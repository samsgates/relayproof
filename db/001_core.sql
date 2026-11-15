CREATE SCHEMA IF NOT EXISTS relay;
SET search_path TO relay, public;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text,
  federated_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleting')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer','auditor')),
  PRIMARY KEY (tenant_id,user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE TABLE workspaces (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  state text NOT NULL DEFAULT 'setup' CHECK (state IN ('setup','active','paused')),
  alert_emails boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE workspace_memberships (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','operator','viewer','auditor')),
  PRIMARY KEY (tenant_id,workspace_id,user_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE
);
CREATE TABLE invites (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','operator','viewer','auditor')),
  digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE entitlements (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'pilot',
  active_scope_limit int NOT NULL DEFAULT 1 CHECK (active_scope_limit BETWEEN 1 AND 100),
  evidence_days int NOT NULL DEFAULT 365 CHECK (evidence_days BETWEEN 1 AND 3650),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused'))
);
CREATE TABLE connections (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('servicenow','jira','github','entra','aws')),
  label text NOT NULL,
  host text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  credentials text,
  health text NOT NULL DEFAULT 'untested' CHECK (health IN ('untested','healthy','degraded','revoked')),
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,provider),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE rules (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  module text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  draft jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE rule_versions (
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  version integer NOT NULL,
  config jsonb NOT NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,rule_id,version),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES rules(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE source_records (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  kind text NOT NULL,
  native_id text NOT NULL,
  provider_updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,connection_id,kind,native_id),
  FOREIGN KEY (tenant_id,workspace_id,connection_id) REFERENCES connections(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX source_scope ON source_records(tenant_id,workspace_id,kind,observed_at);
CREATE TABLE checkpoints (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  source text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  state text NOT NULL,
  PRIMARY KEY (tenant_id,rule_id,source),
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE evidence_inputs (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_kind text NOT NULL,
  sample jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX inputs_rule ON evidence_inputs(tenant_id,rule_id,created_at DESC);
CREATE TABLE findings (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  streak integer NOT NULL DEFAULT 0,
  last_outcome text NOT NULL DEFAULT 'unknown',
  last_observation uuid,
  first_due_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,rule_id,subject,kind),
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE occurrences (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence integer NOT NULL,
  state text NOT NULL CHECK (state IN ('open','acknowledged','suppressed','resolved','dismissed')),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  suppressed_until timestamptz,
  closure_reason text,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,finding_id,sequence),
  FOREIGN KEY (tenant_id,workspace_id,finding_id) REFERENCES findings(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX occurrence_active ON occurrences(tenant_id,finding_id) WHERE closed_at IS NULL;
CREATE INDEX inbox_scope ON occurrences(tenant_id,workspace_id,state,opened_at DESC,id DESC);
CREATE TABLE runs (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  summary jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX runs_workspace ON runs(tenant_id,workspace_id,created_at DESC);
CREATE TABLE evaluations (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  run_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  occurrence_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('pass','fail','unknown')),
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,finding_id),
  FOREIGN KEY (tenant_id,workspace_id,run_id) REFERENCES runs(tenant_id,workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,workspace_id,finding_id) REFERENCES findings(tenant_id,workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,workspace_id,occurrence_id) REFERENCES occurrences(tenant_id,workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,rule_id,rule_version) REFERENCES rule_versions(tenant_id,rule_id,version)
);
CREATE INDEX evidence_finding ON evaluations(tenant_id,finding_id,observed_at DESC);
CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  id bigint GENERATED ALWAYS AS IDENTITY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX audit_scope ON audit_events(tenant_id,workspace_id,created_at DESC);
CREATE TABLE exports (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued',
  filters jsonb NOT NULL DEFAULT '{}',
  content text,
  row_count int,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE idempotency (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,actor_id,key)
);
CREATE TABLE inbox_outbox (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  summary jsonb NOT NULL,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,dedupe_key),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
-- Routing tables carry only identifiers. Web and worker code use RLS-scoped domain transactions.
CREATE TABLE schedule_routes (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  interval_minutes int NOT NULL CHECK(interval_minutes BETWEEN 5 AND 1440),
  next_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,rule_id),
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  target_id uuid,
  run_id uuid,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  lease_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX jobs_ready ON jobs(status,available_at,leased_until);
SET search_path TO relay, public;
CREATE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('relay.tenant',true),'')::uuid
$$;
CREATE FUNCTION current_actor() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('relay.actor',true),'')::uuid
$$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON organizations USING (id = current_tenant()) WITH CHECK (id = current_tenant());
-- Membership discovery may read only the authenticated user's own membership outside a tenant transaction.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON memberships USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY own_membership ON memberships FOR SELECT USING (current_tenant() IS NULL AND user_id = current_actor());
DO $$
DECLARE entity text;
BEGIN
  FOREACH entity IN ARRAY ARRAY['workspaces','workspace_memberships','invites','entitlements','connections','rules','rule_versions','source_records','checkpoints','evidence_inputs','findings','occurrences','runs','evaluations','audit_events','exports','idempotency','inbox_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',entity);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',entity);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (tenant_id = relay.current_tenant()) WITH CHECK (tenant_id = relay.current_tenant())',entity);
  END LOOP;
END $$;
