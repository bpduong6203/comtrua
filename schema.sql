-- 1. Bảng người dùng
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1, -- 1: Đang hoạt động, 0: Đã nghỉ/tạm ngưng
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng món ăn
CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL, -- Giá tiền VND
    active INTEGER DEFAULT 1 -- 1: Đang bán, 0: Tạm ngưng
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(dish_id) REFERENCES dishes(id),
    UNIQUE(date, user_id) -- Mỗi người chỉ được đặt tối đa 1 phần cơm một ngày!
);

-- Chèn dữ liệu món ăn mẫu ban đầu
INSERT OR IGNORE INTO dishes (id, name, price, active) VALUES
(1, 'Cơm Sườn Trứng', 35000, 1),
(2, 'Cơm Xào Bò', 30000, 1),
(3, 'Mì Xào Bò', 30000, 1),
(4, 'Nuôi Xào Bò', 30000, 1);

-- Chèn dữ liệu người dùng mẫu ban đầu
INSERT OR IGNORE INTO users (id, name, active) VALUES
(1, 'N.Minh', 1),
(2, 'P.Dương', 1);
-- 4. Bảng món thêm (Toppings)
CREATE TABLE IF NOT EXISTS toppings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL, -- Giá tiền VND (có thể là 0đ)
    active INTEGER DEFAULT 1 -- 1: Đang bán, 0: Tạm ngưng
);

-- Chèn dữ liệu món thêm mẫu ban đầu
INSERT OR IGNORE INTO toppings (id, name, price, active) VALUES
(1, 'Cơm thêm', 0, 1),
(2, 'Nhiều Cơm', 0, 1),
(3, 'Nhiều Mì', 0, 1),
(4, 'Nhiều Mì', 0, 1),
(5, 'Trứng ốp la', 5000, 1);