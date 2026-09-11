"""Stitch render_gallery.py output into one labelled contact sheet per sweep.

    python3 tools/flower/contact_sheet.py /path/to/gallery
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def main(d):
    manifest = json.load(open(os.path.join(d, "manifest.json")))
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
    except OSError:
        font = ImageFont.load_default()
    sheets = []
    for key, items in manifest.items():
        ims = [Image.open(os.path.join(d, it["file"])).convert("RGBA") for it in items]
        w, h = ims[0].size
        pad, label_h = 8, 34
        sheet = Image.new("RGB", (len(ims) * (w + pad) + pad, h + label_h + pad * 2), "white")
        draw = ImageDraw.Draw(sheet)
        for i, (im, it) in enumerate(zip(ims, items)):
            x = pad + i * (w + pad)
            sheet.paste(im, (x, label_h + pad), im)
            draw.text((x + 6, pad), f"{key} = {it['value']}", fill="black", font=font)
        out = os.path.join(d, f"sheet_{key}.png")
        sheet.save(out)
        sheets.append(out)
        print("wrote", out)
    return sheets


if __name__ == "__main__":
    main(sys.argv[1])
