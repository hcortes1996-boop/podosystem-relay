/**
 * registro.js — Registro de nuevas clínicas
 *
 *   POST /api/registro-clinica  — crea una clínica, devuelve clinicaId + apiKey
 *   Protegido por REGISTRO_SECRET (variable de entorno)
 */

const crypto       = require('crypto');
const router       = require('express').Router();
const { genId, genApiKey } = require('../db');

router.post('/registro-clinica', (req, res) => {
  const { nombre, registroSecret } = req.body;

  // Verificar el secreto de registro. En tiempo constante, como el panel (01-10-2026): con `!==`
  // el tiempo de respuesta delata cuántos caracteres iniciales acierta quien prueba. Y con un
  // mínimo de longitud: un secreto corto o vacío en el servidor deja la puerta cerrada.
  const secretEsperado = process.env.REGISTRO_SECRET || '';
  const dado = typeof registroSecret === 'string' ? registroSecret : '';
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  if (secretEsperado.length < 16 || !dado || !crypto.timingSafeEqual(hash(dado), hash(secretEsperado))) {
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
