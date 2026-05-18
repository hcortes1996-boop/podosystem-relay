/**
 * netlify-deploy.js — Despliega automáticamente la web de citas de un cliente en Netlify.
 *
 * Requiere NETLIFY_TOKEN en variables de entorno (Railway).
 * Usa fflate (puro JS, sin compilación nativa) para generar el ZIP.
 */

const fs    = require('fs');
const path  = require('path');
const { zipSync } = require('fflate');

const TEMPLATE_DIR = path.join(__dirname, '..', 'web-template');
const NETLIFY_API  = 'https://api.netlify.com/api/v1';

/**
 * Deriva una paleta de colores profesional y única a partir del nombre de la clínica.
 * Usa un hash simple para elegir un matiz (hue) en rangos médicos/profesionales.
 * Resultado: tres colores CSS HSL para el fondo hero.
 */
function clinicaColors(nombre) {
  let hash = 0;
  for (let i = 0; i < nombre.length; i++) {
    hash = ((hash << 5) - hash + nombre.charCodeAt(i)) | 0;
  }
  // Mantener hue en rangos profesionales: azul-verde-violeta (170–260)
  const hue = 170 + (Math.abs(hash) % 90);
  const hue2 = (hue + 20) % 360;
  const hueAccent = (hue + 140) % 360;
  return {
    color1:  `hsl(${hue},  45%, 12%)`,      // oscuro base
    color2:  `hsl(${hue2}, 50%, 22%)`,      // oscuro medio
    accent:  `hsl(${hueAccent}, 35%, 18%)`, // acento sutil
  };
}

function toSlug(nombre) {
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

function applyPlaceholders(content, vars) {
  return content
    .replace(/\{\{CLINICA_ID\}\}/g,              vars.clinicaId)
    .replace(/\{\{CLINICA_NOMBRE\}\}/g,           vars.nombre)
    .replace(/\{\{CLINICA_NOMBRE_HEADER\}\}/g,    vars.nombreHeader)
    .replace(/\{\{CLINICA_COLOR_1\}\}/g,          vars.color1)
    .replace(/\{\{CLINICA_COLOR_2\}\}/g,          vars.color2)
    .replace(/\{\{CLINICA_COLOR_ACCENT\}\}/g,     vars.colorAccent)
    .replace(/\{\{CLINICA_CIUDAD\}\}/g,           vars.ciudad)
    .replace(/\{\{CLINICA_DIRECCION\}\}/g,        vars.direccion)
    .replace(/\{\{CLINICA_TELEFONO\}\}/g,         vars.telefono)
    .replace(/\{\{CLINICA_TELEFONO_RAW\}\}/g,     vars.telefonoRaw)
    .replace(/\{\{CLINICA_DESCRIPCION\}\}/g,      vars.descripcion);
}

function buildZip(vars) {
  const files = {};

  function addDir(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, e.name);
      const zipPath  = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        addDir(fullPath, zipPath);
      } else if (e.name === 'cita.html') {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        files[zipPath] = Buffer.from(applyPlaceholders(raw, vars));
      } else {
        files[zipPath] = fs.readFileSync(fullPath);
      }
    }
  }

  addDir(TEMPLATE_DIR, '');
  // Redirect raíz → /cita.html para evitar 404 al visitar el dominio sin ruta
  files['_redirects'] = Buffer.from('/  /cita.html  301\n');
  return Buffer.from(zipSync(files));
}

async function netlifyPost(path_, token, body, contentType = 'application/json') {
  const res = await fetch(`${NETLIFY_API}${path_}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  contentType,
    },
    body: contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function createNetlifySite(token, slug) {
  for (let i = 0; i < 4; i++) {
    const name = i === 0 ? slug : `${slug}-${Math.random().toString(36).slice(2, 5)}`;
    const { ok, data } = await netlifyPost('/sites', token, { name });
    if (ok) return { siteId: data.id, siteName: name };
    const err = JSON.stringify(data);
    if (!err.includes('taken') && !err.includes('already') && !err.includes('exists')) {
      throw new Error(`Netlify crear site: ${err}`);
    }
  }
  throw new Error('No se pudo crear el site en Netlify — nombre ya en uso en los 4 intentos');
}

/**
 * deployClientSite — punto de entrada principal.
 *
 * @param {object} opts
 * @param {string} opts.clinicaId   — ID del relay
 * @param {string} opts.nombre      — nombre completo de la clínica
 * @param {string} [opts.ciudad]    — ciudad (ej: "Sevilla")
 * @param {string} [opts.direccion] — dirección completa
 * @param {string} [opts.telefono]  — teléfono
 * @returns {Promise<{ webUrl: string, netlifyId: string, siteName: string }>}
 */
async function deployClientSite({ clinicaId, nombre, ciudad = '', direccion = '', telefono = '' }) {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_TOKEN no configurado en Railway');

  const slug    = toSlug(nombre);
  const teleRaw = telefono.replace(/\D/g, '');

  const partes = nombre.trim().split(/\s+/);
  const nombreHeader = partes.length >= 3
    ? `${partes.slice(0, -1).join(' ')}<br><strong>${partes[partes.length - 1]}</strong>`
    : `<strong>${nombre}</strong>`;

  const colors = clinicaColors(nombre);
  const vars = {
    clinicaId,
    nombre,
    nombreHeader,
    ciudad:       ciudad    || 'su ciudad',
    direccion:    direccion || '',
    telefono:     telefono  || 'Sin teléfono',
    telefonoRaw:  teleRaw   || '000000000',
    descripcion:  `Podología en ${ciudad || nombre}`,
    color1:       colors.color1,
    color2:       colors.color2,
    colorAccent:  colors.accent,
  };

  const { siteId, siteName } = await createNetlifySite(token, slug);
  console.log(`[netlify] Site creado: ${siteName} (${siteId})`);

  const zipBuffer = buildZip(vars);
  console.log(`[netlify] ZIP generado: ${zipBuffer.length} bytes`);

  const { ok, data } = await netlifyPost(
    `/sites/${siteId}/deploys`,
    token,
    zipBuffer,
    'application/zip'
  );
  if (!ok) throw new Error(`Netlify deploy: ${JSON.stringify(data)}`);

  const webUrl = `https://${siteName}.netlify.app/cita.html`;
  console.log(`[netlify] Deploy completado: ${webUrl}`);
  return { webUrl, netlifyId: siteId, siteName };
}

module.exports = { deployClientSite };
