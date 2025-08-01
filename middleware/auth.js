const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        req.user = result.rows[0];
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

const authorizeRole = (roles) => {
    return async (req, res, next) => {
        try {
            const result = await pool.query(
                'SELECT r.name FROM roles r WHERE r.id = $1',
                [req.user.role_id]
            );
            
            if (result.rows.length === 0 || !roles.includes(result.rows[0].name)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            
            next();
        } catch (error) {
            return res.status(500).json({ error: 'Authorization error' });
        }
    };
};

const logActivity = async (userId, action, details = {}) => {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)',
            [userId, action, JSON.stringify(details)]
        );
    } catch (error) {
        console.error('Error logging activity:', error);
    }
};

module.exports = {
    authenticateToken,
    authorizeRole,
    logActivity,
    JWT_SECRET
};