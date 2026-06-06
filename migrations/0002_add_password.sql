-- Migration number: 0002 	 2026-06-05T08:00:00.000Z
-- Alter table users to add password_hash column
ALTER TABLE users ADD COLUMN password_hash TEXT;
