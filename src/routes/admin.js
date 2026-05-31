/**
 * admin.js — Panel de administración PodoSystem
 *
 * Montado en /admin desde index.js, así las rutas internas son:
 *   GET  /              → HTML panel (ruta pública, auth en UI con JS)
 *   GET  /api/stats     → resumen general
 *   GET  /api/licencias → lista de licencias
 *   POST /api/licencias → crear licencia
 *   PUT  /api/licencias/:id → actualizar licencia
 *   DELETE /api/licencias/:id → eliminar
 *   GET  /api/clinicas  → lista clínicas relay
 *   POST /api/nuevo-cliente → flujo completo: licencia + relay + email draft
 *   POST /api/licencias/verificar → verificar licencia desde Electron (sin auth)
 *
 * Auth: todas /api/* (excepto /api/licencias/verificar) requieren
 *       header Authorization: Bearer <ADMIN_TOKEN>
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const { genId, genApiKey, genActivationCode } = require('../db');
const { deployClientSite } = require('../netlify-deploy');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambiar-este-token-en-railway';

// Cargar el HTML del panel al arrancar (más fiable que sendFile en producción)
const adminHtmlPath = path.resolve(__dirname, '..', 'admin-panel', 'index.html');
let adminHtml = '';
try {
  adminHtml = fs.readFileSync(adminHtmlPath, 'utf-8');
  console.log('[admin] HTML panel cargado desde:', adminHtmlPath);
} catch (e) {
  adminHtml = `<!DOCTYPE html><html><body>
    <h2>Admin panel no encontrado</h2>
    <p>Ruta esperada: ${adminHtmlPath}</p>
    <p>Error: ${e.message}</p>
  </body></html>`;
  console.error('[admin] ERROR cargando HTML:', e.message);
}

function authAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
}

function genLicenseKey() {
  // Formato XXXXX-XXXXX-XXXXX-XXXXX (20 chars hex + guiones)
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return [0,4,8,12,16].map((s,i,a) => bytes.slice(s, a[i+1] || bytes.length)).join('-');
}

// ── HTML del panel (GET /admin) ───────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtml);
});

// Alias /admin/index.html → mismo HTML
router.get('/index.html', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtml);
});

// ── Verificar licencia desde Electron (sin auth admin) ───────────────────────

router.post('/api/licencias/verificar', (req, res) => {
  const { licenseKey, hardwareId, instanceId } = req.body;
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey requerida' });
  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (lic.estado === 'blocked') return res.status(403).json({ ok: false, error: 'Licencia bloqueada' });
  // Registrar hardware la primera vez
  if (!lic.hardwareId && hardwareId) {
    req.db.prepare('UPDATE licencias SET hardwareId=?, instanceId=?, estado=?, activadaEn=?, ultimaValidacion=? WHERE id=?')
      .run(hardwareId, instanceId || '', 'active', new Date().toISOString(), new Date().toISOString(), lic.id);
  } else if (lic.hardwareId && lic.hardwareId !== hardwareId) {
    return res.status(403).json({ ok: false, error: 'hardware_mismatch' });
  } else {
    req.db.prepare('UPDATE licencias SET ultimaValidacion=? WHERE id=?')
      .run(new Date().toISOString(), lic.id);
  }
  const updated = req.db.prepare('SELECT * FROM licencias WHERE id=?').get(lic.id);
  res.json({ ok: true, estado: updated.estado });
});

// ── API (requiere ADMIN_TOKEN) ────────────────────────────────────────────────

router.get('/api/stats', authAdmin, (req, res) => {
  const licencias = req.db.prepare('SELECT * FROM licencias').all();
  const clinicas  = req.db.prepare('SELECT * FROM clinicas').all();

  const activas   = licencias.filter(l => l.estado === 'active').length;
  const trial     = licencias.filter(l => l.estado === 'trial').length;
  const expiradas = licencias.filter(l => l.estado === 'expired' || l.estado === 'blocked').length;
  const solicitudesPendientes = req.db.prepare("SELECT COUNT(*) AS n FROM solicitudes_alta WHERE estado='pendiente'").get().n;

  res.json({
    ok: true,
    stats: {
      totalLicencias: licencias.length,
      activas,
      trial,
      expiradas,
      totalClinicas: clinicas.length,
      ingresosMes: activas * 19,
      solicitudesPendientes,
    }
  });
});

router.get('/api/licencias', authAdmin, (req, res) => {
  const licencias = req.db.prepare('SELECT * FROM licencias ORDER BY createdAt DESC').all();
  res.json({ ok: true, licencias });
});

router.post('/api/licencias', authAdmin, (req, res) => {
  const { clienteNombre, clienteEmail, notas } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre y clienteEmail son obligatorios' });
  }
  const id         = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, notas, estado)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(id, licenseKey, clienteNombre.trim(), clienteEmail.trim(), notas || '');

  res.status(201).json({ ok: true, id, licenseKey });
});

router.put('/api/licencias/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  const campos  = ['clienteNombre','clienteEmail','clinicaId','hardwareId','instanceId',
                   'estado','activadaEn','ultimaValidacion','proximaRenovacion','notas',
                   'fuente','suscripcionId','max_podologos','plan_extra'];
  const updates = [];
  const vals    = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) { updates.push(`${c} = ?`); vals.push(req.body[c]); }
  }
  if (!updates.length) return res.status(400).json({ ok: false, error: 'Nada que actualizar' });
  vals.push(id);
  req.db.prepare(`UPDATE licencias SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

router.delete('/api/licencias/:id', authAdmin, (req, res) => {
  req.db.prepare('DELETE FROM licencias WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/api/clinicas', authAdmin, (req, res) => {
  const clinicas = req.db.prepare('SELECT id, nombre, createdAt, activa, activation_code, activation_code_used FROM clinicas ORDER BY createdAt DESC').all();
  res.json({ ok: true, clinicas });
});

router.post('/api/clinicas/:id/regenerar-codigo', authAdmin, (req, res) => {
  const { id } = req.params;
  const clinica = req.db.prepare('SELECT id, nombre FROM clinicas WHERE id = ?').get(id);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  const activation_code = genActivationCode(clinica.nombre);
  req.db.prepare('UPDATE clinicas SET activation_code = ?, activation_code_used = 0 WHERE id = ?').run(activation_code, id);
  res.json({ ok: true, activation_code });
});

router.delete('/api/clinicas/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  try {
    req.db.transaction(() => {
      req.db.prepare('DELETE FROM citas_remote_ops  WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM agenda_snapshot   WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM agenda_config     WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM citas_ocupadas    WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM reservas          WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM solicitudes       WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM bloqueos          WHERE clinicaId = ?').run(id);
      req.db.prepare('DELETE FROM clinicas          WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] Error eliminando clínica:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Flujo completo: crear licencia + clínica relay + despliegue Netlify + borrador email
router.post('/api/nuevo-cliente', authAdmin, async (req, res) => {
  const { clienteNombre, clienteEmail, clinicaNombre, clinicaTelefono = '', clinicaCiudad = '', clinicaDireccion = '', clinicaLogoUrl = '' } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim() || !clinicaNombre?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre, clienteEmail y clinicaNombre son obligatorios' });
  }

  // 1. Crear licencia
  const licId      = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado)
    VALUES (?, ?, ?, ?, 'active')
  `).run(licId, licenseKey, clienteNombre.trim(), clienteEmail.trim());

  // 2. Crear clínica relay
  const clinicaId = genId(10);
  const apiKey    = genApiKey();
  const activationCode = genActivationCode(clinicaNombre.trim());
  req.db.prepare(`
    INSERT INTO clinicas (id, nombre, apiKey, activation_code, activation_code_used) VALUES (?, ?, ?, ?, 0)
  `).run(clinicaId, clinicaNombre.trim(), apiKey, activationCode);

  // 3. Vincular licencia con clínica
  req.db.prepare('UPDATE licencias SET clinicaId = ? WHERE id = ?').run(clinicaId, licId);

  // 4. Despliegue Netlify (si NETLIFY_TOKEN está configurado)
  let webUrl    = null;
  let netlifyId = null;
  let netlifyError = null;
  if (process.env.NETLIFY_TOKEN) {
    try {
      const result = await deployClientSite({
        clinicaId,
        nombre:     clinicaNombre.trim(),
        ciudad:     clinicaCiudad.trim(),
        direccion:  clinicaDireccion.trim(),
        telefono:   clinicaTelefono.trim(),
        logoUrl:    clinicaLogoUrl.trim(),
      });
      webUrl    = result.webUrl;
      netlifyId = result.netlifyId;
      req.db.prepare('UPDATE clinicas SET webUrl=?, netlifyId=? WHERE id=?')
        .run(webUrl, netlifyId, clinicaId);
    } catch (e) {
      netlifyError = e.message;
      console.error('[nuevo-cliente] Netlify deploy fallido:', e.message);
    }
  }

  // 5. Generar borrador email
  const relayUrl   = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  const emailDraft = generarEmailBienvenida({
    nombre:    clienteNombre.trim(),
    email:     clienteEmail.trim(),
    licenseKey,
    clinicaId,
    apiKey,
    relayUrl,
    webUrl,
    activationCode,
  });

  res.status(201).json({ ok: true, licenseKey, clinicaId, apiKey, activationCode, webUrl, netlifyError, emailDraft });
});

// ── Solicitudes de alta (formulario alta-relay.html) ─────────────────────────

router.get('/api/solicitudes-alta', authAdmin, (req, res) => {
  const { estado } = req.query;
  const sql = estado
    ? 'SELECT * FROM solicitudes_alta WHERE estado = ? ORDER BY creadaEn DESC'
    : 'SELECT * FROM solicitudes_alta ORDER BY creadaEn DESC';
  const rows = estado ? req.db.prepare(sql).all(estado) : req.db.prepare(sql).all();
  res.json({ ok: true, solicitudes: rows });
});

router.post('/api/solicitudes-alta/:id/aprobar', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { notas_admin } = req.body;

  const sol = req.db.prepare('SELECT * FROM solicitudes_alta WHERE id = ?').get(id);
  if (!sol) return res.status(404).json({ ok: false, error: 'Solicitud no encontrada' });
  if (sol.estado === 'aprobada') return res.status(400).json({ ok: false, error: 'Solicitud ya aprobada' });

  console.log(`[admin:aprobar] Iniciando — solicitud ${id} / ${sol.nombre_clinica}`);

  const clinicaId      = genId(10);
  const apiKey         = genApiKey();
  const activationCode = genActivationCode(sol.nombre_clinica);
  const now            = new Date().toISOString();

  try {
    req.db.transaction(() => {
      console.log(`[admin:aprobar] INSERT clinicas id=${clinicaId} activation_code=${activationCode}`);
      req.db.prepare(`
        INSERT INTO clinicas (id, nombre, apiKey, activation_code, activation_code_used, activa)
        VALUES (?, ?, ?, ?, 0, 1)
      `).run(clinicaId, sol.nombre_clinica.trim(), apiKey, activationCode);

      console.log(`[admin:aprobar] UPDATE solicitudes_alta clinicaId=${clinicaId}`);
      req.db.prepare(`
        UPDATE solicitudes_alta SET estado='aprobada', gestionadaEn=?, notas_admin=?, clinicaId=? WHERE id=?
      `).run(now, notas_admin || null, clinicaId, id);
    })();
    console.log(`[admin:aprobar] Transacción OK`);
  } catch (e) {
    console.error(`[admin:aprobar] Error transacción:`, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  // Responde antes de intentar el email
  res.json({ ok: true, clinica: { id: clinicaId, activation_code: activationCode } });

  // Fire-and-forget: email al cliente con código de activación
  const relayUrl = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  const { sendMail } = require('../email');
  const html = `
<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0f2137;padding:28px 40px">
    <p style="margin:0;font-size:20px;font-weight:800;color:#fff">Podo<span style="color:#2ecc9a">System</span></p>
    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.5)">Activación de Citas Online</p>
  </div>
  <div style="padding:32px 40px">
    <p style="margin:0 0 16px;color:#1a2a3a">Hola <strong>${esc(sol.profesional)}</strong>,</p>
    <p style="margin:0 0 24px;color:#1a2a3a">Tu cuenta de <strong>Citas Online PodoSystem</strong> para <strong>${esc(sol.nombre_clinica)}</strong> ya está activa. Usa este código en PodoSystem para activarla:</p>
    <div style="background:#f0f6ff;border:2px solid #2ecc9a;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#1E3A5F;text-transform:uppercase;letter-spacing:.1em">Código de activación</p>
      <p style="margin:0;font-family:monospace;font-size:28px;font-weight:800;letter-spacing:.15em;color:#0f2137">${esc(activationCode)}</p>
    </div>
    <p style="margin:0 0 8px;font-size:.9rem;color:#5a7080">En PodoSystem ve a: <strong>Citas Web → escribe el código → Activar citas web</strong></p>
    <p style="margin:24px 0 0;font-size:.85rem;color:#aaa">¿Dudas? Escríbenos a <a href="mailto:info@podosystem.es" style="color:#2ecc9a">info@podosystem.es</a></p>
  </div>
</div>`;
  sendMail({ to: sol.email, subject: `Tu código de activación PodoSystem — ${sol.nombre_clinica}`, html })
    .catch(e => console.error('[admin:aprobar] Email error:', e.message));
});

router.post('/api/solicitudes-alta/:id/rechazar', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { notas_admin, enviar_email } = req.body;
  const sol = req.db.prepare('SELECT * FROM solicitudes_alta WHERE id = ?').get(id);
  if (!sol) return res.status(404).json({ ok: false, error: 'Solicitud no encontrada' });

  req.db.prepare(`
    UPDATE solicitudes_alta SET estado='rechazada', gestionadaEn=?, notas_admin=? WHERE id=?
  `).run(new Date().toISOString(), notas_admin || null, id);

  if (enviar_email) {
    const { sendMail } = require('../email');
    const html = `
<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0f2137;padding:28px 40px">
    <p style="margin:0;font-size:20px;font-weight:800;color:#fff">Podo<span style="color:#2ecc9a">System</span></p>
  </div>
  <div style="padding:32px 40px">
    <p>Hola ${esc(sol.profesional)},</p>
    <p>Hemos recibido tu solicitud de información sobre PodoSystem para <strong>${esc(sol.nombre_clinica)}</strong>.</p>
    <p>Lamentablemente no podemos atenderte en este momento.${notas_admin ? ` ${esc(notas_admin)}` : ''}</p>
    <p>Si tienes alguna duda, contáctanos en <a href="mailto:info@podosystem.es">info@podosystem.es</a>.</p>
    <p style="margin-top:32px;color:#666">El equipo de PodoSystem</p>
  </div>
</div>`;
    try {
      await sendMail({ to: sol.email, subject: 'Tu solicitud en PodoSystem', html });
    } catch (e) {
      console.error('[solicitudes-alta] Error email rechazo:', e.message);
    }
  }

  res.json({ ok: true });
});

function generarEmailBienvenida({ nombre, email, licenseKey, clinicaId, apiKey, relayUrl, webUrl, activationCode }) {
  const seccionCitas = webUrl
    ? `─────────────────────────────────────
🌐 CITAS ONLINE

Tu web de reservas ya está lista y activa:
  ${webUrl}

Compártela con tus pacientes (web, WhatsApp, Instagram, etc.).

Para activarla en PodoSystem:

  ┌─────────────────────────────┐
  │  🔑 CÓDIGO DE ACTIVACIÓN    │
  │                             │
  │       ${(activationCode || '').padEnd(9)}          │
  │                             │
  └─────────────────────────────┘

  En PodoSystem ve a:
  Citas Web → escribe el código → Activar citas web`
    : `─────────────────────────────────────
🌐 CITAS ONLINE (opcional)

Si quieres activar el sistema de reservas online:

  ┌─────────────────────────────┐
  │  🔑 CÓDIGO DE ACTIVACIÓN    │
  │                             │
  │       ${(activationCode || '—').padEnd(9)}          │
  │                             │
  └─────────────────────────────┘

  En PodoSystem ve a:
  Citas Web → escribe el código → Activar citas web`;

  return {
    para: email,
    asunto: '¡Bienvenido/a a PodoSystem! Tus datos de acceso',
    cuerpo: `Hola ${nombre},

¡Bienvenido/a a PodoSystem! Aquí tienes todo lo que necesitas para empezar.

─────────────────────────────────────
🔑 CLAVE DE LICENCIA
${licenseKey}

Al abrir PodoSystem por primera vez, introduce esta clave cuando te la solicite.
La licencia queda vinculada al PC donde la actives.

${seccionCitas}

─────────────────────────────────────
📥 DESCARGA

Descarga PodoSystem en: https://podosystem.es

─────────────────────────────────────

¿Tienes alguna duda? Escríbenos a soporte@podosystem.es o llámanos.

Un saludo,
El equipo de PodoSystem`.trim()
  };
}

module.exports = router;
