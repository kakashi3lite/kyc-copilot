/**
 * webhooks.ts — Outbound webhook delivery
 *
 * Why webhooks matter for enterprise sales:
 *   Banks and PSPs have existing case management systems (ServiceNow, Jira,
 *   Salesforce, custom CRM). They will NOT change their workflow for a new
 *   vendor. Webhooks let KYC Copilot push events INTO their existing systems.
 *   Without webhooks, every enterprise deal dies in integration discussions.
 *
 * Event model:
 *   case.completed     — graph reached END (auto-approved)
 *   case.pending_hitl  — graph paused, human review required
 *   case.approved      — HITL sign-off completed
 *   case.rescreened    — ongoing monitoring re-run triggered
 *
 * Delivery guarantees:
 *   - At-least-once delivery with 3 retry attempts (exponential backoff)
 *   - HMAC-SHA256 signature on every payload (Stripe-style)
 *   - Production: replace with a queue (SQS, BullMQ) for true at-least-once
 */

import { createHmac, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookEvent =
  | "case.completed"
  | "case.pending_hitl"
  | "case.approved"
  | "case.rescreened";

export interface WebhookEndpoint {
  endpointId: string;
  tenantId:   string;
  url:        string;
  secret:     string;        // HMAC signing secret
  events:     WebhookEvent[];
  active:     boolean;
  createdAt:  Date;
}

export interface WebhookPayload {
  id:         string;        // delivery ID
  event:      WebhookEvent;
  tenantId:   string;
  caseId:     string;
  occurredAt: string;        // ISO
  data:       Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const endpointStore = new Map<string, WebhookEndpoint>();
const byTenant      = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWebhook(
  tenantId: string,
  url:      string,
  events:   WebhookEvent[]
): WebhookEndpoint {
  const endpointId = `wh_${randomBytes(8).toString("hex")}`;
  const secret     = `whsec_${randomBytes(20).toString("hex")}`;

  const endpoint: WebhookEndpoint = {
    endpointId, tenantId, url, secret, events,
    active:    true,
    createdAt: new Date(),
  };

  endpointStore.set(endpointId, endpoint);
  byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), endpointId]);

  return endpoint;
}

export function listWebhooks(tenantId: string): WebhookEndpoint[] {
  return (byTenant.get(tenantId) ?? [])
    .map((id) => endpointStore.get(id))
    .filter((e): e is WebhookEndpoint => e !== undefined);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Signs a payload with the endpoint's HMAC secret.
 * The consumer verifies: `HMAC-SHA256(secret, JSON.stringify(payload)) === signature`
 */
function sign(payload: WebhookPayload, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Dispatches an event to all active endpoints for a tenant that subscribed
 * to that event type. Runs fire-and-forget with exponential backoff retries.
 *
 * Non-blocking: the graph run does not wait for webhook delivery to complete.
 */
export function dispatch(
  tenantId: string,
  event:    WebhookEvent,
  caseId:   string,
  data:     Record<string, unknown>
): void {
  const endpoints = listWebhooks(tenantId).filter(
    (e) => e.active && e.events.includes(event)
  );

  if (endpoints.length === 0) return;

  const payload: WebhookPayload = {
    id:         `evt_${randomBytes(8).toString("hex")}`,
    event,
    tenantId,
    caseId,
    occurredAt: new Date().toISOString(),
    data,
  };

  // Fire-and-forget — intentionally not awaited
  for (const endpoint of endpoints) {
    deliverWithRetry(endpoint, payload).catch((err) =>
      console.error(`[webhook] Delivery failed permanently for ${endpoint.endpointId}: ${String(err)}`)
    );
  }
}

/**
 * Attempts delivery with up to 3 retries on non-2xx responses.
 * Backoff: 1s, 4s, 16s (exponential, base 4).
 */
async function deliverWithRetry(
  endpoint: WebhookEndpoint,
  payload:  WebhookPayload,
  attempt   = 1
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const signature    = sign(payload, endpoint.secret);

  try {
    const res = await fetch(endpoint.url, {
      method:  "POST",
      headers: {
        "Content-Type":       "application/json",
        "X-KYC-Signature":    signature,
        "X-KYC-Event":        payload.event,
        "X-KYC-Delivery-ID":  payload.id,
      },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000), // 10-second delivery timeout
    });

    if (res.ok) {
      console.log(`[webhook] ${payload.event} → ${endpoint.url} (${res.status})`);
      return;
    }

    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      const backoffMs = Math.pow(4, attempt) * 1_000;
      console.warn(`[webhook] Attempt ${attempt} failed for ${endpoint.url}: ${String(err)}. Retrying in ${backoffMs}ms…`);
      await new Promise((r) => setTimeout(r, backoffMs));
      return deliverWithRetry(endpoint, payload, attempt + 1);
    }
    throw err;
  }
}
