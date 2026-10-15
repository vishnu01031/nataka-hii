const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../lib/db');
const { httpError } = require('../lib/errors');
const { requireAuth, signToken } = require('../middleware/auth');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/signup  { name, email, password, role: 'customer'|'vendor', business_name? }
// Vendors start as 'pending' until an admin approves them.
router.post('/signup', async (req, res) => {
    const { name, email, password, role = 'customer', business_name } = req.body || {};
    if (!name || !email || !password) throw httpError(400, 'Name, email and password are required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters.');
    if (!['customer', 'vendor'].includes(role)) throw httpError(400, 'Choose customer or vendor.');
    if (role === 'vendor' && !business_name) throw httpError(400, 'Business name is required for vendors.');

    const existing = await query('SELECT 1 FROM users WHERE email = @email', { email });
    if (existing.recordset.length) throw httpError(409, 'An account with this email already exists.');

    const passwordHash = await bcrypt.hash(password, 10);

    // TRANSACTION: users row + vendors row are created together or not at all
    await withTransaction(async tx => {
        const u = await query(
            `INSERT INTO users (name, email, password_hash, role) VALUES (@name, @email, @hash, @role);
             SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
            { name, email, hash: passwordHash, role }, tx);
        if (role === 'vendor') {
            await query(`INSERT INTO vendors (user_id, business_name) VALUES (@uid, @business_name)`,
                { uid: u.recordset[0].id, business_name }, tx);
        }
    });

    res.status(201).json({
        message: role === 'vendor'
            ? 'Store created. An admin needs to approve it before you can log in.'
            : 'Account created. You can log in now.'
    });
});

// POST /api/auth/login  { email, password } -> { token, user }
router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'Email and password are required.');

    const { recordset } = await query(
        `SELECT u.user_id, u.name, u.email, u.password_hash, u.role, u.is_active,
                v.vendor_id, v.business_name, v.approval_status
         FROM users u
         LEFT JOIN vendors v ON v.user_id = u.user_id
         WHERE u.email = @email`, { email });
    const u = recordset[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) throw httpError(401, 'Wrong email or password.');
    if (!u.is_active) throw httpError(403, 'This account has been deactivated by an admin.');
    if (u.role === 'vendor' && u.approval_status !== 'approved') {
        throw httpError(403, u.approval_status === 'pending'
            ? 'Your store is waiting for admin approval.'
            : 'Your store application was rejected. Contact the admin.');
    }

    const payload = { userId: u.user_id, role: u.role, name: u.name };
    if (u.role === 'vendor') Object.assign(payload, { vendorId: u.vendor_id, businessName: u.business_name });

    res.json({ token: signToken(payload), user: { ...payload, email: u.email } });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => res.json(req.user));

module.exports = router;
