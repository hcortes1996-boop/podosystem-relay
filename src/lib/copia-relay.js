/**
 * lib/copia-relay.js — Copia diaria CIFRADA de la base del relay (30-09-2026)
 *
 * Hasta hoy la base del relay (reservas de pacientes, licencias, clínicas) no tenía NINGUNA copia:
 * si Railway perdía el disco, se perdía todo. El art. 32 RGPD pide poder restablecer la
 * disponibilidad de los datos, y el Contrato de Encargado lo va a prometer. Aquí está.
 *
 * ── Cómo ────────────────────────────────────────────────────────────────────
 *
 *   1. `db.backup()` de better-sqlite3: copia consistente en caliente, sin parar el relay.
 *   2. gzip (fflate) y **cifrado AES-256-GCM** con `RELAY_COPIA_CLAVE` (32 bytes, en hex o base64),
 *      que solo está en Railway. Backblaze guarda un fichero que no puede leer.
 *   3. Subida a Backblaze con su API nativa (sin SDK): `relay/relay-AAAA-MM-DD.db.gz.enc`.
 *   4. Se borran las de más de `DIAS_CONSERVACION` días.
 *
 * Formato del fichero: `PSRC1` (5 bytes) + IV (12) + etiqueta GCM (16) + datos cifrados.
 * `descifrar()` lo abre; `scripts/descifrar-copia-relay.js` lo usa para restaurar.
 *
 * Variables de Railway (si falta alguna, NO se copia y el informe lo dice):
 *   RELAY_COPIA_KEY_ID, RELAY_COPIA_APP_KEY  — clave de Backblaze, idealmente limitada a un bucket
 *   RELAY_COPIA_BUCKET_ID                    — si la clave no está limitada a un bucket
 *   RELAY_COPIA_CLAVE                        — la clave de cifrado. ⚠️ Guardarla también FUERA de
 *                                              Railway (gestor de contraseñas): sin ella, las
 *                                              copias no se pueden abrir.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gzipSync, gunzipSync } = require('fflate');

const MAGIA = Buffer.from('PSRC1');
const PREFIJO = 'relay/';
const DIAS_CONSERVACION = 30;
const DIA_MS = 24 * 60 * 60 * 1000;

function claveDeCifrado(texto) {
  const t = String(texto || '').trim();
  let k = null;
  if (/^[0-9a-f]{64}$/i.test(t)) k = Buffer.from(t, 'hex');
  else { try { k = Buffer.from(t, 'base64'); } catch (_) {} }
  return k && k.length === 32 ? k : null;
}

function cifrar(datos, clave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const cuerpo = Buffer.concat([c.update(datos), c.final()]);
  return Buffer.concat([MAGIA, iv, c.getAuthTag(), cuerpo]);
}

function descifrar(fichero, clave) {
  if (!fichero.subarray(0, 5).equals(MAGIA)) throw new Error('No es una copia del relay (cabecera distinta)');
  const iv = fichero.subarray(5, 17), tag = fichero.subarray(17, 33), cuerpo = fichero.subarray(33);
  const d = crypto.createDecipheriv('aes-256-gcm', clave, iv);
  d.setAuthTag(tag);
  return Buffer.from(gunzipSync(Buffer.concat([d.update(cuerpo), d.final()])));
}

function configuracion(env = process.env) {
  const faltan = [];
  if (!env.RELAY_COPIA_KEY_ID) faltan.push('RELAY_COPIA_KEY_ID');
  if (!env.RELAY_COPIA_APP_KEY) faltan.push('RELAY_COPIA_APP_KEY');
  const clave = claveDeCifrado(env.RELAY_COPIA_CLAVE);
  if (!clave) faltan.push('RELAY_COPIA_CLAVE (32 bytes en hex o base64)');
  return { faltan, clave, keyId: env.RELAY_COPIA_KEY_ID, appKey: env.RELAY_COPIA_APP_KEY,
           bucketId: env.RELAY_COPIA_BUCKET_ID || null };
}

// ── Backblaze, API nativa ──────────────────────────────────────────────────
async function b2(cfg) {
  const basic = Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64');
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
    { headers: { Authorization: 'Basic ' + basic } });
  if (!r.ok) throw new Error('Backblaze no autoriza la clave (' + r.status + ')');
  const a = await r.json();
  const bucketId = cfg.bucketId || (a.allowed && a.allowed.bucketId);
  if (!bucketId) throw new Error('No se sabe en qué bucket copiar: define RELAY_COPIA_BUCKET_ID o limita la clave a un bucket');
  const api = async (op, cuerpo) => {
    const res = await fetch(`${a.apiUrl}/b2api/v2/${op}`, {
      method: 'POST', headers: { Authorization: a.authorizationToken }, body: JSON.stringify(cuerpo),
    });
    if (!res.ok) throw new Error(`Backblaze ${op}: ${res.status}`);
    return res.json();
  };
  return { api, bucketId };
}

async function subir(cx, nombre, datos) {
  const up = await cx.api('b2_get_upload_url', { bucketId: cx.bucketId });
  const res = await fetch(up.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: up.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(nombre),
      'Content-Type': 'application/octet-stream',
      'X-Bz-Content-Sha1': crypto.createHash('sha1').update(datos).digest('hex'),
    },
    body: datos,
  });
  if (!res.ok) throw new Error('Backblaze no aceptó la subida (' + res.status + ')');
  return res.json();
}

/**
 * Una copia. No lanza: devuelve el resultado, que queda en `ultimo()` y en el log.
 * `ahora` y `env` se pueden inyectar para probarlo.
 */
