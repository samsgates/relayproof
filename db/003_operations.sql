SET search_path TO relay, public;
CREATE TABLE tenant_routes (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenant_routes(tenant_id) SELECT id FROM organizations ON CONFLICT DO NOTHING;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS evidence_input_id uuid;
