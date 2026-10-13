"""Gera os ícones da bandeja: o Vigia em miniatura (16, 24 e 32 px).

Uso: python scripts/tray-icons.py   (precisa do Pillow: pip install pillow)

Saída: assets/tray/<nível>-<quadro>.png, com @1.5x e @2x pra telas com zoom.
Níveis seguem as cores da luz da barra; quadros são as poses que o main.js alterna.
"""

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

# poses: deslocamento do olho, olho fechado, olho apagado
FRAMES = {
    "open": dict(dx=0, blink=False, dim=False),
    "blink": dict(dx=0, blink=True, dim=False),
    "left": dict(dx=-4, blink=False, dim=False),
    "right": dict(dx=4, blink=False, dim=False),
    "dim": dict(dx=0, blink=False, dim=True),
}

SIZES = {"": 16, "@1.5x": 24, "@2x": 32}
SS = 8  # supersampling: desenha 8x maior e reduz, pra borda ficar lisa


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw(level_color, frame, px):
    """Desenha numa grade de 32 unidades e reduz pra px."""
    u = px * SS / 32  # tamanho de uma unidade em pixels do rascunho
    W = round(32 * u)
    S = lambda v: round(v * u)  # noqa: E731

    base = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    color = hex_rgb(level_color)
    eye = mix(color, (20, 22, 26), 0.6) if frame["dim"] else color

    # brilho do olho (atrás do visor, pra vazar um pouco)
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    if not frame["dim"]:
        g = ImageDraw.Draw(glow)
        cx = 16 + frame["dx"]
        g.rounded_rectangle([S(cx - 6), S(14.5), S(cx + 6), S(23.5)], radius=S(4.5), fill=color + (150,))
        glow = glow.filter(ImageFilter.GaussianBlur(S(2.2)))

    d = ImageDraw.Draw(base)

    # antena
    d.line([S(16), S(4.5), S(16), S(9)], fill=(120, 128, 142, 255), width=max(1, S(1.6)))
    d.ellipse([S(13.6), S(1.4), S(18.4), S(6.2)], fill=eye + (255,))

    # orelhas
    for x0 in (1.2, 27.6):
        d.rounded_rectangle([S(x0), S(14), S(x0 + 3.2), S(22.5)], radius=S(1.6), fill=(58, 63, 74, 255))

    # cabeça com degradê (claro em cima, escuro embaixo)
    head = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([S(3), S(8), S(29), S(30)], radius=S(8.5), fill=255)
    top, bottom = hex_rgb("#7c8494"), hex_rgb("#22262d")
    grad = Image.new("RGBA", (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(W):
        t = min(1, max(0, (y - S(8)) / max(1, S(22))))
        gd.line([0, y, W, y], fill=mix(top, bottom, t) + (255,))
    head.paste(grad, (0, 0), mask)
    base.alpha_composite(head)
    # contorno claro: separa o robô da barra de tarefas escura
    d.rounded_rectangle([S(3), S(8), S(29), S(30)], radius=S(8.5), outline=(160, 168, 182, 200), width=max(1, S(0.9)))

    # visor
    d.rounded_rectangle([S(6.2), S(13), S(25.8), S(25)], radius=S(6), fill=(6, 7, 10, 255))

    # olho
    base.alpha_composite(glow)
    d = ImageDraw.Draw(base)
    cx = 16 + frame["dx"]
    if frame["blink"]:
        d.rounded_rectangle([S(cx - 4), S(18.4), S(cx + 4), S(20.2)], radius=S(0.9), fill=eye + (255,))
    else:
        d.rounded_rectangle([S(cx - 3.8), S(15.6), S(cx + 3.8), S(22.6)], radius=S(3.2), fill=eye + (255,))

    return base.resize((px, px), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    n = 0
    for level, color in LEVELS.items():
        for name, frame in FRAMES.items():
            for suffix, px in SIZES.items():
                draw(color, frame, px).save(OUT / f"{level}-{name}{suffix}.png", optimize=True)
                n += 1
    print(f"{n} ícones em {OUT}")


if __name__ == "__main__":
    main()
