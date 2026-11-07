'use strict';
// Uso:
//   npm run admin -- crear <usuario> "<Nombre visible>"   (pide la contraseña)
//   npm run admin -- password <usuario>                   (cambia la contraseña)
//   npm run admin -- lista
const readline = require('node:readline');
const { admins } = require('../src/db');
const { hashPassword } = require('../src/auth');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function askPassword() {
  const fromEnv = process.env.NEW_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  const p1 = await ask('Contraseña (mín. 8 caracteres): ');
  const p2 = await ask('Repite la contraseña: ');
  if (p1 !== p2) throw new Error('Las contraseñas no coinciden.');
  if (p1.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  return p1;
}

(async () => {
  const [cmd, username, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'crear' && username) {
      if (admins.byUsername(username)) throw new Error('Ese usuario ya existe.');
      const name = rest.join(' ') || username;
      admins.create(username, name, hashPassword(await askPassword()));
      console.log(`Listo: administrador "${username}" (${name}) creado.`);
    } else if (cmd === 'password' && username) {
      const r = admins.setPassword(username, hashPassword(await askPassword()));
      if (!r.changes) throw new Error('No existe ese usuario.');
      console.log('Contraseña actualizada.');
    } else if (cmd === 'lista') {
      for (const a of admins.list()) console.log(`${a.username}\t${a.name}`);
    } else {
      console.log('Uso:\n  npm run admin -- crear <usuario> "<Nombre>"\n  npm run admin -- password <usuario>\n  npm run admin -- lista');
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exitCode = 1;
  }
})();
