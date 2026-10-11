#!/usr/bin/env python3
# Crop each box label out of the owner's five photos and OCR it with Tesseract,
# the engine core-scan's label reader uses. Boxes are in the coordinates of the
# 1200-px-long preview (the photo after auto-orient), scaled to full size.
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "ocr")
os.makedirs(OUT, exist_ok=True)

# name: (photo, [(x0, y0, x1, y1, rotate_degrees, expected colour), ...])
LABELS = {
    "multicolor-a": ("multi-a", [
        (70, 605, 240, 760, 0, "Black"), (265, 650, 445, 785, 0, "Transparent"), (455, 640, 640, 765, 0, "Gray"),
        (670, 645, 860, 770, 0, "Dark Blue"), (890, 655, 1085, 790, 0, "Green")]),
    "multicolor-b": ("multi-b", [
        (125, 575, 295, 700, 0, "White"), (318, 560, 505, 690, 0, "Red"), (518, 585, 702, 705, 0, "Metallic Silver"),
        (712, 585, 898, 710, 0, "Orange"), (940, 570, 1125, 690, 0, "Yellow")]),
    "multicolor1-a": ("multi1-a", [
        (70, 630, 270, 745, 0, "White"), (300, 590, 505, 705, 0, "Light Pink"), (520, 605, 725, 720, 0, "Orange"),
        (740, 585, 945, 705, 0, "Black"), (960, 565, 1165, 690, 0, "Purple")]),
    "multicolor1-b": ("multi1-b", [
        (100, 580, 290, 690, 0, "Red"), (305, 580, 495, 690, 0, "Dark Blue"), (505, 580, 700, 690, 0, "Gray"),
        (705, 580, 910, 695, 0, "Grass Green"), (912, 580, 1110, 700, 0, "Light Apricot")]),
    "white-carton": ("white", [
        (655, 25, 815, 215, 90, "White"), (655, 255, 820, 450, 90, "White"), (655, 480, 825, 680, 90, "White"),
        (665, 715, 835, 915, 90, "White"), (665, 955, 840, 1160, 90, "White")]),
}


def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


for name, (photo, boxes) in LABELS.items():
    src = os.path.join(HERE, f"{photo}.img")
    full = os.path.join(HERE, f"{photo}.full.png")
    if not os.path.exists(full):
        run("magick", src, "-auto-orient", full)
    w = int(run("magick", "identify", "-format", "%w", full))
    h = int(run("magick", "identify", "-format", "%h", full))
    scale = max(w, h) / 1200.0
    texts = []
    for i, (x0, y0, x1, y1, rot, colour) in enumerate(boxes, 1):
        crop = os.path.join(HERE, f"{name}-{i}.png")
        geo = f"{int((x1 - x0) * scale)}x{int((y1 - y0) * scale)}+{int(x0 * scale)}+{int(y0 * scale)}"
        crop = crop.replace(".png", ".jpg")
        # A person's photo of one box's label: the crop as taken, upright.
        run("magick", full, "-crop", geo, "+repage", "-rotate", str(rot), "-quality", "90", crop)
        texts.append({"box": i, "expected_colour": colour, "image": os.path.basename(crop)})
    with open(os.path.join(OUT, f"{name}.crops.json"), "w") as f:
        json.dump({"photo": photo, "labels": texts}, f, indent=1, ensure_ascii=False)
    print(name, "done")
