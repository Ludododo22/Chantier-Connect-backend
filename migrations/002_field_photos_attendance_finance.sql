CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  author_id uuid NOT NULL,
  caption text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  image_data bytea NOT NULL,
  sha256 char(64) NOT NULL,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, tenant_id) REFERENCES users(id, tenant_id)
);

CREATE INDEX photos_tenant_site_created_idx ON photos (tenant_id, site_id, created_at DESC);

CREATE TABLE attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  clock_in_at timestamptz NOT NULL DEFAULT now(),
  clock_in_latitude double precision CHECK (clock_in_latitude BETWEEN -90 AND 90),
  clock_in_longitude double precision CHECK (clock_in_longitude BETWEEN -180 AND 180),
  clock_out_at timestamptz,
  clock_out_latitude double precision CHECK (clock_out_latitude BETWEEN -90 AND 90),
  clock_out_longitude double precision CHECK (clock_out_longitude BETWEEN -180 AND 180),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id),
  CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);

CREATE UNIQUE INDEX attendance_one_open_shift_per_user
  ON attendance_records (user_id) WHERE clock_out_at IS NULL;
CREATE INDEX attendance_tenant_user_clock_in_idx
  ON attendance_records (tenant_id, user_id, clock_in_at DESC);

CREATE TABLE finance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  created_by uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('engagement', 'encaissement', 'depense')),
  category text NOT NULL,
  description text NOT NULL,
  amount_fcfa bigint NOT NULL CHECK (amount_fcfa > 0),
  status text NOT NULL DEFAULT 'prévu' CHECK (status IN ('prévu', 'réalisé')),
  due_date date,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id),
  FOREIGN KEY (created_by, tenant_id) REFERENCES users(id, tenant_id),
  CHECK (
    (status = 'prévu' AND occurred_at IS NULL)
    OR (status = 'réalisé' AND occurred_at IS NOT NULL)
  )
);

CREATE INDEX finance_entries_tenant_site_type_idx
  ON finance_entries (tenant_id, site_id, entry_type, created_at DESC);
