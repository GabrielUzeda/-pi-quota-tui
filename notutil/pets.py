#!/usr/bin/env python3
"""Pet virtual ANSI: geometria e bitmaps próprios, sem imagens ou dependências."""

import math

Color = tuple[int, int, int]
Canvas = list[list[Color | None]]
W, H = 84, 84
STATES = ("comemorando", "triste", "desesperado", "concentrado")
OUTLINE = (3, 8, 24)
BLUE = (0, 100, 245)
LIGHT = (16, 127, 255)
WHITE = (250, 252, 255)
TEAR = (14, 194, 255)
YELLOW = (255, 224, 40)
CORAL = (217, 119, 87)
CORAL_DARK = (176, 88, 62)
CORAL_EDGE = (93, 44, 30)
GREEN = (16, 163, 127)
GREEN_DARK = (10, 124, 97)
GREEN_EDGE = (7, 78, 62)
NIGHT = (17, 18, 23)
NIGHT_SHADE = (10, 11, 15)
IVORY = (249, 245, 239)
IVORY_SHADE = (205, 200, 197)

# Perfil desenhado à mão: topo arredondado, laterais inclinadas e vão entre pernas.
BODY = [
    (-3, 0), (3, 0), (6, 2), (9, 6), (12, 12), (15, 19),
    (18, 28), (20, 36), (22, 46), (24, 50), (23, 52),
    (16, 52), (13, 49), (10, 44), (6, 41), (-6, 41),
    (-10, 44), (-13, 49), (-16, 52), (-23, 52), (-24, 50),
    (-22, 46), (-20, 36), (-18, 28), (-15, 19), (-12, 12),
    (-9, 6), (-6, 2),
]
# (salto, escala vertical, escala horizontal, inclinação) para F1..F6.
POSES = {
    "comemorando": [(0, .94, 1, 0), (0, .86, 1.06, 0), (-6, 1.02, .98, -.03),
                    (-10, 1, .98, 0), (-4, .98, 1, .03), (0, .90, 1.03, 0)],
    "triste": [(0, .87, 1.03, 0), (0, .86, 1.03, -.01), (0, .84, 1.04, -.02),
               (0, .83, 1.04, 0), (0, .84, 1.04, .02), (0, .86, 1.03, .01)],
    "desesperado": [(0, .94, 1, 0), (0, .92, 1.02, -.08), (-1, .95, .99, -.04),
                    (0, .94, 1, 0), (0, .92, 1.02, .08), (-1, .95, .99, .04)],
    "concentrado": [(0, .91, 1.02, 0), (0, .92, 1.02, 0), (0, .92, 1.02, 0),
                    (0, .91, 1.02, 0), (0, .90, 1.03, 0), (0, .90, 1.03, 0)],
}


def polygon(points):
    """Rasterização por scanline: degraus de pixel, sem antialiasing."""
    mask = set()
    for y in range(math.floor(min(p[1] for p in points)),
                   math.ceil(max(p[1] for p in points)) + 1):
        cuts = []
        for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1], strict=True):
            if (ay <= y < by) or (by <= y < ay):
                cuts.append(ax + (y - ay) * (bx - ax) / (by - ay))
        cuts.sort()
        for a, b in zip(cuts[::2], cuts[1::2], strict=True):
            mask.update((x, y) for x in range(math.ceil(a), math.floor(b) + 1))
    return mask


def arm(points, radius: float = 3):
    """Bézier quadrática rasterizada; masqueamento comum evita costura no ombro."""
    mask = set()
    for i in range(33):
        t = i / 32
        x = (1-t)**2*points[0][0] + 2*t*(1-t)*points[1][0] + t*t*points[2][0]
        y = (1-t)**2*points[0][1] + 2*t*(1-t)*points[1][1] + t*t*points[2][1]
        for py in range(math.floor(y-radius), math.ceil(y+radius)+1):
            for px in range(math.floor(x-radius), math.ceil(x+radius)+1):
                if (px-x)**2 + (py-y)**2 <= radius**2:
                    mask.add((px, py))
    return mask


