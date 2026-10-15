// Customer API: cart, addresses, checkout, orders, reviews
const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../lib/db');
const { httpError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('customer'));

// ---------------- CART ----------------

// GET /api/customer/cart
router.get('/cart', async (req, res) => {
    const { recordset } = await query(
        `SELECT ci.product_id, ci.quantity, pc.name, pc.price, pc.stock_quantity, pc.image_url,
                pc.business_name, (ci.quantity * pc.price) AS line_total
         FROM cart_items ci
         JOIN vw_product_catalog pc ON pc.product_id = ci.product_id
         WHERE ci.user_id = @u
         ORDER BY ci.added_at`, { u: req.user.userId });
    const total = recordset.reduce((sum, r) => sum + Number(r.line_total), 0);
    res.json({ items: recordset, total });
});

// POST /api/customer/cart  { product_id, quantity }  - adds to the existing quantity (MERGE = upsert)
router.post('/cart', async (req, res) => {
    const productId = Number(req.body?.product_id);
    const qty = Number(req.body?.quantity || 1);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'Quantity must be at least 1.');

    const p = await query('SELECT stock_quantity FROM vw_product_catalog WHERE product_id = @id', { id: productId });
    if (!p.recordset.length) throw httpError(404, 'This product is not available.');
    const inCart = await query('SELECT quantity FROM cart_items WHERE user_id = @u AND product_id = @p',
        { u: req.user.userId, p: productId });
    const newQty = qty + (inCart.recordset[0]?.quantity || 0);
    if (newQty > p.recordset[0].stock_quantity) throw httpError(409, `Only ${p.recordset[0].stock_quantity} in stock.`);

    await query(
        `MERGE cart_items AS target
         USING (SELECT @u AS user_id, @p AS product_id) AS src
            ON target.user_id = src.user_id AND target.product_id = src.product_id
         WHEN MATCHED THEN UPDATE SET quantity = @q
         WHEN NOT MATCHED THEN INSERT (user_id, product_id, quantity) VALUES (@u, @p, @q);`,
        { u: req.user.userId, p: productId, q: newQty });
    res.json({ message: 'Added to cart.' });
});

// PUT /api/customer/cart/:productId  { quantity }
router.put('/cart/:productId', async (req, res) => {
    const qty = Number(req.body?.quantity);
    const productId = Number(req.params.productId);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'Quantity must be at least 1.');
    const p = await query('SELECT stock_quantity FROM products WHERE product_id = @id', { id: productId });
    if (p.recordset.length && qty > p.recordset[0].stock_quantity) throw httpError(409, `Only ${p.recordset[0].stock_quantity} in stock.`);
    await query('UPDATE cart_items SET quantity = @q WHERE user_id = @u AND product_id = @p',
        { q: qty, u: req.user.userId, p: productId });
    res.json({ message: 'Cart updated.' });
});

// DELETE /api/customer/cart/:productId
router.delete('/cart/:productId', async (req, res) => {
    await query('DELETE FROM cart_items WHERE user_id = @u AND product_id = @p',
        { u: req.user.userId, p: Number(req.params.productId) });
    res.json({ message: 'Removed from cart.' });
});

// ---------------- ADDRESSES ----------------

router.get('/addresses', async (req, res) => {
    const { recordset } = await query(
        'SELECT * FROM addresses WHERE user_id = @u ORDER BY is_default DESC, address_id DESC', { u: req.user.userId });
    res.json(recordset);
});

