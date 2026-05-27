/**
 * Backend API for ComTrua (Lunch Ordering Project)
 * Built on Cloudflare Workers and D1 Database
 */

export interface Env {
	DB: D1Database;
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
			// 1. API NGƯỜI DÙNG (USERS)
			// ==========================================

			// Đăng nhập / Đăng ký không mật khẩu bằng Tên
			// POST /api/users/login
			if (pathname === '/api/users/login' && method === 'POST') {
				const body = await request.json() as { name?: string };
				const name = body.name?.trim();

				if (!name) {
					return jsonResponse({ error: 'Tên người dùng không được bỏ trống.' }, 400);
				}

				// Kiểm tra người dùng đã tồn tại chưa
				let user = await env.DB.prepare('SELECT * FROM users WHERE name = ?')
					.bind(name)
					.first<{ id: number; name: string; active: number }>();

				if (!user) {
					// Nếu chưa tồn tại, tự động tạo mới tài khoản
					const result = await env.DB.prepare('INSERT INTO users (name) VALUES (?)')
						.bind(name)
						.run();

					if (!result.success) {
						return jsonResponse({ error: 'Không thể tạo tài khoản người dùng.' }, 500);
					}

					user = await env.DB.prepare('SELECT * FROM users WHERE name = ?')
						.bind(name)
						.first<{ id: number; name: string; active: number }>();
				}

				if (user && user.active === 0) {
					return jsonResponse({ error: 'Tài khoản này đã bị khóa hoặc tạm ngưng hoạt động.' }, 403);
				}

				return jsonResponse({ message: 'Đăng nhập thành công', user });
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
				const body = await request.json() as { name?: string; phone?: string; avatar?: string; default_note?: string };
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

				const result = await env.DB.prepare('UPDATE users SET name = ?, phone = ?, avatar = ?, default_note = ? WHERE id = ?')
					.bind(newName, phone, avatar, defaultNote, userId)
					.run();

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

			// Lấy thực đơn (danh sách món ăn đang bán)
			// GET /api/dishes (hỗ trợ lọc theo ?shop_id=N)
			if (pathname === '/api/dishes' && method === 'GET') {
				const shopIdParam = url.searchParams.get('shop_id');
				if (shopIdParam) {
					const shopId = parseInt(shopIdParam);
					const { results } = await env.DB.prepare(
						'SELECT * FROM dishes WHERE active = 1 AND shop_id = ? ORDER BY price ASC'
					)
						.bind(shopId)
						.all();
					return jsonResponse(results);
				} else {
					const { results } = await env.DB.prepare('SELECT * FROM dishes WHERE active = 1 ORDER BY price ASC').all();
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
				const body = await request.json() as { name?: string; price?: number; shop_id?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const shopId = Number(body.shop_id);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}
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
			// GET /api/toppings
			if (pathname === '/api/toppings' && method === 'GET') {
				const { results } = await env.DB.prepare('SELECT * FROM toppings WHERE active = 1 ORDER BY price ASC').all();
				return jsonResponse(results);
			}

			// Thêm món thêm mới (hoặc cập nhật nếu trùng tên)
			// POST /api/toppings
			if (pathname === '/api/toppings' && method === 'POST') {
				const body = await request.json() as { name?: string; price?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}

				if (!name || isNaN(price) || price < 0) {
					return jsonResponse({ error: 'Tên món thêm và giá (lớn hơn hoặc bằng 0) không hợp lệ.' }, 400);
				}

				const result = await env.DB.prepare(
					'INSERT INTO toppings (name, price) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET price = EXCLUDED.price, active = 1'
				)
					.bind(name, price)
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
				const body = await request.json() as { name?: string; price?: number; caller_id?: number };
				const name = body.name?.trim();
				const price = Number(body.price);
				const callerId = Number(body.caller_id);

				if (callerId !== 1) {
					return jsonResponse({ error: 'Bạn không có quyền thực hiện thao tác này.' }, 403);
				}
				if (!name || isNaN(price) || price < 0) {
					return jsonResponse({ error: 'Thông tin món thêm không hợp lệ.' }, 400);
				}

				const result = await env.DB.prepare('UPDATE toppings SET name = ?, price = ? WHERE id = ?')
					.bind(name, price, toppingId)
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
						o.created_at
					FROM orders o
					JOIN users u ON o.user_id = u.id
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
				const toppingIds = body.topping_ids || [];
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
				const dish = await env.DB.prepare('SELECT name, price FROM dishes WHERE id = ? AND active = 1')
					.bind(dishId)
					.first<{ name: string; price: number }>();

				if (!dish) {
					return jsonResponse({ error: 'Món ăn không tồn tại hoặc đã ngừng bán.' }, 404);
				}

				let finalName = dish.name;
				let finalPrice = dish.price;

				if (toppingIds.length > 0) {
					const placeholders = toppingIds.map(() => '?').join(',');
					const { results: toppings } = await env.DB.prepare(
						`SELECT name, price FROM toppings WHERE id IN (${placeholders}) AND active = 1`
					)
						.bind(...toppingIds)
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

			// Đường dẫn không hợp lệ
			return jsonResponse({ error: 'Không tìm thấy API tương ứng.' }, 404);

		} catch (error: any) {
			return jsonResponse({ error: error.message || 'Lỗi hệ thống.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
