// Admin API
const express = require('express');
const { query } = require('../lib/db');
const { httpError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
    const { recordset } = await query(
        `SELECT
            (SELECT COUNT(*) FROM users WHERE role = 'customer')                  AS customers,
            (SELECT COUNT(*) FROM vendors WHERE approval_status = 'approved')     AS vendors,
            (SELECT COUNT(*) FROM vendors WHERE approval_status = 'pending')      AS pending_vendors,
            (SELECT COUNT(*) FROM vw_product_catalog)                             AS live_products,
            (SELECT COUNT(*) FROM orders)                                         AS orders,
            (SELECT ISNULL(SUM(amount), 0) FROM payments WHERE payment_status = 'success') AS revenue`);
    const byCategory = await query(
        `SELECT c.name AS category, ISNULL(SUM(oi.subtotal), 0) AS revenue, ISNULL(SUM(oi.quantity), 0) AS units
         FROM categories c
         LEFT JOIN products p     ON p.category_id = c.category_id
         LEFT JOIN order_items oi ON oi.product_id = p.product_id AND oi.item_status <> 'cancelled'
         GROUP BY c.name ORDER BY revenue DESC`);
    const topVendors = await query(
        `SELECT TOP 5 v.business_name, SUM(oi.subtotal) AS revenue, COUNT(DISTINCT oi.order_id) AS orders
         FROM order_items oi
         JOIN products p ON p.product_id = oi.product_id
         JOIN vendors v  ON v.vendor_id = p.vendor_id
         WHERE oi.item_status <> 'cancelled'
         GROUP BY v.business_name
         HAVING SUM(oi.subtotal) > 0
         ORDER BY revenue DESC`);
    res.json({ ...recordset[0], by_category: byCategory.recordset, top_vendors: topVendors.recordset });
});

// GET /api/admin/vendors
router.get('/vendors', async (req, res) => {
    const { recordset } = await query(
        `SELECT v.vendor_id, v.business_name, v.description, v.approval_status, v.created_at,
                u.user_id, u.name AS owner_name, u.email, u.is_active,
                (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.vendor_id AND p.is_active = 1) AS product_count
         FROM vendors v JOIN users u ON u.user_id = v.user_id
         ORDER BY CASE v.approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, v.created_at DESC`);
    res.json(recordset);
});

// PATCH /api/admin/vendors/:id  { approval_status: 'approved' | 'rejected' | 'pending' }
router.patch('/vendors/:id', async (req, res) => {
    const status = req.body?.approval_status;
    if (!['approved', 'rejected', 'pending'].includes(status)) throw httpError(400, 'Invalid status.');
    const r = await query('UPDATE vendors SET approval_status = @s WHERE vendor_id = @id',
        { s: status, id: Number(req.params.id) });
    if (!r.rowsAffected[0]) throw httpError(404, 'Vendor not found.');
    res.json({ message: `Vendor ${status}.` });
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
    const { recordset } = await query(
        `SELECT u.user_id, u.name, u.email, u.role, u.is_active, u.created_at,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.user_id) AS order_count
         FROM users u ORDER BY u.created_at DESC`);
    res.json(recordset);
});

// PATCH /api/admin/users/:id  { is_active: true|false }
router.patch('/users/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.userId) throw httpError(400, 'You cannot deactivate your own account.');
    const r = await query('UPDATE users SET is_active = @a WHERE user_id = @id', { a: !!req.body?.is_active, id });
    if (!r.rowsAffected[0]) throw httpError(404, 'User not found.');
    res.json({ message: req.body?.is_active ? 'Account activated.' : 'Account deactivated.' });
});

// GET /api/admin/orders
router.get('/orders', async (req, res) => {
    const { recordset } = await query('SELECT TOP 100 * FROM vw_order_overview ORDER BY order_date DESC');
    res.json(recordset);
});

module.exports = router;