router.post('/addresses', async (req, res) => {
    const a = req.body || {};
    for (const f of ['full_name', 'phone', 'address_line1', 'city', 'state', 'postal_code']) {
        if (!a[f] || !String(a[f]).trim()) throw httpError(400, 'Fill in name, phone, address, city, state and PIN code.');
    }
    if (!/^\d{6}$/.test(a.postal_code)) throw httpError(400, 'PIN code must be 6 digits.');
    const r = await query(
        `INSERT INTO addresses (user_id, full_name, phone, address_line1, address_line2, city, state, postal_code, is_default)
         VALUES (@u, @full_name, @phone, @address_line1, @address_line2, @city, @state, @postal_code,
                 CASE WHEN EXISTS (SELECT 1 FROM addresses WHERE user_id = @u) THEN 0 ELSE 1 END);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { u: req.user.userId, full_name: a.full_name, phone: a.phone, address_line1: a.address_line1,
          address_line2: a.address_line2 || null, city: a.city, state: a.state, postal_code: a.postal_code });
    res.status(201).json({ address_id: r.recordset[0].id, message: 'Address saved.' });
});

// ---------------- CHECKOUT (the main TRANSACTION) ----------------
// POST /api/customer/checkout  { address_id, payment_method }
// All of these happen atomically - if ANY step fails, everything is rolled back:
//   1. read the cart   2. decrement stock for each item (fails if not enough stock)
//   3. create the order   4. copy cart lines into order_items with the current price
//   5. record the payment   6. empty the cart
router.post('/checkout', async (req, res) => {
    const addressId = Number(req.body?.address_id);
    const method = String(req.body?.payment_method || '').toUpperCase();
    if (!['UPI', 'CARD', 'NETBANKING', 'COD'].includes(method)) throw httpError(400, 'Choose a payment method.');
    const userId = req.user.userId;

    const orderId = await withTransaction(async tx => {
        const addr = await query('SELECT 1 FROM addresses WHERE address_id = @a AND user_id = @u', { a: addressId, u: userId }, tx);
        if (!addr.recordset.length) throw httpError(400, 'Choose a delivery address.');

        const cart = (await query(
            `SELECT ci.product_id, ci.quantity, p.name, p.price, p.is_active, v.approval_status
             FROM cart_items ci
             JOIN products p ON p.product_id = ci.product_id
             JOIN vendors v  ON v.vendor_id = p.vendor_id
             WHERE ci.user_id = @u`, { u: userId }, tx)).recordset;
        if (!cart.length) throw httpError(400, 'Your cart is empty.');
        const unavailable = cart.find(c => !c.is_active || c.approval_status !== 'approved');
        if (unavailable) throw httpError(409, `${unavailable.name} is no longer sold. Remove it from your cart.`);

        // Stock check + decrement in ONE statement: safe even if two customers check out at once
        for (const c of cart) {
            const r = await query(
                `UPDATE products SET stock_quantity = stock_quantity - @q
                 WHERE product_id = @p AND stock_quantity >= @q`, { q: c.quantity, p: c.product_id }, tx);
            if (!r.rowsAffected[0]) throw httpError(409, `Not enough stock for ${c.name}. Lower the quantity and try again.`);
        }

        const total = Math.round(cart.reduce((s, c) => s + c.quantity * Number(c.price), 0) * 100) / 100;
        const o = await query(
            `INSERT INTO orders (user_id, address_id, total_amount) VALUES (@u, @a, @total);
             SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`, { u: userId, a: addressId, total }, tx);
        const newOrderId = o.recordset[0].id;

        for (const c of cart) {
            await query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
                 VALUES (@o, @p, @q, @price)`, { o: newOrderId, p: c.product_id, q: c.quantity, price: c.price }, tx);
        }

        // Simulated payment gateway: online methods succeed immediately, COD is collected on delivery
        await query(
            `INSERT INTO payments (order_id, payment_method, transaction_id, amount, payment_status)
             VALUES (@o, @m, @txn, @amount, @status)`,
            { o: newOrderId, m: method, txn: `${method === 'COD' ? 'COD' : 'TXN'}-${crypto.randomUUID().slice(0, 13).toUpperCase()}`,
              amount: total, status: method === 'COD' ? 'pending' : 'success' }, tx);

        await query('DELETE FROM cart_items WHERE user_id = @u', { u: userId }, tx);
        return newOrderId;
    });

    res.status(201).json({ order_id: orderId, message: 'Order placed.' });
});

// ---------------- ORDERS ----------------

// GET /api/customer/orders
router.get('/orders', async (req, res) => {
    const { recordset } = await query(
        'SELECT * FROM vw_order_overview WHERE user_id = @u ORDER BY order_date DESC', { u: req.user.userId });
    res.json(recordset);
});

// GET /api/customer/orders/:id  -> items (grouped by vendor), shipments, payment, address
router.get('/orders/:id', async (req, res) => {
    const id = Number(req.params.id);
    const u = req.user.userId;
    const head = await query('SELECT * FROM vw_order_overview WHERE order_id = @id AND user_id = @u', { id, u });
    if (!head.recordset.length) throw httpError(404, 'Order not found.');

    const items = await query(
        `SELECT oi.order_item_id, oi.quantity, oi.unit_price, oi.subtotal, oi.item_status,
                p.product_id, p.name AS product_name, v.vendor_id, v.business_name,
                (SELECT TOP 1 image_url FROM product_images pi WHERE pi.product_id = p.product_id
                  ORDER BY is_primary DESC, image_id) AS image_url,
                r.rating, r.comment
         FROM order_items oi
         JOIN products p ON p.product_id = oi.product_id
         JOIN vendors v  ON v.vendor_id = p.vendor_id
         LEFT JOIN reviews r ON r.order_item_id = oi.order_item_id
         WHERE oi.order_id = @id
         ORDER BY v.business_name, oi.order_item_id`, { id });
    const shipments = await query(
        `SELECT s.vendor_id, s.courier_name, s.tracking_number, s.shipped_date, s.delivered_date
         FROM shipments s WHERE s.order_id = @id`, { id });
    const payments = await query('SELECT * FROM payments WHERE order_id = @id ORDER BY payment_id', { id });
    const address = await query(
        'SELECT a.* FROM addresses a JOIN orders o ON o.address_id = a.address_id WHERE o.order_id = @id', { id });

    res.json({ ...head.recordset[0], items: items.recordset, shipments: shipments.recordset,
        payments: payments.recordset, address: address.recordset[0] });
});

// ---------------- REVIEWS ----------------
// POST /api/customer/reviews  { order_item_id, rating, comment }
// Only for an item THIS customer bought and that has been delivered. One review per item (UNIQUE).
router.post('/reviews', async (req, res) => {
    const { order_item_id, rating, comment } = req.body || {};
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) throw httpError(400, 'Choose a rating from 1 to 5 stars.');

    const item = await query(
        `SELECT oi.item_status FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
         WHERE oi.order_item_id = @i AND o.user_id = @u`, { i: Number(order_item_id), u: req.user.userId });
    if (!item.recordset.length) throw httpError(404, 'You can only review products you bought.');
    if (item.recordset[0].item_status !== 'delivered') throw httpError(400, 'You can review this once it is delivered.');

    await query('INSERT INTO reviews (order_item_id, rating, comment) VALUES (@i, @r, @c)',
        { i: Number(order_item_id), r, c: comment ? String(comment).slice(0, 1000) : null });
    res.status(201).json({ message: 'Thanks for your review.' });
});

module.exports = router;
