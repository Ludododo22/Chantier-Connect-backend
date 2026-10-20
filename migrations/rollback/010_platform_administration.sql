DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS audit_logs;

UPDATE sites SET status = 'Terminé' WHERE status = 'Archivé';
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_status_check;
ALTER TABLE sites
  ADD CONSTRAINT sites_status_check
    CHECK (status IN ('En cours', 'En pause', 'Terminé'));

ALTER TABLE registration_requests DROP COLUMN IF EXISTS tenant_id;

DROP INDEX IF EXISTS users_tenant_site_idx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_assigned_site_tenant_fk;
ALTER TABLE users
  DROP COLUMN IF EXISTS assigned_site_id,
  DROP COLUMN IF EXISTS session_version,
  DROP COLUMN IF EXISTS requires_user_consent,
  DROP COLUMN IF EXISTS sensitive_data_consented_at;

UPDATE tenants SET status = 'Suspendu' WHERE status = 'Archivé';
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('Actif', 'Essai', 'Impayé', 'Suspendu'));
