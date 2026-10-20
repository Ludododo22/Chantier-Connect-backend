ALTER TABLE tenants
  DROP CONSTRAINT tenants_status_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('Actif', 'Essai', 'Impayé', 'Suspendu', 'Archivé'));

ALTER TABLE sites
  DROP CONSTRAINT sites_status_check;
ALTER TABLE sites
  ADD CONSTRAINT sites_status_check
    CHECK (status IN ('En cours', 'En pause', 'Terminé', 'Archivé'));

ALTER TABLE users
  ADD COLUMN assigned_site_id uuid,
  ADD COLUMN session_version integer NOT NULL DEFAULT 0,
  ADD COLUMN requires_user_consent boolean NOT NULL DEFAULT true,
  ADD COLUMN sensitive_data_consented_at timestamptz;

UPDATE users u
SET assigned_site_id = (
  SELECT s.id
  FROM sites s
  WHERE s.tenant_id = u.tenant_id
    AND s.name = u.assigned_site
  ORDER BY s.created_at, s.id
  LIMIT 1
)
WHERE u.tenant_id IS NOT NULL
  AND u.assigned_site IS NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_assigned_site_tenant_fk
    FOREIGN KEY (assigned_site_id, tenant_id)
    REFERENCES sites (id, tenant_id)
    ON DELETE SET NULL (assigned_site_id);

CREATE INDEX users_tenant_site_idx ON users (tenant_id, assigned_site_id);

ALTER TABLE registration_requests
  ADD COLUMN tenant_id uuid UNIQUE REFERENCES tenants(id) ON DELETE SET NULL;

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL,
  payload_masked jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_created_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_created_idx
  ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at) WHERE used_at IS NULL;
