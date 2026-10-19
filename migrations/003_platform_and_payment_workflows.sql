ALTER TABLE tenants
  ADD COLUMN status text NOT NULL DEFAULT 'Actif'
    CHECK (status IN ('Actif', 'Essai', 'Impayé', 'Suspendu'));

CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  monthly_price_fcfa bigint NOT NULL CHECK (monthly_price_fcfa >= 0),
  max_users integer CHECK (max_users IS NULL OR max_users > 0),
  max_sites integer CHECK (max_sites IS NULL OR max_sites > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (name, monthly_price_fcfa, max_users, max_sites)
VALUES
  ('Découverte', 25000, 5, 2),
  ('Plan PME', 75000, 30, 10),
  ('Entreprise', 0, 100, 100);

CREATE TABLE tenant_subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'Actif'
    CHECK (status IN ('Essai', 'Actif', 'Impayé', 'Suspendu', 'Résilié')),
  started_at timestamptz NOT NULL DEFAULT now(),
  renews_at date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_subscriptions (tenant_id, plan_id, status)
SELECT t.id, p.id,
       CASE WHEN t.status = 'Essai' THEN 'Essai' ELSE t.status END
FROM tenants t
JOIN subscription_plans p ON p.name = t.plan
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  subject text NOT NULL CHECK (length(subject) BETWEEN 2 AND 180),
  description text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'Normale'
    CHECK (priority IN ('Basse', 'Normale', 'Haute', 'Urgente')),
  status text NOT NULL DEFAULT 'Nouveau'
    CHECK (status IN ('Nouveau', 'En cours', 'En attente client', 'Résolu')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX support_tickets_status_created_idx
  ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_tenant_idx
  ON support_tickets (tenant_id, created_at DESC);

CREATE SEQUENCE payment_dossier_reference_seq;

CREATE TABLE payment_dossiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  created_by uuid NOT NULL,
  reference text NOT NULL UNIQUE,
  subject text NOT NULL CHECK (length(subject) BETWEEN 2 AND 180),
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa > 0),
  status text NOT NULL DEFAULT 'En préparation'
    CHECK (status IN (
      'En préparation', 'Prêt à transmettre', 'En instruction',
      'À corriger', 'Payé', 'Refusé'
    )),
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id),
  FOREIGN KEY (created_by, tenant_id) REFERENCES users(id, tenant_id)
);

CREATE INDEX payment_dossiers_tenant_status_idx
  ON payment_dossiers (tenant_id, status, created_at DESC);
