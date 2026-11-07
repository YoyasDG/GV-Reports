'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-reports-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'secreto123';
process.env.ADMIN_NAME = 'Sistemas';

const server = require('../src/server');
let base;

// JPEG mínimo válido (1x1)
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('flujo completo: empleado reporta, admin asigna tiempo, empleado lo ve', async () => {
  const emp = client();
  assert.equal((await emp('/api/me')).data.reporter, null);
  assert.equal((await emp('/api/tickets', { method: 'POST', body: { description: 'x' } })).status, 401);

  const me = await emp('/api/me', { method: 'POST', body: { name: 'Laura Méndez', area: 'Contabilidad', hostname: 'cont-pc-07' } });
  assert.equal(me.status, 200);
  assert.equal(me.data.reporter.hostname, 'CONT-PC-07');

  assert.equal((await emp('/api/tickets', { method: 'POST', body: {} })).status, 400);
  const bad = await emp('/api/tickets', { method: 'POST', body: { description: 'a', photos: ['data:text/html;base64,PGI+'] } });
  assert.equal(bad.status, 400);

  const created = await emp('/api/tickets', { method: 'POST', body: { description: 'No me abre el correo', topic: 'Correo', photos: [JPEG] } });
  assert.equal(created.status, 201);
  const t = created.data.ticket;
  assert.match(t.folio, /^GV-\d+$/);
  assert.equal(t.queue.position, 1);
  assert.equal(t.photo_count, 1);

  const urgent = await emp('/api/tickets', { method: 'POST', body: { description: 'Sin internet', blocked: true } });
  assert.equal(urgent.data.ticket.queue.position, 1, 'los bloqueados pasan al frente');

  const adm = client();
  assert.equal((await adm('/api/admin/tickets')).status, 401);
  assert.equal((await adm('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'mal' } })).status, 401);
  assert.equal((await adm('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'secreto123' } })).status, 200);

  const list = await adm('/api/admin/tickets?view=sin_tiempo');
  assert.equal(list.data.tickets.length, 2);
  assert.equal(list.data.tickets[0].blocked, true);

  const detail = await adm('/api/admin/tickets/' + t.id);
  assert.equal(detail.data.photos.length, 1);

  const upd = await adm('/api/admin/tickets/' + t.id, { method: 'PATCH', body: { eta_minutes: 60 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.ticket.status, 'en_progreso');
  assert.ok(upd.data.ticket.eta_at);
  assert.equal(upd.data.ticket.assignee_name, 'Sistemas');

  await adm(`/api/admin/tickets/${t.id}/messages`, { method: 'POST', body: { body: 'Ya voy', internal: false } });
  await adm(`/api/admin/tickets/${t.id}/messages`, { method: 'POST', body: { body: 'secreto', internal: true } });

  const mine = await emp('/api/my/tickets');
  const mt = mine.data.tickets.find((x) => x.id === t.id);
  assert.equal(mt.status, 'en_progreso');
  assert.equal(mt.last_message.body, 'Ya voy');
  const myDetail = await emp('/api/my/tickets/' + t.id);
  assert.ok(!myDetail.data.events.some((e) => e.body === 'secreto'), 'las notas internas no se muestran');

  // Fotos: el dueño y el admin pueden verlas, otro empleado no.
  const photoUrl = myDetail.data.photos[0].url;
  const other = client();
  await other('/api/me', { method: 'POST', body: { name: 'Otro' } });
  assert.equal((await other(photoUrl)).status, 403);
  assert.equal((await other('/api/my/tickets/' + t.id)).status, 404);

  // Resolver y reabrir
  await adm('/api/admin/tickets/' + t.id, { method: 'PATCH', body: { status: 'resuelto' } });
  await emp(`/api/my/tickets/${t.id}/messages`, { method: 'POST', body: { body: 'Volvió a fallar', reopen: true } });
  const again = await adm('/api/admin/tickets/' + t.id);
  assert.equal(again.data.ticket.status, 'nuevo');
});
