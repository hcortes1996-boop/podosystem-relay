/**
 * lib/recordatorios.js — Pieza 6.0 WhatsApp Cloud
 *
 * Logica pura testeable:
 *   - calcularRecordatorios(citas, config, hoy): port literal de
 *     main.js:2653 generarRecordatoriosPendientes() pero como funcion pura.
 *   - enviarPushNotification(token, msg): cliente HTTPS a Expo Push API.
 */
'use strict';

const https = require('https');

/**
 * Calcula las citas que toca recordar HOY para una clinica.
 *
 * @param {Array}  citas   — todas las citas en agenda_snapshot (con paciente y telefono).
 * @param {object} config  — recordatorios_config: { diasAntelacion, recordarMismoDia, reglaViernes }.
 * @param {Date}   hoy     — fecha referencia (param. para tests deterministas).
 * @returns {Array} subset de citas filtradas (las que tocan recordar).
 */
function calcularRecordatorios(citas, config, hoy) {
  if (!Array.isArray(citas)) return [];
  const cfg = config || {};
  const diasAntelacion   = cfg.diasAntelacion ?? 1;
  const recordarMismoDia = cfg.recordarMismoDia !== false && cfg.recordarMismoDia !== 0;
  const reglaViernes     = cfg.reglaViernes !== false && cfg.reglaViernes !== 0;

  const yyyymmdd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const dmyyyy   = (d) => `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
  const diaSemana = hoy.getDay(); // 0=Dom..6=Sab

  const fechasACubrir = new Set();
  for (let i = 1; i <= diasAntelacion; i++) {
    const d = new Date(hoy); d.setDate(d.getDate() + i);
    fechasACubrir.add(yyyymmdd(d));
    fechasACubrir.add(ddmmyyyy(d));
    fechasACubrir.add(dmyyyy(d));
  }
  if (recordarMismoDia) {
    fechasACubrir.add(yyyymmdd(hoy));
    fechasACubrir.add(ddmmyyyy(hoy));
    fechasACubrir.add(dmyyyy(hoy));
  }
  // Viernes → cubrir lunes si no hay citas el sabado
  if (reglaViernes && diaSemana === 5) {
    const sabado = new Date(hoy); sabado.setDate(sabado.getDate() + 1);
    const sabadoStr = yyyymmdd(sabado);
    const hayCitasSabado = citas.some(c => c.fecha === sabadoStr);
    if (!hayCitasSabado) {
      const lunes = new Date(hoy); lunes.setDate(lunes.getDate() + 3);
      fechasACubrir.add(yyyymmdd(lunes));
      fechasACubrir.add(ddmmyyyy(lunes));
      fechasACubrir.add(dmyyyy(lunes));
    }
  }
  // Sabado → cubrir lunes
  if (reglaViernes && diaSemana === 6) {
    const lunes = new Date(hoy); lunes.setDate(lunes.getDate() + 2);
    fechasACubrir.add(yyyymmdd(lunes));
    fechasACubrir.add(ddmmyyyy(lunes));
    fechasACubrir.add(dmyyyy(lunes));
  }

  return citas
    .filter(c => c && c.fecha && fechasACubrir.has(c.fecha))
    .filter(c => c.telefono && String(c.telefono).trim());
}

/**
 * Envia push notification via Expo Push API.
 *
 * @param {string|Array<string>} tokens — Expo Push Token(s) ExponentPushToken[xxx].
 * @param {object} payload — { title, body, data }.
 * @returns {Promise<{ok:boolean, statusCode?:number, response?:any, error?:string}>}
 */
function enviarPushNotification(tokens, payload) {
  return new Promise((resolve) => {
    const arrTokens = Array.isArray(tokens) ? tokens : [tokens];
    if (!arrTokens.length) return resolve({ ok: true, response: { data: [] } });
    // Expo permite hasta 100 destinatarios por request.
    const body = arrTokens.map(t => ({
      to: t,
      title: payload.title || 'PodoSystem',
      body:  payload.body  || '',
      data:  payload.data  || {},
      sound: 'default',
      priority: 'high',
    }));
    const json = JSON.stringify(body.length === 1 ? body[0] : body);
    const req = https.request({
      hostname: 'exp.host',
      path: '/--/api/v2/push/send',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, response: parsed });
        } catch (e) {
          resolve({ ok: false, statusCode: res.statusCode, error: 'parse error: ' + e.message });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(json);
    req.end();
  });
}

module.exports = { calcularRecordatorios, enviarPushNotification };
