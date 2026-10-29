#!/usr/bin/env python3
"""Gera theme/user.css a partir de src/user.css e confere a extensão.

  theme/user.css = import do Hazy + src/user.css

A extensão (extensions/liquid-glass.js) NÃO carrega mais uma cópia do CSS: o CSS vem só do
theme/user.css. Este script confere se a versão do CSS (--jc-css-v) é a mesma que a extensão
espera (JC_CSS_V); se não for, a extensão avisa na tela quando o Spotify abre.

Uso (na pasta do projeto):  python tools/build.py
Depois copie os dois arquivos para as pastas do Spicetify e rode:  spicetify apply
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_CSS = ROOT / "src" / "user.css"
THEME = ROOT / "theme" / "user.css"
EXT = ROOT / "extensions" / "liquid-glass.js"
HAZY_IMPORT = '@import url("https://cdn.jsdelivr.net/gh/astromations/hazy/app.css");\n\n'


def main() -> int:
    css = SRC_CSS.read_text(encoding="utf-8")
    js = EXT.read_text(encoding="utf-8")

    vc = re.search(r"--jc-css-v:\s*(\d+)\s*;", css)
    vj = re.search(r"JC_CSS_V\s*=\s*'(\d+)'", js)
    if not vc or not vj:
        print("ERRO: não achei --jc-css-v no CSS ou JC_CSS_V na extensão.")
        return 1
    if vc.group(1) != vj.group(1):
        print(f"ERRO: versões diferentes (CSS {vc.group(1)} x extensão {vj.group(1)}). Mude os dois juntos.")
        return 1

    THEME.parent.mkdir(exist_ok=True)
    THEME.write_text(HAZY_IMPORT + css, encoding="utf-8")

    try:
        r = subprocess.run(["node", "--check", str(EXT)], capture_output=True, text=True)
        print("node --check:", "ok" if r.returncode == 0 else r.stderr)
    except FileNotFoundError:
        print("node não encontrado: pulei a checagem de sintaxe (opcional)")
    print("versão do CSS/extensão:", vc.group(1))
    print("theme/user.css:", THEME.stat().st_size, "bytes")
    print("extensions/liquid-glass.js:", EXT.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
