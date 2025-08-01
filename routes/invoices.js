const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get all invoices with pagination and filters
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, customer_id, start_date, end_date } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramCount = 1;

        if (status) {
            whereClause += ` AND i.status = $${paramCount}`;
            queryParams.push(status);
            paramCount++;
        }

        if (customer_id) {
            whereClause += ` AND so.customer_id = $${paramCount}`;
            queryParams.push(customer_id);
            paramCount++;
        }

        if (start_date) {
            whereClause += ` AND i.invoice_date >= $${paramCount}`;
            queryParams.push(start_date);
            paramCount++;
        }

        if (end_date) {
            whereClause += ` AND i.invoice_date <= $${paramCount}`;
            queryParams.push(end_date);
            paramCount++;
        }

        const query = `
            SELECT i.*, so.id as sales_order_id, c.company_name as customer_name,
                   COALESCE(SUM(p.amount), 0) as paid_amount,
                   i.total_amount - COALESCE(SUM(p.amount), 0) as outstanding_amount
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN payments p ON i.id = p.invoice_id
            ${whereClause}
            GROUP BY i.id, so.id, c.company_name
            ORDER BY i.invoice_date DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        queryParams.push(limit, offset);
        const result = await pool.query(query, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(DISTINCT i.id) 
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            ${whereClause}
        `;
        const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            invoices: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get invoices error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get invoice by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const invoiceResult = await pool.query(`
            SELECT i.*, so.id as sales_order_id, c.company_name as customer_name,
                   c.contact_person, c.email, c.phone, c.address,
                   COALESCE(SUM(p.amount), 0) as paid_amount,
                   i.total_amount - COALESCE(SUM(p.amount), 0) as outstanding_amount
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN payments p ON i.id = p.invoice_id
            WHERE i.id = $1
            GROUP BY i.id, so.id, c.company_name, c.contact_person, c.email, c.phone, c.address
        `, [id]);

        if (invoiceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const itemsResult = await pool.query(`
            SELECT soi.*, p.name as product_name, p.sku, p.brand
            FROM sales_order_items soi
            JOIN products p ON soi.product_id = p.id
            WHERE soi.sales_order_id = $1
            ORDER BY p.name
        `, [invoiceResult.rows[0].sales_order_id]);

        const paymentsResult = await pool.query(`
            SELECT p.*, pg.name as payment_gateway_name
            FROM payments p
            LEFT JOIN payment_gateways pg ON p.payment_gateway_id = pg.id
            WHERE p.invoice_id = $1
            ORDER BY p.payment_date DESC
        `, [id]);

        const creditNotesResult = await pool.query(`
            SELECT * FROM credit_notes WHERE invoice_id = $1 ORDER BY credit_date DESC
        `, [id]);

        res.json({
            invoice: invoiceResult.rows[0],
            items: itemsResult.rows,
            payments: paymentsResult.rows,
            credit_notes: creditNotesResult.rows
        });
    } catch (error) {
        console.error('Get invoice error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create invoice from sales order
router.post('/', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('sales_order_id').isInt().withMessage('Sales order ID must be an integer'),
    body('due_date').isISO8601().withMessage('Due date must be a valid date')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { sales_order_id, due_date } = req.body;

        // Check if sales order exists and is confirmed/processing
        const orderResult = await pool.query(
            'SELECT * FROM sales_orders WHERE id = $1 AND status IN ($2, $3)',
            [sales_order_id, 'confirmed', 'processing']
        );

        if (orderResult.rows.length === 0) {
            return res.status(400).json({ error: 'Sales order not found or not in confirmed/processing status' });
        }

        const salesOrder = orderResult.rows[0];

        const result = await pool.query(
            'INSERT INTO invoices (sales_order_id, due_date, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING *',
            [sales_order_id, due_date, salesOrder.total_amount, 'pending']
        );

        await logActivity(req.user.id, 'INVOICE_CREATED', {
            invoice_id: result.rows[0].id,
            sales_order_id,
            total_amount: salesOrder.total_amount
        });

        res.status(201).json({
            message: 'Invoice created successfully',
            invoice: result.rows[0]
        });
    } catch (error) {
        console.error('Create invoice error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update invoice status
router.put('/:id/status', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('status').isIn(['pending', 'sent', 'paid', 'overdue', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { status } = req.body;

        const result = await pool.query(
            'UPDATE invoices SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        await logActivity(req.user.id, 'INVOICE_STATUS_UPDATED', {
            invoice_id: id,
            new_status: status
        });

        res.json({
            message: 'Invoice status updated successfully',
            invoice: result.rows[0]
        });
    } catch (error) {
        console.error('Update invoice status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Record payment
router.post('/:id/payments', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('amount').isDecimal({ decimal_digits: '0,2' }).withMessage('Amount must be a valid decimal'),
    body('payment_gateway_id').optional().isInt().withMessage('Payment gateway ID must be an integer'),
    body('transaction_id').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { amount, payment_gateway_id, transaction_id } = req.body;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if invoice exists
            const invoiceResult = await client.query('SELECT * FROM invoices WHERE id = $1', [id]);
            if (invoiceResult.rows.length === 0) {
                throw new Error('Invoice not found');
            }

            const invoice = invoiceResult.rows[0];

            // Get total paid amount
            const paidResult = await client.query(
                'SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = $1',
                [id]
            );
            const totalPaid = parseFloat(paidResult.rows[0].total_paid);
            const newTotalPaid = totalPaid + parseFloat(amount);

            if (newTotalPaid > parseFloat(invoice.total_amount)) {
                throw new Error('Payment amount exceeds invoice total');
            }

            // Record payment
            const paymentResult = await client.query(
                'INSERT INTO payments (invoice_id, payment_gateway_id, amount, transaction_id) VALUES ($1, $2, $3, $4) RETURNING *',
                [id, payment_gateway_id, amount, transaction_id]
            );

            // Update invoice status if fully paid
            if (newTotalPaid >= parseFloat(invoice.total_amount)) {
                await client.query('UPDATE invoices SET status = $1 WHERE id = $2', ['paid', id]);
            }

            await client.query('COMMIT');

            await logActivity(req.user.id, 'PAYMENT_RECORDED', {
                invoice_id: id,
                payment_id: paymentResult.rows[0].id,
                amount: parseFloat(amount)
            });

            res.status(201).json({
                message: 'Payment recorded successfully',
                payment: paymentResult.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Record payment error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Create credit note
router.post('/:id/credit-notes', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('amount').isDecimal({ decimal_digits: '0,2' }).withMessage('Amount must be a valid decimal'),
    body('reason').notEmpty().withMessage('Reason is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { id } = req.params;
        const { amount, reason } = req.body;

        // Check if invoice exists
        const invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
        if (invoiceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const result = await pool.query(
            'INSERT INTO credit_notes (invoice_id, amount, reason) VALUES ($1, $2, $3) RETURNING *',
            [id, amount, reason]
        );

        await logActivity(req.user.id, 'CREDIT_NOTE_CREATED', {
            invoice_id: id,
            credit_note_id: result.rows[0].id,
            amount: parseFloat(amount)
        });

        res.status(201).json({
            message: 'Credit note created successfully',
            credit_note: result.rows[0]
        });
    } catch (error) {
        console.error('Create credit note error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Generate invoice PDF (placeholder)
router.get('/:id/pdf', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // In a real implementation, you would generate a PDF using a library like PDFKit or Puppeteer
        // For now, we'll return a placeholder response
        res.json({
            message: 'PDF generation not implemented yet',
            download_url: `/api/invoices/${id}/download.pdf`
        });
    } catch (error) {
        console.error('Generate invoice PDF error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get overdue invoices
router.get('/reports/overdue', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.*, so.id as sales_order_id, c.company_name as customer_name,
                   COALESCE(SUM(p.amount), 0) as paid_amount,
                   i.total_amount - COALESCE(SUM(p.amount), 0) as outstanding_amount,
                   CURRENT_DATE - i.due_date as days_overdue
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN payments p ON i.id = p.invoice_id
            WHERE i.due_date < CURRENT_DATE 
            AND i.status NOT IN ('paid', 'cancelled')
            GROUP BY i.id, so.id, c.company_name
            HAVING i.total_amount - COALESCE(SUM(p.amount), 0) > 0
            ORDER BY days_overdue DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Get overdue invoices error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

