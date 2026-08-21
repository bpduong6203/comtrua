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
	CLERK_PUBLISHABLE_KEY?: string;
	CLERK_SECRET_KEY?: string;
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

function parseJwtPayload(token: string): any | null {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payloadJson = new TextDecoder().decode(base64urlDecode(parts[1]));
		return JSON.parse(payloadJson);
	} catch {
		return null;
	}
}

interface UserAuth {
	id: number;
	name: string;
	phone: string | null;
	avatar: string;
	default_note: string | null;
	balance: number;
	avatar_frame?: string | null;
	custom_title?: string | null;
	owned_items?: string | null;
	active: number;
	clerk_id?: string | null;
}

async function ensureClerkIdColumn(db: D1Database) {
	try {
		await db.prepare('SELECT clerk_id FROM users LIMIT 1').first();
	} catch (e) {
		try {
			await db.prepare('ALTER TABLE users ADD COLUMN clerk_id TEXT').run();
			await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)').run();
		} catch (err) { }
	}
}

async function ensureGamificationTables(db: D1Database) {
	await ensureClerkIdColumn(db);
	try {
		await db.prepare('SELECT balance, avatar_frame, custom_title, owned_items FROM users LIMIT 1').first();
	} catch (e) {
		try { await db.prepare('ALTER TABLE users ADD COLUMN balance INTEGER DEFAULT 100000').run(); } catch (err) {}
		try { await db.prepare('ALTER TABLE users ADD COLUMN avatar_frame TEXT DEFAULT ""').run(); } catch (err) {}
		try { await db.prepare('ALTER TABLE users ADD COLUMN custom_title TEXT DEFAULT ""').run(); } catch (err) {}
		try { await db.prepare('ALTER TABLE users ADD COLUMN owned_items TEXT DEFAULT "[]"').run(); } catch (err) {}
		try { await db.prepare('UPDATE users SET balance = 100000 WHERE balance IS NULL').run(); } catch (err) {}
	}

	try {
		await db.prepare(`
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
			)
		`).run();
		await db.prepare(`
			CREATE TABLE IF NOT EXISTS coin_transactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				amount INTEGER NOT NULL,
				balance_after INTEGER NOT NULL,
				reason TEXT NOT NULL,
				metadata TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY(user_id) REFERENCES users(id)
			)
		`).run();
	} catch (err) {}
}

const SHOP_ITEMS: Record<string, { id: string; name: string; type: 'frame' | 'title' | 'cheer'; price: number; icon: string }> = {
	// Frames (7 days / permanent)
	gold_royale: { id: 'gold_royale', name: 'Hoàng Gia Kim Cương', type: 'frame', price: 100000, icon: '👑' },
	cyberpunk_neon: { id: 'cyberpunk_neon', name: 'Cyberpunk Neon RGB', type: 'frame', price: 80000, icon: '🌌' },
	inferno_flame: { id: 'inferno_flame', name: 'Hỏa Diệm Rực Cháy', type: 'frame', price: 60000, icon: '🔥' },
	thunder_storm: { id: 'thunder_storm', name: 'Lôi Thần Điện Quang', type: 'frame', price: 90000, icon: '⚡' },
	cosmic_galaxy: { id: 'cosmic_galaxy', name: 'Vũ Trụ Huyền Bí', type: 'frame', price: 120000, icon: '🪐' },
	frozen_frost: { id: 'frozen_frost', name: 'Băng Tuyết Bắc Cực', type: 'frame', price: 50000, icon: '❄️' },
	sakura_blossom: { id: 'sakura_blossom', name: 'Hoa Anh Đào', type: 'frame', price: 40000, icon: '🌸' },
	emerald_nature: { id: 'emerald_nature', name: 'Tự Nhiên Rừng Xanh', type: 'frame', price: 30000, icon: '🍃' },

	// Titles
	title_dai_gia: { id: 'title_dai_gia', name: 'Đại Gia Cơm Trưa', type: 'title', price: 150000, icon: '💎' },
	title_chua_te: { id: 'title_chua_te', name: 'Chúa Tể Văn Phòng', type: 'title', price: 200000, icon: '👑' },
	title_than_doan: { id: 'title_than_doan', name: 'Thần Đoán Vũ Trụ', type: 'title', price: 120000, icon: '🔮' },
	title_dan_choi: { id: 'title_dan_choi', name: 'Dân Chơi Không Sợ Mưa Rơi', type: 'title', price: 130000, icon: '🍷' },
	title_ban_tay_vang: { id: 'title_ban_tay_vang', name: 'Bàn Tay Vàng Làng Gắp Cơm', type: 'title', price: 110000, icon: '🍀' },
	title_vua_ve_dich: { id: 'title_vua_ve_dich', name: 'Vua Về Đích', type: 'title', price: 100000, icon: '🚀' },
	title_toc_do: { id: 'title_toc_do', name: 'Tốc Độ Bàn Thờ', type: 'title', price: 90000, icon: '⚡' },
	title_phu_thuy: { id: 'title_phu_thuy', name: 'Phù Thủy Ẩm Thực', type: 'title', price: 140000, icon: '🧙‍♂️' },

	// Live VIP Cheer FX
	cheer_fireworks: { id: 'cheer_fireworks', name: 'Pháo Hoa Rực Rỡ', type: 'cheer', price: 10000, icon: '🎆' },
	cheer_nitro: { id: 'cheer_nitro', name: 'Bình Nitro Phản Lực', type: 'cheer', price: 15000, icon: '🚀' },
	cheer_lightning: { id: 'cheer_lightning', name: 'Sấm Sét Gạt Giò', type: 'cheer', price: 20000, icon: '⚡' },
	cheer_money_rain: { id: 'cheer_money_rain', name: 'Mưa Tiền Đô Rơi', type: 'cheer', price: 18000, icon: '🌧️' },
	cheer_tornado: { id: 'cheer_tornado', name: 'Lốc Xoáy Quét Đường', type: 'cheer', price: 22000, icon: '🌪️' },
	cheer_led_banner: { id: 'cheer_led_banner', name: 'Bảng LED Chạy Chữ', type: 'cheer', price: 25000, icon: '💬' },
	cheer_smoke_bomb: { id: 'cheer_smoke_bomb', name: 'Ném Bom Khói Mù', type: 'cheer', price: 12000, icon: '💣' },
	cheer_heart_burst: { id: 'cheer_heart_burst', name: 'Mưa Thả Tim Khổng Lồ', type: 'cheer', price: 14000, icon: '💖' },
};

async function getUserFromRequest(request: Request, env: Env): Promise<UserAuth | null> {
	await ensureGamificationTables(env.DB);

	// 1. Authorization: Bearer <clerk_token>
	const authHeader = request.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.substring(7).trim();
		const payload = parseJwtPayload(token);
		if (payload && payload.sub) {
			if (payload.exp && (Date.now() / 1000) > payload.exp) {
				return null;
			}
			const user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE clerk_id = ?')
				.bind(payload.sub)
				.first<UserAuth>();
			if (user && user.active === 1) return user;
		}
	}

	// 2. Cookie session
	const cookieVal = getCookie(request, 'session');
	if (cookieVal) {
		const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
		const payload = await verifyJwt(cookieVal, secret);
		if (payload && payload.id) {
			const user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE id = ?')
				.bind(payload.id)
				.first<UserAuth>();
			if (user && user.active === 1) return user;
		}
	}

	return null;
}


