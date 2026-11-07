'use strict';
const crypto = require('node:crypto');
const { SECRET } = require('./config');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  return value + '.' + mac;
}

function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value));
  const b = Buffer.from(signed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

// Sesión de admin: "a:<id>:<expira>" firmado.
function makeAdminSession(adminId, days = 14) {
  const exp = Date.now() + days * 864e5;
  return sign('a:' + adminId + ':' + exp);
}

function readAdminSession(cookie) {
  const v = unsign(cookie);
  if (!v) return null;
  const [kind, id, exp] = v.split(':');
  if (kind !== 'a' || Number(exp) < Date.now()) return null;
  return Number(id);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = { hashPassword, verifyPassword, sign, unsign, makeAdminSession, readAdminSession, newToken };
