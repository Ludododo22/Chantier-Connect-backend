CREATE TABLE contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  topic text NOT NULL CHECK (
    topic IN (
      'Demander une démonstration',
      'Information sur une formule',
      'Autre demande'
    )
  ),
  message text NOT NULL,
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_requests_created_at_idx
  ON contact_requests (created_at DESC);
