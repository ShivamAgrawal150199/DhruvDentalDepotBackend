const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const { Pool } = require("pg");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const COOKIE_NAME = "ddd_sid";
const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_POSTGRES = Boolean(DATABASE_URL);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const ALLOWED_PROFESSIONS = ["dentist", "dealer", "student", "universities supplier"];

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests from localhost/127.0.0.1 on any port during development
      if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
        callback(null, true);
      }
      // Allow requests from local LAN (e.g. testing on phone)
      else if (
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
        /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      }
      // Allow requests from production domains
      else if (
        origin === "https://ddent.co.in" ||
        origin === "https://www.ddent.co.in" ||
        origin === "https://dhruv-dental-depot.vercel.app"
      ) {
        callback(null, true);
      }
      // Reject other origins (no error to avoid noisy logs)
      else {
        callback(null, false);
      }
    },
    credentials: true
  })
);

let db;
let pgPool;
let pgTxnClient = null;

function formatPgSql(sql, params = []) {
  if (!params.length) return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function shouldUseSsl(url) {
  if (!url) return false;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return false;
  return true;
}

async function runAsync(sql, params = []) {
  if (USE_POSTGRES) {
    const text = formatPgSql(sql, params);
    if (!pgPool) throw new Error("Postgres pool not initialized");

    if (/^\s*BEGIN/i.test(sql)) {
      pgTxnClient = await pgPool.connect();
      await pgTxnClient.query(text, params);
      return { lastID: null, changes: 0 };
    }

    if (/^\s*COMMIT/i.test(sql) || /^\s*ROLLBACK/i.test(sql)) {
      if (!pgTxnClient) return { lastID: null, changes: 0 };
      try {
        await pgTxnClient.query(text, params);
      } finally {
        pgTxnClient.release();
        pgTxnClient = null;
      }
      return { lastID: null, changes: 0 };
    }

    const client = pgTxnClient || pgPool;
    const result = await client.query(text, params);
    return { lastID: null, changes: result.rowCount || 0 };
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  if (USE_POSTGRES) {
    const text = formatPgSql(sql, params);
    const client = pgTxnClient || pgPool;
    return client
      .query(text, params)
      .then((result) => result.rows[0] || null);
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row || null);
    });
  });
}

function allAsync(sql, params = []) {
  if (USE_POSTGRES) {
    const text = formatPgSql(sql, params);
    const client = pgTxnClient || pgPool;
    return client
      .query(text, params)
      .then((result) => result.rows || []);
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      return resolve(rows || []);
    });
  });
}

async function initDb() {
  if (USE_POSTGRES) {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
    });
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    db = new sqlite3.Database(DB_FILE);
    await runAsync("PRAGMA foreign_keys = ON");
  }

  const schemaSql = USE_POSTGRES
    ? [
        `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          profession TEXT,
          phone TEXT,
          city TEXT,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `,
        `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `,
        `
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
      `,
        `
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          order_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          qty INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
      `,
        `
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          image TEXT NOT NULL,
          note TEXT,
          fit TEXT,
          created_at TEXT NOT NULL
        )
      `
        ,
        `
        CREATE TABLE IF NOT EXISTS wishlist (
          id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, product_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `
      ]
    : [
        `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          profession TEXT,
          phone TEXT,
          city TEXT,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `,
        `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `,
        `
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
      `,
        `
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          qty INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
      `,
        `
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          image TEXT NOT NULL,
          note TEXT,
          fit TEXT,
          created_at TEXT NOT NULL
        )
      `
        ,
        `
        CREATE TABLE IF NOT EXISTS wishlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, product_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `
      ];

  for (const statement of schemaSql) {
    await runAsync(statement);
  }

  if (USE_POSTGRES) {
    await runAsync("ALTER TABLE users ADD COLUMN IF NOT EXISTS profession TEXT");
    await runAsync("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
    await runAsync("ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT");
    await runAsync("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone)");
  } else {
    try {
      await runAsync("ALTER TABLE users ADD COLUMN profession TEXT");
    } catch (_error) {
      // Column likely already exists.
    }
    try {
      await runAsync("ALTER TABLE users ADD COLUMN phone TEXT");
    } catch (_error) {
      // Column likely already exists.
    }
    try {
      await runAsync("ALTER TABLE users ADD COLUMN city TEXT");
    } catch (_error) {
      // Column likely already exists.
    }
    await runAsync("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone)");
  }
}

function setSessionCookie(res, sessionId) {
  const isProd = USE_POSTGRES || process.env.NODE_ENV === "production";
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

function clearSessionCookie(res) {
  const isProd = USE_POSTGRES || process.env.NODE_ENV === "production";
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd
  });
}

function getCookieOptions() {
  const isProd = USE_POSTGRES || process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 10
  };
}

function getFrontendOrigin(req) {
  if (FRONTEND_ORIGIN) return FRONTEND_ORIGIN;
  const ref = req.get("referer");
  if (ref) {
    try {
      const parsed = new URL(ref);
      return parsed.origin;
    } catch {
      // ignore
    }
  }
  return USE_POSTGRES ? "https://ddent.co.in" : "http://localhost:5500";
}

