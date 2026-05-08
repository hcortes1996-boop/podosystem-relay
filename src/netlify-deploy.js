/**
 * netlify-deploy.js — Despliega automáticamente la web de citas de un cliente en Netlify.
 *
 * Requiere NETLIFY_TOKEN en variables de entorno (Railway).
 * Usa la API de Netlify: crea un site + sube un zip con la plantilla personalizada.
 */

const fs   = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE_DIR = path.join(__dirname, '..', 'web-template');
const NETLIFY_API  = 'https://api.netlify.com/api/v1';

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
    .replace(/\{\{CLINICA_ID\}\}/g,           vars.clinicaId)
    .replace(/\{\{CLINICA_NOMBRE\}\}/g,        vars.nombre)
    .replace(/\{\{CLINICA_NOMBRE_HEADER\}\}/g, vars.nombreHeader)
    .replace(/\{\{CLINICA_TELEFONO\}\}/g,      vars.telefono)
    .replace(/\{\{CLINICA_TELEFONO_RAW\}\}/g,  vars.telefonoRaw)
    .replace(/\{\{CLINICA_DESCRIPCION\}\}/g,   vars.descripcion);
}

async function buildZip(vars) {
  const zip = new JSZip();

  function addDir(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      const zipPath  = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        addDir(fullPath, zipPath);
      } else if (e.name === 'cita.html') {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        zip.file(zipPath, applyPlaceholders(raw, vars));
      } else {
        zip.file(zipPath, fs.readFileSync(fullPath));
      }
    }
  }

  addDir(TEMPLATE_DIR, '');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
  // Intenta con el slug base; si está ocupado añade sufijo aleatorio
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
 * @param {string} opts.clinicaId    — ID del relay
 * @param {string} opts.nombre       — nombre completo de la clínica
 * @param {string} [opts.telefono]   — teléfono (opcional)
 * @returns {Promise<{ webUrl: string, netlifyId: string, siteName: string }>}
 */
async function deployClientSite({ clinicaId, nombre, telefono = '' }) {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_TOKEN no configurado en Railway');

  const slug    = toSlug(nombre);
  const teleRaw = telefono.replace(/\D/g, '');

  // Nombre en header: primera línea / segunda línea si tiene dos palabras significativas
  const partes = nombre.trim().split(/\s+/);
  const nombreHeader = partes.length >= 3
    ? `${partes.slice(0, -1).join(' ')}<br><strong>${partes[partes.length - 1]}</strong>`
    : `<strong>${nombre}</strong>`;

  const vars = {
    clinicaId,
    nombre,
    nombreHeader,
    telefono:    telefono || 'Sin teléfono',
    telefonoRaw: teleRaw  || '000000000',
    descripcion: `Podología en ${nombre}`,
  };

  const { siteId, siteName } = await createNetlifySite(token, slug);
  console.log(`[netlify] Site creado: ${siteName} (${siteId})`);

  const zipBuffer = await buildZip(vars);
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
