#!/usr/bin/env node
'use strict';
/**
 * test_copia_relay.js — la copia diaria cifrada de la base del relay (30-09-2026).
 *
 * Backblaze se simula en memoria sustituyendo `fetch`: lo que se comprueba es lo que decide
 * PodoSystem —que sin configuración no copia y lo dice, que lo subido está CIFRADO, que se puede
 * descifrar y es la base entera, y que solo se borran las copias viejas y solo las suyas—.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), `relay_copia_${process.pid}.db`);
process.env.DB_PATH = TMP;
const { initDB } = require('../src/db');
const { hacerCopia, descifrar, claveDeCifrado } = require('../src/lib/copia-relay');
const Database = require('better-sqlite3');

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.error('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

// ── Backblaze de mentira ────────────────────────────────────────────────────
const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-09-30T03:00:00Z');
const bucket = new Map();   // fileName -> { fileId, datos, uploadTimestamp }
bucket.set('relay/relay-2026-08-01.db.gz.enc', { fileId: 'f-viejo', datos: Buffer.from('x'), uploadTimestamp: AHORA.getTime() - 60 * DIA });
bucket.set('relay/relay-2026-09-25.db.gz.enc', { fileId: 'f-reciente', datos: Buffer.from('x'), uploadTimestamp: AHORA.getTime() - 5 * DIA });
bucket.set('otra-cosa/no-tocar.bin', { fileId: 'f-ajeno', datos: Buffer.from('x'), uploadTimestamp: AHORA.getTime() - 90 * DIA });
let n = 0;
global.fetch = async (url, opt = {}) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (url.includes('b2_authorize_account')) return json({ apiUrl: 'https://api.b2', authorizationToken: 'T', allowed: { bucketId: 'B1' } });
  if (url.endsWith('b2_get_upload_url')) return json({ uploadUrl: 'https://up.b2/x', authorizationToken: 'U' });
  if (url === 'https://up.b2/x') {
    const nombre = decodeURIComponent(opt.headers['X-Bz-File-Name']);
    const sha = crypto.createHash('sha1').update(opt.body).digest('hex');
    if (sha !== opt.headers['X-Bz-Content-Sha1']) return { ok: false, status: 400, json: async () => ({}) };
    bucket.set(nombre, { fileId: 'f' + (++n), datos: Buffer.from(opt.body), uploadTimestamp: AHORA.getTime() });
    return json({ fileName: nombre });
  }
  if (url.endsWith('b2_list_file_names')) {
    const { prefix } = JSON.parse(opt.body);
    return json({ files: [...bucket.entries()].filter(([k]) => k.startsWith(prefix))
      .map(([fileName, v]) => ({ fileName, fileId: v.fileId, uploadTimestamp: v.uploadTimestamp })) });
  }
  if (url.endsWith('b2_delete_file_version')) { bucket.delete(JSON.parse(opt.body).fileName); return json({}); }
  return { ok: false, status: 404, json: async () => ({}) };
};

(async () => {
  const db = initDB();
  db.prepare("INSERT INTO clinicas (id, nombre, apiKey) VALUES ('C1', 'CLINICA PRUEBA', 'k1')").run();
  db.prepare("INSERT INTO reservas (id, clinicaId, fecha, hora, nombre, telefono) VALUES ('R1', 'C1', '2026-10-02', '10:00', 'PACIENTE SECRETO', '600111222')").run();
  const CLAVE_HEX = crypto.randomBytes(32).toString('hex');
  const env = { RELAY_COPIA_KEY_ID: 'kid', RELAY_COPIA_APP_KEY: 'app', RELAY_COPIA_CLAVE: CLAVE_HEX };

  try {
    console.log('\n🧪 Copia diaria cifrada del relay\n');

    const sin = await hacerCopia(db, { env: {}, ahora: AHORA });
    prueba(sin.omitida && /RELAY_COPIA_KEY_ID/.test(sin.motivo) && /RELAY_COPIA_CLAVE/.test(sin.motivo),
      'sin configuración NO copia, y dice qué falta', JSON.stringify(sin));
    const corta = await hacerCopia(db, { env: { ...env, RELAY_COPIA_CLAVE: 'corta' }, ahora: AHORA });
    prueba(corta.omitida, 'una clave de cifrado que no mide 32 bytes no vale');

    const r = await hacerCopia(db, { env, ahora: AHORA });
    prueba(r.ok && r.fichero === 'relay/relay-2026-09-30.db.gz.enc', 'con configuración, sube la copia del día', JSON.stringify(r));
    const subido = bucket.get('relay/relay-2026-09-30.db.gz.enc');
    prueba(subido && !subido.datos.includes(Buffer.from('PACIENTE SECRETO')) && !subido.datos.includes(Buffer.from('600111222')),
      'lo que llega a Backblaze no deja leer ni el nombre ni el teléfono del paciente');
    // La compresión sola ya escondería las cadenas: se comprueba que además está CIFRADO, o sea,
    // que sin la clave ni siquiera se puede descomprimir.
    const { gunzipSync } = require('fflate');
    let seDescomprime = true;
    try { gunzipSync(subido.datos.subarray(33)); } catch (_) { seDescomprime = false; }
    let seDescomprimeEntero = true;
    try { gunzipSync(subido.datos); } catch (_) { seDescomprimeEntero = false; }
    prueba(!seDescomprime && !seDescomprimeEntero && subido.datos.subarray(0, 5).toString() === 'PSRC1',
      'y está CIFRADO, no solo comprimido: sin la clave ni siquiera se descomprime');

    const base = descifrar(subido.datos, claveDeCifrado(CLAVE_HEX));
    const restaurada = path.join(os.tmpdir(), `relay_restaurada_${process.pid}.db`);
    fs.writeFileSync(restaurada, base);
    const rdb = new Database(restaurada, { readonly: true });
    const fila = rdb.prepare("SELECT nombre FROM reservas WHERE id = 'R1'").get();
    rdb.close(); fs.unlinkSync(restaurada);
    prueba(fila && fila.nombre === 'PACIENTE SECRETO', 'y se DESCIFRA en una base completa: la copia sirve para restaurar');

    let rechaza = false;
    try { descifrar(subido.datos, crypto.randomBytes(32)); } catch (_) { rechaza = true; }
    prueba(rechaza, 'con otra clave no se abre');

    prueba(!bucket.has('relay/relay-2026-08-01.db.gz.enc'), 'se borra la copia de hace 60 días');
    prueba(bucket.has('relay/relay-2026-09-25.db.gz.enc'), 'se conserva la de hace 5 días');
    prueba(bucket.has('otra-cosa/no-tocar.bin'), 'y NUNCA toca nada fuera de su carpeta');
  } finally {
    try { db.close(); } catch (_) {}
    for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(`\n${ok} bien, ${fallos} mal`);
  process.exit(fallos ? 1 : 0);
})();