function sanitizeNextUrl(nextUrl, origin) {
  if (!nextUrl) return `${origin}/index.html`;

  if (/^https?:\/\//i.test(nextUrl)) {
    try {
      const parsed = new URL(nextUrl);
      return parsed.origin === origin ? parsed.toString() : `${origin}/index.html`;
    } catch {
      return `${origin}/index.html`;
    }
  }

  if (nextUrl.startsWith("/")) {
    return `${origin}${nextUrl}`;
  }

  return `${origin}/${nextUrl}`;
}

function getGoogleRedirectUri(req) {
  if (GOOGLE_REDIRECT_URI) return GOOGLE_REDIRECT_URI;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/auth/google/callback`;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    profession: user.profession || "",
    phone: user.phone || "",
    city: user.city || "",
    createdAt: user.created_at
  };
}

function normalizeIndiaPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return "";
}

function isValidEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function getUserFromSession(req) {
  const sessionId = req.cookies[COOKIE_NAME];
  if (!sessionId) return null;

  return getAsync(
    `
      SELECT u.id, u.name, u.email, u.profession, u.phone, u.city, u.created_at
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [sessionId]
  );
}

async function requireUser(req, res) {
  const user = await getUserFromSession(req);
  if (!user) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  return user;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    db: USE_POSTGRES ? "postgres" : "sqlite"
  });
});