def thermal(x, y):
    # A cor quente fica à direita; o azul assume TODO o rosto inferior.
    d = math.hypot((x-6)*.72, (y-2)*1.08)
    stops = [(4, (255, 58, 12)), (8, (255, 122, 12)),
             (12, (255, 218, 25)), (16, (143, 208, 32)),
             (20, (27, 184, 133)), (26, BLUE)]
    for limit, color in stops:
        if d <= limit:
            return color
    return BLUE


PAL = {"P": OUTLINE, "K": OUTLINE, "W": WHITE, "R": (240, 42, 48),
       "M": (55, 8, 20), "C": TEAR, "S": (206, 250, 255),
       "Y": YELLOW, "G": (102, 156, 195)}
ARCH = ["..KKK..", ".KKKKK.", "KK...KK", "K.....K"]
ROUND = ["..KKK..", ".KWWWK.", "KWWWWWK", "KWWPWWK", "KWWPWWK", ".KWWWK.", "..KKK.."]
WIDE = [".KKKKK.", "KWWWWWK", "KWWPWWK", "KWWPWWK", "KWWPWWK", ".KKKKK."]
STAR = ["...K...", "..KYK..", "KKYYYKK", ".KYYYK.", ".KYYYK.", "KYK.KYK"]
FOCUS = ["KK.....", ".KKKKK.", "KWWWWWK", "KWWPWWK", ".KKKKK."]
SAD = [".....KK", ".KKKKKK", "KWWWWWK", "KWWPWWK", ".KKKKK."]
CLOSED = ["K.....K", ".KKKKK.", "..KKK.."]
SQUEEZE = ["KK.....", ".KKK...", "..KKKK.", ".KKK...", "KK....."]


def bitmap(canvas, x, y, rows, palette=PAL):
    for ry, row in enumerate(rows):
        for rx, ch in enumerate(row):
            if ch in palette and 0 <= y+ry < H and 0 <= x+rx < W:
                canvas[y+ry][x+rx] = palette[ch]


def tears(stamp, anchors, frame, streaming=False):
    """Filetes presos à pálpebra; crescimento e recuo fecham o ciclo de choro."""
    length = (2, 4, 6, 7, 6, 4)[frame] + (3 if streaming else 0)
    for x, y in anchors:
        stamp(x, y, ["CSC"] * length + ["CCC", ".C."])


def composite(canvas, layer, inverse, origin):
    """É o pixel de destino que busca a cor: ampliar/girar não abre buracos."""
    for py in range(H):
        for px in range(W):
            x, y = inverse(px, py)
            lx, ly = round(x)+origin[0], round(y)+origin[1]
            if 0 <= lx < W and 0 <= ly < H and layer[ly][lx] is not None:
                canvas[py][px] = layer[ly][lx]


def _face_layer(state, frame, expr, compact=False, pupil=OUTLINE, compact_pupil=WHITE, cx=40):
    """Rosto em camada própria, para compor junto com o corpo de qualquer pet."""
    layer: Canvas = [[None]*W for _ in range(H)]

    def stamp(x, y, rows):
        bitmap(layer, x+cx, y+8, rows, PAL | {"P": compact_pupil if compact else pupil})

    def eyes(left, right=None, y=25):
        stamp(-12, y, left)
        stamp(6, y, right if right is not None else [r[::-1] for r in left])

    mouth = ["KKKKKKKKK", "KMMMMMMMK", "KMMMMMMMK",
             "KMRRRRRMK", ".KRRRRRK.", "..KKKKK.."]
    if state == "comemorando":
        happy = ARCH if expr == 0 and frame in (1, 4) else ROUND
        eyes([happy, WIDE, ARCH, STAR][expr], y=24)
        stamp(-4, 34, mouth if expr != 2 else
              ["KKKKKKKKK", "KMMMMMMMK", "KMRRRRRMK", "KRRRRRRRK", ".KKKKKKK."])
    elif state == "triste":
        blink = frame == 3 and expr == 0
        eyes(CLOSED if blink or expr in (2, 3) else SAD, y=26)
        stamp(-4, 36, ["..KKKKK..", ".KK...KK.", "KK.....KK"])
        if expr in (1, 2) or (expr != 3 and frame >= 1):
            tear_y = 29 if blink or expr == 2 else 31
            anchors = [(-11, tear_y)] if expr == 1 else [(-11, tear_y), (9, tear_y)]
            tears(stamp, anchors, frame, streaming=expr == 2)
    elif state == "desesperado":
        squeezed = expr == 3 or (expr == 0 and frame in (1, 3, 4, 5))
        eyes(SQUEEZE if squeezed else WIDE, y=23)
        if expr == 3:
            stamp(-4, 35, ["..KKKKK..", ".KRRRRRK.", "KK.....KK"])
        elif expr == 2:
            stamp(-3, 35, [".KKKKK.", "KKMMMKK", ".KRRRK.", "..KKK.."])
        else:
            stamp(-6, 33 if expr == 1 else 34, ["...KKKKKKK...", "..KKMMMMMKK..",
                          ".KKMMMMMMMKK.", "KKMMMMMMMMMKK",
                          "KKMRRRRRRRMKK", "KKK.......KKK"])
    else:
        focus = ["KKKKKKK", "KWWWWWK", "KWWPWWK", ".KKKKK."] if expr == 1 else FOCUS
        eyes(CLOSED if (expr == 0 and frame in (3, 4)) or expr == 2 else focus,
             y=26 if expr == 2 else 25)
        if expr == 3:
            stamp(-2, 34, ["KKKKK"])
        else:
            stamp(-2, 34, ["..K..", ".KKK.", "K.K.K"])
    return layer


