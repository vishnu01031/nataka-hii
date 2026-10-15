/* =====================================================================
   Multi Vendor E-Commerce Platform (Nataka Hii) — Group 11, AIE-B
   Database: Azure SQL Database (Microsoft SQL Server / T-SQL)

   Batches are separated by GO. Run with:  npm run db:init  (or db:reset)
   Re-running this file DROPS and recreates every object.
   ===================================================================== */

-- ---------- Drop in reverse dependency order ----------
DROP VIEW IF EXISTS vw_order_overview;
DROP VIEW IF EXISTS vw_product_catalog;
DROP PROCEDURE IF EXISTS sp_vendor_sales_report;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS vendors;
DROP TABLE IF EXISTS users;
GO

-- ---------- USERS: every account (admin / vendor / customer) ----------
CREATE TABLE users (
    user_id        INT IDENTITY(1,1) PRIMARY KEY,
    name           NVARCHAR(100) NOT NULL,
    email          NVARCHAR(150) NOT NULL CONSTRAINT uq_users_email UNIQUE,
    password_hash  NVARCHAR(255) NOT NULL,
    role           NVARCHAR(20)  NOT NULL CONSTRAINT ck_users_role CHECK (role IN ('admin', 'vendor', 'customer')),
    is_active      BIT           NOT NULL CONSTRAINT df_users_active DEFAULT 1,
    created_at     DATETIME2     NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME()
);

