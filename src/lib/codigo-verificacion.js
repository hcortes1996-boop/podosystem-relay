/**
 * codigo-verificacion.js — El código de seis dígitos que se manda por correo.
 *
 * ── Por qué existe este módulo ───────────────────────────────────────────────
 *
 * Esta mecánica estaba escrita **dentro de `routes/recuperacion.js`**, donde nació para mover una
 * licencia a otro ordenador. El bloque 2 del trial (`docs/estudio_citas_web_en_el_trial.md`)
 * necesita exactamente la misma: seis dígitos, quince minutos, cinco intentos y un solo uso.
 *
 * Se extrae en vez de copiarse, y no por elegancia. Este repositorio ya tiene escrito lo que pasa
 * al copiar: `construirVars` estuvo duplicada palabra por palabra en dos funciones y **las dos
 * copias se separaron sin que nadie lo viera**. Aquí el precio sería peor, porque lo duplicado
 * sería la parte que decide si un código vale o no.
 *
 * ⚠️ `hashCodigo` se reproduce **carácter por carácter** respecto a la versión original. Cambiar
 * el algoritmo —aunque fuera a mejor— invalidaría de golpe los códigos que estuvieran en vuelo en
 * ese momento, y quien estuviera moviendo su licencia se quedaría tirado sin entender por qué.
 *
 * ── Las decisiones que vienen de origen, y por qué se mantienen ──────────────
 *
 *   · **`crypto.randomInt`, nunca `Math.random`.** Es una credencial, aunque dure quince minutos.
 *   · **Se guarda hasheado**, para que una fuga de solo lectura de la base no entregue códigos
 *     que todavía sirven.
 *   · **El hash lleva el `id` de la fila como sal.** Dos filas con el mismo código dan hashes
 *     distintos, así que no se pueden cruzar ni reconocer por repetición.
 *   · **Cinco intentos y quince minutos.** Bastante para quien teclea mal, poco para quien prueba.
 */
'use strict';

const crypto = require('crypto');

/** Quince minutos. Suficiente para ir al correo, insuficiente para dejarlo ahí. */
const VIDA_CODIGO_MS = 15 * 60 * 1000;

/** Cinco intentos por código. Al sexto hay que pedir uno nuevo. */
const MAX_INTENTOS = 5;

/**
 * Seis dígitos con generador criptográfico, ceros a la izquierda incluidos.
 * `padStart` no es cosmético: sin él, uno de cada diez códigos tendría cinco cifras.
 */
function generarCodigo() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * El hash que se guarda. El `id` de la fila actúa de sal.
 * ⚠️ NO tocar la fórmula: ver el aviso de la cabecera.
 */
function hashCodigo(id, codigo) {
  return crypto.createHash('sha256').update(id + ':' + codigo).digest('hex');
}

/** francisco@ejemplo.com → f···o@ejemplo.com. Confirma a dónde fue sin revelarlo. */
function pistaEmail(email) {
  const partes = String(email).split('@');
  if (partes.length !== 2) return '···';
  const u = partes[0];
  const visible = u.length <= 2 ? u[0] : u[0] + '···' + u[u.length - 1];
  return visible + '@' + partes[1];
}

/**
 * ¿Vale este código para esta fila? Devuelve el motivo exacto, no un booleano.
 *
 * Se centraliza aquí porque el orden de las comprobaciones importa y es fácil equivocarse al
 * repetirlo: **caducado y gastado se miran ANTES que el hash**, para no gastar un intento de los
 * cinco en un código que ya no valía de todas formas.
 *
 * Devuelve `{ ok: true }` o `{ ok: false, motivo, estado }`, con el `estado` HTTP que corresponde:
 * 410 si ya no existe o caducó, 429 si se agotaron los intentos, 401 si no coincide.
 */
function comprobarCodigo(fila, codigo, ahora = new Date()) {
  if (!fila) {
    return { ok: false, estado: 410, motivo: 'No hay ningún código pendiente. Pide uno nuevo.' };
  }
  if (fila.usadoEn) {
    return { ok: false, estado: 410, motivo: 'Ese código ya se usó. Pide uno nuevo.' };
  }
  if (new Date(fila.expiraEn) < ahora) {
    return { ok: false, estado: 410, motivo: 'El código ha caducado. Pide uno nuevo.' };
  }
  if (fila.intentos >= MAX_INTENTOS) {
    return { ok: false, estado: 429, motivo: 'Demasiados intentos con este código. Pide uno nuevo.' };
  }
  if (hashCodigo(fila.id, String(codigo)) !== fila.codigoHash) {
    return {
      ok: false,
      estado: 401,
      motivo: 'Código incorrecto',
      intentosRestantes: Math.max(0, MAX_INTENTOS - (fila.intentos + 1)),
      fallo: true,   // el llamante debe sumar un intento
    };
  }
  return { ok: true };
}

module.exports = {
  VIDA_CODIGO_MS,
  MAX_INTENTOS,
  generarCodigo,
  hashCodigo,
  pistaEmail,
  comprobarCodigo,
};