def face(canvas, state, frame, expr, inverse, compact=False, pupil=OUTLINE,
         compact_pupil=WHITE):
    """Rosto alinhado ao corpo, reamostrado na mesma grade da silhueta."""
    composite(canvas, _face_layer(state, frame, expr, compact, pupil, compact_pupil),
              inverse, (40, 8))


def render_mascot_frame(state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    if state not in STATES or not 0 <= frame_idx < 6 or not 0 <= expr_idx < 4:
        raise ValueError("estado, frame (0..5) ou expressão (0..3) inválido")
    f = frame_idx
    jump, sy, sx, tilt = POSES[state][f]
    top = 73 + jump - 52*sy

    def transform(x, y):
        return round(42+x*sx+(26-y)*tilt), round(top+y*sy)

    def inverse(px, py):
        y = (py-top)/sy
        return (px-42-(26-y)*tilt)/sx, y

    canvas: Canvas = [[None]*W for _ in range(H)]
    for y in range(74, 77):
        half = (18 if y != 75 else 22) + round(jump*.5)
        for x in range(42-half, 43+half):
            canvas[y][x] = (43, 45, 56)

    body = polygon(BODY)
    back = set()
    front = set()
    for side in (-1, 1):
        if state == "comemorando":
            # Antecipação, impulso, ápice e retorno ao repouso.
            ends = [
                ((-27, 33), (27, 33)),
                ((-27, 39), (27, 39)),
                ((-27, 21), (27, 23)),
                ((-27, 16), (27, 16)),
                ((-27, 24), (27, 22)),
                ((-27, 35), (27, 35)),
            ]
            end = ends[f][0 if side < 0 else 1]
            elbow = (side*29, (30+end[1])/2+3)
            back |= arm([(side*16, 30), elbow, end], 3)
        elif state == "triste":
            back |= arm([(side*17, 32), (side*23, 39),
                         (side*22, 47)], 3.4)
        elif state == "desesperado":
            back |= arm([(side*18, 30), (side*28, 23),
                         (side*14, (13, 11, 12, 13, 11, 12)[f])], 3.5)
        else:
            front |= arm([(side*18, 36), (side*26, 45),
                          (side*4, 40)], 4)

    def paint(mask, color):
        # Transformar a máscara ANTES de preencher evita buracos ao esticar.
        corners = [transform(x, y) for x, y in mask]
        points = {}
        for py in range(min(y for _, y in corners), max(y for _, y in corners)+1):
            for px in range(min(x for x, _ in corners), max(x for x, _ in corners)+1):
                x, y = inverse(px, py)
                local = round(x), round(y)
                if local in mask:
                    points[px, py] = local
        for x, y in points:
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (1, -1), (-1, 1), (1, 1)):
                if (x+dx, y+dy) not in points and 0 <= x+dx < W and 0 <= y+dy < H:
                    canvas[y+dy][x+dx] = OUTLINE
        for (px, py), (x, y) in points.items():
            if 0 <= px < W and 0 <= py < H:
                edge = (x-2, y) not in mask or (x, y+2) not in mask
                c = color(x, y)
                canvas[py][px] = tuple(round(v*.72) for v in c) if edge and x < 0 else c

    paint(body | back, lambda x, y: thermal(x, y) if (x, y) in body
          else LIGHT if y < 25 else BLUE)
    face(canvas, state, f, expr_idx, inverse, compact)
    if front:
        paint(front, lambda x, y: LIGHT if y < 39 else BLUE)

    def effect(x, y, rows):
        px, py = transform(x, y)
        bitmap(canvas, px, py, rows)

    sparkle = ["..Y..", "..Y..", "YYYYY", "..Y..", "..Y.."]
    if state == "comemorando" and f >= 4:
        effect(-29, -1, sparkle)
        if f == 5:
            effect(0, -7, sparkle)
            effect(17, -5, ["CY", "YC"])
    elif state == "desesperado":
        if f == 1:
            for side in (-1, 1):
                effect(side*28, 8, ["WW", ".W", "W."])
        else:
            for x, y in [(-23, 2), (-13, -5), (10, -4), (24, 3)]:
                effect(x, y+(f%2)*2, [".C.", "CSC", ".CC"])
    elif state == "concentrado" and f in (3, 4):
        effect(21, -2, sparkle)
    return canvas


