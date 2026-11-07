'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

const db = new DatabaseSync(path.join(DATA_DIR, 'reports.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS reporters (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES reporters(id),
  topic TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  hostname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','en_progreso','en_espera','resuelto')),
  assignee_id INTEGER REFERENCES admins(id),
  eta_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('reporter','admin','system')),
  author_id INTEGER,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_reporter ON tickets(reporter_id);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
`);

const now = () => new Date().toISOString();
const folio = (id) => 'GV-' + String(1000 + Number(id));

const STATUS_LABELS = {
  nuevo: 'Nuevo',
  en_progreso: 'En progreso',
  en_espera: 'En espera',
  resuelto: 'Resuelto'
};

// ---------- Admins ----------
const admins = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM admins').get().n,
  byUsername: (u) => db.prepare('SELECT * FROM admins WHERE username = ? AND active = 1').get(u),
  byId: (id) => db.prepare('SELECT id, username, name FROM admins WHERE id = ? AND active = 1').get(id),
  list: () => db.prepare('SELECT id, username, name FROM admins WHERE active = 1 ORDER BY name').all(),
  create: (username, name, passHash) =>
    db.prepare('INSERT INTO admins (username, name, pass_hash) VALUES (?, ?, ?)').run(username, name, passHash),
  setPassword: (username, passHash) =>
    db.prepare('UPDATE admins SET pass_hash = ?, active = 1 WHERE username = ?').run(passHash, username)
};

// ---------- Reporters ----------
const reporters = {
  byToken: (t) => db.prepare('SELECT * FROM reporters WHERE token = ?').get(t),
  create: (token, name, area, hostname) =>
    db.prepare('INSERT INTO reporters (token, name, area, hostname, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, name, area, hostname, now()),
  update: (id, name, area, hostname) =>
    db.prepare('UPDATE reporters SET name = ?, area = ?, hostname = ?, last_seen_at = ? WHERE id = ?')
      .run(name, area, hostname, now(), id),
  touch: (id, hostname) => {
    if (hostname) db.prepare('UPDATE reporters SET hostname = ?, last_seen_at = ? WHERE id = ?').run(hostname, now(), id);
    else db.prepare('UPDATE reporters SET last_seen_at = ? WHERE id = ?').run(now(), id);
  }
};

// ---------- Tickets ----------
function queuePosition(ticket) {
  if (ticket.status !== 'nuevo') return null;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets
    WHERE status = 'nuevo' AND (blocked > ? OR (blocked = ? AND created_at < ?))
  `).get(ticket.blocked, ticket.blocked, ticket.created_at);
  const total = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'nuevo'").get().n;
  return { position: row.n + 1, total };
}

function decorate(t) {
  if (!t) return t;
  return {
    ...t,
    blocked: !!t.blocked,
    folio: folio(t.id),
    status_label: STATUS_LABELS[t.status],
    queue: queuePosition(t)
  };
}

const ticketSelect = `
  SELECT t.*, r.name AS reporter_name, r.area AS reporter_area,
         a.name AS assignee_name,
         (SELECT COUNT(*) FROM photos p WHERE p.ticket_id = t.id) AS photo_count
  FROM tickets t
  JOIN reporters r ON r.id = t.reporter_id
  LEFT JOIN admins a ON a.id = t.assignee_id
`;

