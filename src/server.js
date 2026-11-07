'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./config');
const { admins, reporters, tickets, photos, events, STATUS_LABELS } = require('./db');
const auth = require('./auth');

// ---------- Admin inicial desde .env ----------
if (admins.count() === 0 && cfg.ADMIN_USER && cfg.ADMIN_PASSWORD) {
  admins.create(cfg.ADMIN_USER, cfg.ADMIN_NAME, auth.hashPassword(cfg.ADMIN_PASSWORD));
  console.log(`Administrador inicial creado: ${cfg.ADMIN_USER}`);
}

// ---------- Utilidades HTTP ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAgeDays = 3650, clear = false } = {}) {
  const parts = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push('Max-Age=' + (clear ? 0 : Math.round(maxAgeDays * 86400)));
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

function readBody(req, limit = cfg.MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'El envío es demasiado grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Datos inválidos.')); }
    });
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const cleanHost = (v) => clean(v, 63).replace(/[^A-Za-z0-9._-]/g, '').toUpperCase();

// ---------- Fotos ----------
const IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: '.png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: '.webp', magic: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { ext: '.gif', magic: (b) => b.toString('ascii', 0, 3) === 'GIF' }
};

function decodePhoto(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES[m[1]]) throw new HttpError(400, 'Solo se aceptan imágenes JPG, PNG, WEBP o GIF.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > cfg.MAX_PHOTO_BYTES) throw new HttpError(413, 'Una de las fotos pesa más de 8 MB.');
  if (!IMAGE_TYPES[m[1]].magic(buf)) throw new HttpError(400, 'Una de las fotos no es una imagen válida.');
  return { mime: m[1], buf };
}

function savePhotos(ticketId, list) {
  for (const p of list) {
    const name = crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[p.mime].ext;
    fs.writeFileSync(path.join(cfg.UPLOAD_DIR, name), p.buf);
    photos.add(ticketId, name, p.mime, p.buf.length);
  }
}

// ---------- Sesiones ----------
function currentReporter(req) {
  const token = auth.unsign(parseCookies(req).gv_rep);
  return token ? reporters.byToken(token) : null;
}

function currentAdmin(req) {
  const id = auth.readAdminSession(parseCookies(req).gv_adm);
  return id ? admins.byId(id) : null;
}

function requireReporter(req) {
  const r = currentReporter(req);
  if (!r) throw new HttpError(401, 'Primero dinos quién eres.');
  return r;
}

function requireAdmin(req) {
  const a = currentAdmin(req);
  if (!a) throw new HttpError(401, 'Inicia sesión.');
  return a;
}

// Límite sencillo de intentos de login por IP.
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const nowMs = Date.now();
  const rec = loginAttempts.get(ip) || { n: 0, since: nowMs };
  if (nowMs - rec.since > 15 * 60e3) { rec.n = 0; rec.since = nowMs; }
  rec.n += 1;
  loginAttempts.set(ip, rec);
  if (rec.n > 10) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
}

// ---------- Vistas públicas de datos ----------
function publicTicket(t) {
  const last = events.lastPublicMessage(t.id);
  return {
    id: t.id, folio: t.folio, topic: t.topic, description: t.description, blocked: t.blocked,
    status: t.status, status_label: t.status_label, eta_at: t.eta_at, queue: t.queue,
    assignee_name: t.assignee_name, photo_count: t.photo_count,
    created_at: t.created_at, updated_at: t.updated_at, resolved_at: t.resolved_at,
    last_message: last
  };
}

// ---------- Rutas ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', (req, res) => json(res, 200, { app: cfg.APP_NAME, company: cfg.COMPANY }));

// --- Empleado ---
route('GET', '/api/me', (req, res, { query }) => {
  const r = currentReporter(req);
  if (r) reporters.touch(r.id, cleanHost(query.get('equipo')));
  json(res, 200, { reporter: r ? { name: r.name, area: r.area, hostname: cleanHost(query.get('equipo')) || r.hostname } : null });
});

route('POST', '/api/me', async (req, res) => {
  const body = await readBody(req, 64 * 1024);
  const name = clean(body.name, 80);
  const area = clean(body.area, 80);
  const hostname = cleanHost(body.hostname);
  if (name.length < 2) throw new HttpError(400, 'Escribe tu nombre.');
  let r = currentReporter(req);
  const headers = {};
  if (r) reporters.update(r.id, name, area, hostname || r.hostname);
  else {
    const token = auth.newToken();
    reporters.create(token, name, area, hostname);
    headers['Set-Cookie'] = cookie('gv_rep', auth.sign(token));
  }
  json(res, 200, { reporter: { name, area, hostname } }, headers);
});

