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
const { firmar } = require('../firma');
const { deployClientSite, redeployClientSite } = require('../netlify-deploy');

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
  const { licenseKey, hardwareId, instanceId, version } = req.body;
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey requerida' });
  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (lic.estado === 'blocked') return res.status(403).json({ ok: false, error: 'Licencia bloqueada' });

  // Vista de flota (27-08-2026). El PC dice qué versión corre; aquí se anota junto a cuándo
  // se la vio. Un cliente atascado en una versión vieja se detecta antes de que llame.
  //
  // Va aparte del resto de UPDATEs y con su propio try: que esto falle NUNCA puede impedir
  // que una licencia se valide. Es telemetría, no autorización.
  // Tiene que PARECER una versión: 3.5.1, 3.5.1-beta.2. Un patrón laxo dejaba pasar
  // cualquier cosa —un número suelto, por ejemplo— y ensuciaba la columna del panel, que es
  // justamente donde hay que poder confiar de un vistazo.
  if (typeof version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(-[\w.]{1,16})?$/.test(version)) {
    try {
      req.db.prepare('UPDATE licencias SET version_instalada = ?, version_vista_en = ? WHERE id = ?')
        .run(String(version), new Date().toISOString(), lic.id);
    } catch (e) {
      console.error('[licencias] no se pudo anotar la version:', e.message);
    }
  }
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
  // Pieza 5.0 — devolver plan para que PodoSystem cliente determine features
  // sin depender de plan.json bundled. Default 'clinica' por ALTER TABLE.
  // V12 — la afirmacion va FIRMADA. Sin esto el PC es juez de su propia licencia: basta
  // escribir un license.enc a mano, porque dentro del intervalo de 7 dias ni pregunta.
  //
  // Se firma tambien el hardwareId: una licencia firmada de un equipo no vale en otro,
  // asi que copiar el fichero a otro PC sigue sin servir. Y va emitidoEn, para que una
  // respuesta vieja capturada no valga indefinidamente.
  const plan = updated.plan || 'clinica';
  const sello = firmar({
    tipo:       'licencia',
    licenseKey: updated.licenseKey,
    hardwareId: updated.hardwareId || hardwareId || null,
    estado:     updated.estado,
    plan,
  });

  res.json({
    ok: true,
    estado: updated.estado,
    plan,
    // Puede venir a null mientras FIRMA_PRIV_KEY no este puesta en Railway. El cliente
    // de esta version lo tolera; el de la siguiente, no.
    firmado: sello ? sello.firmado : null,
    firma:   sello ? sello.firma   : null,
  });
});

// ── API (requiere ADMIN_TOKEN) ────────────────────────────────────────────────

/**
 * Diagnóstico del proceso que está corriendo AHORA MISMO.
 *
 * Nace el 27-08-2026 de no poder responder a una pregunta simple: los correos salían con
 * `[TEST]` en el asunto —lo que en el código solo ocurre si `DEV_EMAIL_OVERRIDE` tiene
 * valor— pero esa variable no aparecía por ninguna parte en Railway. Sin poder mirar dentro
 * del proceso, la discusión se quedaba en suposiciones.
 *
 * Devuelve **si** hay valor, nunca **cuál**. Va tras el ADMIN_TOKEN porque describe la
 * configuración del servidor, aunque no contenga secretos.
 */
