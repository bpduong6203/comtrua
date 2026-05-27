-- Migration number: 0001 	 2026-05-27T02:58:48.946Z
-- Alter table users to add profile columns
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '👤';
ALTER TABLE users ADD COLUMN default_note TEXT;

-- Alter table orders to add note column
ALTER TABLE orders ADD COLUMN note TEXT;
