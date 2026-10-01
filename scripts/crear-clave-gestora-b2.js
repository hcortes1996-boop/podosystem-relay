#!/usr/bin/env node
/**
 * crear-clave-gestora-b2.js — Crea la clave con la que el relay da una clave a cada clínica.
 *
 * Se ejecuta UNA vez, en local, con la clave MAESTRA de Backblaze (la única que puede crear claves
 * con permiso de crear claves). La maestra se lee del entorno, nunca de argv:
 *
 *   source C:/ClinicApp_Proyecto/setup-tokens.sh   # con B2_MASTER_KEY_ID y B2_MASTER_APP_KEY
 *   node scripts/crear-clave-gestora-b2.js
 *
 * Qué hace:
 *   1. Busca el bucket de las copias de las clínicas y dice su id (no es secreto).
 *   2. Crea la clave gestora: puede crear, listar y borrar claves, y nada más.
 *   3. COMPRUEBA que sirve: con ella crea una clave de clínica de prueba limitada a
 *      `prueba-gestor/`, y la borra. Si Backblaze exigiera que la gestora tenga también los
 *      permisos de ficheros, aquí se ve, y no el día que una clínica pida la suya.
 *   4. Guarda la gestora en C:\ClinicApp_Proyecto\clave_gestora_b2.txt (fuera de todo repo).
 *      En pantalla, solo longitudes.
 *
 * Después: pegar en Railway RELAY_B2_GESTOR_KEY_ID, RELAY_B2_GESTOR_APP_KEY y COPIAS_BUCKET_ID,
 * y QUITAR la maestra de setup-tokens.sh.
 */
'use strict';
const fs = require('fs');

const BUCKET = process.env.COPIAS_BUCKET_NOMBRE || 'podosystem-backups-2026';
const SALIDA = 'C:/ClinicApp_Proyecto/clave_gestora_b2.txt';

async function autorizar(keyId, appKey) {
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
    { headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${appKey}`).toString('base64') } });
  if (!r.ok) throw new Error('Backblaze no autoriza la clave (' + r.status + ')');
  const a = await r.json();
  const apiUrl = a.apiInfo.storageApi.apiUrl;
  const api = async (op, cuerpo) => {
    const res = await fetch(`${apiUrl}/b2api/v3/${op}`, { method: 'POST', headers: { Authorization: a.authorizationToken }, body: JSON.stringify(cuerpo) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${op}: ${res.status} ${j.message || ''}`);
    return j;
  };
  return { api, accountId: a.accountId };
}

(async () => {
  const mk = process.env.B2_MASTER_KEY_ID, ma = process.env.B2_MASTER_APP_KEY;
  if (!mk || !ma) { console.log('❌ Falta B2_MASTER_KEY_ID / B2_MASTER_APP_KEY en el entorno (setup-tokens.sh).'); process.exit(1); }
  const maestra = await autorizar(mk, ma);
  const { buckets } = await maestra.api('b2_list_buckets', { accountId: maestra.accountId, bucketName: BUCKET });
  if (!buckets || !buckets.length) throw new Error('No se encuentra el bucket ' + BUCKET);
  const bucketId = buckets[0].bucketId;
  console.log(`✅ Bucket ${BUCKET}: COPIAS_BUCKET_ID = ${bucketId}`);

  // Si ya existe (una pasada anterior que falló en la comprobación), se reutiliza: no se crea otra.
  let g;
  if (fs.existsSync(SALIDA)) {
    const t = fs.readFileSync(SALIDA, 'utf8');
    g = { applicationKeyId: (t.match(/RELAY_B2_GESTOR_KEY_ID=(.+)/) || [])[1], applicationKey: (t.match(/RELAY_B2_GESTOR_APP_KEY=(.+)/) || [])[1] };
    console.log('↻ Se reutiliza la gestora ya guardada en ' + SALIDA);
  } else {
  g = await maestra.api('b2_create_key', {
    accountId: maestra.accountId,
    capabilities: ['listKeys', 'writeKeys', 'deleteKeys'],
    keyName: 'relay-gestor-claves-copias',
  });
  fs.writeFileSync(SALIDA, `RELAY_B2_GESTOR_KEY_ID=${g.applicationKeyId}\nRELAY_B2_GESTOR_APP_KEY=${g.applicationKey}\nCOPIAS_BUCKET_ID=${bucketId}\n`, { mode: 0o600 });
  console.log(`✅ Clave gestora creada y guardada en ${SALIDA} (keyId ${g.applicationKeyId.length} caracteres, clave ${g.applicationKey.length})`);
  }

  // ── Comprobar que la gestora sirve para lo que se quiere ──
  const gestora = await autorizar(g.applicationKeyId, g.applicationKey);
  try {
    const prueba = await gestora.api('b2_create_key', {
      accountId: gestora.accountId,
      capabilities: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles'],
      keyName: 'prueba-gestor', bucketId, namePrefix: 'prueba-gestor/',
    });
    await gestora.api('b2_delete_key', { applicationKeyId: prueba.applicationKeyId });
    console.log('✅ La gestora crea una clave de clínica limitada a su carpeta, y la borra. Todo listo.');
  } catch (e) {
    console.log('❌ La gestora NO puede crear claves de clínica: ' + e.message);
    console.log('   Hay que darle también los permisos de ficheros. Avisa antes de seguir.');
    process.exit(1);
  }
})().catch(e => { console.log('❌ ' + e.message); process.exit(1); });