const tickets = {
  create({ reporterId, topic, description, blocked, hostname }) {
    const ts = now();
    const res = db.prepare(`
      INSERT INTO tickets (reporter_id, topic, description, blocked, hostname, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reporterId, topic, description, blocked ? 1 : 0, hostname, ts, ts);
    const id = Number(res.lastInsertRowid);
    events.add(id, 'reporter', reporterId, 'created', '');
    return id;
  },
  get: (id) => decorate(db.prepare(ticketSelect + ' WHERE t.id = ?').get(id)),
  forReporter(reporterId) {
    return db.prepare(ticketSelect + `
      WHERE t.reporter_id = ?
      ORDER BY (t.status = 'resuelto'), t.created_at DESC
      LIMIT 50
    `).all(reporterId).map(decorate);
  },
  list({ view = 'abiertos', q = '' } = {}) {
    const where = [];
    const params = [];
    if (view === 'abiertos') where.push("t.status != 'resuelto'");
    else if (view === 'sin_tiempo') where.push("t.status != 'resuelto' AND t.eta_at IS NULL");
    else if (STATUS_LABELS[view]) { where.push('t.status = ?'); params.push(view); }
    if (q) {
      const like = '%' + q + '%';
      const idMatch = /^(gv-)?(\d+)$/i.exec(q.trim());
      where.push('(t.description LIKE ? OR t.topic LIKE ? OR r.name LIKE ? OR r.area LIKE ? OR t.hostname LIKE ?' +
        (idMatch ? ' OR t.id = ?' : '') + ')');
      params.push(like, like, like, like, like);
      if (idMatch) params.push(Number(idMatch[2]) - (idMatch[1] ? 1000 : 0));
    }
    const sql = ticketSelect + (where.length ? ' WHERE ' + where.join(' AND ') : '') + `
      ORDER BY (t.status = 'resuelto'), t.blocked DESC,
               (t.eta_at IS NULL) DESC, t.eta_at, t.created_at
      LIMIT 300`;
    return db.prepare(sql).all(...params).map(decorate);
  },
  stats() {
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const g = (sql, ...p) => db.prepare(sql).get(...p).n;
    return {
      abiertos: g("SELECT COUNT(*) AS n FROM tickets WHERE status != 'resuelto'"),
      sin_tiempo: g("SELECT COUNT(*) AS n FROM tickets WHERE status != 'resuelto' AND eta_at IS NULL"),
      vencen_hoy: g("SELECT COUNT(*) AS n FROM tickets WHERE status != 'resuelto' AND eta_at IS NOT NULL AND eta_at <= ?", today.toISOString()),
      resueltos_semana: g("SELECT COUNT(*) AS n FROM tickets WHERE status = 'resuelto' AND resolved_at >= ?", weekAgo),
      en_progreso: g("SELECT COUNT(*) AS n FROM tickets WHERE status = 'en_progreso'"),
      en_espera: g("SELECT COUNT(*) AS n FROM tickets WHERE status = 'en_espera'"),
      nuevo: g("SELECT COUNT(*) AS n FROM tickets WHERE status = 'nuevo'"),
      resuelto: g("SELECT COUNT(*) AS n FROM tickets WHERE status = 'resuelto'"),
      ultimo_id: g('SELECT COALESCE(MAX(id), 0) AS n FROM tickets')
    };
  },
  update(id, fields) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(k + ' = ?'); params.push(v); }
    sets.push('updated_at = ?'); params.push(now());
    params.push(id);
    db.prepare('UPDATE tickets SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
  }
};

// ---------- Photos ----------
const photos = {
  add: (ticketId, filename, mime, bytes) =>
    db.prepare('INSERT INTO photos (ticket_id, filename, mime, bytes) VALUES (?, ?, ?, ?)').run(ticketId, filename, mime, bytes),
  forTicket: (ticketId) => db.prepare('SELECT id, mime, bytes, created_at FROM photos WHERE ticket_id = ? ORDER BY id').all(ticketId),
  get: (id) => db.prepare('SELECT p.*, t.reporter_id FROM photos p JOIN tickets t ON t.id = p.ticket_id WHERE p.id = ?').get(id)
};

// ---------- Events (historial y mensajes) ----------
const events = {
  add: (ticketId, authorKind, authorId, kind, body, internal = false) =>
    db.prepare('INSERT INTO events (ticket_id, author_kind, author_id, kind, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ticketId, authorKind, authorId, kind, body, internal ? 1 : 0, now()),
  forTicket(ticketId, { includeInternal }) {
    return db.prepare(`
      SELECT e.*, CASE e.author_kind WHEN 'admin' THEN a.name WHEN 'reporter' THEN r.name ELSE 'Sistema' END AS author_name
      FROM events e
      LEFT JOIN admins a ON e.author_kind = 'admin' AND a.id = e.author_id
      LEFT JOIN reporters r ON e.author_kind = 'reporter' AND r.id = e.author_id
      WHERE e.ticket_id = ? ${includeInternal ? '' : 'AND e.internal = 0'}
      ORDER BY e.id
    `).all(ticketId).map((e) => ({ ...e, internal: !!e.internal }));
  },
  lastPublicMessage(ticketId) {
    return db.prepare(`
      SELECT e.body, e.created_at, a.name AS author_name FROM events e
      LEFT JOIN admins a ON a.id = e.author_id
      WHERE e.ticket_id = ? AND e.kind = 'message' AND e.author_kind = 'admin' AND e.internal = 0
      ORDER BY e.id DESC LIMIT 1
    `).get(ticketId) || null;
  }
};

module.exports = { db, admins, reporters, tickets, photos, events, folio, STATUS_LABELS, now };
