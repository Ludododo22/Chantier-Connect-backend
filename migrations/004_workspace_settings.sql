CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  tax_id text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT 'Gabon',
  language text NOT NULL DEFAULT 'fr',
  currency text NOT NULL DEFAULT 'XAF' CHECK (currency = 'XAF'),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_settings (tenant_id, legal_name)
SELECT id, name FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE platform_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  name text NOT NULL DEFAULT 'Chantier Connect',
  support_email text NOT NULL DEFAULT 'support@chantierconnect.ga',
  request_limit integer NOT NULL DEFAULT 120 CHECK (request_limit BETWEEN 10 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
