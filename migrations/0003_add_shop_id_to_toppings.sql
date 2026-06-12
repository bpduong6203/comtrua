-- Migration number: 0003 	 2026-06-12T12:55:30.000Z
-- Recreate toppings table to add shop_id and change unique constraint to unique(shop_id, name)

ALTER TABLE toppings RENAME TO toppings_old;

CREATE TABLE toppings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    active INTEGER DEFAULT 1,
    FOREIGN KEY(shop_id) REFERENCES shops(id),
    UNIQUE(shop_id, name)
);

-- Copy existing toppings and default them to shop_id = 1 (Quán Cơm Chiên)
INSERT INTO toppings (id, shop_id, name, price, active)
SELECT id, 1, name, price, active FROM toppings_old;

DROP TABLE toppings_old;
