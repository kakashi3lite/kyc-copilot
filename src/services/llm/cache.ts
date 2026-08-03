/**
 * Redis-backed semantic cache for LLM dossier calls — Sprint 3.
 *
 * Enterprise customers process related entities and get repeated registry /
 * sanctions data. Same company name + jurisdiction + data completeness →
 * identical LLM prompt → identical response. The cache avoids the LLM call
 * entirely for repeat lookups (target: ≥15% cache hit rate).
 *
 * The cache key is derived from the state fields that drive the prompt
 * (plus an optional graph-context digest so a growing knowledge graph
 * never serves stale cross-case context). High-risk cases and
 * browser-failed cases are bypassed at the router level (fresh assessment
 * is mandatory), and the cache is skipped entirely in tests.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { redis } from "../../db/index.js";
import type { DossierDraft } from "./client.js";
import type { AgentState } from "../../graph/state.js";
import type { GraphContext } from "../kyc-data/graph-query.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "llm-cache" });

export const CacheEntrySchema = z.object({
  /** SHA-256 hex of the canonical prompt input (64 chars). */
  promptHash: z.string().length(64),
  response: z.object({
    claims: z.array(z.object({ id: z.string(), text: z.string(), sourceKey: z.string() })),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]),
    summary: z.string(),
  }),
  modelId: z.string(),
  costSavedUsd: z.number(),
  createdAt: z.string(), // ISO-8601
  ttlSeconds: z.number().int().min(0),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

export interface SemanticCache {
  get(key: string): Promise<CacheEntry | null>;
  set(entry: CacheEntry): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
  /** Compute cache TTL based on data freshness requirements. */
  ttlForState(state: AgentState): number;
}

/** Redis key prefix — namespaced so invalidation can target the family. */
const CACHE_PREFIX = "llm:cache:";

/**
 * SHA-256 hex of the canonical state that drives the dossier prompt.
 * A graph-context digest is included when provided so a change in the
 * knowledge graph (new prior case, new related entity) invalidates the
 * cached dossier for that entity.
 */
export function hashCacheKey(state: AgentState, graphCtx?: GraphContext | null): string {
  const canonical = JSON.stringify({
    companyName: state.companyName.toLowerCase().trim(),
    jurisdiction: state.jurisdiction,
    status: state.apiData?.status,
    sanctions: state.apiData?.sanctions.map(s => `${s.list}:${s.name}:${s.matched}`).sort(),
    pep: state.apiData?.pep,
    uboCount: state.apiData?.ubos.length,
    completeness: state.apiData?.completeness,
    graphCtx: graphCtx ? {
      entityResolution: graphCtx.entityResolution,
      relatedEntities: graphCtx.relatedEntities.map(r => `${r.canonicalName}:${r.relationshipType}`).sort(),
      priorCases: graphCtx.priorCases.map(c => c.caseId).sort(),
    } : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Full Redis key for a cache entry (`llm:cache:<sha256>`). */
export function cacheKey(state: AgentState, graphCtx?: GraphContext | null): string {
  return `${CACHE_PREFIX}${hashCacheKey(state, graphCtx)}`;
}

export class RedisSemanticCache implements SemanticCache {
  private readonly DEFAULT_TTL = 3600; // 1 hour for sanctions data freshness
  private readonly LONG_TTL = 86400;   // 24 hours for stable registry data

  public async get(key: string): Promise<CacheEntry | null> {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      await redis.del(key);
      return null;
    }
  }

  public async set(entry: CacheEntry): Promise<void> {
    const key = `${CACHE_PREFIX}${entry.promptHash}`;
    await redis.set(key, JSON.stringify(entry), "EX", entry.ttlSeconds);
    log.info({ promptHash: entry.promptHash.slice(0, 16), ttl: entry.ttlSeconds }, "cache set");
  }

  public async invalidate(_tenantId: string): Promise<void> {
    // Pattern-based invalidation — Redis KEYS is OK at current scale
    // (<100K keys). For production at scale, use SCAN or a tenant-keyed hash.
    const keys = await redis.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      log.info({ keyCount: keys.length }, "cache invalidated");
    }
  }

  /** Compute cache TTL based on data freshness requirements. */
  public ttlForState(state: AgentState): number {
    // Sanctions data changes — short TTL
    if (state.apiData?.sanctions.some(s => s.matched)) return this.DEFAULT_TTL;
    // PEP status changes — short TTL
    if (state.apiData?.pep) return this.DEFAULT_TTL;
    // Stable registry data — long TTL
    return this.LONG_TTL;
  }
}

export const sharedCache = new RedisSemanticCache();

// Runtime validation helper: every entry written through the cache must
// satisfy the schema (defense against shape drift).
export function parseCacheEntry(raw: unknown): CacheEntry | null {
  const parsed = CacheEntrySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Re-export the DossierDraft type for consumers building entries.
export type { DossierDraft };
