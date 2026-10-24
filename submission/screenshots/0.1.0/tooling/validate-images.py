#!/usr/bin/env python3
"""Validate native PNG sets and create review-only contact sheets. Never modifies captures."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
accepted = {
    "iphone": {(1320, 2868), (2868, 1320)},
    "ipad": {(2064, 2752), (2752, 2064)},
    "duo-outer": {(1398, 2034), (2034, 1398)},
    "duo-inner": {(2007, 2853), (2853, 2007)},
}
for required in ("iphone", "ipad", "duo-outer"):
    assert (root / "en-US" / required).is_dir(), f"Missing required set: {required}"
records = []
all_hashes = set()
expected_names = ["01-conversation.png", "02-models.png", "03-connections.png",
                  "04-conversations.png", "05-controls.png", "06-dark-conversation.png"]
for family, sizes in accepted.items():
    directory = root / "en-US" / family
    if not directory.exists():
        continue
    files = sorted(directory.glob("*.png"))
    if len(files) != 6:
        raise SystemExit(f"{family}: expected six captures, got {len(files)}")
    assert [path.name for path in files] == expected_names, (family, "unexpected capture sequence")
    hashes = set()
    sheet = Image.new("RGB", (960, 920), "#e9ecf0")
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(files):
        with Image.open(path) as capture:
            capture.load()
            assert capture.format == "PNG", path
            assert capture.size in sizes, (path, capture.size)
            assert capture.mode == "RGB", (path, "alpha channel or non-RGB mode", capture.mode)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert digest not in hashes, (family, "duplicate image")
            assert digest not in all_hashes, (family, "duplicate across upload sets")
            hashes.add(digest)
            all_hashes.add(digest)
            records.append({"file": str(path.relative_to(root)), "deviceFamily": family,
                            "width": capture.width, "height": capture.height,
                            "mode": capture.mode, "sha256": digest})
            thumbnail = capture.copy()
            thumbnail.thumbnail((300, 410))
            x, y = (index % 3) * 320, (index // 3) * 460
            sheet.paste(thumbnail, (x + (320 - thumbnail.width) // 2, y + 24))
            draw.text((x + 10, y + 438), path.stem, fill="black")
    sheet.save(root / f"contact-sheet-{family}.jpg", quality=92)
(root / "image-validation.json").write_text(json.dumps(records, indent=2) + "\n")
print(f"Validated {len(records)} opaque, unique native PNGs")
