const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const COOKIE_NAME = "ddd_sid";

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5500", "http://localhost:3000"],
    credentials: true
  })
);

let db;

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row || null);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      return resolve(rows || []);
    });
  });
}

async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  db = new sqlite3.Database(DB_FILE);
  await runAsync("PRAGMA foreign_keys = ON");

  await runAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      customer_address TEXT NOT NULL,
      customer_city TEXT,
      customer_state TEXT,
      customer_pin_code TEXT,
      customer_note TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      qty INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `);
}

function setSessionCookie(res, sessionId) {
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: false
  });
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.created_at
  };
}

async function getUserFromSession(req) {
  const sessionId = req.cookies[COOKIE_NAME];
  if (!sessionId) return null;

  return getAsync(
    `
      SELECT u.id, u.name, u.email, u.created_at
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [sessionId]
  );
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/auth/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }

    const existing = await getAsync("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existing) {
      return res.status(409).json({ error: "email already registered" });
    }

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };

    await runAsync(
      `
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [user.id, user.name, user.email, user.passwordHash, user.createdAt]
    );

    const sessionId = crypto.randomUUID();
    await runAsync(
      `
        INSERT INTO sessions (id, user_id, created_at)
        VALUES (?, ?, ?)
      `,
      [sessionId, user.id, new Date().toISOString()]
    );

    setSessionCookie(res, sessionId);
    return res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await getAsync(
      `
        SELECT id, name, email, password_hash, created_at
        FROM users
        WHERE email = ?
        LIMIT 1
      `,
      [email]
    );
    if (!user) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const sessionId = crypto.randomUUID();
    await runAsync(
      `
        INSERT INTO sessions (id, user_id, created_at)
        VALUES (?, ?, ?)
      `,
      [sessionId, user.id, new Date().toISOString()]
    );

    setSessionCookie(res, sessionId);
    return res.json({ user: sanitizeUser(user) });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const sessionId = req.cookies[COOKIE_NAME];
    if (sessionId) {
      await runAsync("DELETE FROM sessions WHERE id = ?", [sessionId]);
    }

    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const user = await getUserFromSession(req);
    if (!user) {
      return res.status(401).json({ error: "not authenticated" });
    }
    return res.json({ user: sanitizeUser(user) });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/orders", async (req, res) => {
  try {
    const user = await getUserFromSession(req);
    if (!user) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const customer = req.body?.customer || {};
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({ error: "customer name, phone, and address are required" });
    }
    if (items.length === 0) {
      return res.status(400).json({ error: "at least one order item is required" });
    }

    const orderId = `DDD-${Date.now()}`;
    const createdAt = new Date().toISOString();

    await runAsync("BEGIN TRANSACTION");
    try {
      await runAsync(
        `
          INSERT INTO orders (
            id, user_id, created_at, customer_name, customer_phone, customer_email,
            customer_address, customer_city, customer_state, customer_pin_code, customer_note
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          orderId,
          user.id,
          createdAt,
          String(customer.name || "").trim(),
          String(customer.phone || "").trim(),
          String(customer.email || "").trim(),
          String(customer.address || "").trim(),
          String(customer.city || "").trim(),
          String(customer.state || "").trim(),
          String(customer.pinCode || "").trim(),
          String(customer.note || "").trim()
        ]
      );

      for (const item of items) {
        await runAsync(
          `
            INSERT INTO order_items (order_id, product_id, title, category, qty)
            VALUES (?, ?, ?, ?, ?)
          `,
          [
            orderId,
            String(item.id || ""),
            String(item.title || ""),
            String(item.category || ""),
            Number(item.qty || 0)
          ]
        );
      }

      await runAsync("COMMIT");
    } catch (error) {
      await runAsync("ROLLBACK");
      throw error;
    }

    return res.status(201).json({
      order: {
        id: orderId,
        createdAt,
        customer: {
          name: String(customer.name || "").trim(),
          phone: String(customer.phone || "").trim(),
          email: String(customer.email || "").trim(),
          address: String(customer.address || "").trim(),
          city: String(customer.city || "").trim(),
          state: String(customer.state || "").trim(),
          pinCode: String(customer.pinCode || "").trim(),
          note: String(customer.note || "").trim()
        },
        items: items.map((item) => ({
          id: String(item.id || ""),
          title: String(item.title || ""),
          category: String(item.category || ""),
          qty: Number(item.qty || 0)
        }))
      }
    });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.get("/orders/me", async (req, res) => {
  try {
    const user = await getUserFromSession(req);
    if (!user) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const rows = await allAsync(
      `
        SELECT
          o.id AS order_id,
          o.created_at,
          o.customer_name,
          o.customer_phone,
          o.customer_email,
          o.customer_address,
          o.customer_city,
          o.customer_state,
          o.customer_pin_code,
          o.customer_note,
          oi.product_id,
          oi.title,
          oi.category,
          oi.qty
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC, oi.id ASC
      `,
      [user.id]
    );

    const orderMap = new Map();
    for (const row of rows) {
      if (!orderMap.has(row.order_id)) {
        orderMap.set(row.order_id, {
          id: row.order_id,
          createdAt: row.created_at,
          customer: {
            name: row.customer_name,
            phone: row.customer_phone,
            email: row.customer_email,
            address: row.customer_address,
            city: row.customer_city,
            state: row.customer_state,
            pinCode: row.customer_pin_code,
            note: row.customer_note
          },
          items: []
        });
      }

      if (row.product_id) {
        orderMap.get(row.order_id).items.push({
          id: row.product_id,
          title: row.title,
          category: row.category,
          qty: row.qty
        });
      }
    }

    return res.json({ orders: Array.from(orderMap.values()) });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Auth API running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
