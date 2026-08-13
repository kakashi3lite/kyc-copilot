---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: DPA_PACK
title: Sub-Processor Register & Data Protection Agreement Pack
status: current
updated: 2026-08-13
owner: Principal AI Architect + RegTech Partner Architect (BD) + legal
related: [INCIDENT_RUNBOOK.md, PLAN_PRODUCTION_READINESS.md §Phase 5, ARCHITECTURE_CONTEXT.md]
---

# Sub-Processor Register & DPA Pack

> Every data processor KYC Copilot relies on must have a signed DPA (GDPR
> Art. 28), a documented EU-transfer mechanism (Art. 44–49), and a defined
> data scope. This register is the single source of truth for enterprise
> prospects' security questionnaires and our own Art. 30 record of processing.
>
> **This is not legal advice** — legal counsel must confirm each DPA and
> transfer mechanism before any enterprise signature.

## 1. Register (as of 2026-08-13)

| Provider | Service | Data categories processed | Role | EU-transfer mechanism | DPA status |
|---|---|---|---|---|---|
| **OpenAI** | LLM tiers t2/t4 (GPT-4o-mini/4o) | Dossier prompts — **pseudonymized only** (G1 redactor; no raw PII) | Processor | DPA + SCCs + **EU Data Boundary** (processing in EU) | To be countersigned |
| **Google** | LLM tier t3 (Gemini Flash) | Same (pseudonymized prompts) | Processor | DPA + SCCs + EU residency options | To be countersigned |
| **Anthropic** | LLM (adapter present, tiered routing) | Same (pseudonymized prompts) | Processor | DPA + SCCs | Optional until routed |
| **Ollama** | Local LLM t1 | None (local inference, $0, no egress) | n/a | n/a (local) | n/a |
| **ComplyAdvantage** | Sanctions/PEP screening | Company names + registration numbers (not individual PII) | Processor | DPA + SCCs | In place |
| **OpenCorporates** | Corporate registry lookup | Company names, officers (UBO data) | Controller-to-controller | n/a (business data) | API ToS |
| **Stripe** | Billing, Checkout, metered usage | Tenant + case **counts only** (no KYC PII; metering key is `case:<id>`) | Processor | DPA + SCCs | In place |
| **Resend** | Transactional email (reset links) | Email addresses, reset tokens | Processor | DPA + SCCs | Pending (wire-up phase) |
| **Fly.io** | Hosting: Postgres, Redis, volumes | Encrypted data at rest (EU region `ams`); runtime memory | Processor | Processor DPA + **EU data residency** (region ams) | In place |
| **Upstash (via Fly)** | Redis (queues, cache, rate limits) | Transient hashed/pseudonymous values | Processor | DPA + SCCs | Verify per contract |
| **Cloudflare R2** | Object storage (future S3 evidence) | Encrypted evidence blobs | Processor | DPA + SCCs | Pre-wired only (not active) |
| **Playwright browser** | Registry scraping | Public web pages only (no PII egress from our side) | n/a (compute) | n/a | n/a |

## 2. Privacy controls that shrink the register's blast radius

- **G1 PII redaction** — LLM providers only ever see HMAC pseudonyms
  (`ENTITY_A7B3`), never identity data. DPAs for LLM providers are the
  lowest-risk items on this register.
- **Encryption at rest (AES-256-GCM)** — a stolen volume without the key is not
  a notifiable breach (see `INCIDENT_RUNBOOK.md` §3 assess).
- **ADR-003 / graphState stripping** — PII is encrypted in DB columns; raw
  transaction data never persists to `graphState`.
- **EU residency** — Fly region `ams`; object storage + cache provisioned for
  EU.

## 3. Template — GDPR Art. 28 processor clause (skeleton for review)

> [Processor] shall process personal data only on documented instructions of
> [Controller] (KYC Copilot platform), for the purposes set out in Annex A
> (data categories, processing purpose, duration). [Processor] shall: (a) not
> use the data for its own purposes or for training models on [Controller]'s
> data without prior written consent; (b) implement appropriate technical and
> organisational measures (Art. 32) incl. encryption, access control, and
> breach notification ≤ 72 h; (c) grant audit rights; (d) return or destroy
> data at end of the term (Art. 28(3)(g)); (e) flow-down these terms to any
> sub-processor (registered in Annex B). Transfers outside the EEA rely on
> [SCCs 2021/914 Module 2 / EU Data Boundary], Annex C.

## 4. Annex B — sub-processor authorisation

- General authorisation: [Controller] authorises the sub-processors in §1.
- Objection: [Controller] may object to a new sub-processor ≤ 15 days; upon
  objection [Processor] shall either not engage it or terminate the affected
  service.

## 5. Maintenance

- Review this register **quarterly** and on any new dependency
  (`npm install` of a data-touching service) or provider-catalog change
  (`src/config/llm-providers.ts`).
- Every change bumps the register version and requires legal sign-off before
  enterprise use.
