/**
 * cases.ts — In-memory case registry
 *
 * The LangGraph MemorySaver owns the authoritative graph state (checkpoints).
 * This registry is a lightweight index on top — optimised for the dashboard
 * queries that the graph's state store doesn't natively support:
 *   - "List all cases for tenant X"
 *   - "Filter by risk score"
 *   - "Count pending HITL reviews"
 *
 * Production note:
 *   Replace the Map with a Postgres `cases` table.
 *   The graph checkpoints stay in LangGraph's Postgres checkpointer.
 *   This registry becomes a materialised view / event-sourced projection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaseStatus =
  | "processing"    // graph is running
  | "pending_hitl"  // paused at humanReviewNode
  | "completed"     // graph reached END
  | "error";        // unrecoverable failure

export interface CaseRecord {
  caseId:             string;
  tenantId:           string;
  companyName:        string;
  registrationNumber: string;
  jurisdiction:       string;
  riskScore:          "Low" | "Medium" | "High" | "Pending";
  status:             CaseStatus;
  requiresHuman:      boolean;
  draftDossier:       string;
  evidenceLedger:     Record<string, string>;
  createdAt:          Date;
  updatedAt:          Date;
  completedAt:        Date | null;
  /** Reviewer notes added during HITL approval */
  reviewerNotes:      string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const caseStore   = new Map<string, CaseRecord>();
/** Secondary index: tenantId → caseId[] (insertion order = newest first) */
const byTenant    = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Called when a new KYC run is started (POST /cases). */
export function registerCase(
  caseId:             string,
  tenantId:           string,
  companyName:        string,
  registrationNumber: string,
  jurisdiction:       string
): CaseRecord {
  const now = new Date();
  const rec: CaseRecord = {
    caseId, tenantId, companyName, registrationNumber, jurisdiction,
    riskScore:      "Pending",
    status:         "processing",
    requiresHuman:  false,
    draftDossier:   "",
    evidenceLedger: {},
    createdAt:      now,
    updatedAt:      now,
    completedAt:    null,
    reviewerNotes:  null,
  };
  caseStore.set(caseId, rec);

  // Maintain per-tenant index (newest first by prepending)
  const list = byTenant.get(tenantId) ?? [];
  list.unshift(caseId);
  byTenant.set(tenantId, list);

  return rec;
}

/** Upserts case data after a graph run (or partial run) completes. */
export function updateCase(caseId: string, patch: Partial<Omit<CaseRecord, "caseId" | "tenantId" | "createdAt">>): CaseRecord | null {
  const rec = caseStore.get(caseId);
  if (!rec) return null;

  Object.assign(rec, patch, { updatedAt: new Date() });

  if (patch.status === "completed" && !rec.completedAt) {
    rec.completedAt = new Date();
  }

  return rec;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export function getCase(caseId: string): CaseRecord | null {
  return caseStore.get(caseId) ?? null;
}

export interface CaseListOptions {
  status?:    CaseStatus;
  riskScore?: "Low" | "Medium" | "High" | "Pending";
  limit?:     number;
  offset?:    number;
}

/** Returns cases for a tenant, newest first, with optional filters. */
export function listCases(
  tenantId: string,
  opts: CaseListOptions = {}
): { cases: CaseRecord[]; total: number } {
  const ids  = byTenant.get(tenantId) ?? [];
  let   recs = ids
    .map((id) => caseStore.get(id))
    .filter((r): r is CaseRecord => r !== undefined);

  if (opts.status)    recs = recs.filter((r) => r.status === opts.status);
  if (opts.riskScore) recs = recs.filter((r) => r.riskScore === opts.riskScore);

  const total = recs.length;
  recs = recs.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));

  return { cases: recs, total };
}

/** Returns aggregate counts for the dashboard metrics row. */
export function getCaseMetrics(tenantId: string): {
  total:       number;
  low:         number;
  medium:      number;
  high:        number;
  pending:     number;
  hitlPending: number;
  completed:   number;
} {
  const ids  = byTenant.get(tenantId) ?? [];
  const recs = ids.map((id) => caseStore.get(id)).filter((r): r is CaseRecord => r !== undefined);

  return {
    total:       recs.length,
    low:         recs.filter((r) => r.riskScore === "Low").length,
    medium:      recs.filter((r) => r.riskScore === "Medium").length,
    high:        recs.filter((r) => r.riskScore === "High").length,
    pending:     recs.filter((r) => r.status === "processing").length,
    hitlPending: recs.filter((r) => r.status === "pending_hitl").length,
    completed:   recs.filter((r) => r.status === "completed").length,
  };
}

