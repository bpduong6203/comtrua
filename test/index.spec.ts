import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

// Helper to create database tables
async function setupDatabase() {
	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			clerk_id TEXT UNIQUE,
			name TEXT NOT NULL UNIQUE,
			phone TEXT,
			avatar TEXT DEFAULT '👤',
			default_note TEXT,
			active INTEGER DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS shops (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			active INTEGER DEFAULT 1
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS dishes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			shop_id INTEGER NOT NULL DEFAULT 1,
			name TEXT NOT NULL UNIQUE,
			price INTEGER NOT NULL,
			active INTEGER DEFAULT 1,
			FOREIGN KEY(shop_id) REFERENCES shops(id)
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS orders (
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
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS toppings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			shop_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			price INTEGER NOT NULL,
			active INTEGER DEFAULT 1,
			FOREIGN KEY(shop_id) REFERENCES shops(id),
			UNIQUE(shop_id, name)
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS payments (
			order_code INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL,
			amount INTEGER NOT NULL,
			status TEXT DEFAULT 'PENDING',
			order_ids TEXT NOT NULL,
			payment_link_id TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(user_id) REFERENCES users(id)
		)
	`).run();

	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`).run();

	await env.DB.prepare("INSERT OR IGNORE INTO shops (id, name, active) VALUES (1, 'Quán Cơm Chiên', 1)").run();
	await env.DB.prepare("INSERT OR IGNORE INTO dishes (id, shop_id, name, price, active) VALUES (1, 1, 'Cơm Đùi Gà', 35000, 1)").run();
	await env.DB.prepare("INSERT OR IGNORE INTO toppings (id, shop_id, name, price, active) VALUES (5, 1, 'Trứng ốp la', 5000, 1)").run();
}

async function createClerkUser(name: string, clerkId: string = 'user_clerk_1') {
	const linkReq = new Request('http://example.com/api/users/link-clerk', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ clerkId, newName: name })
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(linkReq, env, ctx);
	await waitOnExecutionContext(ctx);
	const data = (await response.json()) as any;
	const sessionCookie = response.headers.get('Set-Cookie');
	return { response, data, user: data.user, sessionCookie };
}

