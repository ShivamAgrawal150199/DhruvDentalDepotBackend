const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "auth-db.json");
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

let writeQueue = Promise.resolve();

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    const initial = { users: [], sessions: {}, orders: [] };
    await fs.writeFile(DB_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}

function writeDb(nextDb) {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DB_FILE, JSON.stringify(nextDb, null, 2), "utf8")
  );
  return writeQueue;
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
    createdAt: user.createdAt
  };
}

function sanitizeOrder(order) {
  return {
    id: order.id,
    createdAt: order.createdAt,
    customer: order.customer,
    items: order.items
  };
}

async function getUserFromSession(req) {
  const sessionId = req.cookies[COOKIE_NAME];
  if (!sessionId) return null;
  const db = await readDb();
  const session = db.sessions[sessionId];
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
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

    const db = await readDb();
    const exists = db.users.some((user) => user.email === email);
    if (exists) {
      return res.status(409).json({ error: "email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);

    const sessionId = crypto.randomUUID();
    db.sessions[sessionId] = {
      userId: user.id,
      createdAt: new Date().toISOString()
    };

    await writeDb(db);
    setSessionCookie(res, sessionId);
    return res.status(201).json({ user: sanitizeUser(user) });
  } catch (error) {
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

    const db = await readDb();
    const user = db.users.find((entry) => entry.email === email);
    if (!user) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const sessionId = crypto.randomUUID();
    db.sessions[sessionId] = {
      userId: user.id,
      createdAt: new Date().toISOString()
    };

    await writeDb(db);
    setSessionCookie(res, sessionId);
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const sessionId = req.cookies[COOKIE_NAME];
    if (!sessionId) {
      clearSessionCookie(res);
      return res.json({ ok: true });
    }

    const db = await readDb();
    delete db.sessions[sessionId];
    await writeDb(db);
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
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
  } catch (error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.post("/orders", async (req, res) => {
  try {
    const sessionId = req.cookies[COOKIE_NAME];
    if (!sessionId) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const db = await readDb();
    const session = db.sessions[sessionId];
    if (!session) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const user = db.users.find((entry) => entry.id === session.userId);
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

    const order = {
      id: `DDD-${Date.now()}`,
      createdAt: new Date().toISOString(),
      userId: user.id,
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
    };

    db.orders = Array.isArray(db.orders) ? db.orders : [];
    db.orders.push(order);
    await writeDb(db);
    return res.status(201).json({ order: sanitizeOrder(order) });
  } catch (error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.get("/orders/me", async (req, res) => {
  try {
    const sessionId = req.cookies[COOKIE_NAME];
    if (!sessionId) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const db = await readDb();
    const session = db.sessions[sessionId];
    if (!session) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const userOrders = (Array.isArray(db.orders) ? db.orders : [])
      .filter((order) => order.userId === session.userId)
      .map(sanitizeOrder);

    return res.json({ orders: userOrders });
  } catch (error) {
    return res.status(500).json({ error: "internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Auth API running on http://localhost:${PORT}`);
});
