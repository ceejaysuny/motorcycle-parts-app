const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all customers with pagination and search
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (search) {
            whereClause += ` AND (c.company_name ILIKE $${paramCount} OR c.contact_person ILIKE $${paramCount} OR c.email ILIKE $${paramCount})`;
            queryParams.push(`%${search}%`);
            paramCount++;
        }

        const query = `
            SELECT c.*,
                   COUNT(so.id) as total_orders,
                   COALESCE(SUM(so.total_amount), 0) as total_sales,
                   MAX(so.order_date) as last_order_date
            FROM customers c
            LEFT JOIN sales_orders so ON c.id = so.customer_id
            ${whereClause}
            GROUP BY c.id
            ORDER BY c.company_name
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM customers c ${whereClause}`;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            customers: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get customers error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get customer by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT c.*,
                   COUNT(so.id) as total_orders,
                   COALESCE(SUM(so.total_amount), 0) as total_sales,
                   MAX(so.order_date) as last_order_date,
                   COUNT(CASE WHEN so.status = 'completed' THEN 1 END) as completed_orders,
                   COUNT(CASE WHEN so.status = 'pending' THEN 1 END) as pending_orders,
                   AVG(so.total_amount) as avg_order_value
            FROM customers c
            LEFT JOIN sales_orders so ON c.id = so.customer_id
            WHERE c.id = $1
            GROUP BY c.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get customer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create customer
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager', 'sales_rep']), [
    body('company_name').notEmpty().withMessage('Company name is required'),
    body('contact_person').optional().isString(),
    body('email').optional().isEmail().withMessage('Must be a valid email'),
    body('phone').optional().isString(),
    body('address').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { company_name, contact_person, email, phone, address } = req.body;

        const result = await pool.query(
            'INSERT INTO customers (company_name, contact_person, email, phone, address) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [company_name, contact_person, email, phone, address]
        );

        await logActivity(req.user.id, 'CUSTOMER_CREATED', { customer_id: result.rows[0].id });

        res.status(201).json({
            message: 'Customer created successfully',
            customer: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Company name already exists' });
        }
        console.error('Create customer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update customer
router.put('/:id', authenticateToken, authorizeRole(['administrator', 'manager', 'sales_rep']), [
    body('company_name').optional().notEmpty().withMessage('Company name cannot be empty'),
    body('contact_person').optional().isString(),
    body('email').optional().isEmail().withMessage('Must be a valid email'),
    body('phone').optional().isString(),
    body('address').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { company_name, contact_person, email, phone, address } = req.body;

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (company_name) {
            updates.push(`company_name = $${paramCount}`);
            values.push(company_name);
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

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);
        const query = `UPDATE customers SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await logActivity(req.user.id, 'CUSTOMER_UPDATED', { customer_id: id });

        res.json({
            message: 'Customer updated successfully',
            customer: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Company name already exists' });
        }
        console.error('Update customer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete customer
router.delete('/:id', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const { id } = req.params;

        // Check if customer has sales orders
        const ordersCheck = await pool.query('SELECT COUNT(*) FROM sales_orders WHERE customer_id = $1', [id]);
        if (parseInt(ordersCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete customer with existing sales orders' });
        }

        const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await logActivity(req.user.id, 'CUSTOMER_DELETED', { customer_id: id });

        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        console.error('Delete customer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get customer sales history
router.get('/:id/sales-history', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT so.*, COUNT(soi.id) as item_count
            FROM sales_orders so
            LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
            WHERE so.customer_id = $1
            GROUP BY so.id
            ORDER BY so.order_date DESC
            LIMIT $2 OFFSET $3
        `, [id, limit, offset]);

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM sales_orders WHERE customer_id = $1',
            [id]
        );
        const total = parseInt(countResult.rows[0].count);

        res.json({
            sales_orders: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get customer sales history error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

