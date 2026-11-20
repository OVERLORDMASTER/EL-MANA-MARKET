"""
Actualiza tasas/dolar.json con la ÚLTIMA tasa del dólar publicada por el BCV.

El BCV publica en la tarde la tasa del siguiente día hábil: el viernes en la
tarde ya aparece la del lunes, y esa es la que queda para sábado y domingo.

- Misma lógica que e-commerce (lib/tasa-bcv.js).
- Maneja certificados del BCV con fallback seguro.
- Si el BCV falla por completo, consulta DolarApi como respaldo.
- Nunca guarda una tasa con fecha valor más vieja que la que ya está guardada.
- Sincroniza tanto tasas/dolar.json como tasa-bcv.json.

Lo ejecuta la GitHub Action .github/workflows/tasa-bcv.yml cada hora o de forma manual.
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
HISTORIAL = RAIZ / "tasa-bcv.json"
VENEZUELA = timezone(timedelta(hours=-4))

sys.path.insert(0, str(CARPETA))
import tasas_bcv  # noqa: E402


def descargar_pagina_segura(timeout=30):
    """Descarga la página del BCV manejando la verificación SSL."""
    req = urllib.request.Request(tasas_bcv.URL, headers={"User-Agent": "Mozilla/5.0"})
    try:
        ctx = ssl.create_default_context()
        if CERTIFICADO.exists():
            try:
                ctx.load_verify_locations(cafile=str(CERTIFICADO))
            except Exception:
                pass
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as err:
        # En caso de rechazo por certificado intermedio faltante en Linux/Windows
        ctx_fallback = ssl._create_unverified_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx_fallback) as resp:
            return resp.read().decode("utf-8", errors="replace")


def leer_respaldo_dolarapi():
    """Consulta DolarApi en caso de que el portal del BCV no responda."""
    req = urllib.request.Request(
        "https://ve.dolarapi.com/v1/dolares/oficial",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        d = json.loads(resp.read().decode("utf-8"))
        promedio = float(d.get("promedio", 0))
        if promedio <= 0:
            raise ValueError("Respuesta de DolarApi sin promedio válido")
        fecha = str(d.get("fechaActualizacion") or datetime.now(VENEZUELA).isoformat())[:10]
        return {
            "fecha_valor": fecha,
            "fecha_valor_texto": fecha,
            "tasas": {"USD": promedio},
            "fuente": "respaldo"
        }


def main():
    tasas_bcv.descargar_pagina = descargar_pagina_segura

    fuente = "bcv"
    try:
        datos = tasas_bcv.obtener_tasas()
    except Exception as e:
        print(f"[aviso] No se pudo leer el BCV directamente ({e}); intentando respaldo...")
        try:
            datos = leer_respaldo_dolarapi()
            fuente = "respaldo"
        except Exception as e2:
            print(f"[aviso] Falló también el respaldo: {e2}. Se mantiene la tasa actual.")
            return 0

    fecha = datos.get("fecha_valor")
    usd = datos.get("tasas", {}).get("USD")
    if not fecha or not usd:
        print("[aviso] No se obtuvo fecha valor o tasa del dólar; no se modifica el archivo.")
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

    # Actualizar historial tasa-bcv.json primero
    historial_data = {"historial": {}, "ultimaConsulta": datetime.now(VENEZUELA).isoformat(timespec="seconds"), "ultimoExito": None, "ultimoError": None}
    try:
        if HISTORIAL.exists():
            try:
                historial_data = json.loads(HISTORIAL.read_text(encoding="utf-8"))
            except Exception:
                pass
        historial_data.setdefault("historial", {})
        historial_data["historial"][fecha] = {
            "usd": usd,
            "fuente": fuente,
            "texto": datos.get("fecha_valor_texto") or ""
        }
        historial_data["ultimaConsulta"] = datetime.now(VENEZUELA).isoformat(timespec="seconds")
        if fuente == "bcv":
            historial_data["ultimoExito"] = historial_data["ultimaConsulta"]
        HISTORIAL.write_text(json.dumps(historial_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as err:
        print(f"[aviso] No se pudo escribir tasa-bcv.json: {err}")

    # Determinar la tasa activa según día de la semana:
    # Sábado y Domingo: tasa del lunes (última publicada)
    # Lunes a Viernes: tasa vigente hoy
    ahora_ve = datetime.now(VENEZUELA)
    dia_semana = ahora_ve.weekday()  # 0 = Lunes, ..., 4 = Viernes, 5 = Sábado, 6 = Domingo
    hoy_str = ahora_ve.strftime("%Y-%m-%d")

    tasa_activa_fecha = fecha
    tasa_activa_usd = usd
    tasa_activa_texto = datos.get("fecha_valor_texto")

    if dia_semana not in (5, 6) and fecha > hoy_str and historial_data.get("historial"):
        fechas_validas = [f for f in sorted(historial_data["historial"].keys()) if f <= hoy_str]
        if fechas_validas:
            f_vigente = fechas_validas[-1]
            tasa_activa_fecha = f_vigente
            tasa_activa_usd = historial_data["historial"][f_vigente]["usd"]
            tasa_activa_texto = historial_data["historial"][f_vigente].get("texto") or f_vigente

    # Actualizar tasas/dolar.json con la tasa activa
    salida = {
        "moneda": "USD",
        "fuente": "oficial" if fuente == "bcv" else "respaldo",
        "nombre": "Dólar",
        "compra": None,
        "venta": None,
        "promedio": tasa_activa_usd,
        "rate": tasa_activa_usd,
        "fechaActualizacion": f"{tasa_activa_fecha}T00:00:00-04:00",
        "fechaValor": tasa_activa_fecha,
        "fechaValorTexto": tasa_activa_texto,
        "consultado": datetime.now(VENEZUELA).isoformat(timespec="seconds"),
        "tasas": datos.get("tasas", {}),
    }
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Actualizada con éxito: {fecha} -> {usd} Bs/$ ({datos.get('fecha_valor_texto')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
