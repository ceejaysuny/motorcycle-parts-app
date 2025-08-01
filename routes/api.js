const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// API Documentation endpoint
router.get('/docs', (req, res) => {
    res.json({
        title: 'Motorcycle Parts Management API',
        version: '1.0.0',
        description: 'RESTful API for motorcycle parts business and inventory management',
        base_url: '/api',
        authentication: {
            type: 'Bearer Token',
            header: 'Authorization: Bearer <token>',
            login_endpoint: '/api/auth/login'
        },
        endpoints: {
            authentication: {
                'POST /auth/register': 'Register new user',
                'POST /auth/login': 'User login',
                'POST /auth/forgot-password': 'Request password reset',
                'POST /auth/reset-password': 'Reset password'
            },
            users: {
                'GET /users': 'Get all users (admin only)',
                'GET /users/:id': 'Get user by ID',
                'PUT /users/:id': 'Update user',
                'DELETE /users/:id': 'Delete user (admin only)',
                'GET /users/roles/list': 'Get all roles',
                'GET /users/audit/logs': 'Get audit logs (admin only)'
            },
            products: {
                'GET /products': 'Get all products with pagination and search',
                'GET /products/:id': 'Get product by ID',
                'POST /products': 'Create new product',
                'PUT /products/:id': 'Update product',
                'DELETE /products/:id': 'Delete product',
                'POST /products/bulk-import': 'Bulk import products',
                'GET /products/:id/barcode': 'Generate barcode for product'
            },
            inventory: {
                'GET /inventory': 'Get inventory with pagination and filters',
                'GET /inventory/product/:productId': 'Get inventory for specific product',
                'PUT /inventory/:id': 'Update inventory (stock adjustment)',
                'POST /inventory': 'Add inventory for new product-warehouse combination',
                'GET /inventory/alerts/low-stock': 'Get low stock alerts',
                'POST /inventory/alerts/threshold': 'Set low stock threshold',
                'GET /inventory/reorder-suggestions': 'Get reorder suggestions',
                'GET /inventory/warehouses': 'Get warehouses',
                'POST /inventory/warehouses': 'Create warehouse'
            },
            suppliers: {
                'GET /suppliers': 'Get all suppliers',
                'GET /suppliers/:id': 'Get supplier by ID',
                'POST /suppliers': 'Create supplier',
                'PUT /suppliers/:id': 'Update supplier',
                'DELETE /suppliers/:id': 'Delete supplier',
                'GET /suppliers/:id/performance': 'Get supplier performance metrics'
            },
            customers: {
                'GET /customers': 'Get all customers',
                'GET /customers/:id': 'Get customer by ID',
                'POST /customers': 'Create customer',
                'PUT /customers/:id': 'Update customer',
                'DELETE /customers/:id': 'Delete customer',
                'GET /customers/:id/sales-history': 'Get customer sales history'
            },
            purchase_orders: {
                'GET /purchase-orders': 'Get all purchase orders',
                'GET /purchase-orders/:id': 'Get purchase order by ID',
                'POST /purchase-orders': 'Create purchase order',
                'PUT /purchase-orders/:id/status': 'Update purchase order status',
                'PUT /purchase-orders/:id/approve': 'Approve purchase order',
                'POST /purchase-orders/:id/receive': 'Receive purchase order',
                'GET /purchase-orders/supplier/:supplierId/history': 'Get supplier purchase order history'
            },
            sales_orders: {
                'GET /sales-orders': 'Get all sales orders',
                'GET /sales-orders/:id': 'Get sales order by ID',
                'POST /sales-orders': 'Create sales order (quotation)',
                'PUT /sales-orders/:id/status': 'Update sales order status',
                'PUT /sales-orders/:id/approve': 'Approve sales order',
                'PUT /sales-orders/:id/process': 'Process sales order (reduce inventory)',
                'POST /sales-orders/:id/return': 'Create return/exchange',
                'GET /sales-orders/analytics/summary': 'Get sales analytics'
            },
            invoices: {
                'GET /invoices': 'Get all invoices',
                'GET /invoices/:id': 'Get invoice by ID',
                'POST /invoices': 'Create invoice from sales order',
                'PUT /invoices/:id/status': 'Update invoice status',
                'POST /invoices/:id/payments': 'Record payment',
                'POST /invoices/:id/credit-notes': 'Create credit note',
                'GET /invoices/:id/pdf': 'Generate invoice PDF',
                'GET /invoices/reports/overdue': 'Get overdue invoices'
            },
            reports: {
                'GET /reports/profit-loss': 'Get profit and loss report',
                'GET /reports/balance-sheet': 'Get balance sheet',
                'GET /reports/cash-flow': 'Get cash flow report',
                'GET /reports/sales-performance': 'Get sales performance dashboard',
                'GET /reports/inventory-valuation': 'Get inventory valuation report',
                'GET /reports/accounts-receivable-aging': 'Get accounts receivable aging report',
                'POST /reports/custom': 'Create custom report',
                'GET /reports/tax-summary': 'Get tax calculation summary'
            },
            notifications: {
                'GET /notifications': 'Get notifications for current user',
                'PUT /notifications/:id/read': 'Mark notification as read',
                'PUT /notifications/mark-all-read': 'Mark all notifications as read',
                'POST /notifications/check-low-stock': 'Check and send low stock alerts',
                'POST /notifications/check-overdue-invoices': 'Check and send overdue invoice alerts',
                'POST /notifications/purchase-order-status': 'Send purchase order status notifications',
                'GET /notifications/summary': 'Get daily/weekly summary',
                'POST /notifications/send-summary': 'Send daily/weekly summary email'
            }
        },
        data_formats: {
            pagination: {
                page: 'Page number (default: 1)',
                limit: 'Items per page (default: 20)',
                total: 'Total number of items',
                pages: 'Total number of pages'
            },
            date_format: 'ISO 8601 (YYYY-MM-DD)',
            currency_format: 'Decimal with 2 decimal places'
        }
    });
});

