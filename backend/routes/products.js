// Public catalogue (no login needed to browse)
const express = require('express');
const { query } = require('../lib/db');
const { httpError } = require('../lib/errors');

const router = express.Router();

// GET /api/products?search=&category=&sort=new|price_asc|price_desc|rating
router.get('/', async (req, res) => {
    const { search, category, sort } = req.query;
    const where = [];
    const params = {};
    if (search) { where.push('(name LIKE @s OR description LIKE @s OR business_name LIKE @s)'); params.s = `%${search}%`; }
    if (category) { where.push('category_id = @category'); params.category = Number(category); }
    const orderBy = {
        price_asc: 'price ASC',
        price_desc: 'price DESC',
        rating: 'ISNULL(avg_rating, 0) DESC, review_count DESC'
    }[sort] || 'created_at DESC';

    const { recordset } = await query(
        `SELECT * FROM vw_product_catalog
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ${orderBy}`, params);
    res.json(recordset);
});

// GET /api/products/:id  -> product + all images + reviews
router.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const product = await query('SELECT * FROM vw_product_catalog WHERE product_id = @id', { id });
    if (!product.recordset.length) throw httpError(404, 'This product is not available.');

    const images = await query(
        'SELECT image_id, image_url, is_primary FROM product_images WHERE product_id = @id ORDER BY is_primary DESC, image_id',
        { id });
    const reviews = await query(
        `SELECT r.review_id, r.rating, r.comment, r.created_at, u.name AS reviewer
         FROM reviews r
         JOIN order_items oi ON oi.order_item_id = r.order_item_id
         JOIN orders o       ON o.order_id = oi.order_id
         JOIN users u        ON u.user_id = o.user_id
         WHERE oi.product_id = @id
         ORDER BY r.created_at DESC`, { id });

    res.json({ ...product.recordset[0], images: images.recordset, reviews: reviews.recordset });
});

module.exports = router;
