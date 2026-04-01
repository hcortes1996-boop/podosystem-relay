/**
 * auth.js — Middleware de autenticación por API Key
 * Lee X-Api-Key del header, valida en la tabla clinicas,
 * e inyecta req.clinicaId para los handlers siguientes.
 */

module.exports = function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ ok: false, error: 'Falta cabecera X-Api-Key' });
  }

  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE apiKey = ? AND activa = 1')
    .get(key);

  if (!clinica) {
    return res.status(403).json({ ok: false, error: 'ApiKey inválida o clínica desactivada' });
  }

  req.clinicaId = clinica.id;
  next();
};
