"""Cards ANSI compactos: um provedor por linha, janela critica escolhida sozinha.

Formatacao pura: nenhuma rede, nenhuma credencial e nenhum estado global.
"""
import math
import re
import unicodedata
from datetime import datetime

from . import banner as welcome
from . import pets
from .graphics import PetImage
from .models import Snapshot, Window
from .rules import countdown, delta, forecast, health, pace, pace_label, reset_text

DIM = 245
EDGE = 60
TITLE = 231
ORANGE = 208
CYAN = 45
GREEN = 42
AMBER = 214
RED = 203
MAGENTA = 200
PURPLE = 141
WHITE = 255
USAGE = ((50, CYAN), (75, PURPLE), (90, MAGENTA), (101, RED))
ACCENT = {"antigravity": 42, "opencode": 141, "openai": 39, "claude": 208, "commandcode": 45}
PET_FOR = {"antigravity": "antigravity", "opencode": "opencode", "openai": "openai",
           "claude": "claude", "commandcode": "commandcode"}
PILL = {"comemorando": ("FOLGA", GREEN), "concentrado": ("NO RITMO", CYAN),
        "desesperado": ("ATENCAO", RED), "triste": ("SEM SINAL", AMBER)}
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PT_DAYS = ("SEG", "TER", "QUA", "QUI", "SEX", "SAB", "DOM")
CARD_ROWS = 3


def clean(text: str) -> str:
    # Texto externo nunca pode injetar ANSI, bidi ou alterar a largura das células.
    text = "".join(c for c in str(text) if not unicodedata.category(c).startswith("C"))
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).encode("ascii", "replace").decode("ascii")


def _paint(text: str, color: int | None, bold: bool = False) -> str:
    if color is None:
        return text
    return (f"\x1b[1;38;5;{color}m" if bold else f"\x1b[38;5;{color}m")+text+"\x1b[0m"


def _visible(text: str) -> int:
    return len(ANSI.sub("", text))


def _fit(text: str, width: int) -> str:
    return text if len(text) <= width else text[:max(0, width-3)]+"..."


def _usage_color(used: float, stale: bool) -> int:
    if stale:
        return DIM
    for limit, color in USAGE:
        if used < limit:
            return color
    return RED


def bar(used: float, reference: float | None, width=20, full="█", empty="░") -> str:
    filled = round(used*width/100)
    chars = [full if i < filled else empty for i in range(width)]
    if reference is not None:
        chars[min(width-1, max(0, round(reference*(width-1)/100)))] = "│"
    return "".join(chars)


def _main(snapshot: Snapshot) -> tuple[Window | None, list[Window]]:
    """Janela principal automatica: a que bloqueia primeiro; as outras vao para o rodape."""
    windows = list(snapshot.windows)
    if not windows:
        return None, []
    first = min(windows, key=lambda window: window.remaining)
    return first, [window for window in windows if window is not first]


def details(snapshot: Snapshot, now: float) -> list[str]:
    """Relatório completo de um provedor, para --once."""
    _, status = health(snapshot, now)
    lines = [snapshot.name.upper(), status]
    if snapshot.updated_at is not None:
        lines.append("Leitura "+datetime.fromtimestamp(snapshot.updated_at).astimezone().strftime("%H:%M:%S"))
    if snapshot.cooldown_until is not None and snapshot.cooldown_until > now:
        lines.append("Cooldown global "+countdown(snapshot.cooldown_until-now))
    if snapshot.error:
        lines.append(snapshot.error)
    stale = snapshot.outdated(now)
    for window in snapshot.windows:
        lines.extend([
            "",
            (window.group+" / " if window.group else "")+window.label,
            f"{window.used:.0f}% USADO  |  {window.remaining:.0f}% RESTANTE",
            bar(window.used, pace(window, now, stale), full="#", empty="."),
            pace_label(delta(window, now, stale)),
            reset_text(window, now),
        ])
        estimate = forecast(window, now, stale)
        if estimate:
            lines.append(estimate)
    if not snapshot.windows:
        lines.append("Sem dados da assinatura.")
    if snapshot.note:
        lines.extend(["", snapshot.note])
    lines.append("Origem: "+snapshot.source)
    return [clean(line) for line in lines]


