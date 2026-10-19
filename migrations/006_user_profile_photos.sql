ALTER TABLE users
  ADD COLUMN profile_photo_data bytea,
  ADD COLUMN profile_photo_content_type text,
  ADD CONSTRAINT users_profile_photo_type_check
    CHECK (
      profile_photo_content_type IS NULL OR
      profile_photo_content_type IN ('image/jpeg', 'image/png', 'image/webp')
    ),
  ADD CONSTRAINT users_profile_photo_pair_check
    CHECK ((profile_photo_data IS NULL) = (profile_photo_content_type IS NULL));