// Creates the schema (db/schema.sql) and loads demo data.
//   npm run db:init   -> only if the tables don't exist yet
//   npm run db:reset  -> drop everything and recreate (wipes data!)
// On startup, server.js calls initDb() when INIT_DB=true.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { sql, getPool, query, buildConfig } = require('./db');

function findSchema() {
    const candidates = [
        path.join(__dirname, '..', 'db', 'schema.sql'),       // inside the Docker image
        path.join(__dirname, '..', '..', 'db', 'schema.sql')  // running from the repo
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('schema.sql not found');
    return found;
}

async function createDatabaseIfMissing() {
    // Only for the local SQL Server container. On Azure the database is created in the portal.
    const name = process.env.DB_NAME || 'ecommerce_db';
    if (!/^\w+$/.test(name)) throw new Error('DB_NAME may only contain letters, digits and _');
    const master = await new sql.ConnectionPool(buildConfig('master')).connect();
    try {
        await master.request().query(`IF DB_ID(N'${name}') IS NULL CREATE DATABASE [${name}]`);
    } finally {
        await master.close();
    }
}

async function runSchema() {
    const pool = await getPool();
    const batches = fs.readFileSync(findSchema(), 'utf8')
        .split(/^\s*GO\s*$/im)
        .map(b => b.trim())
        .filter(Boolean);
    for (const batch of batches) await pool.request().batch(batch);
}

// INSERT ... and return the new IDENTITY value
async function insert(text, params) {
    const result = await query(`${text}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`, params);
    return result.recordset[0].id;
}

async function seed() {
    const hash = pw => bcrypt.hash(pw, 10);

    // Categories
    const cat = {};
    for (const [name, description] of [
        ['Clothing', 'Ethnic and western wear'],
        ['Electronics', 'Gadgets, audio and accessories'],
        ['Home & Kitchen', 'Decor, cookware and essentials'],
        ['Books', 'Fiction, non-fiction and textbooks']
    ]) cat[name] = await insert('INSERT INTO categories (name, description) VALUES (@name, @description)', { name, description });

    // Users
    const user = async (name, email, password, role) =>
        insert('INSERT INTO users (name, email, password_hash, role) VALUES (@name, @email, @hash, @role)',
            { name, email, hash: await hash(password), role });

    await user('Platform Admin', 'admin@natakahii.com', 'admin123', 'admin');
    const rahulU = await user('Rahul Kumar', 'rahul@example.com', 'vendor123', 'vendor');
    const priyaU = await user('Priya Sharma', 'priya@example.com', 'vendor123', 'vendor');
    const meenaU = await user('Meena Iyer', 'meena@example.com', 'vendor123', 'vendor');
    const anitaU = await user('Anita Raj', 'anita@example.com', 'customer123', 'customer');
    const karthikU = await user('Karthik S', 'karthik@example.com', 'customer123', 'customer');

    // Vendors (Meena is pending -> shows the admin approval workflow)
    const vendor = (user_id, business_name, description, approval_status) =>
        insert(`INSERT INTO vendors (user_id, business_name, description, approval_status)
                VALUES (@user_id, @business_name, @description, @approval_status)`,
            { user_id, business_name, description, approval_status });
    const rahul = await vendor(rahulU, 'Rahul Textiles', 'Handloom and cotton clothing from Coimbatore', 'approved');
    const priya = await vendor(priyaU, 'Priya Electronics', 'Everyday gadgets and accessories', 'approved');
    await vendor(meenaU, 'Meena Home Decor', 'Handmade decor for every room', 'pending');

    // Products
    const product = (vendor_id, category_id, name, description, price, stock_quantity) =>
        insert(`INSERT INTO products (vendor_id, category_id, name, description, price, stock_quantity)
                VALUES (@vendor_id, @category_id, @name, @description, @price, @stock_quantity)`,
            { vendor_id, category_id, name, description, price, stock_quantity });
    const kurti = await product(rahul, cat.Clothing, 'Cotton Kurti', 'Handwoven cotton kurti, size M', 799, 23);
    const jacket = await product(rahul, cat.Clothing, 'Denim Jacket', 'Unisex denim jacket, regular fit', 1499, 9);
    await product(rahul, cat.Clothing, 'Silk Saree', 'Kanchipuram-style silk saree with zari border', 3499, 4);
    const earbuds = await product(priya, cat.Electronics, 'Wireless Earbuds', 'Bluetooth 5.3, 30-hour battery with case', 1999, 29);
    const powerbank = await product(priya, cat.Electronics, 'Power Bank 10000mAh', 'Fast charging, dual USB output', 1299, 2);
    await product(priya, cat.Electronics, 'USB-C Cable (1m)', 'Braided, 60W fast charging', 299, 100);

    // Addresses
    const address = (user_id, full_name, phone, address_line1, city, state, postal_code) =>
        insert(`INSERT INTO addresses (user_id, full_name, phone, address_line1, city, state, postal_code, is_default)
                VALUES (@user_id, @full_name, @phone, @address_line1, @city, @state, @postal_code, 1)`,
            { user_id, full_name, phone, address_line1, city, state, postal_code });
    const anitaAddr = await address(anitaU, 'Anita Raj', '9876543210', '12, Avinashi Road', 'Coimbatore', 'Tamil Nadu', '641018');
    const karthikAddr = await address(karthikU, 'Karthik S', '9123456780', '45, Anna Salai', 'Chennai', 'Tamil Nadu', '600002');

    // Order 1 (Anita): delivered by both vendors, paid by UPI, reviewed
    const o1 = await insert(`INSERT INTO orders (user_id, address_id, order_date, total_amount)
                             VALUES (@u, @a, DATEADD(day, -6, SYSUTCDATETIME()), 3597)`, { u: anitaU, a: anitaAddr });
    const item = (order_id, product_id, quantity, unit_price, item_status) =>
        insert(`INSERT INTO order_items (order_id, product_id, quantity, unit_price, item_status)
                VALUES (@order_id, @product_id, @quantity, @unit_price, @item_status)`,
            { order_id, product_id, quantity, unit_price, item_status });
    const i1 = await item(o1, kurti, 2, 799, 'delivered');
    const i2 = await item(o1, earbuds, 1, 1999, 'delivered');
    await query(`INSERT INTO payments (order_id, payment_method, transaction_id, amount, payment_status, payment_date)
                 VALUES (@o, 'UPI', 'TXN-SEED-0001', 3597, 'success', DATEADD(day, -6, SYSUTCDATETIME()))`, { o: o1 });
    for (const [v, courier, tracking] of [[rahul, 'Delhivery', 'DLV1029384'], [priya, 'Blue Dart', 'BD5566778']]) {
        await query(`INSERT INTO shipments (order_id, vendor_id, courier_name, tracking_number, shipped_date, delivered_date)
                     VALUES (@o, @v, @courier, @tracking, DATEADD(day, -5, SYSUTCDATETIME()), DATEADD(day, -2, SYSUTCDATETIME()))`,
            { o: o1, v, courier, tracking });
    }
    await query(`INSERT INTO reviews (order_item_id, rating, comment) VALUES
                 (@i1, 5, N'Lovely fabric, fits perfectly.'), (@i2, 4, N'Good sound for the price. Case is a bit bulky.')`,
        { i1, i2 });

    // Order 2 (Karthik): pending with both vendors -> vendors can ship it during the demo
    const o2 = await insert(`INSERT INTO orders (user_id, address_id, order_date, total_amount)
                             VALUES (@u, @a, DATEADD(hour, -20, SYSUTCDATETIME()), 2798)`, { u: karthikU, a: karthikAddr });
    await item(o2, jacket, 1, 1499, 'pending');
    await item(o2, powerbank, 1, 1299, 'pending');
    await query(`INSERT INTO payments (order_id, payment_method, transaction_id, amount, payment_status)
                 VALUES (@o, 'COD', 'COD-SEED-0002', 2798, 'pending')`, { o: o2 });
}

async function initDb({ reset = false } = {}) {
    if (process.env.DB_CREATE === 'true') await createDatabaseIfMissing();
    const exists = (await query("SELECT OBJECT_ID('dbo.users', 'U') AS id")).recordset[0].id;
    if (exists && !reset) {
        console.log('[db] schema already exists - skipping init');
        return;
    }
    console.log('[db] creating schema...');
    await runSchema();
    console.log('[db] loading demo data...');
    await seed();
    console.log('[db] ready');
}

// Retries because the SQL Server container (or a paused Azure SQL serverless DB) can take a minute to wake up.
async function initDbWithRetry(options, attempts = 20) {
    for (let i = 1; i <= attempts; i++) {
        try {
            return await initDb(options);
        } catch (err) {
            if (i === attempts) throw err;
            console.log(`[db] not ready (${err.message}) - retry ${i}/${attempts} in 5s`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

module.exports = { initDb, initDbWithRetry };

if (require.main === module) {
    initDbWithRetry({ reset: process.argv.includes('--reset') }, 3)
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
}
