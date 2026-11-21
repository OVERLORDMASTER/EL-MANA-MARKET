"""Actualiza los archivos de tasa de Maná Market desde el BCV."""

import json
import math
import ssl
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import tasas_bcv

CARPETA = Path(__file__).resolve().parent
RAIZ = CARPETA.parent
CERTIFICADO = CARPETA / "sectigo-dv-r36.pem"
SALIDA = RAIZ / "tasas" / "dolar.json"
HISTORIAL = RAIZ / "tasa-bcv.json"
VENEZUELA = timezone(timedelta(hours=-4))


def descargar_pagina_segura(timeout=30):
    req = urllib.request.Request(tasas_bcv.URL, headers={"User-Agent": "Mozilla/5.0"})
    ctx = ssl.create_default_context()
    if CERTIFICADO.exists():
        ctx.load_verify_locations(cafile=str(CERTIFICADO))
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fecha_valida(fecha):
    try:
        return date.fromisoformat(fecha).isoformat() == fecha
    except (TypeError, ValueError):
        return False


def tasa_valida(usd):
    return type(usd) in (int, float) and math.isfinite(usd) and usd > 0


def cargar_historial():
    try:
        estado = json.loads(HISTORIAL.read_text(encoding="utf-8"))
        estado["historial"] = {
            fecha: tasa for fecha, tasa in estado["historial"].items()
            if fecha_valida(fecha) and isinstance(tasa, dict)
            and tasa.get("fuente") == "bcv" and tasa_valida(tasa.get("usd"))
        }
        return estado
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {"historial": {}, "ultimoExito": None}


def guardar_json(archivo, datos):
    archivo.parent.mkdir(parents=True, exist_ok=True)
    temporal = archivo.with_suffix(".json.tmp")
    temporal.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporal.replace(archivo)


def main():
    tasas_bcv.descargar_pagina = descargar_pagina_segura
    ahora = datetime.now(VENEZUELA)
    consultado = ahora.isoformat(timespec="seconds")
    estado = cargar_historial()
    historial = estado["historial"]
    estado.update(ultimaConsulta=consultado, ultimoError=None)

    try:
        datos = tasas_bcv.obtener_tasas()
        fecha = datos["fecha_valor"]
        usd = datos["tasas"].get("USD")
        if not fecha_valida(fecha) or not tasa_valida(usd):
            raise ValueError("No se obtuvo una fecha valor y una tasa USD válidas")
        historial[fecha] = {"usd": usd, "fuente": "bcv", "texto": datos["fecha_valor_texto"] or ""}
        estado["ultimoExito"] = consultado
        for vieja in sorted(historial)[:-90]:
            del historial[vieja]
    except Exception as error:
        estado["ultimoError"] = f"BCV: {error}"
        print(f"[aviso] {estado['ultimoError']}", file=sys.stderr)

    if not historial:
        return 1

    hoy = ahora.date().isoformat()
    fechas_vigentes = [fecha for fecha in historial if fecha <= hoy]
    fecha = max(fechas_vigentes if ahora.weekday() < 5 and fechas_vigentes else historial)
    tasa = historial[fecha]
    usd = tasa["usd"]
    guardar_json(HISTORIAL, estado)
    guardar_json(SALIDA, {
        "moneda": "USD",
        "fuente": "oficial",
        "nombre": "Dólar",
        "compra": None,
        "venta": None,
        "promedio": usd,
        "rate": usd,
        "fechaActualizacion": f"{fecha}T00:00:00-04:00",
        "fechaValor": fecha,
        "fechaValorTexto": tasa["texto"],
        "consultado": consultado,
        "tasas": {"USD": usd},
    })
    print(f"Tasa oficial activa: {fecha} -> {usd} Bs/$")
    return 0


if __name__ == "__main__":
    sys.exit(main())
