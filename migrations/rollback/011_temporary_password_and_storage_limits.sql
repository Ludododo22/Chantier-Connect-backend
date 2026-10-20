ALTER TABLE subscription_plans
  DROP COLUMN IF EXISTS max_storage_mb;

ALTER TABLE users
  DROP COLUMN IF EXISTS must_change_password;
