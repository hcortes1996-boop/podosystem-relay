/**
 * test_claves_copia.js — Cada clínica, su clave de Backblaze, y solo para su carpeta.
 *
 * 01-10-2026: todos los instaladores llevaban la misma clave, capaz de borrar las copias de todas
 * las clínicas. Se fija aquí:
 *   · solo una licencia viva, desde su equipo y con clínica enlazada recibe clave;
 *   · la clave se crea limitada al bucket y a `<clinicaId>/`, sin permisos de gestión;
 *   · se crea UNA vez: pedirla otra vez (reinstalar, restaurar) devuelve la misma;
 *   · se guarda cifrada, nunca en claro;
 *   · al borrar la clínica, la limpieza apunta su keyId ANTES de borrar la fila, para revocarla.
 * Backblaze se simula interceptando `fetch`; el relay es el de verdad.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), `relay_clavescopia_${process.pid}.db`);
const PORT = 3092;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.RELAY_B2_GESTOR_KEY_ID = 'gestor-id';
process.env.RELAY_B2_GESTOR_APP_KEY = 'gestor-secreto';
process.env.COPIAS_BUCKET_ID = 'bucket-123';
process.env.RELAY_COPIA_CLAVE = crypto.randomBytes(32).toString('hex');
delete process.env.RESEND_API_KEY;

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

// ── Backblaze de mentira ──
const fetchReal = global.fetch;
const llamadas = [];
let nClaves = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('backblazeb2.com')) return fetchReal(url, opts);
  const op = u.split('/').pop();
  const cuerpo = opts.body ? JSON.parse(opts.body) : null;
  llamadas.push({ op, cuerpo });
  const r = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (op === 'b2_authorize_account') return r({ accountId: 'cuenta-1', authorizationToken: 'tok', apiInfo: { storageApi: { apiUrl: 'https://api000.backblazeb2.com' } } });
  if (op === 'b2_create_key') { nClaves++; return r({ applicationKeyId: 'clave-' + nClaves, applicationKey: 'SECRETO-' + nClaves }); }
  if (op === 'b2_delete_key') return r({ applicationKeyId: cuerpo.applicationKeyId });
  return { ok: false, status: 400, json: async () => ({ message: 'op desconocida' }) };
};

require('../src/index.js');
const pedir = (cuerpo) => fetchReal(`http://127.0.0.1:${PORT}/api/copias/credenciales`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, cuerpo: await r.json().catch(() => ({})) }));

(async () => {
  let db = null;
  try {
    await new Promise(r => setTimeout(r, 900));
    console.log('\n🧪 Una clave de Backblaze por clínica\n');
    db = require('better-sqlite3')(TMP);
    const lic = (id, estado, clinicaId, hw) => db.prepare(
      "INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, clinicaId, estado, hardwareId) VALUES (?,?,'C','c@x.es',?,?,?)")
      .run(id, 'KEY-' + id, clinicaId, estado, hw);
    db.prepare("INSERT INTO clinicas (id, nombre, apiKey) VALUES ('CLIN_A', 'A', 'ka'), ('CLIN_B', 'B', 'kb')").run();
    lic('VIVA', 'active', 'CLIN_A', 'HW-A');
    lic('PRUEBA', 'trial', 'CLIN_B', 'HW-B');
    lic('CADUCADA', 'expired', 'CLIN_B', 'HW-B');
    lic('SINCLINICA', 'active', null, 'HW-C');

    console.log('── Quién NO la recibe ──');
    prueba((await pedir({ licenseKey: 'KEY-NADA', hardwareId: 'x' })).status === 404, 'una licencia que no existe');
    prueba((await pedir({ licenseKey: 'KEY-PRUEBA', hardwareId: 'HW-B' })).status === 403, 'una prueba (no tiene nube)');
    prueba((await pedir({ licenseKey: 'KEY-CADUCADA', hardwareId: 'HW-B' })).status === 403, 'una licencia caducada');
    prueba((await pedir({ licenseKey: 'KEY-VIVA', hardwareId: 'OTRO-PC' })).status === 403, 'desde otro equipo');
    prueba((await pedir({ licenseKey: 'KEY-VIVA' })).status === 403,
      'SIN decir el equipo — en /recuperacion/api-key eso se saltaba la comprobación');
    prueba((await pedir({ licenseKey: 'KEY-SINCLINICA', hardwareId: 'HW-C' })).status === 404, 'una licencia sin clínica enlazada');
    prueba(!llamadas.some(l => l.op === 'b2_create_key'), 'y en ninguno de esos casos se ha creado ninguna clave');

    console.log('\n── La licencia viva, desde su equipo ──');
    const r1 = await pedir({ licenseKey: 'KEY-VIVA', hardwareId: 'HW-A' });
    prueba(r1.status === 200 && r1.cuerpo.keyId === 'clave-1' && r1.cuerpo.appKey === 'SECRETO-1', 'recibe su clave', JSON.stringify(r1.cuerpo));
    prueba(r1.cuerpo.prefijo === 'CLIN_A/' && r1.cuerpo.bucket === 'podosystem-backups-2026', 'con su carpeta y el bucket');
    const crear = llamadas.find(l => l.op === 'b2_create_key').cuerpo;
    prueba(crear.namePrefix === 'CLIN_A/' && JSON.stringify(crear.bucketIds) === '["bucket-123"]' && crear.accountId === 'cuenta-1',
      'Backblaze la crea limitada al bucket y a SU carpeta', JSON.stringify(crear));
    prueba(!crear.capabilities.some(c => /Keys|Buckets$|Retention|bypass/i.test(c) && c !== 'listBuckets'),
      'sin permisos de gestión: ni crear claves, ni tocar el bucket, ni retenciones', crear.capabilities.join(','));
    prueba(crear.capabilities.includes('deleteFiles'), 'pero sí borrar dentro de su carpeta (rotar las copias viejas)');

    const r2 = await pedir({ licenseKey: 'KEY-VIVA', hardwareId: 'HW-A' });
    prueba(r2.cuerpo.keyId === 'clave-1' && r2.cuerpo.appKey === 'SECRETO-1' && nClaves === 1,
      'pedirla otra vez devuelve LA MISMA: reinstalar no llena Backblaze de claves');
    const fila = db.prepare("SELECT * FROM claves_copia WHERE clinicaId = 'CLIN_A'").get();
    prueba(fila && !String(fila.appKeyCifrada).includes('SECRETO') && fila.keyId === 'clave-1', 'y se guarda CIFRADA, nunca en claro');

    console.log('\n── Sin configurar en el servidor ──');
    delete process.env.RELAY_B2_GESTOR_APP_KEY;
    db.prepare("DELETE FROM claves_copia").run();
    const r3 = await pedir({ licenseKey: 'KEY-VIVA', hardwareId: 'HW-A' });
    prueba(r3.status === 503 && !JSON.stringify(r3.cuerpo).includes('GESTOR'),
      'responde 503 sin decir qué variable falta (el PC sigue con la del instalador)', JSON.stringify(r3.cuerpo));
    process.env.RELAY_B2_GESTOR_APP_KEY = 'gestor-secreto';

    console.log('\n── Al borrar la clínica, su clave se revoca ──');
    const { revisarClinicas } = require('../src/lib/limpieza-clinicas');
    await pedir({ licenseKey: 'KEY-VIVA', hardwareId: 'HW-A' });   // vuelve a tener clave
    const keyId = db.prepare("SELECT keyId FROM claves_copia WHERE clinicaId = 'CLIN_A'").get().keyId;
    db.prepare("UPDATE licencias SET estado = 'expired' WHERE id = 'VIVA'").run();
    revisarClinicas(db, { ahora: new Date('2026-10-01T00:00:00Z'), modo: 'aplicar' });   // arranca el reloj
    const inf = revisarClinicas(db, { ahora: new Date('2026-11-15T00:00:00Z'), modo: 'aplicar' }); // pasado el mes
    prueba(inf.borradas.some(d => d.clinicaId === 'CLIN_A'), 'la limpieza borra la clínica (licencia caducada hace meses)');
    prueba(inf.clavesARevocar.some(k => k.clinicaId === 'CLIN_A' && k.keyId === keyId),
      'y apunta su keyId ANTES de borrar la fila — si no, la clave quedaría viva en Backblaze', JSON.stringify(inf.clavesARevocar));
    const { revocarPorKeyId } = require('../src/lib/claves-copia');
    const rv = await revocarPorKeyId(keyId);
    prueba(rv.revocada && llamadas.some(l => l.op === 'b2_delete_key' && l.cuerpo.applicationKeyId === keyId), 'y se revoca en Backblaze');
  } catch (e) {
    fallos++; console.log('💥', e);
  } finally {
    try { db && db.close(); } catch (_) {}
    for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(`\n${ok} bien, ${fallos} mal\n`);
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallos ? 1 : 0);
})();
