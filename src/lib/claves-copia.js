'use strict';
/**
 * claves-copia.js — Una clave de Backblaze por clínica, que solo ve su carpeta.
 *
 * ── Por qué existe (01-10-2026) ──────────────────────────────────────────────
 *
 * Todos los instaladores llevan dentro LA MISMA clave de Backblaze, con permiso sobre el bucket
 * entero. Quien la saque de un EXE —basta con abrir `resources/b2-config.json`— puede **borrar
 * las copias de todas las clínicas** (verificado contra el bucket el 09-09-2026). El cifrado de las
 * copias impide leerlas, no borrarlas. Y en ese mismo bucket están las copias del propio relay.
 *
 * Con esto, cada clínica pide al relay SU clave, limitada con `namePrefix` a `<clinicaId>/`. Una
 * clave sacada de un equipo solo alcanza las copias de ese equipo.
 *
 * ── Cómo ─────────────────────────────────────────────────────────────────────
 *
 *   · El relay tiene una clave GESTORA (`RELAY_B2_GESTOR_KEY_ID` / `_APP_KEY`) con permiso para
 *     crear y borrar claves. Vive solo en Railway.
 *   · La primera vez que una clínica la pide se crea con `b2_create_key` y se guarda aquí CIFRADA
 *     (AES-256-GCM, clave derivada de `RELAY_COPIA_CLAVE`). Las siguientes se devuelve la misma:
 *     reinstalar o restaurar en otro PC no crea claves nuevas.
 *   · Al borrar una clínica (limpieza), se revoca su clave en Backblaze.
 *
 * La clave de cifrado de aquí NO es la de las copias de las clínicas: esas las cifra el PC con
 * una contraseña que solo tiene el cliente. Esto solo protege la credencial de acceso al bucket.
 */

const crypto = require('crypto');

const BUCKET_NOMBRE_DEFECTO = 'podosystem-backups-2026';
const REGION_DEFECTO = 'eu-central-003';

/** Lo que puede hacer una clave de clínica, y nada más. `deleteFiles` hace falta para rotar
 *  (se conservan las últimas N copias); el prefijo la limita a SU carpeta. */
const CAPACIDADES_CLINICA = ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles'];

function configuracion(env = process.env) {
  const faltan = [];
  if (!env.RELAY_B2_GESTOR_KEY_ID) faltan.push('RELAY_B2_GESTOR_KEY_ID');
  if (!env.RELAY_B2_GESTOR_APP_KEY) faltan.push('RELAY_B2_GESTOR_APP_KEY');
  if (!env.COPIAS_BUCKET_ID) faltan.push('COPIAS_BUCKET_ID');
  if (!claveDeCifrado(env)) faltan.push('RELAY_COPIA_CLAVE');
  return {
    faltan,
    keyId: env.RELAY_B2_GESTOR_KEY_ID, appKey: env.RELAY_B2_GESTOR_APP_KEY,
    bucketId: env.COPIAS_BUCKET_ID,
    bucket: env.COPIAS_BUCKET_NOMBRE || BUCKET_NOMBRE_DEFECTO,
    region: env.COPIAS_REGION || REGION_DEFECTO,
  };
}

/** Derivada de la de las copias del relay: una sola clave que custodiar fuera de Railway. */
function claveDeCifrado(env = process.env) {
  const base = String(env.RELAY_COPIA_CLAVE || '').trim();
  let bytes = null;
  if (/^[0-9a-f]{64}$/i.test(base)) bytes = Buffer.from(base, 'hex');
  else { try { const b = Buffer.from(base, 'base64'); if (b.length === 32) bytes = b; } catch (_) {} }
  if (!bytes) return null;
  return Buffer.from(crypto.hkdfSync('sha256', bytes, Buffer.alloc(0), Buffer.from('claves-copia-clinica'), 32));
}

function cifrar(texto, clave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}

