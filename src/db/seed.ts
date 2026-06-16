import bcrypt from "bcrypt";
import { db } from "./index.js";
import { amld6Articles, auditLogs, cases, tenants, users } from "./schema.js";
import { encryptPii } from "../services/encryption/at-rest.js";
import { newId, sha256Hex } from "../utils/id.js";

// ─── Demo constants ────────────────────────────────────────────────────────────
const DEMO_API_KEY = "kc_live_demo0000000000000000000000";
const DEMO_TENANT_ID = "ten_demo00000000000000000000000000";

export async function seed(): Promise<{ tenantId: string; apiKey: string; email: string; password: string }> {
  const password = "ChangeMe-123456";

  // ── 1. Upsert demo tenant with pinned API key ──────────────────────────────
  const apiKeyHash = await bcrypt.hash(DEMO_API_KEY, 12);
  await db
    .insert(tenants)
    .values({
      id: DEMO_TENANT_ID,
      name: "Demo Payments BV",
      plan: "growth",
      apiKeyHash,
      webhookSecretEncrypted: encryptPii("whsec_demo_placeholder"),
    })
    .onConflictDoUpdate({
      target: tenants.id,
      set: { apiKeyHash, updatedAt: new Date() },
    });

  // ── 2. Upsert admin user ───────────────────────────────────────────────────
  const userId = newId("usr");
  await db
    .insert(users)
    .values({
      id: userId,
      tenantId: DEMO_TENANT_ID,
      email: "admin@example.test",
      passwordHash: await bcrypt.hash(password, 12),
      role: "admin",
    })
    .onConflictDoNothing();

  // ── 3. AMLD6 reference data ────────────────────────────────────────────────
  await db
    .insert(amld6Articles)
    .values([
      {
        id: "amld6-art-13",
        article: "Article 13",
        title: "Customer due diligence",
        text: "CDD obligations for obliged entities.",
        effectiveFrom: new Date("2021-06-03T00:00:00Z"),
      },
      {
        id: "amld6-art-18",
        article: "Article 18",
        title: "Enhanced due diligence",
        text: "EDD measures for high-risk relationships.",
        effectiveFrom: new Date("2021-06-03T00:00:00Z"),
      },
    ])
    .onConflictDoNothing();

  // ── 4. Seed 3 realistic demo cases ────────────────────────────────────────

  // Case A — completed, Low risk, full dossier
  const caseA = "case_demo_completed_0001";
  await db
    .insert(cases)
    .values({
      id: caseA,
      tenantId: DEMO_TENANT_ID,
      companyNameEncrypted: encryptPii("Acme Logistics BV"),
      companyNameMask: "Ac** Lo*******",
      registrationNumberEncrypted: encryptPii("NL12345678"),
      registrationNumberMask: "NL****78",
      jurisdiction: "NL",
      status: "completed",
      riskScore: "Low",
      requiresHuman: false,
      uboVerified: true,
      dossier: `# KYC Dossier — Acme Logistics BV\n\n**Jurisdiction:** Netherlands\n**Registration:** NL12345678\n**Risk Score:** Low\n\n## Summary\nCustomer due diligence completed. No adverse media. UBO verified. Sanctions screening clear.\n\n## Evidence\n- CoC extract: valid\n- UBO register: verified (3 shareholders < 25%)\n- Sanctions: OFAC, EU, UN — clear\n- Adverse media: none\n\n**Outcome:** Approved. Full CDD passed per AMLD6 Art. 13.`,
      graphState: { stage: "completed", nodes: ["collect", "screen", "score", "report"], passed: true },
      completedAt: new Date("2026-06-01T10:30:00Z"),
      createdAt: new Date("2026-06-01T09:00:00Z"),
      updatedAt: new Date("2026-06-01T10:30:00Z"),
    })
    .onConflictDoNothing();

  // Case B — pending_hitl, High risk, needs human review
  const caseB = "case_demo_hitl_0002";
  await db
    .insert(cases)
    .values({
      id: caseB,
      tenantId: DEMO_TENANT_ID,
      companyNameEncrypted: encryptPii("Volkov Capital Partners"),
      companyNameMask: "Vo**** Ca****** Pa*****",
      registrationNumberEncrypted: encryptPii("CY98765432"),
      registrationNumberMask: "CY****32",
      jurisdiction: "CY",
      status: "pending_hitl",
      riskScore: "High",
      requiresHuman: true,
      uboVerified: false,
      dossier: `# KYC Dossier — Volkov Capital Partners\n\n**Jurisdiction:** Cyprus\n**Registration:** CY98765432\n**Risk Score:** High\n\n## Summary\nEDD triggered per AMLD6 Art. 18. UBO identity unverified. Adverse media hits detected. Pending human review.\n\n## Flags\n- ⚠️ PEP-adjacent beneficial owner detected\n- ⚠️ Adverse media: 2 hits (corruption allegations, 2023)\n- ⚠️ Complex ownership structure — nominee directors\n\n**Outcome:** HITL required. Analyst must verify UBO and override or reject.`,
      graphState: { stage: "pending_hitl", flags: ["pep_adjacent", "adverse_media", "complex_ownership"] },
      createdAt: new Date("2026-06-05T14:00:00Z"),
      updatedAt: new Date("2026-06-05T15:45:00Z"),
    })
    .onConflictDoNothing();

  // Case C — processing, showing active pipeline state
  const caseC = "case_demo_processing_0003";
  await db
    .insert(cases)
    .values({
      id: caseC,
      tenantId: DEMO_TENANT_ID,
      companyNameEncrypted: encryptPii("Sunshine Retail GmbH"),
      companyNameMask: "Su******* Re**** Gm**",
      registrationNumberEncrypted: encryptPii("DE45678901"),
      registrationNumberMask: "DE****01",
      jurisdiction: "DE",
      status: "processing",
      riskScore: "Pending",
      requiresHuman: false,
      uboVerified: false,
      dossier: "",
      graphState: { stage: "screen", progress: 0.4, nodes_completed: ["collect", "validate"], nodes_pending: ["screen", "score", "report"] },
      createdAt: new Date("2026-06-08T17:00:00Z"),
      updatedAt: new Date("2026-06-08T17:05:00Z"),
    })
    .onConflictDoNothing();

  // ── 5. Seed audit log entries for the completed case ──────────────────────
  const auditPayloadA = JSON.stringify({ tenantId: DEMO_TENANT_ID, caseId: caseA, actor: "system", action: "case.approved" });
  await db
    .insert(auditLogs)
    .values({
      id: newId("aud"),
      tenantId: DEMO_TENANT_ID,
      caseId: caseA,
      actor: "system",
      action: "case.approved",
      newValue: { notes: "Automated CDD pass", riskOverride: null },
      hash: sha256Hex(auditPayloadA),
    })
    .onConflictDoNothing();

  return { tenantId: DEMO_TENANT_ID, apiKey: DEMO_API_KEY, email: "admin@example.test", password };
}

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  void seed()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    })
    .catch((error: unknown) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
