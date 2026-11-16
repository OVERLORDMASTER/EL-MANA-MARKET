"""
Actualiza tasas/dolar.json con la ÚLTIMA tasa del dólar publicada por el BCV.

El BCV publica en la tarde la tasa del siguiente día hábil: el viernes en la
tarde ya aparece la del lunes, y esa es la que queda para sábado y domingo.

- Usa tasas_bcv.py (Omega API, en esta misma carpeta) sin modificarlo.
- Agrega el certificado intermedio que la página del BCV no envía
  (sectigo-dv-r36.pem); sin él, en Linux falla la verificación SSL.
- Nunca guarda una tasa con fecha valor más vieja que la que ya está guardada.
- Si el BCV no responde, no toca el archivo (se queda la última tasa buena).

Lo ejecuta la GitHub Action .github/workflows/tasa-bcv.yml cada hora.
Uso manual:  python scripts/actualizar_tasa.py
"""

import json
import ssl
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CARPETA = Path(__file__).resolve().parent
RAIZ = CARPETA.parent
CERTIFICADO = CARPETA / "sectigo-dv-r36.pem"
SALIDA = RAIZ / "tasas" / "dolar.json"
VENEZUELA = timezone(timedelta(hours=-4))

sys.path.insert(0, str(CARPETA))
import tasas_bcv  # noqa: E402  (Omega API, en esta misma carpeta)


def descargar_pagina_segura(timeout=30):
    """Igual que tasas_bcv.descargar_pagina, pero completando la cadena SSL del BCV."""
    ctx = ssl.create_default_context()
    if CERTIFICADO.exists():
        ctx.load_verify_locations(cafile=str(CERTIFICADO))
    req = urllib.request.Request(tasas_bcv.URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.read().decode("utf-8", errors="replace")


def main():
    tasas_bcv.descargar_pagina = descargar_pagina_segura

    try:
        datos = tasas_bcv.obtener_tasas()
    except Exception as e:
        print(f"[aviso] No se pudo leer el BCV, se mantiene la tasa guardada: {e}")
        return 0

    fecha = datos.get("fecha_valor")
    usd = datos.get("tasas", {}).get("USD")
    if not fecha or not usd:
        print("[aviso] El BCV no mostró fecha valor o tasa del dólar; no se cambia nada.")
        return 0

    anterior = None
    if SALIDA.exists():
        try:
            anterior = json.loads(SALIDA.read_text(encoding="utf-8"))
        except Exception:
            anterior = None

    if anterior and str(anterior.get("fechaValor", "")) > fecha:
        print(f"[aviso] El BCV muestra {fecha}, pero ya hay guardada {anterior['fechaValor']}; no se retrocede.")
        return 0

    if anterior and anterior.get("fechaValor") == fecha and anterior.get("promedio") == usd:
        print(f"Sin cambios: {fecha} -> {usd}")
        return 0

    # Mismo formato que ve.dolarapi.com/v1/dolares/oficial (+ campos extra)
    salida = {
        "moneda": "USD",
        "fuente": "oficial",
        "nombre": "Dólar",
        "compra": None,
        "venta": None,
        "promedio": usd,
        "fechaActualizacion": f"{fecha}T00:00:00-04:00",
        "fechaValor": fecha,
        "fechaValorTexto": datos.get("fecha_valor_texto"),
        "consultado": datetime.now(VENEZUELA).isoformat(timespec="seconds"),
        "tasas": datos.get("tasas", {}),
    }
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Actualizada: {fecha} -> {usd} Bs/$")
    return 0


if __name__ == "__main__":
    sys.exit(main())
