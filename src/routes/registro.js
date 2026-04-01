/**
 * registro.js — Registro de nuevas clínicas
 *
 *   POST /api/registro-clinica  — crea una clínica, devuelve clinicaId + apiKey
 *   Protegido por REGISTRO_SECRET (variable de entorno)
 */

const router       = require('express').Router();
const { genId, genApiKey } = require('../db');

router.post('/registro-clinica', (req, res) => {
  const { nombre, registroSecret } = req.body;

  // Verificar el secreto de registro
  const secretEsperado = process.env.REGISTRO_SECRET;
  if (!secretEsperado || registroSecret !== secretEsperado) {
    return res.status(403).json({ ok: false, error: 'Secreto de registro incorrecto' });
  }

  if (!nombre?.trim()) {
    return res.status(400).json({ ok: false, error: 'Campo requerido: nombre' });
  }

  const id     = genId(10);
  const apiKey = genApiKey();

  req.db.prepare(`
    INSERT INTO clinicas (id, nombre, apiKey) VALUES (?, ?, ?)
  `).run(id, nombre.trim(), apiKey);

  res.status(201).json({
    ok: true,
    clinicaId: id,
    apiKey,
    mensaje: 'Clínica registrada. Guarde estas credenciales — el apiKey no se puede recuperar.'
  });
});

module.exports = router;
