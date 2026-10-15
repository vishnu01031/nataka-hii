// Vendor portal API - every query is scoped to the logged-in vendor (req.user.vendorId)
const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../lib/db');
const { httpError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const storage = require('../lib/storage');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) =>
        /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
            ? cb(null, true)
            : cb(Object.assign(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'), { status: 400 }))
});

router.use(requireAuth, requireRole('vendor'));

// Re-check the vendor is still approved on every request (admin may have changed it after login)
router.use(async (req, res, next) => {
    const { recordset } = await query(
        `SELECT v.approval_status, u.is_active FROM vendors v JOIN users u ON u.user_id = v.user_id
         WHERE v.vendor_id = @v`, { v: req.user.vendorId });
    if (!recordset.length || recordset[0].approval_status !== 'approved' || !recordset[0].is_active) {
        throw httpError(401, 'Your store is no longer approved. Contact the admin.');
    }
    next();
});

function readProduct(body = {}) {
    const p = {
        category_id: Number(body.category_id),
        name: (body.name || '').trim(),
        description: (body.description || '').trim(),
        price: Number(body.price),
        stock_quantity: Number(body.stock_quantity)
    };
    if (!p.name) throw httpError(400, 'Product name is required.');
    if (!Number.isInteger(p.category_id)) throw httpError(400, 'Choose a category.');
    if (!Number.isFinite(p.price) || p.price < 0) throw httpError(400, 'Enter a valid price.');
    if (!Number.isInteger(p.stock_quantity) || p.stock_quantity < 0) throw httpError(400, 'Enter a valid stock quantity.');
    return p;
}

// ---------------- PRODUCTS ----------------

// GET /api/vendor/products?search=
router.get('/products', async (req, res) => {
    const params = { v: req.user.vendorId };
    let filter = '';
    if (req.query.search) { filter = 'AND (p.name LIKE @s OR p.description LIKE @s)'; params.s = `%${req.query.search}%`; }
    const { recordset } = await query(
        `SELECT p.product_id, p.name, p.description, p.price, p.stock_quantity, p.category_id,
                c.name AS category_name,
                (SELECT TOP 1 image_url FROM product_images pi WHERE pi.product_id = p.product_id
                  ORDER BY is_primary DESC, image_id) AS image_url,
                (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.product_id) AS image_count
         FROM products p
         JOIN categories c ON c.category_id = p.category_id
         WHERE p.vendor_id = @v AND p.is_active = 1 ${filter}
         ORDER BY p.updated_at DESC`, params);
    res.json(recordset);
});

// GET /api/vendor/products/:id
router.get('/products/:id', async (req, res) => {
    const { recordset } = await query(
        'SELECT * FROM products WHERE product_id = @id AND vendor_id = @v AND is_active = 1',
        { id: Number(req.params.id), v: req.user.vendorId });
    if (!recordset.length) throw httpError(404, 'Product not found.');
    const images = await query(
        'SELECT image_id, image_url, is_primary FROM product_images WHERE product_id = @id ORDER BY is_primary DESC, image_id',
        { id: recordset[0].product_id });
    res.json({ ...recordset[0], images: images.recordset });
});