// Helper to return a JSON response (internal use only, no external CORS)
function jsonResponse(data: any, status: number = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
}

// Helper to get today's date in GMT+7 (ICT) time zone
function getVNDateString() {
	const offset = 7 * 60; // ICT is UTC + 7
	const date = new Date(Date.now() + offset * 60 * 1000);
	return date.toISOString().split('T')[0];
}

// Helper to get current time in GMT+7 (HH:MM)
function getVNTimeString() {
	const offset = 7 * 60; // ICT is UTC + 7
	const date = new Date(Date.now() + offset * 60 * 1000);
	const hours = String(date.getUTCHours()).padStart(2, '0');
	const minutes = String(date.getUTCMinutes()).padStart(2, '0');
	return `${hours}:${minutes}`;
}

// Helper to resolve race theme ('duck', 'horse', 'rabbit', 'turtle', 'bird', or 'random')
function resolveRaceTheme(configuredTheme: string, dateStr: string): string {
	const validThemes = ['duck', 'horse', 'rabbit', 'turtle', 'bird'];
	if (configuredTheme && validThemes.includes(configuredTheme)) {
		return configuredTheme;
	}
	if (configuredTheme === 'random') {
		let hash = 0;
		for (let i = 0; i < dateStr.length; i++) {
			hash = (hash * 31 + dateStr.charCodeAt(i)) & 0xffffffff;
		}
		return validThemes[Math.abs(hash) % validThemes.length];
	}
	return 'duck';
}

