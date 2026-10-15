const express = require('express');
const { query } = require('../lib/db');
const { httpError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/categories  (public) - with how many live products each has
router.get('/', async (req, res) => {
    const { recordset } = await query(
        `SELECT c.category_id, c.name, c.description,
                (SELECT COUNT(*) FROM vw_product_catalog pc WHERE pc.category_id = c.category_id) AS product_count
         FROM categories c ORDER BY c.name`);
    res.json(recordset);
});

// Admin only below
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) throw httpError(400, 'Category name is required.');
    await query('INSERT INTO categories (name, description) VALUES (@name, @description)',
        { name: name.trim(), description: description || null });
    res.status(201).json({ message: 'Category added.' });
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const inUse = await query('SELECT COUNT(*) AS n FROM products WHERE category_id = @id', { id: Number(req.params.id) });
    if (inUse.recordset[0].n > 0) throw httpError(409, 'This category still has products. Move or delete them first.');
    const r = await query('DELETE FROM categories WHERE category_id = @id', { id: Number(req.params.id) });
    if (!r.rowsAffected[0]) throw httpError(404, 'Category not found.');
    res.json({ message: 'Category deleted.' });
});

module.exports = router;
