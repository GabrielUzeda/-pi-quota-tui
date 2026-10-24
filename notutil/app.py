"""Entrada do monitor: polling lento em background, pets a 6 fps."""
import argparse
import json
import select
import shutil
import sys
import termios
import time
import tty
from dataclasses import asdict

from .banner import Weather
from .calendar import Calendar
from .graphics import KittyGraphics, enabled, text_update
from .service import Monitor, collect_once
from .ui import plain, render


def run(graphics: str = "auto") -> None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SystemExit("Modo interativo exige terminal; use --once ou --json.")
    cols, lines = shutil.get_terminal_size((100, 40))
    if cols < 52 or lines < 15:
        raise SystemExit("Terminal pequeno: minimo 52x15. Use --once para texto.")
    monitor = Monitor()
    weather = Weather()
    agenda = Calendar()
    previous = termios.tcgetattr(sys.stdin.fileno())
    page, frame = 0, 0
    painter = KittyGraphics() if enabled(graphics) else None
    previous_screen, previous_size = "", (cols, lines)
    try:
        tty.setcbreak(sys.stdin.fileno())
        sys.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J")
        while True:
            monitor.start(time.monotonic())
            monitor.finish()
            weather.start(time.time())
            agenda.start(time.time())
            cols, lines = shutil.get_terminal_size((100, 40))
            images = [] if painter is not None else None
            if cols < 52 or lines < 15:
                screen, pages = "Aumente a janela para pelo menos 52x15.", 1
            else:
                now = time.time()
                screen, pages = render(monitor.snapshots(), now, frame, page, cols, lines,
                                       weather.finish(), agenda.finish(now), images=images)
            resized = previous_size != (cols, lines)
            output = "\x1b[2J" if resized else ""
            output += text_update(screen, "" if resized else previous_screen)
            if painter is not None:
                output += painter.draw(images or [], force=resized)
            sys.stdout.write("\x1b[?2026h"+output+"\x1b[?2026l")
            previous_screen, previous_size = screen, (cols, lines)
            sys.stdout.flush()
            frame = (frame+1) % 6
            if select.select([sys.stdin], [], [], 1/6)[0]:
                key = sys.stdin.read(1)
                if key.lower() == "q":
                    break
                if key.lower() == "r":
                    monitor.start(time.monotonic(), force=True)
                if key.lower() in ("n", "p"):
                    page = (page+(1 if key.lower() == "n" else -1)) % pages
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, previous)
        if painter is not None:
            sys.stdout.write(painter.close())
        sys.stdout.write("\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()
        agenda.close()
        weather.close()
        monitor.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Notutil: monitor de quotas com pets 8-bit")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Consulta uma vez, imprime texto e encerra")
    mode.add_argument("--json", action="store_true", help="Consulta uma vez; JSON normalizado sem credenciais")
    parser.add_argument("--graphics", choices=("auto", "kitty", "ansi"), default="auto",
                        help="Mascotes: imagens Kitty/Ghostty ou caracteres ANSI (padrao: auto)")
    args = parser.parse_args()
    if args.once or args.json:
        snapshots = collect_once()
        if args.json:
            now = time.time()
            values = [dict(asdict(s), stale=s.outdated(now)) for s in snapshots]
            print(json.dumps(values, ensure_ascii=False, allow_nan=False, indent=2))
        else:
            print(plain(snapshots, time.time()), end="")
    else:
        run(args.graphics)


if __name__ == "__main__":
    main()