def render_monitor_frame(state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    """Monitor branco da segunda referência: peças e rosto desenhados à mão."""
    if state not in STATES or not 0 <= frame_idx < 6 or not 0 <= expr_idx < 4:
        raise ValueError("estado, frame (0..5) ou expressão (0..3) inválido")
    f, e = frame_idx, expr_idx
    black = (3, 3, 5)
    ivory = (249, 245, 239)
    shade = (205, 200, 197)
    screen = (19, 20, 24)
    jumps = {
        "comemorando": [0, 0, -5, -9, -4, 0],
        "triste": [0, 0, 0, 0, 0, 0],
        "desesperado": [0, 0, -1, 0, 0, -1],
        "concentrado": [0, 0, 0, 0, 0, 0],
    }
    angles = {
        "comemorando": [0, -3, -6, 0, 6, 3],
        "triste": [0, -1, -2, 0, 2, 1],
        "desesperado": [0, -8, -4, 0, 8, 4],
        "concentrado": [0, 0, 0, 0, 0, 0],
    }
    jump = jumps[state][f]
    angle = math.radians(angles[state][f])
    co, si = math.cos(angle), math.sin(angle)
    scale_y = (1, .98, .96, .95, .96, .98)[f] if state == "triste" else 1
    top = 73 + jump - 44*scale_y

    def transform(x, y):
        # Pivô central do monitor: corpo, tela, mãos e pés giram juntos.
        dx, dy = x, (y-20)*scale_y
        return round(42+dx*co-dy*si), round(top+20*scale_y+dx*si+dy*co)

    layer: Canvas = [[None]*W for _ in range(H)]

    def fill(mask, color):
        for x, y in mask:
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (1, -1), (-1, 1), (1, 1)):
                px, py = x+40+dx, y+12+dy
                if (x+dx, y+dy) not in mask and 0 <= px < W and 0 <= py < H:
                    layer[py][px] = black
        for x, y in mask:
            px, py = x+40, y+12
            if 0 <= px < W and 0 <= py < H:
                edge = (x-1, y) not in mask or (x, y+1) not in mask
                layer[py][px] = shade if edge else color

    def stamp(x, y, rows):
        bitmap(layer, x+40, y+12, rows, {"P": WHITE if compact else screen, "W": WHITE, "C": TEAR,
                                       "S": (200, 249, 255), "Y": YELLOW})

    front = set()
    for side in (-1, 1):
        if state == "comemorando":
            endpoints = [
                ((-25, 21), (25, 21)),
                ((-25, 27), (25, 27)),
                ((-25, 7), (25, 9)),
                ((-25, 0), (25, 0)),
                ((-25, 10), (25, 8)),
                ((-25, 23), (25, 23)),
            ]
            end = endpoints[f][0 if side < 0 else 1]
            fill(arm([(side*15, 20), (side*24, 24), end], 2.6), ivory)
        elif state == "triste":
            fill(arm([(side*15, 24), (side*22, 32),
                      (side*20, 37)], 3), ivory)
        elif state == "desesperado":
            fill(arm([(side*16, 25), (side*26, 18), (side*17, 5)], 3), ivory)
        else:
            front |= arm([(side*16, 27), (side*24, 36),
                          (side*4, 33)], 3.4)
        # Tornozelos e sapatos separados do gabinete.
        foot = [(side*x, y) for x, y in
                [(8, 33), (13, 33), (14, 38), (18, 39),
                 (18, 43), (7, 43), (7, 39)]]
        fill(polygon(foot), ivory)

    body = {(x, y) for y in range(33) for x in range(-16, 17)
            if not (abs(x) == 16 and y in (0, 32))}
    fill(body, ivory)
    for y in range(7, 25):
        for x in range(-9, 10):
            layer[y+12][x+40] = screen

    if state == "comemorando":
        closed = e == 2 or (e == 0 and f in (1, 4))
        eye = [".WWW.", "W...W"] if closed else [
            ".WWW.", "WWWWW", "WWPWW", "WWPWW", ".WWW."]
        if e == 1:
            eye = [".WWW.", "W...W", "WWPWW", "WWPWW", "W...W", ".WWW."]
        for x in (-8, 4):
            stamp(x, 11, ["..Y..", ".YYY.", "YYYYY", ".YYY.", "..Y.."] if e == 3 else eye)
        stamp(-5, 20, ["W.........W", ".WWWWWWWWW."] if e != 2 else
              ["WWWWWWWWWWW", ".WWWWWWWWW.", "..WWWWWWW..", "...WWWWW..."])
    elif state == "triste":
        eyes = [
            ["...WW", "WWWWW", "WWPWW", ".WWW."],
            ["WWWWW", "WWPWW", "WWPWW", ".WWW."],
            ["W...W", ".WWW."],
            [".....", "WWWWW"],
        ]
        left = ["W...W", ".WWW."] if e == 0 and f == 3 else eyes[e]
        stamp(-8, 13, left)
        stamp(4, 13, [row[::-1] for row in left])
        stamp(-3, 22, [".WWWWW.", "W.....W"])
        if e != 3:
            tear_y = 15 if e == 2 or (e == 0 and f == 3) else 17
            tears(stamp, [(-7, tear_y), (5, tear_y)], f, streaming=e == 2)
    elif state == "desesperado":
        if e != 3:
            stamp(-3, 20, [".WWWWW.", "WW...WW", ".WWWWW."])
        if e in (0, 2):
            oval = ["WWWWW", "WWPWW", "WWPWW", "WWWWW"] if e == 0 else ["WWWWW", "WWPWW", "WWWWW"]
            stamp(-8, 12 if e == 0 else 14, oval)
            stamp(4, 12 if e == 0 else 14, oval)
        elif e == 1:
            for x in (-7, 5):
                stamp(x, 12, ["W.W", ".W.", "W.W"])
        else:
            stamp(-5, 12, ["W.W.....W.W", ".W.......W.", "W.W.....W.W"])
            stamp(-5, 19, ["...WWW...", ".WW...WW.", "W.......W"])
    else:
        lids = [
            ["WW.......WW", "..WW...WW.."],
            ["WWW.....WWW", "..W.....W.."],
            ["W.........W", ".WWW...WWW."],
            ["W.........W", ".WW.....WW.", "...WW.WW..."],
        ]
        stamp(-5, 14, lids[e])
        stamp(-2, 21, [".WWW."] if e == 1 else ["WWWWW"])
    if front:
        fill(front, ivory)

    canvas: Canvas = [[None]*W for _ in range(H)]
    # Faixa plana, sem os pixels isolados nas pontas superior/inferior da elipse.
    for y in range(74, 77):
        half = (18 if y != 75 else 22) + min(0, jump)
        for x in range(42-half, 43+half):
            canvas[y][x] = (43, 45, 56)
    # Amostragem inversa mantém a moldura e a tela fechadas durante a rotação.
    def inverse(px, py):
        dx, dy = px-42, py-(top+20*scale_y)
        return dx*co+dy*si, 20+(-dx*si+dy*co)/scale_y

    composite(canvas, layer, inverse, (40, 12))

    def effect(x, y, rows, palette=PAL):
        px, py = transform(x, y)
        bitmap(canvas, px, py, rows, palette)

    if state == "comemorando" and f >= 4:
        effect(-26, -5, ["..Y..", ".YYY.", "YYYYY", ".YYY.", "..Y.."])
        effect(24, -8, [".Y.", "YYY", ".Y."])
        effect(9, -6, ["R.", ".R", "R."])
    elif state == "desesperado":
        for side in (-1, 1):
            if f in (1, 3):
                effect(side*29, 6, ["W.", ".W", "W.", ".W"])
            else:
                effect(side*22, -8, [".C.", "CSC", ".CC"])
    elif state == "concentrado" and f in (3, 4):
        effect(22, 6, ["C", "C", "S"])
    return canvas


