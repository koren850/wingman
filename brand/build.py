#!/usr/bin/env python3
"""Wingman brand: the final capybara ("Yuzu") mark and every derived file.

Final = Y1 drawing + tilted ear, closed "zen" eyes and a soft smile (no headset); Y7 night palette for dark mode;
Y10 answer card for the banner. Writes SVGs to brand/svg/ and a render job list for render.cjs.
Usage: python3 brand/build.py [path/to/Final.dc.html]   (optional design-canvas board)
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVG_DIR = os.path.join(HERE, "svg")
PNG_DIR = os.path.join(HERE, "png")
FONT = "'Baloo 2', 'Arial Rounded MT Bold', system-ui, sans-serif"   # body text (tagline, labels)
WORD = "'Unbounded', 'Arial Black', system-ui, sans-serif"           # the "wingman" wordmark
FONT_CSS = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;800&family=Unbounded:wght@700&display=swap"


def el(n, inner="", **a):
    s = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in a.items())
    return f"<{n}{s}>{inner}</{n}>"
def circ(x, y, r, fill, **k): return el("circle", cx=x, cy=y, r=r, fill=fill, **k)
def ell(x, y, rx, ry, fill, **k): return el("ellipse", cx=x, cy=y, rx=rx, ry=ry, fill=fill, **k)
def rect(x, y, w, h, rx, fill, **k): return el("rect", x=x, y=y, width=w, height=h, rx=rx, fill=fill, **k)
def path(d, fill="none", **k): return el("path", d=d, fill=fill, **k)
def stroke(d, col, sw, **k): return path(d, stroke=col, stroke_width=sw, stroke_linecap="round", stroke_linejoin="round", **k)


DAY = dict(ear="#6B4423", earin="#8A5A33", head="#9A6B3F", muz="#B98A5E", ink="#3B2414", blush="#E9967A",
           brow="#B07C4C", yuzu="#F59E0B", dot="#D97706", hlt="#FCD34D", leaf="#16A34A", leafd="#0F7A36",
           hs="#2B3A55", hs2="#7FB2E5", body="#7A5230", glow=None)
NIGHT = dict(ear="#4F3320", earin="#6A4529", head="#85593A", muz="#A8794F", ink="#24150B", blush="#E9967A",
             brow="#A8794F", yuzu="#FFA726", dot="#FF9A2E", hlt="#FFD98A", leaf="#4ADE80", leafd="#16A34A",
             hs="#9FC3E8", hs2="#2B3A55", body="#6B4528", glow="#FFB84D")
INK, CREAM, MINT, NAVY, NAVY2 = "#3B2414", "#FEF7EC", "#CDE8D8", "#12263A", "#0B1826"

MARK_VB = (34, 6, 132, 168)   # head + ears + yuzu
_uid = [0]
def uid(p):
    _uid[0] += 1
    return f"{p}{_uid[0]}"


def glow_defs(c, gid):
    return el("defs", el("radialGradient",
        el("stop", offset="0", stop_color=c["glow"], stop_opacity="0.85")
        + el("stop", offset="0.45", stop_color=c["dot"], stop_opacity="0.3")
        + el("stop", offset="1", stop_color=c["dot"], stop_opacity="0"), id=gid, cx="0.5", cy="0.5", r="0.5"))


FACE = "zen"   # final face; others kept for comparison
TEETH = "none"   # "none" | "small" | "one" | "big"
def teeth(c, y=151, kind=None):
    kind = kind or TEETH
    if kind == "none":
        return ""
    if kind == "small":   # two tiny soft teeth tucked under the smile
        return rect(96.6, y + 0.5, 3.4, 4.6, 1.2, "#FFF8EE") + rect(100, y + 0.5, 3.4, 4.6, 1.2, "#FFF8EE") + stroke(f"M100 {y+0.8} V{y+4.6}", c["muz"], 0.8)
    if kind == "one":     # a single little tooth
        return rect(97.5, y + 0.5, 5, 5, 1.6, "#FFF8EE")
    return rect(94, y, 6, 8, 1.5, "#FFFFFF", stroke=c["ink"], stroke_width=1.6) + rect(100, y, 6, 8, 1.5, "#FFFFFF", stroke=c["ink"], stroke_width=1.6)
def face_full(c, kind):
    s = ell(86, 128, 6, 4, c["ink"]) + ell(114, 128, 6, 4, c["ink"])
    blush = circ(64, 120, 8, c["blush"], opacity="0.5") + circ(136, 120, 8, c["blush"], opacity="0.5")
    if kind == "zen":        # eyes closed, content; tiny buck teeth
        s += stroke("M66 98 Q77 106 88 98", c["ink"], 5) + stroke("M112 98 Q123 106 134 98", c["ink"], 5)
        s += teeth(c) + stroke("M90 150 Q100 154 110 150", c["ink"], 3.5) + blush
    elif kind == "sleepy":   # heavy lids, eyes half open, lopsided grin
        for cx in (77, 123):
            s += circ(cx, 101, 7, c["ink"]) + circ(cx + 2.5, 103, 1.8, "#FFFFFF")
            s += rect(cx - 12, 86, 24, 14.5, 2, c["head"]) + stroke(f"M{cx-10} 100.5 Q{cx} 102.5 {cx+10} 100.5", c["ink"], 3.5)
        s += teeth(c, 150) + stroke("M89 150 Q101 155 112 147", c["ink"], 3.5) + blush
    elif kind == "dots":     # deadpan dot eyes far apart, classic capy meme
        s += circ(72, 99, 5, c["ink"]) + circ(128, 99, 5, c["ink"]) + circ(73.5, 97.5, 1.4, "#FFFFFF") + circ(129.5, 97.5, 1.4, "#FFFFFF")
        s += teeth(c, 150) + stroke("M91 150 H109", c["ink"], 3.5) + blush
    elif kind == "derp":     # one eye closed, one sleepy
        s += stroke("M66 98 Q77 106 88 98", c["ink"], 5)
        s += circ(123, 101, 7, c["ink"]) + circ(125.5, 103, 1.8, "#FFFFFF") + rect(111, 86, 24, 14.5, 2, c["head"]) + stroke("M113 100.5 Q123 102.5 133 100.5", c["ink"], 3.5)
        s += teeth(c) + stroke("M88 149 Q100 155 112 150", c["ink"], 3.5) + blush
    return s

def capy(c, lv="full", body=False, headset=False, face=None):
    face = face or FACE
    """lv: full (detailed), m32 (simplified), m16 (tiny). Drawn in a 200x200 space.
    headset=False: the final logo has none (kept as an option)."""
    s = ""
    if c["glow"] and lv == "full":
        g = uid("glow")
        s += glow_defs(c, g) + circ(100, 42, 48, f"url(#{g})")
    if body:
        s += ell(100, 162, 72, 30, c["body"])
    band = {"full": 7, "m32": 9, "m16": 12}[lv]
    if headset:
        s += path("M35 92 C31 34 68 31 100 31 C132 31 169 34 165 92", stroke=c["hs"], stroke_width=band, stroke_linecap="round")
    # ears: left round, right tilted up (listening)
    s += circ(56, 62, 13, c["ear"]) + el("ellipse", cx=148, cy=57, rx=11, ry=15, fill=c["ear"], transform="rotate(22 148 57)")
    if lv != "m16":
        s += circ(56, 63, 6.5, c["earin"]) + el("ellipse", cx=148, cy=58, rx=5.5, ry=9, fill=c["earin"], transform="rotate(22 148 58)")
    s += rect(40, 52, 120, 120, 54, c["head"]) + rect(56, 112, 88, 56, 28, c["muz"])
    if lv == "full":
        s += ell(86, 70, 22, 9, c["brow"], opacity="0.5")
        s += face_full(c, face)
    elif lv == "m32":
        s += stroke("M66 97 Q77 106 88 97", c["ink"], 7) + stroke("M112 97 Q123 106 134 97", c["ink"], 7)
        s += ell(86, 130, 6, 4, c["ink"]) + ell(114, 130, 6, 4, c["ink"])
    else:
        s += stroke("M64 96 Q77 108 90 96", c["ink"], 10) + stroke("M110 96 Q123 108 136 96", c["ink"], 10)
    # yuzu on top of the band
    if lv == "full":
        s += ell(100, 42, 20, 18.5, c["yuzu"]) + circ(93, 36, 4, c["hlt"])
        s += "".join(circ(x, y, 1.1, c["dot"], opacity="0.6") for x, y in ((108, 48), (101, 52), (112, 40)))
        s += path("M100 24 Q110 10 124 18 Q112 26 100 24 Z", c["leaf"]) + stroke("M104 21.5 Q112 16.5 119.5 18", c["leafd"], 1.4)
    elif lv == "m32":
        s += circ(100, 40, 22, c["yuzu"]) + path("M100 20 Q112 4 128 14 Q114 24 100 20 Z", c["leaf"])
    else:
        s += circ(100, 38, 27, c["yuzu"]) + path("M100 14 Q114 -2 134 10 Q116 22 100 14 Z", c["leaf"])
    if not headset:
        return s
    # headset cups + mic
    cw = {"full": 15, "m32": 18, "m16": 22}[lv]
    s += rect(35.5 - cw / 2, 84, cw, 32, cw / 2, c["hs"]) + rect(164.5 - cw / 2, 84, cw, 32, cw / 2, c["hs"])
    if lv == "full":
        s += rect(31, 92, 4, 16, 2, c["hs2"]) + rect(165, 92, 4, 16, 2, c["hs2"])
    if lv != "m16":
        s += stroke("M165 114 Q166 150 141 150", c["hs"], 4 if lv == "full" else 6) + circ(136, 150, 5.5 if lv == "full" else 7, c["hs"])
    if lv == "full":
        s += circ(135, 149, 1.8, c["hs2"])
    return s


def tray_silhouette():
    """macOS menu-bar template: one colour, eyes cut out with a mask."""
    m = uid("m")
    shape = (circ(56, 62, 14, "#fff") + circ(144, 62, 14, "#fff") + rect(40, 52, 120, 120, 54, "#fff")
             + circ(100, 38, 27, "#fff") + path("M100 14 Q114 -2 134 10 Q116 22 100 14 Z", "#fff")
             + ell(78, 100, 10, 9, "#000") + ell(122, 100, 10, 9, "#000"))
    return el("defs", el("mask", rect(-20, -20, 240, 240, 0, "#000") + shape, id=m)) + rect(0, -10, 200, 200, 0, "#000", mask=f"url(#{m})")


def svg_doc(inner, vb, w, h, fonts=False):
    x, y, vw, vh = vb
    style = el("style", f"@import url('{FONT_CSS}');") if fonts else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{x} {y} {vw} {vh}">'
            + style + inner + "</svg>")


def fit(inner, vb, box_x, box_y, box_w, box_h):
    """Place content drawn in viewBox vb centred inside a box."""
    x, y, vw, vh = vb
    k = min(box_w / vw, box_h / vh)
    tx = box_x + (box_w - vw * k) / 2 - x * k
    ty = box_y + (box_h - vh * k) / 2 - y * k
    return el("g", inner, transform=f"translate({tx:.2f} {ty:.2f}) scale({k:.4f})")


def app_icon(night=True, mac=False):
    gid = uid("bg")
    if night:
        bgdef = el("defs", el("linearGradient", el("stop", offset="0", stop_color=NAVY) + el("stop", offset="1", stop_color=NAVY2),
                              id=gid, x1="0", y1="0", x2="0", y2="1"))
        fill, c = f"url(#{gid})", NIGHT
    else:
        bgdef, fill, c = "", MINT, DAY
    if mac:   # Apple grid: 824 tile inside 1024 with room for the shadow
        tile = rect(100, 100, 824, 824, 185, fill)
        box = (100 + 824 * 0.12, 100 + 824 * 0.1, 824 * 0.76, 824 * 0.8)
    else:
        tile = rect(0, 0, 1024, 1024, 230, fill)
        box = (1024 * 0.11, 1024 * 0.08, 1024 * 0.78, 1024 * 0.84)
    return bgdef + tile + fit(capy(c, "full"), MARK_VB, *box)


def lockup(dark=False):
    c = dict(NIGHT, glow=None) if dark else DAY
    txt = CREAM if dark else INK
    return (fit(capy(c, "full"), MARK_VB, 0, 0, 170, 180)
            + el("text", "wingman", x=186, y=126, font_family=WORD, font_size=112, font_weight=700, letter_spacing=-3, fill=txt))


def banner():
    """1200x630 share/README banner: capy + an answer card (Y10)."""
    s = rect(0, 0, 1200, 630, 0, CREAM) + circ(300, 330, 250, MINT)
    s += fit(capy(DAY, "full"), MARK_VB, 110, 110, 380, 420)
    s += rect(616, 186, 500, 220, 30, "#3B2414", opacity="0.08") + rect(606, 172, 500, 220, 30, "#FFFFFF")
    s += path("M616 300 L586 330 L636 316 Z", "#FFFFFF")
    s += rect(642, 206, 128, 38, 19, DAY["yuzu"]) + el("text", "ANSWER", x=706, y=232, text_anchor="middle", font_family=FONT, font_size=20, font_weight=800, fill="#FFFFFF", letter_spacing=2)
    s += rect(642, 270, 410, 18, 9, "#E9DFD2") + rect(642, 304, 360, 18, 9, "#E9DFD2") + rect(642, 338, 250, 18, 9, "#F3EBE1")
    s += el("text", "wingman", x=604, y=500, font_family=WORD, font_size=86, font_weight=700, letter_spacing=-2, fill=INK)
    s += el("text", "Calm help on every call.", x=606, y=556, font_family=FONT, font_size=36, font_weight=600, fill="#6B5240")
    return s


def build():
    os.makedirs(SVG_DIR, exist_ok=True)
    files = {
        "mark.svg": svg_doc(capy(DAY), MARK_VB, 264, 336),
        "mark-night.svg": svg_doc(capy(NIGHT), MARK_VB, 264, 336),
        "mark-32.svg": svg_doc(capy(DAY, "m32"), MARK_VB, 25, 32),
        "mark-16.svg": svg_doc(capy(DAY, "m16"), (30, -4, 140, 180), 16, 21),
        "icon.svg": svg_doc(app_icon(True), (0, 0, 1024, 1024), 1024, 1024),
        "icon-day.svg": svg_doc(app_icon(False), (0, 0, 1024, 1024), 1024, 1024),
        "icon-mac.svg": svg_doc(app_icon(True, mac=True), (0, 0, 1024, 1024), 1024, 1024),
        "tray-template.svg": svg_doc(tray_silhouette(), (30, -6, 140, 186), 16, 21),
        "lockup.svg": svg_doc(lockup(False), (0, 0, 840, 180), 840, 180, fonts=True),
        "lockup-dark.svg": svg_doc(lockup(True), (0, 0, 840, 180), 840, 180, fonts=True),
        "banner.svg": svg_doc(banner(), (0, 0, 1200, 630), 1200, 630, fonts=True),
    }
    for name, body in files.items():
        with open(os.path.join(SVG_DIR, name), "w") as f:
            f.write(body + "\n")
    jobs = []
    def job(src, w, h, out): jobs.append(dict(svg=os.path.join(SVG_DIR, src), w=w, h=h, out=os.path.join(PNG_DIR, out)))
    for n in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        job("icon.svg", n, n, f"icon-{n}.png")
        job("icon-mac.svg", n, n, f"mac/icon-{n}.png")
    job("icon-day.svg", 512, 512, "icon-day-512.png")
    job("mark.svg", 400, 509, "mark-512.png")
    job("mark-night.svg", 400, 509, "mark-night-512.png")
    job("tray-template.svg", 16, 21, "trayTemplate.png")
    job("tray-template.svg", 32, 42, "trayTemplate@2x.png")
    job("lockup.svg", 1680, 360, "lockup.png")
    job("lockup-dark.svg", 1680, 360, "lockup-dark.png")
    job("banner.svg", 1200, 630, "banner.png")
    with open(os.path.join(HERE, "jobs.json"), "w") as f:
        json.dump(jobs, f, indent=1)
    return files


def board(files, out):
    """Design-canvas board showing the final set."""
    inline = lambda name, h: files[name].replace('<svg xmlns="http://www.w3.org/2000/svg" ', f'<svg style="height: {h}px; width: auto; display: block" ', 1)
    lab = lambda t: f'<div style="font-size: 14px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #8A5A2E">{t}</div>'
    tile = lambda bg, inner, w, h: f'<div style="width: {w}px; height: {h}px; border-radius: 32px; background: {bg}; display: flex; align-items: center; justify-content: center">{inner}</div>'
    h = '<div style="width: 2360px; height: 1100px; box-sizing: border-box; padding: 56px; background: #FEF7EC; font-family: \'Baloo 2\', system-ui, sans-serif; color: #3B2414; display: flex; flex-direction: column; gap: 32px">'
    h += '<div><div style="font-size: 44px; font-weight: 800; line-height: 1.1">Wingman · final logo</div><div style="font-size: 20px; color: #6B5240">Y1 drawing, sleepy "zen" face with buck teeth, no headset · Y7 night colors for dark mode · Y10 card for the banner</div></div>'
    h += '<div style="display: flex; gap: 40px">'
    h += f'<div style="display: flex; flex-direction: column; gap: 12px">{lab("Mark · day")}{tile(MINT, inline("mark.svg", 420), 500, 500)}</div>'
    h += f'<div style="display: flex; flex-direction: column; gap: 12px">{lab("Mark · night (dark mode)")}{tile(NAVY, inline("mark-night.svg", 420), 500, 500)}</div>'
    h += '<div style="flex: 1; display: flex; flex-direction: column; gap: 22px">'
    h += f'{lab("App icons · small sizes · menu bar")}<div style="display: flex; align-items: flex-end; gap: 28px">{inline("icon.svg", 180)}{inline("icon-day.svg", 180)}{inline("icon.svg", 64)}{inline("icon.svg", 32)}<div style="display: flex; align-items: flex-end; gap: 18px; background: #FFFFFF; border-radius: 16px; padding: 14px 18px">{inline("mark-32.svg", 34)}{inline("mark-16.svg", 18)}<div style="width: 1px; height: 30px; background: #E5DCCF"></div>{inline("tray-template.svg", 20)}</div></div>'
    h += f'{lab("Lockups")}<div style="display: flex; gap: 24px"><div style="background: #FFFFFF; border-radius: 24px; padding: 22px 28px">{inline("lockup.svg", 90)}</div><div style="background: {NAVY}; border-radius: 24px; padding: 22px 28px">{inline("lockup-dark.svg", 90)}</div></div>'
    h += f'{lab("Banner")}<div style="border-radius: 24px; overflow: hidden; width: 600px">{inline("banner.svg", 315)}</div>'
    h += '</div></div>'
    h += '<div style="display: flex; gap: 12px; align-items: center">' + "".join(
        f'<div style="width: 40px; height: 40px; border-radius: 11px; background: {c}; border: 1px solid rgba(0,0,0,0.08)"></div>' for c in (DAY["head"], DAY["yuzu"], DAY["leaf"], MINT, NAVY, INK)) + '<div style="font-size: 16px; color: #6B5240; margin-left: 8px">Capy brown, yuzu orange, leaf green, mint, night navy, cocoa · wordmark Unbounded Bold, text Baloo 2</div></div></div>'
    doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Wingman final logo</title>\n<script src="./support.js"></script>\n</head>\n<body>\n<x-dc>\n<helmet>\n'
           '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;800&amp;family=Unbounded:wght@700&amp;display=swap" rel="stylesheet">\n'
           '<style>\nbody{margin:0}\n</style>\n</helmet>\n' + h.replace(f"@import url('{FONT_CSS}');", "") + '\n</x-dc>\n'
           '<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":2360,"height":1100}}\'>\nclass Component extends DCLogic {\n  renderVals() { return {}; }\n}\n</script>\n</body>\n</html>\n')
    with open(out, "w") as f:
        f.write(doc)


if __name__ == "__main__":
    fs = build()
    if len(sys.argv) > 1:
        board(fs, sys.argv[1])
    print(f"wrote {len(fs)} SVGs to {SVG_DIR}")