def plain(snapshots: list[Snapshot], now: float) -> str:
    active = [snapshot for snapshot in snapshots if not snapshot.disabled]
    sections = ["QUOTA WATCH // MONITOR DE IA", "Cota da assinatura; nao e contexto nem custo de sessao."]
    for snapshot in active:
        sections.extend(["", *details(snapshot, now)])
    off = [snapshot.name for snapshot in snapshots if snapshot.disabled]
    if off:
        sections.extend(["", "Nao configurado: "+", ".join(off)+"."])
    return "\n".join(sections)+"\n"


def _row(snapshot: Snapshot, now: float, width: int) -> str:
    """Linha unica do card: barra, uso e renovacao da janela principal."""
    main, _ = _main(snapshot)
    stale = snapshot.outdated(now)
    if main is None:
        return _paint(_fit(" "+(snapshot.error or snapshot.note or "sem dados da assinatura"), width), AMBER)
    if main.resets_at is None:
        reset = "--"
    elif main.resets_at <= now:
        reset = "aguardando"
    else:
        reset = ("~" if main.estimated else "")+countdown(main.resets_at-now)
    pct = f"{main.used:.0f}%"
    tail = "  "+reset
    left = " "+bar(main.used, pace(main, now, stale), max(6, min(24, width-len(pct)-len(tail)-2)))
    room = " "*max(1, width-len(left)-len(pct)-len(tail))
    tone = RED if main.used >= 90 and not stale else TITLE
    return (_paint(left, _usage_color(main.used, stale))+room
            +_paint(pct, tone, True)+_paint(tail, DIM))


def _card(snapshot: Snapshot, now: float, width: int) -> list[str]:
    accent = ACCENT.get(snapshot.id, PURPLE)
    emotion, status = health(snapshot, now)
    pill_text, pill_color = (status, AMBER) if status in ("SEM SINAL", "DESATUALIZADO") else PILL[emotion]
    text_width = width-2
    body = _row(snapshot, now, text_width)
    body += " "*max(0, text_width-_visible(body))
    name = _fit(snapshot.name.upper(), max(4, width-14-len(pill_text)))
    head = _paint("╭─ ", accent)+_paint(name, TITLE, True)+_paint(" ", accent)
    right_edge = _paint(" ", accent)+_paint(pill_text, pill_color, True)+_paint(" ─╮", accent)
    filler = "─"*max(0, width-_visible(head)-_visible(right_edge))
    title = head+_paint(filler, accent)+right_edge
    return [title, _paint("│", accent)+body+_paint("│", accent),
            _paint("╰"+"─"*(width-2)+"╯", accent)]


