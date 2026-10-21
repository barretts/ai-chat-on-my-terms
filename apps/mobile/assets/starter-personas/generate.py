"""T184 starter-pack + T180 bench avatars: 19 flat 512x512 PNGs, zero deps.

Deterministic: every image is a pure function of this file. From this
directory run `python generate.py` to regenerate all PNGs + provenance
sidecars in place. Painter's-algorithm shape layers, 2x supersampling.
"""
import math
import os
import struct
import sys
import zlib

W = H = 512
SS = 2  # supersample factor (2x2 box filter)


def hexc(s):
    return (int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16))


def _tri_side(ax, ay, bx, by, px, py):
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)


def covers(sh, x, y):
    kind = sh[0]
    if kind == "bg":
        return True
    if kind == "circle":
        _, cx, cy, r, _c = sh
        dx, dy = x - cx, y - cy
        return dx * dx + dy * dy <= r * r
    if kind == "rect":
        _, x0, y0, x1, y1, _c = sh
        return x0 <= x <= x1 and y0 <= y <= y1
    if kind == "tri":
        (ax, ay), (bx, by), (cx, cy) = sh[1], sh[2], sh[3]
        d1 = _tri_side(ax, ay, bx, by, x, y)
        d2 = _tri_side(bx, by, cx, cy, x, y)
        d3 = _tri_side(cx, cy, ax, ay, x, y)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)
    if kind == "ring":
        _, cx, cy, r, w, _c = sh
        d = math.hypot(x - cx, y - cy)
        return abs(d - r) <= w / 2
    if kind == "arc":
        _, cx, cy, r, w, a0, a1, _c = sh
        d = math.hypot(x - cx, y - cy)
        if abs(d - r) > w / 2:
            return False
        a = math.degrees(math.atan2(y - cy, x - cx)) % 360
        if a0 <= a1:
            return a0 <= a <= a1
        return a >= a0 or a <= a1
    if kind == "capsule":
        _, x0, y0, x1, y1, w, _c = sh
        vx, vy = x1 - x0, y1 - y0
        seg = vx * vx + vy * vy
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((x - x0) * vx + (y - y0) * vy) / seg))
        px, py = x0 + t * vx, y0 + t * vy
        return math.hypot(x - px, y - py) <= w / 2
    raise ValueError(kind)


def trace(shapes, x, y):
    for sh in reversed(shapes):
        if covers(sh, x, y):
            return sh[-1]
    return (0, 0, 0)


