/**
 * lib/limpieza-clinicas.js — Lo que pasa con una clínica cuando se acaba su servicio (28-09-2026)
 *
 * Dos cosas que las Condiciones Generales van a prometer y que HOY no hacía nadie:
 *
 *  1. **La página de citas de una PRUEBA caducada deja de admitir reservas.** Solo el webhook de
 *     Stripe ponía `clinicas.activa = 0`, y una prueba no tiene Stripe: su página seguía abierta
 *     indefinidamente. Una clínica que enseñó el QR a sus pacientes y no contrató habría recibido
 *     reservas que ya no podía ver — su PC está en el muro.
 *     Es REVERSIBLE: se marca `desactivadaPor = 'fin_prueba'` y, si desde el panel se le dan más
 *     días a esa prueba, se reabre sola. Nunca se reabre lo que cerró otro (Stripe, el admin).
 *
 *  2. **Mes de cortesía y borrado.** 30 días después del fin del servicio —la prueba, o la
 *     licencia caducada— se borran los datos de esa clínica en el relay. Si vuelve antes,
 *     recupera su misma licencia y su misma página. Decidido por Francisco el 28-09-2026.
 *
 * ── Decisiones, y por qué ────────────────────────────────────────────────────
 *
 * - **El reloj de una licencia lo pone ESTA tarea**, no los cuatro sitios que caducan licencias
 *   (dos webhooks y dos handlers de Stripe/LemonSqueezy). La primera vez que ve una licencia en
 *   `expired` apunta `expiradaEn`; si vuelve a estar viva, lo borra. Empieza a contar como mucho
 *   una pasada tarde, que va A FAVOR del cliente, y no toca código que funciona.
 *
 * - **El borrado arranca en ENSAYO.** Solo se borra de verdad con `LIMPIEZA_MODO=aplicar` en
 *   Railway. Hasta entonces la tarea dice qué borraría (log + `/admin/api/limpieza`). Borrar es lo
 *   único irreversible de este fichero, y la primera vez se mira el informe antes.
 *
 * - **Una clínica con una licencia VIVA no se toca nunca**, venga de donde venga (una prueba que
 *   compró y se quedó con su página, una licencia puesta a mano…).
 *
 * - **Se borra lo de la clínica y se DESVINCULA lo que solo apunta a ella**: `licencias`, `trials` y
 *   `solicitudes_alta` son historial nuestro (quién tuvo licencia, quién probó), no datos de sus
 *   pacientes. Se quedan con `clinicaId = NULL`.
 *
 * - **Las copias en la nube (Backblaze) se borran a los 90 días** del fin del servicio (Anexo C), no
 *   el día 30: el día 30 se revoca su clave y se APUNTA su carpeta en `copias_por_borrar`; el
 *   borrado lo hace `borrar-copias-clinica.js` cuando vence el plazo (06-10-2026). El sitio de
 *   Netlify de una clínica de pago no se borra: se avisa en el informe.
 */
'use strict';

const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_CORTESIA = 30;
const DIAS_COPIAS = 90;
const DIAS_DATOS_PRUEBA = 365;   // quien pidió la prueba y no contrató (decidido el 07-10-2026)   // las copias en la nube, desde el fin del servicio (Anexo C)
// La duración de la prueba: la misma que `TRIAL_DIAS` en routes/trials.js (lo fija la prueba).
const DIAS_PRUEBA = 60;
const RESERVA_DIAS_TRAS_CITA = 7;   // una reserva vive hasta su cita + 7 días (ver el paso 3)
const INTERVALO_MS = 6 * 60 * 60 * 1000;   // cuatro veces al día: fechas de días, no de minutos

// Estados de licencia que ya NO dan servicio. Todo lo demás cuenta como viva.
const MUERTAS = new Set(['expired', 'revoked', 'revocada', 'cancelada', 'cancelled']);

// Tablas que solo APUNTAN a la clínica: se desvinculan, no se borran.
const SOLO_APUNTAN = new Set(['licencias', 'trials', 'solicitudes_alta']);

