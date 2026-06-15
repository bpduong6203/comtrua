import nodeCrypto from 'node:crypto';

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
	PAYOS_CLIENT_ID?: string;
	PAYOS_API_KEY?: string;
	PAYOS_CHECKSUM_KEY?: string;
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

// payOS Payment Request signature generator
function generatePaymentRequestSignature(data: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }, checksumKey: string): string {
	const signData = `amount=${data.amount}&cancelUrl=${data.cancelUrl}&description=${data.description}&orderCode=${data.orderCode}&returnUrl=${data.returnUrl}`;
	return nodeCrypto
		.createHmac('sha256', checksumKey)
		.update(signData)
		.digest('hex');
}

// payOS Webhook signature verification helper
function verifyWebhookSignature(body: { data: any; signature: string }, checksumKey: string): boolean {
	const data = body.data;
	const signature = body.signature;
	if (!data || !signature) return false;

	// Sort keys alphabetically
	const sortedKeys = Object.keys(data).sort();
	const signData = sortedKeys
		.map(key => `${key}=${data[key]}`)
		.join('&');

	const expectedSignature = nodeCrypto
		.createHmac('sha256', checksumKey)
		.update(signData)
		.digest('hex');

	try {
		return nodeCrypto.timingSafeEqual(
			Buffer.from(expectedSignature, 'utf8'),
			Buffer.from(signature, 'utf8')
		);
	} catch (err) {
		return false;
	}
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

				// Tự động đối soát và tự sửa (self-heal) các giao dịch PENDING cũ của user này
				const clientId = env.PAYOS_CLIENT_ID;
				const apiKey = env.PAYOS_API_KEY;
				if (clientId && apiKey) {
					try {
						const { results: pendingPayments } = await env.DB.prepare(
							"SELECT order_code, order_ids FROM payments WHERE user_id = ? AND status = 'PENDING'"
						)
							.bind(userId)
							.all<{ order_code: number; order_ids: string }>();

						for (const payment of pendingPayments) {
							const payosResp = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${payment.order_code}`, {
								method: 'GET',
								headers: {
									'x-client-id': clientId,
									'x-api-key': apiKey
								}
							});
							if (payosResp.ok) {
								const payosResult = await payosResp.json() as any;
								if (payosResult.code === '00' && payosResult.data) {
									const payosStatus = payosResult.data.status;
									if (payosStatus === 'PAID') {
										// Cập nhật bảng payments
										await env.DB.prepare('UPDATE payments SET status = ? WHERE order_code = ?')
											.bind('PAID', payment.order_code)
											.run();

										// Cập nhật các đơn hàng liên quan
										if (payment.order_ids) {
											const orderIds = payment.order_ids.split(',').map(Number).filter(id => !isNaN(id) && id > 0);
											if (orderIds.length > 0) {
												const placeholders = orderIds.map(() => '?').join(',');
												await env.DB.prepare(`UPDATE orders SET paid = 1 WHERE id IN (${placeholders})`)
													.bind(...orderIds)
													.run();
											}
										}
										console.log(`Self-healed PENDING payment ${payment.order_code} to PAID during unpaid check for user ${userId}`);
									} else if (payosStatus === 'CANCELLED') {
										await env.DB.prepare('UPDATE payments SET status = ? WHERE order_code = ?')
											.bind('CANCELLED', payment.order_code)
											.run();
										console.log(`Self-healed PENDING payment ${payment.order_code} to CANCELLED during unpaid check for user ${userId}`);
									}
								}
							}
						}
					} catch (err) {
						console.error('Error during self-healing in user unpaid check:', err);
					}
				}

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

				// Kiểm tra phân quyền: Chỉ ID 1 (P.Dương) được thay đổi thủ công trạng thái thanh toán.
				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền cập nhật thủ công trạng thái thanh toán cho đơn hàng này. Vui lòng thanh toán qua payOS.' }, 403);
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
			// 5. API THANH TOÁN ONLINE (PAYOS)
			// ==========================================

			// POST /api/payment/create
			if (pathname === '/api/payment/create' && method === 'POST') {
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
				const clientId = env.PAYOS_CLIENT_ID;
				const apiKey = env.PAYOS_API_KEY;
				const checksumKey = env.PAYOS_CHECKSUM_KEY;

				if (!clientId || !apiKey || !checksumKey) {
					return jsonResponse({ error: 'Hệ thống chưa cấu hình cổng thanh toán payOS.' }, 500);
				}

				// Lấy danh sách các đơn hàng chưa thanh toán của người dùng này
				const { results: unpaidOrders } = await env.DB.prepare(
					'SELECT id, dish_price FROM orders WHERE user_id = ? AND paid = 0'
				)
					.bind(userId)
					.all<{ id: number; dish_price: number }>();

				if (unpaidOrders.length === 0) {
					return jsonResponse({ error: 'Bạn không có khoản nợ cơm nào chưa thanh toán.' }, 400);
				}

				const totalAmount = unpaidOrders.reduce((sum, order) => sum + order.dish_price, 0);
				const orderIdsStr = unpaidOrders.map(order => order.id).join(',');

				// Tạo một giao dịch thanh toán PENDING trong database
				const insertResult = await env.DB.prepare(
					'INSERT INTO payments (user_id, amount, status, order_ids) VALUES (?, ?, ?, ?)'
				)
					.bind(userId, totalAmount, 'PENDING', orderIdsStr)
					.run();

				if (!insertResult.success) {
					return jsonResponse({ error: 'Không thể khởi tạo giao dịch thanh toán.' }, 500);
				}

				// Lấy order_code tự động sinh ra
				const orderCodeResult = await env.DB.prepare('SELECT last_insert_rowid() as id').first<{ id: number }>();
				const orderCode = orderCodeResult?.id;

				if (!orderCode) {
					return jsonResponse({ error: 'Không thể khởi tạo mã đơn hàng.' }, 500);
				}

				const origin = url.origin;
				const cancelUrl = `${origin}/?status=CANCELLED&orderCode=${orderCode}`;
				const returnUrl = `${origin}/?status=PAID&orderCode=${orderCode}`;
				
				// Rút gọn tên không dấu
				const cleanName = (userName: string) => {
					let str = userName || 'Member';
					str = str.replace(/A|À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, 'A');
					str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, 'a');
					str = str.replace(/E|È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, 'E');
					str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, 'e');
					str = str.replace(/I|Ì|Í|Ị|Ỉ|Ĩ/g, 'I');
					str = str.replace(/ì|í|ị|ỉ|ĩ/g, 'i');
					str = str.replace(/O|Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, 'O');
					str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, 'o');
					str = str.replace(/U|Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, 'U');
					str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, 'u');
					str = str.replace(/Y|Ỳ|Ý|Y|Ỷ|Ỹ/g, 'Y');
					str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, 'y');
					str = str.replace(/D|Đ/g, 'D');
					str = str.replace(/đ/g, 'd');
					str = str.replace(/[^A-Za-z0-9]/g, '');
					return str;
				};

				// Lấy thông tin user để ghi description
				const userResult = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
				const nameClean = cleanName(userResult?.name || '').substring(0, 15);
				const description = `ComTrua${nameClean}`.substring(0, 25);

				const payosData = {
					orderCode,
					amount: totalAmount,
					description,
					cancelUrl,
					returnUrl
				};

				const signature = generatePaymentRequestSignature(payosData, checksumKey);

				// Gửi yêu cầu sang payOS
				const payosResponse = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-client-id': clientId,
						'x-api-key': apiKey
					},
					body: JSON.stringify({
						...payosData,
						signature
					})
				});

				const payosResult = await payosResponse.json() as any;

				if (!payosResponse.ok || payosResult.code !== '00') {
					console.error('payOS Error:', payosResult);
					return jsonResponse({ error: payosResult.desc || 'Lỗi khi gọi API payOS.' }, 500);
				}

				return jsonResponse({
					checkoutUrl: payosResult.data.checkoutUrl,
					qrCode: payosResult.data.qrCode,
					amount: totalAmount,
					description,
					orderCode
				});
			}

			// GET /api/payment/status/:orderCode
			const paymentStatusMatch = pathname.match(/^\/api\/payment\/status\/(\d+)$/);
			if (paymentStatusMatch && method === 'GET') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				const orderCode = parseInt(paymentStatusMatch[1]);
				const payment = await env.DB.prepare('SELECT * FROM payments WHERE order_code = ?')
					.bind(orderCode)
					.first<{ order_code: number; user_id: number; amount: number; status: string; order_ids: string }>();

				if (!payment) {
					return jsonResponse({ error: 'Không tìm thấy giao dịch.' }, 404);
				}

				// Nếu trạng thái trong DB là PENDING, gọi API payOS đối soát dự phòng (self-heal)
				if (payment.status === 'PENDING') {
					const clientId = env.PAYOS_CLIENT_ID;
					const apiKey = env.PAYOS_API_KEY;
					if (clientId && apiKey) {
						try {
							const payosResp = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCode}`, {
								method: 'GET',
								headers: {
									'x-client-id': clientId,
									'x-api-key': apiKey
								}
							});
							if (payosResp.ok) {
								const payosResult = await payosResp.json() as any;
								if (payosResult.code === '00' && payosResult.data) {
									const payosStatus = payosResult.data.status; // 'PAID', 'PENDING', 'CANCELLED'
									if (payosStatus === 'PAID') {
										await env.DB.prepare('UPDATE payments SET status = ? WHERE order_code = ?')
											.bind('PAID', orderCode)
											.run();

										if (payment.order_ids) {
											const orderIds = payment.order_ids.split(',').map(Number).filter(id => !isNaN(id) && id > 0);
											if (orderIds.length > 0) {
												const placeholders = orderIds.map(() => '?').join(',');
												await env.DB.prepare(`UPDATE orders SET paid = 1 WHERE id IN (${placeholders})`)
													.bind(...orderIds)
													.run();
											}
										}
										console.log(`Self-healed payment status for orderCode ${orderCode} to PAID via payOS API.`);
										return jsonResponse({ status: 'PAID' });
									} else if (payosStatus === 'CANCELLED') {
										await env.DB.prepare('UPDATE payments SET status = ? WHERE order_code = ?')
											.bind('CANCELLED', orderCode)
											.run();
										console.log(`Self-healed payment status for orderCode ${orderCode} to CANCELLED via payOS API.`);
										return jsonResponse({ status: 'CANCELLED' });
									}
								}
							}
						} catch (err) {
							console.error(`Error querying payOS status for orderCode ${orderCode}:`, err);
						}
					}
				}

				return jsonResponse({ status: payment.status });
			}


			// POST /api/payment/webhook
			// GET or POST /api/payment/webhook
			if (pathname === '/api/payment/webhook') {
				if (method === 'POST') {
					const checksumKey = env.PAYOS_CHECKSUM_KEY;
					if (!checksumKey) {
						return jsonResponse({ error: 'Cổng thanh toán chưa cấu hình Checksum Key.' }, 500);
					}

					let body: any;
					try {
						body = await request.json();
					} catch (err) {
						console.log('Webhook received empty or invalid JSON body');
						// Trả về 200 OK đối với các yêu cầu kiểm tra kết nối từ payOS khi body trống
						return jsonResponse({ success: true, message: 'Webhook is active but payload is empty.' });
					}

					console.log('Received payOS Webhook Payload:', JSON.stringify(body));

					// payOS test ping check (họ gửi thành công và message Ok trực tiếp trong body không có data)
					if (body && body.success === true && body.message === 'Ok' && !body.data) {
						console.log('Received payOS connection test ping');
						return jsonResponse({ success: true });
					}

					const isValid = verifyWebhookSignature(body, checksumKey);
					if (!isValid) {
						console.error('Invalid payOS Webhook Signature');
						return jsonResponse({ error: 'Chữ ký không hợp lệ.' }, 400);
					}

					const txData = body.data;
					// Kiểm tra mã kết quả giao dịch
					if (body.code === '00' && txData) {
						const orderCode = txData.orderCode;

						// Lấy giao dịch trong DB
						const payment = await env.DB.prepare('SELECT * FROM payments WHERE order_code = ? AND status = ?')
							.bind(orderCode, 'PENDING')
							.first<{ order_code: number; order_ids: string }>();

						if (payment) {
							// Bắt đầu cập nhật trạng thái đã thanh toán
							const orderIds = payment.order_ids.split(',').map(Number);
							
							// Cập nhật bảng payments
							await env.DB.prepare('UPDATE payments SET status = ? WHERE order_code = ?')
								.bind('PAID', orderCode)
								.run();

							// Cập nhật các đơn hàng liên quan trong bảng orders
							if (orderIds.length > 0) {
								const placeholders = orderIds.map(() => '?').join(',');
								await env.DB.prepare(`UPDATE orders SET paid = 1 WHERE id IN (${placeholders})`)
									.bind(...orderIds)
									.run();
							}

							console.log(`Successfully updated payment for orderCode: ${orderCode}, marked orders: ${payment.order_ids} as PAID`);
						} else {
							console.log(`Payment already processed or not found for orderCode: ${orderCode}`);
						}
					}

					return jsonResponse({ success: true });
				} else {
					return jsonResponse({ success: true, message: 'Cổng thanh toán payOS webhook đang hoạt động.' });
				}
			}

			// Đường dẫn không hợp lệ
			return jsonResponse({ error: 'Không tìm thấy API tương ứng.' }, 404);

		} catch (error: any) {
			return jsonResponse({ error: error.message || 'Lỗi hệ thống.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