def render(shapes):
    raw = bytearray()
    for oy in range(H):
        raw.append(0)  # filter: none
        for ox in range(W):
            rs = gs = bs = 0
            for sy in range(SS):
                y = oy + (sy + 0.5) / SS
                for sx in range(SS):
                    x = ox + (sx + 0.5) / SS
                    c = trace(shapes, x, y)
                    rs += c[0]
                    gs += c[1]
                    bs += c[2]
            n = SS * SS
            raw.append(rs // n)
            raw.append(gs // n)
            raw.append(bs // n)
    return bytes(raw)


def write_png(path, rgb_rows):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    stride = W * 3 + 1
    rows = bytearray()
    for y in range(H):
        rows += b"\x00"
        rows += rgb_rows[y * stride + 1 : (y + 1) * stride]
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


INK = "#1A1417"


def mix(a, b, t):
    A, B = hexc(a), hexc(b)
    return tuple(round(A[i] + (B[i] - A[i]) * t) for i in range(3))


def base(bg, skin, shirt):
    """Common bust: shoulder dome, neck shadow, head."""
    return [
        ("bg", hexc(bg)),
        ("circle", 256, 728, 306, hexc(shirt)),
        ("rect", 226, 322, 286, 404, mix(skin, "#000000", 0.25)),
        ("circle", 256, 258, 126, hexc(skin)),
    ]


def eyes(sh, c=INK, r=10):
    sh.append(("circle", 216, 252, r, hexc(c)))
    sh.append(("circle", 296, 252, r, hexc(c)))


def smile(sh, c=INK):
    sh.append(("arc", 256, 268, 40, 9, 25, 155, hexc(c)))


def flat(sh, c=INK):
    sh.append(("capsule", 232, 292, 280, 292, 9, hexc(c)))


def blush(sh, c):
    sh.append(("circle", 188, 288, 17, hexc(c)))
    sh.append(("circle", 324, 288, 17, hexc(c)))


def brows(sh, c, w=10):
    sh.append(("capsule", 192, 218, 240, 212, w, hexc(c)))
    sh.append(("capsule", 272, 212, 320, 218, w, hexc(c)))


def star(sh, x, y, s, c):
    """Four-point sparkle from two triangles."""
    sh.append(("tri", (x, y - s), (x - s * 0.42, y), (x + s * 0.42, y), hexc(c)))
    sh.append(("tri", (x, y + s), (x - s * 0.42, y), (x + s * 0.42, y), hexc(c)))


def gruff_mentor():
    bg, skin, hair = "#3E2723", "#C08A5E", "#B9B4AE"
    sh = base(bg, skin, "#4E342E")
    sh.append(("arc", 256, 258, 116, 40, 200, 340, hexc(hair)))  # swept-back top
    sh.append(("rect", 130, 230, 162, 306, hexc(hair)))  # sideburns
    sh.append(("rect", 350, 230, 382, 306, hexc(hair)))
    sh.append(("arc", 256, 244, 108, 52, 35, 145, hexc(hair)))  # full beard
    sh.append(("capsule", 232, 290, 280, 290, 8, mix(hair, "#000000", 0.55)))
    brows(sh, hair, 12)
    eyes(sh)
    sh.append(("capsule", 330, 236, 344, 286, 6, mix(skin, "#8c2f1f", 0.6)))  # scar
    return sh


def sunbeam():
    bg, skin, hair = "#FFF8E1", "#F2C9A8", "#F9A825"
    sh = base(bg, skin, "#FFE082")
    for i, ang in enumerate(range(0, 180, 30)):  # sunburst spikes
        r0, r1 = 118, 176
        a = math.radians(ang + 90)
        cx, cy = 256 - 0, 258
        px, py = cx + r0 * math.cos(a), cy + r0 * math.sin(a)
        tx, ty = cx + r1 * math.cos(a), cy + r1 * math.sin(a)
        nx, ny = -math.sin(a) * 22, math.cos(a) * 22
        sh.append(("tri", (px - nx, py - ny), (px + nx, py + ny), (tx, ty), hexc(hair)))
    sh.append(("arc", 256, 258, 118, 44, 195, 345, hexc(hair)))  # bangs
    sh.append(("rect", 158, 120, 354, 206, hexc(hair)))  # full bangs
    smile(sh)
    eyes(sh)
    blush(sh, "#F4B183")
    star(sh, 444, 88, 30, hair)
    star(sh, 66, 120, 20, hair)
    return sh


def butler():
    bg, skin = "#263238", "#E9BE96"
    sh = base(bg, skin, "#37474F")
    grey = "#90A4AE"
    sh.append(("arc", 256, 258, 122, 26, 335, 25, hexc(grey)))  # side fringe R
    sh.append(("arc", 256, 258, 122, 26, 155, 205, hexc(grey)))  # side fringe L
    flat(sh)
    eyes(sh)
    brows(sh, "#78909C")
    sh.append(("ring", 296, 252, 27, 7, hexc("#CFD8DC")))  # monocle
    sh.append(("capsule", 318, 276, 342, 330, 5, hexc("#CFD8DC")))
    bowtie = "#B0BEC5"
    sh.append(("tri", (256, 372), (196, 344), (196, 400), hexc(bowtie)))
    sh.append(("tri", (256, 372), (316, 344), (316, 400), hexc(bowtie)))
    sh.append(("circle", 256, 372, 14, mix(bowtie, "#000000", 0.4)))
    return sh


def noir_detective():
    bg, skin, hat = "#1C262D", "#D8A176", "#90A4AE"
    sh = base(bg, skin, "#2E3B43")
    for (x0, y0) in ((96, 90), (150, 60), (360, 84), (416, 140), (60, 200), (444, 230)):
        sh.append(("capsule", x0, y0, x0 - 26, y0 + 58, 5, mix(hat, "#000000", 0.25)))  # rain
    flat(sh)
    eyes(sh, "#263238", 8)
    sh.append(("rect", 178, 118, 334, 192, hexc(hat)))  # crown
    sh.append(("rect", 178, 168, 334, 192, mix(hat, "#000000", 0.5)))  # band
    sh.append(("rect", 112, 188, 400, 216, hexc(hat)))  # brim
    sh.append(("tri", (256, 402), (186, 330), (226, 336), hexc("#42525C")))  # collar
    sh.append(("tri", (256, 402), (326, 330), (286, 336), hexc("#42525C")))
    return sh


def schemer():
    bg, skin = "#2A1A33", "#EAC1A2"
    hair, accent = "#4A2B57", "#AB47BC"
    sh = base(bg, skin, "#5E3567")
    sh.append(("arc", 256, 258, 124, 60, 190, 350, hexc(hair)))  # swept hair
    sh.append(("rect", 152, 120, 360, 200, hexc(hair)))  # swept fringe
    smile(sh)
    eyes(sh)
    brows(sh, hair, 8)
    crown = "#FFD54F"
    for i, x in enumerate((196, 236, 276, 316)):
        h = 58 if i in (0, 3) else 76
        sh.append(("tri", (x - 22, 150), (x + 22, 150), (x, 150 - h), hexc(crown)))
    sh.append(("rect", 172, 146, 340, 172, hexc(crown)))
    sh.append(("ring", 148, 320, 14, 6, hexc(crown)))  # earring
    sh.append(("ring", 364, 320, 14, 6, hexc(crown)))
    sh.append(("tri", (256, 420), (196, 348), (238, 360), hexc(accent)))  # collar
    sh.append(("tri", (256, 420), (316, 348), (274, 360), hexc(accent)))
    return sh


def archivist():
    bg, skin = "#E0F2F1", "#F2C9A8"
    hair, accent = "#546E7A", "#26A69A"
    sh = base(bg, skin, "#B2DFDB")
    sh.append(("rect", 122, 200, 178, 452, hexc(hair)))  # shoulder-length sides
    sh.append(("rect", 334, 200, 390, 452, hexc(hair)))
    sh.append(("arc", 256, 258, 124, 56, 185, 355, hexc(hair)))  # top + fringe
    sh.append(("rect", 150, 120, 362, 202, hexc(hair)))  # side-parted bangs
    smile(sh)
    eyes(sh)
    brows(sh, hair, 7)
    sh.append(("ring", 216, 252, 33, 7, hexc(accent)))  # glasses
    sh.append(("ring", 296, 252, 33, 7, hexc(accent)))
    sh.append(("capsule", 244, 250, 268, 250, 7, hexc(accent)))
    sh.append(("rect", 216, 430, 296, 470, hexc(accent)))  # book
    sh.append(("rect", 224, 438, 288, 446, mix(accent, "#FFFFFF", 0.7)))
    return sh


def hype_buddy():
    bg, skin = "#212121", "#C9885C"
    accent = "#FF7043"
    sh = base(bg, skin, "#8E2D16")
    for x, h in ((206, 120), (256, 156), (306, 120)):  # flame hair
        sh.append(("tri", (x - 34, 220), (x + 34, 220), (x, 220 - h), hexc(accent)))
    sh.append(("rect", 136, 204, 376, 238, hexc("#FFAB91")))  # headband
    smile(sh)
    eyes(sh)
    blush(sh, "#A9603C")
    sh.append(("capsule", 176, 468, 336, 468, 14, hexc(accent)))  # barbell
    sh.append(("circle", 172, 468, 28, mix(accent, "#000000", 0.35)))
    sh.append(("circle", 340, 468, 28, mix(accent, "#000000", 0.35)))
    return sh


CHARACTERS = {
    "gruff-mentor": (gruff_mentor, "Aldric Vane", "stern grey beard and swept-back silver hair, scar on the cheek, watchmaker's gravity"),
    "sunbeam": (sunbeam, "Sunny Marlowe", "radiating sun-ray hair, big smile, sparkles, morning-yellow warmth"),
    "butler": (butler, "Bingham", "silver side fringe, monocle on a chain, bow tie, immaculate poise"),
    "noir-detective": (noir_detective, "Rook Malone", "fedora and raised collar, diagonal rain, shade in the brim's shadow"),
    "schemer": (schemer, "Duchess Virelai", "gold spike crown over swept plum hair, high collar, court rings"),
    "archivist": (archivist, "Wren Ashbury", "shoulder-length slate hair, teal round glasses, a book at the bust line"),
    "hype-buddy": (hype_buddy, "Blaze Carson", "flame-orange spiky hair under a headband, barbell across the chest"),
}


def oracle():
    bg, skin, accent = "#15131F", "#B8875F", "#B39DDB"
    sh = [
        ("bg", hexc(bg)),
        ("circle", 256, 728, 306, hexc("#2A2344")),
        ("circle", 256, 250, 158, hexc("#3A2E58")),  # hood
        ("circle", 256, 268, 118, hexc(skin)),  # face opening
    ]
    sh.append(("circle", 256, 140, 34, hexc(accent)))  # crescent on hood
    sh.append(("circle", 272, 130, 30, hexc("#3A2E58")))
    sh.append(("circle", 256, 216, 11, hexc(accent)))  # third eye
    eyes(sh, accent, 9)
    flat(sh, "#3A2E58")
    star(sh, 70, 96, 22, accent)
    star(sh, 448, 66, 16, accent)
    return sh


def tsundere():
    bg, skin, accent = "#FCE4EC", "#F2C9A8", "#EF5350"
    hair = "#2A2E45"
    sh = base(bg, skin, "#EF9A9A")
    for x in (112, 400):  # twin tails
        sh.append(("circle", x, 292, 52, hexc(hair)))
        sh.append(("circle", x + (-10 if x < 256 else 10), 384, 40, hexc(hair)))
    sh.append(("arc", 256, 258, 124, 58, 185, 355, hexc(hair)))  # bangs
    sh.append(("rect", 152, 120, 360, 204, hexc(hair)))  # straight bangs
    sh.append(("rect", 132, 200, 180, 250, hexc(hair)))
    sh.append(("rect", 332, 200, 380, 250, hexc(hair)))
    sh.append(("circle", 178, 186, 12, hexc(accent)))  # hair clip
    sh.append(("arc", 256, 306, 22, 8, 205, 335, hexc(INK)))  # pout
    eyes(sh)
    brows(sh, hair)  # angled: inner ends low
    sh[-2] = ("capsule", 192, 208, 240, 226, 10, hexc(hair))
    sh[-1] = ("capsule", 272, 226, 320, 208, 10, hexc(hair))
    blush(sh, "#F48FB1")
    sh.append(("capsule", 344, 128, 374, 158, 9, hexc(accent)))  # pop mark
    sh.append(("capsule", 374, 128, 344, 158, 9, hexc(accent)))
    return sh


def kuudere():
    bg, skin, accent = "#E1F5FE", "#F6DCC7", "#4FC3F7"
    hair = "#78909C"
    sh = base(bg, skin, "#B3E5FC")
    sh.append(("rect", 130, 196, 184, 400, hexc(hair)))  # hime-cut sides
    sh.append(("rect", 328, 196, 382, 400, hexc(hair)))
    sh.append(("rect", 134, 150, 378, 224, hexc(hair)))  # straight bangs
    sh.append(("arc", 256, 240, 124, 60, 180, 360, hexc(hair)))
    eyes(sh, "#37474F", 8)
    sh.append(("capsule", 240, 296, 272, 296, 7, hexc("#78909C")))  # still mouth
    sh.append(("circle", 330, 186, 11, hexc(accent)))  # droplet pin
    sh.append(("tri", (319, 186), (341, 186), (330, 158), hexc(accent)))
    return sh


def genki():
    bg, skin, accent = "#F1F8E9", "#F2C9A8", "#66BB6A"
    hair = "#8D6E63"
    sh = base(bg, skin, "#AED581")
    sh.append(("circle", 396, 156, 58, hexc(hair)))  # side ponytail
    sh.append(("circle", 428, 236, 42, hexc(hair)))
    sh.append(("arc", 256, 258, 124, 58, 185, 355, hexc(hair)))
    sh.append(("rect", 152, 120, 360, 202, hexc(hair)))  # spiky bangs
    sh.append(("circle", 256, 292, 36, hexc(INK)))  # open grin
    sh.append(("rect", 218, 236, 294, 292, hexc(skin)))
    eyes(sh)
    brows(sh, hair, 8)
    blush(sh, "#F4B183")
    star(sh, 158, 182, 26, accent)  # star pin
    return sh


def chuunibyou():
    bg, skin, accent = "#1A1B26", "#EAC1A2", "#7E57C2"
    hair = "#14141F"
    sh = base(bg, skin, "#2B2B40")
    sh.append(("arc", 256, 258, 128, 70, 170, 10, hexc(hair)))  # hair mass
    for x, h in ((176, 74), (226, 96), (286, 92), (336, 72)):  # spikes
        sh.append(("tri", (x - 30, 168), (x + 30, 168), (x, 168 - h), hexc(hair)))
    sh.append(("capsule", 150, 214, 372, 190, 12, hexc("#101018")))  # patch strap
    sh.append(("circle", 300, 252, 36, hexc("#101018")))  # eyepatch
    sh.append(("circle", 216, 252, 10, hexc(accent)))  # glowing left eye
    sh.append(("circle", 212, 248, 4, hexc("#FFFFFF")))
    sh.append(("arc", 256, 284, 26, 8, 30, 150, hexc(INK)))  # smirk
    sh.append(("ring", 356, 140, 18, 6, hexc(accent)))  # sealed sigil
    sh.append(("tri", (256, 424), (196, 348), (240, 362), hexc("#3B3A55")))  # collar
    sh.append(("tri", (256, 424), (316, 348), (272, 362), hexc("#3B3A55")))
    return sh


def isekai_hero():
    bg, skin, accent = "#E3F2FD", "#D8A176", "#42A5F5"
    hair = "#2E3440"
    sh = base(bg, skin, "#ECEFF1")
    sh.append(("arc", 256, 258, 122, 52, 195, 345, hexc(hair)))  # office cut
    sh.append(("rect", 152, 120, 360, 198, hexc(hair)))  # office fringe
    sh.append(("rect", 132, 214, 168, 262, hexc(hair)))
    sh.append(("rect", 344, 214, 380, 262, hexc(hair)))
    smile(sh)
    eyes(sh)
    brows(sh, hair, 8)
    sh.append(("tri", (256, 404), (236, 372), (276, 372), hexc(accent)))  # tie
    sh.append(("tri", (256, 486), (228, 420), (284, 420), hexc(accent)))
    sh.extend(  # katana over the shoulder, carried in front of the collar
        [
            ("capsule", 424, 108, 346, 300, 12, hexc("#B0BEC5")),  # blade
            ("capsule", 354, 286, 402, 304, 10, hexc("#FFC107")),  # guard
            ("capsule", 344, 302, 330, 346, 8, hexc("#6D4C41")),  # grip
        ]
    )
    return sh


def magical_girl():
    bg, skin, accent = "#FDF0F6", "#F2C9A8", "#F06292"
    hair = "#9575CD"
    sh = base(bg, skin, "#F8BBD0")
    for x in (110, 402):  # bun drills
        sh.append(("circle", x, 208, 54, hexc(hair)))
        sh.append(("circle", x, 208, 22, mix(hair, "#000000", 0.3)))
        sh.append(("circle", x, 208, 13, hexc(accent)))
    sh.append(("arc", 256, 258, 124, 60, 185, 355, hexc(hair)))  # bangs
    sh.append(("rect", 152, 120, 360, 200, hexc(hair)))  # heart bangs
    smile(sh)
    eyes(sh)
    blush(sh, "#F48FB1")
    sh.append(("rect", 196, 150, 316, 166, hexc("#FFD54F")))  # tiara band
    star(sh, 256, 148, 30, "#FFD54F")
    star(sh, 64, 110, 20, accent)
    star(sh, 452, 92, 16, accent)
    return sh


CHARACTERS.update(
    {
        "oracle": (oracle, "Sable Nyx", "veiled in a dusk hood with a crescent, third eye and starlit violet"),
        "tsundere": (tsundere, "Aoi Hazuki", "dark twin tails and a red clip, pout and crossed pop-mark, flustered blush"),
        "kuudere": (kuudere, "Shizuku", "silver-blue hime-cut with straight bangs, a single cyan droplet pin, perfect stillness"),
        "genki": (genki, "Hina Morikawa", "side ponytail and star pin, open grin, club-president spring green"),
        "chuunibyou": (chuunibyou, "Rin Kurogane", "black spikes, eyepatch over a violet glowing eye, sealed sigil and tall collar"),
        "isekai-hero": (isekai_hero, "Kenji Takao", "office-cut hair, necktie over shirt, sword carried over the shoulder"),
        "magical-girl": (magical_girl, "Lumi", "lavender drills with rose cores, gold star tiara, moonpink sparkles"),
    }
)

# --- T180 bench personas (the dev-grid characters; owner asked they carry
# proper names + avatars like the trope pack). Names mirror the identity
# embedded in the matrix prompts: Captain Marrow, Mira, Dana, Vic, Sal.


def bench_pirate():
    bg, skin = "#0E2A35", "#C9885C"
    hat, coat = "#263238", "#4E342E"
    sh = base(bg, skin, coat)
    smile(sh)
    eyes(sh)
    sh.append(("capsule", 138, 232, 330, 196, 10, mix(hat, "#000000", 0.3)))  # patch strap
    sh.append(("circle", 216, 252, 30, hexc("#141C22")))  # eyepatch
    sh.append(("capsule", 216, 232, 232, 244, 5, hexc("#546E7A")))  # patch glint
    sh.append(("capsule", 96, 206, 416, 206, 16, hexc(hat)))  # tricorn brim
    sh.append(("rect", 180, 116, 332, 198, mix(hat, "#FFFFFF", 0.08)))  # crown
    sh.append(("rect", 180, 178, 332, 198, hexc("#FFC107")))  # gold band
    sh.append(("circle", 256, 148, 18, hexc("#ECEFF1")))  # skull disc
    sh.append(("circle", 249, 145, 4, hexc(INK)))  # skull eyes
    sh.append(("circle", 263, 145, 4, hexc(INK)))
    sh.append(("rect", 249, 156, 263, 164, hexc("#ECEFF1")))  # skull jaw
    sh.append(("circle", 336, 302, 12, hexc("#FFC107")))  # hoop earring
    sh.append(("circle", 336, 302, 6, mix(skin, "#000000", 0.25)))
    sh.append(("tri", (256, 402), (186, 330), (226, 336), mix(coat, "#FFFFFF", 0.18)))  # coat lapels
    sh.append(("tri", (256, 402), (326, 330), (286, 336), mix(coat, "#FFFFFF", 0.18)))
    return sh


def bench_poet():
    bg, skin = "#F3E5F5", "#F2C9A8"
    hair = "#4A2C4F"
    sh = base(bg, skin, "#7E57C2")
    sh.append(("arc", 256, 258, 122, 52, 195, 345, hexc(hair)))  # flowing hair
    sh.append(("rect", 152, 132, 360, 176, hexc(hair)))  # fringe
    sh.append(("rect", 130, 176, 168, 372, hexc(hair)))  # shoulder locks
    sh.append(("rect", 344, 176, 382, 372, hexc(hair)))
    blush(sh, "#F48FB1")
    smile(sh)
    eyes(sh)
    brows(sh, hair, 8)
    for (x, y) in ((150, 186), (168, 152), (196, 128), (230, 112), (282, 112), (316, 128), (344, 152), (362, 186)):
        sh.append(("circle", x, y, 9, hexc("#66BB6A")))  # laurel leaves
    for (x, y) in ((182, 166), (256, 106), (330, 166)):
        sh.append(("circle", x, y, 5, hexc("#FFC107")))  # gold berries
    sh.append(("capsule", 396, 92, 334, 214, 10, hexc("#FAFAFA")))  # quill
    sh.append(("capsule", 396, 92, 366, 152, 6, hexc("#CFD8DC")))  # quill spine
    sh.append(("tri", (322, 236), (330, 204), (348, 212), hexc("#FFC107")))  # nib
    return sh


def bench_engineer():
    bg, skin = "#ECEFF1", "#D8A176"
    sh = base(bg, skin, "#455A64")
    smile(sh)
    eyes(sh)
    sh.append(("circle", 256, 138, 98, hexc("#FFB300")))  # hard-hat dome
    sh.append(("capsule", 256, 60, 256, 128, 10, hexc("#FFA000")))  # dome ridge
    sh.append(("rect", 126, 192, 386, 224, hexc("#FFA000")))  # brim
    sh.append(("circle", 208, 148, 36, hexc("#37474F")))  # goggle housings
    sh.append(("circle", 208, 148, 26, hexc("#B3E5FC")))  # goggle lenses
    sh.append(("circle", 304, 148, 26, hexc("#B3E5FC")))
    sh.append(("rect", 238, 140, 274, 156, hexc("#37474F")))  # goggle bridge
    sh.append(("tri", (256, 404), (240, 368), (272, 368), hexc("#FFB300")))  # collar tab
    sh.append(("capsule", 176, 452, 256, 420, 8, hexc("#FFEE58")))  # hi-vis vest stripes
    sh.append(("capsule", 336, 452, 256, 420, 8, hexc("#FFEE58")))
    return sh


def bench_skeptic():
    bg, skin = "#EFEBE9", "#F6DCC7"
    tweed = "#5D4037"
    sh = base(bg, skin, tweed)
    sh.append(("arc", 256, 258, 124, 44, 200, 340, hexc("#8D6E63")))  # grey top
    sh.append(("rect", 164, 140, 348, 178, hexc("#8D6E63")))  # receding fringe
    sh.append(("capsule", 192, 220, 240, 216, 8, hexc("#616161")))  # left brow level
    sh.append(("capsule", 272, 198, 320, 204, 8, hexc("#616161")))  # right brow raised
    flat(sh)  # unimpressed mouth
    eyes(sh)
    sh.append(("circle", 296, 252, 27, hexc("#FFC107")))  # monocle ring
    sh.append(("circle", 296, 252, 21, hexc(skin)))  # ring window
    sh.append(("circle", 296, 252, 10, hexc(INK)))  # pinned eye
    sh.append(("capsule", 314, 278, 332, 356, 4, hexc("#FFC107")))  # monocle chain
    sh.append(("tri", (256, 402), (186, 330), (226, 336), mix(tweed, "#FFFFFF", 0.18)))  # tweed lapels
    sh.append(("tri", (256, 402), (326, 330), (286, 336), mix(tweed, "#FFFFFF", 0.18)))
    sh.append(("rect", 156, 424, 204, 440, mix(tweed, "#000000", 0.35)))  # elbow patch
    return sh


def bench_chef():
    bg, skin = "#FFF3E0", "#C08A5E"
    sh = base(bg, skin, "#FAFAFA")
    eyes(sh)
    blush(sh, "#E57373")
    brows(sh, "#3E2723", 8)
    sh.append(("capsule", 188, 306, 210, 314, 7, hexc("#3E2723")))  # left handlebar curl
    sh.append(("capsule", 302, 314, 324, 306, 7, hexc("#3E2723")))  # right handlebar curl
    sh.append(("capsule", 206, 300, 306, 300, 15, hexc("#3E2723")))  # handlebar moustache
    sh.append(("circle", 256, 98, 74, hexc("#FFFFFF")))  # toque top puff
    sh.append(("circle", 190, 120, 46, hexc("#FFFFFF")))
    sh.append(("circle", 322, 120, 46, hexc("#FFFFFF")))
    sh.append(("rect", 182, 118, 330, 188, hexc("#FFFFFF")))  # toque body
    sh.append(("rect", 176, 182, 336, 212, hexc("#E0E0E0")))  # toque band
    sh.append(("tri", (256, 448), (196, 372), (316, 372), hexc("#D32F2F")))  # neckerchief
    sh.append(("circle", 256, 380, 16, hexc("#B71C1C")))  # knot
    sh.append(("circle", 176, 448, 9, hexc("#FBC02D")))  # apron strings
    sh.append(("circle", 336, 448, 9, hexc("#FBC02D")))
    return sh


CHARACTERS.update(
    {
        "bench-pirate": (
            bench_pirate,
            "Captain Marrow",
            "tricorn hat with skull and gold band, eyepatch over the left eye, hoop earring and heavy coat",
        ),
        "bench-poet": (
            bench_poet,
            "Mira the Poet",
            "plum locks with a green laurel and gold berries, rose blush, white quill with a gold nib",
        ),
        "bench-engineer": (
            bench_engineer,
            "Dana the Engineer",
            "amber hard hat with light-blue goggles pushed up, hi-vis vest stripes on slate",
        ),
        "bench-skeptic": (
            bench_skeptic,
            "Vic the Skeptic",
            "grey receding fringe, one raised brow, gold monocle with chain and tweed elbow patch",
        ),
        "bench-chef": (
            bench_chef,
            "Sal the Chef",
            "white toque with band, dark moustache, red neckerchief and yellow apron strings",
        ),
    }
)




def main():
    here = os.path.dirname(os.path.abspath(__file__))
    keys = sorted(sys.argv[1:]) or sorted(CHARACTERS)
    for key in keys:
        fn, name, desc = CHARACTERS[key]
        png = os.path.join(here, key + ".png")
        write_png(png, render(fn()))
        with open(os.path.join(here, key + ".prompt.md"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(
                f"# {name} avatar ({key})\n\n"
                f"Flat vector bust emblem for the bundled persona avatars "
                f"(starter trope pack T184, bench characters after owner "
                f"feedback): {desc}.\n\n"
                "Fully own-generated: drawn from primitive geometry (circles, rects, "
                "triangles, arcs, capsules) by `generate.py` in this directory — pure "
                "Python, no image model, no third-party art. The PNG is a build "
                "artifact of that script plus the per-persona palette in "
                "`packages/personas/starter-pack/src/tropes.ts`; regenerate in place "
                "with `python generate.py`.\n"
            )
        print(key, os.path.getsize(png), "bytes")


main()
