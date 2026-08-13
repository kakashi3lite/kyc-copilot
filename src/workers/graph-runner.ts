import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { redis, db } from "../db/index.js";
import { cases, evidence, failedCases } from "../db/schema.js";
import { KycGraph } from "../graph/graph.js";
import { CompositeKycDataAdapter } from "../services/kyc-data/adapter.js";
import { OpenCorporatesClient } from "../services/kyc-data/opencorporates.js";
import { ComplyAdvantageClient } from "../services/kyc-data/comply-advantage.js";
import { PlaywrightBrowserPool, sharedBrowserPool } from "../services/browser/pool.js";
import { FallbackLlmClient } from "../services/llm/fallback.js";
import { decryptPii, encryptPii } from "../services/encryption/at-rest.js";
import { writeAuditLog } from "../services/audit/logger.js";
import { enqueueWebhookEvent } from "../services/webhooks/dispatcher.js";
import { incrementUsage, reportMeteredUsageToStripe } from "../services/billing/usage-meter.js";
import { newId } from "../utils/id.js";
import { maskPiiInText } from "../utils/mask.js";
import { childLogger } from "../config/logger.js";

const log = childLogger({ component: "graph-runner" });

/**
 * Remove decrypted PII fields from graph state before persistence.
 *
 * `AgentState` extends `EntityInput` and carries decrypted `companyName` /
 * `registrationNumber` in memory for the graph pipeline. Those values
 * already live in encrypted columns (`cases.companyNameEncrypted` etc.),
 * so persisting them again inside the `graphState` jsonb would leak
 * plaintext PII into the database — bypassing the ADR-003 encrypt+mask
 * pattern. The state is shallow-copied so the in-memory object (used by
 * later pipeline steps) is untouched.
 */
export function stripPiiFromGraphState(state: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...state };
  delete safe.companyName;
  delete safe.registrationNumber;
  // Raw wallet transactions are case data (potentially sensitive) — persist
  // only the aggregate KYT verdict, never the raw transaction stream.
  delete safe.transactionData;
  return safe;
}

export interface GraphJobData { caseId: string; tenantId: string; }

export type GraphJobName = "run" | "rescreen";

export const graphQueue = new Queue<GraphJobData, unknown, GraphJobName>("kyc-graph", { connection: redis as unknown as ConnectionOptions, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: false } });

export function createGraph(): KycGraph {
  return new KycGraph({ adapter: new CompositeKycDataAdapter(new OpenCorporatesClient(), new ComplyAdvantageClient()), browser: new PlaywrightBrowserPool(), llm: new FallbackLlmClient() });
}

export async function runCase(caseId: string, tenantId: string, graph = createGraph()): Promise<void> {
  const rows = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error("Case not found");
  await db.update(cases).set({ status: "processing", updatedAt: new Date() }).where(eq(cases.id, caseId));
  try {
    const state = await graph.run({ caseId, tenantId, companyName: decryptPii(row.companyNameEncrypted), registrationNumber: decryptPii(row.registrationNumberEncrypted), jurisdiction: row.jurisdiction });
    for (const item of Object.values(state.evidenceLedger)) {
      await db.insert(evidence).values({ id: newId("evd"), caseId, tenantId, key: item.key, sourceUrlEncrypted: encryptPii(item.sourceUrl), sourceUrlMask: maskPiiInText(item.sourceUrl), summary: item.summary, kind: item.kind, version: item.version, contentHash: item.hash }).onConflictDoNothing();
    }
    await db.update(cases).set({ status: state.status === "completed" ? "completed" : "pending_hitl", riskScore: state.riskScore, requiresHuman: state.requiresHuman, uboVerified: state.uboVerified, browserFailed: state.browserFailed, dossier: state.dossier, graphState: stripPiiFromGraphState(state as unknown as Record<string, unknown>), completedAt: state.status === "completed" ? new Date() : null, updatedAt: new Date() }).where(eq(cases.id, caseId));
    await writeAuditLog({ tenantId, caseId, actor: "system", action: state.status === "completed" ? "case.completed" : "case.pending_hitl", newValue: { riskScore: state.riskScore, requiresHuman: state.requiresHuman } });
    await incrementUsage(tenantId, "casesProcessed");
    // Metered billing — reports to Stripe when the tenant has a
    // subscription and Stripe is configured; fail-soft otherwise.
    await reportMeteredUsageToStripe(tenantId, caseId);
    await enqueueWebhookEvent(tenantId, state.status === "completed" ? "case.completed" : "case.pending_hitl", { caseId, status: state.status, riskScore: state.riskScore });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(cases).set({ status: "failed", updatedAt: new Date() }).where(eq(cases.id, caseId));
    await db.insert(failedCases).values({ id: newId("fail"), caseId, tenantId, reason: message, payload: { caseId, tenantId } });
    await enqueueWebhookEvent(tenantId, "case.failed", { caseId, reason: message });
    childLogger({ component: "graph-runner", caseId, tenantId }).error({ error: message }, "case failed");
    throw error;
  }
}

export function startGraphWorker(): Worker<GraphJobData> {
  return new Worker<GraphJobData>("kyc-graph", async (job: Job<GraphJobData>) => runCase(job.data.caseId, job.data.tenantId), { connection: redis as unknown as ConnectionOptions, concurrency: 10 });
}

/**
 * Close graph-owned resources during graceful shutdown. The BullMQ worker
 * itself is closed by `worker.close()` in `src/index.ts` before this is
 * called; here we tear down the producer-side queue and the shared
 * Chromium browser pool. Both close paths swallow and log their own
 * errors so a failure in one does not block the other.
 */
export async function closeGraphResources(): Promise<void> {
  try {
    await graphQueue.close();
    log.info("graph queue closed");
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "graphQueue close failed");
  }
  try {
    await sharedBrowserPool().close();
    log.info("shared browser pool closed");
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "shared browser pool close failed");
  }
}
