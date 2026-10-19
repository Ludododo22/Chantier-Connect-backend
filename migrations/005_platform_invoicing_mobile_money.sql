CREATE SEQUENCE platform_invoice_number_seq;

CREATE TABLE platform_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 180),
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa > 0),
  issued_at date NOT NULL DEFAULT CURRENT_DATE,
  due_at date NOT NULL,
  status text NOT NULL DEFAULT 'À payer'
    CHECK (status IN ('À payer', 'Payée', 'Annulée')),
  payment_method text CHECK (
    payment_method IS NULL OR
    payment_method IN ('Espèces', 'Virement bancaire', 'Mobile Money', 'Autre')
  ),
  payment_reference text,
  paid_at timestamptz,
  closed_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'À payer' AND paid_at IS NULL AND closed_by IS NULL) OR
    (status = 'Payée' AND payment_method IS NOT NULL AND paid_at IS NOT NULL AND closed_by IS NOT NULL) OR
    (status = 'Annulée' AND paid_at IS NULL AND closed_by IS NOT NULL)
  ),
  CHECK (due_at >= issued_at)
);

CREATE INDEX platform_invoices_status_due_idx
  ON platform_invoices (status, due_at);
CREATE INDEX platform_invoices_tenant_status_idx
  ON platform_invoices (tenant_id, status, due_at DESC);

CREATE TABLE platform_mobile_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES platform_invoices(id),
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 2 AND 40),
  payer_phone text NOT NULL CHECK (length(payer_phone) BETWEEN 6 AND 32),
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa > 0),
  currency text NOT NULL DEFAULT 'XAF' CHECK (currency = 'XAF'),
  status text NOT NULL DEFAULT 'En attente'
    CHECK (status IN ('En attente', 'Payée', 'Échouée', 'Annulée')),
  idempotency_key text NOT NULL,
  provider_reference text,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (provider_key, idempotency_key),
  UNIQUE (provider_key, provider_reference)
);

CREATE INDEX platform_mobile_attempts_invoice_idx
  ON platform_mobile_payment_attempts (invoice_id, created_at DESC);

CREATE TABLE platform_mobile_payment_events (
  provider_key text NOT NULL,
  event_id text NOT NULL,
  payment_attempt_id uuid REFERENCES platform_mobile_payment_attempts(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider_key, event_id)
);