function asegurarColumnas(db) {
  try { db.exec('ALTER TABLE clinicas ADD COLUMN desactivadaPor TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE licencias ADD COLUMN expiradaEn TEXT'); } catch (_) {}
}

/** Las tablas con columna `clinicaId`, leídas del esquema: una lista a mano se desincroniza. */
function tablasDeClinica(db) {
  const nombres = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  return nombres.filter(n => n !== 'clinicas' &&
    db.prepare(`PRAGMA table_info(${n})`).all().some(c => c.name === 'clinicaId'));
}

function tieneLicenciaViva(db, clinicaId) {
  const filas = db.prepare('SELECT estado FROM licencias WHERE clinicaId = ?').all(clinicaId);
  return filas.some(f => !MUERTAS.has(String(f.estado || '').toLowerCase()));
}

/** Fin de la prueba de una clínica de prueba: el más tardío de sus equipos (null si no se sabe). */
function finDePrueba(db, clinicaId) {
  const r = db.prepare(`
    SELECT MAX(ti.fin) AS fin
      FROM trials t JOIN trial_instalaciones ti ON ti.trialId = t.id
     WHERE t.clinicaId = ?`).get(clinicaId);
  if (r && r.fin) return r.fin;
  // Sin enlace con su prueba (01-10-2026: `pbdaJ0ekdf`, que ningún trial apunta). Antes salía
  // «sin fecha» y se saltaba PARA SIEMPRE: ni se cerraba ni se borraba, contra lo que promete el
  // Anexo C. Una web de prueba no puede vivir más que la prueba, así que su alta más la duración
  // de la prueba es un fin seguro. Si se le dieron más días desde el panel, cerrar la página es
  // reversible (se reabre sola en la siguiente pasada en cuanto la prueba enlazada lo diga).
  const c = db.prepare('SELECT createdAt FROM clinicas WHERE id = ?').get(clinicaId);
  const alta = c && Date.parse(c.createdAt);
  return Number.isFinite(alta) ? new Date(alta + DIAS_PRUEBA * DIA_MS).toISOString() : null;
}

/**
 * Una pasada. Devuelve el informe; no lanza (un fallo en una clínica no para a las demás).
 * `modo`: 'aplicar' borra de verdad; cualquier otra cosa es ensayo (el cierre de las páginas de
 * prueba, que es reversible, se aplica siempre).
 */
