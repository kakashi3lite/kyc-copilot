/**
 * Postgres-backed knowledge-graph query service — Sprint 5.
 *
 * The LLM currently sees only the current case's flat evidence list. With
 * the graph, the dossier prompt can also carry cross-case context:
 * "This entity shares a UBO with 3 other entities processed in the last
 * 6 months" and "This entity was previously screened on [date] with
 * result X." This service reads/writes the graph tables
 * (`graph_entities`, `graph_edges`, `case_entities`).
 *
 * Designed to be fail-open: if the graph is empty (fresh deployment) every
 * lookup returns an "isNewEntity" context and no pipeline breaks.
 */

import { z } from "zod";
import { eq, and, or, desc, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { graphEntities, graphEdges, caseEntities, cases } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import type { ResolvedEntity } from "./entity-resolver.js";

export const GraphContextSchema = z.object({
  /** Entities directly linked to the subject (UBOs, subsidiaries, etc.). */
  relatedEntities: z.array(z.object({
    canonicalName: z.string(),
    entityType: z.string(),
    relationshipType: z.string(),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]).nullable(),
    lastSeenAt: z.string().nullable(),
  })),
  /** Previous cases involving this entity or related entities. */
  priorCases: z.array(z.object({
    caseId: z.string(),
    completedAt: z.string(),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]),
    summary: z.string(),
  })),
  /** Entity resolution status for the current subject. */
  entityResolution: z.object({
    isNewEntity: z.boolean(),
    canonicalName: z.string(),
    confidence: z.number(),
    mergedFrom: z.number().int(), // how many source entities were merged
  }),
});
export type GraphContext = z.infer<typeof GraphContextSchema>;

export interface GraphQueryService {
  getContext(tenantId: string, caseId: string, entityName: string, jurisdiction: string): Promise<GraphContext>;
  upsertEntity(resolved: ResolvedEntity, tenantId: string): Promise<string>;
  linkCaseToEntity(caseId: string, entityId: string, role: string): Promise<void>;
}

export class PostgresGraphQueryService implements GraphQueryService {
  public async getContext(tenantId: string, caseId: string, entityName: string, jurisdiction: string): Promise<GraphContext> {
    // 1. Find the canonical entity for this name+jurisdiction WITHIN this tenant.
    //    Cross-tenant entity resolution is opt-in via federated learning (§6),
    //    NOT implicit via shared graph tables — that would leak case data across
    //    institutions and violate GDPR data isolation requirements.
    const entityRows = await db.select()
      .from(graphEntities)
      .where(and(
        eq(graphEntities.tenantId, tenantId),
        eq(graphEntities.canonicalName, entityName),
        eq(graphEntities.jurisdiction, jurisdiction),
      ))
      .limit(1);

    const entity = entityRows[0];
    const isNewEntity = entity === undefined;

    let relatedEntities: GraphContext["relatedEntities"] = [];
    let priorCases: GraphContext["priorCases"] = [];

    if (entity) {
      // 2. Related entities via edges — scoped to this tenant
      const edges = await db.select()
        .from(graphEdges)
        .where(and(
          eq(graphEdges.tenantId, tenantId),
          or(
            eq(graphEdges.sourceEntityId, entity.id),
            eq(graphEdges.targetEntityId, entity.id),
          ),
        ))
        .limit(20);

      const relatedIds = edges.map(e =>
        e.sourceEntityId === entity.id ? e.targetEntityId : e.sourceEntityId
      );

      if (relatedIds.length > 0) {
        const relatedRows = await db.select()
          .from(graphEntities)
          .where(inArray(graphEntities.id, relatedIds))
          .limit(20);

        relatedEntities = relatedRows.map(r => ({
          canonicalName: r.canonicalName,
          entityType: r.entityType,
          relationshipType: edges.find(e =>
            e.sourceEntityId === r.id || e.targetEntityId === r.id
          )?.relationshipType ?? "unknown",
          riskScore: null, // populated from cases if available
          lastSeenAt: r.updatedAt?.toISOString() ?? null,
        }));
      }

      // 3. Prior cases involving this entity — scoped to this tenant.
      //    case_entities links are tenant-agnostic (no tenant_id column),
      //    but the joined cases table carries tenant_id. We filter there
      //    so a tenant only sees their own prior assessments.
      const caseLinks = await db.select()
        .from(caseEntities)
        .innerJoin(cases, eq(caseEntities.caseId, cases.id))
        .where(and(
          eq(caseEntities.entityId, entity.id),
          eq(cases.tenantId, tenantId),
        ))
        .limit(10);

      if (caseLinks.length > 0) {
        // Extract the joined cases rows (caseLinks is {case_entities, cases}[]).
        const caseRows = caseLinks.map(cl => cl.cases);

        priorCases = caseRows
          .filter(c => c.completedAt !== null)
          .map(c => ({
            caseId: c.id,
            completedAt: c.completedAt!.toISOString(),
            riskScore: c.riskScore,
            summary: c.dossier.slice(0, 200),
          }));
      }
    }

    return {
      relatedEntities,
      priorCases,
      entityResolution: {
        isNewEntity,
        canonicalName: entityName,
        confidence: entity ? Number(entity.resolutionConfidence) : 1.0,
        mergedFrom: entity ? (entity.sourceMetadata as { _sourceCount?: number })._sourceCount ?? 1 : 1,
      },
    };
  }

  public async upsertEntity(resolved: ResolvedEntity, tenantId: string): Promise<string> {
    // Find existing entity by registration number + jurisdiction WITHIN this tenant.
    // Two different institutions may assess the same legal entity independently;
    // their graphs must not merge unless they explicitly opt into federation.
    const existing = await db.select()
      .from(graphEntities)
      .where(and(
        eq(graphEntities.tenantId, tenantId),
        eq(graphEntities.registrationNumber, resolved.registrationNumber),
        eq(graphEntities.jurisdiction, resolved.jurisdiction),
      ))
      .limit(1);

    if (existing[0]) {
      // Update confidence if new resolution is higher
      if (resolved.confidence > Number(existing[0].resolutionConfidence)) {
        await db.update(graphEntities)
          .set({
            canonicalName: resolved.canonicalName,
            resolutionConfidence: String(resolved.confidence),
            sourceMetadata: { _sourceCount: resolved.sources.length, ...resolved },
            updatedAt: new Date(),
          })
          .where(eq(graphEntities.id, existing[0].id));
      }
      return existing[0].id;
    }

    // Insert new entity
    const id = newId("ent");
    await db.insert(graphEntities).values({
      id,
      tenantId,
      canonicalName: resolved.canonicalName,
      entityType: "company",
      jurisdiction: resolved.jurisdiction,
      registrationNumber: resolved.registrationNumber,
      sourceMetadata: { _sourceCount: resolved.sources.length, ...resolved },
      resolutionConfidence: String(resolved.confidence),
    });
    return id;
  }

  public async linkCaseToEntity(caseId: string, entityId: string, role: string): Promise<void> {
    await db.insert(caseEntities).values({
      id: newId("cel"),
      caseId,
      entityId,
      role,
    }).onConflictDoNothing();
  }
}
