/**
 * index.js — Servidor relay PodoSystem Citas Online
 *
 * Arquitectura: Express + SQLite (better-sqlite3)
 * Conecta formularios web de clínicas con PodoSystem (app de escritorio).
 *
 * Desplegable en Railway o Render (free tier).
 * Ver .env.example para configuración.
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { initDB } = require('./db');

const app = express();

// Trust proxy (Railway / Render) — necesario para rate-limit y logs de IP correctos
app.set('trust proxy', 1);

// CORS abierto — necesario para el widget embebido en cualquier dominio
app.use(cors());

// Inicializar base de datos y adjuntarla a cada request.
// IMPORTANTE: va ANTES de montar los webhooks — sus handlers usan req.db.
// Si no está disponible, req.db es undefined -> db.prepare() casca fuera del
// try/catch en un handler async -> el proceso no responde -> Railway 502 en Stripe.
const db = initDB();
app.use((req, _res, next) => {
  req.db = db;
  next();
});

// Webhooks (LemonSqueezy + Stripe) — montados ANTES de express.json() para preservar el raw body.
// express.raw() deja req.body como Buffer, necesario para verificar HMAC-SHA256 (LS) y Stripe.constructEvent.
// Pieza 8.2: webhooks-stripe paralelo a LemonSqueezy (que queda como fallback historico).
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use('/api/webhooks', require('./routes/webhooks'));         // /api/webhooks/lemonsqueezy
app.use('/api/webhooks', require('./routes/webhooks-stripe'));  // /api/webhooks/stripe

app.use(express.json());

// Ruta raíz informativa
app.get('/', (_req, res) => {
  res.json({
    service: 'PodoSystem Relay — Citas Online',
    version: '1.0.0',
    endpoints: {
      ping:             'GET  /api/ping',
      solicitudCita:    'POST /api/solicitud-cita',
      registroClinica:  'POST /api/registro-clinica',
      solicitudes:      'GET  /api/solicitudes  (X-Api-Key requerida)',
      gestionar:        'PUT  /api/solicitudes/:id/gestionar  (X-Api-Key requerida)',
      bloqueoWeb:       'PUT  /api/bloqueo-web  (X-Api-Key requerida)',
      disponibilidad:   'GET  /api/disponibilidad/:clinicaId  (público)',
      widget:           'GET  /widget/podosystem-widget.js',
      admin:            'GET  /admin  (ADMIN_TOKEN requerido)'
    }
  });
});

// API pública
app.use('/api', require('./routes/public'));
app.use('/api', require('./routes/registro'));
app.use('/api', require('./routes/clinica'));
app.use('/api', require('./routes/bloqueos'));
app.use('/api', require('./routes/agenda'));
app.use('/api', require('./routes/alta'));
// Pieza 6.0 — WhatsApp Cloud (recordatorios push notification a APK)
app.use('/api', require('./routes/recordatorios'));
// Pieza 8.3 — Stripe Checkout Sessions (POST /api/checkout/create-session)
app.use('/api/checkout', require('./routes/checkout'));

// Panel de administración — montado en /admin para claridad de rutas
app.use('/admin', require('./routes/admin'));

// Widget embebible como archivo estático
app.use('/widget', express.static('widget'));

// 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[relay-error]', err);
  res.status(500).json({ ok: false, error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`[podosystem-relay] Escuchando en puerto ${PORT}`);
  console.log(`[podosystem-relay] Base de datos: ${process.env.DB_PATH || './relay.db'}`);
  console.log(`[podosystem-relay] ADMIN_TOKEN cargado: ${process.env.ADMIN_TOKEN ? 'SI' : 'NO (usando default)'}`);
  console.log(`[podosystem-relay] REGISTRO_SECRET cargado: "${process.env.REGISTRO_SECRET || '(no definido)'}"`);
  // Pieza 6.0 — cron recordatorios cloud (push notifications)
  try {
    const { iniciarCronRecordatorios } = require('./lib/cron-recordatorios');
    iniciarCronRecordatorios(db);
  } catch (e) {
    console.error('[cron-recordatorios] no se pudo arrancar:', e.message);
  }
});
