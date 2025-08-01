const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get inventory with pagination and filters
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, warehouse_id, low_stock = false, search = '' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (warehouse_id) {
            whereClause += ` AND i.warehouse_id = $${paramCount}`;
            queryParams.push(warehouse_id);
            paramCount++;
        }

        if (search) {
            whereClause += ` AND (p.name ILIKE $${paramCount} OR p.sku ILIKE $${paramCount})`;
            queryParams.push(`%${search}%`);
            paramCount++;
        }

        if (low_stock === 'true') {
            whereClause += ` AND i.quantity <= COALESCE(lsa.threshold, 10)`;
        }

        const query = `
            SELECT i.*, p.name as product_name, p.sku, p.brand, 
                   w.name as warehouse_name, w.location,
                   lsa.threshold as low_stock_threshold,
                   CASE WHEN i.quantity <= COALESCE(lsa.threshold, 10) THEN true ELSE false END as is_low_stock
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            ${whereClause}
            ORDER BY i.last_updated DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) 
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            inventory: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get inventory error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get inventory for specific product
router.get('/product/:productId', authenticateToken, async (req, res) => {
    try {
        const { productId } = req.params;

        const result = await pool.query(`
            SELECT i.*, w.name as warehouse_name, w.location,
                   lsa.threshold as low_stock_threshold,
                   CASE WHEN i.quantity <= COALESCE(lsa.threshold, 10) THEN true ELSE false END as is_low_stock
            FROM inventory i
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.product_id = $1
            ORDER BY w.name
        `, [productId]);

        res.json(result.rows);
    } catch (error) {
        console.error('Get product inventory error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update inventory (stock adjustment)
router.put('/:id', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
    body('batch_number').optional().isString(),
    body('serial_number').optional().isString(),
    body('adjustment_reason').notEmpty().withMessage('Adjustment reason is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { quantity, batch_number, serial_number, adjustment_reason } = req.body;

        // Get current inventory
        const currentResult = await pool.query('SELECT * FROM inventory WHERE id = $1', [id]);
        if (currentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Inventory record not found' });
        }

        const currentInventory = currentResult.rows[0];
        const oldQuantity = currentInventory.quantity;

        // Update inventory
        const result = await pool.query(
            'UPDATE inventory SET quantity = $1, batch_number = $2, serial_number = $3, last_updated = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
            [quantity, batch_number, serial_number, id]
        );

        await logActivity(req.user.id, 'INVENTORY_ADJUSTED', {
            inventory_id: id,
            product_id: currentInventory.product_id,
            warehouse_id: currentInventory.warehouse_id,
            old_quantity: oldQuantity,
            new_quantity: quantity,
            adjustment: quantity - oldQuantity,
            reason: adjustment_reason
        });

        res.json({
            message: 'Inventory updated successfully',
            inventory: result.rows[0],
            adjustment: quantity - oldQuantity
        });
    } catch (error) {
        console.error('Update inventory error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add inventory for new product-warehouse combination
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('product_id').isInt().withMessage('Product ID must be an integer'),
    body('warehouse_id').isInt().withMessage('Warehouse ID must be an integer'),
    body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
    body('batch_number').optional().isString(),
    body('serial_number').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { product_id, warehouse_id, quantity, batch_number, serial_number } = req.body;

        // Check if combination already exists
        const existingResult = await pool.query(
            'SELECT * FROM inventory WHERE product_id = $1 AND warehouse_id = $2',
            [product_id, warehouse_id]
        );

        if (existingResult.rows.length > 0) {
            return res.status(400).json({ error: 'Inventory record already exists for this product-warehouse combination' });
        }

        const result = await pool.query(
            'INSERT INTO inventory (product_id, warehouse_id, quantity, batch_number, serial_number) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [product_id, warehouse_id, quantity, batch_number, serial_number]
        );

        await logActivity(req.user.id, 'INVENTORY_CREATED', {
            inventory_id: result.rows[0].id,
            product_id,
            warehouse_id,
            quantity
        });

        res.status(201).json({
            message: 'Inventory record created successfully',
            inventory: result.rows[0]
        });
    } catch (error) {
        console.error('Create inventory error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get low stock alerts
router.get('/alerts/low-stock', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.*, p.name as product_name, p.sku, w.name as warehouse_name,
                   lsa.threshold, lsa.alert_sent_at
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.quantity <= COALESCE(lsa.threshold, 10)
            ORDER BY i.quantity ASC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Get low stock alerts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Set low stock threshold
router.post('/alerts/threshold', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('product_id').isInt().withMessage('Product ID must be an integer'),
    body('warehouse_id').isInt().withMessage('Warehouse ID must be an integer'),
    body('threshold').isInt({ min: 0 }).withMessage('Threshold must be a non-negative integer')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { product_id, warehouse_id, threshold } = req.body;

        const result = await pool.query(
            `INSERT INTO low_stock_alerts (product_id, warehouse_id, threshold) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (product_id, warehouse_id) 
             DO UPDATE SET threshold = $3 
             RETURNING *`,
            [product_id, warehouse_id, threshold]
        );

        await logActivity(req.user.id, 'LOW_STOCK_THRESHOLD_SET', {
            product_id,
            warehouse_id,
            threshold
        });

        res.json({
            message: 'Low stock threshold set successfully',
            alert: result.rows[0]
        });
    } catch (error) {
        console.error('Set threshold error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get reorder suggestions
router.get('/reorder-suggestions', authenticateToken, async (req, res) => {
    try {
        // This is a simplified reorder suggestion based on low stock
        // In a real system, this would consider sales velocity, lead times, etc.
        const result = await pool.query(`
            SELECT i.*, p.name as product_name, p.sku, w.name as warehouse_name,
                   lsa.threshold,
                   CASE 
                       WHEN i.quantity = 0 THEN lsa.threshold * 3
                       WHEN i.quantity <= lsa.threshold THEN lsa.threshold * 2
                       ELSE lsa.threshold
                   END as suggested_order_quantity
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.quantity <= COALESCE(lsa.threshold, 10)
            ORDER BY i.quantity ASC, p.name
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Get reorder suggestions error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get warehouses
router.get('/warehouses', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warehouses ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('Get warehouses error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create warehouse
router.post('/warehouses', authenticateToken, authorizeRole(['administrator']), [
    body('name').notEmpty().withMessage('Warehouse name is required'),
    body('location').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, location } = req.body;

        const result = await pool.query(
            'INSERT INTO warehouses (name, location) VALUES ($1, $2) RETURNING *',
            [name, location]
        );

        await logActivity(req.user.id, 'WAREHOUSE_CREATED', { warehouse_id: result.rows[0].id });

        res.status(201).json({
            message: 'Warehouse created successfully',
            warehouse: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Warehouse name already exists' });
        }
        console.error('Create warehouse error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

