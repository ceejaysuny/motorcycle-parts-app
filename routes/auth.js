
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, logActivity, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// Login route
router.post('/login', [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;
        
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
        
        await logActivity(user.id, 'LOGIN');

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout route
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        await logActivity(req.user.id, 'LOGOUT');
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;



// const express = require('express');
// const bcrypt = require('bcryptjs'); // Changed from 'bcrypt' to 'bcryptjs'
// const jwt = require('jsonwebtoken');
// const { body, validationResult } = require('express-validator');
// const pool = require('../config/database');

// const router = express.Router();
// const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// const authenticateToken = async (req, res, next) => {
//     const authHeader = req.headers['authorization'];
//     const token = authHeader && authHeader.split(' ')[1];

//     if (!token) {
//         return res.status(401).json({ error: 'Access token required' });
//     }

//     try {
//         const decoded = jwt.verify(token, JWT_SECRET);
//         const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        
//         if (result.rows.length === 0) {
//             return res.status(401).json({ error: 'Invalid token' });
//         }

//         req.user = result.rows[0];
//         next();
//     } catch (error) {
//         return res.status(403).json({ error: 'Invalid token' });
//     }
// };

// const authorizeRole = (roles) => {
//     return async (req, res, next) => {
//         try {
//             const result = await pool.query(
//                 'SELECT r.name FROM roles r WHERE r.id = $1',
//                 [req.user.role_id]
//             );
            
//             if (result.rows.length === 0 || !roles.includes(result.rows[0].name)) {
//                 return res.status(403).json({ error: 'Insufficient permissions' });
//             }
            
//             next();
//         } catch (error) {
//             return res.status(500).json({ error: 'Authorization error' });
//         }
//     };
// };

// const logActivity = async (userId, action, details = {}) => {
//     try {
//         await pool.query(
//             'INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)',
//             [userId, action, JSON.stringify(details)]
//         );
//     } catch (error) {
//         console.error('Error logging activity:', error);
//     }
// };

// // Add authentication routes
// router.post('/login', [
//     body('email').isEmail().withMessage('Valid email is required'),
//     body('password').notEmpty().withMessage('Password is required')
// ], async (req, res) => {
//     try {
//         const errors = validationResult(req);
//         if (!errors.isEmpty()) {
//             return res.status(400).json({ errors: errors.array() });
//         }

//         const { email, password } = req.body;
        
//         const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
//         if (result.rows.length === 0) {
//             return res.status(401).json({ error: 'Invalid credentials' });
//         }

//         const user = result.rows[0];
//         const validPassword = await bcrypt.compare(password, user.password);

//         if (!validPassword) {
//             return res.status(401).json({ error: 'Invalid credentials' });
//         }

//         const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
        
//         await logActivity(user.id, 'LOGIN');

//         res.json({
//             token,
//             user: {
//                 id: user.id,
//                 email: user.email,
//                 first_name: user.first_name,
//                 last_name: user.last_name
//             }
//         });
//     } catch (error) {
//         console.error('Login error:', error);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// });

// router.post('/logout', authenticateToken, async (req, res) => {
//     try {
//         await logActivity(req.user.id, 'LOGOUT');
//         res.json({ message: 'Logged out successfully' });
//     } catch (error) {
//         console.error('Logout error:', error);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// });

// // Export the router
// module.exports = router;

// If you need the utility functions elsewhere, you can also export them like this:
// module.exports = {
//     router,
//     authenticateToken,
//     authorizeRole,
//     logActivity,
//     JWT_SECRET
// };


// const jwt = require('jsonwebtoken');
// const pool = require('../config/database');

// const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// const authenticateToken = async (req, res, next) => {
//     const authHeader = req.headers['authorization'];
//     const token = authHeader && authHeader.split(' ')[1];

//     if (!token) {
//         return res.status(401).json({ error: 'Access token required' });
//     }

//     try {
//         const decoded = jwt.verify(token, JWT_SECRET);
//         const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        
//         if (result.rows.length === 0) {
//             return res.status(401).json({ error: 'Invalid token' });
//         }

//         req.user = result.rows[0];
//         next();
//     } catch (error) {
//         return res.status(403).json({ error: 'Invalid token' });
//     }
// };

// const authorizeRole = (roles) => {
//     return async (req, res, next) => {
//         try {
//             const result = await pool.query(
//                 'SELECT r.name FROM roles r WHERE r.id = $1',
//                 [req.user.role_id]
//             );
            
//             if (result.rows.length === 0 || !roles.includes(result.rows[0].name)) {
//                 return res.status(403).json({ error: 'Insufficient permissions' });
//             }
            
//             next();
//         } catch (error) {
//             return res.status(500).json({ error: 'Authorization error' });
//         }
//     };
// };

// const logActivity = async (userId, action, details = {}) => {
//     try {
//         await pool.query(
//             'INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)',
//             [userId, action, JSON.stringify(details)]
//         );
//     } catch (error) {
//         console.error('Error logging activity:', error);
//     }
// };

// module.exports = {
//     authenticateToken,
//     authorizeRole,
//     logActivity,
//     JWT_SECRET
// };

