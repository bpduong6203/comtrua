-- Migration number: 0005 	 2026-07-31T11:47:00.000Z
-- Alter table users to add clerk_id column and index
ALTER TABLE users ADD COLUMN clerk_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id);
