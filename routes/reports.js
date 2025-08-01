const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get profit and loss report
router.get('/profit-loss', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        let dateFilter = '';
        const queryParams = [];
        let paramCount = 1;

        if (start_date) {
            dateFilter += ` AND t.transaction_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            dateFilter += ` AND t.transaction_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        const result = await pool.query(`
            SELECT 
                SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END) as total_revenue,
                SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END) as total_purchases,
                SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END) - 
                SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END) as gross_profit,
                COUNT(CASE WHEN t.type = 'sale' THEN 1 END) as total_sales_transactions,
                COUNT(CASE WHEN t.type = 'purchase' THEN 1 END) as total_purchase_transactions
            FROM transactions t
            WHERE 1=1 ${dateFilter}
        `, queryParams);

        // Get monthly breakdown
        const monthlyResult = await pool.query(`
            SELECT 
                DATE_TRUNC('month', t.transaction_date) as month,
                SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END) as revenue,
                SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END) as purchases,
                SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END) - 
                SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END) as profit
            FROM transactions t
            WHERE 1=1 ${dateFilter}
            GROUP BY DATE_TRUNC('month', t.transaction_date)
            ORDER BY month
        `, queryParams);

        res.json({
            summary: result.rows[0],
            monthly_breakdown: monthlyResult.rows
        });
    } catch (error) {
        console.error('Get profit and loss report error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get balance sheet
router.get('/balance-sheet', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { as_of_date = new Date().toISOString().split('T')[0] } = req.query;

        // Assets
        const inventoryValue = await pool.query(`
            SELECT COALESCE(SUM(i.quantity * COALESCE(poi.unit_price, 0)), 0) as inventory_value
            FROM inventory i
            LEFT JOIN products p ON i.product_id = p.id
            LEFT JOIN purchase_order_items poi ON p.id = poi.product_id
            LEFT JOIN purchase_orders po ON poi.purchase_order_id = po.id
            WHERE po.order_date = (
                SELECT MAX(po2.order_date) 
                FROM purchase_orders po2 
                JOIN purchase_order_items poi2 ON po2.id = poi2.purchase_order_id 
                WHERE poi2.product_id = p.id AND po2.order_date <= $1
            ) OR po.order_date IS NULL
        `, [as_of_date]);

        const accountsReceivable = await pool.query(`
            SELECT COALESCE(SUM(i.total_amount - COALESCE(p.paid_amount, 0)), 0) as accounts_receivable
            FROM invoices i
            LEFT JOIN (
                SELECT invoice_id, SUM(amount) as paid_amount
                FROM payments
                WHERE payment_date <= $1
                GROUP BY invoice_id
            ) p ON i.id = p.invoice_id
            WHERE i.invoice_date <= $1 AND i.status != 'cancelled'
        `, [as_of_date]);

        // Liabilities
        const accountsPayable = await pool.query(`
            SELECT COALESCE(SUM(po.total_amount), 0) as accounts_payable
            FROM purchase_orders po
            WHERE po.order_date <= $1 AND po.status IN ('approved', 'sent') 
        `, [as_of_date]);

        res.json({
            as_of_date,
            assets: {
                inventory_value: parseFloat(inventoryValue.rows[0].inventory_value),
                accounts_receivable: parseFloat(accountsReceivable.rows[0].accounts_receivable),
                total_assets: parseFloat(inventoryValue.rows[0].inventory_value) + parseFloat(accountsReceivable.rows[0].accounts_receivable)
            },
            liabilities: {
                accounts_payable: parseFloat(accountsPayable.rows[0].accounts_payable),
                total_liabilities: parseFloat(accountsPayable.rows[0].accounts_payable)
            },
            equity: {
                retained_earnings: (parseFloat(inventoryValue.rows[0].inventory_value) + parseFloat(accountsReceivable.rows[0].accounts_receivable)) - parseFloat(accountsPayable.rows[0].accounts_payable)
            }
        });
    } catch (error) {
        console.error('Get balance sheet error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get cash flow report
router.get('/cash-flow', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        let dateFilter = '';
        const queryParams = [];
        let paramCount = 1;

        if (start_date) {
            dateFilter += ` AND payment_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            dateFilter += ` AND payment_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        // Cash inflows (payments received)
        const cashInflows = await pool.query(`
            SELECT 
                DATE_TRUNC('month', p.payment_date) as month,
                SUM(p.amount) as cash_inflow
            FROM payments p
            WHERE 1=1 ${dateFilter}
            GROUP BY DATE_TRUNC('month', p.payment_date)
            ORDER BY month
        `, queryParams);

        // Cash outflows (payments made to suppliers - simplified)
        const cashOutflows = await pool.query(`
            SELECT 
                DATE_TRUNC('month', po.order_date) as month,
                SUM(po.total_amount) as cash_outflow
            FROM purchase_orders po
            WHERE po.status = 'completed' ${dateFilter.replace('payment_date', 'po.order_date')}
            GROUP BY DATE_TRUNC('month', po.order_date)
            ORDER BY month
        `, queryParams);

        // Combine and calculate net cash flow
        const months = new Set([
            ...cashInflows.rows.map(row => row.month),
            ...cashOutflows.rows.map(row => row.month)
        ]);

        const cashFlow = Array.from(months).sort().map(month => {
            const inflow = cashInflows.rows.find(row => row.month === month)?.cash_inflow || 0;
            const outflow = cashOutflows.rows.find(row => row.month === month)?.cash_outflow || 0;
            return {
                month,
                cash_inflow: parseFloat(inflow),
                cash_outflow: parseFloat(outflow),
                net_cash_flow: parseFloat(inflow) - parseFloat(outflow)
            };
        });

        res.json({
            cash_flow_by_month: cashFlow,
            summary: {
                total_inflows: cashFlow.reduce((sum, item) => sum + item.cash_inflow, 0),
                total_outflows: cashFlow.reduce((sum, item) => sum + item.cash_outflow, 0),
                net_cash_flow: cashFlow.reduce((sum, item) => sum + item.net_cash_flow, 0)
            }
        });
    } catch (error) {
        console.error('Get cash flow report error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get sales performance dashboard
router.get('/sales-performance', authenticateToken, async (req, res) => {
    try {
        const { start_date, end_date, group_by = 'month' } = req.query;

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

        const dateGrouping = group_by === 'week' ? 'week' : group_by === 'day' ? 'day' : 'month';

        // Sales by period
        const salesByPeriod = await pool.query(`
            SELECT 
                DATE_TRUNC('${dateGrouping}', so.order_date) as period,
                COUNT(*) as order_count,
                SUM(so.total_amount) as total_sales,
                AVG(so.total_amount) as avg_order_value,
                COUNT(DISTINCT so.customer_id) as unique_customers
            FROM sales_orders so
            WHERE so.status = 'completed' ${dateFilter}
            GROUP BY DATE_TRUNC('${dateGrouping}', so.order_date)
            ORDER BY period
        `, queryParams);

        // Top products
        const topProducts = await pool.query(`
            SELECT 
                p.name as product_name,
                p.sku,
                SUM(soi.quantity) as total_quantity_sold,
                SUM(soi.quantity * soi.unit_price) as total_revenue
            FROM sales_order_items soi
            JOIN products p ON soi.product_id = p.id
            JOIN sales_orders so ON soi.sales_order_id = so.id
            WHERE so.status = 'completed' ${dateFilter}
            GROUP BY p.id, p.name, p.sku
            ORDER BY total_revenue DESC
            LIMIT 10
        `, queryParams);

        // Top customers
        const topCustomers = await pool.query(`
            SELECT 
                c.company_name,
                COUNT(so.id) as order_count,
                SUM(so.total_amount) as total_spent,
                AVG(so.total_amount) as avg_order_value
            FROM customers c
            JOIN sales_orders so ON c.id = so.customer_id
            WHERE so.status = 'completed' ${dateFilter}
            GROUP BY c.id, c.company_name
            ORDER BY total_spent DESC
            LIMIT 10
        `, queryParams);

        res.json({
            sales_by_period: salesByPeriod.rows,
            top_products: topProducts.rows,
            top_customers: topCustomers.rows
        });
    } catch (error) {
        console.error('Get sales performance error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get inventory valuation report
router.get('/inventory-valuation', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { method = 'fifo', as_of_date = new Date().toISOString().split('T')[0] } = req.query;

        // Simplified inventory valuation (FIFO method)
        const result = await pool.query(`
            SELECT 
                p.id as product_id,
                p.name as product_name,
                p.sku,
                w.name as warehouse_name,
                i.quantity,
                COALESCE(poi.unit_price, 0) as unit_cost,
                i.quantity * COALESCE(poi.unit_price, 0) as total_value
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN purchase_order_items poi ON p.id = poi.product_id
            LEFT JOIN purchase_orders po ON poi.purchase_order_id = po.id
            WHERE i.quantity > 0
            AND (po.order_date = (
                SELECT MAX(po2.order_date) 
                FROM purchase_orders po2 
                JOIN purchase_order_items poi2 ON po2.id = poi2.purchase_order_id 
                WHERE poi2.product_id = p.id AND po2.order_date <= $1
            ) OR po.order_date IS NULL)
            ORDER BY p.name, w.name
        `, [as_of_date]);

        const summary = await pool.query(`
            SELECT 
                COUNT(DISTINCT p.id) as total_products,
                SUM(i.quantity) as total_quantity,
                SUM(i.quantity * COALESCE(poi.unit_price, 0)) as total_value
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            LEFT JOIN purchase_order_items poi ON p.id = poi.product_id
            LEFT JOIN purchase_orders po ON poi.purchase_order_id = po.id
            WHERE i.quantity > 0
            AND (po.order_date = (
                SELECT MAX(po2.order_date) 
                FROM purchase_orders po2 
                JOIN purchase_order_items poi2 ON po2.id = poi2.purchase_order_id 
                WHERE poi2.product_id = p.id AND po2.order_date <= $1
            ) OR po.order_date IS NULL)
        `, [as_of_date]);

        res.json({
            method,
            as_of_date,
            summary: summary.rows[0],
            details: result.rows
        });
    } catch (error) {
        console.error('Get inventory valuation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get accounts receivable aging report
router.get('/accounts-receivable-aging', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.company_name as customer_name,
                i.id as invoice_id,
                i.invoice_date,
                i.due_date,
                i.total_amount,
                COALESCE(p.paid_amount, 0) as paid_amount,
                i.total_amount - COALESCE(p.paid_amount, 0) as outstanding_amount,
                CURRENT_DATE - i.due_date as days_overdue,
                CASE 
                    WHEN CURRENT_DATE <= i.due_date THEN 'Current'
                    WHEN CURRENT_DATE - i.due_date <= 30 THEN '1-30 days'
                    WHEN CURRENT_DATE - i.due_date <= 60 THEN '31-60 days'
                    WHEN CURRENT_DATE - i.due_date <= 90 THEN '61-90 days'
                    ELSE '90+ days'
                END as aging_bucket
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN (
                SELECT invoice_id, SUM(amount) as paid_amount
                FROM payments
                GROUP BY invoice_id
            ) p ON i.id = p.invoice_id
            WHERE i.status NOT IN ('paid', 'cancelled')
            AND i.total_amount - COALESCE(p.paid_amount, 0) > 0
            ORDER BY days_overdue DESC, outstanding_amount DESC
        `);

        // Summary by aging bucket
        const summary = await pool.query(`
            SELECT 
                aging_bucket,
                COUNT(*) as invoice_count,
                SUM(outstanding_amount) as total_outstanding
            FROM (
                SELECT 
                    i.total_amount - COALESCE(p.paid_amount, 0) as outstanding_amount,
                    CASE 
                        WHEN CURRENT_DATE <= i.due_date THEN 'Current'
                        WHEN CURRENT_DATE - i.due_date <= 30 THEN '1-30 days'
                        WHEN CURRENT_DATE - i.due_date <= 60 THEN '31-60 days'
                        WHEN CURRENT_DATE - i.due_date <= 90 THEN '61-90 days'
                        ELSE '90+ days'
                    END as aging_bucket
                FROM invoices i
                LEFT JOIN (
                    SELECT invoice_id, SUM(amount) as paid_amount
                    FROM payments
                    GROUP BY invoice_id
                ) p ON i.id = p.invoice_id
                WHERE i.status NOT IN ('paid', 'cancelled')
                AND i.total_amount - COALESCE(p.paid_amount, 0) > 0
            ) aged_invoices
            GROUP BY aging_bucket
            ORDER BY 
                CASE aging_bucket
                    WHEN 'Current' THEN 1
                    WHEN '1-30 days' THEN 2
                    WHEN '31-60 days' THEN 3
                    WHEN '61-90 days' THEN 4
                    WHEN '90+ days' THEN 5
                END
        `);

        res.json({
            summary: summary.rows,
            details: result.rows
        });
    } catch (error) {
        console.error('Get accounts receivable aging error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create custom report
router.post('/custom', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('name').notEmpty().withMessage('Report name is required'),
    body('query').notEmpty().withMessage('SQL query is required'),
    body('description').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, query, description } = req.body;

        // Basic SQL injection protection (in production, use a proper query builder)
        const allowedKeywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN'];
        const upperQuery = query.toUpperCase();
        
        if (upperQuery.includes('DROP') || upperQuery.includes('DELETE') || upperQuery.includes('UPDATE') || upperQuery.includes('INSERT')) {
            return res.status(400).json({ error: 'Only SELECT queries are allowed' });
        }

        try {
            const result = await pool.query(query);
            
            await logActivity(req.user.id, 'CUSTOM_REPORT_EXECUTED', {
                report_name: name,
                query_length: query.length
            });

            res.json({
                name,
                description,
                executed_at: new Date().toISOString(),
                row_count: result.rows.length,
                data: result.rows
            });
        } catch (queryError) {
            res.status(400).json({ error: 'Invalid SQL query: ' + queryError.message });
        }
    } catch (error) {
        console.error('Execute custom report error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get tax calculation summary
router.get('/tax-summary', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const { start_date, end_date, tax_rate = 0.1 } = req.query;

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
                SUM(so.total_amount) as total_sales,
                SUM(so.total_amount * $${paramCount}) as total_tax_collected,
                COUNT(*) as total_transactions
            FROM sales_orders so
            WHERE so.status = 'completed' ${dateFilter}
        `, [...queryParams, tax_rate]);

        res.json({
            tax_rate: parseFloat(tax_rate),
            period: { start_date, end_date },
            summary: result.rows[0]
        });
    } catch (error) {
        console.error('Get tax summary error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

