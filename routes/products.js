const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all products with pagination and search
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '', brand = '', model = '' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (search) {
            whereClause += ` AND (p.name ILIKE $${paramCount} OR p.sku ILIKE $${paramCount} OR p.description ILIKE $${paramCount})`;
            queryParams.push(`%${search}%`);
            paramCount++;
        }

        if (brand) {
            whereClause += ` AND p.brand ILIKE $${paramCount}`;
            queryParams.push(`%${brand}%`);
            paramCount++;
        }

        if (model) {
            whereClause += ` AND p.model_compatibility ILIKE $${paramCount}`;
            queryParams.push(`%${model}%`);
            paramCount++;
        }

        const query = `
            SELECT p.*, 
                   COALESCE(SUM(i.quantity), 0) as total_stock
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            ${whereClause}
            GROUP BY p.id
            ORDER BY p.created_at DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(DISTINCT p.id) 
            FROM products p 
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            products: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get product by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT p.*, 
                   COALESCE(SUM(i.quantity), 0) as total_stock,
                   json_agg(
                       json_build_object(
                           'warehouse_id', w.id,
                           'warehouse_name', w.name,
                           'quantity', COALESCE(i.quantity, 0)
                       )
                   ) as warehouse_stock
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            LEFT JOIN warehouses w ON i.warehouse_id = w.id
            WHERE p.id = $1
            GROUP BY p.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create product
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('sku').notEmpty().withMessage('SKU is required'),
    body('name').notEmpty().withMessage('Product name is required'),
    body('description').optional().isString(),
    body('brand').optional().isString(),
    body('model_compatibility').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { sku, name, description, brand, model_compatibility } = req.body;

        const result = await pool.query(
            'INSERT INTO products (sku, name, description, brand, model_compatibility) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [sku, name, description, brand, model_compatibility]
        );

        await logActivity(req.user.id, 'PRODUCT_CREATED', { product_id: result.rows[0].id });

        res.status(201).json({
            message: 'Product created successfully',
            product: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'SKU already exists' });
        }
        console.error('Create product error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update product
router.put('/:id', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('sku').optional().notEmpty().withMessage('SKU cannot be empty'),
    body('name').optional().notEmpty().withMessage('Product name cannot be empty'),
    body('description').optional().isString(),
    body('brand').optional().isString(),
    body('model_compatibility').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { sku, name, description, brand, model_compatibility } = req.body;

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (sku) {
            updates.push(`sku = $${paramCount}`);
            values.push(sku);
            paramCount++;
        }

        if (name) {
            updates.push(`name = $${paramCount}`);
            values.push(name);
            paramCount++;
        }

        if (description !== undefined) {
            updates.push(`description = $${paramCount}`);
            values.push(description);
            paramCount++;
        }

        if (brand !== undefined) {
            updates.push(`brand = $${paramCount}`);
            values.push(brand);
            paramCount++;
        }

        if (model_compatibility !== undefined) {
            updates.push(`model_compatibility = $${paramCount}`);
            values.push(model_compatibility);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(id);

        const query = `UPDATE products SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        await logActivity(req.user.id, 'PRODUCT_UPDATED', { product_id: id });

        res.json({
            message: 'Product updated successfully',
            product: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'SKU already exists' });
        }
        console.error('Update product error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete product
router.delete('/:id', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const { id } = req.params;

        // Check if product has inventory
        const inventoryCheck = await pool.query('SELECT SUM(quantity) as total FROM inventory WHERE product_id = $1', [id]);
        if (inventoryCheck.rows[0].total > 0) {
            return res.status(400).json({ error: 'Cannot delete product with existing inventory' });
        }

        const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        await logActivity(req.user.id, 'PRODUCT_DELETED', { product_id: id });

        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bulk import products (CSV)
router.post('/bulk-import', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { products } = req.body; // Array of product objects

        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'Products array is required' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const importedProducts = [];
            const errors = [];

            for (let i = 0; i < products.length; i++) {
                const product = products[i];
                try {
                    const result = await client.query(
                        'INSERT INTO products (sku, name, description, brand, model_compatibility) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                        [product.sku, product.name, product.description, product.brand, product.model_compatibility]
                    );
                    importedProducts.push(result.rows[0]);
                } catch (error) {
                    errors.push({
                        row: i + 1,
                        sku: product.sku,
                        error: error.code === '23505' ? 'SKU already exists' : error.message
                    });
                }
            }

            await client.query('COMMIT');

            await logActivity(req.user.id, 'PRODUCTS_BULK_IMPORTED', { 
                imported_count: importedProducts.length,
                error_count: errors.length 
            });

            res.json({
                message: 'Bulk import completed',
                imported: importedProducts.length,
                errors: errors
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Bulk import error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Generate barcode for product
router.get('/:id/barcode', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query('SELECT sku FROM products WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // In a real implementation, you would generate an actual barcode image
        // For now, we'll return the SKU as the barcode data
        res.json({
            product_id: id,
            sku: result.rows[0].sku,
            barcode_data: result.rows[0].sku,
            barcode_url: `/api/products/${id}/barcode.png` // Would be actual barcode image URL
        });
    } catch (error) {
        console.error('Generate barcode error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

