const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all users (admin only)
router.get('/', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.email, u.created_at, u.updated_at, r.name as role_name
            FROM users u
            JOIN roles r ON u.role_id = r.id
            ORDER BY u.created_at DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Users can only view their own profile unless they're admin
        if (req.user.id !== parseInt(id)) {
            const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [req.user.role_id]);
            if (roleResult.rows.length === 0 || roleResult.rows[0].name !== 'administrator') {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        const result = await pool.query(`
            SELECT u.id, u.username, u.email, u.created_at, u.updated_at, r.name as role_name
            FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE u.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update user
router.put('/:id', authenticateToken, [
    body('username').optional().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('email').optional().isEmail().withMessage('Must be a valid email'),
    body('role_id').optional().isInt().withMessage('Role ID must be an integer')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { username, email, role_id } = req.body;

        // Users can only update their own profile unless they're admin
        if (req.user.id !== parseInt(id)) {
            const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [req.user.role_id]);
            if (roleResult.rows.length === 0 || roleResult.rows[0].name !== 'administrator') {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (username) {
            updates.push(`username = $${paramCount}`);
            values.push(username);
            paramCount++;
        }

        if (email) {
            updates.push(`email = $${paramCount}`);
            values.push(email);
            paramCount++;
        }

        if (role_id && req.user.id !== parseInt(id)) { // Only admin can change roles
            updates.push(`role_id = $${paramCount}`);
            values.push(role_id);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(id);

        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, username, email, role_id`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await logActivity(req.user.id, 'USER_UPDATED', { updated_user_id: id });

        res.json({
            message: 'User updated successfully',
            user: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete user (admin only)
router.delete('/:id', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent admin from deleting themselves
        if (req.user.id === parseInt(id)) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await logActivity(req.user.id, 'USER_DELETED', { deleted_user_id: id });

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all roles
router.get('/roles/list', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roles ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('Get roles error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get audit logs (admin only)
router.get('/audit/logs', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT al.*, u.username
            FROM audit_logs al
            LEFT JOIN users u ON al.user_id = u.id
            ORDER BY al.timestamp DESC
            LIMIT $1 OFFSET $2
        `, [limit, offset]);

        const countResult = await pool.query('SELECT COUNT(*) FROM audit_logs');
        const total = parseInt(countResult.rows[0].count);

        res.json({
            logs: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get audit logs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

