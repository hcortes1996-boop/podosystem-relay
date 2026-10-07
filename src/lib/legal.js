'use strict';
/**
 * lib/legal.js — Qué condiciones aceptó cada cliente, y cuándo (07-10-2026).
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * La Ley de Condiciones Generales de la Contratación exige que el cliente pueda conocer las
 * condiciones ANTES de contratar y conservarlas; la LSSI, que se pongan a su disposición de forma
 * que pueda almacenarlas y reproducirlas, y que se confirme la contratación. Hasta hoy la página de
 * compra no tenía ninguna casilla, y el servidor no guardaba nada: si un cliente discutía una
 * cláusula, no había forma de probar que la había visto.
 *
 * ── Cómo ─────────────────────────────────────────────────────────────────────
 *
 *   · `legal-vigentes.json` dice qué documentos hay que aceptar, en qué versión, y la huella
 *     (SHA-256) de su copia fija en PDF. La web los pinta desde `GET /api/legal/vigentes`.
 *   · Al pagar (y al descargar la prueba) la web manda qué versiones aceptó. **Lo comprueba el
 *     servidor**, no solo la página: sin todas las del momento, o con una vieja, no se sigue.
 *   · Cada aceptación se guarda en `aceptaciones_legales`: correo, fecha, IP, navegador, y las
 *     versiones con su huella. Se enlaza después con la licencia (por la sesión de Stripe) o con
 *     la prueba (por su id).
 *
 * ⚠️ Un PDF ya publicado NO se cambia nunca: es la prueba de lo que aceptó cada cliente. Una
 * versión nueva es un PDF nuevo, con otro nombre, y otra entrada en el JSON.
 */

const VIGENTES = require('../legal-vigentes.json');

function asegurarTabla(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aceptaciones_legales (
    id               TEXT PRIMARY KEY,
    para             TEXT NOT NULL,          -- 'compra' | 'prueba'
    email            TEXT,
    fecha            TEXT NOT NULL,          -- ISO, UTC
    ip               TEXT,
    userAgent        TEXT,
    documentos       TEXT NOT NULL,          -- JSON: [{ id, version, sha256, accion }]
    stripeSessionId  TEXT,
    licenciaId       TEXT,
    trialId          TEXT
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_acept_email ON aceptaciones_legales(email)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_acept_stripe ON aceptaciones_legales(stripeSessionId)'); } catch (_) {}
}

/** El texto exacto de la casilla: se pinta en la web y se GUARDA con la aceptación, como prueba de qué
 *  declaró el cliente (por ejemplo, que contrata como profesional). */
function textoCasilla({ titulo, articulo, version, accion, declaracion }) {
  return (accion === 'acepto' ? 'He leído y acepto ' : 'He leído ') + (articulo || 'el') + ' ' + titulo +
    ' (versión ' + version + ')' + (declaracion ? ', ' + declaracion : '');
}

/** Los documentos que hay que aceptar para `para` ('compra' | 'prueba'). */
function vigentes(para) {
  return VIGENTES.documentos.filter(d => d.para.includes(para))
    .map(({ id, titulo, articulo, version, accion, declaracion, ver, pdf, sha256 }) =>
      ({ id, titulo, articulo: articulo || 'el', version, accion, declaracion: declaracion || null, ver, pdf, sha256,
         casilla: textoCasilla({ titulo, articulo, version, accion, declaracion }) }));
}

/**
 * ¿Ha aceptado todo lo vigente? `aceptaciones`: [{ id, version }] tal como lo manda la web.
 * Devuelve `{ ok, error?, documentos? }`; `documentos` es lo que se guarda.
 */
function validar(para, aceptaciones) {
  const docs = vigentes(para);
  if (!Array.isArray(aceptaciones)) {
    return { ok: false, error: 'Hay que aceptar las condiciones antes de continuar.' };
  }
  const faltan = docs.filter(d => !aceptaciones.some(a => a && a.id === d.id && a.version === d.version));
  if (faltan.length) {
    const viejas = faltan.filter(d => aceptaciones.some(a => a && a.id === d.id));
    return { ok: false, error: viejas.length
      ? 'Las condiciones han cambiado desde que abriste la página. Recárgala y vuelve a aceptarlas.'
      : 'Falta aceptar: ' + faltan.map(d => d.titulo).join(', ') + '.' };
  }
  return { ok: true, documentos: docs.map(d => ({ id: d.id, version: d.version, sha256: d.sha256, accion: d.accion, casilla: d.casilla })) };
}

function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) || null;
}

