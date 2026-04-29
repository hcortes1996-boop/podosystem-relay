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

// CORS abierto — necesario para el widget embebido en cualquier dominio
app.use(cors());
app.use(express.json());

// Inicializar base de datos y adjuntarla a cada request
const db = initDB();
app.use((req, _res, next) => {
  req.db = db;
  next();
});

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
});