route('POST', '/api/tickets', async (req, res) => {
  const r = requireReporter(req);
  const body = await readBody(req);
  const description = clean(body.description, 4000);
  const topic = clean(body.topic, 60);
  const list = Array.isArray(body.photos) ? body.photos : [];
  if (list.length > cfg.MAX_PHOTOS) throw new HttpError(400, `Máximo ${cfg.MAX_PHOTOS} fotos.`);
  const decoded = list.map(decodePhoto);
  if (!description && !decoded.length) throw new HttpError(400, 'Escribe algo o agrega una foto.');
  const hostname = cleanHost(body.hostname) || r.hostname;
  const id = tickets.create({ reporterId: r.id, topic, description, blocked: !!body.blocked, hostname });
  savePhotos(id, decoded);
  json(res, 201, { ticket: publicTicket(tickets.get(id)) });
});

route('GET', '/api/my/tickets', (req, res) => {
  const r = requireReporter(req);
  json(res, 200, { tickets: tickets.forReporter(r.id).map(publicTicket) });
});

route('GET', '/api/my/tickets/:id', (req, res, { params }) => {
  const r = requireReporter(req);
  const t = tickets.get(Number(params.id));
  if (!t || t.reporter_id !== r.id) throw new HttpError(404, 'No encontramos ese reporte.');
  json(res, 200, {
    ticket: publicTicket(t),
    photos: photos.forTicket(t.id).map((p) => ({ id: p.id, url: '/api/photos/' + p.id })),
    events: events.forTicket(t.id, { includeInternal: false })
  });
});

route('POST', '/api/my/tickets/:id/messages', async (req, res, { params }) => {
  const r = requireReporter(req);
  const t = tickets.get(Number(params.id));
  if (!t || t.reporter_id !== r.id) throw new HttpError(404, 'No encontramos ese reporte.');
  const body = await readBody(req, 64 * 1024);
  const text = clean(body.body, 2000);
  if (!text) throw new HttpError(400, 'Escribe un mensaje.');
  if (body.reopen && t.status === 'resuelto') {
    tickets.update(t.id, { status: 'nuevo', resolved_at: null, eta_at: null });
    events.add(t.id, 'reporter', r.id, 'reopened', '');
  }
  events.add(t.id, 'reporter', r.id, 'message', text);
  tickets.update(t.id, {});
  json(res, 201, { ok: true });
});

route('GET', '/api/photos/:id', (req, res, { params }) => {
  const p = photos.get(Number(params.id));
  if (!p) throw new HttpError(404, 'No encontrada.');
  const admin = currentAdmin(req);
  const rep = admin ? null : currentReporter(req);
  if (!admin && !(rep && rep.id === p.reporter_id)) throw new HttpError(403, 'Sin acceso.');
  const file = path.join(cfg.UPLOAD_DIR, path.basename(p.filename));
  if (!fs.existsSync(file)) throw new HttpError(404, 'No encontrada.');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' });
});

// --- Administrador ---
route('POST', '/api/admin/login', async (req, res) => {
  checkLoginRate(req.socket.remoteAddress);
  const body = await readBody(req, 16 * 1024);
  const a = admins.byUsername(clean(body.username, 60));
  if (!a || !auth.verifyPassword(String(body.password || ''), a.pass_hash)) {
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  }
  loginAttempts.delete(req.socket.remoteAddress);
  json(res, 200, { admin: { id: a.id, name: a.name, username: a.username } },
    { 'Set-Cookie': cookie('gv_adm', auth.makeAdminSession(a.id), { maxAgeDays: 14 }) });
});

route('POST', '/api/admin/logout', (req, res) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': cookie('gv_adm', '', { clear: true }) });
});

route('GET', '/api/admin/me', (req, res) => {
  json(res, 200, { admin: currentAdmin(req) || null, needsSetup: admins.count() === 0 });
});

route('GET', '/api/admin/admins', (req, res) => {
  requireAdmin(req);
  json(res, 200, { admins: admins.list() });
});

route('GET', '/api/admin/stats', (req, res) => {
  requireAdmin(req);
  json(res, 200, { stats: tickets.stats() });
});

route('GET', '/api/admin/tickets', (req, res, { query }) => {
  requireAdmin(req);
  const list = tickets.list({ view: query.get('view') || 'abiertos', q: clean(query.get('q'), 80) });
  json(res, 200, { tickets: list, stats: tickets.stats() });
});

