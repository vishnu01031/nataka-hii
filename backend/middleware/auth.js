const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_secret_change_me';

// Verifies the Bearer token and puts its payload on req.user
// payload: { userId, role, name, vendorId?, businessName? }
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Log in to continue.' });
    }
    try {
        req.user = jwt.verify(header.slice(7), JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Your session has expired. Log in again.' });
    }
}

// Role-based access control: requireRole('admin'), requireRole('vendor'), ...
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'You do not have access to this.' });
        }
        next();
    };
}

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

module.exports = { requireAuth, requireRole, signToken };
