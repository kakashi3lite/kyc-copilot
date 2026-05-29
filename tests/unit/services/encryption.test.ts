import { expect, it } from "vitest";
import { decryptPii, encryptPii } from "../../../src/services/encryption/at-rest.js";

it("round trips AES-256-GCM encrypted PII", () => {
  const encrypted = encryptPii("Test BV 12345678");
  expect(encrypted).not.toContain("Test BV");
  expect(decryptPii(encrypted)).toBe("Test BV 12345678");
});