app.get("/products", async (_req, res) => {
  try {
    const products = await allAsync(
      `
        SELECT id, title, category, image, COALESCE(note, '') AS note, COALESCE(fit, '') AS fit, created_at
        FROM products
        ORDER BY created_at DESC
      `
    );
    return res.json({ products });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/products", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const title = String(req.body?.title || "").trim();
    const category = String(req.body?.category || "").trim();
    const image = String(req.body?.image || "").trim();
    const note = String(req.body?.note || "").trim();
    const fit = String(req.body?.fit || "").trim();

    if (!title || !category || !image) {
      return res.status(400).json({ error: "title, category, and image are required" });
    }

    const product = {
      id: `prd-${crypto.randomUUID()}`,
      title,
      category,
      image,
      note,
      fit,
      createdAt: new Date().toISOString()
    };

    await runAsync(
      `
        INSERT INTO products (id, title, category, image, note, fit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [product.id, product.title, product.category, product.image, product.note, product.fit, product.createdAt]
    );

    return res.status(201).json({ product });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.put("/products/:id", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const id = String(req.params.id || "").trim();
    const title = String(req.body?.title || "").trim();
    const category = String(req.body?.category || "").trim();
    const image = String(req.body?.image || "").trim();
    const note = String(req.body?.note || "").trim();
    const fit = String(req.body?.fit || "").trim();

    if (!id || !title || !category || !image) {
      return res.status(400).json({ error: "id, title, category, and image are required" });
    }

    const result = await runAsync(
      `
        UPDATE products
        SET title = ?, category = ?, image = ?, note = ?, fit = ?
        WHERE id = ?
      `,
      [title, category, image, note, fit, id]
    );

    if (!result.changes) {
      return res.status(404).json({ error: "product not found" });
    }

    const product = await getAsync(
      `
        SELECT id, title, category, image, COALESCE(note, '') AS note, COALESCE(fit, '') AS fit, created_at
        FROM products
        WHERE id = ?
      `,
      [id]
    );

    return res.json({ product });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const result = await runAsync("DELETE FROM products WHERE id = ?", [id]);
    if (!result.changes) {
      return res.status(404).json({ error: "product not found" });
    }

    return res.json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/auth/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    const profession = String(req.body?.profession || "").trim().toLowerCase();
    const phone = normalizeIndiaPhone(req.body?.phone);
    const city = String(req.body?.city || "").trim();

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "invalid email" });
    }
    if (profession && !ALLOWED_PROFESSIONS.includes(profession)) {
      return res.status(400).json({ error: "invalid profession" });
    }
    if (phone) {
      const existingPhone = await getAsync("SELECT id FROM users WHERE phone = ? LIMIT 1", [phone]);
      if (existingPhone) {
        return res.status(409).json({ error: "phone already registered" });
      }
    } else if (req.body?.phone) {
      return res.status(400).json({ error: "phone must be a valid 10-digit number" });
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
        INSERT INTO users (id, name, email, profession, phone, city, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [user.id, user.name, user.email, profession || null, phone || null, city || null, user.passwordHash, user.createdAt]
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
        profession: profession || "",
        phone: phone || "",
        city: city || "",
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
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "invalid email" });
    }

    const user = await getAsync(
      `
        SELECT id, name, email, profession, phone, city, password_hash, created_at
        FROM users
        WHERE email = ?
        LIMIT 1
      `,
      [email]
    );
    if (!user) {
      return res.status(404).json({ error: "email not registered" });
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

app.get("/auth/google", async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).send("Google SSO is not configured.");
    }

    const next = String(req.query?.next || "");
    const origin = getFrontendOrigin(req);
    const state = crypto.randomUUID();

    res.cookie("ddd_oauth_state", state, getCookieOptions());
    res.cookie("ddd_oauth_next", next, getCookieOptions());
    res.cookie("ddd_oauth_origin", origin, getCookieOptions());

    const redirectUri = getGoogleRedirectUri(req);
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state
    });

    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (_error) {
    return res.status(500).send("Failed to start Google login.");
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = String(req.query?.code || "");
    const state = String(req.query?.state || "");
    const storedState = req.cookies["ddd_oauth_state"] || "";
    const next = req.cookies["ddd_oauth_next"] || "";
    const origin = req.cookies["ddd_oauth_origin"] || getFrontendOrigin(req);

    res.clearCookie("ddd_oauth_state", getCookieOptions());
    res.clearCookie("ddd_oauth_next", getCookieOptions());
    res.clearCookie("ddd_oauth_origin", getCookieOptions());

    if (!code || !state || !storedState || state !== storedState) {
      return res.status(400).send("Invalid OAuth state.");
    }

    const redirectUri = getGoogleRedirectUri(req);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    if (!tokenRes.ok) {
      return res.status(401).send("Failed to exchange Google token.");
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(401).send("Missing access token.");
    }

    const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!profileRes.ok) {
      return res.status(401).send("Failed to fetch Google profile.");
    }

    const profile = await profileRes.json();
    const email = String(profile.email || "").trim().toLowerCase();
    const name = String(profile.name || "Google User").trim();

    if (!email) {
      return res.status(400).send("Google account missing email.");
    }

    let user = await getAsync(
      `
        SELECT id, name, email, profession, phone, city, created_at
        FROM users
        WHERE email = ?
        LIMIT 1
      `,
      [email]
    );

    if (!user) {
      const userId = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
      const createdAt = new Date().toISOString();
      await runAsync(
        `
          INSERT INTO users (id, name, email, profession, phone, city, password_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [userId, name || "Google User", email, null, null, null, passwordHash, createdAt]
      );

      user = {
        id: userId,
        name: name || "Google User",
        email,
        profession: "",
        phone: "",
        city: "",
        created_at: createdAt
      };
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
    const target = sanitizeNextUrl(next, origin);
    return res.redirect(target);
  } catch (_error) {
    return res.status(500).send("Google login failed.");
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

app.put("/auth/profile", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const name = String(req.body?.name || "").trim();
    const profession = String(req.body?.profession || "").trim().toLowerCase();
    const phone = normalizeIndiaPhone(req.body?.phone);
    const city = String(req.body?.city || "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    if (profession && !ALLOWED_PROFESSIONS.includes(profession)) {
      return res.status(400).json({ error: "invalid profession" });
    }
    if (!phone) {
      return res.status(400).json({ error: "phone must be a valid 10-digit number" });
    }
    if (!city) {
      return res.status(400).json({ error: "city is required" });
    }
    const existingPhone = await getAsync(
      "SELECT id FROM users WHERE phone = ? AND id != ? LIMIT 1",
      [phone, user.id]
    );
    if (existingPhone) {
      return res.status(409).json({ error: "phone already registered" });
    }

    await runAsync("UPDATE users SET name = ?, profession = ?, phone = ?, city = ? WHERE id = ?", [
      name,
      profession || null,
      phone,
      city || null,
      user.id
    ]);
    const updated = await getAsync(
      `
        SELECT id, name, email, profession, phone, city, created_at
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
      [user.id]
    );

    return res.json({ user: sanitizeUser(updated) });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.delete("/auth/me", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    await runAsync("DELETE FROM sessions WHERE user_id = ?", [user.id]);
    await runAsync("DELETE FROM users WHERE id = ?", [user.id]);
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.get("/wishlist", async (req, res) => {
  try {
    const user = await getUserFromSession(req);
    if (!user) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const rows = await allAsync(
      `
        SELECT product_id, created_at
        FROM wishlist
        WHERE user_id = ?
        ORDER BY created_at DESC
      `,
      [user.id]
    );

    return res.json({
      items: rows.map((row) => ({
        productId: row.product_id,
        createdAt: row.created_at
      }))
    });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/wishlist", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const productId = String(req.body?.productId || "").trim();
    if (!productId) {
      return res.status(400).json({ error: "productId is required" });
    }

    const createdAt = new Date().toISOString();
    const insertSql = USE_POSTGRES
      ? `
        INSERT INTO wishlist (user_id, product_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id, product_id) DO NOTHING
      `
      : `
        INSERT OR IGNORE INTO wishlist (user_id, product_id, created_at)
        VALUES (?, ?, ?)
      `;

    await runAsync(insertSql, [user.id, productId, createdAt]);
    return res.status(201).json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.delete("/wishlist/:productId", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const productId = String(req.params.productId || "").trim();
    if (!productId) {
      return res.status(400).json({ error: "productId is required" });
    }

    await runAsync(
      `
        DELETE FROM wishlist
        WHERE user_id = ? AND product_id = ?
      `,
      [user.id, productId]
    );

    return res.json({ ok: true });
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
