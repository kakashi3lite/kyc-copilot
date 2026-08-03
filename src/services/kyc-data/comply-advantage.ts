import type { EntityInput } from "../../types/index.js";
import { CircuitBreaker, withRetry } from "../../utils/retry.js";
import { sanitizeInput } from "../../utils/mask.js";
import { env } from "../../config/env.js";

export interface ScreeningResult { sanctions: ReadonlyArray<{ list: string; matched: boolean; name: string }>; pep: boolean; }

export class ComplyAdvantageClient {
  private readonly breaker = new CircuitBreaker(5, 30000);
  public constructor(private readonly baseUrl = env.COMPLY_ADVANTAGE_BASE_URL) {}

  public async screen(input: EntityInput): Promise<ScreeningResult> {
    return await this.breaker.execute(async () => withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/searches`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // ComplyAdvantage uses an API-token auth scheme. An empty key
          // (zero-key mode) yields 401 → retry → circuit breaker → the
          // composite adapter's deterministic fallback.
          authorization: `Token ${env.COMPLY_ADVANTAGE_API_KEY}`
        },
        body: JSON.stringify({ search_term: sanitizeInput(input.companyName), client_ref: sanitizeInput(input.registrationNumber) }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`ComplyAdvantage ${response.status}`);
      const json = await response.json() as { hits?: Array<{ match_status?: string; name?: string; lists?: string[]; types?: string[] }> };
      const hits = json.hits ?? [];
      return {
        sanctions: hits.map((hit) => ({ list: hit.lists?.[0] ?? "unknown", matched: hit.match_status === "potential_match" || hit.match_status === "true_positive", name: hit.name ?? input.companyName })),
        pep: hits.some((hit) => hit.types?.includes("pep") === true)
      };
    }, { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }));
  }
}
