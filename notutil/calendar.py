"""Próximos eventos de calendário a partir de arquivos iCalendar (.ics).

Fontes: NOTUTIL_ICS (caminhos ou URLs https separados por ':') ou, sem ele,
os calendários locais do Evolution. Nada de OAuth: para o Google Calendar, use
o endereço iCal secreto da própria agenda.

Suporta eventos únicos e recorrência DIÁRIA/SEMANAL/MENSAL com INTERVAL,
COUNT, UNTIL e BYDAY. Recorrências com RECURRENCE-ID são ignoradas para não
duplicar o evento base; EXDATE não é aplicado.
"""
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo

from .banner import _clean

DAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
HORIZON = 7*24*3600
REFRESH = 10*60
WEEKDAY = ("SEG", "TER", "QUA", "QUI", "SEX", "SAB", "DOM")
URL_MAX = 1024*1024


@dataclass(frozen=True)
class Event:
    at: float
    summary: str
    all_day: bool = False


def _unfold(text: str) -> list[str]:
    lines = re.split(r"\r?\n", text.replace("\r\n", "\n"))
    folded: list[str] = []
    for line in lines:
        if line[:1] in (" ", "\t") and folded:
            folded[-1] += line[1:]
        else:
            folded.append(line)
    return folded


def _property(line: str) -> tuple[str, dict[str, str], str] | None:
    index = line.find(":")
    if index < 0:
        return None
    name, params = line[:index], {}
    for part in name.split(";")[1:]:
        if "=" in part:
            key, value = part.split("=", 1)
            params[key.upper()] = value.strip('"')
    return name.split(";")[0].upper(), params, line[index+1:]


def _moment(value: str, params: dict[str, str]) -> tuple[float | None, bool]:
    value = value.strip()
    all_day = len(value) == 8 and "T" not in value
    try:
        if all_day:
            parsed = datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc)  # noqa: UP017
        elif value.endswith("Z"):
            parsed = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)  # noqa: UP017
        else:
            parsed = datetime.strptime(value, "%Y%m%dT%H%M%S")
            zone = params.get("TZID")
            parsed = parsed.replace(tzinfo=ZoneInfo(zone) if zone else None)
    except (ValueError, KeyError):
        return None, all_day
    return parsed.timestamp(), all_day


def _rrule(value: str) -> dict[str, str]:
    rules = {}
    for part in value.split(";"):
        if "=" in part:
            key, item = part.split("=", 1)
            rules[key.strip().upper()] = item.strip().upper()
    return rules


def _occurrences(start: datetime, rules: dict[str, str], horizon: datetime) -> list[datetime]:
    freq = rules.get("FREQ", "")
    interval = max(1, int(rules["INTERVAL"])) if rules.get("INTERVAL", "").isdigit() else 1
    count = int(rules["COUNT"]) if rules.get("COUNT", "").isdigit() else None
    until = None
    if rules.get("UNTIL"):
        stamp, _ = _moment(rules["UNTIL"], {})
        until = datetime.fromtimestamp(stamp, start.tzinfo) if stamp else None
    if freq not in ("DAILY", "WEEKLY", "MONTHLY"):
        return [start]
    by_day = {DAYS.index(day) for day in rules.get("BYDAY", "").replace("-1", "").split(",")
              if day in DAYS}
    found, produced, cursor = [], 0, start
    limit = max(start, horizon)+timedelta(days=1)
    while cursor <= limit and produced < 20000:
        if until is not None and cursor > until:
            break
        if count is not None and produced >= count:
            break
        matched = True
        if freq == "DAILY":
            matched = (cursor.date()-start.date()).days % interval == 0
        elif freq == "WEEKLY":
            days = by_day or {start.weekday()}
            weeks = (cursor.date()-start.date()).days//7
            matched = cursor.weekday() in days and weeks % interval == 0
        else:
            matched = cursor.day == start.day and \
                ((cursor.year-start.year)*12+cursor.month-start.month) % interval == 0
        if matched:
            produced += 1
            if cursor >= start:
                found.append(cursor)
        cursor += timedelta(days=1)
    return found