router.get('/api/diagnostico', authAdmin, (req, res) => {
  const hay = (v) => {
    const x = process.env[v];
    return typeof x === 'string' && x.trim().length > 0;
  };
  res.json({
    ok: true,
    ahora: new Date().toISOString(),
    correo: {
      // El que motivó todo esto.
      overrideDefinida:  hay('DEV_EMAIL_OVERRIDE'),
      overrideLongitud:  hay('DEV_EMAIL_OVERRIDE') ? process.env.DEV_EMAIL_OVERRIDE.trim().length : 0,
      // Lo que de verdad importa: si el correo SE DESVÍA. Desde el 27-08 hace falta además
      // DEV_EMAIL_OVERRIDE_CONFIRMAR, para que una variable olvidada no tumbe la
      // recuperación de contraseña de un cliente.
      desviaElCorreo:    hay('DEV_EMAIL_OVERRIDE') && ['si','sí','yes','1','true']
                           .includes(String(process.env.DEV_EMAIL_OVERRIDE_CONFIRMAR||'').trim().toLowerCase()),
      resendConfigurado: hay('RESEND_API_KEY'),
    },
    // V12/T3: sin clave, el relay responde sin firmar y las versiones que la exijan no
    // podran validar. Es lo primero que hay que mirar si un cliente dice que su licencia
    // ha dejado de valer despues de actualizar.
    firma: {
      puedeFirmar: require('../firma').puedeFirmar(),
      remitente: process.env.SMTP_FROM || '(por defecto: PodoSystem <info@podosystem.es>)',
    },
    // Solo los NOMBRES, nunca los valores. Sirve para encontrar una variable que la interfaz
    // de Railway no enseña — que es exactamente lo que pasó el 27-08.
    variables: Object.keys(process.env)
      .filter(k => !/^(RAILWAY_|npm_|NODE_|PATH$|HOME$|HOSTNAME$|PWD$|SHLVL$|_$|TERM|LANG|LC_)/.test(k))
      .sort(),
    entorno: {
      nodeEnv: process.env.NODE_ENV || '(sin definir)',
      // Para saber qué código corre de verdad, sin fiarse de lo que uno cree haber desplegado.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || '(desconocido)',
      rama:   process.env.RAILWAY_GIT_BRANCH || '(desconocida)',
      desplegadoEn: process.env.RAILWAY_DEPLOYMENT_ID ? 'railway' : '(local u otro)',
    },
  });
});

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
  const { clienteNombre, clienteEmail, notas, plan } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre y clienteEmail son obligatorios' });
  }
  // Pieza 5.0 — validar plan (whitelist) con default 'clinica'
  const PLANES_VALIDOS = ['basico', 'clinica', 'red'];
  const planFinal = PLANES_VALIDOS.includes(plan) ? plan : 'clinica';
  const id         = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, notas, estado, plan)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(id, licenseKey, clienteNombre.trim(), clienteEmail.trim(), notas || '', planFinal);

  res.status(201).json({ ok: true, id, licenseKey, plan: planFinal });
});

router.put('/api/licencias/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  const campos  = ['clienteNombre','clienteEmail','clinicaId','hardwareId','instanceId',
                   'estado','activadaEn','ultimaValidacion','proximaRenovacion','notas',
                   'fuente','suscripcionId','max_podologos','plan_extra','plan'];
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

