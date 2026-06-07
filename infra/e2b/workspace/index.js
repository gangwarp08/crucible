'use strict';

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// BUG 1: hostname 'postgres' is a Docker Compose service name — it does not
//        resolve in a standalone E2B sandbox.
// BUG 2: port 5433 is wrong; PostgreSQL's default port is 5432.
// Both are silent config errors, not syntax issues. The server crashes on
// startup at the pool.connect() health-check below.
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'crucible',
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || 'secret',
  connectionTimeoutMillis: 3000,
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email FROM users ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/users', async (req, res) => {
  const { name, email } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eagerly verify DB connectivity before accepting traffic — crashes here.
pool.connect()
  .then((client) => {
    client.release();
    console.log('Database connection established');
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  });
