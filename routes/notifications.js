const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');
const nodemailer = require('nodemailer');

const router = express.Router();

// Email configuration (in production, use environment variables)
const emailTransporter = nodemailer.createTransport({  // Changed from createTransporter to createTransport
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER || 'your-email@gmail.com',
        pass: process.env.SMTP_PASS || 'your-app-password'
    }
});

// Get notifications for current user
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, is_read } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE user_id = $1';
        const queryParams = [req.user.id];
        let paramCount = 2;

        if (is_read !== undefined) {
            whereClause += ` AND is_read = $${paramCount}`;
            queryParams.push(is_read === 'true');
            paramCount++;
        }

        const result = await pool.query(`
            SELECT * FROM notifications
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `, [...queryParams, limit, offset]);

        const countResult = await pool.query(`
            SELECT COUNT(*) FROM notifications ${whereClause}
        `, queryParams.slice(0, -2));
        const total = parseInt(countResult.rows[0].count);

        res.json({
            notifications: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({
            message: 'Notification marked as read',
            notification: result.rows[0]
        });
    } catch (error) {
        console.error('Mark notification as read error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Mark all notifications as read
router.put('/mark-all-read', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
            [req.user.id]
        );

        res.json({
            message: 'All notifications marked as read',
            updated_count: result.rowCount
        });
    } catch (error) {
        console.error('Mark all notifications as read error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create notification (internal use)
const createNotification = async (userId, type, message) => {
    try {
        await pool.query(
            'INSERT INTO notifications (user_id, type, message) VALUES ($1, $2, $3)',
            [userId, type, message]
        );
    } catch (error) {
        console.error('Create notification error:', error);
    }
};

// Send email notification
const sendEmailNotification = async (to, subject, message) => {
    try {
        await emailTransporter.sendMail({
            from: process.env.SMTP_FROM || 'noreply@motorcycleparts.com',
            to,
            subject,
            text: message,
            html: `<p>${message}</p>`
        });
    } catch (error) {
        console.error('Send email error:', error);
    }
};

// Check and send low stock alerts
router.post('/check-low-stock', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const lowStockItems = await pool.query(`
            SELECT i.*, p.name as product_name, p.sku, w.name as warehouse_name,
                   lsa.threshold, lsa.alert_sent_at
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN warehouses w ON i.warehouse_id = w.id
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.quantity <= COALESCE(lsa.threshold, 10)
            AND (lsa.alert_sent_at IS NULL OR lsa.alert_sent_at < CURRENT_DATE - INTERVAL '1 day')
        `);

        let alertsSent = 0;

        for (const item of lowStockItems.rows) {
            const message = `Low stock alert: ${item.product_name} (${item.sku}) in ${item.warehouse_name} has only ${item.quantity} units remaining (threshold: ${item.threshold || 10})`;

            // Get users who should receive alerts (administrators and managers)
            const usersResult = await pool.query(`
                SELECT u.id, u.email FROM users u
                JOIN roles r ON u.role_id = r.id
                WHERE r.name IN ('administrator', 'manager')
            `);

            for (const user of usersResult.rows) {
                await createNotification(user.id, 'low_stock', message);
                if (user.email) {
                    await sendEmailNotification(user.email, 'Low Stock Alert', message);
                }
            }

            // Update alert sent timestamp
            await pool.query(
                'UPDATE low_stock_alerts SET alert_sent_at = CURRENT_TIMESTAMP WHERE product_id = $1 AND warehouse_id = $2',
                [item.product_id, item.warehouse_id]
            );

            alertsSent++;
        }

        await logActivity(req.user.id, 'LOW_STOCK_ALERTS_SENT', { alerts_sent: alertsSent });

        res.json({
            message: `Low stock alerts checked and sent`,
            alerts_sent: alertsSent,
            low_stock_items: lowStockItems.rows.length
        });
    } catch (error) {
        console.error('Check low stock alerts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Check and send overdue invoice alerts
router.post('/check-overdue-invoices', authenticateToken, authorizeRole(['administrator', 'manager']), async (req, res) => {
    try {
        const overdueInvoices = await pool.query(`
            SELECT i.*, c.company_name as customer_name, c.email as customer_email,
                   i.total_amount - COALESCE(p.paid_amount, 0) as outstanding_amount,
                   CURRENT_DATE - i.due_date as days_overdue
            FROM invoices i
            JOIN sales_orders so ON i.sales_order_id = so.id
            JOIN customers c ON so.customer_id = c.id
            LEFT JOIN (
                SELECT invoice_id, SUM(amount) as paid_amount
                FROM payments
                GROUP BY invoice_id
            ) p ON i.id = p.invoice_id
            WHERE i.due_date < CURRENT_DATE 
            AND i.status NOT IN ('paid', 'cancelled')
            AND i.total_amount - COALESCE(p.paid_amount, 0) > 0
        `);

        let alertsSent = 0;

        for (const invoice of overdueInvoices.rows) {
            const message = `Overdue invoice alert: Invoice #${invoice.id} for ${invoice.customer_name} is ${invoice.days_overdue} days overdue. Outstanding amount: $${invoice.outstanding_amount}`;

            // Get users who should receive alerts
            const usersResult = await pool.query(`
                SELECT u.id, u.email FROM users u
                JOIN roles r ON u.role_id = r.id
                WHERE r.name IN ('administrator', 'manager')
            `);

            for (const user of usersResult.rows) {
                await createNotification(user.id, 'overdue_invoice', message);
                if (user.email) {
                    await sendEmailNotification(user.email, 'Overdue Invoice Alert', message);
                }
            }

            // Send reminder to customer if email exists
            if (invoice.customer_email) {
                const customerMessage = `Dear ${invoice.customer_name}, your invoice #${invoice.id} is ${invoice.days_overdue} days overdue. Please arrange payment of $${invoice.outstanding_amount} at your earliest convenience.`;
                await sendEmailNotification(invoice.customer_email, 'Payment Reminder', customerMessage);
            }

            alertsSent++;
        }

        await logActivity(req.user.id, 'OVERDUE_INVOICE_ALERTS_SENT', { alerts_sent: alertsSent });

        res.json({
            message: `Overdue invoice alerts checked and sent`,
            alerts_sent: alertsSent,
            overdue_invoices: overdueInvoices.rows.length
        });
    } catch (error) {
        console.error('Check overdue invoices error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send purchase order status notifications
router.post('/purchase-order-status', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('purchase_order_id').isInt().withMessage('Purchase order ID must be an integer'),
    body('status').notEmpty().withMessage('Status is required'),
    body('message').optional().isString()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { purchase_order_id, status, message } = req.body;

        // Get purchase order details
        const poResult = await pool.query(`
            SELECT po.*, s.name as supplier_name, s.email as supplier_email
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            WHERE po.id = $1
        `, [purchase_order_id]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];
        const notificationMessage = message || `Purchase order #${purchase_order_id} status updated to: ${status}`;

        // Notify relevant users
        const usersResult = await pool.query(`
            SELECT u.id, u.email FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE r.name IN ('administrator', 'manager')
        `);

        for (const user of usersResult.rows) {
            await createNotification(user.id, 'purchase_order_status', notificationMessage);
            if (user.email) {
                await sendEmailNotification(user.email, 'Purchase Order Status Update', notificationMessage);
            }
        }

        // Notify supplier if email exists
        if (po.supplier_email) {
            const supplierMessage = `Dear ${po.supplier_name}, your purchase order #${purchase_order_id} status has been updated to: ${status}`;
            await sendEmailNotification(po.supplier_email, 'Purchase Order Status Update', supplierMessage);
        }

        await logActivity(req.user.id, 'PURCHASE_ORDER_STATUS_NOTIFICATION_SENT', {
            purchase_order_id,
            status
        });

        res.json({
            message: 'Purchase order status notifications sent successfully'
        });
    } catch (error) {
        console.error('Send purchase order status notification error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get daily/weekly summary
router.get('/summary', authenticateToken, async (req, res) => {
    try {
        const { period = 'daily' } = req.query;
        const startDate = period === 'weekly' ? 
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] :
            new Date().toISOString().split('T')[0];

        // Get summary data
        const salesSummary = await pool.query(`
            SELECT 
                COUNT(*) as order_count,
                COALESCE(SUM(total_amount), 0) as total_sales
            FROM sales_orders
            WHERE order_date >= $1 AND status = 'completed'
        `, [startDate]);

        const lowStockCount = await pool.query(`
            SELECT COUNT(*) as low_stock_count
            FROM inventory i
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.quantity <= COALESCE(lsa.threshold, 10)
        `);

        const overdueInvoicesCount = await pool.query(`
            SELECT COUNT(*) as overdue_count
            FROM invoices i
            LEFT JOIN (
                SELECT invoice_id, SUM(amount) as paid_amount
                FROM payments
                GROUP BY invoice_id
            ) p ON i.id = p.invoice_id
            WHERE i.due_date < CURRENT_DATE 
            AND i.status NOT IN ('paid', 'cancelled')
            AND i.total_amount - COALESCE(p.paid_amount, 0) > 0
        `);

        const pendingOrders = await pool.query(`
            SELECT COUNT(*) as pending_count
            FROM purchase_orders
            WHERE status = 'pending'
        `);

        const summary = {
            period,
            date_range: { start: startDate, end: new Date().toISOString().split('T')[0] },
            sales: salesSummary.rows[0],
            alerts: {
                low_stock_items: parseInt(lowStockCount.rows[0].low_stock_count),
                overdue_invoices: parseInt(overdueInvoicesCount.rows[0].overdue_count),
                pending_purchase_orders: parseInt(pendingOrders.rows[0].pending_count)
            }
        };

        res.json(summary);
    } catch (error) {
        console.error('Get summary error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send daily/weekly summary email
router.post('/send-summary', authenticateToken, authorizeRole(['administrator', 'manager']), [
    body('period').isIn(['daily', 'weekly']).withMessage('Period must be daily or weekly'),
    body('recipients').isArray().withMessage('Recipients must be an array of email addresses')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { period, recipients } = req.body;

        // Get summary data (reuse logic from above)
        const startDate = period === 'weekly' ? 
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] :
            new Date().toISOString().split('T')[0];

        const salesSummary = await pool.query(`
            SELECT 
                COUNT(*) as order_count,
                COALESCE(SUM(total_amount), 0) as total_sales
            FROM sales_orders
            WHERE order_date >= $1 AND status = 'completed'
        `, [startDate]);

        const lowStockCount = await pool.query(`
            SELECT COUNT(*) as low_stock_count
            FROM inventory i
            LEFT JOIN low_stock_alerts lsa ON i.product_id = lsa.product_id AND i.warehouse_id = lsa.warehouse_id
            WHERE i.quantity <= COALESCE(lsa.threshold, 10)
        `);

        const overdueInvoicesCount = await pool.query(`
            SELECT COUNT(*) as overdue_count
            FROM invoices i
            LEFT JOIN (
                SELECT invoice_id, SUM(amount) as paid_amount
                FROM payments
                GROUP BY invoice_id
            ) p ON i.id = p.invoice_id
            WHERE i.due_date < CURRENT_DATE 
            AND i.status NOT IN ('paid', 'cancelled')
            AND i.total_amount - COALESCE(p.paid_amount, 0) > 0
        `);

        // Create email content
        const emailContent = `
${period.charAt(0).toUpperCase() + period.slice(1)} Business Summary

Sales Performance:
- Orders completed: ${salesSummary.rows[0].order_count}
- Total sales: $${salesSummary.rows[0].total_sales}

Alerts:
- Low stock items: ${lowStockCount.rows[0].low_stock_count}
- Overdue invoices: ${overdueInvoicesCount.rows[0].overdue_count}

This is an automated summary from your Motorcycle Parts Management System.
        `;

        // Send emails
        for (const email of recipients) {
            await sendEmailNotification(email, `${period.charAt(0).toUpperCase() + period.slice(1)} Business Summary`, emailContent);
        }

        await logActivity(req.user.id, 'SUMMARY_EMAIL_SENT', {
            period,
            recipients_count: recipients.length
        });

        res.json({
            message: `${period.charAt(0).toUpperCase() + period.slice(1)} summary sent successfully`,
            recipients_count: recipients.length
        });
    } catch (error) {
        console.error('Send summary email error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
// module.exports = {
//     router,
//     createNotification,
//     sendEmailNotification
// };

//module.exports = router;