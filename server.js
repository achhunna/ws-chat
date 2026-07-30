import express from "express";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/socket" });
const isProd = process.env.NODE_ENV === "production";
const dbPath = path.join(__dirname, "chat.db");

const chatHistory = [];
const MAX_HISTORY = 100;
const ADJECTIVES = [
  "Blue",
  "Swift",
  "Quiet",
  "Bright",
  "Mellow",
  "Orbit",
  "Velvet",
  "Lucky",
];
const NOUNS = [
  "Fox",
  "Comet",
  "Pilot",
  "River",
  "Spark",
  "Drift",
  "Atlas",
  "Echo",
];
const USERNAME_COLORS = [
  ["#2563eb", "rgba(37, 99, 235, 0.18)"],
  ["#0f766e", "rgba(15, 118, 110, 0.18)"],
  ["#7c3aed", "rgba(124, 58, 237, 0.18)"],
  ["#b45309", "rgba(180, 83, 9, 0.18)"],
  ["#be185d", "rgba(190, 24, 93, 0.18)"],
  ["#0891b2", "rgba(8, 145, 178, 0.18)"],
  ["#ea580c", "rgba(234, 88, 12, 0.18)"],
  ["#16a34a", "rgba(22, 163, 74, 0.18)"],
];
const MINE_COLOR = "#2563eb";

function nextUniqueUserStyle(usedColors) {
  const available = USERNAME_COLORS.find(
    ([color]) => color !== MINE_COLOR && !usedColors.has(color),
  );
  if (available) return available;

  // Keep producing distinct colors if the fixed palette is exhausted.
  let index = usedColors.size;
  let color;
  do {
    const hue = Math.round((index * 137.508) % 360);
    color = [`hsl(${hue} 70% 45%)`, `hsla(${hue} 70% 45% / 0.18)`];
    index += 1;
  } while (usedColors.has(color[0]));
  return color;
}

function sanitizeMessage(raw) {
  const text =
    typeof raw?.text === "string" ? raw.text.trim().slice(0, 240) : "";
  return { text };
}

function isChatMessage(message) {
  return (
    message &&
    message.type === "chat" &&
    typeof message.id === "string" &&
    typeof message.user === "string" &&
    typeof message.text === "string" &&
    message.text.trim().length > 0
  );
}