function revisarClinicas(db, { ahora = new Date(), modo = process.env.LIMPIEZA_MODO } = {}) {
  asegurarColumnas(db);
  const aplicar = modo === 'aplicar';
  const t = ahora.getTime();
  const iso = ahora.toISOString();
  const informe = {
    fecha: iso, modo: aplicar ? 'aplicar' : 'ensayo',
    pruebasCerradas: [], pruebasReabiertas: [], relojIniciado: [], relojAnulado: [],
    aBorrar: [], borradas: [], sinFecha: [], errores: [],
    // Las claves de Backblaze de las clínicas borradas: se revocan DESPUÉS, fuera de la
    // transacción (es una llamada de red). Se apunta el keyId antes de borrar su fila.
    clavesARevocar: [],
  };

  // ── 0. El reloj de las licencias ─────────────────────────────────────────
  for (const l of db.prepare('SELECT id, estado, expiradaEn FROM licencias').all()) {
    const muerta = MUERTAS.has(String(l.estado || '').toLowerCase());
    if (muerta && !l.expiradaEn) {
      db.prepare('UPDATE licencias SET expiradaEn = ? WHERE id = ?').run(iso, l.id);
      informe.relojIniciado.push(l.id);
    } else if (!muerta && l.expiradaEn) {
      db.prepare('UPDATE licencias SET expiradaEn = NULL WHERE id = ?').run(l.id);
      informe.relojAnulado.push(l.id);
    }
  }

  const tablas = tablasDeClinica(db);

  for (const c of db.prepare('SELECT id, nombre, fuente, activa, desactivadaPor, netlifyId FROM clinicas').all()) {
    try {
      if (tieneLicenciaViva(db, c.id)) continue;

      // ¿Cuándo acabó su servicio? Si la clínica tuvo ALGUNA licencia, manda la licencia aunque
      // naciera como prueba: una prueba que compró y luego canceló cuenta desde que caducó la
      // licencia, no desde el fin de la prueba (que pudo ser meses antes).
      const esPrueba = c.fuente === 'trial' &&
        db.prepare('SELECT COUNT(*) AS n FROM licencias WHERE clinicaId = ?').get(c.id).n === 0;
      let fin = null, motivo = null;
      if (esPrueba) {
        fin = finDePrueba(db, c.id);
        motivo = 'fin de la prueba';
        if (!fin) { informe.sinFecha.push(c.id); continue; }
      } else {
        const r = db.prepare("SELECT MAX(expiradaEn) AS fin FROM licencias WHERE clinicaId = ? AND expiradaEn IS NOT NULL").get(c.id);
        fin = r && r.fin;
        motivo = 'licencia caducada';
        if (!fin) continue;   // sin licencia caducada que la respalde: no es asunto de esta tarea
      }
      const tFin = new Date(fin).getTime();

      // ── 1. Prueba caducada: la página deja de admitir reservas (reversible) ──
      if (esPrueba) {
        if (tFin <= t && c.activa === 1) {
          db.prepare("UPDATE clinicas SET activa = 0, desactivadaPor = 'fin_prueba' WHERE id = ?").run(c.id);
          informe.pruebasCerradas.push(c.id);
          continue;
        }
        if (tFin > t && c.activa === 0 && c.desactivadaPor === 'fin_prueba') {
          // Se le dieron más días desde el panel: se reabre lo que cerró ESTA tarea, y nada más.
          db.prepare('UPDATE clinicas SET activa = 1, desactivadaPor = NULL WHERE id = ?').run(c.id);
          informe.pruebasReabiertas.push(c.id);
          continue;
        }
      }

      // ── 2. Pasado el mes de cortesía: borrado ───────────────────────────
      if (t - tFin < DIAS_CORTESIA * DIA_MS) continue;

      const detalle = { clinicaId: c.id, nombre: c.nombre, motivo, finServicio: fin,
                        copiaNube: `${c.id}/`, netlify: c.netlifyId || null, filas: {} };
      for (const tabla of tablas) {
        if (SOLO_APUNTAN.has(tabla)) continue;
        detalle.filas[tabla] = db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE clinicaId = ?`).get(c.id).n;
      }

      if (!aplicar) { informe.aBorrar.push(detalle); continue; }

      let claveB2 = null;
      try { claveB2 = db.prepare('SELECT keyId FROM claves_copia WHERE clinicaId = ?').get(c.id); } catch (_) {}

      const copias = require('./borrar-copias-clinica');
      copias.asegurarTabla(db);
      db.transaction(() => {
        // Antes de borrar nada: apuntar su carpeta de copias, para borrarla el día 90.
        db.prepare(`INSERT OR REPLACE INTO copias_por_borrar (idClinica, prefijo, finServicio, borrarDesde, apuntadaEn)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(c.id, `${c.id}/`, fin, new Date(tFin + DIAS_COPIAS * DIA_MS).toISOString(), iso);
        for (const tabla of tablas) {
          if (SOLO_APUNTAN.has(tabla)) db.prepare(`UPDATE ${tabla} SET clinicaId = NULL WHERE clinicaId = ?`).run(c.id);
          else db.prepare(`DELETE FROM ${tabla} WHERE clinicaId = ?`).run(c.id);
        }
        db.prepare('DELETE FROM clinicas WHERE id = ?').run(c.id);
      })();
      informe.borradas.push(detalle);
      if (claveB2 && claveB2.keyId) informe.clavesARevocar.push({ clinicaId: c.id, keyId: claveB2.keyId });
    } catch (e) {
      informe.errores.push({ clinicaId: c.id, error: e.message });
    }
  }

  // ── 3. Reservas de citas ya pasadas: fecha de la cita + 7 días (30-09-2026) ──
  //
  // Decidido con Francisco. Una reserva hace falta hasta el día de la cita —el enlace de anulación
  // del paciente la busca aquí— y una semana más: el PC se entera de las anulaciones pidiendo las
  // de los últimos 7 días, para ponerse al día si estuvo apagado. Después no la usa nada: la cita
  // ya está en la agenda del PC. Vale también para las que nunca llegaron a un PC.
  // Con el mismo modo que el resto: en ENSAYO solo se cuentan.
  try {
    const limite = new Date(t - RESERVA_DIAS_TRAS_CITA * DIA_MS).toISOString().slice(0, 10);
    const donde = "fecha < ? AND fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
    const n = db.prepare(`SELECT COUNT(*) AS n FROM reservas WHERE ${donde}`).get(limite).n;
    informe.reservasCaducadas = { limite, cuantas: n, borradas: 0 };
    if (aplicar && n) {
      informe.reservasCaducadas.borradas = db.prepare(`DELETE FROM reservas WHERE ${donde}`).run(limite).changes;
    }
  } catch (e) {
    informe.errores.push({ reservas: e.message });
  }

  // ── 3b. Lo que pasó por el servidor de camino al PC (07-10-2026) ────────────
  //
  // · `citas_remote_ops`: cambios de citas hechos desde el móvil fuera de la clínica (pueden
  //   llevar notas). Una vez que el PC los ha recogido (`syncedAt`) no los necesita nadie: fuera
  //   a los 7 días, como las reservas.
  // · `solicitudes`: el formulario antiguo, ya retirado; tenía la IP del paciente. 30 días.
  // · Datos de quien pidió la prueba y no contrató: 12 meses desde su última descarga (decidido
  //   por Francisco). Se borra la fila de `trials` y sus aceptaciones de prueba; de los equipos
  //   (`trial_instalaciones`) se borra la IP, y se conserva la huella y la fecha de fin, que es
  //   lo que impide repetir la prueba en el mismo equipo.
  // Con el mismo modo que el resto: en ENSAYO solo se cuentan.
  try {
    const hace7 = new Date(t - 7 * DIA_MS).toISOString();
    const hace30 = new Date(t - 30 * DIA_MS).toISOString();
    const hace12m = new Date(t - DIAS_DATOS_PRUEBA * DIA_MS).toISOString();
    const cuenta = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch (_) { return 0; } };
    const corre = (sql, ...a) => { try { return db.prepare(sql).run(...a).changes; } catch (_) { return 0; } };
    const noCliente = "LOWER(email) NOT IN (SELECT LOWER(clienteEmail) FROM licencias WHERE clienteEmail IS NOT NULL)";
    informe.purgas = {
      citasRemotasSincronizadas: cuenta('SELECT COUNT(*) AS n FROM citas_remote_ops WHERE syncedAt IS NOT NULL AND syncedAt < ?', hace7),
      solicitudesAntiguas: cuenta('SELECT COUNT(*) AS n FROM solicitudes WHERE creadaEn < ?', hace30),
      pruebasSinContratar: cuenta(`SELECT COUNT(*) AS n FROM trials WHERE COALESCE(ultima_descarga, acepta_privacidad_en, creadaEn) < ? AND ${noCliente}`, hace12m),
      ipsDeEquipos: cuenta('SELECT COUNT(*) AS n FROM trial_instalaciones WHERE ip IS NOT NULL AND COALESCE(ultimaVista, primeraVista) < ?', hace12m),
      borradas: false,
    };
    if (aplicar) {
      corre('DELETE FROM citas_remote_ops WHERE syncedAt IS NOT NULL AND syncedAt < ?', hace7);
      corre('DELETE FROM solicitudes WHERE creadaEn < ?', hace30);
      corre(`DELETE FROM aceptaciones_legales WHERE para = 'prueba' AND fecha < ? AND ${noCliente}`, hace12m);
      corre(`DELETE FROM trials WHERE COALESCE(ultima_descarga, acepta_privacidad_en, creadaEn) < ? AND ${noCliente}`, hace12m);
      corre('UPDATE trial_instalaciones SET ip = NULL WHERE ip IS NOT NULL AND COALESCE(ultimaVista, primeraVista) < ?', hace12m);
      informe.purgas.borradas = true;
    }
  } catch (e) {
    informe.errores.push({ purgas: e.message });
  }

  // ── 4. El registro de accesos al panel, 90 días ─────────────────────────
  // Es NUESTRO registro, no datos de pacientes: se purga siempre, no depende del modo.
  try {
    const hace90 = new Date(t - 90 * DIA_MS).toISOString();
    informe.accesosAdminPurgados = db.prepare('DELETE FROM admin_accesos WHERE fecha < ?').run(hace90).changes;
  } catch (_) { /* tabla aún sin crear en una base vieja: nada que purgar */ }

  return informe;
}

