"""
Lee las tasas de cambio oficiales publicadas en la página del BCV (www.bcv.org.ve).

Uso:
    python tasas_bcv.py          -> muestra una tabla
    python tasas_bcv.py --json   -> imprime JSON (para usar desde otros programas)

Desde otro script de Python:
    from tasas_bcv import obtener_tasas
    datos = obtener_tasas()
    print(datos["tasas"]["USD"], datos["fecha_valor"])

Nota: el BCV suele publicar en la tarde la tasa del siguiente día hábil, así que
un viernes en la tarde ya aparece la tasa del lunes ("Fecha Valor").

Solo usa la biblioteca estándar de Python (no hay que instalar nada).
"""

import json
import re
import sys
import urllib.request
from datetime import datetime

URL = "https://www.bcv.org.ve/"

# id del bloque en la página -> código de moneda
MONEDAS = {
    "dolar": "USD",
    "euro": "EUR",
    "yuan": "CNY",
    "lira": "TRY",
    "rublo": "RUB",
}


def descargar_pagina(timeout=30):
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def a_numero(texto):
    """Convierte '1.010,56078251' (formato venezolano) a 1010.56078251."""
    return float(texto.strip().replace(".", "").replace(",", "."))


def obtener_tasas():
    html = descargar_pagina()

    tasas = {}
    for div_id, codigo in MONEDAS.items():
        m = re.search(
            r'<div id="' + div_id + r'".*?<strong[^>]*>\s*([\d.,]+)\s*</strong>',
            html,
            re.S,
        )
        if m:
            tasas[codigo] = a_numero(m.group(1))

    if not tasas:
        raise RuntimeError(
            "No se encontraron tasas. Es posible que el BCV haya cambiado su página."
        )

    fecha_valor = None
    fecha_texto = None
    m = re.search(r'Fecha Valor:\s*<span[^>]*content="([^"]+)"[^>]*>([^<]+)</span>', html)
    if m:
        fecha_valor = m.group(1)[:10]  # 'AAAA-MM-DD'
        fecha_texto = " ".join(m.group(2).split())

    return {
        "fuente": URL,
        "fecha_valor": fecha_valor,
        "fecha_valor_texto": fecha_texto,
        "consultado": datetime.now().isoformat(timespec="seconds"),
        "tasas": tasas,
    }


def main():
    try:
        datos = obtener_tasas()
    except Exception as e:
        print(f"Error al consultar el BCV: {e}", file=sys.stderr)
        sys.exit(1)

    if "--json" in sys.argv:
        print(json.dumps(datos, ensure_ascii=False, indent=2))
        return

    print(f"Tasas oficiales BCV - Fecha valor: {datos['fecha_valor_texto'] or 'desconocida'}")
    print("-" * 40)
    for codigo, valor in datos["tasas"].items():
        print(f"  {codigo}   {valor:>18,.8f} Bs.")


if __name__ == "__main__":
    main()
