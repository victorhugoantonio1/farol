"""Gera os ícones da bandeja: o Vigia em miniatura, em quadros de animação.

Uso: python scripts/tray-icons.py   (precisa do Pillow: pip install pillow)

Saída em assets/tray/:
  sheet.png, sheet@1.5x.png, sheet@2x.png  folhas com todos os quadros (16, 24 e 32 px)
  frames.json                              ordem das linhas (níveis) e colunas (quadros)

O main.js recorta cada quadro da folha e troca o ícone ~12 vezes por segundo,
como um GIF em loop.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets" / "tray"

# mesmas cores da luz da ilha (renderer/island.css)
LEVELS = {
    "ok": "#5fe0a0",
    "0": "#a3abb5",
    "1": "#7ab8ff",
    "2": "#f0d873",
    "3": "#f4bb62",
    "4": "#ff9a5c",
    "5": "#ff6268",
    "error": "#7d838c",
}

# quadros: posição do olho (dx), abertura (1 = aberto, 0 = fechado) e brilho (1 = cheio)
FRAMES = {}
for dx in range(-5, 6):
    FRAMES[f"x{dx}"] = dict(dx=dx, open=1.0, light=1.0)
FRAMES["b1"] = dict(dx=0, open=0.55, light=1.0)
FRAMES["b2"] = dict(dx=0, open=0.25, light=1.0)
FRAMES["b3"] = dict(dx=0, open=0.0, light=1.0)
for i, light in enumerate((0.85, 0.7, 0.55, 0.4), start=1):
    FRAMES[f"p{i}"] = dict(dx=0, open=1.0, light=light)

SIZES = {"": 16, "@1.5x": 24, "@2x": 32}
SS = 8  # supersampling: desenha 8x maior e reduz, pra borda ficar lisa
DARK = (20, 22, 26)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw(level_color, frame, px):
    """Desenha numa grade de 32 unidades e reduz pra px."""
    u = px * SS / 32
    W = round(32 * u)
    S = lambda v: round(v * u)  # noqa: E731

    base = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    color = hex_rgb(level_color)
    light = frame["light"]
    eye = mix(DARK, color, light)
    cx = 16 + frame["dx"]
    h = 1.8 + (7.0 - 1.8) * frame["open"]  # altura do olho
    top, bottom = 19.1 - h / 2, 19.1 + h / 2

    # brilho do olho, proporcional à luz e à abertura
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    alpha = round(150 * light * (0.35 + 0.65 * frame["open"]))
    if alpha > 8:
        g = ImageDraw.Draw(glow)
        g.rounded_rectangle([S(cx - 6), S(top - 1.5), S(cx + 6), S(bottom + 1.5)], radius=S(4.5), fill=color + (alpha,))
        glow = glow.filter(ImageFilter.GaussianBlur(S(2.2)))

    d = ImageDraw.Draw(base)

    # antena (acompanha o brilho do olho)
    d.line([S(16), S(4.5), S(16), S(9)], fill=(120, 128, 142, 255), width=max(1, S(1.6)))
    d.ellipse([S(13.6), S(1.4), S(18.4), S(6.2)], fill=eye + (255,))

    # orelhas
    for x0 in (1.2, 27.6):
        d.rounded_rectangle([S(x0), S(14), S(x0 + 3.2), S(22.5)], radius=S(1.6), fill=(58, 63, 74, 255))

    # cabeça com degradê
    head = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([S(3), S(8), S(29), S(30)], radius=S(8.5), fill=255)
    g_top, g_bottom = hex_rgb("#7c8494"), hex_rgb("#22262d")
    grad = Image.new("RGBA", (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(W):
        t = min(1, max(0, (y - S(8)) / max(1, S(22))))
        gd.line([0, y, W, y], fill=mix(g_top, g_bottom, t) + (255,))
    head.paste(grad, (0, 0), mask)
    base.alpha_composite(head)
    # contorno claro: separa o robô da barra de tarefas escura
    d.rounded_rectangle([S(3), S(8), S(29), S(30)], radius=S(8.5), outline=(160, 168, 182, 200), width=max(1, S(0.9)))

    # visor
    d.rounded_rectangle([S(6.2), S(13), S(25.8), S(25)], radius=S(6), fill=(6, 7, 10, 255))

    # olho
    base.alpha_composite(glow)
    d = ImageDraw.Draw(base)
    w = 3.8 + 0.2 * (1 - frame["open"])  # fechando, fica um pouco mais largo
    d.rounded_rectangle([S(cx - w), S(top), S(cx + w), S(bottom)], radius=S(min(3.2, h / 2)), fill=eye + (255,))

    return base.resize((px, px), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    levels, frames = list(LEVELS), list(FRAMES)
    for suffix, px in SIZES.items():
        sheet = Image.new("RGBA", (px * len(frames), px * len(levels)), (0, 0, 0, 0))
        for r, level in enumerate(levels):
            for c, name in enumerate(frames):
                sheet.alpha_composite(draw(LEVELS[level], FRAMES[name], px), (c * px, r * px))
        sheet.save(OUT / f"sheet{suffix}.png", optimize=True)
    (OUT / "frames.json").write_text(json.dumps({"size": 16, "levels": levels, "frames": frames}, indent=2) + "\n")
    print(f"{len(levels)} níveis x {len(frames)} quadros em {OUT}")


if __name__ == "__main__":
    main()
