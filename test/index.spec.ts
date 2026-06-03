import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";

// Helper to initialize D1 database schema
async function setupDatabase() {
	const statements = [
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			phone TEXT,
			avatar TEXT DEFAULT '👤',
			default_note TEXT,
			active INTEGER DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS shops (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			active INTEGER DEFAULT 1
		)`,
		`CREATE TABLE IF NOT EXISTS dishes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			shop_id INTEGER NOT NULL DEFAULT 1,
			name TEXT NOT NULL UNIQUE,
			price INTEGER NOT NULL,
			active INTEGER DEFAULT 1,
			FOREIGN KEY(shop_id) REFERENCES shops(id)
		)`,
		`CREATE TABLE IF NOT EXISTS orders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			dish_id INTEGER NOT NULL,
			dish_name TEXT NOT NULL,
			dish_price INTEGER NOT NULL,
			paid INTEGER DEFAULT 0,
			note TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(user_id) REFERENCES users(id),
			FOREIGN KEY(dish_id) REFERENCES dishes(id),
			UNIQUE(date, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS toppings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			price INTEGER NOT NULL,
			active INTEGER DEFAULT 1
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`INSERT OR IGNORE INTO shops (id, name, active) VALUES (1, 'Quán Cơm Chiên', 1)`,
		`INSERT OR IGNORE INTO dishes (id, shop_id, name, price, active) VALUES (1, 1, 'Cơm Đùi Gà', 35000, 1)`,
		`INSERT OR IGNORE INTO toppings (id, name, price, active) VALUES (5, 'Trứng ốp la', 5000, 1)`
	];
	
	for (const sql of statements) {
		await env.DB.prepare(sql).run();
	}
}

describe("ComTrua Backend Tests", () => {
	beforeEach(async () => {
		// Clean start for each test
		await env.DB.exec(`
			DROP TABLE IF EXISTS orders;
			DROP TABLE IF EXISTS users;
			DROP TABLE IF EXISTS dishes;
			DROP TABLE IF EXISTS shops;
			DROP TABLE IF EXISTS toppings;
			DROP TABLE IF EXISTS settings;
		`);
		await setupDatabase();
	});

	it("should login and register user", async () => {
		const request = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json() as any;
		expect(data.message).toBe("Đăng nhập thành công");
		expect(data.user.name).toBe("Nguyễn Văn A");
		expect(data.user.avatar).toBe("👤"); // default avatar
	});

	it("should update user profile (name, phone, avatar, default_note)", async () => {
		// First login/register user
		const loginReq = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A" }),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(loginReq, env, ctx);
		await waitOnExecutionContext(ctx);
		const loginData = await response.json() as any;
		const userId = loginData.user.id;

		// Now update profile
		const updateReq = new Request(`http://example.com/api/users/${userId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Nguyễn Văn A - Cập Nhật",
				phone: "0987654321",
				avatar: "🦊",
				default_note: "Không hành, ít cay",
			}),
		});
		ctx = createExecutionContext();
		response = await worker.fetch(updateReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const updateData = await response.json() as any;
		expect(updateData.message).toBe("Cập nhật thông tin thành công");
		expect(updateData.user.name).toBe("Nguyễn Văn A - Cập Nhật");
		expect(updateData.user.phone).toBe("0987654321");
		expect(updateData.user.avatar).toBe("🦊");
		expect(updateData.user.default_note).toBe("Không hành, ít cay");

		// Verify database row
		const userRow = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
			.bind(userId)
			.first<any>();
		expect(userRow.name).toBe("Nguyễn Văn A - Cập Nhật");
		expect(userRow.phone).toBe("0987654321");
		expect(userRow.avatar).toBe("🦊");
		expect(userRow.default_note).toBe("Không hành, ít cay");
	});

	it("should place order with custom order note and retrieve it in orders list", async () => {
		// Register a user
		const loginReq = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A" }),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(loginReq, env, ctx);
		await waitOnExecutionContext(ctx);
		const loginData = await response.json() as any;
		const userId = loginData.user.id;

		// Set default profile phone and avatar
		const updateReq = new Request(`http://example.com/api/users/${userId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Nguyễn Văn A",
				phone: "0987654321",
				avatar: "🐱",
				default_note: "Không hành",
			}),
		});
		ctx = createExecutionContext();
		response = await worker.fetch(updateReq, env, ctx);
		await waitOnExecutionContext(ctx);

		// Place an order for dish 1 ("Cơm Đùi Gà" from shop 1) with custom note
		const orderReq = new Request("http://example.com/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				user_id: userId,
				dish_id: 1,
				date: "2026-05-22",
				topping_ids: [5], // Trứng ốp la (5000đ)
				note: "Ít cơm, thêm trứng chín kỹ",
			}),
		});
		ctx = createExecutionContext();
		response = await worker.fetch(orderReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const orderData = await response.json() as any;
		expect(orderData.message).toBe("Đặt cơm thành công");

		// Fetch orders and verify
		const getOrdersReq = new Request("http://example.com/api/orders?date=2026-05-22");
		ctx = createExecutionContext();
		response = await worker.fetch(getOrdersReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const ordersList = await response.json() as any[];
		expect(ordersList.length).toBe(1);
		expect(ordersList[0].user_name).toBe("Nguyễn Văn A");
		expect(ordersList[0].user_phone).toBe("0987654321");
		expect(ordersList[0].user_avatar).toBe("🐱");
		expect(ordersList[0].dish_name).toContain("Cơm Đùi Gà");
		expect(ordersList[0].dish_name).toContain("Trứng ốp la");
		expect(ordersList[0].note).toBe("Ít cơm, thêm trứng chín kỹ");
	});

	it("should calculate cumulative spending stats correctly", async () => {
		// Register a user
		const loginReq = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A" }),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(loginReq, env, ctx);
		await waitOnExecutionContext(ctx);
		const loginData = await response.json() as any;
		const userId = loginData.user.id;

		// Place an order for dish 1 (35000)
		const orderReq = new Request("http://example.com/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				user_id: userId,
				dish_id: 1,
				date: "2026-05-22",
				topping_ids: [],
			}),
		});
		ctx = createExecutionContext();
		response = await worker.fetch(orderReq, env, ctx);
		await waitOnExecutionContext(ctx);

		// Now fetch spending stats
		const statsReq = new Request("http://example.com/api/stats/spending");
		ctx = createExecutionContext();
		response = await worker.fetch(statsReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const stats = await response.json() as any;
		expect(stats.grand_total).toBe(35000);
		expect(stats.grand_paid).toBe(0);
		expect(stats.grand_unpaid).toBe(35000);
		expect(stats.users_breakdown.length).toBe(1);
		expect(stats.users_breakdown[0].user_name).toBe("Nguyễn Văn A");
		expect(stats.users_breakdown[0].total_orders).toBe(1);
		expect(stats.users_breakdown[0].total_spent).toBe(35000);
		expect(stats.users_breakdown[0].total_unpaid).toBe(35000);
	});
});

