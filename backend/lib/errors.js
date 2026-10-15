// Errors that carry an HTTP status code.
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Central error handler: turns DB constraint violations and upload errors into clean JSON.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err.status) return res.status(err.status).json({ error: err.message });

    if (err.name === 'MulterError') {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller.' : err.message;
        return res.status(400).json({ error: msg });
    }

    // SQL Server error numbers
    if (err.number === 2627 || err.number === 2601) {
        return res.status(409).json({ error: 'That record already exists (unique constraint).' });
    }
    if (err.number === 547) {
        return res.status(400).json({ error: 'That change breaks a database rule (CHECK or FOREIGN KEY constraint).' });
    }

    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Check the logs.' });
}

module.exports = { httpError, errorHandler };