def _blocks(lines: list[str]):
    current: list[str] | None = None
    for line in lines:
        stripped = line.strip()
        if stripped == "BEGIN:VEVENT":
            current = []
        elif stripped == "END:VEVENT":
            if current is not None:
                yield current
            current = None
        elif current is not None:
            current.append(line)


def parse_ics(text: str, now: float) -> list[Event]:
    horizon = now+HORIZON
    events: list[Event] = []
    for raw in _blocks(_unfold(text)):
        block: dict[str, tuple[dict[str, str], str]] = {}
        for line in raw:
            parsed = _property(line)
            if not parsed:
                continue
            name, params, value = parsed
            if name == "RECURRENCE-ID":
                block = {}
                break
            block.setdefault(name, (params, value))
        if not block or "DTSTART" not in block:
            continue
        if block.get("STATUS", ({}, ""))[1].strip().upper() == "CANCELLED":
            continue
        params, value = block["DTSTART"]
        begin, all_day = _moment(value, params)
        if begin is None:
            continue
        summary = _clean(block.get("SUMMARY", ({}, "SEM TITULO"))[1])[:40] or "SEM TITULO"
        moment = datetime.fromtimestamp(begin).astimezone()
        rules = _rrule(block["RRULE"][1]) if "RRULE" in block else {}
        for occurrence in _occurrences(moment, rules, datetime.fromtimestamp(horizon).astimezone()):
            stamp = occurrence.timestamp()
            if now <= stamp <= horizon:
                events.append(Event(stamp, summary, all_day))
    unique = {(round(event.at), event.summary): event for event in events}
    return sorted(unique.values(), key=lambda event: event.at)


def _read_source(source: str) -> str:
    parsed = urlsplit(source)
    if parsed.scheme in ("http", "https"):
        if parsed.username or parsed.password:
            raise ValueError("URL com credenciais não é permitida")
        if parsed.scheme == "http" and parsed.hostname != "127.0.0.1":
            raise ValueError("HTTP sem TLS apenas em loopback")
        opener = build_opener(ProxyHandler({}))
        request = Request(source, headers={"User-Agent": "notutil/0.1"})  # noqa: S310 -- esquema validado acima
        with opener.open(request, timeout=8) as response:
            return response.read(URL_MAX).decode("utf-8", "replace")
    return Path(source).expanduser().read_text(errors="replace")


def sources() -> list[str]:
    configured = [item for item in os.environ.get("NOTUTIL_ICS", "").split(":") if item.strip()]
    if configured:
        return configured
    home = Path.home()
    found = sorted(str(path) for path in home.glob(".local/share/evolution/calendar/*/calendar.ics"))
    found += sorted(str(path) for path in home.glob(".calendars/*/*.ics"))
    return found


def label(event: Event, now: float) -> str:
    moment = datetime.fromtimestamp(event.at).astimezone()
    today = datetime.fromtimestamp(now).astimezone().date()
    if moment.date() == today:
        day = "HOJE"
    elif moment.date() == today+timedelta(days=1):
        day = "AMANHA"
    else:
        day = WEEKDAY[moment.weekday()]
    clock = "" if event.all_day else moment.strftime("%H:%M ")
    return f"{day} {clock}{event.summary.upper()}"


class Calendar:
    """Eventos com cache de 10 min, lidos fora do loop de animação."""

    def __init__(self, places: list[str] | None = None):
        self.places = places if places is not None else sources()
        self.events: list[Event] = []
        self.at = float("-inf")
        self.pending = False
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="agenda")

    def start(self, now: float) -> None:
        if not self.places or self.pending or now-self.at < REFRESH:
            return
        self.pending = True
        self.at = now
        self.future = self.pool.submit(self._read_all)

    def _read_all(self) -> list[Event]:
        events: list[Event] = []
        for place in self.places:
            try:
                events.extend(parse_ics(_read_source(place), time.time()))
            except (OSError, ValueError):
                continue
        return sorted(events, key=lambda event: event.at)[:4]

    def finish(self, now: float) -> tuple[str, ...]:
        if self.pending and self.future.done():
            self.pending = False
            try:
                self.events = self.future.result()
            except Exception:
                self.events = []
        return tuple(label(event, now) for event in self.events
                     if event.at >= now-60)[:2]

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
