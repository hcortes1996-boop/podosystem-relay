/**
 * test_descarga.js — La demo tiene que poder descargarse aunque la API de GitHub diga que no.
 *
 * 01-10-2026: tras mover el relay a Ámsterdam, `/api/trial/descarga` respondía 503 con
 * «GitHub respondió 403». La API sin token admite 60 consultas por hora y por IP, y la IP de
 * Railway es compartida. Quien rellenaba el formulario de la demo se quedaba sin EXE.
 */
'use strict';

const descarga = require('../src/lib/descarga');

let fallos = 0;
const ok = (c, msg, extra) => { console.log(`${c ? '✅' : '❌'} ${msg}${!c && extra ? ' → ' + extra : ''}`); if (!c) fallos++; };

const respuesta = (status, { json, location } = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => json,
  headers: { get: (h) => (h.toLowerCase() === 'location' ? location || null : null) },
});

const original = global.fetch;
function simular(fn) { global.fetch = fn; descarga._olvidar(); }

(async () => {
  console.log('── La API responde: manda la API ──');
  simular(async (url) => url.includes('api.github.com')
    ? respuesta(200, { json: { tag_name: 'v9.9.9', assets: [{ name: 'PodoSystem_v9.9.9.exe', browser_download_url: 'https://x/api.exe' }] } })
    : respuesta(500));
  let r = await descarga.ultimaDescarga();
  ok(r.url === 'https://x/api.exe' && r.version === 'v9.9.9', 'usa la URL que da la API', JSON.stringify(r));

  console.log('\n── La API da 403 (cupo agotado): respaldo por la web ──');
  simular(async (url, opts) => {
    if (url.includes('api.github.com')) return respuesta(403);
    ok(opts && opts.redirect === 'manual', 'la web se consulta sin seguir la redirección');
    return respuesta(302, { location: `https://github.com/${descarga.REPO}/releases/tag/v3.10.43` });
  });
  r = await descarga.ultimaDescarga();
  ok(r.url === `https://github.com/${descarga.REPO}/releases/download/v3.10.43/PodoSystem_v3.10.43.exe`,
    'construye la URL del EXE desde la etiqueta', r.url);
  ok(r.version === 'v3.10.43' && !r.error, 'con la versión y sin error', JSON.stringify(r));

  console.log('\n── Una redirección que no es una versión no se inventa una URL ──');
  simular(async (url) => url.includes('api.github.com') ? respuesta(403) : respuesta(302, { location: 'https://github.com/login' }));
  r = await descarga.ultimaDescarga();
  ok(r.url === null && /403/.test(r.error) && /respaldo/.test(r.error), 'sin URL, y el error dice las dos causas', JSON.stringify(r));

  console.log('\n── Si fallan las dos, se sirve lo último que se supo ──');
  simular(async () => respuesta(403, { json: {} }));
  descarga._olvidar();
  simular(async (url) => url.includes('api.github.com')
    ? respuesta(200, { json: { tag_name: 'v1.0.0', assets: [{ name: 'a.exe', browser_download_url: 'https://x/a.exe' }] } })
    : respuesta(500));
  await descarga.ultimaDescarga();
  global.fetch = async () => { throw new Error('sin red'); };
  // Caducar la caché a mano sin borrarla: se mantiene la URL pero se vuelve a preguntar.
  const realNow = Date.now; Date.now = () => realNow() + 11 * 60 * 1000;
  r = await descarga.ultimaDescarga();
  Date.now = realNow;
  ok(r.url === 'https://x/a.exe' && !!r.error, 'devuelve la URL anterior con el error al lado', JSON.stringify(r));

  global.fetch = original;
  console.log(fallos ? `\n❌ ${fallos} fallo(s)` : '\n✅ Todo en verde');
  process.exit(fallos ? 1 : 0);
})();
