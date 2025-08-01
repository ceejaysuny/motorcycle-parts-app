const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all sales orders with pagination and filters
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, customer_id, start_date, end_date } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (status) {
            whereClause += ` AND so.status = $${paramCount}`;
            queryParams.push(status);
            paramCount++;
        }

        if (customer_id) {
            whereClause += ` AND so.customer_id = $${paramCount}`;
            queryParams.push(customer_id);
            paramCount++;
        }

        if (start_date) {
            whereClause += ` AND so.order_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            whereClause += ` AND so.order_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        const query = `
            SELECT so.*, c.company_name as customer_name, c.contact_person,
                   u.username as approved_by_username,
                   COUNT(soi.id) as item_count
            FROM sales_orders so
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN users u ON so.approved_by = u.id
            LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
            ${whereClause}
            GROUP BY so.id, c.company_name, c.contact_person, u.username
            ORDER BY so.order_date DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(DISTINCT so.id) 
            FROM sales_orders so
            JOIN customers c ON so.customer_id = c.id
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
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
        console.error('Get sales orders error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get sales order by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const orderResult = await pool.query(`
            SELECT so.*, c.company_name as customer_name, c.contact_person, c.email, c.phone, c.address,
                   u.username as approved_by_username
            FROM sales_orders so
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN users u ON so.approved_by = u.id
            WHERE so.id = $1
        `, [id]);

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found' });
        }

        const itemsResult = await pool.query(`
            SELECT soi.*, p.name as product_name, p.sku, p.brand,
                   i.quantity as available_stock
            FROM sales_order_items soi
            JOIN products p ON soi.product_id = p.id
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as quantity
                FROM inventory
                GROUP BY product_id
            ) i ON p.id = i.product_id
            WHERE soi.sales_order_id = $1
            ORDER BY p.name
        `, [id]);

        const invoicesResult = await pool.query(`
            SELECT i.*
            FROM invoices i
            WHERE i.sales_order_id = $1
            ORDER BY i.invoice_date DESC
        `, [id]);

        res.json({
            sales_order: orderResult.rows[0],
            items: itemsResult.rows,
            invoices: invoicesResult.rows
        });
    } catch (error) {
        console.error('Get sales order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create sales order (quotation)
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager', 'sales_rep']), [
    body('customer_id').isInt().withMessage('Customer ID must be an integer'),
    body('items').isArray({ min: 1 }).withMessage('Items array is required and must not be empty'),
    body('items.*.product_id').isInt().withMessage('Product ID must be an integer'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.unit_price').isDecimal({ decimal_digits: '0,2' }).withMessage('Unit price must be a valid decimal')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { customer_id, items } = req.body;

        // Calculate total amount
        const total_amount = items.reduce((sum, item) => sum + (item.quantity * parseFloat(item.unit_price)), 0);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Create sales order
            const orderResult = await client.query(
                'INSERT INTO sales_orders (customer_id, status, total_amount) VALUES ($1, $2, $3) RETURNING *',
                [customer_id, 'quotation', total_amount]
            );

            const sales_order_id = orderResult.rows[0].id;

            // Create sales order items
            for (const item of items) {
                await client.query(
                    'INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
                    [sales_order_id, item.product_id, item.quantity, item.unit_price]
                );
            }

            await client.query('COMMIT');

            await logActivity(req.user.id, 'SALES_ORDER_CREATED', { 
                sales_order_id,
                customer_id,
                total_amount 
            });

            res.status(201).json({
                message: 'Sales order created successfully',
                sales_order: orderResult.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Create sales order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update sales order status
router.put('/:id/status', authenticateToken, authorizeRole(['administrator', 'manager', 'sales_rep']), [
    body('status').isIn(['quotation', 'confirmed', 'processing', 'shipped', 'delivered', 'completed', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { status } = req.body;

        const result = await pool.query(
            'UPDATE sales_orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found' });
        }

        await logActivity(req.user.id, 'SALES_ORDER_STATUS_UPDATED', {
            sales_order_id: id,
            new_status: status
        });

        res.json({
            message: 'Sales order status updated successfully',
            sales_order: result.rows[0]
        });
    } catch (error) {
        console.error('Update sales order status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Approve sales order
router.put('/:id/approve', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'UPDATE sales_orders SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = $4 RETURNING *',
            ['confirmed', req.user.id, id, 'quotation']
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found or not in quotation status' });
        }

        await logActivity(req.user.id, 'SALES_ORDER_APPROVED', { sales_order_id: id });

        res.json({
            message: 'Sales order approved successfully',
            sales_order: result.rows[0]
        });
    } catch (error) {
        console.error('Approve sales order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Process sales order (reduce inventory)
router.put('/:id/process', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { id } = req.params;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if sales order exists and is confirmed
            const orderCheck = await client.query(
                'SELECT * FROM sales_orders WHERE id = $1 AND status = $2',
                [id, 'confirmed']
            );

            if (orderCheck.rows.length === 0) {
                throw new Error('Sales order not found or not in confirmed status');
            }

            // Get sales order items
            const itemsResult = await client.query(
                'SELECT * FROM sales_order_items WHERE sales_order_id = $1',
                [id]
            );

            // Check inventory availability and reduce stock
            for (const item of itemsResult.rows) {
                // Get total available inventory for this product
                const inventoryResult = await client.query(
                    'SELECT SUM(quantity) as total_quantity FROM inventory WHERE product_id = $1',
                    [item.product_id]
                );

                const availableQuantity = parseInt(inventoryResult.rows[0].total_quantity) || 0;

                if (availableQuantity < item.quantity) {
                    throw new Error(`Insufficient inventory for product ID ${item.product_id}. Available: ${availableQuantity}, Required: ${item.quantity}`);
                }

                // Reduce inventory (FIFO - First In, First Out)
                let remainingToReduce = item.quantity;
                const inventoryRecords = await client.query(
                    'SELECT * FROM inventory WHERE product_id = $1 AND quantity > 0 ORDER BY last_updated ASC',
                    [item.product_id]
                );

                for (const inventoryRecord of inventoryRecords.rows) {
                    if (remainingToReduce <= 0) break;

                    const reduceFromThis = Math.min(remainingToReduce, inventoryRecord.quantity);
                    const newQuantity = inventoryRecord.quantity - reduceFromThis;

                    await client.query(
                        'UPDATE inventory SET quantity = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2',
                        [newQuantity, inventoryRecord.id]
                    );

                    remainingToReduce -= reduceFromThis;
                }
            }

            // Update sales order status to processing
            await client.query(
                'UPDATE sales_orders SET status = $1 WHERE id = $2',
                ['processing', id]
            );

            await client.query('COMMIT');

            await logActivity(req.user.id, 'SALES_ORDER_PROCESSED', { sales_order_id: id });

            res.json({
                message: 'Sales order processed successfully, inventory updated'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Process sales order error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Create return/exchange
router.post('/:id/return', authenticateToken, authorizeRole(['administrator', 'manager', 'sales_rep']), [
    body('items').isArray({ min: 1 }).withMessage('Items array is required and must not be empty'),
    body('items.*.product_id').isInt().withMessage('Product ID must be an integer'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('reason').notEmpty().withMessage('Return reason is required'),
    body('type').isIn(['return', 'exchange']).withMessage('Type must be return or exchange')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { items, reason, type } = req.body;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Verify sales order exists and is completed
            const orderCheck = await client.query(
                'SELECT * FROM sales_orders WHERE id = $1 AND status IN ($2, $3)',
                [id, 'completed', 'delivered']
            );

            if (orderCheck.rows.length === 0) {
                throw new Error('Sales order not found or not in completed/delivered status');
            }

            // For returns, add items back to inventory
            if (type === 'return') {
                for (const item of items) {
                    // Get the first warehouse (in a real system, you'd specify which warehouse)
                    const warehouseResult = await client.query('SELECT id FROM warehouses LIMIT 1');
                    if (warehouseResult.rows.length > 0) {
                        const warehouse_id = warehouseResult.rows[0].id;

                        // Check if inventory record exists
                        const inventoryCheck = await client.query(
                            'SELECT * FROM inventory WHERE product_id = $1 AND warehouse_id = $2',
                            [item.product_id, warehouse_id]
                        );

                        if (inventoryCheck.rows.length > 0) {
                            // Update existing inventory
                            await client.query(
                                'UPDATE inventory SET quantity = quantity + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND warehouse_id = $3',
                                [item.quantity, item.product_id, warehouse_id]
                            );
                        } else {
                            // Create new inventory record
                            await client.query(
                                'INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES ($1, $2, $3)',
                                [item.product_id, warehouse_id, item.quantity]
                            );
                        }
                    }
                }
            }

            await client.query('COMMIT');

            await logActivity(req.user.id, `SALES_ORDER_${type.toUpperCase()}`, {
                sales_order_id: id,
                reason,
                items: items.length
            });

            res.json({
                message: `Sales order ${type} processed successfully`
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(`Sales order ${req.body.type} error:`, error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Get sales analytics
router.get('/analytics/summary', authenticateToken, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        let dateFilter = '';
        const queryParams = [];
        let paramCount = 1;

        if (start_date) {
            dateFilter += ` AND so.order_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            dateFilter += ` AND so.order_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_orders,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
                COALESCE(SUM(total_amount), 0) as total_sales,
                COALESCE(AVG(total_amount), 0) as avg_order_value,
                COUNT(DISTINCT customer_id) as unique_customers
            FROM sales_orders so
            WHERE 1=1 ${dateFilter}
        `, queryParams);

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get sales analytics error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

