/**
 * test_salud_licencias.js — que el panel avise de los clientes en apuros.
 *
 * ── Por que ──────────────────────────────────────────────────────────────────
 *
 * El 29-08-2026, mirando la tabla de licencias por otra cosa, aparecieron dos clientes en
 * situaciones que nadie habia avisado: uno llevaba 47 dias sin validar y otro tenia la
 * licencia emitida y nunca la habia activado. Con dos clientes eso se ve de un vistazo. Con
 * veinte, no.
 *
 * ── Lo que hay que fijar ─────────────────────────────────────────────────────
 *
 *   · Los plazos tienen que ser los MISMOS que aplica el PC. Si aqui se dice que un cliente
 *     esta bien cuando su programa lleva dias bloqueado, el panel miente — y eso es peor que
 *     no tener panel.
 *   · Una licencia emitida y nunca usada se ve. Es una venta a medias.
 *   · Y el mensaje dice lo que le pasa AL CLIENTE, no que falte un campo: es lo unico que
 *     sirve para decidir a quien llamar.
 *
 * Uso:  node scripts/test_salud_licencias.js
 */
'use strict';

const { saludLicencia, resumen, INTERVALO_DIAS, GRACIA_DIAS, LIMITE_DIAS } =
  require('../src/lib/salud_licencias');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const AHORA = new Date('2026-08-29T12:00:00.000Z').getTime();
const haceDias = (d) => new Date(AHORA - d * 86400000).toISOString();
const lic = (extra = {}) => ({
  estado: 'active', plan: 'clinica',
  createdAt: haceDias(200), activadaEn: haceDias(180),
  ultimaValidacion: haceDias(1), version_instalada: '3.7.1',
  ...extra,
});
const salud = (l, ultimaVersion) => saludLicencia(l, { ahora: AHORA, ultimaVersion });

console.log('\n🧪 Salud de las licencias\n');

console.log('── Los plazos, que tienen que cuadrar con el PC ──');
ok(INTERVALO_DIAS === 7, 'el intervalo de revalidacion son 7 dias');
ok(GRACIA_DIAS === 7, 'la gracia son 7 dias');
ok(LIMITE_DIAS === 14, 'y el limite antes de bloquearse, 14', String(LIMITE_DIAS));

console.log('\n── Al dia ──');
{
  const s = salud(lic(), '3.7.1');
  ok(s.nivel === 'ok', 'una licencia validada ayer no molesta', s.nivel + ' / ' + s.mensaje);
  ok(s.estado === 'al_dia', 'y su estado es al_dia');
}

console.log('\n── El caso que aparecio de casualidad ──');
{
  // 47 dias sin validar: su programa lleva mas de un mes en solo lectura, o no lo abre.
  const s = salud(lic({ ultimaValidacion: haceDias(47) }));
  ok(s.nivel === 'alerta', 'a los 47 dias sin validar, alerta', s.nivel);
  ok(s.estado === 'caducada', 'estado caducada');
  ok(/solo lectura/.test(s.mensaje), 'y el mensaje dice lo que le pasa al CLIENTE', s.mensaje);
  ok(s.diasSinValidar === 47, 'con los dias exactos', String(s.diasSinValidar));
}

console.log('\n── Las fronteras, que es donde estas cosas fallan ──');
{
  ok(salud(lic({ ultimaValidacion: haceDias(7) })).nivel === 'ok',
    'a los 7 dias justos todavia no hay nada que decir');
  ok(salud(lic({ ultimaValidacion: haceDias(8) })).nivel === 'aviso',
    'a los 8 empieza el periodo de gracia');
  ok(salud(lic({ ultimaValidacion: haceDias(14) })).nivel === 'aviso',
    'a los 14 justos AUN funciona: no hay que alarmar antes de tiempo');
  ok(salud(lic({ ultimaValidacion: haceDias(15) })).nivel === 'alerta',
    'a los 15 ya esta bloqueado y hay que llamar');
}

