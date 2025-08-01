const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'motorcycle_parts_db',
    password: process.env.DB_PASSWORD || 'Ceejay123',
    port: process.env.DB_PORT || 5433,
});

module.exports = pool;

