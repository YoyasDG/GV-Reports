'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

// Carga .env si existe (sin dependencias).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Secreto para firmar sesiones: del entorno o generado una vez y guardado en data/.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  SECRET: loadSecret(),
  APP_NAME: process.env.APP_NAME || 'Reports',
  COMPANY: process.env.COMPANY || 'Grupo Volcanes',
  ADMIN_USER: process.env.ADMIN_USER || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ADMIN_NAME: process.env.ADMIN_NAME || 'Sistemas',
  MAX_PHOTOS: 5,
  MAX_PHOTO_BYTES: 8 * 1024 * 1024,
  MAX_BODY_BYTES: 45 * 1024 * 1024
};
