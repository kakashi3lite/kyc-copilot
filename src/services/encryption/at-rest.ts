import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

const algorithm = "aes-256-gcm";

function keyBuffer(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes hex encoded");
  return key;
}

export function encryptPii(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptPii(payload: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = payload.split(":");
  if (version !== "v1" || ivPart === undefined || tagPart === undefined || ciphertextPart === undefined) {
    throw new Error("Invalid encrypted payload");
  }
  const decipher = createDecipheriv(algorithm, keyBuffer(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64")), decipher.final()]).toString("utf8");
}