# --- Mascotes dos demais provedores: estrela coral, bolha verde e terminal ---

KNOT = [
    "..WWW.WWW..",
    ".W...W...W.",
    "W...WWW...W",
    "W..W...W..W",
    "W...WWW...W",
    ".W...W...W.",
    "..WWW.WWW..",
]
GLYPH = [
    ".WWW.....WWW.",
    "W...W...W...W",
    "W...W...W...W",
    ".WWW.WWW.WWW.",
    "....W...W....",
    ".WWW.WWW.WWW.",
    "W...W...W...W",
    "W...W...W...W",
    ".WWW.....WWW.",
]


def _circulo(raio):
    return {(x, y) for y in range(-raio, raio+1) for x in range(-raio, raio+1)
            if x*x+y*y <= raio*raio}


def _retangulo(y0, x0, y1, x1, r):
    mascara = set()
    for y in range(y0, y1+1):
        for x in range(x0, x1+1):
            dx = max(x0+r-x, 0, x-(x1-r))
            dy = max(y0+r-y, 0, y-(y1-r))
            if dx*dx+dy*dy <= r*r:
                mascara.add((x, y))
    return mascara


def _pintar_camada(layer, mascara, cor, sombra=None, contorno=None):
    """Preenche a silhueta local com sombra de borda e contorno, sem vazar."""
    ox, oy = 42, 44
    for x, y in mascara:
        px, py = x+ox, y+oy
        if not 0 <= px < W or not 0 <= py < H:
            continue
        borda = any((x+dx, y+dy) not in mascara
                    for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2)))
        layer[py][px] = sombra if borda and sombra else cor
    if contorno:
        for x, y in mascara:
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                px, py = x+dx+ox, y+dy+oy
                if (0 <= px < W and 0 <= py < H
                        and (x+dx, y+dy) not in mascara and layer[py][px] is None):
                    layer[py][px] = contorno


