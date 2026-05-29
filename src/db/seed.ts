import bcrypt from "bcrypt";
import { db } from "./index.js";
import { amld6Articles, tenants, users } from "./schema.js";
import { encryptPii } from "../services/encryption/at-rest.js";
import { newId, newSecret } from "../utils/id.js";

export async function seed(): Promise<{ tenantId: string; apiKey: string; email: string; password: string }> {
  const tenantId = newId("ten");
  const apiKey = newSecret("kc_live", 24);
  const password = "ChangeMe-123456";
  await db.insert(tenants).values({ id: tenantId, name: "Demo Payments BV", apiKeyHash: await bcrypt.hash(apiKey, 12), webhookSecretEncrypted: encryptPii(newSecret("whsec", 16)) });
  await db.insert(users).values({ id: newId("usr"), tenantId, email: "admin@example.test", passwordHash: await bcrypt.hash(password, 12), role: "admin" });
  await db.insert(amld6Articles).values([
    { id: "amld6-art-13", article: "Article 13", title: "Customer due diligence", text: "CDD obligations for obliged entities.", effectiveFrom: new Date("2021-06-03T00:00:00Z") },
    { id: "amld6-art-18", article: "Article 18", title: "Enhanced due diligence", text: "EDD measures for high-risk relationships.", effectiveFrom: new Date("2021-06-03T00:00:00Z") }
  ]);
  return { tenantId, apiKey, email: "admin@example.test", password };
}

if (process.argv[1]?.endsWith("seed.ts")) {
  void seed().then((result) => process.stdout.write(JSON.stringify(result))).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
