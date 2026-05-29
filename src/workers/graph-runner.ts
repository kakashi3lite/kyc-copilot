import { Queue, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { redis, db } from "../db/index.js";
import { cases, evidence, failedCases } from "../db/schema.js";
import { KycGraph } from "../graph/graph.js";
import { CompositeKycDataAdapter } from "../services/kyc-data/adapter.js";
import { OpenCorporatesClient } from "../services/kyc-data/opencorporates.js";
import { ComplyAdvantageClient } from "../services/kyc-data/comply-advantage.js";
import { PlaywrightBrowserPool } from "../services/browser/pool.js";
import { FallbackLlmClient } from "../services/llm/fallback.js";
import { decryptPii, encryptPii } from "../services/encryption/at-rest.js";
import { writeAuditLog } from "../services/audit/logger.js";
import { enqueueWebhookEvent } from "../services/webhooks/dispatcher.js";
import { incrementUsage } from "../services/billing/usage-meter.js";
import { newId } from "../utils/id.js";
import { maskPiiInText } from "../utils/mask.js";
import { childLogger } from "../config/logger.js";

export interface GraphJobData { caseId: string; tenantId: string; }

export const graphQueue = new Queue<GraphJobData>("kyc-graph", { connection: redis, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: false, timeout: 300000 } });

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
    await db.update(cases).set({ status: state.status === "completed" ? "completed" : "pending_hitl", riskScore: state.riskScore, requiresHuman: state.requiresHuman, uboVerified: state.uboVerified, browserFailed: state.browserFailed, dossier: state.dossier, graphState: state as unknown as Record<string, unknown>, completedAt: state.status === "completed" ? new Date() : null, updatedAt: new Date() }).where(eq(cases.id, caseId));
    await writeAuditLog({ tenantId, caseId, actor: "system", action: state.status === "completed" ? "case.completed" : "case.pending_hitl", newValue: { riskScore: state.riskScore, requiresHuman: state.requiresHuman } });
    await incrementUsage(tenantId, "casesProcessed");
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
  return new Worker<GraphJobData>("kyc-graph", async (job: Job<GraphJobData>) => runCase(job.data.caseId, job.data.tenantId), { connection: redis, concurrency: 10 });
}
