/**
 * Backend API for ComTrua (Lunch Ordering Project)
 * Built on Cloudflare Workers and D1 Database
 */

export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	JWT_SECRET?: string;
	AI: any;
	GEMINI_API_KEY?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_AI_GATEWAY?: string;
}

// Cookie helpers
function getCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader) return null;
	const cookies = cookieHeader.split(';');
	for (let cookie of cookies) {
		const [key, val] = cookie.trim().split('=');
		if (key === name) {
			return decodeURIComponent(val);
		}
	}
	return null;
}

// Cryptography helpers (PBKDF2 SHA-256)
function generateSalt(): string {
	const arr = new Uint8Array(16);
	crypto.getRandomValues(arr);
	return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits', 'deriveKey']
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: encoder.encode(salt),
			iterations: 100000,
			hash: 'SHA-256'
		},
		keyMaterial,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		true,
		['sign']
	);
	const exported = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
	return Array.from(new Uint8Array(exported)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// JWT Helpers (HS256)
async function base64urlEncode(str: string | ArrayBuffer): Promise<string> {
	let bytes: Uint8Array;
	if (typeof str === 'string') {
		bytes = new TextEncoder().encode(str);
	} else {
		bytes = new Uint8Array(str);
	}
	let binString = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binString += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binString);
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	while (base64.length % 4) {
		base64 += '=';
	}
	const binString = atob(base64);
	const bytes = new Uint8Array(binString.length);
	for (let i = 0; i < binString.length; i++) {
		bytes[i] = binString.charCodeAt(i);
	}
	return bytes;
}

async function signJwt(payload: any, secret: string): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const encodedHeader = await base64urlEncode(JSON.stringify(header));
	const encodedPayload = await base64urlEncode(JSON.stringify(payload));

	const tokenInput = `${encodedHeader}.${encodedPayload}`;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(tokenInput)
	);

	const encodedSignature = await base64urlEncode(signature);
	return `${tokenInput}.${encodedSignature}`;
}

async function verifyJwt(token: string, secret: string): Promise<any | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;

		const [encodedHeader, encodedPayload, encodedSignature] = parts;
		const tokenInput = `${encodedHeader}.${encodedPayload}`;

		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const signatureBytes = base64urlDecode(encodedSignature);
		const isValid = await crypto.subtle.verify(
			'HMAC',
			key,
			signatureBytes,
			encoder.encode(tokenInput)
		);

		if (!isValid) return null;

		const payloadJson = new TextDecoder().decode(base64urlDecode(encodedPayload));
		const payload = JSON.parse(payloadJson);

		if (payload.exp && Date.now() / 1000 > payload.exp) {
			return null;
		}

		return payload;
	} catch (e) {
		return null;
	}
}


// Helper to return a JSON response with CORS headers
function jsonResponse(data: any, status: number = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		},
	});
}

// Helper to get today's date in GMT+7 (ICT) time zone
function getVNDateString() {
	const offset = 7 * 60; // ICT is UTC + 7
	const date = new Date(Date.now() + offset * 60 * 1000);
	return date.toISOString().split('T')[0];
}