-- ---------- VENDORS: 1:1 with USERS (UNIQUE user_id) ----------
CREATE TABLE vendors (
    vendor_id        INT IDENTITY(1,1) PRIMARY KEY,
    user_id          INT NOT NULL CONSTRAINT uq_vendors_user UNIQUE,
    business_name    NVARCHAR(150) NOT NULL,
    description      NVARCHAR(500) NULL,
    logo_url         NVARCHAR(255) NULL,
    approval_status  NVARCHAR(20) NOT NULL CONSTRAINT df_vendors_status DEFAULT 'pending'
                     CONSTRAINT ck_vendors_status CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    created_at       DATETIME2 NOT NULL CONSTRAINT df_vendors_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_vendors_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ---------- CATEGORIES ----------
CREATE TABLE categories (
    category_id  INT IDENTITY(1,1) PRIMARY KEY,
    name         NVARCHAR(100) NOT NULL CONSTRAINT uq_categories_name UNIQUE,
    description  NVARCHAR(300) NULL
);

-- ---------- PRODUCTS: vendor OWNS many products; product BELONGS TO one category ----------
CREATE TABLE products (
    product_id      INT IDENTITY(1,1) PRIMARY KEY,
    vendor_id       INT NOT NULL,
    category_id     INT NOT NULL,
    name            NVARCHAR(150) NOT NULL,
    description     NVARCHAR(MAX) NULL,
    price           DECIMAL(10,2) NOT NULL CONSTRAINT ck_products_price CHECK (price >= 0),
    stock_quantity  INT NOT NULL CONSTRAINT df_products_stock DEFAULT 0
                    CONSTRAINT ck_products_stock CHECK (stock_quantity >= 0),
    is_active       BIT NOT NULL CONSTRAINT df_products_active DEFAULT 1,   -- soft delete once it has order history
    created_at      DATETIME2 NOT NULL CONSTRAINT df_products_created DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2 NOT NULL CONSTRAINT df_products_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_products_vendor   FOREIGN KEY (vendor_id)   REFERENCES vendors(vendor_id) ON DELETE CASCADE,
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(category_id)
);
CREATE INDEX ix_products_vendor   ON products(vendor_id);
CREATE INDEX ix_products_category ON products(category_id);

-- ---------- PRODUCT_IMAGES: 1:M with PRODUCTS ----------
CREATE TABLE product_images (
    image_id    INT IDENTITY(1,1) PRIMARY KEY,
    product_id  INT NOT NULL,
    image_url   NVARCHAR(255) NOT NULL,
    is_primary  BIT NOT NULL CONSTRAINT df_images_primary DEFAULT 0,
    created_at  DATETIME2 NOT NULL CONSTRAINT df_images_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_images_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);
-- At most ONE primary image per product (filtered unique index)
CREATE UNIQUE INDEX ux_images_one_primary ON product_images(product_id) WHERE is_primary = 1;

-- ---------- ADDRESSES: USERS 1:M ADDRESSES ----------
CREATE TABLE addresses (
    address_id     INT IDENTITY(1,1) PRIMARY KEY,
    user_id        INT NOT NULL,
    full_name      NVARCHAR(100) NOT NULL,
    phone          NVARCHAR(20)  NOT NULL,
    address_line1  NVARCHAR(200) NOT NULL,
    address_line2  NVARCHAR(200) NULL,
    city           NVARCHAR(100) NOT NULL,
    state          NVARCHAR(100) NOT NULL,
    postal_code    NVARCHAR(10)  NOT NULL,
    country        NVARCHAR(60)  NOT NULL CONSTRAINT df_addresses_country DEFAULT 'India',
    is_default     BIT NOT NULL CONSTRAINT df_addresses_default DEFAULT 0,
    CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX ix_addresses_user ON addresses(user_id);

-- ---------- CART_ITEMS: customer's cart (one row per user+product) ----------
CREATE TABLE cart_items (
    cart_item_id  INT IDENTITY(1,1) PRIMARY KEY,
    user_id       INT NOT NULL,
    product_id    INT NOT NULL,
    quantity      INT NOT NULL CONSTRAINT ck_cart_qty CHECK (quantity > 0),
    added_at      DATETIME2 NOT NULL CONSTRAINT df_cart_added DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_cart_user_product UNIQUE (user_id, product_id),
    CONSTRAINT fk_cart_user    FOREIGN KEY (user_id)    REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_cart_product FOREIGN KEY (product_id) REFERENCES products(product_id)
);

-- ---------- ORDERS: USERS 1:M ORDERS; each order ships to ONE address ----------
CREATE TABLE orders (
    order_id      INT IDENTITY(1,1) PRIMARY KEY,
    user_id       INT NOT NULL,
    address_id    INT NOT NULL,
    order_date    DATETIME2 NOT NULL CONSTRAINT df_orders_date DEFAULT SYSUTCDATETIME(),
    total_amount  DECIMAL(12,2) NOT NULL CONSTRAINT ck_orders_total CHECK (total_amount >= 0),
    CONSTRAINT fk_orders_user    FOREIGN KEY (user_id)    REFERENCES users(user_id),
    CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES addresses(address_id)
);
CREATE INDEX ix_orders_user ON orders(user_id);

-- ---------- ORDER_ITEMS: weak entity of ORDERS; status tracked PER ITEM (multi-vendor) ----------
CREATE TABLE order_items (
    order_item_id  INT IDENTITY(1,1) PRIMARY KEY,
    order_id       INT NOT NULL,
    product_id     INT NOT NULL,
    quantity       INT NOT NULL CONSTRAINT ck_items_qty CHECK (quantity > 0),
    unit_price     DECIMAL(10,2) NOT NULL CONSTRAINT ck_items_price CHECK (unit_price >= 0), -- price AT PURCHASE time
    subtotal       AS (quantity * unit_price) PERSISTED,                                     -- computed column, can never be inconsistent
    item_status    NVARCHAR(20) NOT NULL CONSTRAINT df_items_status DEFAULT 'pending'
                   CONSTRAINT ck_items_status CHECK (item_status IN ('pending', 'shipped', 'delivered', 'cancelled')),
    CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders(order_id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(product_id)
);
CREATE INDEX ix_items_order   ON order_items(order_id);
CREATE INDEX ix_items_product ON order_items(product_id);

-- ---------- PAYMENTS: ORDERS 1:M PAYMENTS (a retry is a new row) ----------
CREATE TABLE payments (
    payment_id      INT IDENTITY(1,1) PRIMARY KEY,
    order_id        INT NOT NULL,
    payment_method  NVARCHAR(20) NOT NULL CONSTRAINT ck_payments_method CHECK (payment_method IN ('UPI', 'CARD', 'NETBANKING', 'COD')),
    transaction_id  NVARCHAR(50) NOT NULL CONSTRAINT uq_payments_txn UNIQUE,
    amount          DECIMAL(12,2) NOT NULL CONSTRAINT ck_payments_amount CHECK (amount >= 0),
    payment_status  NVARCHAR(20) NOT NULL CONSTRAINT ck_payments_status CHECK (payment_status IN ('pending', 'success', 'failed', 'refunded')),
    payment_date    DATETIME2 NOT NULL CONSTRAINT df_payments_date DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);
CREATE INDEX ix_payments_order ON payments(order_id);

-- ---------- SHIPMENTS: one shipment per (order, vendor) ----------
CREATE TABLE shipments (
    shipment_id      INT IDENTITY(1,1) PRIMARY KEY,
    order_id         INT NOT NULL,
    vendor_id        INT NOT NULL,
    courier_name     NVARCHAR(100) NOT NULL,
    tracking_number  NVARCHAR(100) NOT NULL,
    shipped_date     DATETIME2 NOT NULL CONSTRAINT df_shipments_shipped DEFAULT SYSUTCDATETIME(),
    delivered_date   DATETIME2 NULL,
    CONSTRAINT uq_shipments_order_vendor UNIQUE (order_id, vendor_id),
    CONSTRAINT ck_shipments_dates CHECK (delivered_date IS NULL OR delivered_date >= shipped_date),
    CONSTRAINT fk_shipments_order  FOREIGN KEY (order_id)  REFERENCES orders(order_id) ON DELETE CASCADE,
    CONSTRAINT fk_shipments_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id)
);

-- ---------- REVIEWS: 1:1 with a purchased ORDER_ITEM (verified purchase) ----------
-- user and product are reached through order_item -> order / product, so they are NOT stored
-- again here (storing them would be a transitive dependency and break 3NF).
CREATE TABLE reviews (
    review_id      INT IDENTITY(1,1) PRIMARY KEY,
    order_item_id  INT NOT NULL CONSTRAINT uq_reviews_item UNIQUE,
    rating         TINYINT NOT NULL CONSTRAINT ck_reviews_rating CHECK (rating BETWEEN 1 AND 5),
    comment        NVARCHAR(1000) NULL,
    created_at     DATETIME2 NOT NULL CONSTRAINT df_reviews_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_reviews_item FOREIGN KEY (order_item_id) REFERENCES order_items(order_item_id) ON DELETE CASCADE
);
GO

-- ---------- TRIGGER: keep products.updated_at current ----------
CREATE TRIGGER trg_products_updated_at ON products
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE p
       SET updated_at = SYSUTCDATETIME()
      FROM products p
      JOIN inserted i ON i.product_id = p.product_id;
END;
GO

-- ---------- VIEW: public catalogue (active products of approved, active vendors) ----------
CREATE VIEW vw_product_catalog AS
SELECT  p.product_id, p.name, p.description, p.price, p.stock_quantity, p.created_at, p.updated_at,
        c.category_id, c.name AS category_name,
        v.vendor_id, v.business_name,
        (SELECT TOP 1 pi.image_url FROM product_images pi
          WHERE pi.product_id = p.product_id
          ORDER BY pi.is_primary DESC, pi.image_id) AS image_url,
        r.avg_rating,
        ISNULL(r.review_count, 0) AS review_count
FROM    products p
JOIN    categories c ON c.category_id = p.category_id
JOIN    vendors    v ON v.vendor_id   = p.vendor_id
JOIN    users      u ON u.user_id     = v.user_id
LEFT JOIN (
        SELECT oi.product_id,
               CAST(AVG(CAST(rv.rating AS DECIMAL(4,2))) AS DECIMAL(3,2)) AS avg_rating,
               COUNT(*) AS review_count
        FROM   reviews rv
        JOIN   order_items oi ON oi.order_item_id = rv.order_item_id
        GROUP BY oi.product_id
) r ON r.product_id = p.product_id
WHERE   p.is_active = 1
  AND   v.approval_status = 'approved'
  AND   u.is_active = 1;
GO

-- ---------- VIEW: order overview with status DERIVED from item statuses ----------
CREATE VIEW vw_order_overview AS
SELECT  o.order_id, o.user_id, u.name AS customer_name, o.order_date, o.total_amount,
        COUNT(oi.order_item_id) AS item_count,
        CASE
            WHEN SUM(CASE WHEN oi.item_status = 'cancelled' THEN 1 ELSE 0 END) = COUNT(*) THEN 'Cancelled'
            WHEN SUM(CASE WHEN oi.item_status IN ('delivered', 'cancelled') THEN 1 ELSE 0 END) = COUNT(*) THEN 'Delivered'
            WHEN SUM(CASE WHEN oi.item_status IN ('shipped', 'delivered', 'cancelled') THEN 1 ELSE 0 END) = COUNT(*) THEN 'Shipped'
            WHEN SUM(CASE WHEN oi.item_status IN ('shipped', 'delivered') THEN 1 ELSE 0 END) > 0 THEN 'Partially shipped'
            ELSE 'Placed'
        END AS order_status,
        (SELECT TOP 1 pm.payment_status FROM payments pm
          WHERE pm.order_id = o.order_id ORDER BY pm.payment_id DESC) AS payment_status,
        (SELECT TOP 1 pm.payment_method FROM payments pm
          WHERE pm.order_id = o.order_id ORDER BY pm.payment_id DESC) AS payment_method
FROM    orders o
JOIN    users u        ON u.user_id   = o.user_id
JOIN    order_items oi ON oi.order_id = o.order_id
GROUP BY o.order_id, o.user_id, u.name, o.order_date, o.total_amount;
GO

-- ---------- STORED PROCEDURE: vendor sales report (3 result sets) ----------
CREATE PROCEDURE sp_vendor_sales_report
    @vendor_id INT
AS
BEGIN
    SET NOCOUNT ON;

    -- 1. Summary
    SELECT  COUNT(DISTINCT oi.order_id)        AS total_orders,
            ISNULL(SUM(oi.quantity), 0)         AS units_sold,
            ISNULL(SUM(oi.subtotal), 0)         AS revenue,
            ISNULL(SUM(CASE WHEN oi.item_status = 'pending' THEN 1 ELSE 0 END), 0) AS items_to_ship
    FROM    order_items oi
    JOIN    products p ON p.product_id = oi.product_id
    WHERE   p.vendor_id = @vendor_id
      AND   oi.item_status <> 'cancelled';

    -- 2. Top products by revenue
    SELECT  TOP 5 p.product_id, p.name,
            SUM(oi.quantity) AS units_sold,
            SUM(oi.subtotal) AS revenue
    FROM    order_items oi
    JOIN    products p ON p.product_id = oi.product_id
    WHERE   p.vendor_id = @vendor_id
      AND   oi.item_status <> 'cancelled'
    GROUP BY p.product_id, p.name
    ORDER BY revenue DESC;

    -- 3. Low-stock alert
    SELECT  product_id, name, stock_quantity
    FROM    products
    WHERE   vendor_id = @vendor_id AND is_active = 1 AND stock_quantity <= 5
    ORDER BY stock_quantity;
END;
GO
