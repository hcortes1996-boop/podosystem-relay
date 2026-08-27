/**
 * descarga.js — Dónde está el último EXE público.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * `demo.html` tenía el enlace escrito a mano:
 *
 *     .../releases/download/v3.1.0/PodoSystem_v3.1.0.exe
 *
 * Y ahí se quedó. El 27-08-2026 la web seguía ofreciendo la **v3.1.0, del 1 de julio** —
 * anterior a la 3.3.1, que fue la primera versión firmada. O sea que todo el que se
 * descargaba la prueba recibía un instalador **sin firmar**, con el aviso de SmartScreen de
 * Windows por delante. Para un producto de pago, esa era la primera impresión.
 *
 * Un enlace que hay que acordarse de actualizar en cada versión se queda viejo. Este módulo
 * **pregunta** cuál es la última: la web deja de poder quedarse atrás.
 *
 * ── El repositorio ───────────────────────────────────────────────────────────
 *
 * `podosystem-releases` es PÚBLICO (comprobado: responde 200 sin autenticación), distinto
 * del privado que usa el auto-updater. Por eso aquí no hace falta ningún token — y por eso
 * mismo sirve como vía de descarga de emergencia el día que el updater falle.
 */

'use strict';

const REPO = process.env.RELEASES_REPO || 'hcortes1996-boop/podosystem-releases';
const CACHE_MS = 10 * 60 * 1000;

let _cache = null;   // { url, version, en }

/**
 * @returns {Promise<{url:string|null, version:string|null, error?:string}>}
 */
async function ultimaDescarga() {
  if (_cache && Date.now() - _cache.en < CACHE_MS) {
    return { url: _cache.url, version: _cache.version };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'podosystem-relay' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);

    const rel = await res.json();
    const exe = (rel.assets || []).find(a => /\.exe$/i.test(a.name));
    if (!exe) throw new Error('el último release no tiene ningún .exe');

    _cache = { url: exe.browser_download_url, version: rel.tag_name, en: Date.now() };
    return { url: _cache.url, version: _cache.version };
  } catch (e) {
    // Si GitHub no responde se devuelve lo último que se supo, aunque esté caducado: una URL
    // de hace un rato vale infinitamente más que ninguna.
    if (_cache) return { url: _cache.url, version: _cache.version, error: e.message };
    return { url: null, version: null, error: e.message };
  }
}

module.exports = { ultimaDescarga, REPO };
