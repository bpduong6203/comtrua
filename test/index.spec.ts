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
			password_hash TEXT,
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
			shop_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			price INTEGER NOT NULL,
			active INTEGER DEFAULT 1,
			FOREIGN KEY(shop_id) REFERENCES shops(id),
			UNIQUE(shop_id, name)
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS payments (
			order_code INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			amount INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'PENDING',
			order_ids TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(user_id) REFERENCES users(id)
		)`,
		`INSERT OR IGNORE INTO shops (id, name, active) VALUES (1, 'Quán Cơm Chiên', 1)`,
		`INSERT OR IGNORE INTO dishes (id, shop_id, name, price, active) VALUES (1, 1, 'Cơm Đùi Gà', 35000, 1)`,
		`INSERT OR IGNORE INTO toppings (id, shop_id, name, price, active) VALUES (5, 1, 'Trứng ốp la', 5000, 1)`
	];
	
	for (const sql of statements) {
		await env.DB.prepare(sql).run();
	}
}

describe("ComTrua Backend Tests", () => {
	beforeEach(async () => {
		// Clean start for each test
		await env.DB.exec(`
			DROP TABLE IF EXISTS payments;
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
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
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
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
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
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
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
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
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

	it("should upload avatar to R2 and serve it", async () => {
		// Register and login user A
		const loginReq = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(loginReq, env, ctx);
		await waitOnExecutionContext(ctx);
		const loginData = await response.json() as any;
		
		const sessionCookie = response.headers.get("Set-Cookie");
		expect(sessionCookie).not.toBeNull();

		// Construct FormData with an avatar image file
		const formData = new FormData();
		const testBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
		const testFile = new File([testBlob], "avatar.png", { type: "image/png" });
		formData.append("avatar", testFile);

		const uploadReq = new Request("http://example.com/api/users/upload-avatar", {
			method: "POST",
			headers: {
				"Cookie": sessionCookie || "",
			},
			body: formData,
		});
		ctx = createExecutionContext();
		response = await worker.fetch(uploadReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const uploadData = await response.json() as any;
		expect(uploadData.message).toBe("Tải ảnh đại diện thành công");
		expect(uploadData.avatarUrl).toContain("/avatars/");

		// Retrieve from R2 directly via route GET /avatars/:key
		const getAvatarReq = new Request(`http://example.com${uploadData.avatarUrl}`);
		ctx = createExecutionContext();
		response = await worker.fetch(getAvatarReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		const arrayBuf = await response.arrayBuffer();
		expect(new Uint8Array(arrayBuf)[0]).toBe(137); // PNG header check
	});

	it("should verify webhook signature and mark orders as paid", async () => {
		const crypto = require("node:crypto");
		
		// 1. Setup a user, order, and pending payment in D1
		await env.DB.prepare("INSERT INTO users (id, name) VALUES (1, 'P.Dương')").run();
		await env.DB.prepare("INSERT INTO orders (id, date, user_id, dish_id, dish_name, dish_price, paid) VALUES (101, '2026-06-13', 1, 1, 'Cơm Đùi Gà', 35000, 0)").run();
		await env.DB.prepare("INSERT INTO payments (order_code, user_id, amount, status, order_ids) VALUES (100001, 1, 35000, 'PENDING', '101')").run();

		// 2. Generate a valid webhook payload
		const webhookData = {
			orderCode: 100001,
			amount: 35000,
			description: "ComTruaPDuong",
			accountNumber: "123456789",
			reference: "FT12345",
			transactionDateTime: "2026-06-13T14:00:00",
			currency: "VND",
			paymentLinkId: "link_123",
			code: "00",
			desc: "success"
		};

		// Sort keys alphabetically to construct signData
		const sortedKeys = Object.keys(webhookData).sort();
		const signData = sortedKeys
			.map(key => `${key}=${(webhookData as any)[key]}`)
			.join('&');

		// Checksum key must match env.PAYOS_CHECKSUM_KEY or fallback
		const checksumKey = "ad30870d8b98cf51b5c031ad51d2ed6e0c2e8a89ca57542c87e9f1ad61669c35";
		const signature = crypto
			.createHmac('sha256', checksumKey)
			.update(signData)
			.digest('hex');

		const webhookPayload = {
			code: "00",
			desc: "success",
			data: webhookData,
			signature
		};

		// 3. Send the webhook request
		const request = new Request("http://example.com/api/payment/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(webhookPayload)
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			PAYOS_CHECKSUM_KEY: checksumKey
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const resData = await response.json() as any;
		expect(resData.success).toBe(true);

		// 4. Verify D1 database updates
		const paymentRow = await env.DB.prepare("SELECT status FROM payments WHERE order_code = 100001").first<any>();
		expect(paymentRow.status).toBe("PAID");

		const orderRow = await env.DB.prepare("SELECT paid FROM orders WHERE id = 101").first<any>();
		expect(orderRow.paid).toBe(1);
	});

	it("should return the payment status for a given orderCode", async () => {
		// 1. Setup a user, login to get session cookie, and insert a payment transaction
		const loginReq = new Request("http://example.com/api/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nguyễn Văn A", register: true, password: "123456" }),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(loginReq, env, ctx);
		await waitOnExecutionContext(ctx);
		const sessionCookie = response.headers.get("Set-Cookie");

		await env.DB.prepare("INSERT INTO payments (order_code, user_id, amount, status, order_ids) VALUES (200001, 1, 40000, 'PENDING', '102')").run();

		// 2. Fetch the payment status
		const statusReq = new Request("http://example.com/api/payment/status/200001", {
			method: "GET",
			headers: {
				"Cookie": sessionCookie || "",
			}
		});
		ctx = createExecutionContext();
		response = await worker.fetch(statusReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const statusData = await response.json() as any;
		expect(statusData.status).toBe("PENDING");
	});
});