route('GET', '/api/admin/tickets/:id', (req, res, { params }) => {
  requireAdmin(req);
  const t = tickets.get(Number(params.id));
  if (!t) throw new HttpError(404, 'No encontramos ese ticket.');
  json(res, 200, {
    ticket: t,
    photos: photos.forTicket(t.id).map((p) => ({ id: p.id, url: '/api/photos/' + p.id })),
    events: events.forTicket(t.id, { includeInternal: true })
  });
});

function fmtEta(iso) {
  return new Date(iso).toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ || undefined });
}

route('PATCH', '/api/admin/tickets/:id', async (req, res, { params }) => {
  const a = requireAdmin(req);
  const t = tickets.get(Number(params.id));
  if (!t) throw new HttpError(404, 'No encontramos ese ticket.');
  const body = await readBody(req, 16 * 1024);
  const fields = {};
  const changes = [];

  if (body.status !== undefined && body.status !== t.status) {
    if (!STATUS_LABELS[body.status]) throw new HttpError(400, 'Estado inválido.');
    fields.status = body.status;
    fields.resolved_at = body.status === 'resuelto' ? new Date().toISOString() : null;
    changes.push('Estado: ' + STATUS_LABELS[body.status]);
  }
  if (body.assignee_id !== undefined) {
    const id = body.assignee_id === null ? null : Number(body.assignee_id);
    if (id !== null && !admins.byId(id)) throw new HttpError(400, 'Responsable inválido.');
    if (id !== t.assignee_id) {
      fields.assignee_id = id;
      changes.push('Asignado a: ' + (id ? admins.byId(id).name : 'nadie'));
    }
  }
  let eta;
  if (body.eta_minutes !== undefined && body.eta_minutes !== null) {
    const mins = Number(body.eta_minutes);
    if (!Number.isFinite(mins) || mins <= 0 || mins > 60 * 24 * 60) throw new HttpError(400, 'Tiempo estimado inválido.');
    eta = new Date(Date.now() + mins * 60e3).toISOString();
  } else if (body.eta_at !== undefined) {
    if (body.eta_at === null) eta = null;
    else {
      const d = new Date(body.eta_at);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Fecha inválida.');
      eta = d.toISOString();
    }
  }
  if (eta !== undefined && eta !== t.eta_at) {
    fields.eta_at = eta;
    changes.push(eta ? 'Tiempo estimado: ' + fmtEta(eta) : 'Tiempo estimado retirado');
    // Al dar horario a un ticket nuevo, pasa a "En progreso" salvo que se indique otro estado.
    if (eta && t.status === 'nuevo' && fields.status === undefined && body.keep_status !== true) {
      fields.status = 'en_progreso';
      changes.push('Estado: En progreso');
    }
  }
  if (!t.assignee_id && fields.assignee_id === undefined && (fields.eta_at || fields.status)) {
    fields.assignee_id = a.id;
    changes.push('Asignado a: ' + a.name);
  }

  if (Object.keys(fields).length) {
    tickets.update(t.id, fields);
    events.add(t.id, 'admin', a.id, 'update', changes.join(' · '));
  }
  json(res, 200, { ticket: tickets.get(t.id) });
});

route('POST', '/api/admin/tickets/:id/messages', async (req, res, { params }) => {
  const a = requireAdmin(req);
  const t = tickets.get(Number(params.id));
  if (!t) throw new HttpError(404, 'No encontramos ese ticket.');
  const body = await readBody(req, 64 * 1024);
  const text = clean(body.body, 2000);
  if (!text) throw new HttpError(400, 'Escribe un mensaje.');
  events.add(t.id, 'admin', a.id, 'message', text, !!body.internal);
  tickets.update(t.id, {});
  json(res, 201, { ok: true });
});

// ---------- Archivos estáticos ----------
const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/admin/': 'admin.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.resolve(cfg.PUBLIC_DIR, rel);
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  });
  return true;
}

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        await r.handler(req, res, { params, query: url.searchParams });
        return;
      }
      throw new HttpError(404, 'Ruta no encontrada.');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Algo falló en el servidor.' : err.message });
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`${cfg.APP_NAME} · ${cfg.COMPANY} escuchando en http://${cfg.HOST}:${cfg.PORT}`);
    console.log(`  Empleados:      http://<servidor>:${cfg.PORT}/`);
    console.log(`  Administrador:  http://<servidor>:${cfg.PORT}/admin`);
    if (admins.count() === 0) console.log('  ⚠ No hay administradores. Crea uno con: npm run admin -- crear <usuario> "<Nombre>"');
  });
}

module.exports = server;
