// Product image storage.
//  - On Azure: Azure Blob Storage (set AZURE_STORAGE_CONNECTION_STRING).
//  - Locally:  the ./uploads folder.
// Either way the database stores a URL like /images/<file>, and GET /images/:name streams the
// file through the API. The blob container therefore stays PRIVATE (no public access needed).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'product-images';
const LOCAL_DIR = path.join(__dirname, '..', 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

let containerClient = null;
if (CONN) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    containerClient = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONTAINER);
} else {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

const mode = CONN ? 'azure-blob' : 'local-disk';

async function init() {
    if (containerClient) await containerClient.createIfNotExists(); // private container
}

const isSafeName = name => /^[A-Za-z0-9._-]+$/.test(name);

/** Save an uploaded file (multer memory storage) and return its URL. */
async function saveImage(file) {
    const name = `${Date.now()}-${crypto.randomUUID()}${EXT[file.mimetype] || '.img'}`;
    if (containerClient) {
        await containerClient.getBlockBlobClient(name).uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype }
        });
    } else {
        await fs.promises.writeFile(path.join(LOCAL_DIR, name), file.buffer);
    }
    return `/images/${name}`;
}

async function deleteImage(url) {
    const name = path.basename(url || '');
    if (!isSafeName(name)) return;
    try {
        if (containerClient) await containerClient.getBlockBlobClient(name).deleteIfExists();
        else await fs.promises.unlink(path.join(LOCAL_DIR, name));
    } catch (_) { /* file already gone - nothing to do */ }
}

/** Express handler: GET /images/:name */
async function serveImage(req, res) {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).end();
    res.set('Cache-Control', 'public, max-age=86400');
    if (containerClient) {
        try {
            const download = await containerClient.getBlobClient(name).download();
            res.set('Content-Type', download.contentType || 'application/octet-stream');
            download.readableStreamBody.pipe(res);
        } catch (err) {
            res.status(err.statusCode === 404 ? 404 : 500).end();
        }
    } else {
        const file = path.join(LOCAL_DIR, name);
        if (!fs.existsSync(file)) return res.status(404).end();
        res.sendFile(file);
    }
}

module.exports = { init, saveImage, deleteImage, serveImage, mode };
