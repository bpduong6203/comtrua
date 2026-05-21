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
			// 2. API MÓN ĂN (DISHES)
			// ==========================================

			// Lấy thực đơn (danh sách món ăn đang bán)
			// GET /api/dishes
			if (pathname === '/api/dishes' && method === 'GET') {
				const { results } = await env.DB.prepare('SELECT * FROM dishes WHERE active = 1 ORDER BY price ASC').all();
				return jsonResponse(results);
			}

			// Thêm món ăn mới (hoặc cập nhật nếu trùng tên)
			// POST /api/dishes
			if (pathname === '/api/dishes' && method === 'POST') {
				const body = await request.json() as { name?: string; price?: number };
				const name = body.name?.trim();
				const price = Number(body.price);

				if (!name || isNaN(price) || price <= 0) {
					return jsonResponse({ error: 'Tên món ăn và giá (lớn hơn 0) không hợp lệ.' }, 400);
				}

				// Thêm mới hoặc cập nhật nếu trùng tên (đưa active về 1)
				const result = await env.DB.prepare(
					'INSERT INTO dishes (name, price) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET price = EXCLUDED.price, active = 1'
				)
				.bind(name, price)
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
				const result = await env.DB.prepare('UPDATE dishes SET active = 0 WHERE id = ?')
					.bind(dishId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể ẩn món ăn.' }, 500);
				}

				return jsonResponse({ message: 'Đã ẩn món ăn thành công.' });
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
				const body = await request.json() as { name?: string; price?: number };
				const name = body.name?.trim();
				const price = Number(body.price);

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
				const result = await env.DB.prepare('UPDATE toppings SET active = 0 WHERE id = ?')
					.bind(toppingId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể ẩn món thêm.' }, 500);
				}

				return jsonResponse({ message: 'Đã ẩn món thêm thành công.' });
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
						o.dish_id, 
						o.dish_name, 
						o.dish_price, 
						o.paid, 
						o.created_at
					FROM orders o
					JOIN users u ON o.user_id = u.id
					WHERE o.date = ?
					ORDER BY o.created_at ASC`
				)
				.bind(dateParam)
				.all();

				return jsonResponse(results);
			}

			// Đặt cơm / Đổi món
			// POST /api/orders
			if (pathname === '/api/orders' && method === 'POST') {
				const body = await request.json() as { user_id?: number; dish_id?: number; date?: string; topping_ids?: number[] };
				const userId = Number(body.user_id);
				const dishId = Number(body.dish_id);
				const dateParam = body.date?.trim() || getVNDateString();
				const toppingIds = body.topping_ids || [];

				if (!userId || !dishId) {
					return jsonResponse({ error: 'Thiếu thông tin người dùng hoặc món ăn.' }, 400);
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
					`INSERT INTO orders (date, user_id, dish_id, dish_name, dish_price, paid)
					VALUES (?, ?, ?, ?, ?, 0)
					ON CONFLICT(date, user_id) DO UPDATE SET
						dish_id = EXCLUDED.dish_id,
						dish_name = EXCLUDED.dish_name,
						dish_price = EXCLUDED.dish_price,
						paid = 0,
						created_at = CURRENT_TIMESTAMP`
				)
				.bind(dateParam, userId, dishId, finalName, finalPrice)
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
				const body = await request.json() as { paid?: boolean | number };
				const paidValue = body.paid ? 1 : 0;

				const result = await env.DB.prepare('UPDATE orders SET paid = ? WHERE id = ?')
					.bind(paidValue, orderId)
					.run();

				if (!result.success) {
					return jsonResponse({ error: 'Không thể cập nhật trạng thái thanh toán.' }, 500);
				}

				return jsonResponse({ message: 'Cập nhật trạng thái thanh toán thành công' });
			}

			// Hủy đặt cơm
			// DELETE /api/orders/:id
			const orderDeleteMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
			if (orderDeleteMatch && method === 'DELETE') {
				const orderId = parseInt(orderDeleteMatch[1]);

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
