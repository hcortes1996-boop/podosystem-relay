/**
 * test_reasignar_equipo.js — Reasignar una licencia a otro ordenador, sin llamar a nadie.
 *
 *   POST /api/recuperacion/reasignar/solicitar
 *   POST /api/recuperacion/reasignar/confirmar
 *
 * ── Qué hay que fijar aquí ───────────────────────────────────────────────────
 *
 * Este endpoint mueve una licencia de un equipo a otro. Es exactamente lo que la comprobación
 * de `hardware_mismatch` existe para impedir, así que lo único que lo separa de ser un agujero
 * es el segundo factor. Lo que se prueba, por tanto, no es que funcione —eso es lo fácil— sino
 * que **no se pueda saltar**:
 *
 *   · el código lo genera el RELAY y va SOLO al correo registrado de la licencia. Quien pide
 *     no elige destinatario, que es justo lo que sí hace `enviar-codigo` y por lo que ese
 *     mecanismo no valdría aquí;
 *   · sin código correcto no se mueve nada;
 *   · caduca, tiene intentos contados y es de un solo uso;
 *   · una licencia bloqueada no se reasigna;
 *   · y el código no aparece nunca en la respuesta ni en el registro.
 *
 * Uso:  node scripts/test_reasignar_equipo.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), `relay_reasig_${process.pid}.db`);
const PORT = 3096;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';        // desactiva los límites de peticiones
delete process.env.RESEND_API_KEY;    // sin clave, sendMail avisa y no envía nada

let pasados = 0, fallados = 0;
let db = null;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

require('../src/index.js');

const BASE = `http://127.0.0.1:${PORT}`;
const LICENCIA = 'PODO-TEST-REASIG-0001';
const HW_VIEJO = 'huella-del-pc-muerto-0001';
const HW_NUEVO = 'huella-del-pc-nuevo-0002';

const pedir = (ruta, body) => fetch(`${BASE}/api/recuperacion/reasignar/${ruta}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

process.on('uncaughtException', (e) => {
  fallados++;
  console.log('  💥 excepción no capturada: ' + e.message);
  cerrar();
});

(async () => {
 try {
  await new Promise(r => setTimeout(r, 900));

  db = require('better-sqlite3')(TMP);
  const sembrar = () => {
    db.prepare('DELETE FROM licencias WHERE licenseKey = ?').run(LICENCIA);
    db.prepare('DELETE FROM reasignaciones').run();
    db.prepare(`INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, hardwareId, estado)
                VALUES ('lic_reasig', ?, 'Cliente de prueba', 'duenyo@ejemplo.test', ?, 'active')`)
      .run(LICENCIA, HW_VIEJO);
  };
  // El código nunca sale por la respuesta: para probar, se lee de la base como lo haría el
  // relay al verificarlo. Es la única forma de comprobar el camino feliz sin imprimirlo.
  const codigoDe = (cod) => {
    const f = db.prepare('SELECT id FROM reasignaciones WHERE usadoEn IS NULL ORDER BY creadoEn DESC LIMIT 1').get();
    return f ? crypto.createHash('sha256').update(f.id + ':' + cod).digest('hex') : null;
  };
  const filaViva = () => db.prepare('SELECT * FROM reasignaciones WHERE usadoEn IS NULL ORDER BY creadoEn DESC LIMIT 1').get();
  const hwActual = () => db.prepare('SELECT hardwareId FROM licencias WHERE licenseKey = ?').get(LICENCIA).hardwareId;
  // Fuerza bruta de 6 dígitos sobre el hash guardado: así la prueba conoce el código sin que
  // el endpoint lo haya revelado nunca. Con 5 intentos reales sería imposible; aquí vale.
  const averiguarCodigo = () => {
    const f = filaViva();
    if (!f) return null;
    for (let i = 0; i < 1000000; i++) {
      const c = String(i).padStart(6, '0');
      if (crypto.createHash('sha256').update(f.id + ':' + c).digest('hex') === f.codigoHash) return c;
    }
    return null;
  };

  sembrar();

  console.log('\n── El problema que esto resuelve ──');
  {
    // Antes de nada: confirmar que sin esto la puerta está cerrada de verdad.
    const r = await fetch(`${BASE}/admin/api/licencias/verificar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: LICENCIA, hardwareId: HW_NUEVO }),
    }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    ok(r.status === 403 && r.body.error === 'hardware_mismatch',
      'un PC nuevo con la misma licencia recibe 403 hardware_mismatch',
      JSON.stringify(r.body));
  }

  console.log('\n── Quién puede pedir un código ──');
  {
    let r = await pedir('solicitar', {});
    ok(r.status === 400, 'sin licenseKey → 400', `status ${r.status}`);

    r = await pedir('solicitar', { licenseKey: 'NO-EXISTE-ESTA-CLAVE' });
    ok(r.status === 404, 'licencia inexistente → 404', `status ${r.status}`);

    db.prepare("UPDATE licencias SET estado='blocked' WHERE licenseKey=?").run(LICENCIA);
    r = await pedir('solicitar', { licenseKey: LICENCIA });
    ok(r.status === 403, 'licencia bloqueada → 403, no se reasigna', `status ${r.status}`);
    db.prepare("UPDATE licencias SET estado='active' WHERE licenseKey=?").run(LICENCIA);
  }

  console.log('\n── El destinatario NO lo elige quien pide ──');
  {
    // Es la diferencia con `enviar-codigo`, y la que hace que esto sea un segundo factor.
    //
    // ⚠️ Hay que mirar A DÓNDE SE MANDA, no solo qué responde. La primera versión de esta
    // prueba solo comprobaba que el correo del atacante no saliera en la respuesta — y un
    // sabotaje que cambiaba `to:` por el email del solicitante **pasaba en verde**. Se
    // descubrió saboteando, que para eso está.
    //
    // Sin RESEND_API_KEY, `src/email.js:82` escribe el destinatario en un aviso. Es el único
    // sitio donde se puede observar sin montar un servidor de correo, y basta.
    const capturado = [];
    const warnOriginal = console.warn;
    console.warn = (...a) => { capturado.push(a.join(' ')); warnOriginal(...a); };

    const r = await pedir('solicitar', { licenseKey: LICENCIA, email: 'ladron@ejemplo.test' });
    await new Promise(res => setTimeout(res, 50));
    console.warn = warnOriginal;

    const enviado = capturado.filter(l => l.includes('[email]')).join(' | ');
    ok(r.status === 200, 'la solicitud se acepta', JSON.stringify(r.body));
    ok(enviado.includes('duenyo@ejemplo.test'),
      'el correo sale al buzón REGISTRADO en la licencia', enviado || '(no se capturó envío)');
    ok(!enviado.includes('ladron@ejemplo.test'),
      'y NUNCA al que pide el solicitante',
      'si se aceptara, cualquiera con la licencia robada se aprobaría a sí mismo');
    ok(!/\b\d{6}\b/.test(enviado.replace(/duenyo@ejemplo\.test/g, '')),
      'y el código tampoco se escribe en el registro');
    ok(!/ladron/.test(JSON.stringify(r.body)),
      'ni se le devuelve en la respuesta',
      'si se aceptara, cualquiera con la licencia se aprobaría a sí mismo');
    ok(/@ejemplo\.test$/.test(r.body.enviadoA || ''),
      'se responde con una pista del correo registrado, no con el pedido', r.body.enviadoA);
    ok(!/duenyo/.test(r.body.enviadoA || ''),
      'y la pista no revela el buzón entero', r.body.enviadoA);
    ok(!/\d{6}/.test(JSON.stringify(r.body)), 'el código NO viaja en la respuesta');
  }

  console.log('\n── Sin el código correcto no se mueve nada ──');
  {
    const antes = hwActual();
    let r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: '000000', hardwareId: HW_NUEVO });
    ok(r.status === 401, 'código equivocado → 401', `status ${r.status}`);
    ok(hwActual() === antes, 'y la licencia sigue en el equipo de antes');
    ok(typeof r.body.intentosRestantes === 'number', 'y se dice cuántos intentos quedan', JSON.stringify(r.body));

    r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: '12345', hardwareId: HW_NUEVO });
    ok(r.status === 400, 'un código de 5 dígitos ni se mira');

    r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: '123456', hardwareId: 'corto' });
    ok(r.status === 400, 'sin un hardwareId creíble tampoco');
  }

  console.log('\n── Los intentos están contados ──');
  {
    for (let i = 0; i < 4; i++) {
      await pedir('confirmar', { licenseKey: LICENCIA, codigo: '000001', hardwareId: HW_NUEVO });
    }
    const r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: '000002', hardwareId: HW_NUEVO });
    ok(r.status === 429, 'al sexto intento el código muere → 429', `status ${r.status}`);
    ok(hwActual() === HW_VIEJO, 'y la licencia no se ha movido');
  }

  console.log('\n── Caducidad ──');
  {
    await pedir('solicitar', { licenseKey: LICENCIA });
    const f = filaViva();
    db.prepare('UPDATE reasignaciones SET expiraEn = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), f.id);
    const cod = averiguarCodigo();
    const r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: cod, hardwareId: HW_NUEVO });
    ok(r.status === 410, 'un código caducado no vale ni siendo el correcto', `status ${r.status}`);
    ok(hwActual() === HW_VIEJO, 'y la licencia sigue donde estaba');
  }

  console.log('\n── El camino feliz: el cliente se recupera solo ──');
  {
    await pedir('solicitar', { licenseKey: LICENCIA });
    const cod = averiguarCodigo();
    ok(!!cod && /^\d{6}$/.test(cod), 'el relay ha generado un código de 6 dígitos');

    const r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: cod, hardwareId: HW_NUEVO });
    ok(r.status === 200 && r.body.ok, 'con el código bueno, la licencia se reasigna', JSON.stringify(r.body));
    ok(hwActual() === HW_NUEVO, 'la licencia apunta ya al ordenador nuevo');

    // Y lo que de verdad importaba: que el PC nuevo pueda validar.
    const v = await fetch(`${BASE}/admin/api/licencias/verificar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: LICENCIA, hardwareId: HW_NUEVO }),
    }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    ok(v.status === 200 && v.body.ok, 'y el PC nuevo YA VALIDA su licencia', JSON.stringify(v.body));

    // Y el viejo deja de valer, que es lo que impide duplicar licencias.
    const w = await fetch(`${BASE}/admin/api/licencias/verificar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: LICENCIA, hardwareId: HW_VIEJO }),
    }).then(async x => ({ status: x.status }));
    ok(w.status === 403, 'y el equipo anterior deja de estar autorizado');
  }

  console.log('\n── Un solo uso ──');
  {
    const usado = db.prepare('SELECT * FROM reasignaciones WHERE usadoEn IS NOT NULL ORDER BY usadoEn DESC LIMIT 1').get();
    ok(!!usado && !!usado.usadoEn, 'el código queda marcado como usado');
    ok(usado.hardwareAntes === HW_VIEJO && usado.hardwareNuevo === HW_NUEVO,
      'y queda registrado de qué equipo a cuál, que es la pista si alguien reclama');

    const r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: '000000', hardwareId: 'otro-equipo-mas-0003' });
    ok(r.status === 410, 'y no queda ningún código pendiente que reutilizar', `status ${r.status}`);
  }

  console.log('\n── Pedir otro código invalida el anterior ──');
  {
    sembrar();
    await pedir('solicitar', { licenseKey: LICENCIA });
    const primero = averiguarCodigo();
    await pedir('solicitar', { licenseKey: LICENCIA });
    const segundo = averiguarCodigo();
    ok(primero !== segundo, 'el segundo código es distinto del primero');

    const r = await pedir('confirmar', { licenseKey: LICENCIA, codigo: primero, hardwareId: HW_NUEVO });
    ok(r.status === 401, 'y el primero ya no sirve', `status ${r.status}`);
    ok(db.prepare('SELECT COUNT(*) c FROM reasignaciones WHERE usadoEn IS NULL').get().c === 1,
      'solo queda un código vivo, no dos');
  }

  } catch (e) {
    fallados++;
    console.log('  💥 la prueba ha reventado: ' + e.message);
  }
  cerrar();
})();

/**
 * ⚠️ El resumen se imprime SIEMPRE, aunque la prueba reviente a mitad.
 *
 * Saboteando las defensas el 04-09-2026, tres de los seis sabotajes no imprimían nada: la
 * prueba moría antes del resumen. Y «sin salida» es indistinguible de «pasó» cuando lo lees
 * en una tanda de seis. Así es como una red de seguridad se vuelve decorativa sin que nadie
 * lo note — el mismo patrón que llevamos toda la semana persiguiendo, pero en las pruebas.
 */
function cerrar() {
  try { if (db) db.close(); } catch (_) {}
  try { fs.rmSync(TMP, { force: true }); } catch (_) {}
  try { fs.rmSync(TMP + '-wal', { force: true }); fs.rmSync(TMP + '-shm', { force: true }); } catch (_) {}

  console.log(`\n${fallados ? '❌' : '✅'} ${pasados} en verde, ${fallados} en rojo\n`);
  process.exit(fallados ? 1 : 0);
}
