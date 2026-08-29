/**
 * test_motivos.js — motivos de consulta con duracion propia.
 *
 * ── Lo que hay en juego ──────────────────────────────────────────────────────
 *
 * Hasta ahora «libre» era una propiedad del hueco. Con motivos pasa a depender del servicio:
 * las 11:00 estan LIBRES para una quiropodia de 20 min y OCUPADAS para un estudio de 40.
 *
 * Eso toca justo la aritmetica que produjo **5 dobles citas reales** en agosto de 2026. Por
 * eso esta bateria no se limita a comprobar que el catalogo se lee: comprueba la aritmetica
 * de la rejilla con duraciones distintas, que es donde se rompe.
 *
 * ── La regla que no se relaja ────────────────────────────────────────────────
 *
 * La duracion la decide el SERVIDOR. El cliente manda que motivo, nunca cuantos minutos. Si
 * viniera del navegador, una peticion trucada reservaria 5 minutos y se colaria entre dos
 * citas.
 *
 * Uso:  node scripts/test_motivos.js
 */
'use strict';

const M = require('../src/lib/motivos');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const CFG = {
  duracionSlot: 30,
  motivos: [
    { id: 'consulta', nombre: 'Consulta / Quiropodia', minutos: 20, activo: true },
    { id: 'estudio',  nombre: 'Estudio',               minutos: 40, activo: true },
    { id: 'otro',     nombre: 'Otro / No lo sé',       minutos: null, activo: true },
    { id: 'retirado', nombre: 'Ya no se ofrece',       minutos: 15, activo: false },
  ],
};

console.log('\n🧪 Motivos de consulta\n');

console.log('── La duracion la decide el servidor ──');
ok(M.duracionDeMotivo(CFG, 'consulta') === 20, 'una quiropodia dura 20');
ok(M.duracionDeMotivo(CFG, 'estudio') === 40, 'un estudio dura 40');
ok(M.duracionDeMotivo(CFG, 'otro') === 30, '«no lo sé» toma la duración por defecto de la clínica');
ok(M.duracionDeMotivo(CFG, null) === 30, 'sin motivo, la de siempre — retrocompatible');

console.log('\n── Lo que manda el cliente NO puede cambiar los minutos ──');
ok(M.duracionDeMotivo(CFG, 'inventado') === 30, 'un motivo desconocido cae a la de por defecto');
ok(M.duracionDeMotivo(CFG, 'retirado') === 30, 'uno desactivado tampoco vale');
ok(M.duracionDeMotivo(CFG, { minutos: 5 }) === 30, 'mandar un objeto no cuela');
ok(M.duracionDeMotivo(CFG, '5') === 30, 'mandar un número tampoco');
ok(M.duracionDeMotivo(CFG, '__proto__') === 30, 'ni un nombre de propiedad de JavaScript');
ok(M.duracionDeMotivo(CFG, 'ESTUDIO') === 40, 'pero las mayúsculas no rompen un motivo legítimo');
ok(M.duracionDeMotivo(CFG, '  estudio  ') === 40, 'ni los espacios de sobra');

console.log('\n── Sin catalogo configurado: TODO como antes de esta pieza ──');
// Los de fabrica NO se aplican solos. Si cayeran aqui, una clinica que nunca pidio nada
// veria cambiar su web al regenerarla, y sus estudios pasarian a durar 40 min en vez de su
// rejilla. Cambiarle la web a alguien que no lo ha pedido no vale, por muy razonable que
// sea el valor.
ok(M.duracionDeMotivo({ duracionSlot: 30 }, 'estudio') === 30,
  'una clínica sin motivos NO hereda los de fábrica: todo dura lo de su rejilla');
ok(M.duracionDeMotivo({ duracionSlot: 20 }, 'consulta') === 20, 'con cualquier rejilla');
ok(M.duracionDeMotivo({}, null) === 30, 'la duración por defecto son 30 si no se dice otra cosa');
ok(M.motivosPublicos({}).length === 0,
  'y la web no recibe ningún motivo: se queda con su formulario de siempre');
ok(M.MOTIVOS_FABRICA.length === 9,
  'los de fábrica son los 9 que la web ya enseña hoy, ni uno mas ni uno menos',
  String(M.MOTIVOS_FABRICA.length));
