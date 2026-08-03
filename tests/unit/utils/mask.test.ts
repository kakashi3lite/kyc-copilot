import { describe, expect, it } from "vitest";
import { sanitizeOutput } from "../../../src/utils/mask.js";

describe("sanitizeOutput (Sprint 1 — stored-XSS guard)", () => {
  it("strips <script> blocks entirely — the content is executable JS", () => {
    expect(sanitizeOutput("<script>alert(1)</script>")).toBe("");
    expect(sanitizeOutput("Before <script>alert(1)</script> after")).toBe("Before  after");
  });

  it("strips tags carrying event handlers", () => {
    expect(sanitizeOutput("<img onerror=alert(1)>")).toBe("");
  });

  it("strips tags but preserves visible text", () => {
    expect(sanitizeOutput("Normal text with <b>bold</b>")).toBe("Normal text with bold");
  });

  it("removes dangerous URL protocols", () => {
    expect(sanitizeOutput("javascript:void(0)")).toBe("void(0)");
    expect(sanitizeOutput("More: data:text/html")).toBe("More: ");
    expect(sanitizeOutput("vbscript:msgbox(1)")).toBe("msgbox(1)");
  });

  it("normalizes unicode (NFKC)", () => {
    expect(sanitizeOutput("ｓａｆｅ")).toBe("safe");
  });

  it("leaves ordinary dossier text untouched", () => {
    const text = "The entity operates in NL. [Source: API_1]";
    expect(sanitizeOutput(text)).toBe(text);
  });
});