def _corpo_estrela(layer, state, f, e):
    mascara = _circulo(16)
    crescer = (0, 1, 2, 3, 2, 1)[f] if state == "comemorando" else 0
    giro = (5 if f % 2 else -5) if state == "desesperado" else 0
    for i in range(12):
        a = math.radians(i*30+giro)
        co, si = math.cos(a), math.sin(a)
        r = 27+crescer+(2 if i % 2 else 0)
        nx, ny = -si*4.5, co*4.5
        tx, ty = -si*2.2, co*2.2
        mascara |= polygon([(9*co+nx, 9*si+ny), (r*co+tx, r*si+ty),
                            (r*co-tx, r*si-ty), (9*co-nx, 9*si-ny)])
    _pintar_camada(layer, mascara, CORAL, CORAL_DARK, CORAL_EDGE)


def _corpo_bolha(layer, state, f, e):
    _pintar_camada(layer, _circulo(26), GREEN, GREEN_DARK, GREEN_EDGE)
    bitmap(layer, 37, 53, KNOT, {"W": WHITE})


def _corpo_terminal(layer, state, f, e):
    _pintar_camada(layer, _retangulo(-24, -24, 24, 24, 9), IVORY, IVORY_SHADE, OUTLINE)
    _pintar_camada(layer, _retangulo(-21, -21, 21, 21, 7), NIGHT, NIGHT_SHADE)
    bitmap(layer, 36, 52, GLYPH, {"W": IVORY})


