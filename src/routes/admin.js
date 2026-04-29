/**
 * admin.js — Panel de administración PodoSystem
 *
 * Rutas:
 *   GET  /admin              → HTML panel (autenticación por token en UI)
 *   GET  /admin/api/stats    → resumen general
 *   GET  /admin/api/licencias→ lista de licencias
 *   POST /admin/api/licencias→ crear licencia
 *   PUT  /admin/api/licencias/:id → actualizar licencia
 *   DELETE /admin/api/licencias/:id → eliminar
 *   GET  /admin/api/clinicas → lista clínicas relay
 *   POST /admin/api/nuevo-cliente → flujo completo: licencia + relay + email draft
 *
 * Auth: todas /admin/api/* requieren header Authorization: Bearer <ADMIN_TOKEN>
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const { genId, genApiKey } = require('../db');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambiar-este-token-en-railway';

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

// ── HTML del panel ────────────────────────────────────────────────────────────

const adminHtmlPath = path.resolve(__dirname, '..', 'admin-panel', 'index.html');

router.get('/admin', (_req, res) => {
  if (fs.existsSync(adminHtmlPath)) {
    res.sendFile(adminHtmlPath);
  } else {
    res.status(503).send('<h2>Admin panel HTML not found. Deploy src/admin-panel/index.html.</h2>');
  }
});

// ── API ───────────────────────────────────────────────────────────────────────

router.get('/admin/api/stats', authAdmin, (req, res) => {
  const db = req.db;
  const licencias    = db.prepare('SELECT * FROM licencias').all();
  const clinicas     = db.prepare('SELECT * FROM clinicas').all();

  const activas      = licencias.filter(l => l.estado === 'active').length;
  const trial        = licencias.filter(l => l.estado === 'trial').length;
  const expiradas    = licencias.filter(l => l.estado === 'expired' || l.estado === 'blocked').length;

  res.json({
    ok: true,
    stats: {
      totalLicencias: licencias.length,
      activas,
      trial,
      expiradas,
      totalClinicas: clinicas.length,
      ingresosMes: activas * 19, // 19€/mes por licencia activa
    }
  });
});

router.get('/admin/api/licencias', authAdmin, (req, res) => {
  const licencias = req.db.prepare('SELECT * FROM licencias ORDER BY createdAt DESC').all();
  res.json({ ok: true, licencias });
});

router.post('/admin/api/licencias', authAdmin, (req, res) => {
  const { clienteNombre, clienteEmail, notas } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre y clienteEmail son obligatorios' });
  }
  const id         = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, notas, estado)
    VALUES (?, ?, ?, ?, ?, 'trial')
  `).run(id, licenseKey, clienteNombre.trim(), clienteEmail.trim(), notas || '');

  res.status(201).json({ ok: true, id, licenseKey });
});

router.put('/admin/api/licencias/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  const campos  = ['clienteNombre','clienteEmail','clinicaId','hardwareId','instanceId',
                   'estado','activadaEn','ultimaValidacion','proximaRenovacion','notas'];
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

router.delete('/admin/api/licencias/:id', authAdmin, (req, res) => {
  req.db.prepare('DELETE FROM licencias WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/admin/api/clinicas', authAdmin, (req, res) => {
  const clinicas = req.db.prepare('SELECT id, nombre, createdAt, activa FROM clinicas ORDER BY createdAt DESC').all();
  res.json({ ok: true, clinicas });
});

// Flujo completo: crear licencia + clínica relay + borrador email
router.post('/admin/api/nuevo-cliente', authAdmin, (req, res) => {
  const { clienteNombre, clienteEmail, clinicaNombre } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim() || !clinicaNombre?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre, clienteEmail y clinicaNombre son obligatorios' });
  }

  // 1. Crear licencia
  const licId      = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado)
    VALUES (?, ?, ?, ?, 'trial')
  `).run(licId, licenseKey, clienteNombre.trim(), clienteEmail.trim());

  // 2. Crear clínica relay
  const clinicaId = genId(10);
  const apiKey    = genApiKey();
  req.db.prepare(`
    INSERT INTO clinicas (id, nombre, apiKey) VALUES (?, ?, ?)
  `).run(clinicaId, clinicaNombre.trim(), apiKey);

  // 3. Actualizar licencia con clinicaId
  req.db.prepare('UPDATE licencias SET clinicaId = ? WHERE id = ?').run(clinicaId, licId);

  // 4. Generar borrador email
  const relayUrl  = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  const emailDraft = generarEmailBienvenida({
    nombre: clienteNombre.trim(),
    email: clienteEmail.trim(),
    licenseKey,
    clinicaId,
    apiKey,
    relayUrl,
  });

  res.status(201).json({
    ok: true,
    licenseKey,
    clinicaId,
    apiKey,
    emailDraft,
  });
});

// Verificar si una licencia existe en nuestro sistema (llamado desde Electron en activación)
router.post('/admin/api/licencias/verificar', (req, res) => {
  const { licenseKey, hardwareId, instanceId } = req.body;
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey requerida' });
  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (lic.estado === 'blocked') return res.status(403).json({ ok: false, error: 'Licencia bloqueada' });
  // Registrar hardware la primera vez
  if (!lic.hardwareId && hardwareId) {
    req.db.prepare('UPDATE licencias SET hardwareId=?, instanceId=?, estado=?, activadaEn=?, ultimaValidacion=? WHERE id=?')
      .run(hardwareId, instanceId||'', 'active', new Date().toISOString(), new Date().toISOString(), lic.id);
  } else if (lic.hardwareId && lic.hardwareId !== hardwareId) {
    return res.status(403).json({ ok: false, error: 'hardware_mismatch' });
  } else {
    req.db.prepare('UPDATE licencias SET ultimaValidacion=? WHERE id=?')
      .run(new Date().toISOString(), lic.id);
  }
  res.json({ ok: true, estado: lic.estado });
});

function generarEmailBienvenida({ nombre, email, licenseKey, clinicaId, apiKey, relayUrl }) {
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

─────────────────────────────────────
🌐 CITAS ONLINE (opcional)

Si quieres activar el sistema de reservas online, estos son tus datos:
  • ID Clínica:  ${clinicaId}
  • API Key:     ${apiKey}
  • Relay URL:   ${relayUrl}

Dentro de PodoSystem ve a: Citas Web → Configuración → pega estos datos → Conectar → Sincronizar.

─────────────────────────────────────
📥 DESCARGA

Descarga PodoSystem en: https://podosystem.es

─────────────────────────────────────

¿Tienes alguna duda? Escríbenos a soporte@podosystem.es o llámanos.

Un saludo,
El equipo de PodoSystem
`.trim()
  };
}

module.exports = router;
