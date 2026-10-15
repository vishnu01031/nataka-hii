// Azure SQL Database (SQL Server) connection pool + small query helpers.
const sql = require('mssql');

function buildConfig(database) {
    return {
        server: process.env.DB_SERVER || 'localhost',
        port: Number(process.env.DB_PORT || 1433),
        user: process.env.DB_USER || 'sa',
        password: process.env.DB_PASSWORD || '',
        database: database || process.env.DB_NAME || 'ecommerce_db',
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        options: {
            encrypt: process.env.DB_ENCRYPT !== 'false',                        // required by Azure SQL
            trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true' // only for the local Docker SQL Server
        },
        connectionTimeout: 30000,
        requestTimeout: 30000
    };
}

let poolPromise = null;

function getPool() {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(buildConfig()).connect().catch(err => {
            poolPromise = null; // allow a retry on the next call
            throw err;
        });
    }
    return poolPromise;
}

/**
 * Run a parameterised query. Params are passed as an object: { email: 'a@b.com' } -> @email
 * Pass a sql.Transaction as `tx` to run the query inside that transaction.
 * Parameterised queries are what prevent SQL injection.
 */
async function query(text, params = {}, tx = null) {
    const request = tx ? new sql.Request(tx) : (await getPool()).request();
    for (const [name, value] of Object.entries(params)) {
        request.input(name, value === undefined ? null : value);
    }
    return request.query(text);
}

/** Run fn(tx) inside a transaction: COMMIT if it resolves, ROLLBACK if it throws. */
async function withTransaction(fn) {
    const tx = new sql.Transaction(await getPool());
    await tx.begin();
    try {
        const result = await fn(tx);
        await tx.commit();
        return result;
    } catch (err) {
        try { await tx.rollback(); } catch (_) { /* SQL Server may already have rolled back */ }
        throw err;
    }
}

module.exports = { sql, getPool, query, withTransaction, buildConfig };
