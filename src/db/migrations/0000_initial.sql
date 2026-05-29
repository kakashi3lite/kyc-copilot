CREATE TYPE plan AS ENUM ('starter','growth','enterprise');
CREATE TYPE case_status AS ENUM ('queued','processing','pending_hitl','completed','failed','archived');
CREATE TYPE risk_score AS ENUM ('Low','Medium','High','Pending');

CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  plan plan NOT NULL DEFAULT 'starter',
  api_key_hash text NOT NULL,
  webhook_secret_encrypted text NOT NULL,
  llm_budget_usd numeric(10,2) NOT NULL DEFAULT '100.00',
  stripe_customer_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX tenants_plan_idx ON tenants(plan);
CREATE INDEX tenants_created_idx ON tenants(created_at);

CREATE TABLE users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'analyst',
  refresh_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX users_tenant_idx ON users(tenant_id);

CREATE TABLE cases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  company_name_encrypted text NOT NULL,
  company_name_mask text NOT NULL,
  registration_number_encrypted text NOT NULL,
  registration_number_mask text NOT NULL,
  jurisdiction varchar(2) NOT NULL,
  status case_status NOT NULL DEFAULT 'queued',
  risk_score risk_score NOT NULL DEFAULT 'Pending',
  requires_human boolean NOT NULL DEFAULT false,
  ubo_verified boolean NOT NULL DEFAULT false,
  browser_failed boolean NOT NULL DEFAULT false,
  dossier text NOT NULL DEFAULT '',
  graph_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX cases_tenant_id_idx ON cases(tenant_id);
CREATE INDEX cases_status_idx ON cases(status);
CREATE INDEX cases_risk_score_idx ON cases(risk_score);
CREATE INDEX cases_created_at_idx ON cases(created_at);

CREATE TABLE evidence (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  source_url_encrypted text NOT NULL,
  source_url_mask text NOT NULL,
  summary text NOT NULL,
  kind text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  previous_hash text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT evidence_case_key_unique UNIQUE(case_id, key)
);
CREATE INDEX evidence_case_id_idx ON evidence(case_id);
CREATE INDEX evidence_tenant_id_idx ON evidence(tenant_id);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  case_id text,
  actor text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_id_idx ON audit_logs(tenant_id);
CREATE INDEX audit_case_id_idx ON audit_logs(case_id);
CREATE INDEX audit_created_at_idx ON audit_logs(created_at);

CREATE TABLE usage (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  month varchar(7) NOT NULL,
  cases_processed integer NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT '0',
  api_calls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT usage_tenant_month_unique UNIQUE(tenant_id, month)
);
CREATE INDEX usage_tenant_id_idx ON usage(tenant_id);

CREATE TABLE webhooks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  url_encrypted text NOT NULL,
  url_mask text NOT NULL,
  secret_encrypted text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX webhooks_tenant_id_idx ON webhooks(tenant_id);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  webhook_id text NOT NULL,
  tenant_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX deliveries_tenant_id_idx ON webhook_deliveries(tenant_id);
CREATE INDEX deliveries_status_idx ON webhook_deliveries(status);

CREATE TABLE failed_cases (
  id text PRIMARY KEY,
  case_id text NOT NULL,
  tenant_id text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX failed_cases_case_id_idx ON failed_cases(case_id);

CREATE TABLE amld6_articles (
  id text PRIMARY KEY,
  article text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
