CREATE TABLE company_operating_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa >= 0),
  notes text NOT NULL DEFAULT '',
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_year),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES users(id, tenant_id)
);

CREATE TABLE supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  created_by uuid NOT NULL,
  supplier_name text NOT NULL CHECK (length(supplier_name) BETWEEN 2 AND 180),
  invoice_reference text NOT NULL CHECK (length(invoice_reference) BETWEEN 1 AND 100),
  category text NOT NULL CHECK (length(category) BETWEEN 2 AND 100),
  description text NOT NULL DEFAULT '',
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa > 0),
  invoice_date date,
  due_date date,
  status text NOT NULL DEFAULT 'En préparation'
    CHECK (status IN ('En préparation', 'À contrôler', 'Approuvée', 'Payée', 'Refusée')),
  payment_reference text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id),
  FOREIGN KEY (created_by, tenant_id) REFERENCES users(id, tenant_id),
  CHECK ((status = 'Payée') = (paid_at IS NOT NULL))
);

CREATE UNIQUE INDEX supplier_invoices_tenant_reference_unique
  ON supplier_invoices (tenant_id, lower(supplier_name), lower(invoice_reference));
CREATE INDEX supplier_invoices_tenant_status_due_idx
  ON supplier_invoices (tenant_id, status, due_date);

ALTER TABLE payment_dossiers
  ADD COLUMN payment_reference text;
