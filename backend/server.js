// Azure Application Insights must start before anything else is loaded so it can
// auto-collect requests, dependencies (SQL / Blob calls), exceptions and performance counters.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    require('applicationinsights').setup().setSendLiveMetrics(true).start();
    console.log('[monitoring] Application Insights enabled');
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const { query } = require('./lib/db');
const { errorHandler } = require('./lib/errors');
const storage = require('./lib/storage');
const { initDbWithRetry } = require('./lib/init-db');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check (used by App Service and the frontend status pill)
app.get('/api/health', async (req, res) => {
    try {
        await query('SELECT 1 AS ok');
        res.json({ status: 'ok', database: 'connected', storage: storage.mode });
    } catch (err) {
        res.status(503).json({ status: 'degraded', database: 'unreachable', storage: storage.mode });
    }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/vendor', require('./routes/vendor'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

// Product images (Azure Blob or local disk)
app.get('/images/:name', storage.serveImage);

// Frontend: same origin as the API, so there are no CORS issues and no hard-coded URLs
const publicDir = [path.join(__dirname, 'public'), path.join(__dirname, '..', 'frontend')].find(d => fs.existsSync(d));
app.use(express.static(publicDir));

app.use(errorHandler);

const PORT = process.env.PORT || 8080;

(async () => {
    try {
        await storage.init();
        if (process.env.INIT_DB === 'true') await initDbWithRetry();
    } catch (err) {
        console.error('[startup] initialisation failed:', err.message);
    }
    app.listen(PORT, () => console.log(`Nataka Hii running on http://localhost:${PORT}  (storage: ${storage.mode})`));
})();
