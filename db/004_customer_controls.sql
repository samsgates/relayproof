SET search_path TO relay, public;
CREATE TABLE deletion_requests (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON deletion_requests USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
