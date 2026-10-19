CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'Plan PME',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  phone text,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  initials text NOT NULL,
  role text NOT NULL CHECK (role IN (
    'EDITOR', 'ADMIN_ENTERPRISE', 'CONDUCTEUR', 'CHEF_CHANTIER',
    'COMPAGNON', 'SOUS_TRAITANT', 'COMPTABLE', 'MAITRE_OUVRAGE'
  )),
  role_label text NOT NULL,
  tenant_name text NOT NULL,
  tenant_plan text NOT NULL,
  assigned_site text,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
CREATE INDEX users_tenant_id_idx ON users (tenant_id);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text NOT NULL,
  status text NOT NULL DEFAULT 'En cours'
    CHECK (status IN ('En cours', 'En pause', 'Terminé')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  budget_fcfa bigint NOT NULL DEFAULT 0 CHECK (budget_fcfa >= 0),
  start_date date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE INDEX sites_tenant_id_idx ON sites (tenant_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'Général',
  priority text NOT NULL DEFAULT 'Normale'
    CHECK (priority IN ('Basse', 'Normale', 'Haute', 'Urgente')),
  status text NOT NULL DEFAULT 'À faire'
    CHECK (status IN ('À faire', 'En cours', 'Terminée', 'Bloquée')),
  due_date date,
  assigned_to uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users(id, tenant_id) ON DELETE SET NULL (assigned_to),
  FOREIGN KEY (created_by, tenant_id) REFERENCES users(id, tenant_id)
);

CREATE INDEX tasks_tenant_site_idx ON tasks (tenant_id, site_id);
CREATE INDEX tasks_assigned_to_idx ON tasks (assigned_to);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  author_id uuid NOT NULL,
  work_done text NOT NULL,
  crew_count integer NOT NULL DEFAULT 0 CHECK (crew_count BETWEEN 0 AND 500),
  status text NOT NULL DEFAULT 'À valider'
    CHECK (status IN ('À valider', 'Validé', 'Rejeté')),
  report_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_by uuid,
  validated_at timestamptz,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, tenant_id) REFERENCES users(id, tenant_id),
  FOREIGN KEY (validated_by, tenant_id) REFERENCES users(id, tenant_id)
);

CREATE INDEX reports_tenant_date_idx ON reports (tenant_id, report_date DESC);
CREATE INDEX reports_author_idx ON reports (author_id);
