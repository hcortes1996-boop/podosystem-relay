'use strict';
/**
 * horario-web.js — El horario REAL de la clínica, para la franja de horario de su página de citas.
 *
 * 04-10-2026: la plantilla decía «Lunes — Viernes 9:00 — 14:00 · 16:00 — 19:30 · Sábados cerrado»
 * para TODAS las clínicas. Francisco lo vio en la de Merino, que atiende de 9:30 a 12:30 y de 17:00
 * a 19:15: la página le decía a sus pacientes otra cosa. Ahora sale de `agenda_config.horario`, que
 * es el que configura cada clínica en PodoSystem y el mismo con el que se calculan los huecos.
 *
 * El horario llega como `{ "0".."6": [{inicio:"09:30", fin:"13:00"}, …] }` (0 = domingo, igual que
 * `Date.getDay()`). Los días con las mismas franjas se agrupan: «Lunes — Viernes» si son seguidos,
 * «Lunes, Miércoles» si no.
 */

const NOMBRES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ORDEN = [1, 2, 3, 4, 5, 6, 0];   // la semana empieza en lunes

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hora = (h) => String(h || '').replace(/^0(\d):/, '$1:');   // «09:30» → «9:30», como la plantilla

function franjasDe(horario, d) {
  const f = (horario && horario[String(d)]) || [];
  return Array.isArray(f) ? f.filter(x => x && x.inicio && x.fin) : [];
}

/** Grupos de días con las mismas franjas, en orden de la semana: [{ dias:[1,2,3], franjas }] */
function agrupar(horario) {
  const grupos = [];
  for (const d of ORDEN) {
    const franjas = franjasDe(horario, d);
    if (!franjas.length) continue;
    const clave = franjas.map(f => `${f.inicio}-${f.fin}`).join('|');
    const g = grupos.find(x => x.clave === clave);
    if (g) g.dias.push(d); else grupos.push({ clave, dias: [d], franjas });
  }
  return grupos;
}

/** «Lunes — Miércoles, Viernes»: los tramos de 3 o más días seguidos se abrevian. */
function nombreDias(dias) {
  const pos = dias.map(d => ORDEN.indexOf(d)).sort((a, b) => a - b);
  const tramos = [];
  for (const p of pos) {
    const t = tramos[tramos.length - 1];
    if (t && p === t[t.length - 1] + 1) t.push(p); else tramos.push([p]);
  }
  return tramos.map(t => t.length >= 3
    ? `${NOMBRES[ORDEN[t[0]]]} — ${NOMBRES[ORDEN[t[t.length - 1]]]}`
    : t.map(p => NOMBRES[ORDEN[p]]).join(', ')).join(', ');
}

/** Los bloques de la franja de horario, con el mismo marcado que tenía la plantilla. */
function horarioHtml(horario) {
  const grupos = agrupar(horario);
  const item = (dia, tiempo, i, estiloTiempo = '') =>
    `<div class="horario-item fade-up"${i ? ` style="transition-delay:.${i}s"` : ''}>\n` +
    `          <div class="horario-item__day">${esc(dia)}</div>\n` +
    `          <div class="horario-item__time"${estiloTiempo}>${tiempo}</div>\n` +
    `        </div>`;
  const piezas = [];
  if (!grupos.length) {
    // Sin horario configurado: mejor no inventarlo. La rejilla de abajo ya dice qué días hay hueco.
    piezas.push(item('Horario', 'Consulte los huecos libres', 0, ' style="font-size:1.1rem"'));
  } else {
    grupos.forEach((g, i) => {
      const tiempo = g.franjas.map(f => `${esc(hora(f.inicio))} — ${esc(hora(f.fin))}`).join('<br>');
      piezas.push(item(nombreDias(g.dias), tiempo, i));
    });
    const cerrados = ORDEN.filter(d => !franjasDe(horario, d).length);
    if (cerrados.length && cerrados.length < 7) {
      piezas.push(item(nombreDias(cerrados), 'Cerrado', grupos.length, ' style="color:var(--muted);font-size:1.1rem"'));
    }
  }
  return piezas.join('\n        <div class="horario-divider"></div>\n        ');
}

module.exports = { horarioHtml, agrupar, nombreDias };
