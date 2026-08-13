---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: INCIDENT_RUNBOOK
title: Incident Response Runbook — GDPR Art. 33/34 + DORA notification path
status: current
updated: 2026-08-13
owner: Principal AI Architect / CISO / DPO
related: [DR_RUNBOOK.md, OPERATIONS.md, SECURITY.md, PLAN_SECURITY_HARDENING.md]
---

# Incident Response Runbook

> When something breaks or leaks: **contain → assess → notify → remediate →
> review**. Every step is time-boxed. This runbook covers both DORA ICT
> incidents (any material disruption) and GDPR personal-data breaches.

## 1. Severity matrix

| Severity | Definition | Examples | Target first response |
|---|---|---|---|
| **SEV1** | Full service loss or confirmed PII breach | DB compromise, key exposure, data exfiltration | ≤ 15 min |
| **SEV2** | Major degradation / high-probability data exposure | Graph pipeline outage, webhook DLQ flood, suspected leak | ≤ 30 min |
| **SEV3** | Minor, contained | Single-case failure, latency regression, cosmetic bug | ≤ 2 h |

## 2. Roles (RACI)

| Role | Responsibility |
|---|---|
| **Incident Commander (IC)** | Runs the timeline; owns coordination; single decision-maker during SEV1/2 |
| **On-call engineer** | First responder; contains + triages; technical remediation |
| **CISO** | Escalation, evidence preservation, regulator interface |
| **DPO / Privacy lead** | GDPR Art. 33/34 notification decision + drafting (72 h) |
| **Comms** | Customer/tenant notifications (only via IC) |

## 3. Runbook (time-boxed)

### Contain (0–15 min)
1. **IC declares** severity. Move the incident into a dedicated thread + timeline doc.
2. **Stop the bleed:** rotate any exposed secrets (`infra/fly-secrets.sh` regenerates keys; Fly console), disable compromised API keys, take the affected service offline or fail-closed (the app refuses insecure boots by design — keep it that way).
3. **Preserve evidence:** snapshot logs (`fly logs`), capture the DB transaction window, freeze artifacts. Do NOT delete anything during SEV1/2.

### Assess (15–60 min)
4. Determine: what data, how many records, who is affected, is it PII, was it exfiltrated or just exposed at rest.
5. Check the **PII blast radius:** encrypted at rest (AES-256-GCM) + pseudonymized to LLM providers (G1). A stolen encrypted volume without the key is NOT a GDPR breach requiring notification — document why.
6. Classify: **personal-data breach** (GDPR) vs **ICT incident** (DORA) vs both.

### Notify (per obligations)
| Obligation | Trigger | Deadline | To |
|---|---|---|---|
| GDPR Art. 33 | Personal-data breach | **≤ 72 h** from awareness | Supervisory authority (and AMLA for AML-relevant data where applicable) |
| GDPR Art. 34 | High risk to data subjects | Without undue delay | Data subjects |
| DORA major ICT incident | Material impact (RTS criteria) | **4 h** early warning · **24 h** update · **72 h** final | Customer NCAs (we support our institutional customers' obligations; they notify, we provide facts) |
| Contractual | Customer DPA / SLA | Per contract (typically ≤ 24 h) | Affected tenants |

### Remediate + review (60 min onward)
7. Apply the fix; re-run the affected gates (`npm run test`, `bench:eval`, restore drill if data involved).
8. **Post-incident review** within 5 working days: timeline, root cause, blast radius, corrective actions, follow-up owners. File the report in `docs/` with the date.

## 4. Communication templates

**Tenant notification (SEV1/SEV2):**
> Subject: Security update — [DATE]
> We detected [incident type] affecting [scope] at [time]. [Data type] was
> [impact]. We have [containment actions] and are [remediation]. You do not
> need to take action unless [x]. We will update you within [timeframe].
> — KYC Copilot security team

**DPA / supervisory authority (Art. 33 draft skeleton):**
> Incident date: __ · Nature of the breach: __ · Categories of data: __
> Approx. number of data subjects: __ · Likely consequences: __
> Measures taken / proposed: __ · Point of contact: __

## 5. Where to look first (runbook anchors)

| Symptom | First check |
|---|---|
| Cases stuck queued/processing | BullMQ dashboard, `src/workers/graph-runner.ts`, Redis queue length |
| Webhooks silently failing | `GET /webhooks/:id/deliveries?status=failed`, DLQ `failedAt` |
| LLM cost spike | `/tenants/:id/usage`, LLM budget warnings (80%/100%) |
| Health degraded | `/health` + `/ready` (DB/Redis/OpenAI probes) |
| Suspected data exposure | Audit trail hash chain (`audit_logs`), `graphState` (PII stripped), encryption keys custody |

## 6. Post-incident artifacts

- Timeline doc (times + actions) — retained as DORA/GDPR evidence.
- Blast-radius analysis (records, tenants, jurisdictions).
- Corrective-action ticket(s) with owners + due dates.
- Updated runbook/controls (close the loop — never leave a gap undocumented).
