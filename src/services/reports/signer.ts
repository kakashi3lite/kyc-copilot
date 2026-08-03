import { createHmac, createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "report-signer" });

export interface ReportSignature {
  /** Always HMAC-SHA256 for MVP (D6 — real PKCS#7 deferred to enterprise). */
  algorithm: "HMAC-SHA256";
  /** base64 HMAC-SHA256 of the content hash, or "unsigned:<sha256>" when no key. */
  signature: string;
  /** First 16 hex chars of SHA-256(signing key) — identifies the key used. */
  keyFingerprint: string;
  /** Ordered field names that feed the canonical string. */
  canonicalFields: string[];
  /** Human-readable verification instruction shown on the report. */
  verificationHint: string;
}

interface SignableReport {
  reportId: string;
  caseId: string;
  tenantId: string;
  generatedAt: string;
  dossier: string;
  evidenceChain: unknown;
  auditTrail: unknown;
}

const CANONICAL_FIELDS = ["reportId", "caseId", "tenantId", "generatedAt", "dossier", "evidenceChain", "auditTrail"] as const;

/**
 * D6 — content-integrity signing. Produces a tamper-evident signature
 * over the report's canonical fields:
 *
 *   1. Build a canonical string (newline-joined, stable field order).
 *   2. SHA-256 it → contentHash.
 *   3. HMAC-SHA256(contentHash) with REPORT_SIGNING_KEY → base64 signature.
 *
 * With no REPORT_SIGNING_KEY configured (dev/zero-key) the signature is
 * `unsigned:<contentHash>` and the fingerprint is
 * `no-signing-key-configured` — still tamper-evident (the content hash
 * changes if any field changes), just not authenticated.
 */
export function signReport(report: SignableReport): ReportSignature {
  const canonical = [
    report.reportId,
    report.caseId,
    report.tenantId,
    report.generatedAt,
    report.dossier,
    JSON.stringify(report.evidenceChain),
    JSON.stringify(report.auditTrail),
  ].join("\n");
  const contentHash = createHash("sha256").update(canonical).digest("hex");

  const key = env.REPORT_SIGNING_KEY;
  if (key.length === 0) {
    log.warn("REPORT_SIGNING_KEY not configured — reports are unsigned (content-hash only)");
    return {
      algorithm: "HMAC-SHA256",
      signature: `unsigned:${contentHash}`,
      keyFingerprint: "no-signing-key-configured",
      canonicalFields: [...CANONICAL_FIELDS],
      verificationHint: `No signing key configured. Content hash: ${contentHash}`,
    };
  }

  const signature = createHmac("sha256", key).update(contentHash).digest("base64");
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return {
    algorithm: "HMAC-SHA256",
    signature,
    keyFingerprint: fingerprint,
    canonicalFields: [...CANONICAL_FIELDS],
    verificationHint: `Compute SHA-256 of the canonical fields and HMAC it with the signing key whose fingerprint is ${fingerprint}.`,
  };
}

/**
 * Recompute the signature for a report and compare it against a stored
 * one. Used by POST /cases/:id/report/verify.
 */
export function verifyReportSignature(report: SignableReport, signature: ReportSignature): boolean {
  const recomputed = signReport(report);
  return recomputed.signature === signature.signature
    && recomputed.keyFingerprint === signature.keyFingerprint;
}
