-- Migration number: 0006 	 2026-08-20T14:45:00.000Z
-- Gamification: Balance in VND, Avatar Frames, Titles, Predictions, Transactions

ALTER TABLE users ADD COLUMN balance INTEGER DEFAULT 100000;
ALTER TABLE users ADD COLUMN avatar_frame TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN custom_title TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN owned_items TEXT DEFAULT '[]';

-- Initialize balance for existing users
UPDATE users SET balance = 100000 WHERE balance IS NULL;

-- Table for Race Top 1-2-3 Predictions
CREATE TABLE IF NOT EXISTS race_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    predicted_user_id INTEGER NOT NULL,
    predicted_rank INTEGER NOT NULL DEFAULT 1,
    bet_amount INTEGER NOT NULL DEFAULT 10000,
    payout INTEGER DEFAULT 0,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(predicted_user_id) REFERENCES users(id),
    UNIQUE(date, user_id)
);

CREATE INDEX IF NOT EXISTS idx_predictions_date ON race_predictions(date);

-- Table for VND Balance Transactions Log
CREATE TABLE IF NOT EXISTS coin_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id);
