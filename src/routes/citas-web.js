/**
 * citas-web.js — El relay sirve la web de citas de una clínica: `GET /cita/:clinicaId`
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * Decisión ② del 13-09-2026 (`docs/estudio_citas_web_en_el_trial.md`): **el relay sirve la web
 * de los trials, y Netlify queda solo para quien paga.**
 *
 * Crear un sitio de Netlify por cada persona que prueba el programa significa ancho de banda,
 * sitios que limpiar a los 60 días y acordarse de hacerlo. Y no hace falta: un trial **no manda
 * ese enlace a ningún paciente**, se lo manda a sí mismo para verlo funcionar desde el móvil.
 * Aquí la página está disponible al instante y borrarla es borrar una fila.
 *
 * Lo que NO cambia: los clientes de pago siguen teniendo su sitio de Netlify con su dominio.
 * Este camino es nuevo y no toca el que ya funciona.
 *
 * ── Tres decisiones de implementación, y por qué ─────────────────────────────
 *
 * 1. **Los assets se sirven en una ruta FIJA** (`/cita-assets/...`), no bajo `/cita/:id/`.
 *    `cita.html` referencia `css/styles.css` y `js/main.js` **en relativo**, así que servir el
 *    HTML en `/cita/:id` haría que el navegador pidiera `/css/styles.css` y la página saldría
 *    sin estilos. Se reescriben esas dos referencias al vuelo. Ventaja de la ruta fija: el
 *    navegador cachea los 38 KB de CSS+JS **una sola vez para todas las clínicas**, y no hay
 *    trampa de barra final (`/cita/x` vs `/cita/x/`), que es de los fallos más difíciles de ver.
 *
 *    ⚠️ La reescritura se hace AQUÍ, nunca tocando `web-template/cita.html`: ese fichero es el
 *    que se despliega en Netlify para los clientes de pago, y `test_plantilla_web.js` vigila
 *    expresamente que no se toque.
 *
 * 2. **La plantilla se lee UNA VEZ al arrancar.** El plan de pruebas del estudio lo pide con
 *    todas las letras: *«que servir páginas no ralentice la sincronización de agendas»*. Son
 *    90 KB; leerlos del disco en cada visita competiría con el trabajo real del relay. Mismo
 *    criterio que el panel de administración, que ya carga su HTML al arrancar.
 *
 *    No se cachea el resultado sustituido: `applyPlaceholders` sobre 90 KB es despreciable, y
 *    una caché por clínica traería el problema de invalidarla cuando cambie el nombre o el
 *    logo. Se prefiere siempre fresco a rápido-pero-viejo.
 *
 * 3. **`applyPlaceholders` y `construirVars` se REUTILIZAN de `netlify-deploy.js`.** Ese fichero
 *    lleva escrito el aviso de por qué: `construirVars` estuvo duplicada palabra por palabra y
 *    las dos copias se separaron sin que nadie lo viera. Si esta página y la de Netlify
 *    derivaran los colores o el teléfono de forma distinta, el trial vería una web y el cliente
 *    de pago otra.
 */
'use strict';

const router  = require('express').Router();
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { construirVars, __test__ } = require('../netlify-deploy');
const applyPlaceholders = __test__.applyPlaceholders;

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'web-template');

/* ── La plantilla, leída una sola vez ──────────────────────────────────────── */
let PLANTILLA = null;
let ERROR_CARGA = null;
try {
  PLANTILLA = fs.readFileSync(path.join(TEMPLATE_DIR, 'cita.html'), 'utf-8');
  console.log(`[citas-web] plantilla cargada: ${PLANTILLA.length} bytes`);
} catch (e) {
  // No se tira el relay por esto: el resto (agendas, reservas, licencias) tiene que seguir
  // funcionando aunque falte la plantilla. Pero se dice, y la ruta responderá 500 honesto.
  ERROR_CARGA = e.message;
  console.error('[citas-web] NO se pudo cargar web-template/cita.html:', e.message);
}

/**
 * Las referencias relativas, a la ruta fija compartida.
 *
 * Solo hay dos (`css/styles.css` y `js/main.js`), comprobado sobre la plantilla. Se anclan a
 * comilla para no tocar por accidente una aparición dentro del JavaScript de la página.
 */