// ---------------------------------------------------------------------------
// Seed: pre-populate demo tenant with realistic case history
// ---------------------------------------------------------------------------
(function seedDemoCases() {
  const tid = "tenant_demo";

  const seed: Omit<CaseRecord, "updatedAt">[] = [
    {
      caseId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      tenantId: tid,
      companyName: "Acme Payments BV",
      registrationNumber: "34289034",
      jurisdiction: "NL",
      riskScore: "Low",
      status: "completed",
      requiresHuman: false,
      draftDossier: "**Acme Payments BV** is an EU-domiciled entity with clean screening result and complete UBO data [Source: API_1].\n\nThe UBO is Jane Doe, holding 75% direct ownership [Source: API_1].\n\nNo sanctions or PEP matches detected. Risk classification: **Low** [Source: API_1].",
      evidenceLedger: { API_1: "https://api.opencorporates.com/v0.4/companies/nl/34289034" },
      createdAt:   new Date(Date.now() - 2  * 60_000),
      completedAt: new Date(Date.now() - 1  * 60_000),
      reviewerNotes: null,
    },
    {
      caseId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      tenantId: tid,
      companyName: "Offshore Holdings Ltd",
      registrationNumber: "99887766",
      jurisdiction: "VG",
      riskScore: "Medium",
      status: "pending_hitl",
      requiresHuman: true,
      draftDossier: "**Offshore Holdings Ltd** is a BVI entity with stale API data [Source: API_1].\n\nUBO extracted via browser agent: Robert Chen, 100% ownership (low confidence) [Source: BROWSER_SCREENSHOT_1].\n\nProvisionaly rated **Medium**. Human sign-off required [Source: API_1].",
      evidenceLedger: {
        API_1: "https://api.opencorporates.com/v0.4/companies/vg/99887766",
        BROWSER_SCREENSHOT_1: "./evidence/b2c3d4e5-ubo.png",
      },
      createdAt:   new Date(Date.now() - 7  * 60_000),
      completedAt: null,
      reviewerNotes: null,
    },
    {
      caseId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
      tenantId: tid,
      companyName: "Miraflores Capital SA",
      registrationNumber: "55443322",
      jurisdiction: "PA",
      riskScore: "High",
      status: "pending_hitl",
      requiresHuman: true,
      draftDossier: "**Miraflores Capital SA** is incorporated in Panama, a high-risk FATF jurisdiction [Source: API_1].\n\nUBO could not be verified — browser fallback failed [Source: API_1].\n\nPEP indicator detected. Risk classification: **High**. Senior officer sign-off mandatory (AMLD6 Art. 18) [Source: API_1].",
      evidenceLedger: { API_1: "https://api.opencorporates.com/v0.4/companies/pa/55443322" },
      createdAt:   new Date(Date.now() - 14 * 60_000),
      completedAt: null,
      reviewerNotes: null,
    },
    {
      caseId: "d4e5f6a7-b8c9-0123-defg-234567890123",
      tenantId: tid,
      companyName: "Rhine Digital GmbH",
      registrationNumber: "HRB204511",
      jurisdiction: "DE",
      riskScore: "Low",
      status: "completed",
      requiresHuman: false,
      draftDossier: "**Rhine Digital GmbH** is registered in Germany [Source: API_1].\n\nUBO: Klaus Weber, 60% ownership [Source: API_1].\n\nClean screening. Risk: **Low** [Source: API_1].",
      evidenceLedger: { API_1: "https://api.opencorporates.com/v0.4/companies/de/HRB204511" },
      createdAt:   new Date(Date.now() - 2  * 3600_000),
      completedAt: new Date(Date.now() - 2  * 3600_000 + 840_000),
      reviewerNotes: null,
    },
    {
      caseId: "e5f6a7b8-c9d0-1234-efgh-345678901234",
      tenantId: tid,
      companyName: "Lyon Ventures SAS",
      registrationNumber: "812 345 678",
      jurisdiction: "FR",
      riskScore: "Low",
      status: "completed",
      requiresHuman: false,
      draftDossier: "**Lyon Ventures SAS** is a French entity [Source: API_1].\n\nUBO: Marie Dupont, 51% ownership [Source: API_1].\n\nNo adverse matches. Risk: **Low** [Source: API_1].",
      evidenceLedger: { API_1: "https://api.opencorporates.com/v0.4/companies/fr/812345678" },
      createdAt:   new Date(Date.now() - 5  * 3600_000),
      completedAt: new Date(Date.now() - 5  * 3600_000 + 780_000),
      reviewerNotes: null,
    },
  ];

  for (const s of seed) {
    caseStore.set(s.caseId, { ...s, updatedAt: s.completedAt ?? s.createdAt });
    const list = byTenant.get(tid) ?? [];
    list.push(s.caseId);
    byTenant.set(tid, list);
  }
})();
