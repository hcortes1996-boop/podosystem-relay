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
    let r;
    try {
      r = await porLaApi();
    } catch (eApi) {
      // La API sin token admite 60 consultas por hora y por IP, y la IP de Railway es
      // compartida: desde el traslado a Ámsterdam (30-09-2026) respondía 403 y la demo se
      // quedó sin descarga. La web normal no cuenta contra ese cupo.
      try { r = await porLaWeb(); } catch (eWeb) { throw new Error(`${eApi.message}; respaldo: ${eWeb.message}`); }
    }
    _cache = { ...r, en: Date.now() };
    return { url: _cache.url, version: _cache.version };
  } catch (e) {
    // Si GitHub no responde se devuelve lo último que se supo, aunque esté caducado: una URL
    // de hace un rato vale infinitamente más que ninguna.
    if (_cache) return { url: _cache.url, version: _cache.version, error: e.message };
    return { url: null, version: null, error: e.message };
  }
}

async function porLaApi() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'podosystem-relay' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);

  const rel = await res.json();
  const exe = (rel.assets || []).find(a => /\.exe$/i.test(a.name));
  if (!exe) throw new Error('el último release no tiene ningún .exe');
  return { url: exe.browser_download_url, version: rel.tag_name };
}

/**
 * Sin API: `github.com/<repo>/releases/latest` redirige a `/releases/tag/vX.Y.Z`. El nombre
 * del EXE sale de la etiqueta porque electron-builder lo forma así (`PodoSystem_v${version}.exe`).
 */
async function porLaWeb() {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'podosystem-relay' },
    signal: AbortSignal.timeout(8000),
  });
  const destino = res.headers.get('location') || '';
  const m = destino.match(/\/releases\/tag\/(v\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`la web no redirigió a una versión (${res.status})`);
  const tag = m[1];
  return { url: `https://github.com/${REPO}/releases/download/${tag}/PodoSystem_${tag}.exe`, version: tag };
}

function _olvidar() { _cache = null; }

module.exports = { ultimaDescarga, REPO, _olvidar };
