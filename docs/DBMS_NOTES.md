# DBMS notes for the report and viva

## 1. Relational schema

PK underlined in the report; here `PK`, `FK`, `UK` (unique).

- **users**(user_id PK, name, email UK, password_hash, role, is_active, created_at)
- **vendors**(vendor_id PK, user_id FK→users UK, business_name, description, logo_url, approval_status, created_at)
- **categories**(category_id PK, name UK, description)
- **products**(product_id PK, vendor_id FK→vendors, category_id FK→categories, name, description, price, stock_quantity, is_active, created_at, updated_at)
- **product_images**(image_id PK, product_id FK→products, image_url, is_primary, created_at)
- **addresses**(address_id PK, user_id FK→users, full_name, phone, address_line1, address_line2, city, state, postal_code, country, is_default)
- **cart_items**(cart_item_id PK, user_id FK→users, product_id FK→products, quantity, added_at) — UK(user_id, product_id)
- **orders**(order_id PK, user_id FK→users, address_id FK→addresses, order_date, total_amount)
- **order_items**(order_item_id PK, order_id FK→orders, product_id FK→products, quantity, unit_price, subtotal [computed], item_status)
- **payments**(payment_id PK, order_id FK→orders, payment_method, transaction_id UK, amount, payment_status, payment_date)
- **shipments**(shipment_id PK, order_id FK→orders, vendor_id FK→vendors, courier_name, tracking_number, shipped_date, delivered_date) — UK(order_id, vendor_id)
- **reviews**(review_id PK, order_item_id FK→order_items UK, rating, comment, created_at)

## 2. Relationships and cardinality

| Relationship | Cardinality | How it is enforced |
|---|---|---|
| USERS – VENDORS | 1 : 0..1 | `vendors.user_id` is FK **and** UNIQUE |
| VENDORS – PRODUCTS | 1 : M | `products.vendor_id` FK |
| CATEGORIES – PRODUCTS | 1 : M | `products.category_id` FK |
| PRODUCTS – PRODUCT_IMAGES | 1 : M | FK; filtered UNIQUE index allows one `is_primary = 1` per product |
| USERS – ADDRESSES | 1 : M | FK |
| USERS – CART_ITEMS – PRODUCTS | M : N resolved by `cart_items` | UNIQUE(user_id, product_id) |
| USERS – ORDERS | 1 : M | FK |
| ADDRESSES – ORDERS | 1 : M (each order ships to exactly one address) | `orders.address_id` FK, NOT NULL |
| ORDERS – PRODUCTS | M : N resolved by `order_items` | two FKs |
| ORDERS – PAYMENTS | 1 : M (a failed payment + retry = two rows) | FK |
| ORDERS – SHIPMENTS – VENDORS | each vendor ships its part of an order once | UNIQUE(order_id, vendor_id) |
| ORDER_ITEMS – REVIEWS | 1 : 0..1 (verified purchase, one review per item) | `reviews.order_item_id` FK **and** UNIQUE |

`order_items` is a **weak entity** of `orders`: it has no meaning without its order and is deleted with it (`ON DELETE CASCADE`).

## 3. Normalization

**1NF**: every column holds one atomic value. Multiple product photos are rows in `product_images`, not a comma list in `products`. Addresses are split into line1, line2, city, state, postal_code.

**2NF**: every table has a single-column surrogate key (`IDENTITY`), so no partial dependency on part of a composite key is possible. Where a natural composite key exists (`cart_items(user_id, product_id)`), `quantity` depends on the whole pair.

**3NF**: no non-key column depends on another non-key column.
- `orders` does **not** store `payment_method` / `payment_status`; they live only in `payments` (the original ER had them in both, which can disagree).
- `reviews` does **not** store `user_id` / `product_id`. Both are already determined by `order_item_id` (order_item → order → user, order_item → product), so storing them would be a transitive dependency.
- `products` does **not** store `image_url`; the cover image is `product_images.is_primary`.
- `order_items` does **not** store vendor_id; it is reached through `product_id`.

**Deliberate exceptions, and why they are safe:**
- `order_items.unit_price` copies the product price **at the time of purchase**. It is not redundant: the product's price can change later, but the customer paid the old price.
- `order_items.subtotal` is a **PERSISTED computed column** (`quantity * unit_price`). The DBMS calculates it, so it can never be inconsistent.
- `orders.total_amount` is stored for fast order lists and to match the payment amount. It is written once, inside the checkout transaction, and never updated.
- Order status is **not stored** at all. The view `vw_order_overview` derives it from the item statuses.

## 4. Integrity constraints used

