const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all suppliers with pagination and search
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (search) {
            whereClause += ` AND (s.name ILIKE $${paramCount} OR s.contact_person ILIKE $${paramCount} OR s.email ILIKE $${paramCount})`;
            queryParams.push(`%${search}%`);
            paramCount++;
        }

        const query = `
            SELECT s.*,
                   COUNT(po.id) as total_orders,
                   COALESCE(SUM(po.total_amount), 0) as total_spent,
                   AVG(EXTRACT(EPOCH FROM (r.received_date - po.order_date))/86400) as avg_lead_time_days
            FROM suppliers s
            LEFT JOIN purchase_orders po ON s.id = po.supplier_id
            LEFT JOIN receipts r ON po.id = r.purchase_order_id
            ${whereClause}
            GROUP BY s.id
            ORDER BY s.name
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM suppliers s ${whereClause}`;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            suppliers: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get suppliers error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get supplier by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT s.*,
                   COUNT(po.id) as total_orders,
                   COALESCE(SUM(po.total_amount), 0) as total_spent,
                   AVG(EXTRACT(EPOCH FROM (r.received_date - po.order_date))/86400) as avg_lead_time_days,
                   COUNT(CASE WHEN po.status = 'completed' THEN 1 END) as completed_orders,
                   COUNT(CASE WHEN po.status = 'pending' THEN 1 END) as pending_orders
            FROM suppliers s
            LEFT JOIN purchase_orders po ON s.id = po.supplier_id
            LEFT JOIN receipts r ON po.id = r.purchase_order_id
            WHERE s.id = $1
            GROUP BY s.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get supplier error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create supplier
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('name').notEmpty().withMessage('Supplier name is required'),
    body('contact_person').optional().isString(),
    body('email').optional().isEmail().withMessage('Must be a valid email'),
    body('phone').optional().isString(),
    body('address').optional().isString(),
    body('payment_terms').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, contact_person, email, phone, address, payment_terms } = req.body;

        const result = await pool.query(
            'INSERT INTO suppliers (name, contact_person, email, phone, address, payment_terms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [name, contact_person, email, phone, address, payment_terms]
        );

        await logActivity(req.user.id, 'SUPPLIER_CREATED', { supplier_id: result.rows[0].id });

        res.status(201).json({
            message: 'Supplier created successfully',
            supplier: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Supplier name already exists' });
        }
        console.error('Create supplier error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update supplier
router.put('/:id', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('name').optional().notEmpty().withMessage('Supplier name cannot be empty'),
    body('contact_person').optional().isString(),
    body('email').optional().isEmail().withMessage('Must be a valid email'),
    body('phone').optional().isString(),
    body('address').optional().isString(),
    body('payment_terms').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { name, contact_person, email, phone, address, payment_terms } = req.body;

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (name) {
            updates.push(`name = $${paramCount}`);
            values.push(name);
            paramCount++;
        }

        if (contact_person !== undefined) {
            updates.push(`contact_person = $${paramCount}`);
            values.push(contact_person);
            paramCount++;
        }

        if (email !== undefined) {
            updates.push(`email = $${paramCount}`);
            values.push(email);
            paramCount++;
        }

        if (phone !== undefined) {
            updates.push(`phone = $${paramCount}`);
            values.push(phone);
            paramCount++;
        }

        if (address !== undefined) {
            updates.push(`address = $${paramCount}`);
            values.push(address);
            paramCount++;
        }

        if (payment_terms !== undefined) {
            updates.push(`payment_terms = $${paramCount}`);
            values.push(payment_terms);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);
        const query = `UPDATE suppliers SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        await logActivity(req.user.id, 'SUPPLIER_UPDATED', { supplier_id: id });

        res.json({
            message: 'Supplier updated successfully',
            supplier: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Supplier name already exists' });
        }
        console.error('Update supplier error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete supplier
router.delete('/:id', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const { id } = req.params;

        // Check if supplier has purchase orders
        const ordersCheck = await pool.query('SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1', [id]);
        if (parseInt(ordersCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete supplier with existing purchase orders' });
        }

        const result = await pool.query('DELETE FROM suppliers WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        await logActivity(req.user.id, 'SUPPLIER_DELETED', { supplier_id: id });

        res.json({ message: 'Supplier deleted successfully' });
    } catch (error) {
        console.error('Delete supplier error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get supplier performance metrics
router.get('/:id/performance', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                COUNT(po.id) as total_orders,
                COUNT(CASE WHEN po.status = 'completed' THEN 1 END) as completed_orders,
                COUNT(CASE WHEN po.status = 'cancelled' THEN 1 END) as cancelled_orders,
                COALESCE(SUM(po.total_amount), 0) as total_spent,
                AVG(EXTRACT(EPOCH FROM (r.received_date - po.order_date))/86400) as avg_lead_time_days,
                COUNT(CASE WHEN r.received_date <= po.order_date + INTERVAL '7 days' THEN 1 END) as on_time_deliveries,
                COUNT(r.id) as total_deliveries,
                CASE 
                    WHEN COUNT(r.id) > 0 THEN 
                        ROUND((COUNT(CASE WHEN r.received_date <= po.order_date + INTERVAL '7 days' THEN 1 END)::decimal / COUNT(r.id)) * 100, 2)
                    ELSE 0 
                END as on_time_delivery_rate
            FROM suppliers s
            LEFT JOIN purchase_orders po ON s.id = po.supplier_id
            LEFT JOIN receipts r ON po.id = r.purchase_order_id
            WHERE s.id = $1
            GROUP BY s.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get supplier performance error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

