-- 1. Bảng người dùng
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    phone TEXT,
    avatar TEXT DEFAULT '👤',
    default_note TEXT,
    active INTEGER DEFAULT 1, -- 1: Đang hoạt động, 0: Đã nghỉ/tạm ngưng
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1.5 Bảng cửa hàng
CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1 -- 1: Hoạt động, 0: Tạm ngưng
);

-- 2. Bảng món ăn
CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL, -- Giá tiền VND
    active INTEGER DEFAULT 1, -- 1: Đang bán, 0: Tạm ngưng
    FOREIGN KEY(shop_id) REFERENCES shops(id)
);

-- 3. Bảng đơn đặt cơm
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, -- Định dạng YYYY-MM-DD
    user_id INTEGER NOT NULL,
    dish_id INTEGER NOT NULL,
    dish_name TEXT NOT NULL, -- Lưu snapshot phòng khi món ăn bị đổi tên sau này
    dish_price INTEGER NOT NULL, -- Lưu snapshot giá lúc đặt cơm
    paid INTEGER DEFAULT 0, -- 0: Chưa thanh toán, 1: Đã thanh toán
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(dish_id) REFERENCES dishes(id),
    UNIQUE(date, user_id) -- Mỗi người chỉ được đặt tối đa 1 phần cơm một ngày!
);


-- Chèn dữ liệu cửa hàng mẫu ban đầu
INSERT OR IGNORE INTO shops (id, name, active) VALUES
(1, 'Quán Cơm Chiên', 1),
(2, 'Quán Cơm Sườn', 1);

-- Chèn dữ liệu món ăn mẫu ban đầu
INSERT OR IGNORE INTO dishes (id, shop_id, name, price, active) VALUES
(1, 1, 'Cơm Đùi Gà', 35000, 1),
(2, 1, 'Cơm Xào Bò', 30000, 1),
(3, 1, 'Mì Xào Bò', 30000, 1),
(4, 1, 'Nuôi Xào Bò', 30000, 1),
(5, 2, 'Cơm Sườn Trứng', 35000, 1),
(6, 2, 'Cơm Sườn Bì Chả', 35000, 1),
(7, 2, 'Cơm Cá Kho', 35000, 1);

-- Chèn dữ liệu người dùng mẫu ban đầu
INSERT OR IGNORE INTO users (id, name, active) VALUES
(1, 'P.Dương', 1);

-- 4. Bảng món thêm (Toppings)
CREATE TABLE IF NOT EXISTS toppings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL, -- Giá tiền VND (có thể là 0đ)
    active INTEGER DEFAULT 1, -- 1: Đang bán, 0: Tạm ngưng
    FOREIGN KEY(shop_id) REFERENCES shops(id),
    UNIQUE(shop_id, name)
);

-- Chèn dữ liệu món thêm mẫu ban đầu
INSERT OR IGNORE INTO toppings (id, shop_id, name, price, active) VALUES
(1, 1, 'Cơm thêm', 0, 1),
(2, 1, 'Nhiều Cơm', 0, 1),
(3, 1, 'Nhiều Mì', 0, 1),
(4, 1, 'Nhiều Nuôi', 0, 1),
(5, 2, 'Trứng ốp la', 5000, 1);

-- 5. Bảng cài đặt hệ thống (Settings)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Chèn dữ liệu cài đặt mẫu mặc định ban đầu
INSERT OR IGNORE INTO settings (key, value) VALUES
('order_deadline', '11:00');