function rutasAbsolutas(html) {
  return html
    .replace(/(href|src)="css\//g,  '$1="/cita-assets/css/')
    .replace(/(href|src)="js\//g,   '$1="/cita-assets/js/')
    .replace(/(href|src)="images\//g, '$1="/cita-assets/images/');
}

/**
 * El aviso de que esto es la web de una prueba.
 *
 * Va aquí y no en la plantilla porque la plantilla es la de los clientes de pago: a ellos no
 * les corresponde ningún aviso. Y lleva `noindex` por lo mismo que `gestionar.html`: esta
 * dirección no es una web pública que deba salir en Google, es un enlace para verlo funcionar.
 */
function marcarComoPrueba(html, clinicaId) {
  const noindex = '<meta name="robots" content="noindex, nofollow">';
  const aviso = `
<div style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#1E3A5F;color:#fff;
            font:500 13px/1.45 system-ui,sans-serif;padding:10px 16px;text-align:center">
  Esta es tu web de citas en el período de prueba, servida por PodoSystem.
  <strong>Con tu suscripción tendrás tu propio dominio.</strong>
</div>`;
  return html
    .replace(/<head([^>]*)>/i, `<head$1>${noindex}`)
    .replace(/<\/body>/i, `${aviso}</body>`)
    .replace(/<\/body>/i, `<!-- podosystem: cita de prueba servida por el relay · ${clinicaId} -->\n</body>`);
}

/** Un 404 que puede leer una persona, no el JSON del 404 global. */
function paginaNoEncontrada(res, titulo, detalle) {
  res.status(404).type('html').send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${titulo}</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;
             font:400 16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1E3A5F">
  <div style="max-width:30rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 .75rem">${titulo}</h1>
    <p style="margin:0;color:#5b6472">${detalle}</p>
  </div>
</body></html>`);
}

/* ── Los assets, en ruta fija y compartida ─────────────────────────────────── */
//
// ⚠️ Se bloquea cualquier `.html` ANTES del estático: bajo `web-template` están `cita.html` y
// `gestionar.html` **sin sustituir**, y servirlos crudos enseñaría `{{CLINICA_NOMBRE}}` y demás
// a cualquiera que adivinara la ruta. Los assets (CSS, JS, imágenes) no llevan marcadores
// —comprobado— así que esos sí van tal cual.
router.use('/cita-assets', (req, res, next) => {
  if (/\.html?$/i.test(req.path)) return res.status(404).json({ ok: false, error: 'No disponible' });
  next();
});
router.use('/cita-assets', express.static(TEMPLATE_DIR, {
  index: false,
  maxAge: '1h',
  fallthrough: true,
}));

/* ── La página de una clínica ──────────────────────────────────────────────── */
router.get('/cita/:clinicaId', (req, res) => {
  if (!PLANTILLA) {
    console.error('[citas-web] petición sin plantilla cargada:', ERROR_CARGA);
    return res.status(500).type('html').send('<!doctype html><meta charset="utf-8">'
      + '<p style="font:16px system-ui;padding:2rem">La web de citas no está disponible ahora mismo.</p>');
  }

  const { clinicaId } = req.params;

  // `activa = 1` no es decorativo: es la misma puerta que cierra la web pública cuando se
  // cancela una suscripción (punto 26). Una clínica dada de baja no puede seguir ofreciendo
  // huecos.
  const clinica = req.db
    .prepare('SELECT id, nombre, ciudad, direccion, telefono FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);

  if (!clinica) {
    return paginaNoEncontrada(res,
      'Esta web de citas no está disponible',
      'El enlace no corresponde a ninguna clínica activa. Si es tuyo, vuelve a activarlo desde PodoSystem.');
  }

  const vars = construirVars({
    clinicaId: clinica.id,
    nombre:    clinica.nombre,
    ciudad:    clinica.ciudad    || '',
    direccion: clinica.direccion || '',
    telefono:  clinica.telefono  || '',
  });

  let html = applyPlaceholders(PLANTILLA, vars);
  html = rutasAbsolutas(html);
  html = marcarComoPrueba(html, clinica.id);

  // Sin caché: el horario y los datos de la clínica cambian, y la página se pide pocas veces.
  // Los assets, que son el peso de verdad, sí van cacheados arriba.
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

module.exports = router;
