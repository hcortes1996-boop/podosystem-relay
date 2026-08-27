/**
 * test_trials.js — Registro de quien se descarga la prueba.
 *
 * El boton de demo.html apuntaba directo al EXE: no se sabia quien probaba el producto, ni
 * cuanta gente, ni que porcentaje acababa comprando. Ahora hay que dejar nombre, correo y
 * telefono, y aceptar la politica de privacidad, antes de que aparezca la descarga.
 *
 * ── Lo que de verdad hay que fijar ───────────────────────────────────────────
 *
 *   · SIN consentimiento NO se guarda nada. Es un rechazo, no un campo que se apunta:
 *     telefono y correo de un profesional identificable son datos personales.
 *   · Volver a descargar NO crea un interesado nuevo — si no, uno que entra tres veces
 *     pareceria tres.
 *   · Que el registro falle NO puede dejar sin descargar a un cliente potencial.
 *   · Y la conversion se calcula sobre correos: hay que poder leerla sabiendo que es un
 *     SUELO, no un dato exacto.
 *
 * Uso:  node scripts/test_trials.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_trials_${process.pid}.db`);
const PORT = 3095;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

// La resolucion de la ultima version pregunta a GitHub. Aqui se sustituye para no depender
// de la red ni de que el repositorio publico este como este hoy.
const descarga = require('../src/lib/descarga');
descarga.ultimaDescarga = async () => ({
  url: 'https://github.com/x/y/releases/download/v9.9.9/PodoSystem_v9.9.9.exe',
  version: 'v9.9.9',
});

require('../src/index.js');

const BASE = `http://127.0.0.1:${PORT}`;
const registrar = (body) => fetch(`${BASE}/api/trial/registrar`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const BUENO = {
  nombre: 'Ana Pérez', email: 'ana@ejemplo.test', telefono: '600112233',
  clinica: 'Clínica Ejemplo', provincia: 'Sevilla', aceptaPrivacidad: true,
};

(async () => {
  await new Promise(r => setTimeout(r, 900));
  const db = require('better-sqlite3')(TMP);
  const filas = () => db.prepare('SELECT * FROM trials ORDER BY creadaEn').all();

  console.log('\n── Sin consentimiento no se guarda NADA ──');

  let r = await registrar({ ...BUENO, aceptaPrivacidad: false });
  ok(r.status === 400, 'sin aceptar la privacidad → 400', `status ${r.status}`);
  ok(/privacidad/i.test(r.body.error || ''), 'y lo dice claro', r.body.error);
  ok(filas().length === 0, 'no queda ninguna fila: ni el correo ni el teléfono se guardan');

  r = await registrar({ ...BUENO, aceptaPrivacidad: undefined });
  ok(r.status === 400 && filas().length === 0, 'omitirlo tampoco cuela');

  console.log('\n── Validación de los datos ──');
  for (const [campo, valor, motivo] of [
    ['nombre',   '',              'sin nombre'],
    ['email',    'no-es-correo',  'correo inválido'],
    ['email',    '',              'sin correo'],
    ['telefono', '123',           'teléfono demasiado corto'],
    ['telefono', '',              'sin teléfono'],
  ]) {
    const rr = await registrar({ ...BUENO, [campo]: valor });
    ok(rr.status === 400, `rechaza: ${motivo}`, JSON.stringify(rr.body));
  }
  ok(filas().length === 0, 'y ninguno de esos intentos ha guardado nada');

  console.log('\n── El caso bueno ──');
  r = await registrar(BUENO);
  ok(r.status === 200 && r.body.ok === true, 'se acepta', JSON.stringify(r.body));
  ok(/\.exe$/.test(r.body.descargaUrl || ''), 'devuelve la URL del EXE', r.body.descargaUrl);
  ok(r.body.version === 'v9.9.9', 'y la versión', r.body.version);

  const f = filas()[0];
  ok(filas().length === 1, 'queda una fila');
  ok(f.email === 'ana@ejemplo.test', 'con el correo en minúsculas', f.email);
  ok(f.acepta_privacidad === 1 && !!f.acepta_privacidad_en,
    'con la prueba del consentimiento y su fecha', f.acepta_privacidad_en);
  ok(f.version_descargada === 'v9.9.9', 'y la versión que se llevó');
  ok(!!f.ip || f.ip === null, 'se anota la IP (o null si no se pudo)');

  console.log('\n── Volver a descargar no crea otro interesado ──');
  await registrar({ ...BUENO, telefono: '600999888' });
  const g = filas()[0];
  ok(filas().length === 1, 'sigue habiendo UNA fila, no dos');
  ok(g.descargas === 2, 'pero cuenta dos descargas', String(g.descargas));
  ok(g.telefono === '600999888', 'y actualiza los datos con lo último que puso');

  // Correo distinto = interesado distinto.
  await registrar({ ...BUENO, email: 'otro@ejemplo.test' });
  ok(filas().length === 2, 'otro correo sí es otro interesado');

  console.log('\n── El panel: lista y conversión ──');
  const admin = (ruta, opts = {}) => fetch(`${BASE}/admin${ruta}`, {
    ...opts, headers: { Authorization: 'Bearer token-de-prueba', ...(opts.headers || {}) },
  }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));

  let a = await fetch(`${BASE}/admin/api/trials`).then(x => x.status);
  ok(a === 401, 'sin token, el listado no se ve', String(a));

  a = await admin('/api/trials');
  ok(a.status === 200 && a.body.trials.length === 2, 'con token se ven los dos');
  ok(a.body.stats.total === 2, 'total correcto');
  ok(a.body.stats.convertidos === 0, 'nadie ha comprado todavía');
  ok(a.body.stats.porcentaje === 0, 'conversión 0 %');

  // Uno de ellos compra: aparece una licencia con su correo.
  db.prepare(`INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado)
              VALUES ('lic_conv', 'PODO-CONV-0001', 'Ana Pérez', 'ANA@Ejemplo.test', 'active')`).run();

  a = await admin('/api/trials');
  ok(a.body.stats.convertidos === 1, 'ahora hay una conversión');
  ok(a.body.stats.porcentaje === 50, 'y el porcentaje sale 50', String(a.body.stats.porcentaje));
  const convertida = a.body.trials.find(t => t.email === 'ana@ejemplo.test');
  ok(convertida?.convertido === true, 'la fila correcta queda marcada como convertida');
  ok(a.body.trials.find(t => t.email === 'otro@ejemplo.test')?.convertido === false,
    'y la otra no');

  console.log('\n── Derecho de supresión ──');
  const idBorrar = a.body.trials[0].id;
  const d = await admin(`/api/trials/${idBorrar}`, { method: 'DELETE' });
  ok(d.status === 200 && d.body.borrados === 1, 'se puede borrar a quien lo pida');
  ok(filas().length === 1, 'y desaparece de la base');

  console.log('\n── Sin trials, el porcentaje es null y no 0 ──');
  db.prepare('DELETE FROM trials').run();
  a = await admin('/api/trials');
  ok(a.body.stats.porcentaje === null,
    'null, porque 0 % haría pensar que nadie convierte', String(a.body.stats.porcentaje));

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}`);
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