function descifrar(b64, clave) {
  const b = Buffer.from(String(b64), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', clave, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

function asegurarTabla(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS claves_copia (
    clinicaId      TEXT PRIMARY KEY,
    keyId          TEXT NOT NULL,
    appKeyCifrada  TEXT NOT NULL,
    prefijo        TEXT NOT NULL,
    creadaEn       TEXT NOT NULL
  )`);
}

/** Backblaze, API nativa (como copia-relay.js: sin SDK). `fetchImpl` se inyecta en las pruebas. */
async function gestor(cfg, fetchImpl = fetch) {
  const basic = Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64');
  const r = await fetchImpl('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
    { headers: { Authorization: 'Basic ' + basic } });
  if (!r.ok) throw new Error('Backblaze no autoriza la clave gestora (' + r.status + ')');
  const a = await r.json();
  const apiUrl = (a.apiInfo && a.apiInfo.storageApi && a.apiInfo.storageApi.apiUrl) || a.apiUrl;
  const api = async (op, cuerpo) => {
    const res = await fetchImpl(`${apiUrl}/b2api/v3/${op}`, {
      method: 'POST', headers: { Authorization: a.authorizationToken }, body: JSON.stringify(cuerpo),
    });
    if (!res.ok) {
      let detalle = ''; try { detalle = (await res.json()).message || ''; } catch (_) {}
      throw new Error(`Backblaze ${op}: ${res.status} ${detalle}`.trim());
    }
    return res.json();
  };
  return { api, accountId: a.accountId };
}

/**
 * La clave de una clínica: la guardada, o una nueva si no tiene. Devuelve lo que necesita el PC.
 * Lanza si falta configuración o Backblaze falla — el PC, entonces, sigue con la del instalador.
 */
async function claveDeClinica(db, clinicaId, { env = process.env, fetchImpl = fetch, ahora = new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(clinicaId || ''))) throw new Error('clinicaId no válido');
  const cfg = configuracion(env);
  if (cfg.faltan.length) throw new Error('Sin configurar en el servidor: ' + cfg.faltan.join(', '));
  const cifra = claveDeCifrado(env);
  asegurarTabla(db);

  const prefijo = `${clinicaId}/`;
  const guardada = db.prepare('SELECT keyId, appKeyCifrada, prefijo FROM claves_copia WHERE clinicaId = ?').get(clinicaId);
  if (guardada) {
    return { keyId: guardada.keyId, appKey: descifrar(guardada.appKeyCifrada, cifra),
             bucket: cfg.bucket, region: cfg.region, prefijo: guardada.prefijo, nueva: false };
  }

  const { api, accountId } = await gestor(cfg, fetchImpl);
  const k = await api('b2_create_key', {
    accountId,
    capabilities: CAPACIDADES_CLINICA,
    keyName: `clinica-${clinicaId}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 100),
    // En la API v3 es `bucketId` (uno); `bucketIds` es de la v4 y la v3 lo rechaza con un 400.
    bucketId: cfg.bucketId,
    namePrefix: prefijo,
  });
  if (!k || !k.applicationKeyId || !k.applicationKey) throw new Error('Backblaze no devolvió la clave');
  db.prepare('INSERT INTO claves_copia (clinicaId, keyId, appKeyCifrada, prefijo, creadaEn) VALUES (?,?,?,?,?)')
    .run(clinicaId, k.applicationKeyId, cifrar(k.applicationKey, cifra), prefijo, ahora.toISOString());
  return { keyId: k.applicationKeyId, appKey: k.applicationKey,
           bucket: cfg.bucket, region: cfg.region, prefijo, nueva: true };
}

/** Al borrar una clínica: fuera su clave en Backblaze y aquí. No lanza: la limpieza sigue. */
async function revocarClave(db, clinicaId, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    asegurarTabla(db);
    const g = db.prepare('SELECT keyId FROM claves_copia WHERE clinicaId = ?').get(clinicaId);
    if (!g) return { revocada: false, motivo: 'sin clave' };
    const cfg = configuracion(env);
    if (cfg.faltan.length) return { revocada: false, motivo: 'sin configurar' };
    const { api } = await gestor(cfg, fetchImpl);
    await api('b2_delete_key', { applicationKeyId: g.keyId });
    db.prepare('DELETE FROM claves_copia WHERE clinicaId = ?').run(clinicaId);
    return { revocada: true };
  } catch (e) {
    return { revocada: false, motivo: e.message };
  }
}

/** Para la limpieza: la fila ya se borró con la clínica, así que llega solo el keyId. */
async function revocarPorKeyId(keyId, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    const cfg = configuracion(env);
    if (cfg.faltan.length) return { revocada: false, motivo: 'sin configurar' };
    const { api } = await gestor(cfg, fetchImpl);
    await api('b2_delete_key', { applicationKeyId: keyId });
    return { revocada: true };
  } catch (e) {
    return { revocada: false, motivo: e.message };
  }
}

module.exports = { claveDeClinica, revocarClave, revocarPorKeyId, configuracion, gestor, CAPACIDADES_CLINICA, asegurarTabla,
                   _cifrar: cifrar, _descifrar: descifrar, _claveDeCifrado: claveDeCifrado };
