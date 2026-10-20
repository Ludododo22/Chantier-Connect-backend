ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE subscription_plans
  ADD COLUMN max_storage_mb integer
    CHECK (max_storage_mb IS NULL OR max_storage_mb > 0);
