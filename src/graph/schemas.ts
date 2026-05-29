import { z } from "zod";

export const EntityInputSchema = z.object({
  companyName: z.string().min(1).max(200),
  registrationNumber: z.string().min(1).max(80),
  jurisdiction: z.string().length(2).regex(/^[A-Z]{2}$/)
});

export const ApiCompanyDataSchema = z.object({
  legalName: z.string(),
  registrationNumber: z.string(),
  jurisdiction: z.string().length(2),
  status: z.enum(["active", "inactive", "unknown"]),
  incorporationDate: z.string().nullable(),
  address: z.string().nullable(),
  ubos: z.array(z.object({ name: z.string(), verified: z.boolean(), ownershipPct: z.number().min(0).max(100) })),
  sanctions: z.array(z.object({ list: z.string(), matched: z.boolean(), name: z.string() })),
  pep: z.boolean(),
  sourceUrl: z.string(),
  completeness: z.enum(["complete", "partial"])
});

export const DossierSchema = z.object({
  claims: z.array(z.object({ id: z.string(), text: z.string(), sourceKey: z.string() })),
  riskScore: z.enum(["Low", "Medium", "High", "Pending"]),
  summary: z.string()
});

export const ApprovalSchema = z.object({
  approved: z.boolean(),
  reviewer: z.string().min(1),
  notes: z.string().default(""),
  riskOverride: z.enum(["Low", "Medium", "High", "Pending"]).optional()
});