function broadcast(message) {
  if (!isChatMessage(message)) return;
  const payload = JSON.stringify(message);
  chatHistory.push(message);
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function broadcastControl(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function createUsername() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(10 + Math.random() * 90);
  return `${adjective}${noun}${suffix}`;
}

function colorForUsername(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return USERNAME_COLORS[hash % USERNAME_COLORS.length];
}

async function initDb() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      user_color TEXT NOT NULL,
      user_bg TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      color TEXT NOT NULL,
      bg TEXT NOT NULL
    )
  `);

  // CREATE TABLE IF NOT EXISTS does not update databases created by older
  // versions of the app. Migrate those databases before any queries select
  // the newer style columns.
  const columns = await db.all("PRAGMA table_info(chat_messages)");
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("user_color")) {
    await db.exec(
      "ALTER TABLE chat_messages ADD COLUMN user_color TEXT NOT NULL DEFAULT '#2563eb'",
    );
  }
  if (!columnNames.has("user_bg")) {
    await db.exec(
      "ALTER TABLE chat_messages ADD COLUMN user_bg TEXT NOT NULL DEFAULT 'rgba(37, 99, 235, 0.18)'",
    );
  }

  // Keep migrated messages consistent with the stable style assigned to each
  // username. The defaults above make the ALTER TABLE safe for existing rows.
  const users = await db.all(
    "SELECT username, color, bg FROM users ORDER BY username ASC",
  );
  const styles = new Map();
  const usedColors = new Set();
  for (const user of users) {
    let style = [user.color, user.bg];
    if (user.color === MINE_COLOR || usedColors.has(user.color)) {
      style = nextUniqueUserStyle(usedColors);
      await db.run("UPDATE users SET color = ?, bg = ? WHERE username = ?", [
        style[0],
        style[1],
        user.username,
      ]);
    }
    usedColors.add(style[0]);
    styles.set(user.username, { color: style[0], bg: style[1] });
  }
  const messages = await db.all("SELECT DISTINCT user FROM chat_messages");
  for (const message of messages) {
    let style = styles.get(message.user);
    if (!style) {
      const [color, bg] = nextUniqueUserStyle(usedColors);
      await db.run("INSERT INTO users (username, color, bg) VALUES (?, ?, ?)", [
        message.user,
        color,
        bg,
      ]);
      style = { color, bg };
      usedColors.add(color);
      styles.set(message.user, style);
    }
    await db.run(
      "UPDATE chat_messages SET user_color = ?, user_bg = ? WHERE user = ?",
      [style.color, style.bg, message.user],
    );
  }

  return db;
}

async function loadHistory(db) {
  const rows = await db.all(
    "SELECT id, user, user_color, user_bg, text, ts FROM chat_messages ORDER BY ts ASC LIMIT ?",
    [MAX_HISTORY],
  );
  chatHistory.length = 0;
  chatHistory.push(
    ...rows.map((row) => ({
      id: row.id,
      type: "chat",
      user: row.user,
      userColor: row.user_color,
      userBg: row.user_bg,
      text: row.text,
      ts: row.ts,
    })),
  );
}

let db;

async function getOrCreateUserStyle(username) {
  const existing = await db.get(
    "SELECT color, bg FROM users WHERE username = ?",
    [username],
  );
  if (existing) return existing;

  const users = await db.all("SELECT color FROM users");
  const [color, bg] = nextUniqueUserStyle(
    new Set(users.map((user) => user.color)),
  );
  await db.run("INSERT INTO users (username, color, bg) VALUES (?, ?, ?)", [
    username,
    color,
    bg,
  ]);
  return { color, bg };
}

async function persistMessage(message) {
  if (!isChatMessage(message)) return;
  const userStyle = await getOrCreateUserStyle(message.user);
  await db.run(
    "INSERT INTO chat_messages (id, user, user_color, user_bg, text, ts) VALUES (?, ?, ?, ?, ?, ?)",
    [
      message.id,
      message.user,
      userStyle.color,
      userStyle.bg,
      message.text,
      message.ts,
    ],
  );
  broadcast({ ...message, userColor: userStyle.color, userBg: userStyle.bg });
}

async function clearChat() {
  await db.run("DELETE FROM chat_messages");
  chatHistory.length = 0;
  broadcastControl({ type: "history-cleared" });
}

app.get("/api/chat/history", async (_req, res, next) => {
  try {
    const rows = await db.all(
      "SELECT id, user, user_color, user_bg, text, ts FROM chat_messages ORDER BY ts ASC LIMIT ?",
      [MAX_HISTORY],
    );
    res.json({
      history: rows.map((row) => ({
        id: row.id,
        type: "chat",
        user: row.user,
        userColor: row.user_color,
        userBg: row.user_bg,
        text: row.text,
        ts: row.ts,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/chat/history", async (_req, res, next) => {
  try {
    await clearChat();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

wss.on("connection", (socket) => {
  socket.username = createUsername();
  getOrCreateUserStyle(socket.username)
    .then((style) => {
      socket.send(
        JSON.stringify({
          type: "assigned-name",
          user: socket.username,
          userColor: style.color,
          userBg: style.bg,
        }),
      );
    })
    .catch(() => {
      socket.send(
        JSON.stringify({
          type: "assigned-name",
          user: socket.username,
        }),
      );
    });

  socket.send(
    JSON.stringify({
      type: "history",
      history: chatHistory.filter(isChatMessage),
    }),
  );

  socket.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data?.type === "hello") {
        const nextName =
          typeof data.user === "string" ? data.user.trim().slice(0, 24) : "";
        socket.username = nextName || socket.username;
        getOrCreateUserStyle(socket.username)
          .then((style) => {
            socket.send(
              JSON.stringify({
                type: "assigned-name",
                user: socket.username,
                userColor: style.color,
                userBg: style.bg,
              }),
            );
          })
          .catch(() => {
            socket.send(
              JSON.stringify({
                type: "assigned-name",
                user: socket.username,
              }),
            );
          });
        return;
      }
      if (data?.type === "clear-history") {
        clearChat().catch(() => {});
        return;
      }
      const { text } = sanitizeMessage(data);
      if (!text) return;

      persistMessage({
        id: crypto.randomUUID(),
        type: "chat",
        user: socket.username,
        text,
        ts: Date.now(),
      }).catch(() => {});
    } catch {
      // Ignore malformed messages.
    }
  });
});

async function sendHtml(res, templateFile, url) {
  const template = await readFile(path.join(__dirname, templateFile), "utf-8");
  const html = isProd
    ? template
    : await currentVite.transformIndexHtml(url, template);
  res.status(200).set({ "Content-Type": "text/html" }).end(html);
}

let currentVite = null;

async function start() {
  db = await initDb();
  await loadHistory(db);
  console.log(`SQLite chat db ready: ${dbPath}`);
  console.log(`Loaded ${chatHistory.length} chat messages from SQLite`);

  if (isProd) {
    app.use(express.static(path.join(__dirname, "dist")));
  } else {
    currentVite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(currentVite.middlewares);
  }

  app.get("/", (_req, res) => {
    res.status(200).type("text/plain").send("us.local");
  });

  app.get("/chat", async (req, res, next) => {
    try {
      await sendHtml(res, "index.html", req.originalUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get(/.*/, async (req, res, next) => {
    try {
      if (
        req.path === "/api/chat/history" ||
        req.path === "/api/chat/history/" ||
        req.path === "/api/chat/history" ||
        req.path === "/socket"
      ) {
        return next();
      }
      await sendHtml(res, "index.html", req.originalUrl);
    } catch (error) {
      next(error);
    }
  });

  server.listen(process.env.PORT || 80, "0.0.0.0", () => {
    console.log("Server running on http://localhost/chat");
  });
}

start();
