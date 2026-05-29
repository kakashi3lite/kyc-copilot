import { db } from "../../db/index.js";
import { auditLogs } from "../../db/schema.js";
import { newId, sha256Hex } from "../../utils/id.js";

export async function writeAuditLog(input: { tenantId: string; caseId?: string | undefined; actor: string; action: string; oldValue?: Record<string, unknown> | null; newValue?: Record<string, unknown> | null; }): Promise<void> {
  const payload = JSON.stringify(input);
  const values = {
    id: newId("aud"),
    tenantId: input.tenantId,
    caseId: input.caseId ?? null,
    actor: input.actor,
    action: input.action,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    hash: sha256Hex(payload)
  };
  await db.insert(auditLogs).values(values);
}
