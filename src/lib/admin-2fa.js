'use strict';
/**
 * admin-2fa.js — Doble autenticación del panel de administración (16-10-2026).
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────
 *
 * Hasta hoy el panel se abría con UNA contraseña (ADMIN_TOKEN) que el navegador guardaba en
 * localStorage para siempre: quien se sentara en el PC de Francisco entraba sin teclear nada, y
 * con ella se ven licencias, clínicas y teléfonos de pacientes en las reservas.
 *
 * Ahora la contraseña sola NO abre el panel: hace falta además el código de 6 cifras de Google
 * Authenticator (TOTP, RFC 6238 — el mismo que usa cualquier app de autenticación). Los dos juntos
 * dan una SESIÓN de 12 horas, y es la sesión lo que el navegador guarda, no la contraseña.
 *
 * ── Las tres llaves ──────────────────────────────────────────────────────────
 *
 *   · Sesión (contraseña + código)  → todo.
 *   · ADMIN_TOKEN_LECTURA            → solo MIRAR (GET). Para diagnosticar desde scripts sin
 *                                      tener el móvil delante. Nunca cambia nada.
 *   · ADMIN_TOKEN a secas            → solo mientras la doble autenticación NO está activada
 *                                      (el paso intermedio, y las pruebas). Activada, ya no vale
 *                                      sola: un 401 que dice que falta el código.
 *
 * ── Si se pierde el móvil ────────────────────────────────────────────────────
 *
 * En Railway, variable ADMIN_2FA_REINICIAR=si y reiniciar el servicio: al arrancar se borra el
 * secreto y el panel vuelve a pedir el QR la próxima vez. Railway tiene su propio inicio de
 * sesión, así que esa puerta no la abre nadie que no pueda ya tocar el servidor. Después,
 * QUITAR la variable, o cada reinicio volvería a borrarlo.
 *
 * Sin dependencias: HMAC-SHA1 y base32 son veinte líneas, y una librería más es una cosa más que
 * vigilar en el servidor que guarda las licencias.
 */
const crypto = require('crypto');

const PASO = 30;                    // segundos por código
const VENTANA = 1;                  // se acepta el código anterior y el siguiente (relojes desfasados)
const SESION_HORAS = 12;
const EMISOR = 'PodoSystem Admin';

// ── base32 (RFC 4648, sin relleno) ──────────────────────────────────────────
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function aBase32(buf) {
  let bits = 0, valor = 0, sal = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { sal += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) sal += ALFABETO[(valor << (5 - bits)) & 31];
  return sal;
}
function deBase32(txt) {
  const limpio = String(txt || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valor = 0; const sal = [];
  for (const c of limpio) {
    valor = (valor << 5) | ALFABETO.indexOf(c); bits += 5;
    if (bits >= 8) { sal.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(sal);
}

// ── TOTP ────────────────────────────────────────────────────────────────────
function codigoEn(secreto, contador) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', deBase32(secreto)).update(c).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const contadorDe = (ms) => Math.floor(ms / 1000 / PASO);

/** El contador del código si es bueno, o null. Comparación en tiempo constante. */
function comprobarCodigo(secreto, codigo, ahora = Date.now()) {
  const cod = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cod) || !secreto) return null;
  const base = contadorDe(ahora);
  for (let d = -VENTANA; d <= VENTANA; d++) {
    const esperado = codigoEn(secreto, base + d);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(cod))) return base + d;
  }
  return null;
}

const nuevoSecreto = () => aBase32(crypto.randomBytes(20));
const urlOtpauth = (secreto) =>
  `otpauth://totp/${encodeURIComponent(EMISOR)}:${encodeURIComponent('panel')}` +
  `?secret=${secreto}&issuer=${encodeURIComponent(EMISOR)}&algorithm=SHA1&digits=6&period=${PASO}`;

// ── Estado en la base ───────────────────────────────────────────────────────
function estado(db) {
  return db.prepare('SELECT * FROM admin_2fa WHERE id = 1').get() || null;
}
const activado = (db) => !!(estado(db) || {}).secreto;
const hayPendiente = (db) => !!(estado(db) || {}).pendiente;

/** Prepara un secreto PENDIENTE (aún no vale para entrar) y lo devuelve para el QR. */
function iniciarAlta(db) {
  const s = nuevoSecreto();
  db.prepare(`INSERT INTO admin_2fa (id, pendiente) VALUES (1, ?)
              ON CONFLICT(id) DO UPDATE SET pendiente = excluded.pendiente`).run(s);
  return { secreto: s, otpauth: urlOtpauth(s) };
}

/** Si el código cuadra con el pendiente, este pasa a ser EL secreto. */
function confirmarAlta(db, codigo, ahora = Date.now()) {
  const e = estado(db);
  if (!e || !e.pendiente) return false;
  const cont = comprobarCodigo(e.pendiente, codigo, ahora);
  if (cont === null) return false;
  db.prepare(`UPDATE admin_2fa SET secreto = pendiente, pendiente = NULL, activado_en = ?, ultimo_contador = ?
              WHERE id = 1`).run(new Date(ahora).toISOString(), cont);
  return true;
}

/** Comprueba el código del secreto activo. Un código ya usado no vale dos veces. */
function verificar(db, codigo, ahora = Date.now()) {
  const e = estado(db);
  if (!e || !e.secreto) return false;
  const cont = comprobarCodigo(e.secreto, codigo, ahora);
  if (cont === null || cont <= (e.ultimo_contador || 0)) return false;
  db.prepare('UPDATE admin_2fa SET ultimo_contador = ? WHERE id = 1').run(cont);
  return true;
}

function reiniciar(db) {
  db.prepare('DELETE FROM admin_2fa').run();
  db.prepare('DELETE FROM admin_sesiones').run();
}

// ── Sesiones ────────────────────────────────────────────────────────────────
// Se guarda la huella SHA-256 del token, nunca el token: con una copia de la base no se entra.
const huella = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function abrirSesion(db, ip, ahora = Date.now()) {
  const token = 'ses_' + crypto.randomBytes(32).toString('hex');
  const expira = new Date(ahora + SESION_HORAS * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM admin_sesiones WHERE expira < ?').run(new Date(ahora).toISOString());
  db.prepare('INSERT INTO admin_sesiones (huella, creada, expira, ip) VALUES (?, ?, ?, ?)')
    .run(huella(token), new Date(ahora).toISOString(), expira, String(ip || '').slice(0, 64));
  return { token, expira };
}

function sesionValida(db, token, ahora = Date.now()) {
  if (!/^ses_[0-9a-f]{64}$/.test(String(token || ''))) return false;
  const f = db.prepare('SELECT expira FROM admin_sesiones WHERE huella = ?').get(huella(token));
  return !!f && f.expira > new Date(ahora).toISOString();
}

function cerrarSesion(db, token) {
  db.prepare('DELETE FROM admin_sesiones WHERE huella = ?').run(huella(token));
}

module.exports = {
  PASO, SESION_HORAS, aBase32, deBase32, codigoEn, comprobarCodigo, contadorDe,
  activado, hayPendiente, iniciarAlta, confirmarAlta, verificar, reiniciar, abrirSesion, sesionValida, cerrarSesion,
};