// Helper to get Monday and Sunday date strings (YYYY-MM-DD) for the week containing dateStr
function getWeekDateRange(dateStr: string): { mondayStr: string; sundayStr: string } {
	const [year, month, day] = dateStr.split('-').map(Number);
	const d = new Date(Date.UTC(year, month - 1, day));
	const dayOfWeek = d.getUTCDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
	const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

	const mondayDate = new Date(d);
	mondayDate.setUTCDate(d.getUTCDate() - diffToMonday);

	const sundayDate = new Date(mondayDate);
	sundayDate.setUTCDate(mondayDate.getUTCDate() + 6);

	return {
		mondayStr: mondayDate.toISOString().split('T')[0],
		sundayStr: sundayDate.toISOString().split('T')[0],
	};
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

// Settle predictions and award bounties for dateParam
async function settleRacePredictionsAndBounties(db: D1Database, dateParam: string, ducks: any[], losers: any[]) {
	await ensureGamificationTables(db);
	const top1 = ducks.find((d: any) => d.finishRank === 1);
	const top2 = ducks.find((d: any) => d.finishRank === 2);
	const top3 = ducks.find((d: any) => d.finishRank === 3);

	const { results: pendingPredictions } = await db.prepare(
		'SELECT * FROM race_predictions WHERE date = ? AND status = "PENDING"'
	).bind(dateParam).all<any>();

	if (pendingPredictions && pendingPredictions.length > 0) {
		for (const pred of pendingPredictions) {
			let isWin = false;
			let payoutMultiplier = 0;
			if (pred.predicted_rank === 1 && top1 && pred.predicted_user_id === top1.id) {
				isWin = true;
				payoutMultiplier = 3.0;
			} else if (pred.predicted_rank === 2 && top2 && pred.predicted_user_id === top2.id) {
				isWin = true;
				payoutMultiplier = 2.0;
			} else if (pred.predicted_rank === 3 && top3 && pred.predicted_user_id === top3.id) {
				isWin = true;
				payoutMultiplier = 1.5;
			}

			if (isWin) {
				const payout = Math.floor(pred.bet_amount * payoutMultiplier);
				await db.prepare('UPDATE race_predictions SET status = "WON", payout = ? WHERE id = ?')
					.bind(payout, pred.id)
					.run();
				await db.prepare('UPDATE users SET balance = COALESCE(balance, 100000) + ? WHERE id = ?')
					.bind(payout, pred.user_id)
					.run();
				const uRow = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(pred.user_id).first<{ balance: number }>();
				await db.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(pred.user_id, payout, uRow?.balance || 100000, 'BET_WON', JSON.stringify({ date: dateParam, rank: pred.predicted_rank, bet: pred.bet_amount }))
					.run();
			} else {
				await db.prepare('UPDATE race_predictions SET status = "LOST", payout = 0 WHERE id = ?')
					.bind(pred.id)
					.run();
			}
		}
	}

	// Shipper bounty (+30000 for each loser)
	if (losers && Array.isArray(losers)) {
		for (const loser of losers) {
			const existingBounty = await db.prepare(
				'SELECT id FROM coin_transactions WHERE user_id = ? AND reason = "SHIPPER_BOUNTY" AND metadata LIKE ?'
			)
				.bind(loser.id, `%${dateParam}%`)
				.first();
			if (!existingBounty) {
				await db.prepare('UPDATE users SET balance = COALESCE(balance, 100000) + 30000 WHERE id = ?')
					.bind(loser.id)
					.run();
				const uRow = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(loser.id).first<{ balance: number }>();
				await db.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(loser.id, 30000, uRow?.balance || 100000, 'SHIPPER_BOUNTY', JSON.stringify({ date: dateParam }))
					.run();
			}
		}
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const method = request.method;

		// Chặn không cho bên ngoài truy cập, chỉ dùng nội bộ (Same-Origin restriction)
		// Ngoại lệ đối với payOS Webhook gọi từ server của payOS
		if (pathname !== '/api/payment/webhook') {
			const origin = request.headers.get('Origin');
			if (origin && origin !== url.origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
				return new Response('Truy cập bị chặn (Origin không hợp lệ)', { status: 403 });
			}

			const referer = request.headers.get('Referer');
			if (referer) {
				try {
					const refererUrl = new URL(referer);
					if (refererUrl.origin !== url.origin && !refererUrl.origin.includes('localhost') && !refererUrl.origin.includes('127.0.0.1')) {
						return new Response('Truy cập bị chặn (Referer không hợp lệ)', { status: 403 });
					}
				} catch (e) {
					return new Response('Truy cập bị chặn (Referer không hợp lệ)', { status: 403 });
				}
			}
		}

		// Handle CORS Preflight requests (chỉ cho phép từ cùng origin)
		if (method === 'OPTIONS') {
			const requestOrigin = request.headers.get('Origin');
			const allowedOrigins = [url.origin, 'http://localhost:3000', 'https://mebicom.pages.dev'];
			const isAllowed = requestOrigin && (allowedOrigins.includes(requestOrigin) || requestOrigin.includes('localhost') || requestOrigin.includes('127.0.0.1'));

			if (requestOrigin && !isAllowed) {
				return new Response('CORS Not Allowed', { status: 403 });
			}

			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': requestOrigin && isAllowed ? requestOrigin : url.origin,
					'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
					'Access-Control-Allow-Credentials': 'true',
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

			// POST /api/users/login (Hỗ trợ xác thực người dùng & test session)
			if (pathname === '/api/users/login' && method === 'POST') {
				await ensureGamificationTables(env.DB);
				const body = await request.json() as { userId?: number; name?: string; register?: boolean };
				let user: UserAuth | null = null;

				if (body.userId) {
					user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE id = ?')
						.bind(body.userId)
						.first<UserAuth>();
				} else if (body.name?.trim()) {
					user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))')
						.bind(body.name.trim())
						.first<UserAuth>();

					if (!user && body.register) {
						const name = body.name.trim();
						await env.DB.prepare('INSERT INTO users (name, balance) VALUES (?, 100000)')
							.bind(name)
							.run();
						user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))')
							.bind(name)
							.first<UserAuth>();
					}
				}

				if (!user) {
					return jsonResponse({ error: 'Không tìm thấy tài khoản người dùng.' }, 404);
				}

				if (user.active === 0) {
					return jsonResponse({ error: 'Tài khoản này đã bị khóa hoặc tạm ngưng hoạt động.' }, 403);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const token = await signJwt({ id: user.id, name: user.name, clerk_id: user.clerk_id || null }, secret);
				const response = jsonResponse({ user, success: true, message: `Đăng nhập thành công với ${user.name}` });
				const isSecure = url.protocol === 'https:';
				response.headers.append('Set-Cookie', `session=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=31536000`);
				return response;
			}

			// POST /api/users/clerk-auth
			if (pathname === '/api/users/clerk-auth' && method === 'POST') {
				await ensureGamificationTables(env.DB);
				const body = await request.json() as { clerkId?: string; name?: string; avatar?: string };
				const clerkId = body.clerkId?.trim();
				if (!clerkId) {
					return jsonResponse({ error: 'Thiếu thông tin clerkId.' }, 400);
				}

				// 1. Kiểm tra xem clerk_id đã được liên kết với user trong D1 chưa
				const user = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE clerk_id = ?')
					.bind(clerkId)
					.first<UserAuth>();

				if (user) {
					if (user.active === 0) {
						return jsonResponse({ error: 'Tài khoản này đã bị khóa hoặc tạm ngưng hoạt động.' }, 403);
					}
					const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
					const token = await signJwt({ id: user.id, name: user.name, clerk_id: user.clerk_id }, secret);
					const response = jsonResponse({ user, unlinkedUsers: [], requiresLinking: false });
					const isSecure = url.protocol === 'https:';
					response.headers.append('Set-Cookie', `session=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=31536000`);
					return response;
				}

				// 2. Chưa được liên kết -> Trả về danh sách tài khoản cũ chưa liên kết để người dùng chọn
				const { results: unlinkedUsers } = await env.DB.prepare(
					'SELECT id, name, avatar FROM users WHERE (clerk_id IS NULL OR clerk_id = "") AND active = 1 ORDER BY name ASC'
				).all();

				return jsonResponse({
					user: null,
					unlinkedUsers: unlinkedUsers || [],
					requiresLinking: true
				});
			}

			// POST /api/users/link-clerk
			if (pathname === '/api/users/link-clerk' && method === 'POST') {
				await ensureGamificationTables(env.DB);
				const body = await request.json() as { clerkId?: string; userId?: number; newName?: string };
				const clerkId = body.clerkId?.trim();
				if (!clerkId) {
					return jsonResponse({ error: 'Thiếu thông tin clerkId.' }, 400);
				}

				let targetUser: UserAuth | null = null;

				if (body.userId) {
					// Gán clerk_id vào tài khoản cũ được chọn
					await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
						.bind(clerkId, body.userId)
						.run();

					targetUser = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE id = ?')
						.bind(body.userId)
						.first<UserAuth>();
				} else if (body.newName?.trim()) {
					// Tạo tài khoản mới hoàn toàn với tên mới
					const name = body.newName.trim();
					const result = await env.DB.prepare('INSERT INTO users (name, clerk_id, balance) VALUES (?, ?, 100000)')
						.bind(name, clerkId)
						.run();
					if (!result.success) {
						return jsonResponse({ error: 'Không thể tạo tài khoản mới.' }, 500);
					}
					targetUser = await env.DB.prepare('SELECT id, name, phone, avatar, default_note, balance, avatar_frame, custom_title, owned_items, active, clerk_id FROM users WHERE clerk_id = ?')
						.bind(clerkId)
						.first<UserAuth>();
				} else {
					return jsonResponse({ error: 'Vui lòng chọn tài khoản cũ hoặc nhập tên mới.' }, 400);
				}

				if (!targetUser) {
					return jsonResponse({ error: 'Không thể xử lý liên kết tài khoản.' }, 500);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const token = await signJwt({ id: targetUser.id, name: targetUser.name, clerk_id: targetUser.clerk_id }, secret);
				const response = jsonResponse({ user: targetUser, message: 'Liên kết tài khoản thành công!' });
				const isSecure = url.protocol === 'https:';
				response.headers.append('Set-Cookie', `session=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=31536000`);
				return response;
			}

			// Lấy thông tin tài khoản hiện tại
			// GET /api/users/me
			if (pathname === '/api/users/me' && method === 'GET') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
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

			// ==========================================
			// 1.5 API VÍ TIỀN & CỬA HÀNG (WALLET & SHOP)
			// ==========================================

			// GET /api/wallet/balance
			if (pathname === '/api/wallet/balance' && method === 'GET') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const { results: transactions } = await env.DB.prepare(
					'SELECT id, amount, balance_after, reason, metadata, created_at FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20'
				)
					.bind(user.id)
					.all();

				let ownedItems: string[] = [];
				try {
					ownedItems = JSON.parse(user.owned_items || '[]');
				} catch {
					ownedItems = [];
				}

				return jsonResponse({
					balance: user.balance || 0,
					avatar_frame: user.avatar_frame || '',
					custom_title: user.custom_title || '',
					owned_items: ownedItems,
					transactions: transactions || [],
					shop_items: SHOP_ITEMS
				});
			}

			// POST /api/shop/buy
			if (pathname === '/api/shop/buy' && method === 'POST') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const body = await request.json() as { itemId?: string };
				const itemId = body.itemId?.trim();
				if (!itemId || !SHOP_ITEMS[itemId]) {
					return jsonResponse({ error: 'Vật phẩm không tồn tại.' }, 400);
				}

				const item = SHOP_ITEMS[itemId];
				const currentBalance = user.balance || 0;
				if (currentBalance < item.price) {
					return jsonResponse({ error: `Số dư không đủ. Bạn cần ${item.price.toLocaleString('vi-VN')} đ (hiện có ${currentBalance.toLocaleString('vi-VN')} đ).` }, 400);
				}

				let ownedItems: string[] = [];
				try {
					ownedItems = JSON.parse(user.owned_items || '[]');
				} catch {
					ownedItems = [];
				}

				if (!ownedItems.includes(itemId)) {
					ownedItems.push(itemId);
				}

				const newBalance = currentBalance - item.price;
				let avatarFrame = user.avatar_frame || '';
				let customTitle = user.custom_title || '';

				if (item.type === 'frame') {
					avatarFrame = itemId;
				} else if (item.type === 'title') {
					customTitle = itemId;
				}

				await env.DB.prepare(
					'UPDATE users SET balance = ?, owned_items = ?, avatar_frame = ?, custom_title = ? WHERE id = ?'
				)
					.bind(newBalance, JSON.stringify(ownedItems), avatarFrame, customTitle, user.id)
					.run();

				await env.DB.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(user.id, -item.price, newBalance, 'SHOP_PURCHASE', JSON.stringify({ itemId, itemName: item.name }))
					.run();

				return jsonResponse({
					success: true,
					message: `Mua thành công ${item.name}!`,
					newBalance,
					owned_items: ownedItems,
					avatar_frame: avatarFrame,
					custom_title: customTitle
				});
			}

			// POST /api/shop/equip
			if (pathname === '/api/shop/equip' && method === 'POST') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const body = await request.json() as { type?: 'frame' | 'title'; itemId?: string };
				const itemType = body.type;
				const itemId = body.itemId || '';

				let ownedItems: string[] = [];
				try {
					ownedItems = JSON.parse(user.owned_items || '[]');
				} catch {
					ownedItems = [];
				}

				if (itemId && !ownedItems.includes(itemId)) {
					return jsonResponse({ error: 'Bạn chưa sở hữu vật phẩm này.' }, 400);
				}

				let avatarFrame = user.avatar_frame || '';
				let customTitle = user.custom_title || '';

				if (itemType === 'frame') {
					avatarFrame = itemId;
					await env.DB.prepare('UPDATE users SET avatar_frame = ? WHERE id = ?').bind(avatarFrame, user.id).run();
				} else if (itemType === 'title') {
					customTitle = itemId;
					await env.DB.prepare('UPDATE users SET custom_title = ? WHERE id = ?').bind(customTitle, user.id).run();
				} else {
					return jsonResponse({ error: 'Loại vật phẩm không hợp lệ.' }, 400);
				}

				return jsonResponse({
					success: true,
					message: 'Trang bị thành công!',
					avatar_frame: avatarFrame,
					custom_title: customTitle
				});
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
					announcement: '',
					lunch_race_auto_time: '11:30',
					lunch_race_auto_enabled: '1',
					lunch_picker_mode: 'duck_race',
					lunch_race_theme: 'duck'
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
			// 2.9 API CHỌN NGƯỜI ĐI LẤY CƠM (LUNCH PICKERS & DUCK RACE)
			// ==========================================

			// GET /api/lunch-pickers?date=YYYY-MM-DD
			if (pathname === '/api/lunch-pickers' && method === 'GET') {
				const dateParam = url.searchParams.get('date') || getVNDateString();
				const key = `lunch_pickers_${dateParam}`;
				const raceKey = `lunch_race_${dateParam}`;
				const now = Date.now();
				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();

				// Kiểm tra nếu đang có cuộc đua đang chạy dở thì chưa trả kết quả ra ngoài
				const raceRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(raceKey)
					.first<{ value: string }>();
				if (raceRow) {
					try {
						const raceData = JSON.parse(raceRow.value);
						const raceEndTime = (raceData.startTime || 0) + (raceData.durationMs || 15000);
						if (now < raceEndTime) {
							return jsonResponse({ pickers: [], isRacing: true });
						}
					} catch (e) {}
				}

				const result = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(key)
					.first<{ value: string }>();

				return jsonResponse({ pickers: result ? JSON.parse(result.value) : [] });
			}

			// POST /api/lunch-race/presence (Heartbeat người đang xem)
			if (pathname === '/api/lunch-race/presence' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn.' }, 401);
				}

				const body = await request.json().catch(() => ({})) as { cheerEmoji?: string };
				const now = Date.now();
				const presenceKey = 'lunch_race_presence';

				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const presenceResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(presenceKey)
					.first<{ value: string }>();

				let presenceMap: Record<string, { id: number; name: string; avatar: string; lastSeen: number; cheerEmoji?: string }> = {};
				if (presenceResult) {
					try {
						presenceMap = JSON.parse(presenceResult.value);
					} catch (e) {
						presenceMap = {};
					}
				}

				// Lấy thông tin user mới nhất
				const user = await env.DB.prepare('SELECT id, name, avatar FROM users WHERE id = ?')
					.bind(payload.id)
					.first<{ id: number; name: string; avatar: string }>();

				if (user) {
					presenceMap[user.id] = {
						id: user.id,
						name: user.name,
						avatar: user.avatar || '👤',
						lastSeen: now,
						cheerEmoji: body.cheerEmoji || presenceMap[user.id]?.cheerEmoji || '🚩'
					};
				}

				// Lọc bỏ những người đã offline quá 10 giây
				const activeSpectators = Object.values(presenceMap).filter(s => now - s.lastSeen < 10000);
				const cleanedMap: Record<string, any> = {};
				activeSpectators.forEach(s => { cleanedMap[s.id] = s; });

				await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(presenceKey, JSON.stringify(cleanedMap))
					.run();

				return jsonResponse({
					success: true,
					spectators: activeSpectators
				});
			}

			// POST /api/lunch-race/cheer (Gửi tương tác cổ vũ siêu tốc)
			if (pathname === '/api/lunch-race/cheer' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn.' }, 401);
				}

				const body = await request.json().catch(() => ({})) as { emoji?: string; text?: string };
				const now = Date.now();
				const cheerEmoji = body.emoji || '🔥';
				const cheerText = body.text || '';
				const userName = payload.name || 'Người dùng';
				const userAvatar = payload.avatar || '👤';

				const cheersKey = 'lunch_race_cheers';
				const cheersResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(cheersKey)
					.first<{ value: string }>();

				let cheersList: any[] = [];
				if (cheersResult) {
					try {
						cheersList = JSON.parse(cheersResult.value);
					} catch (e) {
						cheersList = [];
					}
				}

				const newCheer = {
					id: `${now}_${payload.id}_${Math.floor(Math.random() * 1000)}`,
					userId: payload.id,
					userName,
					userAvatar,
					emoji: cheerEmoji,
					text: cheerText,
					time: now
				};

				cheersList.push(newCheer);
				// Chỉ giữ lại các cheer trong 8 giây gần nhất, tối đa 30 cái
				cheersList = cheersList.filter((c: any) => now - c.time < 8000).slice(-30);

				await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(cheersKey, JSON.stringify(cheersList))
					.run();

				return jsonResponse({
					success: true,
					cheer: newCheer
				});
			}

			// GET /api/lunch-race?date=YYYY-MM-DD
			if (pathname === '/api/lunch-race' && method === 'GET') {
				const dateParam = url.searchParams.get('date') || getVNDateString();
				const raceKey = `lunch_race_${dateParam}`;
				const pickersKey = `lunch_pickers_${dateParam}`;
				const now = Date.now();
				
				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				let raceResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(raceKey)
					.first<{ value: string }>();

				let pickersResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(pickersKey)
					.first<{ value: string }>();

				// Lấy cấu hình giờ tự động đua vịt & chế độ chọn người & chủ đề đua
				const autoTimeRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_auto_time'").first<{ value: string }>();
				const autoEnabledRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_auto_enabled'").first<{ value: string }>();
				const pickerModeRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_picker_mode'").first<{ value: string }>();
				const themeRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_theme'").first<{ value: string }>();
				const autoRaceTime = autoTimeRow?.value || '11:30';
				const autoRaceEnabled = autoEnabledRow?.value !== '0';
				const lunchPickerMode = pickerModeRow?.value || 'duck_race';
				const configuredTheme = themeRow?.value || 'duck';
				const activeTheme = resolveRaceTheme(configuredTheme, dateParam);
				const todayStr = getVNDateString();
				const currentVNTime = getVNTimeString();

				// KIỂM TRA TỰ ĐỘNG CHẠY ĐUA VỊT CHÍNH THỨC
				// Nếu ở chế độ đua vịt, là ngày hôm nay, tính năng tự động bật, giờ hiện tại >= giờ cấu hình, và chưa có trận đua chính thức
				if (lunchPickerMode === 'duck_race' && dateParam === todayStr && autoRaceEnabled && currentVNTime >= autoRaceTime) {
					let currentRace = raceResult ? JSON.parse(raceResult.value) : null;
					if (!currentRace || !currentRace.isOfficial) {
						// Lấy danh sách những người đặt cơm hôm nay
						const { results: orderedUsers } = await env.DB.prepare(`
							SELECT DISTINCT u.id, u.name, u.avatar
							FROM orders o
							JOIN users u ON o.user_id = u.id
							WHERE o.date = ? AND u.active = 1
						`)
							.bind(dateParam)
							.all<{ id: number; name: string; avatar: string }>();

						if (orderedUsers.length > 0) {
							const countdownMs = 4000;
							const durationMs = 15000;
							const startTime = now + countdownMs;
							const seed = Math.floor(Math.random() * 1000000000);
							const totalParticipants = orderedUsers.length;
							const ranks = Array.from({ length: totalParticipants }, (_, i) => i + 1).sort(() => Math.random() - 0.5);

							const ducks = orderedUsers.map((u, index) => ({
								id: u.id,
								name: u.name,
								avatar: u.avatar || '🦆',
								lane: index,
								finishRank: ranks[index],
								duckSeed: (seed + (u.id * 31 + index * 17) * 7919) % 1000000
							}));

							const sortedDucksByRank = [...ducks].sort((a, b) => b.finishRank - a.finishRank);
							let losers: { id: number; name: string; avatar: string }[] = [];
							if (totalParticipants === 1) {
								losers = [{ id: sortedDucksByRank[0].id, name: sortedDucksByRank[0].name, avatar: sortedDucksByRank[0].avatar }];
							} else {
								losers = [
									{ id: sortedDucksByRank[1].id, name: sortedDucksByRank[1].name, avatar: sortedDucksByRank[1].avatar },
									{ id: sortedDucksByRank[0].id, name: sortedDucksByRank[0].name, avatar: sortedDucksByRank[0].avatar }
								];
							}

							const officialRaceData = {
								raceId: `official_race_${now}`,
								date: dateParam,
								theme: activeTheme,
								seed,
								startTime,
								durationMs,
								countdownMs,
								totalDucks: totalParticipants,
								ducks,
								losers,
								isOfficial: true,
								isLocked: true,
								autoTriggered: true
							};

							await env.DB.prepare(
								'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
							)
								.bind(raceKey, JSON.stringify(officialRaceData))
								.run();

							await env.DB.prepare(
								'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
							)
								.bind(pickersKey, JSON.stringify(losers))
								.run();

							raceResult = { value: JSON.stringify(officialRaceData) };
							pickersResult = { value: JSON.stringify(losers) };
						}
					}
				}

				const presenceResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind('lunch_race_presence')
					.first<{ value: string }>();

				let presenceMap: Record<string, any> = {};
				if (presenceResult) {
					try {
						presenceMap = JSON.parse(presenceResult.value);
					} catch (e) {
						presenceMap = {};
					}
				}

				// Tự động ghi nhận người dùng đang online xem qua session cookie
				const cookieVal = getCookie(request, 'session');
				let hasUpdatedPresence = false;
				if (cookieVal) {
					const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
					const payload = await verifyJwt(cookieVal, secret);
					if (payload && payload.id) {
						presenceMap[payload.id] = {
							id: payload.id,
							name: payload.name || 'Người dùng',
							avatar: payload.avatar || '👤',
							lastSeen: now,
							cheerEmoji: presenceMap[payload.id]?.cheerEmoji || '🚩'
						};
						hasUpdatedPresence = true;
					}
				}

				// Lọc bỏ những người đã offline quá 20 giây
				const spectators = Object.values(presenceMap).filter((s: any) => now - s.lastSeen < 20000);
				const cleanedMap: Record<string, any> = {};
				spectators.forEach((s: any) => { cleanedMap[s.id] = s; });

				if (hasUpdatedPresence) {
					await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value')
						.bind('lunch_race_presence', JSON.stringify(cleanedMap))
						.run();
				}

				const cheersResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind('lunch_race_cheers')
					.first<{ value: string }>();

				let cheers: any[] = [];
				if (cheersResult) {
					try {
						cheers = JSON.parse(cheersResult.value).filter((c: any) => now - c.time < 8000);
					} catch (e) {
						cheers = [];
					}
				}

				const parsedRace = raceResult ? JSON.parse(raceResult.value) : null;
				const isRaceInProgress = parsedRace ? (now < (parsedRace.startTime || 0) + (parsedRace.durationMs || 15000)) : false;

				let top3: any[] = [];
				if (parsedRace && parsedRace.ducks) {
					top3 = [
						parsedRace.ducks.find((d: any) => d.finishRank === 1),
						parsedRace.ducks.find((d: any) => d.finishRank === 2),
						parsedRace.ducks.find((d: any) => d.finishRank === 3)
					].filter(Boolean);

					// Settle predictions if race is completed
					if (!isRaceInProgress && parsedRace.losers) {
						await settleRacePredictionsAndBounties(env.DB, dateParam, parsedRace.ducks, parsedRace.losers);
					}
				}

				return jsonResponse({
					serverTime: now,
					race: parsedRace ? {
						...parsedRace,
						top3: isRaceInProgress ? [] : top3,
						losers: isRaceInProgress ? [] : parsedRace.losers
					} : null,
					pickers: (parsedRace && isRaceInProgress) ? [] : (pickersResult ? JSON.parse(pickersResult.value) : []),
					spectators,
					cheers,
					autoRaceTime,
					autoRaceEnabled,
					currentVNTime,
					lunchPickerMode,
					configuredTheme,
					raceTheme: (parsedRace && parsedRace.theme) || activeTheme,
					isLocked: parsedRace ? !!(parsedRace.isLocked || parsedRace.isOfficial) : false,
					isRacing: isRaceInProgress
				});
			}

			// POST /api/lunch-race/predict
			if (pathname === '/api/lunch-race/predict' && method === 'POST') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const body = await request.json() as { date?: string; predictedUserId?: number; predictedRank?: number; betAmount?: number };
				const dateParam = body.date?.trim() || getVNDateString();
				const predictedUserId = Number(body.predictedUserId);
				const predictedRank = Number(body.predictedRank || 1);
				const betAmount = Number(body.betAmount);

				if (!predictedUserId || ![1, 2, 3].includes(predictedRank) || isNaN(betAmount) || betAmount < 1000) {
					return jsonResponse({ error: 'Thông tin cược không hợp lệ (mức cược tối thiểu 1.000 đ).' }, 400);
				}

				// Check deadline
				const deadlineCheck = await isPastDeadline(env.DB, dateParam);
				if (deadlineCheck.blocked && user.id !== 1) {
					return jsonResponse({ error: `Đã quá thời gian đặt cược dự đoán cho ngày hôm nay (${deadlineCheck.deadline}).` }, 403);
				}

				// Check user balance
				const currentBalance = user.balance || 0;
				if (currentBalance < betAmount) {
					return jsonResponse({ error: `Số dư không đủ. Bạn có ${currentBalance.toLocaleString('vi-VN')} đ nhưng cược ${betAmount.toLocaleString('vi-VN')} đ.` }, 400);
				}

				// Check existing prediction
				const existing = await env.DB.prepare('SELECT id, bet_amount FROM race_predictions WHERE date = ? AND user_id = ?')
					.bind(dateParam, user.id)
					.first<{ id: number; bet_amount: number }>();

				if (existing) {
					return jsonResponse({ error: 'Bạn đã gửi dự đoán cho ngày hôm nay rồi!' }, 400);
				}

				const newBalance = currentBalance - betAmount;
				await env.DB.prepare('UPDATE users SET balance = ? WHERE id = ?')
					.bind(newBalance, user.id)
					.run();

				await env.DB.prepare(
					'INSERT INTO race_predictions (date, user_id, predicted_user_id, predicted_rank, bet_amount, status) VALUES (?, ?, ?, ?, ?, "PENDING")'
				)
					.bind(dateParam, user.id, predictedUserId, predictedRank, betAmount)
					.run();

				await env.DB.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(user.id, -betAmount, newBalance, 'BET_PLACED', JSON.stringify({ date: dateParam, rank: predictedRank, target: predictedUserId }))
					.run();

				return jsonResponse({
					success: true,
					message: `Đặt cược thành công ${betAmount.toLocaleString('vi-VN')} đ!`,
					newBalance
				});
			}

			// GET /api/lunch-race/predictions
			if (pathname === '/api/lunch-race/predictions' && method === 'GET') {
				const user = await getUserFromRequest(request, env);
				const dateParam = url.searchParams.get('date') || getVNDateString();

				let myPrediction: any = null;
				if (user) {
					myPrediction = await env.DB.prepare(
						`SELECT p.*, u.name as target_name, u.avatar as target_avatar 
						FROM race_predictions p 
						JOIN users u ON p.predicted_user_id = u.id 
						WHERE p.date = ? AND p.user_id = ?`
					)
						.bind(dateParam, user.id)
						.first();
				}

				const { results: allPreds } = await env.DB.prepare(
					`SELECT p.predicted_user_id, p.predicted_rank, p.bet_amount, u.name, u.avatar
					FROM race_predictions p
					JOIN users u ON p.predicted_user_id = u.id
					WHERE p.date = ?`
				)
					.bind(dateParam)
					.all<{ predicted_user_id: number; predicted_rank: number; bet_amount: number; name: string; avatar: string }>();

				const totalBets = allPreds?.length || 0;
				const totalPool = (allPreds || []).reduce((sum, p) => sum + p.bet_amount, 0);

				const userStatsMap = new Map<number, { userId: number; name: string; avatar: string; votes: number; totalAmount: number; ranks: Record<number, number> }>();
				for (const p of (allPreds || [])) {
					if (!userStatsMap.has(p.predicted_user_id)) {
						userStatsMap.set(p.predicted_user_id, {
							userId: p.predicted_user_id,
							name: p.name,
							avatar: p.avatar || '👤',
							votes: 0,
							totalAmount: 0,
							ranks: { 1: 0, 2: 0, 3: 0 }
						});
					}
					const entry = userStatsMap.get(p.predicted_user_id)!;
					entry.votes++;
					entry.totalAmount += p.bet_amount;
					entry.ranks[p.predicted_rank] = (entry.ranks[p.predicted_rank] || 0) + 1;
				}

				const candidateStats = Array.from(userStatsMap.values()).map(c => ({
					...c,
					percentage: totalBets > 0 ? Math.round((c.votes / totalBets) * 1000) / 10 : 0
				})).sort((a, b) => b.votes - a.votes);

				return jsonResponse({
					myPrediction,
					totalBets,
					totalPool,
					candidateStats
				});
			}

			// POST /api/lunch-race/spectate-reward
			if (pathname === '/api/lunch-race/spectate-reward' && method === 'POST') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const body = await request.json().catch(() => ({})) as { date?: string };
				const dateParam = body.date?.trim() || getVNDateString();

				const existingReward = await env.DB.prepare(
					'SELECT id FROM coin_transactions WHERE user_id = ? AND reason = "SPECTATE_REWARD" AND metadata LIKE ?'
				)
					.bind(user.id, `%${dateParam}%`)
					.first();

				if (existingReward) {
					return jsonResponse({ error: 'Bạn đã nhận thưởng khán giả hôm nay rồi!', alreadyClaimed: true }, 400);
				}

				const rewardAmount = 10000;
				const newBalance = (user.balance || 0) + rewardAmount;

				await env.DB.prepare('UPDATE users SET balance = ? WHERE id = ?')
					.bind(newBalance, user.id)
					.run();

				await env.DB.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(user.id, rewardAmount, newBalance, 'SPECTATE_REWARD', JSON.stringify({ date: dateParam }))
					.run();

				return jsonResponse({
					success: true,
					reward: rewardAmount,
					newBalance,
					message: 'Chúc mừng bạn đã nhận được +10.000 đ thưởng xem trực tiếp!'
				});
			}

			// POST /api/lunch-race/vip-cheer
			if (pathname === '/api/lunch-race/vip-cheer' && method === 'POST') {
				const user = await getUserFromRequest(request, env);
				if (!user) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const body = await request.json().catch(() => ({})) as { cheerId?: string; targetDuckId?: number; customText?: string };
				const cheerId = body.cheerId?.trim();
				if (!cheerId || !SHOP_ITEMS[cheerId]) {
					return jsonResponse({ error: 'Hiệu ứng cổ vũ không hợp lệ.' }, 400);
				}

				const item = SHOP_ITEMS[cheerId];
				const currentBalance = user.balance || 0;
				if (currentBalance < item.price) {
					return jsonResponse({ error: `Số dư không đủ (${currentBalance.toLocaleString('vi-VN')} đ < ${item.price.toLocaleString('vi-VN')} đ).` }, 400);
				}

				const newBalance = currentBalance - item.price;
				await env.DB.prepare('UPDATE users SET balance = ? WHERE id = ?')
					.bind(newBalance, user.id)
					.run();

				await env.DB.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(user.id, -item.price, newBalance, 'VIP_CHEER', JSON.stringify({ cheerId, targetDuckId: body.targetDuckId, text: body.customText }))
					.run();

				// Thêm vào danh sách cheers của race
				const now = Date.now();
				const cheersKey = 'lunch_race_cheers';
				const cheersResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(cheersKey)
					.first<{ value: string }>();

				let cheersList: any[] = [];
				if (cheersResult) {
					try { cheersList = JSON.parse(cheersResult.value); } catch { cheersList = []; }
				}

				const newVipCheer = {
					id: `${now}_${user.id}_vip`,
					userId: user.id,
					userName: user.name,
					userAvatar: user.avatar || '👤',
					avatarFrame: user.avatar_frame || '',
					customTitle: user.custom_title || '',
					emoji: item.icon,
					cheerId,
					isVip: true,
					targetDuckId: body.targetDuckId,
					text: body.customText || item.name,
					time: now
				};

				cheersList.push(newVipCheer);
				cheersList = cheersList.filter((c: any) => now - c.time < 12000).slice(-30);

				await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value')
					.bind(cheersKey, JSON.stringify(cheersList))
					.run();

				return jsonResponse({
					success: true,
					cheer: newVipCheer,
					newBalance
				});
			}

			// POST /api/lunch-race/start
			if (pathname === '/api/lunch-race/start' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				const body = await request.json() as { date?: string };
				const dateParam = body.date?.trim() || getVNDateString();
				const raceKey = `lunch_race_${dateParam}`;
				const pickersKey = `lunch_pickers_${dateParam}`;

				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const existingRace = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(raceKey)
					.first<{ value: string }>();

				if (existingRace) {
					const existingData = JSON.parse(existingRace.value);
					if (existingData.isOfficial || existingData.isLocked) {
						return jsonResponse({ error: 'Cuộc đua chính thức hôm nay đã hoàn thành và bị khóa, không thể chạy lại.' }, 403);
					}
				}

				// Nếu người dùng không phải admin (ID !== 1)
				if (existingRace && payload.id !== 1) {
					return jsonResponse({ error: 'Chỉ có Quản trị viên mới được phép tổ chức đua thử lại.' }, 403);
				}

				// Lấy danh sách những người đã đặt cơm ngày đó
				const { results: orderedUsers } = await env.DB.prepare(`
					SELECT DISTINCT u.id, u.name, u.avatar
					FROM orders o
					JOIN users u ON o.user_id = u.id
					WHERE o.date = ? AND u.active = 1
				`)
					.bind(dateParam)
					.all<{ id: number; name: string; avatar: string }>();

				if (orderedUsers.length === 0) {
					return jsonResponse({ error: 'Không có ai đặt cơm vào ngày này để đua.' }, 400);
				}

				// Lấy cấu hình giờ tự động và chủ đề đua
				const autoTimeRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_auto_time'").first<{ value: string }>();
				const autoEnabledRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_auto_enabled'").first<{ value: string }>();
				const themeRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lunch_race_theme'").first<{ value: string }>();
				const autoRaceTime = autoTimeRow?.value || '11:30';
				const autoRaceEnabled = autoEnabledRow?.value !== '0';
				const configuredTheme = themeRow?.value || 'duck';
				const activeTheme = resolveRaceTheme(configuredTheme, dateParam);
				const todayStr = getVNDateString();
				const currentVNTime = getVNTimeString();

				// Nếu chạy thủ công đúng/sau giờ setup tự động -> Trở thành trận chính thức khóa luôn
				const isOfficial = dateParam === todayStr && autoRaceEnabled && currentVNTime >= autoRaceTime;

				// Thời gian đua 15 giây (+ 4.0 giây đếm ngược để tất cả các client kịp sync)
				const countdownMs = 4000;
				const durationMs = 15000;
				const now = Date.now();
				const startTime = now + countdownMs;
				const seed = Math.floor(Math.random() * 1000000000);

				const totalParticipants = orderedUsers.length;
				const ranks = Array.from({ length: totalParticipants }, (_, i) => i + 1).sort(() => Math.random() - 0.5);

				const ducks = orderedUsers.map((u, index) => ({
					id: u.id,
					name: u.name,
					avatar: u.avatar || '🦆',
					lane: index,
					finishRank: ranks[index],
					duckSeed: (seed + (u.id * 31 + index * 17) * 7919) % 1000000
				}));

				const sortedDucksByRank = [...ducks].sort((a, b) => b.finishRank - a.finishRank);
				let losers: { id: number; name: string; avatar: string }[] = [];
				if (totalParticipants === 1) {
					losers = [{ id: sortedDucksByRank[0].id, name: sortedDucksByRank[0].name, avatar: sortedDucksByRank[0].avatar }];
				} else {
					losers = [
						{ id: sortedDucksByRank[1].id, name: sortedDucksByRank[1].name, avatar: sortedDucksByRank[1].avatar },
						{ id: sortedDucksByRank[0].id, name: sortedDucksByRank[0].name, avatar: sortedDucksByRank[0].avatar }
					];
				}

				const raceData = {
					raceId: `${isOfficial ? 'official_race' : 'race'}_${now}`,
					date: dateParam,
					theme: activeTheme,
					seed,
					startTime,
					durationMs,
					countdownMs,
					totalDucks: totalParticipants,
					ducks,
					losers,
					isOfficial,
					isLocked: isOfficial,
					autoTriggered: false
				};

				// Lưu race và pickers vào DB
				await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(raceKey, JSON.stringify(raceData))
					.run();

				await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(pickersKey, JSON.stringify(losers))
					.run();

				// Khi vừa xuất phát, ẩn kết quả pickers và losers để người xem không bị biết trước
				return jsonResponse({
					serverTime: now,
					race: {
						...raceData,
						losers: []
					},
					pickers: [],
					isRacing: true
				});
			}

			// POST /api/lunch-race/reset
			if (pathname === '/api/lunch-race/reset' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				if (payload.id !== 1) {
					return jsonResponse({ error: 'Chỉ có Quản trị viên mới được phép hủy kết quả đua.' }, 403);
				}

				const body = await request.json() as { date?: string };
				const dateParam = body.date?.trim() || getVNDateString();
				const raceKey = `lunch_race_${dateParam}`;
				const pickersKey = `lunch_pickers_${dateParam}`;

				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const existingRace = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(raceKey)
					.first<{ value: string }>();

				if (existingRace) {
					const existingData = JSON.parse(existingRace.value);
					if (existingData.isOfficial || existingData.isLocked) {
						return jsonResponse({ error: 'Kết quả cuộc đua chính thức đã được chốt và khóa, không thể hủy.' }, 403);
					}
				}

				await env.DB.prepare('DELETE FROM settings WHERE key IN (?, ?)')
					.bind(raceKey, pickersKey)
					.run();

				return jsonResponse({ success: true, message: 'Đã hủy kết quả đua vịt.' });
			}

			// POST /api/lunch-pickers (giữ tương thích)
			if (pathname === '/api/lunch-pickers' && method === 'POST') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				const body = await request.json() as { date?: string };
				const dateParam = body.date?.trim() || getVNDateString();
				const key = `lunch_pickers_${dateParam}`;

				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				const existing = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
					.bind(key)
					.first<{ value: string }>();

				if (existing && payload.id !== 1) {
					return jsonResponse({ error: 'Chỉ có Quản trị viên mới được phép quay số chọn lại.' }, 403);
				}

				const { results: orderedUsers } = await env.DB.prepare(`
					SELECT DISTINCT u.id, u.name, u.avatar
					FROM orders o
					JOIN users u ON o.user_id = u.id
					WHERE o.date = ? AND u.active = 1
				`)
					.bind(dateParam)
					.all<{ id: number; name: string; avatar: string }>();

				if (orderedUsers.length === 0) {
					return jsonResponse({ error: 'Không có ai đặt cơm vào ngày này để chọn.' }, 400);
				}

				let picked: { id: number; name: string; avatar: string }[] = [];

				if (orderedUsers.length === 1) {
					picked = [orderedUsers[0]];
				} else {
					// Lấy danh sách những người đã đi lấy cơm trong tuần này (trừ ngày hiện tại đang quay)
					const { mondayStr, sundayStr } = getWeekDateRange(dateParam);
					const startKey = `lunch_pickers_${mondayStr}`;
					const endKey = `lunch_pickers_${sundayStr}`;

					const { results: weekPickersSettings } = await env.DB.prepare(`
						SELECT key, value FROM settings
						WHERE key >= ? AND key <= ? AND key != ?
					`)
						.bind(startKey, endKey, key)
						.all<{ key: string; value: string }>();

					// Đếm số lần mỗi người dùng đã đi lấy cơm trong tuần
					const timesPickedThisWeek = new Map<number, number>();
					if (weekPickersSettings && weekPickersSettings.length > 0) {
						for (const row of weekPickersSettings) {
							try {
								const pickers = JSON.parse(row.value) as { id: number; name: string; avatar: string }[];
								if (Array.isArray(pickers)) {
									for (const p of pickers) {
										if (p && typeof p.id === 'number') {
											timesPickedThisWeek.set(p.id, (timesPickedThisWeek.get(p.id) || 0) + 1);
										}
									}
								}
							} catch {
								// Bỏ qua nếu dữ liệu không đúng chuẩn JSON
							}
						}
					}

					// Nhóm người đặt cơm theo số lần đã đi trong tuần (0 lần -> 1 lần -> 2 lần...)
					const grouped = new Map<number, typeof orderedUsers>();
					for (const user of orderedUsers) {
						const count = timesPickedThisWeek.get(user.id) || 0;
						if (!grouped.has(count)) {
							grouped.set(count, []);
						}
						grouped.get(count)!.push(user);
					}

					// Ưu tiên chọn những người có số lần đi ít nhất (0 lần ưu tiên trước)
					const sortedCounts = Array.from(grouped.keys()).sort((a, b) => a - b);
					const prioritizedUsers: typeof orderedUsers = [];
					for (const count of sortedCounts) {
						const group = grouped.get(count)!;
						const shuffledGroup = [...group].sort(() => Math.random() - 0.5);
						prioritizedUsers.push(...shuffledGroup);
					}

					picked = prioritizedUsers.slice(0, 2);
				}

				const valueStr = JSON.stringify(picked);
				await env.DB.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value'
				)
					.bind(key, valueStr)
					.run();

				// Reward Shipper bounty for each picked user
				for (const loser of picked) {
					const existingBounty = await env.DB.prepare(
						'SELECT id FROM coin_transactions WHERE user_id = ? AND reason = "SHIPPER_BOUNTY" AND metadata LIKE ?'
					)
						.bind(loser.id, `%${dateParam}%`)
						.first();
					if (!existingBounty) {
						await env.DB.prepare('UPDATE users SET balance = COALESCE(balance, 100000) + 30000 WHERE id = ?')
							.bind(loser.id)
							.run();
						const uRow = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(loser.id).first<{ balance: number }>();
						await env.DB.prepare(
							'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
						)
							.bind(loser.id, 30000, uRow?.balance || 100000, 'SHIPPER_BOUNTY', JSON.stringify({ date: dateParam }))
							.run();
					}
				}

				return jsonResponse({ pickers: picked });
			}

			// DELETE /api/lunch-pickers?date=YYYY-MM-DD
			if (pathname === '/api/lunch-pickers' && method === 'DELETE') {
				const cookieVal = getCookie(request, 'session');
				if (!cookieVal) {
					return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
				}

				const secret = env.JWT_SECRET || 'comtrua-fallback-secret-key-123456';
				const payload = await verifyJwt(cookieVal, secret);
				if (!payload || !payload.id) {
					return jsonResponse({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ.' }, 401);
				}

				if (payload.id !== 1) {
					return jsonResponse({ error: 'Chỉ có Quản trị viên mới được phép hủy kết quả chọn.' }, 403);
				}

				const dateParam = url.searchParams.get('date') || getVNDateString();
				const key = `lunch_pickers_${dateParam}`;
				const raceKey = `lunch_race_${dateParam}`;

				await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
				await env.DB.prepare('DELETE FROM settings WHERE key = ? OR key = ?')
					.bind(key, raceKey)
					.run();

				return jsonResponse({ success: true, message: 'Đã xóa danh sách người đi lấy cơm.' });
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
						u.avatar_frame,
						u.custom_title,
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

				// Lấy thông tin đơn cũ nếu có (để tính chênh lệch tiền cashback)
				const oldOrder = await env.DB.prepare('SELECT dish_price FROM orders WHERE date = ? AND user_id = ?')
					.bind(dateParam, userId)
					.first<{ dish_price: number }>();
				const oldPrice = oldOrder ? oldOrder.dish_price : 0;
				const priceDiff = finalPrice - oldPrice;

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

				// Tự động cộng/điều chỉnh số dư ví theo giá trị đơn đặt cơm
				if (priceDiff !== 0) {
					await env.DB.prepare('UPDATE users SET balance = COALESCE(balance, 100000) + ? WHERE id = ?')
						.bind(priceDiff, userId)
						.run();

					const uRow = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first<{ balance: number }>();
					await env.DB.prepare(
						'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
					)
						.bind(userId, priceDiff, uRow?.balance || 100000, oldOrder ? 'ORDER_ADJUST' : 'ORDER_CASHBACK', JSON.stringify({ date: dateParam, dish_name: finalName, price: finalPrice }))
						.run();
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
					return jsonResponse({ error: 'Bạn không có quyền cập nhật thủ công trạng thái thanh toán cho đơn hàng này.' }, 403);
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
				const order = await env.DB.prepare('SELECT date, user_id, dish_price FROM orders WHERE id = ?')
					.bind(orderId)
					.first<{ date: string; user_id: number; dish_price: number }>();

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

				// Hoàn trả lại số tiền tích lũy của đơn bị hủy
				await env.DB.prepare('UPDATE users SET balance = MAX(0, COALESCE(balance, 100000) - ?) WHERE id = ?')
					.bind(order.dish_price, order.user_id)
					.run();

				const uRow = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(order.user_id).first<{ balance: number }>();
				await env.DB.prepare(
					'INSERT INTO coin_transactions (user_id, amount, balance_after, reason, metadata) VALUES (?, ?, ?, ?, ?)'
				)
					.bind(order.user_id, -order.dish_price, uRow?.balance || 0, 'ORDER_CANCEL', JSON.stringify({ order_id: orderId, price: order.dish_price }))
					.run();

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
					const checksumKey = env.PAYOS_CHECKSUM_KEY || 'ad30870d8b98cf51b5c031ad51d2ed6e0c2e8a89ca57542c87e9f1ad61669c35';
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
