SET search_path TO relay, public;
CREATE TABLE subject_observations (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  subject text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,rule_id,subject),
  FOREIGN KEY (tenant_id,workspace_id,rule_id) REFERENCES rules(tenant_id,workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE subject_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON subject_observations USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
ALTER TABLE findings ADD COLUMN last_rule_version integer NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN streak_at timestamptz;
ALTER TABLE findings ADD COLUMN divergent_since timestamptz;
