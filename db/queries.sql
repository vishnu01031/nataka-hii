/* =====================================================================
   Demo queries for the DBMS viva - run in Azure portal > SQL database > Query editor
   (or Azure Data Studio / VS Code mssql extension)
   ===================================================================== */

-- 1. INNER JOIN (4 tables): every product with its store and category
SELECT p.product_id, p.name, v.business_name, c.name AS category, p.price, p.stock_quantity
FROM products p
JOIN vendors v    ON v.vendor_id = p.vendor_id
JOIN categories c ON c.category_id = p.category_id
JOIN users u      ON u.user_id = v.user_id
WHERE p.is_active = 1
ORDER BY v.business_name, p.name;

-- 2. LEFT JOIN + GROUP BY: product count per category (including empty categories)
SELECT c.name AS category, COUNT(p.product_id) AS products
FROM categories c
LEFT JOIN products p ON p.category_id = c.category_id AND p.is_active = 1
GROUP BY c.name
ORDER BY products DESC;

-- 3. Aggregates + HAVING: stores that have earned more than 2000
SELECT v.business_name, COUNT(DISTINCT oi.order_id) AS orders, SUM(oi.quantity) AS units, SUM(oi.subtotal) AS revenue
FROM order_items oi
JOIN products p ON p.product_id = oi.product_id
JOIN vendors v  ON v.vendor_id = p.vendor_id
WHERE oi.item_status <> 'cancelled'
GROUP BY v.business_name
HAVING SUM(oi.subtotal) > 2000
ORDER BY revenue DESC;

-- 4. Subquery: products priced above the average price of their own category (correlated)
SELECT p.name, c.name AS category, p.price
FROM products p
JOIN categories c ON c.category_id = p.category_id
WHERE p.price > (SELECT AVG(p2.price) FROM products p2 WHERE p2.category_id = p.category_id);

-- 5. NOT EXISTS: customers who have never placed an order
SELECT u.name, u.email
FROM users u
WHERE u.role = 'customer'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.user_id);

-- 6. VIEW: the public catalogue (approved stores only) with average rating
SELECT name, business_name, price, avg_rating, review_count FROM vw_product_catalog ORDER BY avg_rating DESC;

-- 7. VIEW: order status derived from the status of each item (multi-vendor)
SELECT order_id, customer_name, order_status, payment_method, payment_status, total_amount FROM vw_order_overview;

-- 8. STORED PROCEDURE: sales report for vendor 1 (returns 3 result sets)
EXEC sp_vendor_sales_report @vendor_id = 1;

-- 9. Window function: rank each store's products by revenue
SELECT v.business_name, p.name, SUM(oi.subtotal) AS revenue,
       RANK() OVER (PARTITION BY v.vendor_id ORDER BY SUM(oi.subtotal) DESC) AS rank_in_store
FROM order_items oi
JOIN products p ON p.product_id = oi.product_id
JOIN vendors v  ON v.vendor_id = p.vendor_id
GROUP BY v.vendor_id, v.business_name, p.name;

-- 10. Verified-purchase reviews: who reviewed what (review -> order_item -> order -> user)
SELECT u.name AS reviewer, p.name AS product, r.rating, r.comment
FROM reviews r
JOIN order_items oi ON oi.order_item_id = r.order_item_id
JOIN orders o       ON o.order_id = oi.order_id
JOIN users u        ON u.user_id = o.user_id
JOIN products p     ON p.product_id = oi.product_id;

/* ---------------- Constraint demonstrations (each one FAILS on purpose) ---------------- */

-- CHECK constraint: negative stock is rejected
-- UPDATE products SET stock_quantity = -5 WHERE product_id = 1;

-- CHECK constraint: rating must be 1-5
-- INSERT INTO reviews (order_item_id, rating) VALUES (1, 7);

-- UNIQUE constraint: duplicate email is rejected
-- INSERT INTO users (name, email, password_hash, role) VALUES ('X', 'rahul@example.com', 'x', 'customer');

-- UNIQUE constraint: one review per purchased item
-- INSERT INTO reviews (order_item_id, rating) VALUES (1, 3);

-- FOREIGN KEY: product must belong to an existing category
-- INSERT INTO products (vendor_id, category_id, name, price) VALUES (1, 999, 'Ghost', 10);

-- FOREIGN KEY: a product that has been ordered cannot be hard-deleted (the app soft-deletes it instead)
-- DELETE FROM products WHERE product_id = 1;

/* ---------------- Transaction demonstration ---------------- */
-- Stock is decremented only if enough is available; otherwise the whole transaction is rolled back.
BEGIN TRANSACTION;
    UPDATE products SET stock_quantity = stock_quantity - 999 WHERE product_id = 1 AND stock_quantity >= 999;
    IF @@ROWCOUNT = 0
    BEGIN
        PRINT 'Not enough stock - rolling back';
        ROLLBACK TRANSACTION;
    END
    ELSE
        COMMIT TRANSACTION;
SELECT product_id, name, stock_quantity FROM products WHERE product_id = 1;  -- unchanged