async function hacerCopia(db, { env = process.env, ahora = new Date() } = {}) {
  const cfg = configuracion(env);
  const resultado = { fecha: ahora.toISOString(), ok: false };
  if (cfg.faltan.length) {
    resultado.omitida = true;
    resultado.motivo = 'Falta configuración: ' + cfg.faltan.join(', ');
    return resultado;
  }
  const tmp = path.join(os.tmpdir(), `relay-copia-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const crudo = fs.readFileSync(tmp);
    const cifrado = cifrar(Buffer.from(gzipSync(crudo, { level: 6 })), cfg.clave);
    const nombre = `${PREFIJO}relay-${ahora.toISOString().slice(0, 10)}.db.gz.enc`;
    const cx = await b2(cfg);
    await subir(cx, nombre, cifrado);

    // Conservación: fuera las de más de DIAS_CONSERVACION días. Solo bajo el prefijo del relay.
    const lista = await cx.api('b2_list_file_names', { bucketId: cx.bucketId, prefix: PREFIJO, maxFileCount: 1000 });
    const corte = ahora.getTime() - DIAS_CONSERVACION * DIA_MS;
    let borradas = 0;
    for (const f of lista.files || []) {
      if (f.uploadTimestamp < corte) {
        await cx.api('b2_delete_file_version', { fileName: f.fileName, fileId: f.fileId });
        borradas++;
      }
    }
    Object.assign(resultado, { ok: true, fichero: nombre, bytesBase: crudo.length, bytesCopia: cifrado.length, antiguasBorradas: borradas });
  } catch (e) {
    resultado.error = e.message;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return resultado;
}

let ultimoResultado = null;
function ultimo() { return ultimoResultado; }

function iniciarCopiaRelay(db) {
  const pasada = async () => {
    ultimoResultado = await hacerCopia(db);
    if (ultimoResultado.omitida) console.warn('[copia-relay] ⚠️ NO se copia la base del relay — ' + ultimoResultado.motivo);
    else if (ultimoResultado.ok) console.log(`[copia-relay] ✅ ${ultimoResultado.fichero} (${ultimoResultado.bytesCopia} B), ${ultimoResultado.antiguasBorradas} antigua(s) borrada(s)`);
    else console.error('[copia-relay] ❌ la copia falló: ' + ultimoResultado.error);
  };
  setTimeout(pasada, 10 * 60 * 1000);           // diez minutos tras arrancar
  setInterval(pasada, 24 * 60 * 60 * 1000);     // y una vez al día
}

module.exports = { hacerCopia, iniciarCopiaRelay, ultimo, cifrar, descifrar, claveDeCifrado, configuracion, DIAS_CONSERVACION };
