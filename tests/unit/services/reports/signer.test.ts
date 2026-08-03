import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportSignature } from "../../../../src/services/reports/signer.js";

const baseReport = {
  reportId: "rpt_test_1",
  caseId: "case_test_1",
  tenantId: "ten_test_1",
  generatedAt: "2026-08-03T00:00:00.000Z",
  dossier: "# KYC Dossier\nRisk: Low",
  evidenceChain: [{ key: "API_1", hash: "abc123", kind: "api" }],
  auditTrail: [{ actor: "system", action: "case.completed", occurredAt: "2026-08-03T00:00:01.000Z" }],
};

describe("report signer — unsigned path (no REPORT_SIGNING_KEY in dev)", () => {
  it("produces an unsigned content hash with a marker fingerprint", async () => {
    const { signReport } = await import("../../../../src/services/reports/signer.js");
    const sig = signReport(baseReport);
    expect(sig.algorithm).toBe("HMAC-SHA256");
    expect(sig.signature.startsWith("unsigned:")).toBe(true);
    expect(sig.keyFingerprint).toBe("no-signing-key-configured");
    expect(sig.canonicalFields).toContain("dossier");
  });

  it("is deterministic — same inputs produce the same signature", async () => {
    const { signReport } = await import("../../../../src/services/reports/signer.js");
    expect(signReport(baseReport).signature).toBe(signReport(baseReport).signature);
  });

  it("detects tampering — changing any canonical field changes the signature", async () => {
    const { signReport } = await import("../../../../src/services/reports/signer.js");
    const original = signReport(baseReport);
    const tampered = signReport({ ...baseReport, dossier: "# KYC Dossier\nRisk: High" });
    expect(tampered.signature).not.toBe(original.signature);
  });

  it("verifyReportSignature accepts a matching pair and rejects tampered content", async () => {
    const { signReport, verifyReportSignature } = await import("../../../../src/services/reports/signer.js");
    const sig = signReport(baseReport);
    expect(verifyReportSignature(baseReport, sig)).toBe(true);
    expect(verifyReportSignature({ ...baseReport, caseId: "case_test_2" }, sig)).toBe(false);
  });
});

describe("report signer — signed path (REPORT_SIGNING_KEY configured)", () => {
  it("produces an HMAC-SHA256 signature with a key fingerprint", async () => {
    // Fresh module graph so config/env re-reads the stubbed variable.
    vi.resetModules();
    vi.stubEnv("REPORT_SIGNING_KEY", "test-signing-key-0123456789abcdef");
    const { signReport } = await import("../../../../src/services/reports/signer.js");
    const sig: ReportSignature = signReport(baseReport);
    expect(sig.signature.startsWith("unsigned:")).toBe(false);
    expect(sig.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Deterministic for the same key + inputs.
    expect(signReport(baseReport).signature).toBe(sig.signature);
    vi.unstubAllEnvs();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