console.log('\n── Cuanto le queda, dicho de forma util ──');
{
  const s = salud(lic({ ultimaValidacion: haceDias(10) }));
  ok(/quedan 4/.test(s.mensaje), 'dice cuantos dias le quedan antes de bloquearse', s.mensaje);
}

console.log('\n── La licencia que se emitio y nunca se uso ──');
{
  const s = salud(lic({ activadaEn: null, ultimaValidacion: null, createdAt: haceDias(60) }));
  ok(s.estado === 'sin_activar', 'se detecta que nunca se activo', s.estado);
  ok(s.nivel === 'alerta', 'y a los 60 dias eso es una alerta: es una venta a medias', s.nivel);
  ok(/60 d[ií]as/.test(s.mensaje), 'diciendo desde cuando', s.mensaje);

  const reciente = salud(lic({ activadaEn: null, ultimaValidacion: null, createdAt: haceDias(3) }));
  ok(reciente.nivel === 'aviso',
    'pero recien emitida es solo un aviso — puede que aun no le haya dado tiempo', reciente.nivel);
}

console.log('\n── Bloqueada a mano desde el panel ──');
{
  const s = salud(lic({ estado: 'blocked' }));
  ok(s.estado === 'bloqueada' && s.nivel === 'alerta', 'se ve como alerta, no como si estuviera bien');
}

console.log('\n── La version ──');
{
  const s = salud(lic({ version_instalada: '3.5.0' }), '3.7.1');
  ok(s.estado === 'version_vieja', 'un cliente atascado en una version vieja se ve', s.estado);
  ok(s.nivel === 'aviso', 'como aviso, no como alerta: funciona, solo esta atrasado');
  ok(/3\.5\.0/.test(s.mensaje) && /3\.7\.1/.test(s.mensaje), 'diciendo cual usa y cual hay', s.mensaje);

  const sinDato = salud(lic({ version_instalada: null }), '3.7.1');
  ok(sinDato.estado === 'version_desconocida', 'y el que no dice su version tambien');

  // Sin saber cual es la ultima, no se puede opinar de versiones. No se inventa.
  const sinReferencia = salud(lic({ version_instalada: '3.5.0' }), null);
  ok(sinReferencia.nivel === 'ok',
    'si GitHub no contesta, no se marca a nadie por la version', sinReferencia.estado);
}

console.log('\n── Lo importante mandaria sobre lo accesorio ──');
{
  // Un cliente bloqueado Y con version vieja: lo que hay que ver es que esta bloqueado.
  const s = salud(lic({ ultimaValidacion: haceDias(30), version_instalada: '3.5.0' }), '3.7.1');
  ok(s.estado === 'caducada', 'estar bloqueado pesa mas que estar desactualizado', s.estado);
}

console.log('\n── El resumen de arriba ──');
{
  const r = resumen([
    lic(),
    lic({ ultimaValidacion: haceDias(47) }),
    lic({ ultimaValidacion: haceDias(10) }),
    lic({ activadaEn: null, ultimaValidacion: null, createdAt: haceDias(60) }),
  ], { ahora: AHORA });
  ok(r.total === 4, 'cuenta todas');
  ok(r.alerta === 2, 'dos en alerta', String(r.alerta));
  ok(r.aviso === 1, 'una en aviso', String(r.aviso));
  ok(r.ok === 1, 'y una al dia', String(r.ok));
}

console.log('\n── Datos raros no rompen el panel ──');
{
  ok(salud({ estado: 'active' }).nivel === 'aviso', 'una licencia sin ninguna fecha no revienta');
  ok(salud(lic({ ultimaValidacion: 'no es una fecha' })).estado === 'sin_datos',
    'ni una fecha con basura');
  ok(resumen([]).total === 0, 'ni una lista vacia');
}

console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
process.exit(fallados === 0 ? 0 : 1);