// POST /api/vendor/products  multipart/form-data, images[] (up to 5, first = cover)
router.post('/products', upload.array('images', 5), async (req, res) => {
    const p = readProduct(req.body);
    const urls = [];
    for (const f of req.files || []) urls.push(await storage.saveImage(f));

    try {
        const id = await withTransaction(async tx => {
            const r = await query(
                `INSERT INTO products (vendor_id, category_id, name, description, price, stock_quantity)
                 VALUES (@v, @category_id, @name, @description, @price, @stock_quantity);
                 SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
                { v: req.user.vendorId, ...p }, tx);
            const productId = r.recordset[0].id;
            for (let i = 0; i < urls.length; i++) {
                await query('INSERT INTO product_images (product_id, image_url, is_primary) VALUES (@pid, @url, @primary)',
                    { pid: productId, url: urls[i], primary: i === 0 }, tx);
            }
            return productId;
        });
        res.status(201).json({ product_id: id, message: 'Product added.' });
    } catch (err) {
        for (const u of urls) await storage.deleteImage(u); // don't leave orphan files
        throw err;
    }
});

// PUT /api/vendor/products/:id  - uploading new images REPLACES the old ones
router.put('/products/:id', upload.array('images', 5), async (req, res) => {
    const id = Number(req.params.id);
    const p = readProduct(req.body);
    const owned = await query('SELECT 1 FROM products WHERE product_id = @id AND vendor_id = @v AND is_active = 1',
        { id, v: req.user.vendorId });
    if (!owned.recordset.length) throw httpError(404, 'Product not found.');

    const newUrls = [];
    for (const f of req.files || []) newUrls.push(await storage.saveImage(f));

    let oldUrls = [];
    try {
        await withTransaction(async tx => {
            await query(
                `UPDATE products SET category_id = @category_id, name = @name, description = @description,
                        price = @price, stock_quantity = @stock_quantity
                 WHERE product_id = @id AND vendor_id = @v`,
                { id, v: req.user.vendorId, ...p }, tx);
            if (newUrls.length) {
                const old = await query('SELECT image_url FROM product_images WHERE product_id = @id', { id }, tx);
                oldUrls = old.recordset.map(r => r.image_url);
                await query('DELETE FROM product_images WHERE product_id = @id', { id }, tx);
                for (let i = 0; i < newUrls.length; i++) {
                    await query('INSERT INTO product_images (product_id, image_url, is_primary) VALUES (@id, @url, @primary)',
                        { id, url: newUrls[i], primary: i === 0 }, tx);
                }
            }
        });
    } catch (err) {
        for (const u of newUrls) await storage.deleteImage(u);
        throw err;
    }
    for (const u of oldUrls) await storage.deleteImage(u);
    res.json({ message: 'Product updated.' });
});

// DELETE /api/vendor/products/:id
// If the product was ever ordered, order history must keep pointing at it, so it is
// SOFT-deleted (is_active = 0). Otherwise it is removed completely.
router.delete('/products/:id', async (req, res) => {
    const id = Number(req.params.id);
    const v = req.user.vendorId;
    const owned = await query('SELECT 1 FROM products WHERE product_id = @id AND vendor_id = @v AND is_active = 1', { id, v });
    if (!owned.recordset.length) throw httpError(404, 'Product not found.');

    const ordered = (await query('SELECT COUNT(*) AS n FROM order_items WHERE product_id = @id', { id })).recordset[0].n > 0;
    let images = [];
    await withTransaction(async tx => {
        await query('DELETE FROM cart_items WHERE product_id = @id', { id }, tx);
        if (ordered) {
            await query('UPDATE products SET is_active = 0 WHERE product_id = @id AND vendor_id = @v', { id, v }, tx);
        } else {
            images = (await query('SELECT image_url FROM product_images WHERE product_id = @id', { id }, tx)).recordset;
            await query('DELETE FROM products WHERE product_id = @id AND vendor_id = @v', { id, v }, tx); // images cascade
        }
    });
    for (const img of images) await storage.deleteImage(img.image_url);
    res.json({ message: ordered ? 'Product removed from the store (kept for order history).' : 'Product deleted.' });
});

// ---------------- ORDERS ----------------

// GET /api/vendor/orders  -> orders containing this vendor's items, with only THIS vendor's lines
router.get('/orders', async (req, res) => {
    const { recordset } = await query(
        `SELECT o.order_id, o.order_date, u.name AS customer_name,
                a.full_name, a.phone, a.address_line1, a.address_line2, a.city, a.state, a.postal_code,
                oi.order_item_id, oi.quantity, oi.unit_price, oi.subtotal, oi.item_status,
                p.product_id, p.name AS product_name,
                s.courier_name, s.tracking_number, s.shipped_date, s.delivered_date
         FROM order_items oi
         JOIN products p  ON p.product_id = oi.product_id
         JOIN orders o    ON o.order_id = oi.order_id
         JOIN users u     ON u.user_id = o.user_id
         JOIN addresses a ON a.address_id = o.address_id
         LEFT JOIN shipments s ON s.order_id = o.order_id AND s.vendor_id = p.vendor_id
         WHERE p.vendor_id = @v
         ORDER BY o.order_date DESC, oi.order_item_id`, { v: req.user.vendorId });

    const orders = new Map();
    for (const r of recordset) {
        if (!orders.has(r.order_id)) {
            orders.set(r.order_id, {
                order_id: r.order_id, order_date: r.order_date, customer_name: r.customer_name,
                address: [r.full_name, r.phone, r.address_line1, r.address_line2, r.city, r.state, r.postal_code].filter(Boolean).join(', '),
                shipment: r.courier_name ? { courier_name: r.courier_name, tracking_number: r.tracking_number,
                    shipped_date: r.shipped_date, delivered_date: r.delivered_date } : null,
                items: [], vendor_total: 0
            });
        }
        const o = orders.get(r.order_id);
        o.items.push({ order_item_id: r.order_item_id, product_name: r.product_name, quantity: r.quantity,
            unit_price: r.unit_price, subtotal: r.subtotal, item_status: r.item_status });
        o.vendor_total += Number(r.subtotal);
    }
    for (const o of orders.values()) {
        const statuses = new Set(o.items.map(i => i.item_status));
        o.status = statuses.has('pending') ? 'pending' : statuses.has('shipped') ? 'shipped' : 'delivered';
    }
    res.json([...orders.values()]);
});

// POST /api/vendor/orders/:orderId/ship  { courier_name, tracking_number }
// TRANSACTION: create the shipment row AND mark this vendor's items as shipped
router.post('/orders/:orderId/ship', async (req, res) => {
    const orderId = Number(req.params.orderId);
    const { courier_name, tracking_number } = req.body || {};
    if (!courier_name || !tracking_number) throw httpError(400, 'Courier name and tracking number are required.');

    await withTransaction(async tx => {
        const upd = await query(
            `UPDATE oi SET item_status = 'shipped'
             FROM order_items oi JOIN products p ON p.product_id = oi.product_id
             WHERE oi.order_id = @o AND p.vendor_id = @v AND oi.item_status = 'pending'`,
            { o: orderId, v: req.user.vendorId }, tx);
        if (!upd.rowsAffected[0]) throw httpError(400, 'Nothing to ship in this order.');
        await query(
            `INSERT INTO shipments (order_id, vendor_id, courier_name, tracking_number)
             VALUES (@o, @v, @courier_name, @tracking_number)`,
            { o: orderId, v: req.user.vendorId, courier_name, tracking_number }, tx);
    });
    res.json({ message: 'Marked as shipped.' });
});

// POST /api/vendor/orders/:orderId/deliver
router.post('/orders/:orderId/deliver', async (req, res) => {
    const orderId = Number(req.params.orderId);
    await withTransaction(async tx => {
        const upd = await query(
            `UPDATE oi SET item_status = 'delivered'
             FROM order_items oi JOIN products p ON p.product_id = oi.product_id
             WHERE oi.order_id = @o AND p.vendor_id = @v AND oi.item_status = 'shipped'`,
            { o: orderId, v: req.user.vendorId }, tx);
        if (!upd.rowsAffected[0]) throw httpError(400, 'Nothing in this order is waiting for delivery.');
        await query('UPDATE shipments SET delivered_date = SYSUTCDATETIME() WHERE order_id = @o AND vendor_id = @v',
            { o: orderId, v: req.user.vendorId }, tx);
        // Cash on delivery: once every item of the order is delivered, the payment is collected
        await query(
            `UPDATE payments SET payment_status = 'success', payment_date = SYSUTCDATETIME()
             WHERE order_id = @o AND payment_method = 'COD' AND payment_status = 'pending'
               AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @o AND item_status NOT IN ('delivered', 'cancelled'))`,
            { o: orderId }, tx);
    });
    res.json({ message: 'Marked as delivered.' });
});

// ---------------- SALES REPORT (stored procedure) ----------------

// GET /api/vendor/stats
router.get('/stats', async (req, res) => {
    const r = await query('EXEC sp_vendor_sales_report @vendor_id = @v', { v: req.user.vendorId });
    const [summary, topProducts, lowStock] = r.recordsets;
    res.json({ summary: summary[0], top_products: topProducts, low_stock: lowStock });
});

module.exports = router;
