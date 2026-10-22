ALTER TABLE sites
  ADD COLUMN description text,
  ADD COLUMN city text,
  ADD COLUMN province text,
  ADD COLUMN client_name text,
  ADD COLUMN work_type text,
  ADD COLUMN contract_reference text,
  ADD COLUMN planned_duration_days integer
    CHECK (planned_duration_days BETWEEN 1 AND 3650);