// Test/preview del email de bienvenida (Pieza 8.6) con datos mock. Auth admin.
// Base para 8.6.z (reenviar email). await sendMail para reportar OK/error.
router.post('/api/test-email-bienvenida', authAdmin, async (req, res) => {
  const to   = String(req.body?.to || '').trim();
  const plan = ['basico','clinica','red'].includes(req.body?.plan) ? req.body.plan : 'clinica';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ ok: false, error: 'Email destino invalido' });
  }
  try {
    const { buildEmailLicencia } = require('./webhooks-stripe');
    const { sendMail } = require('../email');
    const licenseKey = genLicenseKey();
    await sendMail({
      to,
      subject: 'Bienvenido a PodoSystem — Tu clave de licencia',
      html: buildEmailLicencia({ nombre: 'Francisco Prueba', plan, licenseKey }),
    });
    res.json({ ok: true, to, plan, licenseKey });
  } catch (e) {
    console.error('[test-email-bienvenida] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Quién está probando el producto, y cuántos acaban comprando.
 *
 * La conversión se calcula cruzando `trials.email` con `licencias.clienteEmail`. Funciona
 * sin tocar el flujo de compra, pero **si alguien prueba con un correo y compra con otro, no
 * se cuenta**: la cifra es un SUELO, no un dato exacto. Se devuelve `convertidos` junto al
 * total para que quien la lea sepa sobre qué se calcula.
 */
router.get('/api/trials', authAdmin, (req, res) => {
  const trials = req.db.prepare('SELECT * FROM trials ORDER BY creadaEn DESC').all();

  const correosConLicencia = new Set(
    req.db.prepare("SELECT LOWER(TRIM(clienteEmail)) AS e FROM licencias WHERE clienteEmail IS NOT NULL")
      .all().map(r => r.e)
  );

  const conEstado = trials.map(t => {
    const convertido = correosConLicencia.has(String(t.email || '').toLowerCase().trim());
    const dias = Math.floor((Date.now() - new Date(t.creadaEn).getTime()) / 86400000);
    return { ...t, convertido, diasDesdeDescarga: dias };
  });

  const convertidos = conEstado.filter(t => t.convertido).length;

  // ── T5: los equipos que de verdad están probando el programa ──────────────
  //
  // Descargar y probar no es lo mismo. Uno se descarga el EXE y no lo abre nunca; otro lo
  // pasa a tres compañeros. Hasta ahora solo se veía la descarga, que es la mitad de la
  // historia y la menos interesante: lo que dice si el producto gusta es cuántos equipos
  // lo tienen abierto y cuántos días llevan.
  //
  // Y hay una señal comercial que solo se ve aquí: **si hay más instalaciones que
  // descargas registradas, el EXE está circulando de mano en mano**. Eso no es
  // necesariamente malo —puede ser el mejor canal que tienes— pero conviene saberlo.
  const ahora = Date.now();
  const instalaciones = req.db.prepare(`
    SELECT i.hardwareId, i.inicio, i.fin, i.dias, i.version, i.vistas,
           i.primeraVista, i.ultimaVista, i.trialId,
           t.nombre AS personaNombre, t.email AS personaEmail
      FROM trial_instalaciones i
      LEFT JOIN trials t ON t.id = i.trialId
     ORDER BY i.fin DESC
  `).all().map(i => {
    const restantes = Math.max(0, Math.ceil((new Date(i.fin).getTime() - ahora) / 86400000));
    return {
      // La huella completa no aporta nada EN PANTALLA y es un identificador de máquina: se
      // enseña un trozo, suficiente para distinguir filas y hablar de una en concreto. La
      // completa va aparte porque los botones de ajustar y borrar la necesitan, y este
      // endpoint ya exige el token de administración.
      id:           String(i.hardwareId),
      huella:       String(i.hardwareId).slice(0, 8),
      inicio:       i.inicio,
      fin:          i.fin,
      dias:         i.dias,
      diasRestantes: restantes,
      activo:       restantes > 0,
      version:      i.version,
      vistas:       i.vistas,
      ultimaVista:  i.ultimaVista,
      // Orientativo: se enlazó por IP y fecha cercanas, no es una identificación.
      persona:      i.personaNombre ? { nombre: i.personaNombre, email: i.personaEmail } : null,
    };
  });

  const activos = instalaciones.filter(i => i.activo).length;

  res.json({
    ok: true,
    trials: conEstado,
    instalaciones,
    stats: {
      total: trials.length,
      convertidos,
      // Sin trials no hay porcentaje: devolver 0 haria pensar que nadie convierte.
      porcentaje: trials.length ? Math.round((convertidos / trials.length) * 100) : null,
      ultimos30: conEstado.filter(t => t.diasDesdeDescarga <= 30).length,
      instalaciones:        instalaciones.length,
      instalacionesActivas: activos,
      // Más equipos que descargas = el instalador circula de mano en mano.
      masEquiposQueDescargas: instalaciones.length > trials.length,
    },
  });
});

// ── Ajustar el trial de un equipo ───────────────────────────────────────────
//
// Nace para poder PROBAR que el trial del servidor funciona: con un trial recién empezado,
// borrar `trial.dat` y volver a abrir dice «60 días» las dos veces, así que no se distingue
// el sistema funcionando del sistema roto. Poniéndole 5 días desde aquí, la prueba se ve en
// la propia pantalla del programa y no admite interpretación.
//
// Pero no es solo para eso, y por eso se queda:
//
//   · Un podólogo que está a punto de decidirse y pide una semana más.
//   · Alguien que cambia de placa o reinstala Windows y pierde su periodo de prueba: su
//     huella cambia y el relay lo ve como un equipo distinto, con lo que en realidad NO
//     pierde nada — pero si lo que quiere es empezar limpio, se borra su fila.
//   · Y limpiar las filas de las pruebas, para que el panel diga la verdad.
//
// ⚠️ Con el token de administración se puede regalar tiempo. Es lo esperado: es el panel del
// dueño del producto. Lo que NO puede hacer nadie es hacerlo desde el PC del cliente, que
// era el problema.
const ES_HUELLA_ADMIN = /^[0-9a-f]{32}$/;

router.put('/api/trial-instalaciones/:huella', authAdmin, (req, res) => {
  const huella = String(req.params.huella || '').toLowerCase();
  if (!ES_HUELLA_ADMIN.test(huella)) return res.status(400).json({ ok: false, error: 'huella no válida' });

  const dias = Number(req.body?.dias);
  if (!Number.isFinite(dias) || dias < 0 || dias > 3650) {
    return res.status(400).json({ ok: false, error: 'dias debe ser un número entre 0 y 3650' });
  }

  const fila = req.db.prepare('SELECT hardwareId, fin FROM trial_instalaciones WHERE hardwareId = ?').get(huella);
  if (!fila) return res.status(404).json({ ok: false, error: 'ese equipo no tiene trial registrado' });

  const fin = new Date(Date.now() + dias * 86400000).toISOString();
  const nota = `fin ajustado a ${dias} días el ${new Date().toISOString().slice(0, 10)} (antes: ${fila.fin})`;
  req.db.prepare('UPDATE trial_instalaciones SET fin = ?, notas_admin = ? WHERE hardwareId = ?')
    .run(fin, nota, huella);

  res.json({ ok: true, huella: huella.slice(0, 8), fin, dias });
});

router.delete('/api/trial-instalaciones/:huella', authAdmin, (req, res) => {
  const huella = String(req.params.huella || '').toLowerCase();
  if (!ES_HUELLA_ADMIN.test(huella)) return res.status(400).json({ ok: false, error: 'huella no válida' });
  const r = req.db.prepare('DELETE FROM trial_instalaciones WHERE hardwareId = ?').run(huella);
  // Borrada la fila, ese equipo vuelve a ser desconocido y estrenará 60 días al preguntar.
  res.json({ ok: true, borrados: r.changes });
});

router.delete('/api/trials/:id', authAdmin, (req, res) => {
  // Derecho de supresión: si alguien pide que se borren sus datos, hay que poder hacerlo.
  //
  // Se sueltan también los enlaces desde `trial_instalaciones`. La fila de la instalación
  // NO se borra —es la que impide reiniciar el trial borrando un fichero, y sin ella el
  // equipo estrenaría otros 60 días— pero se queda sin nada que apunte a una persona:
  // una huella de máquina suelta no identifica a nadie. Borrar los datos personales no
  // puede convertirse, de rebote, en una forma de recuperar el periodo de prueba.
  const r = req.db.transaction((id) => {
    req.db.prepare('UPDATE trial_instalaciones SET trialId = NULL, ip = NULL WHERE trialId = ?').run(id);
    return req.db.prepare('DELETE FROM trials WHERE id = ?').run(id);
  })(req.params.id);
  res.json({ ok: true, borrados: r.changes });
});

router.get('/api/clinicas', authAdmin, (req, res) => {
  const clinicas = req.db.prepare('SELECT id, nombre, webUrl, netlifyId, createdAt, activa, activation_code, activation_code_used FROM clinicas ORDER BY createdAt DESC').all();
  res.json({ ok: true, clinicas });
});

router.put('/api/clinicas/:id/weburl', authAdmin, (req, res) => {
  const { id } = req.params;
  const clinica = req.db.prepare('SELECT id FROM clinicas WHERE id = ?').get(id);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  req.db.prepare('UPDATE clinicas SET webUrl = ? WHERE id = ?').run(req.body.webUrl?.trim() || null, id);
  res.json({ ok: true });
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
  const { clienteNombre, clienteEmail, clinicaNombre, clinicaTelefono = '', clinicaCiudad = '', clinicaDireccion = '', clinicaLogoUrl = '', plan } = req.body;
  if (!clienteNombre?.trim() || !clienteEmail?.trim() || !clinicaNombre?.trim()) {
    return res.status(400).json({ ok: false, error: 'clienteNombre, clienteEmail y clinicaNombre son obligatorios' });
  }
  // Pieza 5.0 — validar plan (whitelist) con default 'clinica'
  const PLANES_VALIDOS = ['basico', 'clinica', 'red'];
  const planFinal = PLANES_VALIDOS.includes(plan) ? plan : 'clinica';

  // 1. Crear licencia
  const licId      = genId(12);
  const licenseKey = genLicenseKey();
  req.db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado, plan)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(licId, licenseKey, clienteNombre.trim(), clienteEmail.trim(), planFinal);

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

// ── Redeploy de site Netlify existente ───────────────────────────────────────

router.post('/api/clinicas/:id/redeploy', authAdmin, async (req, res) => {
  const { id } = req.params;
  const clinica = req.db.prepare('SELECT id, nombre, netlifyId, webUrl FROM clinicas WHERE id = ?').get(id);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  if (!clinica.netlifyId) {
    return res.status(400).json({
      ok: false,
      error: 'Esta clínica no tiene sitio Netlify asociado. Créalo primero con el flujo de aprobación.',
    });
  }
  if (!process.env.NETLIFY_TOKEN) {
    return res.status(503).json({ ok: false, error: 'NETLIFY_TOKEN no configurado en Railway' });
  }

  // Recuperar ciudad/teléfono de la solicitud de alta original si existe
  const alta = req.db.prepare(
    'SELECT ciudad, telefono FROM solicitudes_alta WHERE clinicaId = ? ORDER BY creadaEn DESC LIMIT 1'
  ).get(id);

  try {
    await redeployClientSite({
      clinicaId:  id,
      nombre:     clinica.nombre,
      ciudad:     alta?.ciudad   || '',
      telefono:   alta?.telefono || '',
      netlifyId:  clinica.netlifyId,
    });
    console.log(`[admin:redeploy] OK → ${clinica.webUrl}`);
    res.json({ ok: true, webUrl: clinica.webUrl });
  } catch (e) {
    console.error('[admin:redeploy]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Deploy inicial manual desde admin panel ──────────────────────────────────
// Crea el sitio Netlify por primera vez para una clínica que aún no tiene web.
// Si faltan datos esenciales (telefono, ciudad) devuelve 422 con missing[] para
// que el panel pida completarlos y reintente.

router.post('/api/clinicas/:id/deploy-web', authAdmin, async (req, res) => {
  const { id } = req.params;
  const clinica = req.db.prepare(
    'SELECT id, nombre, webUrl, telefono, ciudad, direccion FROM clinicas WHERE id = ?'
  ).get(id);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  if (clinica.webUrl) {
    return res.status(409).json({ ok: false, message: 'Esta clínica ya tiene web activada', webUrl: clinica.webUrl });
  }
  if (!process.env.NETLIFY_TOKEN) {
    return res.status(503).json({ ok: false, error: 'NETLIFY_TOKEN no configurado en Railway' });
  }

  // Validar campos requeridos para un deploy decente. Sin ellos la web queda con defaults feos.
  const missing = [];
  if (!clinica.telefono?.trim()) missing.push('telefono');
  if (!clinica.ciudad?.trim())   missing.push('ciudad');
  if (missing.length > 0) {
    return res.status(422).json({
      ok: false,
      missing,
      message: 'Faltan datos para crear la web. Edita la clínica primero.',
    });
  }

  try {
    const result = await deployClientSite({
      clinicaId: id,
      nombre:    clinica.nombre,
      ciudad:    clinica.ciudad    || '',
      direccion: clinica.direccion || '',
      telefono:  clinica.telefono  || '',
    });
    req.db.prepare('UPDATE clinicas SET webUrl=?, netlifyId=? WHERE id=?')
      .run(result.webUrl, result.netlifyId, id);
    console.log(`[admin:deploy-web] OK → ${result.webUrl}`);
    res.json({ ok: true, webUrl: result.webUrl });
  } catch (e) {
    console.error('[admin:deploy-web]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Edición datos de contacto de la clínica ──────────────────────────────────
// Usado por el modal "campos faltantes" del admin panel y para edición libre.
// Solo actualiza campos enviados en el body (PATCH-like).

router.put('/api/clinicas/:id/datos', authAdmin, (req, res) => {
  const { id } = req.params;
  const clinica = req.db.prepare('SELECT id FROM clinicas WHERE id = ?').get(id);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  const editables = ['nombre', 'telefono', 'ciudad', 'provincia', 'direccion', 'email', 'profesional'];
  const sets = [];
  const vals = [];
  for (const k of editables) {
    if (k in req.body) {
      sets.push(`${k} = ?`);
      vals.push(req.body[k]?.trim?.() || req.body[k] || null);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ ok: false, error: 'Nada que actualizar' });
  }
  vals.push(id);
  req.db.prepare(`UPDATE clinicas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  console.log(`[admin:datos] Clínica ${id} actualizada (${sets.length} campos)`);
  res.json({ ok: true });
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
        INSERT INTO clinicas (id, nombre, apiKey, activation_code, activation_code_used, activa,
                              telefono, ciudad, provincia, email, profesional)
        VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)
      `).run(
        clinicaId,
        sol.nombre_clinica.trim(),
        apiKey,
        activationCode,
        sol.telefono    || null,
        sol.ciudad      || null,
        sol.provincia   || null,
        sol.email       || null,
        sol.profesional || null,
      );

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

  // Responde al admin inmediatamente — clínica ya creada en BD
  res.json({ ok: true, clinica: { id: clinicaId, activation_code: activationCode } });

  // Background: solo email al cliente. La web pública es un paso opcional
  // posterior — el cliente la activa desde su PodoSystem (o el admin desde el panel).
  (async () => {
    console.log('[admin:aprobar] Background iniciado — enviando email');
    try {
      const { sendMail } = require('../email');
      await sendMail({
        to:      sol.email,
        subject: `Tu código de activación PodoSystem — ${sol.nombre_clinica}`,
        html:    buildEmailCliente({ sol, activationCode, webUrl: null }),
      });
      console.log('[admin:aprobar] Email enviado a', sol.email);
    } catch (e) {
      console.error('[admin:aprobar] Email error:', e.message);
    }
  })().catch(e => console.error('[admin:aprobar] Error inesperado en background:', e.message));
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

function buildEmailCliente({ sol, activationCode, webUrl }) {
  // webUrl se conserva en la firma por compatibilidad; en el flujo nuevo llega siempre null
  // (la web pública se activa en un paso posterior, no en el momento de aprobar).
  const seccionWeb = webUrl
    ? `<div style="margin:0 0 24px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.08em">🌐 Tu web de citas</p>
        <a href="${esc(webUrl)}" style="color:#16a34a;font-size:.95rem;word-break:break-all">${esc(webUrl)}</a>
        <p style="margin:6px 0 0;font-size:.82rem;color:#4ade80">Compártela con tus pacientes por WhatsApp, Instagram o tu web.</p>
      </div>`
    : '';
  return `
<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0f2137;padding:28px 40px">
    <p style="margin:0;font-size:20px;font-weight:800;color:#fff">Podo<span style="color:#2ecc9a">System</span></p>
    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.5)">Sincronización PC + Móvil activada</p>
  </div>
  <div style="padding:32px 40px">
    <p style="margin:0 0 16px;color:#1a2a3a">Hola <strong>${esc(sol.profesional)}</strong>,</p>
    <p style="margin:0 0 20px;color:#1a2a3a;line-height:1.6">Tu cuenta de PodoSystem para <strong>${esc(sol.nombre_clinica)}</strong> está activa. Ya puedes sincronizar la agenda entre el PC de tu clínica y la app móvil de tu equipo. Introduce este código en PodoSystem para conectar el servicio:</p>
    ${seccionWeb}
    <div style="background:#f0f6ff;border:2px solid #2ecc9a;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#1E3A5F;text-transform:uppercase;letter-spacing:.1em">Código de activación</p>
      <p style="margin:0;font-family:monospace;font-size:28px;font-weight:800;letter-spacing:.15em;color:#0f2137">${esc(activationCode)}</p>
    </div>
    <p style="margin:0 0 24px;font-size:.9rem;color:#5a7080">En PodoSystem ve a: <strong>Citas Online → Activación → introduce el código → Activar</strong></p>

    <div style="margin:24px 0 0;padding:18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1e40af">🌐 ¿Quieres que tus pacientes reserven citas online?</p>
      <p style="margin:0;font-size:.88rem;color:#1e3a8a;line-height:1.6">La web pública es un paso opcional. Cuando estés listo, abre PodoSystem y ve a <strong>Citas Online → Activación → Activar mi web pública</strong>. Tarda menos de un minuto y te da una URL única para compartir con tus pacientes.</p>
    </div>

    <p style="margin:24px 0 0;font-size:.85rem;color:#aaa">¿Dudas? Escríbenos a <a href="mailto:info@podosystem.es" style="color:#2ecc9a">info@podosystem.es</a></p>
  </div>
</div>`;
}

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

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
