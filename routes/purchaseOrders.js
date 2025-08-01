const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all purchase orders with pagination and filters
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, supplier_id, start_date, end_date } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (status) {
            whereClause += ` AND po.status = $${paramCount}`;
            queryParams.push(status);
            paramCount++;
        }

        if (supplier_id) {
            whereClause += ` AND po.supplier_id = $${paramCount}`;
            queryParams.push(supplier_id);
            paramCount++;
        }

        if (start_date) {
            whereClause += ` AND po.order_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            whereClause += ` AND po.order_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        const query = `
            SELECT po.*, s.name as supplier_name, s.contact_person,
                   u.username as approved_by_username,
                   COUNT(poi.id) as item_count
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            LEFT JOIN users u ON po.approved_by = u.id
            LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
            ${whereClause}
            GROUP BY po.id, s.name, s.contact_person, u.username
            ORDER BY po.order_date DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(DISTINCT po.id) 
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            purchase_orders: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get purchase orders error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get purchase order by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const orderResult = await pool.query(`
            SELECT po.*, s.name as supplier_name, s.contact_person, s.email, s.phone, s.address,
                   u.username as approved_by_username
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            LEFT JOIN users u ON po.approved_by = u.id
            WHERE po.id = $1
        `, [id]);

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const itemsResult = await pool.query(`
            SELECT poi.*, p.name as product_name, p.sku, p.brand
            FROM purchase_order_items poi
            JOIN products p ON poi.product_id = p.id
            WHERE poi.purchase_order_id = $1
            ORDER BY p.name
        `, [id]);

        const receiptsResult = await pool.query(`
            SELECT r.*, u.username as received_by_username
            FROM receipts r
            LEFT JOIN users u ON r.received_by = u.id
            WHERE r.purchase_order_id = $1
            ORDER BY r.received_date DESC
        `, [id]);

        res.json({
            purchase_order: orderResult.rows[0],
            items: itemsResult.rows,
            receipts: receiptsResult.rows
        });
    } catch (error) {
        console.error('Get purchase order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create purchase order
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('supplier_id').isInt().withMessage('Supplier ID must be an integer'),
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

        const { supplier_id, items } = req.body;

        // Calculate total amount
        const total_amount = items.reduce((sum, item) => sum + (item.quantity * parseFloat(item.unit_price)), 0);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Create purchase order
            const orderResult = await client.query(
                'INSERT INTO purchase_orders (supplier_id, status, total_amount) VALUES ($1, $2, $3) RETURNING *',
                [supplier_id, 'pending', total_amount]
            );

            const purchase_order_id = orderResult.rows[0].id;

            // Create purchase order items
            for (const item of items) {
                await client.query(
                    'INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
                    [purchase_order_id, item.product_id, item.quantity, item.unit_price]
                );
            }

            await client.query('COMMIT');

            await logActivity(req.user.id, 'PURCHASE_ORDER_CREATED', { 
                purchase_order_id,
                supplier_id,
                total_amount 
            });

            res.status(201).json({
                message: 'Purchase order created successfully',
                purchase_order: orderResult.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Create purchase order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update purchase order status
router.put('/:id/status', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('status').isIn(['pending', 'approved', 'sent', 'received', 'completed', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { status } = req.body;

        const result = await pool.query(
            'UPDATE purchase_orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        await logActivity(req.user.id, 'PURCHASE_ORDER_STATUS_UPDATED', {
            purchase_order_id: id,
            new_status: status
        });

        res.json({
            message: 'Purchase order status updated successfully',
            purchase_order: result.rows[0]
        });
    } catch (error) {
        console.error('Update purchase order status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Approve purchase order
router.put('/:id/approve', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'UPDATE purchase_orders SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = $4 RETURNING *',
            ['approved', req.user.id, id, 'pending']
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found or not in pending status' });
        }

        await logActivity(req.user.id, 'PURCHASE_ORDER_APPROVED', { purchase_order_id: id });

        res.json({
            message: 'Purchase order approved successfully',
            purchase_order: result.rows[0]
        });
    } catch (error) {
        console.error('Approve purchase order error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Receive purchase order (create receipt)
router.post('/:id/receive', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('items').isArray({ min: 1 }).withMessage('Items array is required and must not be empty'),
    body('items.*.product_id').isInt().withMessage('Product ID must be an integer'),
    body('items.*.quantity_received').isInt({ min: 0 }).withMessage('Quantity received must be a non-negative integer'),
    body('items.*.batch_number').optional().isString(),
    body('items.*.serial_number').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { items } = req.body;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if purchase order exists and is approved
            const orderCheck = await client.query(
                'SELECT * FROM purchase_orders WHERE id = $1 AND status IN ($2, $3)',
                [id, 'approved', 'sent']
            );

            if (orderCheck.rows.length === 0) {
                throw new Error('Purchase order not found or not in approved/sent status');
            }

            // Create receipt
            const receiptResult = await client.query(
                'INSERT INTO receipts (purchase_order_id, received_by) VALUES ($1, $2) RETURNING *',
                [id, req.user.id]
            );

            const receipt_id = receiptResult.rows[0].id;

            // Create receipt items and update inventory
            for (const item of items) {
                if (item.quantity_received > 0) {
                    // Create receipt item
                    await client.query(
                        'INSERT INTO receipt_items (receipt_id, product_id, quantity_received, batch_number, serial_number) VALUES ($1, $2, $3, $4, $5)',
                        [receipt_id, item.product_id, item.quantity_received, item.batch_number, item.serial_number]
                    );

                    // Update inventory for each warehouse (for simplicity, we'll use the first warehouse)
                    // In a real system, you'd specify which warehouse to receive into
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
                                [item.quantity_received, item.product_id, warehouse_id]
                            );
                        } else {
                            // Create new inventory record
                            await client.query(
                                'INSERT INTO inventory (product_id, warehouse_id, quantity, batch_number, serial_number) VALUES ($1, $2, $3, $4, $5)',
                                [item.product_id, warehouse_id, item.quantity_received, item.batch_number, item.serial_number]
                            );
                        }
                    }
                }
            }

            // Update purchase order status to received
            await client.query(
                'UPDATE purchase_orders SET status = $1 WHERE id = $2',
                ['received', id]
            );

            await client.query('COMMIT');

            await logActivity(req.user.id, 'PURCHASE_ORDER_RECEIVED', {
                purchase_order_id: id,
                receipt_id
            });

            res.json({
                message: 'Purchase order received successfully',
                receipt: receiptResult.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Receive purchase order error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Get purchase order history for a supplier
router.get('/supplier/:supplierId/history', authenticateToken, async (req, res) => {
    try {
        const { supplierId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT po.*, COUNT(poi.id) as item_count
            FROM purchase_orders po
            LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
            WHERE po.supplier_id = $1
            GROUP BY po.id
            ORDER BY po.order_date DESC
            LIMIT $2 OFFSET $3
        `, [supplierId, limit, offset]);

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1',
            [supplierId]
        );
        const total = parseInt(countResult.rows[0].count);

        res.json({
            purchase_orders: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get supplier purchase order history error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

