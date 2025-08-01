const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
    // Remove potentially dangerous characters from string inputs
    const sanitize = (obj) => {
        for (let key in obj) {
            if (typeof obj[key] === 'string') {
                // Remove script tags and other potentially dangerous content
                obj[key] = obj[key]
                    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                    .replace(/javascript:/gi, '')
                    .replace(/on\w+\s*=/gi, '')
                    .trim();
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                sanitize(obj[key]);
            }
        }
    };

    if (req.body) sanitize(req.body);
    if (req.query) sanitize(req.query);
    if (req.params) sanitize(req.params);

    next();
};

// SQL injection prevention for raw queries
const preventSQLInjection = (query) => {
    const dangerousPatterns = [
        /(\b(DROP|DELETE|UPDATE|INSERT|CREATE|ALTER|EXEC|EXECUTE)\b)/gi,
        /(;|\-\-|\/\*|\*\/)/g,
        /(\b(UNION|SELECT)\b.*\b(FROM|WHERE)\b)/gi
    ];

    for (let pattern of dangerousPatterns) {
        if (pattern.test(query)) {
            throw new Error('Potentially dangerous SQL detected');
        }
    }
    return query;
};

// File upload security
const secureFileUpload = {
    fileFilter: (req, file, cb) => {
        // Allow only specific file types
        const allowedTypes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'application/pdf',
            'text/csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'), false);
        }
    },
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB default
        files: 5 // Maximum 5 files per request
    }
};

// Password strength validation
const passwordValidation = [
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
];

// Email validation
const emailValidation = [
    body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail()
];

// Common validation rules
const commonValidations = {
    sku: body('sku')
        .isLength({ min: 1, max: 50 })
        .withMessage('SKU must be between 1 and 50 characters')
        .matches(/^[A-Za-z0-9\-_]+$/)
        .withMessage('SKU can only contain letters, numbers, hyphens, and underscores'),
    
    name: body('name')
        .isLength({ min: 1, max: 255 })
        .withMessage('Name must be between 1 and 255 characters')
        .trim(),
    
    phone: body('phone')
        .optional()
        .matches(/^[\+]?[1-9][\d]{0,15}$/)
        .withMessage('Please provide a valid phone number'),
    
    amount: body('amount')
        .isDecimal({ decimal_digits: '0,2' })
        .withMessage('Amount must be a valid decimal with up to 2 decimal places')
        .custom(value => {
            if (parseFloat(value) < 0) {
                throw new Error('Amount cannot be negative');
            }
            return true;
        }),
    
    quantity: body('quantity')
        .isInt({ min: 0 })
        .withMessage('Quantity must be a non-negative integer')
};

// Request validation middleware
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: 'Validation failed',
            details: errors.array()
        });
    }
    next();
};

// API key validation for external integrations
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    // In production, validate against stored API keys
    // For now, we'll use a simple check
    const validApiKeys = process.env.VALID_API_KEYS ? 
        process.env.VALID_API_KEYS.split(',') : 
        ['demo-api-key-123'];

    if (!validApiKeys.includes(apiKey)) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    next();
};

// CSRF protection for state-changing operations
const csrfProtection = (req, res, next) => {
    // Skip CSRF for API requests with valid authentication
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        return next();
    }

    // For form submissions, check CSRF token
    const token = req.headers['x-csrf-token'] || req.body._csrf;
    const sessionToken = req.session?.csrfToken;

    if (!token || !sessionToken || token !== sessionToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    next();
};

// IP whitelist for admin operations
const ipWhitelist = (allowedIPs = []) => {
    return (req, res, next) => {
        if (allowedIPs.length === 0) {
            return next(); // No restrictions if no IPs specified
        }

        const clientIP = req.ip || req.connection.remoteAddress;
        
        if (!allowedIPs.includes(clientIP)) {
            return res.status(403).json({ error: 'Access denied from this IP address' });
        }

        next();
    };
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Enable XSS protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Permissions policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    next();
};

// Audit logging for sensitive operations
const auditLog = (action) => {
    return (req, res, next) => {
        const originalSend = res.send;
        
        res.send = function(data) {
            // Log the action after successful response
            if (res.statusCode < 400) {
                console.log(`AUDIT: ${action} - User: ${req.user?.id || 'anonymous'} - IP: ${req.ip} - Time: ${new Date().toISOString()}`);
            }
            
            originalSend.call(this, data);
        };
        
        next();
    };
};

module.exports = {
    sanitizeInput,
    preventSQLInjection,
    secureFileUpload,
    passwordValidation,
    emailValidation,
    commonValidations,
    validateRequest,
    validateApiKey,
    csrfProtection,
    ipWhitelist,
    securityHeaders,
    auditLog
};