/** Guarda una aceptación ya validada. Devuelve su id. */
function registrar(db, { para, email, req, documentos, stripeSessionId = null, trialId = null, ahora = new Date() }) {
  asegurarTabla(db);
  const id = 'acp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO aceptaciones_legales (id, para, email, fecha, ip, userAgent, documentos, stripeSessionId, trialId)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, para, email ? String(email).toLowerCase().slice(0, 160) : null, ahora.toISOString(),
         req ? ipDe(req) : null, req ? String(req.headers['user-agent'] || '').slice(0, 250) : null,
         JSON.stringify(documentos), stripeSessionId, trialId);
  return id;
}

/** Tras el pago: une la aceptación con la licencia creada y el correo que dio en Stripe. */
function enlazarLicencia(db, { aceptacionId, stripeSessionId, licenciaId, email }) {
  try {
    asegurarTabla(db);
    const r = aceptacionId
      ? db.prepare('UPDATE aceptaciones_legales SET licenciaId = ?, email = COALESCE(email, ?) WHERE id = ?').run(licenciaId, email || null, aceptacionId)
      : db.prepare('UPDATE aceptaciones_legales SET licenciaId = ?, email = COALESCE(email, ?) WHERE stripeSessionId = ?').run(licenciaId, email || null, stripeSessionId);
    return r.changes > 0;
  } catch (_) { return false; }
}

/** Para el correo de confirmación: los documentos de esa aceptación, con su PDF. */
function documentosDe(db, { aceptacionId, stripeSessionId }) {
  try {
    asegurarTabla(db);
    const fila = aceptacionId
      ? db.prepare('SELECT documentos FROM aceptaciones_legales WHERE id = ?').get(aceptacionId)
      : db.prepare('SELECT documentos FROM aceptaciones_legales WHERE stripeSessionId = ?').get(stripeSessionId);
    if (!fila) return [];
    return JSON.parse(fila.documentos).map(d => {
      const v = VIGENTES.documentos.find(x => x.id === d.id && x.version === d.version) || {};
      return { ...d, titulo: v.titulo || d.id, pdf: v.pdf || null };
    });
  } catch (_) { return []; }
}

/** El bloque del correo: qué ha aceptado, con enlace a la copia fija de cada documento. */
function htmlConfirmacion(docs) {
  if (!docs || !docs.length) return '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const filas = docs.map(d =>
    `<li>${esc(d.titulo)} — versión ${esc(d.version)} (${d.accion === 'acepto' ? 'aceptada' : 'leída'})` +
    (d.pdf ? ` · <a href="${esc(d.pdf)}" style="color:#2ecc9a">descargar PDF</a>` : '') + '</li>').join('');
  return `
    <div style="margin:0 0 24px;padding:18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#1E3A5F">Confirmación de la contratación · copia de las condiciones</p>
      <p style="margin:0 0 8px;font-size:.88rem;color:#334155;line-height:1.6">Te adjuntamos <strong>copia de las condiciones vigentes en el momento de la contratación</strong>, en PDF. Guárdalas: son las condiciones de tu contrato.</p>
      <ul style="margin:0;padding-left:20px;font-size:.88rem;color:#334155;line-height:1.8">${filas}</ul>
    </div>`;
}

/** Los PDF de esa aceptación, como adjuntos del correo (Resend los descarga de su URL fija). */
function adjuntosDe(docs) {
  return (docs || []).filter(d => d.pdf).map(d => ({ filename: d.pdf.split('/').pop(), path: d.pdf }));
}

module.exports = { adjuntosDe, vigentes, validar, registrar, enlazarLicencia, documentosDe, htmlConfirmacion, asegurarTabla, VIGENTES };