ok(M.MOTIVOS_FABRICA.every(m => m.minutos === null),
  'y todos SIN duracion propia: partir de ellos no le cambia nada a nadie');
ok(M.MOTIVOS_FABRICA.some(m => m.id === 'quiropodia') && M.MOTIVOS_FABRICA.some(m => m.id === 'otro'),
  'con identificadores estables derivados del nombre');

console.log('\n── Los de fabrica SON los que la web ya enseña ──');
{
  // Si alguien añade un motivo al desplegable de la plantilla y no lo pone aquí, una clínica
  // que empiece a configurarlos perdería esa opción sin enterarse. Y al revés: un motivo de
  // fábrica que la web no ofrece nunca llegaría a usarse.
  //
  // Es la misma clase de desincronización que costó las dobles citas de agosto: dos sitios
  // que deben coincidir y que hay que mantener iguales a mano. Aquí al menos avisa.
  const fs = require('fs');
  const ruta = require('path').join(__dirname, '..', 'web-template', 'cita.html');
  if (!fs.existsSync(ruta)) {
    ok(false, 'no se encuentra web-template/cita.html para comparar', ruta);
  } else {
    // Se quitan los bloques de <script> ANTES de buscar: dentro hay una plantilla de
    // JavaScript que construye opciones (`<option value="${m.id}">${m.nombre}</option>`)
    // y no es una opción de verdad. La primera versión de esta prueba la contaba y daba
    // rojo con el código bien.
    const html = fs.readFileSync(ruta, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
    const enLaWeb = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
      .map(m => m[2].trim()).filter(t => t && !/^Seleccione/.test(t));
    const deFabrica = M.MOTIVOS_FABRICA.map(m => m.nombre);
    const faltan = enLaWeb.filter(o => !deFabrica.includes(o));
    const sobran = deFabrica.filter(f => !enLaWeb.includes(f));
    ok(faltan.length === 0, 'ningún motivo de la web falta en los de fábrica', faltan.join(' | '));
    ok(sobran.length === 0, 'ni al revés', sobran.join(' | '));
  }
}

console.log('\n── Lo que se le enseña al paciente ──');
{
  const pub = M.motivosPublicos(CFG);
  ok(pub.length === 3, 'solo los activos', String(pub.length));
  ok(!pub.some(m => m.id === 'retirado'), 'el desactivado no aparece');
  ok(pub.every(m => m.minutos === undefined),
    'y NO se publican los minutos: no le dicen nada al paciente e invitan a probar números');
  ok(pub[0].nombre === 'Consulta / Quiropodia', 'se manda el nombre para enseñar');
}

console.log('\n── El nombre que acaba viendo la clinica en su agenda ──');
ok(M.nombreDeMotivo(CFG, 'estudio') === 'Estudio', 'se resuelve desde el catálogo');
ok(M.nombreDeMotivo(CFG, 'inventado') === null, 'y uno desconocido no inventa nombre');

console.log('\n── Limpiar el catalogo que llega del PC ──');
{
  const sucio = [
    { id: 'ok', nombre: 'Bueno', minutos: 20 },
    { nombre: 'Sin id' },                                  // se le deriva uno
    { id: 'vacio', nombre: '   ' },                        // fuera
    { id: 'negativo', nombre: 'Malo', minutos: -5 },       // fuera
    { id: 'enorme', nombre: 'Malo', minutos: 9999 },       // fuera
    { id: 'ok', nombre: 'Repetido' },                      // fuera, id duplicado
    'esto no es un objeto',
    null,
  ];
  const l = M.normalizarMotivos(sucio);
  ok(l.length === 2, 'se quedan solo los utilizables', JSON.stringify(l.map(x => x.id)));
  ok(l[1].id === 'sin-id', 'a los que no traen id se les deriva del nombre', l[1].id);
  ok(l[0].minutos === 20 && l[1].minutos === null, 'y sin minutos significa «la de la clínica»');
}
ok(M.normalizarMotivos('no es una lista') === null, 'lo que no es una lista se rechaza entero');
ok(M.normalizarMotivos([]) === null, 'una lista vacía también: mejor los de fábrica que ninguno');
ok(M.normalizarMotivos([{ nombre: 'X', minutos: 5 }])[0].minutos === 5, 'el mínimo son 5 minutos');

console.log('\n── LA ARITMETICA: la rejilla con duraciones distintas ──');
{
  // Copia EXACTA de generarSlots/slotLibres de agenda.js. Si allí cambian y aquí no, estas
  // pruebas dejarán de proteger nada — por eso se comprueba abajo que siguen coincidiendo.
  const t2m = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const m2t = m => `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
  const generarSlots = (franjas, paso, duracionCita = paso) => {
    const s = [];
    for (const f of franjas) {
      let cur = t2m(f.inicio); const end = t2m(f.fin);
      while (cur + duracionCita <= end) { s.push(m2t(cur)); cur += paso; }
    }
    return s;
  };
  const slotLibres = (slots, ocupadas, duracion) => slots.filter(slot => {
    const ini = t2m(slot);
    return !ocupadas.some(oc => {
      const oIni = t2m(oc.hora), oFin = oIni + (oc.duracion || duracion);
      return ini < oFin && ini + duracion > oIni;
    });
  });

  const franja = [{ inicio: '09:00', fin: '11:00' }];

  ok(JSON.stringify(generarSlots(franja, 30)) === JSON.stringify(['09:00','09:30','10:00','10:30']),
    'con dos argumentos hace lo de SIEMPRE — los 7 sitios que ya la usan no cambian');

  ok(JSON.stringify(generarSlots(franja, 30, 40)) === JSON.stringify(['09:00','09:30','10:00']),
    'un estudio de 40 en rejilla de 30 no se oferta a las 10:30: no cabría antes de las 11');

  ok(JSON.stringify(generarSlots(franja, 30, 20)) === JSON.stringify(['09:00','09:30','10:00','10:30']),
    'y una quiropodia de 20 sí cabe en las cuatro');

  // Lo que de verdad cambia: el mismo hueco, dos respuestas segun a que vengas.
  const ocupadas = [{ hora: '10:00', duracion: 20 }];
  ok(slotLibres(generarSlots(franja, 30, 20), ocupadas, 20).includes('10:30'),
    'las 10:30 están LIBRES para una quiropodia de 20');
  ok(!slotLibres(generarSlots(franja, 30, 40), ocupadas, 40).includes('10:30'),
    'y NO se ofertan para un estudio de 40 — ni cabe en la franja');
  ok(!slotLibres(generarSlots(franja, 30, 40), ocupadas, 40).includes('09:30'),
    'las 09:30 tampoco: un estudio hasta las 10:10 pisaría la cita de las 10:00');
  ok(slotLibres(generarSlots(franja, 30, 40), ocupadas, 40).includes('09:00'),
    'pero las 09:00 sí: termina justo a las 09:40');

  // Y al reves: una cita larga ya puesta bloquea mas huecos cortos.
  const conEstudio = [{ hora: '09:30', duracion: 40 }];
  const libresCortos = slotLibres(generarSlots(franja, 30, 20), conEstudio, 20);
  ok(!libresCortos.includes('09:30') && !libresCortos.includes('10:00'),
    'un estudio de 09:30 a 10:10 bloquea las 09:30 Y las 10:00 para una quiropodia');
  ok(libresCortos.includes('10:30'), 'y deja libres las 10:30');
}

console.log('\n── Las funciones de agenda.js siguen siendo las mismas ──');
{
  // Si alguien cambia el cuerpo de generarSlots en agenda.js, la copia de arriba deja de
  // representar la realidad y estas pruebas darian un verde falso.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'agenda.js'), 'utf8');
  ok(/function generarSlots\(franjas, paso, duracionCita = paso\)/.test(src),
    'generarSlots acepta paso y duración de la cita por separado');
  ok(/while \(cur \+ duracionCita <= end\)[\s\S]{0,60}cur \+= paso;/.test(src),
    'avanza por el paso y comprueba que cabe la cita', 'el cuerpo ha cambiado: revisar esta prueba');
}

console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
process.exit(fallados === 0 ? 0 : 1);
