CREATE TABLE registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  admin_full_name text NOT NULL,
  admin_email text NOT NULL,
  phone text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'Nouvelle' CHECK (
    status IN ('Nouvelle', 'En cours', 'Entreprise créée', 'Refusée')
  ),
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX registration_requests_status_created_at_idx
  ON registration_requests (status, created_at DESC);