| Type | Examples |
|---|---|
| Domain / CHECK | `price >= 0`, `stock_quantity >= 0`, `quantity > 0`, `rating BETWEEN 1 AND 5`, `role IN ('admin','vendor','customer')`, `item_status IN (...)`, `delivered_date >= shipped_date` |
| Entity | every table has a PRIMARY KEY |
| Referential | 15 FOREIGN KEYs. CASCADE where the child cannot exist alone (images, order items, payments, shipments). NO ACTION where history must survive (orders, order_items → products) |
| Unique | email, category name, transaction_id, one vendor per user, one review per item, one cart row per product, one shipment per (order, vendor), one primary image per product |
| Default | timestamps (`SYSUTCDATETIME()`), `approval_status = 'pending'`, `item_status = 'pending'` |

**Soft delete:** a product that appears in any order cannot be physically deleted (the FK from `order_items` blocks it). The app sets `is_active = 0` instead, so order history stays correct.

## 5. Transactions (ACID)

All in `backend/routes/*.js` using `withTransaction()` (BEGIN … COMMIT, ROLLBACK on any error).

**Checkout** (`POST /api/customer/checkout`):
1. Read the cart.
2. For each item: `UPDATE products SET stock_quantity = stock_quantity - @q WHERE product_id = @p AND stock_quantity >= @q`. If 0 rows are affected there isn't enough stock → **ROLLBACK**.
3. INSERT the order, then each order_item with the current price.
4. INSERT the payment.
5. DELETE the cart.

- **Atomicity**: either the order exists with its items, payment and reduced stock, or nothing changed.
- **Consistency**: CHECK `stock_quantity >= 0` makes overselling impossible even if the app had a bug.
- **Isolation / concurrency**: the check and decrement happen in one UPDATE statement, which takes a row lock. Two customers buying the last unit at the same moment: the second UPDATE sees 0 and affects 0 rows, so that checkout rolls back.
- **Durability**: guaranteed by Azure SQL after COMMIT (with automatic backups and point-in-time restore).

Other transactions: vendor signup (users + vendors rows), shipping (shipment row + item statuses), delivery (item statuses + shipment date + COD payment), product save (product + images), product delete.

## 6. Other database objects

- **View `vw_product_catalog`**: only active products of approved, active vendors, with cover image and average rating. The storefront reads only from this view, so a rejected vendor's products disappear everywhere at once.
- **View `vw_order_overview`**: order status derived with `CASE` + `SUM` over item statuses ("Placed", "Partially shipped", "Shipped", "Delivered").
- **Stored procedure `sp_vendor_sales_report @vendor_id`**: returns three result sets (summary, top products, low stock). Used by the vendor Sales tab.
- **Trigger `trg_products_updated_at`**: sets `updated_at` on every product UPDATE.
- **Indexes**: on every foreign key column (SQL Server does not create these automatically) to speed up joins.

## 7. Security

- Every query is **parameterised** (`@email`, `@id`…), which prevents SQL injection.
- Passwords are stored as **bcrypt** hashes.
- Every vendor query includes `WHERE vendor_id = @v` taken from the signed token, never from the request, so one vendor cannot read or change another's data even by guessing IDs.

## 8. Changes from our first ER diagram (and why)

| Original | Changed to | Reason |
|---|---|---|
| REVIEWS linked to ORDER_ITEMS but holding user_id, product_id, cardinality M:1 | `reviews.order_item_id` FK + UNIQUE (1:1) | Verified purchase; one review per item; removes transitive dependency |
| ADDRESSES M:M with ORDERS, no link to USERS | USERS 1:M ADDRESSES, ADDRESSES 1:M ORDERS | An order ships to one address; addresses belong to a user |
| `payment_method`, `payment_status` in ORDERS and PAYMENTS | only in PAYMENTS | Redundancy (3NF) |
| `image_url` in PRODUCTS and PRODUCT_IMAGES | only PRODUCT_IMAGES with `is_primary` | Redundancy |
| `order_status` on ORDERS, shipments per order | `item_status` per item, shipment per (order, vendor), status derived by a view | One order can contain items from several vendors who ship separately |
| No cart table | CART_ITEMS | The abstract includes a shopping cart |
| `shipping_status` in SHIPMENTS | derived from shipped/delivered dates | Avoids a column that can contradict the dates |

## 9. Likely viva questions

- **Why a separate `order_items` table?** Orders and products are M:N; the junction table also holds per-line data (quantity, price at purchase, status).
- **Why store `unit_price` if products already have a price?** The product price can change; the order must keep what was actually charged.
- **What happens if two people buy the last item together?** See section 5: the single conditional UPDATE plus row locking means only one succeeds; the other transaction rolls back with "Not enough stock".
- **What if a vendor deletes a product that was ordered?** The FK prevents a hard delete; the app soft-deletes (`is_active = 0`) so order history stays valid.
- **How is a vendor prevented from editing another vendor's product?** Every query is scoped by `vendor_id` from the JWT.
- **Which normal form is the schema in?** 3NF, and in fact BCNF: in every table, each determinant is a candidate key (the surrogate ID, plus UNIQUE keys such as `users.email`). Section 3 lists the deliberate, justified exceptions.
