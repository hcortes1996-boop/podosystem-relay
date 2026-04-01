/**
 * podosystem-widget.js — Widget embebible de citas online
 *
 * Uso en cualquier web de clínica:
 *
 *   <script
 *     src="https://TU-RELAY.railway.app/widget/podosystem-widget.js"
 *     data-clinica-id="abc1234xyz"
 *     data-relay-url="https://TU-RELAY.railway.app"
 *     data-color="#1a5fa8"
 *     data-lang="es"
 *   ></script>
 *   <div id="podosystem-cita-widget"></div>
 *
 * Sin dependencias externas. CSS scoped bajo .ps-widget para no
 * interferir con los estilos del sitio que lo embebe.
 */

(function () {
  'use strict';

  // ── Leer configuración desde el atributo data-* del propio <script> ──
  const me        = document.currentScript;
  const RELAY_URL = (me?.dataset?.relayUrl  || '').replace(/\/$/, '');
  const CLINICA   = me?.dataset?.clinicaId  || '';
  const COLOR     = me?.dataset?.color      || '#1a5fa8';
  const LANG      = me?.dataset?.lang       || 'es';

  const T = {
    es: {
      titulo:    'Solicitar cita',
      nombre:    'Nombre completo *',
      telefono:  'Teléfono *',
      motivo:    'Motivo de consulta *',
      motivos:   ['-- Seleccione --', 'Primera visita', 'Revisión', 'Quiropodia', 'Uña encarnada', 'Cirugía ungueal', 'Biomecánica / Plantillas', 'Pie diabético', 'Otro'],
      fecha:     'Fecha preferida',
      hora:      'Franja horaria',
      horas:     ['-- Indistinto --', 'Mañana 9-11h', 'Mañana 11-13h', 'Tarde 16-18h', 'Tarde 18-20h'],
      notas:     'Notas adicionales',
      enviar:    'Solicitar cita',
      enviando:  'Enviando…',
      ok:        '¡Solicitud enviada! Le contactaremos para confirmar.',
      error:     'No se pudo enviar. Llame directamente a la clínica.',
      requerido: 'Complete los campos obligatorios (*)'
    }
  };

  const txt = T[LANG] || T['es'];

  // ── Estilos scoped bajo .ps-widget ────────────────────────────────
  const css = `
    .ps-widget { font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #dde0f0; border-radius: 12px; background: #fff; }
    .ps-widget h3 { margin: 0 0 18px; font-size: 1.15rem; color: ${COLOR}; }
    .ps-widget label { display: block; margin-bottom: 4px; font-size: .85rem; font-weight: 600; color: #333; }
    .ps-widget input, .ps-widget select, .ps-widget textarea { width: 100%; padding: 9px 12px; border: 1px solid #ccd; border-radius: 6px; font-size: .95rem; margin-bottom: 14px; box-sizing: border-box; }
    .ps-widget textarea { height: 80px; resize: vertical; }
    .ps-widget button { width: 100%; padding: 12px; background: ${COLOR}; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; }
    .ps-widget button:disabled { opacity: .6; cursor: not-allowed; }
    .ps-widget .ps-ok { color: #1a7a3a; background: #e8f5ed; border-radius: 8px; padding: 14px; text-align: center; font-weight: 600; margin-top: 12px; }
    .ps-widget .ps-err { color: #9b2020; background: #fdeaea; border-radius: 8px; padding: 10px; text-align: center; font-size: .9rem; margin-bottom: 10px; }
  `;

  // ── HTML del formulario ────────────────────────────────────────────
  function buildForm() {
    return `
      <h3>${txt.titulo}</h3>
      <div class="ps-err" id="ps-error" style="display:none"></div>
      <label>${txt.nombre}<input id="ps-nombre" type="text" autocomplete="name"></label>
      <label>${txt.telefono}<input id="ps-telefono" type="tel" autocomplete="tel"></label>
      <label>${txt.motivo}
        <select id="ps-motivo">
          ${txt.motivos.map((m, i) => `<option value="${i === 0 ? '' : m}">${m}</option>`).join('')}
        </select>
      </label>
      <label>${txt.fecha}<input id="ps-fecha" type="date" min="${new Date().toISOString().slice(0,10)}"></label>
      <label>${txt.hora}
        <select id="ps-hora">
          ${txt.horas.map(h => `<option value="${h}">${h}</option>`).join('')}
        </select>
      </label>
      <label>${txt.notas}<textarea id="ps-notas" placeholder="Opcional"></textarea></label>
      <button id="ps-btn">${txt.enviar}</button>
    `;
  }

  // ── Montar en el DOM ───────────────────────────────────────────────
  function mount() {
    const target = document.getElementById('podosystem-cita-widget');
    if (!target) return;

    // Inyectar CSS
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Inyectar formulario
    const wrapper = document.createElement('div');
    wrapper.className = 'ps-widget';
    wrapper.innerHTML = buildForm();
    target.appendChild(wrapper);

    // Evento submit
    document.getElementById('ps-btn').addEventListener('click', async () => {
      const nombre   = document.getElementById('ps-nombre').value.trim();
      const telefono = document.getElementById('ps-telefono').value.trim();
      const motivo   = document.getElementById('ps-motivo').value;
      const errEl    = document.getElementById('ps-error');

      if (!nombre || !telefono || !motivo) {
        errEl.textContent = txt.requerido;
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';

      const btn = document.getElementById('ps-btn');
      btn.disabled    = true;
      btn.textContent = txt.enviando;

      try {
        const res = await fetch(`${RELAY_URL}/api/solicitud-cita`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clinicaId:     CLINICA,
            nombre,
            telefono,
            motivo,
            fechaDeseada:  document.getElementById('ps-fecha').value || null,
            horaDeseada:   document.getElementById('ps-hora').value || null,
            observaciones: document.getElementById('ps-notas').value.trim() || null
          })
        });

        if (!res.ok) throw new Error();

        wrapper.innerHTML = `<div class="ps-ok">${txt.ok}</div>`;
      } catch {
        btn.disabled    = false;
        btn.textContent = txt.enviar;
        errEl.textContent = txt.error;
        errEl.style.display = 'block';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
