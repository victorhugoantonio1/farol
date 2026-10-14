"""Gera o ícone do app (assets/icon.png, 512 px): o Vigia sobre um ladrilho escuro, o mesmo do site.

Uso: python scripts/app-icon.py   (precisa do Pillow)
O electron-builder usa esse PNG pra montar o .ico do instalador e do atalho.
"""

import importlib.util
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("tray_icons", HERE / "tray-icons.py")
tray = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tray)

S = 512
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=116, fill=255)
grad = Image.new("RGBA", (S, S))
g = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    g.line([0, y, S, y], fill=(int(34 - 17 * t), int(41 - 20 * t), int(55 - 26 * t), 255))
tile.paste(grad, (0, 0), mask)
# brilho verde atrás do robô
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([116, 136, 396, 396], fill=(95, 224, 160, 70))
glow = glow.filter(ImageFilter.GaussianBlur(48))
tile = Image.alpha_composite(tile, Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
bot = tray.draw(tray.LEVELS["ok"], tray.FRAMES["x0"], 360)
tile.alpha_composite(bot, ((S - 360) // 2, (S - 360) // 2 + 4))
out = HERE.parent / "assets" / "icon.png"
tile.save(out, optimize=True)
print(f"ícone salvo em {out}")