// Helper to check if past order deadline (returns true if past deadline or past date)
async function isPastDeadline(db: D1Database, orderDate: string): Promise<{ blocked: boolean; deadline?: string }> {
	// Dynamically ensure settings table exists
	await db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();

	// Fetch deadline setting
	const result = await db.prepare('SELECT value FROM settings WHERE key = ?')
		.bind('order_deadline')
		.first<{ value: string }>();
	const deadline = result?.value || '11:00'; // Default is 11:00

	const [deadlineHour, deadlineMin] = deadline.split(':').map(Number);

	// Get local Vietnam time (ICT, GMT+7)
	const offset = 7 * 60;
	const now = new Date(Date.now() + offset * 60 * 1000);
	const todayStr = now.toISOString().split('T')[0];

	// Past dates are always blocked
	if (orderDate < todayStr) {
		return { blocked: true, deadline: 'Đã qua ngày đặt' };
	}

	if (orderDate === todayStr) {
		const currentHour = now.getUTCHours();
		const currentMin = now.getUTCMinutes();

		if (currentHour > deadlineHour || (currentHour === deadlineHour && currentMin >= deadlineMin)) {
			return { blocked: true, deadline };
		}
	}

	return { blocked: false, deadline };
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const method = request.method;

		// Handle CORS Preflight requests
		if (method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
				},
			});
		}

		try {
			// ==========================================
			// 0. AVATARS SERVING FROM R2
			// ==========================================
			if (pathname.startsWith('/avatars/') && method === 'GET') {
				const key = decodeURIComponent(pathname.slice(1));
				const object = await env.STORAGE.get(key);
				if (!object) {
					return new Response('Ảnh đại diện không tồn tại', { status: 404 });
				}

				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);
				headers.set('Cache-Control', 'public, max-age=31536000');

				const contentType = object.httpMetadata?.contentType || 'image/jpeg';
				headers.set('Content-Type', contentType);

				return new Response(object.body, { headers });
			}

			// ==========================================
			// 1. API NGƯỜI DÙNG (USERS)
			// ==========================================

			// POST /api/users/upload-avatar
			if (pathname === '/api/users/upload-avatar' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				try {
					const formData = await request.formData();
					const file = formData.get('avatar');
					if (!file || !(file instanceof File)) {
						return jsonResponse({ error: 'Không tìm thấy file ảnh tải lên.' }, 400);
					}

					// Validate file type
					if (!file.type.startsWith('image/')) {
						return jsonResponse({ error: 'Định dạng file không hợp lệ. Chỉ chấp nhận ảnh.' }, 400);
					}
					// Validate file size (2MB max)
					if (file.size > 2 * 1024 * 1024) {
						return jsonResponse({ error: 'Dung lượng ảnh tối đa là 2MB.' }, 400);
					}

					// Delete old avatar if it exists in R2
					const oldUser = await env.DB.prepare('SELECT avatar FROM users WHERE id = ?')
						.bind(payload.id)
						.first<{ avatar: string }>();
					if (oldUser && oldUser.avatar && oldUser.avatar.startsWith('/avatars/')) {
						const oldKey = decodeURIComponent(oldUser.avatar.slice(1));
						try {
							await env.STORAGE.delete(oldKey);
						} catch (err) {
							console.error('Error deleting old avatar:', err);
						}
					}

					const extension = file.name.split('.').pop() || 'jpg';
					const key = `avatars/user-${payload.id}-${Date.now()}.${extension}`;

					await env.STORAGE.put(key, await file.arrayBuffer(), {
						httpMetadata: {
							contentType: file.type
						}
					});

					const avatarUrl = `/${key}`;
					return jsonResponse({ message: 'Tải ảnh đại diện thành công', avatarUrl });
				} catch (e: any) {
					return jsonResponse({ error: e.message || 'Lỗi khi tải ảnh lên.' }, 500);
				}
			}

			// Đăng nhập / Đăng ký
			// POST /api/users/login
			if (pathname === '/api/users/login' && method === 'POST') {
				const body = await request.json() as { name?: string; password?: string; register?: boolean };
				const name = body.name?.trim();
				const password = body.password || '';

				if (!name) {
					return jsonResponse({ error: 'Tên người dùng không được bỏ trống.' }, 400);
				}

				interface UserRow {
					id: number;
					name: string;
					phone: string | null;
					avatar: string;
					default_note: string | null;
					active: number;
					password_hash: string | null;
				}

				// Kiểm tra người dùng đã tồn tại chưa
				let user = await env.DB.prepare('SELECT * FROM users WHERE name = ?')
					.bind(name)
					.first<UserRow>();

				if (!user) {
					// Nếu chưa tồn tại, chỉ tự động tạo nếu có cờ register=true
					if (body.register) {
						const pwdToHash = password || '123456';
						const salt = generateSalt();
						const hash = await hashPassword(pwdToHash, salt);
						const passwordHashValue = `${salt}:${hash}`;

						const result = await env.DB.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)')
							.bind(name, passwordHashValue)
							.run();

						if (!result.success) {
							return jsonResponse({ error: 'Không thể tạo tài khoản người dùng.' }, 500);
						}

						user = await env.DB.prepare('SELECT * FROM users WHERE name = ?')
							.bind(name)
							.first<UserRow>();
					} else {
						// Trả về 404 để thông báo cho Frontend hỏi ý kiến đăng ký tài khoản mới
						return jsonResponse({ error: 'Tài khoản chưa tồn tại.' }, 404);
					}
				}

				if (!user) {
					return jsonResponse({ error: 'Không thể tạo hoặc tìm thấy tài khoản người dùng.' }, 500);
				}

				if (user.active === 0) {
					return jsonResponse({ error: 'Tài khoản này đã bị khóa hoặc tạm ngưng hoạt động.' }, 403);
				}

				// Xác thực mật khẩu
				let isPasswordCorrect = false;
				if (user.password_hash === null) {
					// Chưa đổi mật khẩu lần nào -> Mặc định là '123456'
					if (password === '123456') {
						isPasswordCorrect = true;
					}
				} else {
					const [salt, storedHash] = user.password_hash.split(':');
					if (salt && storedHash) {
						const enteredHash = await hashPassword(password, salt);
						if (enteredHash === storedHash) {
							isPasswordCorrect = true;
						}
					}
				}

				if (!isPasswordCorrect) {
					return jsonResponse({ error: 'Mật khẩu không chính xác.' }, 401);
				}

				// Đăng nhập thành công -> Tạo JWT token
				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const token = await signJwt({ id: user.id, name: user.name }, secret);

				// Loại bỏ password_hash khỏi dữ liệu trả về trước khi gửi cho client
				const safeUser = {
					id: user.id,
					name: user.name,
					phone: user.phone,
					avatar: user.avatar || '👤',
					default_note: user.default_note,
					active: user.active
				};

				const response = jsonResponse({ message: 'Đăng nhập thành công', user: safeUser });
				// Set cookie có hiệu lực trong 1 năm (chỉ đặt Secure khi dùng HTTPS)
				const isSecure = url.protocol === 'https:';
				response.headers.append('Set-Cookie', `session=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=31536000`);
				return response;
			}

			// Lấy thông tin tài khoản hiện tại từ cookie
			// GET /api/users/me
			if (pathname === '/api/users/me' && method === 'GET') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ user: null });
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ user: null });
				}

				const user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, active FROM users WHERE id = ?')
					.bind(payload.id)
					.first<{ id: number; name: string; phone: string | null; avatar: string; default_note: string | null; active: number }>();

				if (!user || user.active === 0) {
					return jsonResponse({ user: null });
				}

				return jsonResponse({ user });
			}

			// Đăng xuất và xóa session cookie
			// POST /api/users/logout
			if (pathname === '/api/users/logout' && method === 'POST') {
				const response = jsonResponse({ message: 'Đăng xuất thành công' });
				const isSecure = url.protocol === 'https:';
				response.headers.append('Set-Cookie', `session=; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`);
				return response;
			}

			// Lấy danh sách thành viên đang hoạt động
			// GET /api/users
			if (pathname === '/api/users' && method === 'GET') {
				const { results } = await env.DB.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name ASC').all();
				return jsonResponse(results);
			}


			// Cập nhật thông tin người dùng (Hồ sơ)
			// PATCH /api/users/:id
			const userUpdateMatch = pathname.match(/^\/api\/users\/(\d+)$/);
			if (userUpdateMatch && method === 'PATCH') {
				const userId = parseInt(userUpdateMatch[1]);
				const body = await request.json() as { name?: string; phone?: string; avatar?: string; default_note?: string; password?: string };
				const newName = body.name?.trim();
				const phone = body.phone?.trim() || null;
				const avatar = body.avatar?.trim() || '👤';
				const defaultNote = body.default_note?.trim() || null;

				if (!newName) {
					return jsonResponse({ error: 'Tên người dùng không được bỏ trống.' }, 400);
				}

				// Kiểm tra tên đã tồn tại chưa (trừ chính người dùng này)
				const existing = await env.DB.prepare('SELECT id FROM users WHERE name = ? AND id != ?')
					.bind(newName, userId)
					.first<{ id: number }>();

				if (existing) {
					return jsonResponse({ error: `Tên "${newName}" đã được sử dụng bởi tài khoản khác.` }, 409);
				}

				let result;
				if (body.password) {
					const salt = generateSalt();
					const hash = await hashPassword(body.password, salt);
					const passwordHashValue = `${salt}:${hash}`;

					result = await env.DB.prepare('UPDATE users SET name = ?, phone = ?, avatar = ?, default_note = ?, password_hash = ? WHERE id = ?')
						.bind(newName, phone, avatar, defaultNote, passwordHashValue, userId)
						.run();
				} else {
					result = await env.DB.prepare('UPDATE users SET name = ?, phone = ?, avatar = ?, default_note = ? WHERE id = ?')
						.bind(newName, phone, avatar, defaultNote, userId)
						.run();
				}

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật thông tin người dùng.' }, 500);
				}

				return jsonResponse({
					message: 'Cập nhật thông tin thành công',
					user: {
						id: userId,
						name: newName,
						phone,
						avatar,
						default_note: defaultNote
					}
				});
			}

			// Lấy tổng nợ chưa thanh toán và chi tiết hóa đơn nợ của một người dùng
			// GET /api/users/:id/unpaid
			const userUnpaidMatch = pathname.match(/^\/api\/users\/(\d+)\/unpaid$/);
			if (userUnpaidMatch && method === 'GET') {
				const userId = parseInt(userUnpaidMatch[1]);

				// Tính tổng số tiền chưa thanh toán
				const totalResult = await env.DB.prepare(
					'SELECT SUM(dish_price) as total_unpaid FROM orders WHERE user_id = ? AND paid = 0'
				)
					.bind(userId)
					.first<{ total_unpaid: number | null }>();

				// Lấy danh sách các đơn hàng chưa thanh toán
				const { results: unpaidOrders } = await env.DB.prepare(
					'SELECT id, date, dish_name, dish_price, created_at FROM orders WHERE user_id = ? AND paid = 0 ORDER BY date DESC'
				)
					.bind(userId)
					.all();

				return jsonResponse({
					userId,
					totalUnpaid: totalResult?.total_unpaid || 0,
					unpaidOrders
				});
			}

			// ==========================================
			// 1.8 API CỬA HÀNG (SHOPS)
			// ==========================================

			// Lấy danh sách cửa hàng đang hoạt động
			// GET /api/shops
			if (pathname === '/api/shops' && method === 'GET') {
				const { results } = await env.DB.prepare('SELECT * FROM shops WHERE active = 1 ORDER BY name ASC').all();
				return jsonResponse(results);
			}

			// Thêm cửa hàng mới (hoặc cập nhật nếu trùng tên)
			// POST /api/shops
			if (pathname === '/api/shops' && method === 'POST') {
				const body = await request.json() as { name?: string; caller_id?: number };
				const name = body.name?.trim();
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				if (!name) {
					return jsonResponse({ error: 'Tên cửa hàng không được bỏ trống.' }, 400);
				}

				const result = await env.DB.prepare(
					'INSERT INTO shops (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1'
				)
					.bind(name)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật danh sách cửa hàng.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật danh sách cửa hàng thành công' });
			}

			// Ẩn cửa hàng (soft delete)
			// DELETE /api/shops/:id
			const shopDeleteMatch = pathname.match(/^\/api\/shops\/(\d+)$/);
			if (shopDeleteMatch && method === 'DELETE') {
				const shopId = parseInt(shopDeleteMatch[1]);
				const callerId = Number(url.searchParams.get('caller_id'));

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				const result = await env.DB.prepare('UPDATE shops SET active = 0 WHERE id = ?')
					.bind(shopId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể ẩn cửa hàng.' }, 500);
				}

				return jsonResponse({ message: 'Đã ẩn cửa hàng thành công.' });
			}

			// Cập nhật cửa hàng (chỉ admin ID 1)
			// PATCH /api/shops/:id
			const shopUpdateMatch = pathname.match(/^\/api\/shops\/(\d+)$/);
			if (shopUpdateMatch && method === 'PATCH') {
				const shopId = parseInt(shopUpdateMatch[1]);
				const body = await request.json() as { name?: string; caller_id?: number };
				const name = body.name?.trim();
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}
				if (!name) {
					return jsonResponse({ error: 'Tên cửa hàng không được bỏ trống.' }, 400);
				}

				const result = await env.DB.prepare('UPDATE shops SET name = ? WHERE id = ?')
					.bind(name, shopId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật cửa hàng.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật cửa hàng thành công.' });
			}

			// ==========================================
			// 1.85 API THỐNG KÊ (STATS)
			// ==========================================

			// Lấy thống kê chi tiêu tích lũy của toàn bộ mọi người
			// GET /api/stats/spending
			if (pathname === '/api/stats/spending' && method === 'GET') {
				// Tính tổng cộng của hệ thống
				const summary = await env.DB.prepare(`
					SELECT 
						COALESCE(SUM(dish_price), 0) as grand_total,
						COALESCE(SUM(CASE WHEN paid = 1 THEN dish_price ELSE 0 END), 0) as grand_paid,
						COALESCE(SUM(CASE WHEN paid = 0 THEN dish_price ELSE 0 END), 0) as grand_unpaid
					FROM orders
				`).first<{ grand_total: number; grand_paid: number; grand_unpaid: number }>();

				// Chi tiết từng người dùng
				const { results: usersBreakdown } = await env.DB.prepare(`
					SELECT 
						u.id as user_id,
						u.name as user_name,
						u.avatar as user_avatar,
						COUNT(o.id) as total_orders,
						COALESCE(SUM(o.dish_price), 0) as total_spent,
						COALESCE(SUM(CASE WHEN o.paid = 1 THEN o.dish_price ELSE 0 END), 0) as total_paid,
						COALESCE(SUM(CASE WHEN o.paid = 0 THEN o.dish_price ELSE 0 END), 0) as total_unpaid
					FROM users u
					LEFT JOIN orders o ON u.id = o.user_id
					WHERE u.active = 1
					GROUP BY u.id, u.name, u.avatar
					HAVING total_spent > 0
					ORDER BY total_spent DESC
				`).all();

				return jsonResponse({
					grand_total: summary?.grand_total || 0,
					grand_paid: summary?.grand_paid || 0,
					grand_unpaid: summary?.grand_unpaid || 0,
					users_breakdown: usersBreakdown
				});
			}

			// ==========================================
			// 1.9 API CÀI ĐẶT (SETTINGS)
			// ==========================================


			// Lấy các cài đặt hệ thống
			// GET /api/settings
			if (pathname === '/api/settings' && method === 'GET') {
				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const { results } = await env.DB.prepare('SELECT * FROM settings').all<{ key: string; value: string }>();

				const settingsObj: Record<string, string> = {
					order_deadline: '11:00',
					announcement: ''
				};
				for (const row of results) {
					settingsObj[row.key] = row.value;
				}
				return jsonResponse(settingsObj);
			}

			// Cập nhật cài đặt hệ thống (chỉ admin ID 1)
			// POST /api/settings
			if (pathname === '/api/settings' && method === 'POST') {
				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const body = await request.json() as { key?: string; value?: string; caller_id?: number };
				const key = body.key?.trim();
				const value = body.value !== undefined ? body.value.trim() : undefined;
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thay đổi cài đặt hệ thống.' }, 403);
				}
				if (!key || value === undefined) {
					return jsonResponse({ error: 'Thiếu thông tin cài đặt.' }, 400);
				}

				const result = await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(key, value)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật cài đặt.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật cài đặt thành công', key, value });
			}

			// ==========================================
			// 2. API MÓN ĂN (DISHES)
			// ==========================================

			// Lấy thực đơn (danh sách món ăn đang bán, hoặc tất cả đối với admin)
			// GET /api/dishes (hỗ trợ lọc theo ?shop_id=N)
			if (pathname === '/api/dishes' && method === 'GET') {
				let isAdmin = false;
				const cookieVal = getCookie(request, 'session');
				if (cookieVal) {
					const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
					const payload = await verifyJwt(cookieVal, secret);
					if (payload && payload.id === 1) {
						isAdmin = true;
					}
				}
				const callerIdParam = url.searchParams.get('caller_id');
				if (callerIdParam === '1') {
					isAdmin = true;
				}

				const shopIdParam = url.searchParams.get('shop_id');
				if (shopIdParam) {
					const shopId = parseInt(shopIdParam);
					const query = isAdmin
						? 'SELECT * FROM dishes WHERE shop_id = ? ORDER BY price ASC'
						: 'SELECT * FROM dishes WHERE active = 1 AND shop_id = ? ORDER BY price ASC';
					const { results } = await env.DB.prepare(query)
						.bind(shopId)
						.all();
					return jsonResponse(results);
				} else {
					const query = isAdmin
						? 'SELECT * FROM dishes ORDER BY price ASC'
						: 'SELECT * FROM dishes WHERE active = 1 ORDER BY price ASC';
					const { results } = await env.DB.prepare(query).all();
					return jsonResponse(results);
				}
			}

			// Thêm món ăn mới (hoặc cập nhật nếu trùng tên)
			// POST /api/dishes
			if (pathname === '/api/dishes' && method === 'POST') {
				const body = await request.json() as { name?: string; price?: number; shop_id?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const shopId = Number(body.shop_id || 1);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				if (!name || isNaN(price) || price <= 0) {
					return jsonResponse({ error: 'Tên món ăn và giá (lớn hơn 0) không hợp lệ.' }, 400);
				}

				// Thêm mới hoặc cập nhật nếu trùng tên (đưa active về 1 và gán shop_id)
				const result = await env.DB.prepare(
					'INSERT INTO dishes (shop_id, name, price) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET shop_id = EXCLUDED.shop_id, price = EXCLUDED.price, active = 1'
				)
					.bind(shopId, name, price)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật thực đơn.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật thực đơn thành công' });
			}

			// Ẩn món ăn (soft delete)
			// DELETE /api/dishes/:id
			const dishDeleteMatch = pathname.match(/^\/api\/dishes\/(\d+)$/);
			if (dishDeleteMatch && method === 'DELETE') {
				const dishId = parseInt(dishDeleteMatch[1]);
				const callerId = Number(url.searchParams.get('caller_id'));

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				const result = await env.DB.prepare('UPDATE dishes SET active = 0 WHERE id = ?')
					.bind(dishId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể ẩn món ăn.' }, 500);
				}

				return jsonResponse({ message: 'Đã ẩn món ăn thành công.' });
			}

			// Cập nhật món ăn (chỉ admin ID 1)
			// PATCH /api/dishes/:id
			const dishUpdateMatch = pathname.match(/^\/api\/dishes\/(\d+)$/);
			if (dishUpdateMatch && method === 'PATCH') {
				const dishId = parseInt(dishUpdateMatch[1]);
				const body = await request.json() as { name?: string; price?: number; shop_id?: number; active?: number; caller_id?: number };
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				// Nếu chỉ cập nhật trạng thái active (bật/tắt)
				if (body.active !== undefined) {
					const activeVal = body.active ? 1 : 0;
					const result = await env.DB.prepare('UPDATE dishes SET active = ? WHERE id = ?')
						.bind(activeVal, dishId)
						.run();

					if (!result.success) {
						return jsonResponse({ error: 'Không thể cập nhật trạng thái món ăn.' }, 500);
					}

					return jsonResponse({ message: 'Cập nhật trạng thái món ăn thành công.' });
				}

				const name = body.name?.trim();
				const price = Number(body.price);
				const shopId = Number(body.shop_id);

				if (!name || isNaN(price) || price <= 0 || isNaN(shopId)) {
					return jsonResponse({ error: 'Thông tin món ăn không hợp lệ.' }, 400);
				}

				const result = await env.DB.prepare('UPDATE dishes SET name = ?, price = ?, shop_id = ? WHERE id = ?')
					.bind(name, price, shopId, dishId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật món ăn.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật món ăn thành công.' });
			}

			// ==========================================
			// 2.5 API MÓN THÊM (TOPPINGS)
			// ==========================================

			// Lấy thực đơn món thêm đang bán
			// GET /api/toppings (hỗ trợ lọc theo ?shop_id=N)
			if (pathname === '/api/toppings' && method === 'GET') {
				const shopIdParam = url.searchParams.get('shop_id');
				if (shopIdParam) {
					const shopId = parseInt(shopIdParam);
					const { results } = await env.DB.prepare(
						'SELECT t.*, s.name as shop_name FROM toppings t LEFT JOIN shops s ON t.shop_id = s.id WHERE t.active = 1 AND t.shop_id = ? ORDER BY t.price ASC'
					)
						.bind(shopId)
						.all();
					return jsonResponse(results);
				} else {
					const { results } = await env.DB.prepare(
						'SELECT t.*, s.name as shop_name FROM toppings t LEFT JOIN shops s ON t.shop_id = s.id WHERE t.active = 1 ORDER BY t.price ASC'
					).all();
					return jsonResponse(results);
				}
			}

			// Thêm món thêm mới (hoặc cập nhật nếu trùng tên cho cùng một quán)
			// POST /api/toppings
			if (pathname === '/api/toppings' && method === 'POST') {
				const body = await request.json() as { name?: string; price?: number; shop_id?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const shopId = Number(body.shop_id);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				if (!name || isNaN(price) || price < 0 || isNaN(shopId)) {
					return jsonResponse({ error: 'Tên món thêm, giá và cửa hàng không hợp lệ.' }, 400);
				}

				const result = await env.DB.prepare(
					'INSERT INTO toppings (shop_id, name, price) VALUES (?, ?, ?) ON CONFLICT(shop_id, name) DO UPDATE SET price = EXCLUDED.price, active = 1'
				)
					.bind(shopId, name, price)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật danh sách món thêm.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật món thêm thành công' });
			}

			// Ẩn món thêm (soft delete)
			// DELETE /api/toppings/:id
			const toppingDeleteMatch = pathname.match(/^\/api\/toppings\/(\d+)$/);
			if (toppingDeleteMatch && method === 'DELETE') {
				const toppingId = parseInt(toppingDeleteMatch[1]);
				const callerId = Number(url.searchParams.get('caller_id'));

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				const result = await env.DB.prepare('UPDATE toppings SET active = 0 WHERE id = ?')
					.bind(toppingId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể ẩn món thêm.' }, 500);
				}

				return jsonResponse({ message: 'Đã ẩn món thêm thành công.' });
			}

			// Cập nhật món thêm (chỉ admin ID 1)
			// PATCH /api/toppings/:id
			const toppingUpdateMatch = pathname.match(/^\/api\/toppings\/(\d+)$/);
			if (toppingUpdateMatch && method === 'PATCH') {
				const toppingId = parseInt(toppingUpdateMatch[1]);
				const body = await request.json() as { name?: string; price?: number; shop_id?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const shopId = Number(body.shop_id);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}
				if (!name || isNaN(price) || price < 0 || isNaN(shopId)) {
					return jsonResponse({ error: 'Thông tin món thêm không hợp lệ.' }, 400);
				}

				const result = await env.DB.prepare('UPDATE toppings SET name = ?, price = ?, shop_id = ? WHERE id = ?')
					.bind(name, price, shopId, toppingId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật món thêm.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật món thêm thành công.' });
			}

			// ==========================================
			// 3. API ĐẶT CƠM (ORDERS)
			// ==========================================

			// Lấy danh sách đặt cơm cho một ngày cụ thể (mặc định hôm nay)
			// GET /api/orders?date=YYYY-MM-DD
			if (pathname === '/api/orders' && method === 'GET') {
				const dateParam = url.searchParams.get('date') || getVNDateString();

				const { results } = await env.DB.prepare(
					`SELECT 
						o.id, 
						o.date, 
						o.user_id, 
						u.name as user_name, 
						u.phone as user_phone,
						u.avatar as user_avatar,
						o.dish_id, 
						o.dish_name, 
						o.dish_price, 
						o.paid, 
						o.note,
						o.created_at,
						d.shop_id,
						s.name as shop_name
					FROM orders o
					JOIN users u ON o.user_id = u.id
					LEFT JOIN dishes d ON o.dish_id = d.id
					LEFT JOIN shops s ON d.shop_id = s.id
					WHERE o.date = ?
					ORDER BY o.dish_name ASC, u.name ASC`
				)
					.bind(dateParam)
					.all();

				return jsonResponse(results);
			}

			// Đặt cơm / Đổi món
			// POST /api/orders
			if (pathname === '/api/orders' && method === 'POST') {
				const body = await request.json() as { user_id?: number; dish_id?: number; date?: string; topping_ids?: number[]; note?: string };
				const userId = Number(body.user_id);
				const dishId = Number(body.dish_id);
				const dateParam = body.date?.trim() || getVNDateString();
				const toppingIds = (body.topping_ids || []).map(Number);
				const note = body.note?.trim() || null;

				if (!userId || !dishId) {
					return jsonResponse({ error: 'Thiếu thông tin người dùng hoặc món ăn.' }, 400);
				}

				// Kiểm tra giờ chốt đặt cơm (bỏ qua đối với tài khoản admin ID 1)
				const deadlineCheck = await isPastDeadline(env.DB, dateParam);
				if (deadlineCheck.blocked && userId !== 1) {
					return jsonResponse({ error: `Đã quá thời gian chốt đặt món ngày hôm nay (${deadlineCheck.deadline}).` }, 403);
				}

				// Lấy thông tin món ăn
				const dish = await env.DB.prepare('SELECT name, price, shop_id FROM dishes WHERE id = ? AND active = 1')
					.bind(dishId)
					.first<{ name: string; price: number; shop_id: number }>();

				if (!dish) {
					return jsonResponse({ error: 'Món ăn không tồn tại hoặc đã ngừng bán.' }, 404);
				}

				let finalName = dish.name;
				let finalPrice = dish.price;

				if (toppingIds.length > 0) {
					const placeholders = toppingIds.map(() => '?').join(',');
					const { results: toppings } = await env.DB.prepare(
						`SELECT name, price FROM toppings WHERE id IN (${placeholders}) AND active = 1 AND shop_id = ?`
					)
						.bind(...toppingIds, dish.shop_id)
						.all<{ name: string; price: number }>();

					if (toppings.length > 0) {
						const toppingsName = toppings.map(t => t.name).join(', ');
						finalName = `${dish.name} (+ ${toppingsName})`;
						const toppingsPrice = toppings.reduce((sum, t) => sum + t.price, 0);
						finalPrice = dish.price + toppingsPrice;
					}
				}

				// Thêm mới hoặc cập nhật đơn cơm cho ngày này (Unique: date, user_id)
				// Trạng thái paid sẽ tự reset về 0 (chưa trả) nếu thay đổi sang món khác
				const result = await env.DB.prepare(
					`INSERT INTO orders (date, user_id, dish_id, dish_name, dish_price, paid, note)
					VALUES (?, ?, ?, ?, ?, 0, ?)
					ON CONFLICT(date, user_id) DO UPDATE SET
						dish_id = EXCLUDED.dish_id,
						dish_name = EXCLUDED.dish_name,
						dish_price = EXCLUDED.dish_price,
						paid = 0,
						note = EXCLUDED.note,
						created_at = CURRENT_TIMESTAMP`
				)
					.bind(dateParam, userId, dishId, finalName, finalPrice, note)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Đặt món thất bại.' }, 500);
				}

				return jsonResponse({ message: 'Đặt cơm thành công' });
			}

			// Cập nhật trạng thái thanh toán (đánh true/false cho paid)
			// PATCH /api/orders/:id/paid
			const orderPaidMatch = pathname.match(/^\/api\/orders\/(\d+)\/paid$/);
			if (orderPaidMatch && method === 'PATCH') {
				const orderId = parseInt(orderPaidMatch[1]);
				const body = await request.json() as { paid?: boolean | number; caller_id?: number };
				const paidValue = body.paid ? 1 : 0;
				const callerId = Number(body.caller_id);

				if (!callerId) {
					return jsonResponse({ error: 'Thiếu thông tin người thực hiện thao tác.' }, 400);
				}

				// Lấy đơn hàng hiện tại để kiểm tra chủ sở hữu
				const order = await env.DB.prepare('SELECT user_id FROM orders WHERE id = ?')
					.bind(orderId)
					.first<{ user_id: number }>();

				if (!order) {
					return jsonResponse({ error: 'Không tìm thấy đơn hàng tương ứng.' }, 404);
				}

				// Kiểm tra phân quyền: Chỉ ID 1 (P.Dương) được sửa cho người khác. Người khác chỉ được tự sửa cho chính mình.
				if (callerId !== 1 && callerId !== order.user_id) {
					return jsonResponse({ error: 'Bạn không có quyền cập nhật trạng thái thanh toán cho đơn hàng này.' }, 403);
				}

				const result = await env.DB.prepare('UPDATE orders SET paid = ? WHERE id = ?')
					.bind(paidValue, orderId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật trạng thái thanh toán.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật trạng thái thanh toán thành công' });
			}

			// Hủy đặt cơm
			// DELETE /api/orders/:id?caller_id=N
			const orderDeleteMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
			if (orderDeleteMatch && method === 'DELETE') {
				const orderId = parseInt(orderDeleteMatch[1]);
				const callerId = Number(url.searchParams.get('caller_id'));

				// Lấy thông tin đơn để kiểm tra ngày
				const order = await env.DB.prepare('SELECT date, user_id FROM orders WHERE id = ?')
					.bind(orderId)
					.first<{ date: string; user_id: number }>();

				if (!order) {
					return jsonResponse({ error: 'Không tìm thấy đơn hàng tương ứng.' }, 404);
				}

				// Kiểm tra giờ chốt đặt cơm (bỏ qua đối với admin ID 1)
				const deadlineCheck = await isPastDeadline(env.DB, order.date);
				if (deadlineCheck.blocked && callerId !== 1) {
					return jsonResponse({ error: `Đã quá thời gian chốt đặt món, không thể hủy đơn (${deadlineCheck.deadline}).` }, 403);
				}

				const result = await env.DB.prepare('DELETE FROM orders WHERE id = ?')
					.bind(orderId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể hủy đơn hàng.' }, 500);
				}

				return jsonResponse({ message: 'Hủy đặt món thành công' });
			}

			// ==========================================
			// 4. API AI TƯ VẤN (AI RECOMMENDATION)
			// ==========================================
			if (pathname === '/api/ai/recommend' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				const userId = payload.id;
				const body = await request.json() as { messages?: { role: string; content: string }[], exclude_dish_ids?: number[] };
				const clientMessages = body.messages || [];
				const excludeDishIds = body.exclude_dish_ids || [];

				// 1. Fetch user's default note and name
				const user = await env.DB.prepare('SELECT name, default_note FROM users WHERE id = ?')
					.bind(userId)
					.first<{ name: string; default_note: string | null }>();

				const userName = user?.name || 'Thành viên';
				const defaultNote = user?.default_note || 'Không có';

				// 2. Fetch user's order history
				const history = await env.DB.prepare(
					'SELECT dish_name, COUNT(*) as count FROM orders WHERE user_id = ? GROUP BY dish_name ORDER BY count DESC LIMIT 5'
				)
					.bind(userId)
					.all<{ dish_name: string; count: number }>();

				const historyStr = history.results.length > 0
					? history.results.map(h => `${h.dish_name} (${h.count} lần)`).join(', ')
					: 'Chưa có lịch sử đặt cơm';

				// 3. Fetch active dishes
				const dishes = await env.DB.prepare(
					'SELECT d.id, d.name, d.price, d.shop_id, s.name as shop_name FROM dishes d JOIN shops s ON d.shop_id = s.id WHERE d.active = 1'
				).all<{ id: number; name: string; price: number; shop_id: number; shop_name: string }>();

				// Filter out excluded dishes if any (e.g. when user clicks "Suggest another dish")
				const availableDishes = dishes.results.filter(d => !excludeDishIds.includes(d.id));

				const dishesStr = availableDishes.length > 0
					? availableDishes.map(d => `ID: ${d.id} - ${d.name} (${d.price} đ) thuộc quán [${d.shop_name}] (shop_id: ${d.shop_id})`).join('\n')
					: 'Không có món ăn nào khả dụng hôm nay!';

				// 4. Fetch active toppings
				const toppings = await env.DB.prepare(
					'SELECT id, name, price, shop_id FROM toppings WHERE active = 1'
				).all<{ id: number; name: string; price: number; shop_id: number }>();

				const toppingsStr = toppings.results.length > 0
					? toppings.results.map(t => `Topping ID: ${t.id} - ${t.name} (+${t.price} đ) thuộc shop_id: ${t.shop_id}`).join('\n')
					: 'Không có topping';

				// 5. Construct system prompt for Gemma 4
				const systemPrompt = `Bạn là Trợ lý AI tư vấn món ăn của ComTrua (một ứng dụng đặt cơm văn phòng nội bộ).
Bạn đang trò chuyện với người dùng tên là: ${userName}.
Ghi chú ăn uống mặc định của người dùng: ${defaultNote} (nếu có dị ứng hoặc không ăn hành, hãy chú ý tránh gợi ý món có thành phần đó).
Lịch sử các món người dùng hay ăn gần đây: ${historyStr}.

Thực đơn hôm nay gồm có các món ăn sau đây (chỉ được phép gợi ý các món trong danh sách này):
${dishesStr}

Danh sách topping đi kèm nếu người dùng muốn chọn thêm:
${toppingsStr}

Nhiệm vụ của bạn:
1. Đọc tin nhắn hội thoại từ người dùng để hiểu yêu cầu của họ (họ thèm thịt, muốn ăn mì hay cơm, dị ứng gì, hoặc chỉ muốn bạn gợi ý ngẫu nhiên).
2. Trả lời người dùng bằng giọng văn tiếng Việt thân thiện, tự nhiên, vui tươi, có chút dí dỏm.
3. Nếu người dùng hỏi chuyện phiếm hoặc hỏi các câu hỏi không liên quan đến việc đặt món ăn, hãy trả lời bình thường và thiết lập trường "recommended_dish" là null.
4. Nếu người dùng muốn gợi ý món hoặc đồng ý chọn món, hãy chọn RA DUY NHẤT 1 món phù hợp trong danh sách thực đơn hôm nay.
   - NGUYÊN TẮC KHỚP TỪ KHÓA: Nếu người dùng hỏi món cụ thể (ví dụ: "mì", "nuôi", "cơm", "bò", "gà"), bạn BẮT BUỘC phải đối chiếu với thực đơn hôm nay:
     + Nếu thực đơn hôm nay CÓ món chứa từ khóa đó: Gợi ý đúng món đó.
     + Nếu thực đơn hôm nay KHÔNG CÓ món chứa từ khóa đó: Bạn phải thông báo lịch sự là hôm nay không có món này (ví dụ: "Hôm nay rất tiếc là quán không có món mì nào rồi bạn ơi..."), sau đó đề xuất một món khác đang thực sự CÓ SẴN trong thực đơn hôm nay. Khi đó, thông tin trong "recommended_dish" phải là món có sẵn được đề xuất thay thế đó, tuyệt đối không được điền món không tồn tại trong thực đơn hôm nay.
   - NGUYÊN TẮC CHỌN TOPPING LOGIC: Gợi ý topping đi kèm phải hợp lý 100% với món ăn chính:
     + Món ăn chính là MÌ (ví dụ: Mì Xào Bò) -> Chỉ được gợi ý topping có chữ "Mì" (ví dụ: Nhiều Mì) hoặc "Trứng ốp la". Tuyệt đối không chọn topping "Nhiều Nuôi" hay "Nhiều Cơm".
     + Món ăn chính là NUÔI (ví dụ: Nuôi Xào Bò) -> Chỉ được gợi ý topping có chữ "Nuôi" (ví dụ: Nhiều Nuôi) hoặc "Trứng ốp la". Tuyệt đối không chọn topping "Nhiều Mì".
     + Món ăn chính là CƠM -> Chỉ gợi ý topping có chữ "Cơm" (ví dụ: Nhiều Cơm, Cơm thêm) hoặc "Trứng ốp la".
   - Chỉ được gợi ý các topping có cùng shop_id với shop_id của món ăn được chọn.
   - NGUYÊN TẮC ĐỒNG NHẤT TUYỆT ĐỐI: Món ăn được giới thiệu trong nội dung chat (trường "message") và món ăn được điền vào JSON (trường "recommended_dish" bao gồm "dish_id" và "dish_name") BẮT BUỘC phải là CÙNG MỘT MÓN ĂN. Không được giới thiệu món Mì Xào Bò ở phần chat nhưng trong JSON lại trả về món Cơm Xào Bò. Nếu giới thiệu Mì Xào Bò, trường "recommended_dish" phải chứa đúng ID và thông tin của món Mì Xào Bò trong thực đơn.
5. Cung cấp câu trả lời dưới định dạng JSON thuần túy như mô tả dưới đây (không viết bất cứ dòng chữ nào khác ngoài JSON):

{
  "message": "Nội dung câu trả lời thân thiện bằng tiếng Việt của bạn, giải thích lý do gợi ý hoặc đối thoại với người dùng.",
  "recommended_dish": {
    "dish_id": 1, // ID của món ăn được chọn từ thực đơn
    "dish_name": "Tên món ăn",
    "price": 35000, // Giá của món ăn
    "shop_name": "Tên quán",
    "topping_ids": [5] // Mảng ID các topping đi kèm gợi ý (ví dụ: [5] cho Trứng ốp la), để trống [] nếu không gợi ý topping nào.
  },
  "auto_submit": false // Điền true nếu trong tin nhắn mới nhất của người dùng có yêu cầu, mệnh lệnh rõ ràng bảo bạn hãy đặt món hoặc chốt món giùm họ (ví dụ: "đặt giùm tôi...", "chốt luôn món này...", "chốt đơn...", "đặt luôn đi..."). Nếu họ chỉ đang hỏi han, tham khảo ý kiến, hoặc chưa nói gì đến việc đặt, điền false.
}

Lưu ý: Nếu không có món ăn nào khả dụng, đặt "recommended_dish" là null. Trả về JSON hợp lệ, tuyệt đối không được bọc JSON trong markdown tag (ví dụ: không dùng \`\`\`json).`;

				let text = '';
				try {
					if (env.GEMINI_API_KEY) {
						console.log('Using Google AI Studio with Gemini API directly...');
						const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`;
						
						const contents = clientMessages.map(msg => ({
							role: msg.role === 'assistant' ? 'model' : 'user',
							parts: [{ text: msg.content }]
						}));

						const reqBody = {
							contents: contents,
							systemInstruction: {
								parts: [{ text: systemPrompt }]
							},
							generationConfig: {
								responseMimeType: "application/json"
							}
						};

						const response = await fetch(directUrl, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json'
							},
							body: JSON.stringify(reqBody)
						});

						if (!response.ok) {
							const errText = await response.text();
							throw new Error(`Google AI Studio Gemini request failed: ${response.status} ${errText}`);
						}

						const geminiResult = await response.json() as any;
						text = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || '';
					} else {
						console.log('Falling back to local Cloudflare Workers AI gemma-3-12b-it...');
						const messages = [
							{ role: 'system', content: systemPrompt },
							...clientMessages
						];
						const aiResult = await env.AI.run('@cf/google/gemma-3-12b-it', {
							messages: messages
						}) as any;

						console.log('AI raw result:', typeof aiResult, JSON.stringify(aiResult));

						if (typeof aiResult === 'string') {
							text = aiResult;
						} else if (aiResult && typeof aiResult === 'object') {
							if (aiResult.choices && aiResult.choices[0] && aiResult.choices[0].message) {
								text = aiResult.choices[0].message.content || '';
							} else {
								text = aiResult.response || aiResult.text || '';
							}
						}
					}

					// Attempt to extract JSON from the text response
					let parsedResult: any = {
						message: text,
						recommended_dish: null
					};

					try {
						// Clean up markdown block tags if LLM wraps it
						let cleanText = text.trim();
						if (cleanText.startsWith('```json')) {
							cleanText = cleanText.substring(7);
						} else if (cleanText.startsWith('```')) {
							cleanText = cleanText.substring(3);
						}
						if (cleanText.endsWith('```')) {
							cleanText = cleanText.substring(0, cleanText.length - 3);
						}
						cleanText = cleanText.trim();

						parsedResult = JSON.parse(cleanText);
					} catch (e) {
						// If JSON parsing fails, regex extract or fallback
						console.error('Failed to parse AI response as JSON:', text);
						const jsonMatch = text.match(/\{[\s\S]*\}/);
						if (jsonMatch) {
							try {
								parsedResult = JSON.parse(jsonMatch[0]);
							} catch (e2) {
								parsedResult = {
									message: text,
									recommended_dish: null
								};
							}
						}
					}

					return jsonResponse({
						message: parsedResult.message || text,
						recommended_dish: parsedResult.recommended_dish || null
					});
				} catch (aiErr: any) {
					console.error('AI run error:', aiErr);
					return jsonResponse({ error: 'Lỗi khi kết nối đến dịch vụ AI: ' + aiErr.message }, 500);
				}
			}

			// Đường dẫn không hợp lệ
			return jsonResponse({ error: 'Không tìm thấy API tương ứng.' }, 404);

		} catch (error: any) {
			return jsonResponse({ error: error.message || 'Lỗi hệ thống.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