describe('ComTrua Backend Tests', () => {
	beforeEach(async () => {
		await setupDatabase();
		await env.DB.prepare('PRAGMA foreign_keys = OFF').run();
		await env.DB.prepare('DELETE FROM payments').run();
		await env.DB.prepare('DELETE FROM orders').run();
		await env.DB.prepare('DELETE FROM users').run();
		await env.DB.prepare('DELETE FROM toppings').run();
		await env.DB.prepare('DELETE FROM dishes').run();
		await env.DB.prepare('DELETE FROM shops').run();
		await env.DB.prepare('DELETE FROM settings').run();
		await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('order_deadline', '23:59')").run();
		await env.DB.prepare('PRAGMA foreign_keys = ON').run();
		await env.DB.prepare("INSERT OR IGNORE INTO shops (id, name, active) VALUES (1, 'Quán Cơm Chiên', 1)").run();
		await env.DB.prepare("INSERT OR IGNORE INTO dishes (id, shop_id, name, price, active) VALUES (1, 1, 'Cơm Đùi Gà', 35000, 1)").run();
		await env.DB.prepare("INSERT OR IGNORE INTO toppings (id, shop_id, name, price, active) VALUES (5, 1, 'Trứng ốp la', 5000, 1)").run();
	});

	it('should reject legacy login and require Clerk authentication', async () => {
		const request = new Request('http://example.com/api/users/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Nguyễn Văn A', password: '123456' })
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('Clerk');
	});

	it('should authenticate and link user with Clerk', async () => {
		const { response, user, sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_123');

		expect(response.status).toBe(200);
		expect(user.name).toBe('Nguyễn Văn A');
		expect(user.clerk_id).toBe('user_clerk_123');
		expect(sessionCookie).not.toBeNull();
	});

	it('should update user profile (name, phone, avatar, default_note)', async () => {
		const { user, sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_patch');
		const userId = user.id;

		const updateReq = new Request(`http://example.com/api/users/${userId}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Cookie: sessionCookie || ''
			},
			body: JSON.stringify({
				name: 'Nguyễn Văn A - Cập Nhật',
				phone: '0987654321',
				avatar: '🦊',
				default_note: 'Không hành, ít cay'
			})
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(updateReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const updateData = (await response.json()) as any;
		expect(updateData.message).toBe('Cập nhật thông tin thành công');
		expect(updateData.user.name).toBe('Nguyễn Văn A - Cập Nhật');
		expect(updateData.user.phone).toBe('0987654321');
		expect(updateData.user.avatar).toBe('🦊');
		expect(updateData.user.default_note).toBe('Không hành, ít cay');
	});

	it('should place order with custom order note and retrieve it in orders list', async () => {
		const { user, sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_order');
		const userId = user.id;

		const updateReq = new Request(`http://example.com/api/users/${userId}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Cookie: sessionCookie || ''
			},
			body: JSON.stringify({
				name: 'Nguyễn Văn A',
				phone: '0987654321',
				avatar: '🐱',
				default_note: 'Không hành'
			})
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(updateReq, env, ctx);
		await waitOnExecutionContext(ctx);

		const today = new Date().toISOString().split('T')[0];
		const orderReq = new Request('http://example.com/api/orders', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: sessionCookie || ''
			},
			body: JSON.stringify({
				user_id: userId,
				dish_id: 1,
				date: today,
				topping_ids: [5],
				note: 'Ít cơm, thêm trứng chín kỹ'
			})
		});
		ctx = createExecutionContext();
		response = await worker.fetch(orderReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const orderData = (await response.json()) as any;
		expect(orderData.message).toBe('Đặt cơm thành công');

		const getOrdersReq = new Request(`http://example.com/api/orders?date=${today}`);
		ctx = createExecutionContext();
		response = await worker.fetch(getOrdersReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const ordersList = (await response.json()) as any[];
		expect(ordersList.length).toBe(1);
		expect(ordersList[0].user_name).toBe('Nguyễn Văn A');
		expect(ordersList[0].dish_name).toContain('Cơm Đùi Gà');
		expect(ordersList[0].note).toBe('Ít cơm, thêm trứng chín kỹ');
	});

	it('should calculate cumulative spending stats correctly', async () => {
		const { user, sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_stats');
		const userId = user.id;
		const today = new Date().toISOString().split('T')[0];

		const orderReq = new Request('http://example.com/api/orders', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: sessionCookie || ''
			},
			body: JSON.stringify({
				user_id: userId,
				dish_id: 1,
				date: today,
				topping_ids: []
			})
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(orderReq, env, ctx);
		await waitOnExecutionContext(ctx);

		const statsReq = new Request('http://example.com/api/stats/spending');
		ctx = createExecutionContext();
		response = await worker.fetch(statsReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const stats = (await response.json()) as any;
		expect(stats.grand_total).toBe(35000);
		expect(stats.grand_unpaid).toBe(35000);
		expect(stats.users_breakdown.length).toBe(1);
		expect(stats.users_breakdown[0].user_name).toBe('Nguyễn Văn A');
	});

	it('should upload avatar to R2 and serve it', async () => {
		const { sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_r2');
		expect(sessionCookie).not.toBeNull();

		const formData = new FormData();
		const testBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
		const testFile = new File([testBlob], 'avatar.png', { type: 'image/png' });
		formData.append('avatar', testFile);

		const uploadReq = new Request('http://example.com/api/users/upload-avatar', {
			method: 'POST',
			headers: {
				Cookie: sessionCookie || ''
			},
			body: formData
		});

		let ctx = createExecutionContext();
		let response = await worker.fetch(uploadReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.avatarUrl).toBeDefined();

		const avatarPath = data.avatarUrl;
		const getReq = new Request(`http://example.com${avatarPath}`);
		ctx = createExecutionContext();
		response = await worker.fetch(getReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
	});

	it('should verify webhook signature and mark orders as paid', async () => {
		const { user } = await createClerkUser('P.Dương', 'user_clerk_duong');

		await env.DB.prepare(
			'INSERT INTO orders (id, date, user_id, dish_id, dish_name, dish_price, paid) VALUES (101, "2026-06-13", ?, 1, "Cơm Sườn", 35000, 0)'
		)
			.bind(user.id)
			.run();

		await env.DB.prepare(
			"INSERT INTO payments (order_code, user_id, amount, status, order_ids) VALUES (100001, ?, 35000, 'PENDING', '101')"
		)
			.bind(user.id)
			.run();

		const webhookPayload = {
			code: '00',
			desc: 'success',
			data: {
				orderCode: 100001,
				amount: 35000,
				description: 'ComTruaPDuong',
				accountNumber: '123456789',
				reference: 'FT12345',
				transactionDateTime: '2026-06-13T14:00:00',
				currency: 'VND',
				paymentLinkId: 'link_123',
				code: '00',
				desc: 'success'
			},
			signature: '91c9f5fa321beba101c1e5a0b7c3d2341ef9c545837687103cd13a951eedcdb4'
		};

		const webhookReq = new Request('http://example.com/api/payment/webhook', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(webhookPayload)
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(webhookReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const resData = (await response.json()) as any;
		expect(resData.success).toBe(true);

		const paymentRow = await env.DB.prepare('SELECT status FROM payments WHERE order_code = 100001').first<any>();
		expect(paymentRow.status).toBe('PAID');

		const orderRow = await env.DB.prepare('SELECT paid FROM orders WHERE id = 101').first<any>();
		expect(orderRow.paid).toBe(1);
	});

	it('should return the payment status for a given orderCode', async () => {
		const { user, sessionCookie } = await createClerkUser('Nguyễn Văn A', 'user_clerk_status');

		await env.DB.prepare(
			"INSERT INTO payments (order_code, user_id, amount, status, order_ids) VALUES (200001, ?, 40000, 'PENDING', '102')"
		)
			.bind(user.id)
			.run();

		const statusReq = new Request('http://example.com/api/payment/status/200001', {
			method: 'GET',
			headers: {
				Cookie: sessionCookie || ''
			}
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(statusReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const statusData = (await response.json()) as any;
		expect(statusData.status).toBe('PENDING');
	});

	it('should exclude users who already picked up lunch earlier in the week', async () => {
		const { user: admin, sessionCookie } = await createClerkUser('Admin', 'user_clerk_admin');

		await env.DB.prepare("INSERT INTO users (id, name) VALUES (2, 'User B'), (3, 'User C'), (4, 'User D')").run();

		const mondayPickers = [
			{ id: admin.id, name: 'Admin', avatar: '👤' },
			{ id: 2, name: 'User B', avatar: '👤' }
		];
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('lunch_pickers_2026-07-20', ?)").bind(JSON.stringify(mondayPickers)).run();

		for (const uId of [admin.id, 2, 3, 4]) {
			await env.DB.prepare("INSERT INTO orders (date, user_id, dish_id, dish_name, dish_price) VALUES ('2026-07-21', ?, 1, 'Cơm Sườn', 35000)").bind(uId).run();
		}

		const spinReq = new Request('http://example.com/api/lunch-pickers', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: sessionCookie || ''
			},
			body: JSON.stringify({ date: '2026-07-21' })
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(spinReq, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		const pickedIds = data.pickers.map((p: any) => p.id).sort();

		expect(pickedIds).toEqual([3, 4]);
	});
});