let ultimoInforme = null;
function ultimo() { return ultimoInforme; }

function resumen(inf) {
  return `[limpieza] ${inf.modo}: ${inf.pruebasCerradas.length} prueba(s) cerrada(s), ` +
    `${inf.pruebasReabiertas.length} reabierta(s), ${inf.aBorrar.length} por borrar, ` +
    `${inf.borradas.length} borrada(s), reservas pasadas ${(inf.reservasCaducadas||{}).cuantas||0} (${(inf.reservasCaducadas||{}).borradas||0} borradas), ${inf.errores.length} error(es)`;
}

function iniciarLimpieza(db) {
  const pasada = () => {
    try {
      ultimoInforme = revisarClinicas(db);
      console.log(resumen(ultimoInforme));
      const inf = ultimoInforme;
      for (const k of inf.clavesARevocar) {
        require('./claves-copia').revocarPorKeyId(k.keyId).then(r => {
          console.log(`[limpieza] clave de copias de ${k.clinicaId}: ${r.revocada ? 'revocada en Backblaze' : 'NO revocada — ' + r.motivo}`);
        });
      }
      for (const d of ultimoInforme.aBorrar) {
        console.log(`[limpieza] ENSAYO — borraría ${d.clinicaId} (${d.motivo}, fin ${d.finServicio}): ${JSON.stringify(d.filas)}`);
      }
      for (const d of [...ultimoInforme.aBorrar, ...ultimoInforme.borradas]) {
        console.log(`[limpieza] ${d.clinicaId}: sus copias en la nube (${d.copiaNube}) se borrarán a los ${DIAS_COPIAS} días del fin del servicio` +
          (d.netlify ? `; su sitio de Netlify (${d.netlify}) hay que retirarlo a mano` : ''));
      }
      // Las copias que ya han cumplido sus 90 días. Asíncrono: no bloquea la pasada.
      require('./borrar-copias-clinica').procesarPendientes(db).then(c => {
        inf.copias = c;
        if (c.vencidas.length || c.errores.length) {
          console.log(`[limpieza] copias en la nube (${c.modo}): ${c.vencidas.length} vencida(s), ` +
            `${c.borradas.length} borrada(s), ${c.errores.length} error(es) ${JSON.stringify(c.errores)}`);
        }
      }).catch(e => console.error('[limpieza] copias en la nube:', e.message));
    } catch (e) {
      console.error('[limpieza] la pasada falló:', e.message);
    }
  };
  // Un minuto después de arrancar: que el relay atienda primero lo urgente.
  // unref(): no impiden que el proceso termine (pruebas, reinicios).
  setTimeout(pasada, 60 * 1000).unref();
  setInterval(pasada, INTERVALO_MS).unref();
}

module.exports = { revisarClinicas, iniciarLimpieza, ultimo, DIAS_CORTESIA, DIAS_COPIAS, DIAS_PRUEBA, RESERVA_DIAS_TRAS_CITA };
