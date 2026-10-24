"""Cabeçalho de boas-vindas: saudação, dica rotativa e próxima renovação.

As dicas de quota são puras. O clima é opcional, com cache e thread própria:
só consulta wttr.in quando NOTUTIL_CITY estiver definido.
"""
import getpass
import os
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

from .models import Snapshot
from .rules import countdown, delta

STATIC_TIPS = ("Cada card mostra a janela que bloqueia primeiro; as outras ficam no rodape.",
               "Pressione r para atualizar agora.", "n e p trocam de pagina.",
               "Cada card e uma assinatura, nao um agente.")
RAIN = ("chuva", "rain", "drizzle", "shower", "thunder", "trovoada", "garoa")
TIP_SECONDS = 600
WEATHER_TTL = 30*60


@dataclass(frozen=True)
class Banner:
    greeting: str
    tip: str
    events: tuple[str, ...] = ()


def greeting() -> str:
    name = os.environ.get("NOTUTIL_USER") or getpass.getuser()
    return "BEM-VINDO, "+name.split("@")[0].split(".")[0].upper()+"!"


def tips(snapshots: list[Snapshot], now: float) -> list[str]:
    """Dicas em linguagem de conselho, não de painel de métricas."""
    readings = [snapshot for snapshot in snapshots if snapshot.windows and not snapshot.error]
    tight = min(readings, key=lambda s: min(w.remaining for w in s.windows), default=None)
    roomy = max(readings, key=lambda s: min(w.remaining for w in s.windows), default=None)
    tight_left = min((w.remaining for w in tight.windows), default=0) if tight else 0
    roomy_left = min((w.remaining for w in roomy.windows), default=0) if roomy else 0

    def switch_advice(snapshot: Snapshot) -> str:
        if roomy is None or roomy is snapshot or roomy_left <= max(40, tight_left+20):
            return ""
        return f" Talvez seja boa hora de trocar para o {roomy.name}, que tem {roomy_left:.0f}%."

    found = []
    for snapshot in snapshots:
        if not snapshot.windows:
            found.append(f"O {snapshot.name} está sem leitura agora. Se usar, vale ligar a fonte de dados.")
            continue
        stale = snapshot.outdated(now)
        worst = min(snapshot.windows, key=lambda window: window.remaining)
        slack = delta(worst, now, stale)
        tail = ""
        if worst.resets_at is not None and worst.resets_at > now:
            tail = f" A janela renova em {countdown(worst.resets_at-now)}."
        if worst.remaining <= 10:
            found.append(f"Seus créditos de {worst.label.lower()} no {snapshot.name} estão acabando "
                         f"({worst.remaining:.0f}% restantes).{tail}{switch_advice(snapshot)}")
        elif worst.remaining < 30:
            found.append(f"Só restam {worst.remaining:.0f}% em {snapshot.name} "
                         f"{worst.label.lower()}; segure um pouco o uso.{tail}{switch_advice(snapshot)}")
        elif slack is not None and slack > 10:
            found.append(f"O {snapshot.name} está {slack:.0f}% adiantado em {worst.label.lower()}. "
                         "Talvez seja hora de desacelerar.")
        elif slack is not None and slack < -10:
            found.append(f"O {snapshot.name} está tranquilo: {-slack:.0f}% de folga em "
                         f"{worst.label.lower()}. Bom momento para usar.")
    if len(readings) > 1:
        tight = min(readings, key=lambda s: min(w.remaining for w in s.windows))
        roomy = max(readings, key=lambda s: min(w.remaining for w in s.windows))
        tight_left = min(window.remaining for window in tight.windows)
        roomy_left = min(window.remaining for window in roomy.windows)
        if tight is not roomy and tight_left < 25 and roomy_left > 60:
            found.append(f"O {tight.name} está com {tight_left:.0f}% e o {roomy.name} com "
                         f"{roomy_left:.0f}%: talvez seja uma boa hora de trocar.")
    return found or list(STATIC_TIPS)


def banner_for(snapshots: list[Snapshot], now: float, weather: str = "",
               events: tuple[str, ...] = ()) -> Banner:
    options = ([weather] if weather else [])+tips(snapshots, now)+list(STATIC_TIPS)
    return Banner(greeting(), options[int(now//TIP_SECONDS) % len(options)], events)


def _clean(text: str) -> str:
    text = "".join(char for char in text if not unicodedata.category(char).startswith("C"))
    return " ".join(text.split())[:90]


def _fetch(place: str) -> str:
    url = "https://wttr.in/"+quote(place)+"?format=%C|%t|%p&lang=pt"
    opener = build_opener(ProxyHandler({}))
    with opener.open(Request(url, headers={"User-Agent": "curl/8"}), timeout=5) as response:
        body = response.read(512)
    parts = body.decode("utf-8", "replace").split("|")
    if len(parts) != 3:
        return ""
    condition, temperature, precipitation = (_clean(part) for part in parts)
    rain = precipitation not in ("0.0mm", "0.0 mm", "0mm", "0 mm") or \
        any(word in condition.lower() for word in RAIN)
    state = "chuva" if rain else "sem chuva"
    return f"{condition.capitalize()} {temperature} em {place}: {state}."


class Weather:
    """Clima opcional: cache de 30 min, fora do loop de animação."""

    def __init__(self, place: str | None = None):
        self.place = (place if place is not None else os.environ.get("NOTUTIL_CITY", "")).strip()
        self.text = ""
        self.at = float("-inf")
        self.pending = False
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clima")

    def start(self, now: float) -> None:
        if not self.place or self.pending or now-self.at < WEATHER_TTL:
            return
        self.pending = True
        self.at = now
        self.future = self.pool.submit(_fetch, self.place)

    def finish(self) -> str:
        if self.pending and self.future.done():
            self.pending = False
            try:
                self.text = self.future.result()
            except Exception:
                self.text = ""
        return self.text

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
