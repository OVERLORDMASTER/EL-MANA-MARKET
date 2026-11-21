/**
 * Actualiza la tasa del dólar BCV en mana market.
 * Ejecuta la misma lógica de lib/tasa-bcv.js y actualiza tasas/dolar.json y tasa-bcv.json.
 * 
 * Uso: node scripts/actualizar-tasa.js
 */
const tasaBCV = require('../lib/tasa-bcv');

async function main() {
  try {
    await tasaBCV.actualizar();
    const { tasaActiva: tasa, ultimoError } = tasaBCV.salud();
    if (tasa && !ultimoError) {
      console.log(`[ok] Tasa actualizada: ${tasa.usd} Bs./$ (${tasa.fechaValor}) - ${tasa.texto || ''}`);
      process.exit(0);
    } else {
      console.warn('[aviso] No se obtuvo una lectura directa del BCV');
      process.exit(1);
    }
  } catch (err) {
    console.error('[error] Falló la actualización:', err.message);
    process.exit(1);
  }
}

main();