_CORPO = {"claude": _corpo_estrela, "openai": _corpo_bolha,
          "commandcode": _corpo_terminal}
_PUPILA = {"claude": OUTLINE, "openai": OUTLINE, "commandcode": NIGHT}
_PUPILA_COMPACTA = {"claude": WHITE, "openai": WHITE, "commandcode": (60, 62, 70)}
_MOTION = {
    "claude": {
        "comemorando": ([0, -8, -16, -6, 6, 2], [0, -3, -7, -10, -4, 0],
                        [1, .97, 1.02, .99, .98, 1]),
        "triste": ([-2, -4, -6, -4, -2, -1], [0, 0, 0, 0, 0, 0],
                   [.96, .95, .94, .93, .94, .95]),
        "desesperado": ([6, -6, 5, -5, 6, 0], [0, 0, -1, 0, 0, -1],
                        [1, .99, 1, .99, 1, 1]),
        "concentrado": ([0, 3, 6, 8, 6, 3], [0, 0, 0, 0, 0, 0],
                        [.98, .99, 1, .99, .98, .97]),
    },
    "openai": {
        "comemorando": ([0, -6, -12, -3, 6, 2], [0, -4, -9, -13, -5, 0],
                        [1, .96, 1.03, .98, .97, 1]),
        "triste": ([-2, -4, -5, -3, -1, 0], [0, 0, 0, 0, 0, 0],
                   [.96, .95, .94, .95, .96, .97]),
        "desesperado": ([6, -6, 4, -4, 6, 0], [0, 0, -1, 0, 0, -1],
                        [1, .99, 1, .99, 1, 1]),
        "concentrado": ([0, -2, -4, -6, -4, -2], [0, 0, 0, 0, 0, 0],
                        [.98, .99, 1, .99, .98, .97]),
    },
    "commandcode": {
        "comemorando": ([0, -4, -8, -2, 4, 2], [0, -3, -7, -9, -4, 0],
                        [1, .97, 1.02, .99, .98, 1]),
        "triste": ([-1, -2, -3, -2, -1, 0], [0, 0, 0, 0, 0, 0],
                   [.96, .95, .94, .95, .96, .97]),
        "desesperado": ([7, -7, 5, -5, 7, 0], [0, 0, -1, 0, 0, -1],
                        [1, .99, 1, .99, 1, 1]),
        "concentrado": ([0, 2, 4, 6, 4, 2], [0, 0, 0, 0, 0, 0],
                        [.98, .99, 1, .99, .98, .97]),
    },
}


def _sombra(canvas, salto):
    for y in range(74, 77):
        half = (18 if y != 75 else 22)+min(0, round(salto*.5))
        for x in range(42-half, 43+half):
            canvas[y][x] = (43, 45, 56)


def _posicao(angulo, salto, squash, x, y):
    a = math.radians(angulo)
    co, si = math.cos(a), math.sin(a)
    y *= squash
    return 42+round(x*co-y*si), 44+salto+round(x*si+y*co)


def _efeitos(state, f, angulo, salto, squash, canvas):
    def stamp(x, y, rows, palette=PAL):
        px, py = _posicao(angulo, salto, squash, x, y)
        bitmap(canvas, px, py, rows, palette)
    faisca = ["..Y..", ".YYY.", "YYYYY", ".YYY.", "..Y.."]
    if state == "comemorando" and f >= 4:
        stamp(-33, -14, faisca)
        if f == 5:
            stamp(32, -16, ["Y.", "YY"])
    elif state == "desesperado":
        for lado in (-1, 1):
            if f in (1, 3):
                stamp(lado*32, 4, ["W.", ".W", "W.", ".W"])
            else:
                stamp(lado*30, -10, [".C.", "CSC", ".CC"])
    elif state == "concentrado" and f in (3, 4):
        stamp(30, -6, faisca)