// Webhook endpoints for third-party integrations
router.post('/webhooks/payment', [
    body('invoice_id').isInt().withMessage('Invoice ID must be an integer'),
    body('amount').isDecimal().withMessage('Amount must be a decimal'),
    body('transaction_id').notEmpty().withMessage('Transaction ID is required'),
    body('status').isIn(['success', 'failed', 'pending']).withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { invoice_id, amount, transaction_id, status, gateway } = req.body;

        if (status === 'success') {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Record payment
                await client.query(
                    'INSERT INTO payments (invoice_id, amount, transaction_id) VALUES ($1, $2, $3)',
                    [invoice_id, amount, transaction_id]
                );

                // Check if invoice is fully paid
                const invoiceResult = await client.query('SELECT total_amount FROM invoices WHERE id = $1', [invoice_id]);
                const paidResult = await client.query(
                    'SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = $1',
                    [invoice_id]
                );

                if (invoiceResult.rows.length > 0) {
                    const totalAmount = parseFloat(invoiceResult.rows[0].total_amount);
                    const totalPaid = parseFloat(paidResult.rows[0].total_paid);

                    if (totalPaid >= totalAmount) {
                        await client.query('UPDATE invoices SET status = $1 WHERE id = $2', ['paid', invoice_id]);
                    }
                }

                await client.query('COMMIT');

                res.json({ message: 'Payment webhook processed successfully' });
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } else {
            res.json({ message: 'Payment webhook received' });
        }
    } catch (error) {
        console.error('Payment webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Export data endpoints
router.get('/export/products', authenticateToken, async (req, res) => {
    try {
        const { format = 'json' } = req.query;

        const result = await pool.query(`
            SELECT p.*, COALESCE(SUM(i.quantity), 0) as total_stock
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            GROUP BY p.id
            ORDER BY p.name
        `);

        if (format === 'csv') {
            const csv = [
                'ID,SKU,Name,Description,Brand,Model Compatibility,Total Stock,Created At',
                ...result.rows.map(row => 
                    `${row.id},"${row.sku}","${row.name}","${row.description || ''}","${row.brand || ''}","${row.model_compatibility || ''}",${row.total_stock},"${row.created_at}"`
                )
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
            res.send(csv);
        } else {
            res.json(result.rows);
        }

        await logActivity(req.user.id, 'PRODUCTS_EXPORTED', { format, count: result.rows.length });
    } catch (error) {
        console.error('Export products error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/export/customers', authenticateToken, async (req, res) => {
    try {
        const { format = 'json' } = req.query;

        const result = await pool.query(`
            SELECT c.*, 
                   COUNT(so.id) as total_orders,
                   COALESCE(SUM(so.total_amount), 0) as total_sales
            FROM customers c
            LEFT JOIN sales_orders so ON c.id = so.customer_id
            GROUP BY c.id
            ORDER BY c.company_name
        `);

        if (format === 'csv') {
            const csv = [
                'ID,Company Name,Contact Person,Email,Phone,Address,Total Orders,Total Sales',
                ...result.rows.map(row => 
                    `${row.id},"${row.company_name}","${row.contact_person || ''}","${row.email || ''}","${row.phone || ''}","${row.address || ''}",${row.total_orders},${row.total_sales}`
                )
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
            res.send(csv);
        } else {
            res.json(result.rows);
        }

        await logActivity(req.user.id, 'CUSTOMERS_EXPORTED', { format, count: result.rows.length });
    } catch (error) {
        console.error('Export customers error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Import data endpoints
router.post('/import/products', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('products').isArray().withMessage('Products must be an array'),
    body('products.*.sku').notEmpty().withMessage('SKU is required'),
    body('products.*.name').notEmpty().withMessage('Product name is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { products } = req.body;

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

            await logActivity(req.user.id, 'PRODUCTS_IMPORTED', { 
                imported_count: importedProducts.length,
                error_count: errors.length 
            });

            res.json({
                message: 'Product import completed',
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
        console.error('Import products error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
router.get('/health', async (req, res) => {
    try {
        // Check database connection
        const dbResult = await pool.query('SELECT 1');
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: dbResult.rows.length > 0 ? 'connected' : 'disconnected',
            version: '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            error: error.message
        });
    }
});

// API statistics endpoint
router.get('/stats', authenticateToken, authorizeRole(['administrator']), async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM products) as total_products,
                (SELECT COUNT(*) FROM customers) as total_customers,
                (SELECT COUNT(*) FROM suppliers) as total_suppliers,
                (SELECT COUNT(*) FROM sales_orders) as total_sales_orders,
                (SELECT COUNT(*) FROM purchase_orders) as total_purchase_orders,
                (SELECT COUNT(*) FROM invoices) as total_invoices,
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM audit_logs WHERE timestamp >= CURRENT_DATE) as todays_activities
        `);

        res.json({
            api_version: '1.0.0',
            statistics: stats.rows[0],
            generated_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Get API stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

