'use strict';
/**
 * salud_licencias.js — qué clientes están en apuros, sin tener que ir a buscarlo.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────
 *
 * El 29-08-2026, mirando la tabla de licencias por otra cosa, aparecieron dos clientes en
 * situaciones que nadie había avisado:
 *
 *   · uno llevaba **47 días sin validar** (resultó ser que estaba de vacaciones, pero podría
 *     haber sido su programa bloqueado sin que lo dijera);
 *   · otro tenía la licencia emitida y **nunca la había activado** — se le vendió algo que no
 *     llegó a usar nunca.
 *
 * Con dos clientes eso se ve de un vistazo. Con veinte, no. Y el patrón de todo este proyecto
 * es el mismo: **un problema que no avisa cuesta horas; uno que deja rastro se ve en diez
 * segundos**. Esto es lo mismo aplicado a los clientes en vez de al código.
 *
 * ── Los plazos, y por qué son estos ──────────────────────────────────────────
 *
 * ⚠️ Tienen que coincidir con `licencia.js` del PC:
 *
 *     VALIDATION_INTERVAL_DAYS = 7   — cada cuánto revalida
 *     GRACE_PERIOD_DAYS        = 7   — cuánto aguanta sin poder preguntar
 *
 * Pasados los 14, el programa entra en solo lectura. Si allí se cambian y aquí no, el panel
 * dirá que un cliente está bien cuando lleva días bloqueado, que es peor que no decir nada.
 */

const INTERVALO_DIAS = 7;
const GRACIA_DIAS    = 7;
const LIMITE_DIAS    = INTERVALO_DIAS + GRACIA_DIAS;   // 14

const dias = (desde, ahora) => {
  const t = new Date(desde).getTime();
  if (!t || isNaN(t)) return null;
  return Math.floor((ahora - t) / 86400000);
};

/**
 * Estado de una licencia, pensado para pintarlo.
 *
 * @returns {{estado: string, nivel: 'ok'|'aviso'|'alerta', mensaje: string, diasSinValidar: number|null}}
 *
 * `nivel` es lo que decide el color; `estado` es para poder filtrar; `mensaje` es lo que se
 * le enseña a una persona y por eso dice qué pasa, no qué campo está vacío.
 */
function saludLicencia(lic, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const ultimaVersion = opciones.ultimaVersion || null;

  if (lic.estado === 'blocked') {
    return { estado: 'bloqueada', nivel: 'alerta', mensaje: 'Bloqueada desde el panel', diasSinValidar: null };
  }

  // Emitida y nunca usada. No es un fallo del cliente ni nuestro, pero es una venta a medias
  // que conviene ver: alguien tiene una clave que no ha llegado a estrenar.
  if (!lic.activadaEn && !lic.ultimaValidacion) {
    const desdeCreacion = dias(lic.createdAt, ahora);
    return {
      estado: 'sin_activar',
      nivel: desdeCreacion !== null && desdeCreacion > 14 ? 'alerta' : 'aviso',
      mensaje: desdeCreacion !== null
        ? `Nunca activada — emitida hace ${desdeCreacion} días`
        : 'Nunca activada',
      diasSinValidar: null,
    };
  }

  const d = dias(lic.ultimaValidacion || lic.activadaEn, ahora);
  if (d === null) {
    return { estado: 'sin_datos', nivel: 'aviso', mensaje: 'Sin fecha de validación', diasSinValidar: null };
  }

  if (d > LIMITE_DIAS) {
    return {
      estado: 'caducada',
      nivel: 'alerta',
      // Se dice lo que le pasa AL CLIENTE, no lo que dice la base de datos.
      mensaje: `${d} días sin validar — su programa está en solo lectura`,
      diasSinValidar: d,
    };
  }
  if (d > INTERVALO_DIAS) {
    return {
      estado: 'en_gracia',
      nivel: 'aviso',
      mensaje: `${d} días sin validar — le quedan ${LIMITE_DIAS - d} antes de bloquearse`,
      diasSinValidar: d,
    };
  }

  // Al día. Solo queda mirar si se ha quedado atrás de versión: no es urgente, pero es lo que
  // explica que un cliente no tenga un arreglo que ya se publicó.
  if (ultimaVersion && lic.version_instalada && lic.version_instalada !== ultimaVersion) {
    return {
      estado: 'version_vieja',
      nivel: 'aviso',
      mensaje: `Usa la ${lic.version_instalada}, hay ${ultimaVersion}`,
      diasSinValidar: d,
    };
  }
  if (ultimaVersion && !lic.version_instalada) {
    // Valida, pero con una versión anterior a la que empezó a decir cuál corre (27-08-2026).
    return {
      estado: 'version_desconocida',
      nivel: 'aviso',
      mensaje: 'No dice qué versión usa: anterior a la 3.5.1',
      diasSinValidar: d,
    };
  }

  return { estado: 'al_dia', nivel: 'ok', mensaje: `Validada hace ${d} día${d === 1 ? '' : 's'}`, diasSinValidar: d };
}

/** Cuántas hay en cada nivel, para poder enseñar un contador arriba. */
function resumen(licencias = [], opciones = {}) {
  const r = { total: licencias.length, alerta: 0, aviso: 0, ok: 0 };
  for (const l of licencias) r[saludLicencia(l, opciones).nivel]++;
  return r;
}

module.exports = { saludLicencia, resumen, INTERVALO_DIAS, GRACIA_DIAS, LIMITE_DIAS };