def render_procedural_frame(pet_name, state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    if (pet_name not in _CORPO or state not in STATES or not 0 <= frame_idx < 6
            or not 0 <= expr_idx < 4):
        raise ValueError("pet, estado, frame (0..5) ou expressão (0..3) inválido")
    f, e = frame_idx, expr_idx
    layer: Canvas = [[None]*W for _ in range(H)]
    _CORPO[pet_name](layer, state, f, e)
    rosto = _face_layer(state, f, e, compact, _PUPILA[pet_name],
                        _PUPILA_COMPACTA[pet_name], cx=42)
    for y in range(H):
        for x in range(W):
            if rosto[y][x] is not None:
                layer[y][x] = rosto[y][x]
    angulos, saltos, escalas = _MOTION[pet_name][state]
    angulo, salto, squash = angulos[f], saltos[f], escalas[f]
    canvas: Canvas = [[None]*W for _ in range(H)]
    _sombra(canvas, salto)
    a = math.radians(angulo)
    co, si = math.cos(a), math.sin(a)
    base = 44+salto

    def inverse(px, py):
        dx, dy = px-42, py-base
        return dx*co+dy*si, (-dx*si+dy*co)/squash

    composite(canvas, layer, inverse, (42, 44))
    _efeitos(state, f, angulo, salto, squash, canvas)
    return canvas


def render_claude_frame(state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    return render_procedural_frame("claude", state, frame_idx, expr_idx, compact)


def render_openai_frame(state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    return render_procedural_frame("openai", state, frame_idx, expr_idx, compact)


def render_commandcode_frame(state, frame_idx, expr_idx=0, compact=False) -> Canvas:
    return render_procedural_frame("commandcode", state, frame_idx, expr_idx, compact)


PETS = ("antigravity", "opencode", "claude", "openai", "commandcode")

_CACHE: dict[tuple[int, int, str], dict[str, list[list[list[tuple[int, int, int] | None]]]]] = {}


def _escala_matriz(
    mat: list[list[tuple[int, int, int] | None]], largura: int, altura: int
) -> list[list[tuple[int, int, int] | None]]:
    """Reamostra por cor dominante (pixel-art) mantendo a transparencia."""
    alt, larg = len(mat), len(mat[0])
    saida: list[list[tuple[int, int, int] | None]] = [[None] * largura for _ in range(altura)]
    for oy in range(altura):
        y0 = oy * alt // altura
        y1 = max(y0 + 1, (oy + 1) * alt // altura)
        for ox in range(largura):
            x0 = ox * larg // largura
            x1 = max(x0 + 1, (ox + 1) * larg // largura)
            contagem: dict[tuple[int, int, int], int] = {}
            for y in range(y0, y1):
                linha = mat[y]
                for x in range(x0, x1):
                    c = linha[x]
                    if c is not None:
                        contagem[c] = contagem.get(c, 0) + 1
            total = (y1 - y0) * (x1 - x0)
            if contagem and sum(contagem.values()) * 2 >= total:
                # cor dominante do bloco mantem o traco do pixel-art nitido
                if largura < larg and contagem.get(WHITE, 0)*4 >= total:
                    saida[oy][ox] = WHITE
                else:
                    saida[oy][ox] = max(contagem, key=contagem.__getitem__)
    return saida


def frames_para(rows: int, expr_idx: int = 0, pet_name: str = "antigravity") -> dict[str, list[list[list[tuple[int, int, int] | None]]]]:
    """Desenhos procedurais redimensionados para a altura pedida em linhas de terminal."""
    if pet_name not in PETS:
        raise ValueError("pet inválido")
    renderer = {"antigravity": render_mascot_frame, "opencode": render_monitor_frame,
                "claude": render_claude_frame, "openai": render_openai_frame,
                "commandcode": render_commandcode_frame}.get(pet_name, render_mascot_frame)
    if (rows, expr_idx, pet_name) not in _CACHE:
        larg, alt = W, H
        alvo_h = rows * 2  # half-block: 1 linha de terminal = 2 px
        alvo_w = max(1, round(larg * alvo_h / alt))
        _CACHE[rows, expr_idx, pet_name] = {
            st: [_escala_matriz(renderer(st, f, expr_idx, compact=rows < 28), alvo_w, alvo_h)
                 for f in range(6)]
            for st in STATES
        }
    return _CACHE[rows, expr_idx, pet_name]
