def _pets(snapshots: list[Snapshot], now: float, frame: int, rows: int, cols: int,
          images: list[PetImage] | None = None, top: int = 1) -> list[str]:
    """Todos os mascotes lado a lado, abaixo dos cards."""
    if not snapshots or rows < 4 or (cols-1)//len(snapshots) < 10:
        return []
    slot = max(1, (cols-1)//len(snapshots))
    pet_rows = max(4, min(rows, 6 if images is not None else 14, (slot-2)//2))
    if images is not None:
        for index, snapshot in enumerate(snapshots):
            images.append(PetImage(PET_FOR.get(snapshot.pet, "opencode"), health(snapshot, now)[0],
                                   frame % 6, top, index*slot+(slot-pet_rows*2)//2+1,
                                   pet_rows, pet_rows*2))
        return [""]*pet_rows
    sprites = []
    for snapshot in snapshots:
        emotion = health(snapshot, now)[0]
        sprite, _ = pets.matrix_to_ansi(pets.frames_para(
            pet_rows, pet_name=PET_FOR.get(snapshot.pet, "opencode"))[emotion][frame % 6])
        sprites.append(sprite.splitlines())
    lines = []
    for y in range(pet_rows):
        cells = []
        for sprite in sprites:
            art = sprite[y] if y < len(sprite) else ""
            art += " "*(pet_rows*2-_visible(art))
            cells.append(" "*((slot-_visible(art))//2)+art)
        lines.append("".join(cells))
    return lines


def _header(info: welcome.Banner, cols: int) -> list[str]:
    """Cabecalho em duas linhas: saudacao/relogio e proximo evento, com dica se couber."""
    width = cols-1
    today = datetime.now()
    stamp = today.strftime("%H:%M")+" · "+PT_DAYS[today.weekday()]+", "+today.strftime("%d/%m")
    left = _paint(_fit(clean(info.greeting), width-len(stamp)-1), TITLE, True)
    first = left+" "*max(1, width-_visible(left)-len(stamp))+_paint(stamp, ORANGE, True)
    event = "proximo: "+info.events[0] if info.events else "agenda: sem eventos"
    tip = "dica: "+clean(info.tip)
    room = width-len(event)-len(tip)-2
    if room >= 8:
        second = _paint(event, CYAN)+" "*room+_paint(tip, DIM)
    else:
        second = _paint(_fit(event, width), CYAN)
    return [first, second]


def render(snapshots: list[Snapshot], now: float, frame: int, page: int,
           cols: int, lines: int, weather: str = "",
           events: tuple[str, ...] = (), images: list[PetImage] | None = None) -> tuple[str, int]:
    active = [snapshot for snapshot in snapshots if not snapshot.disabled]
    columns = min(max(1, len(active)), max(1, min(3, cols//52)))
    gap = 1
    width = (cols-1-gap*(columns-1))//columns
    header = _header(welcome.banner_for(active, now, weather, events), cols)
    body_height = lines-len(header)-2
    total_rows = max(1, math.ceil(len(active)/columns))
    rows_per_page = min(total_rows, max(1, body_height//CARD_ROWS))
    shown = columns*rows_per_page
    pages = max(1, math.ceil(len(active)/shown))
    start = (page % pages)*shown
    selected = active[start:start+shown] if active else []
    cards = [_card(snapshot, now, width) for snapshot in selected]
    readable = sum(1 for snapshot in active if snapshot.windows and not snapshot.error)

    def row(left: str, right: str) -> str:
        room = cols-1-_visible(left)-len(right)
        return left+" "*room+_paint(right, DIM) if room >= 1 else _paint(_fit(ANSI.sub("", left), cols-1), DIM)

    footer = row(_paint(f" r atualizar  n/p {page % pages+1}/{pages}  q sair", DIM),
                 f"{readable}/{len(active)} com leitura")
    if not active:
        return "\n".join(header+[""]+[
            _paint(_fit(" Nenhuma assinatura configurada. Veja o README para ligar as fontes.", cols-1), DIM)
        ]+[footer]), pages
    body: list[str] = []
    rows_shown = math.ceil(len(selected)/columns)
    for row_index in range(rows_shown):
        group = cards[row_index*columns:(row_index+1)*columns]
        for y in range(CARD_ROWS):
            body.append((" "*gap).join(card[y] for card in group))
    free = body_height-len(body)
    others = [f"{snapshot.name.upper()} {window.label.upper()} {window.used:.0f}%" for snapshot in selected
              for window in _main(snapshot)[1]]
    notes = [f"{snapshot.name.upper()} {snapshot.note}" for snapshot in selected if snapshot.note]
    extras = others+notes
    if extras and free >= 1:
        label = " outras janelas  " if others else " notas  "
        line = _paint(_fit(label+" · ".join(extras), cols-1), DIM)
        body.append(line)
        free -= 1
    pet_lines = _pets(active if len(active) <= shown else selected, now, frame,
                      free-1, cols, images, len(header)+len(body)+2)
    if pet_lines:
        body.append("")
        body.extend(pet_lines)
    return "\n".join(header+body+[""]*max(0, body_height-len(body))+[footer]), pages
