-- Migration number: 0004 	 2026-06-13T07:18:00.000Z
-- Create payments table to track online payments with payOS
CREATE TABLE IF NOT EXISTS payments (
    order_code INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    order_ids TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Seed payments AUTOINCREMENT sequence to start order codes at 100001
-- Using user_id = 1 to satisfy the foreign key constraint (admin user guaranteed to exist)
INSERT INTO payments (order_code, user_id, amount, status, order_ids) VALUES (100000, 1, 0, 'SEED', '');
DELETE FROM payments WHERE order_code = 100000;
