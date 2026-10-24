"""Claude: cota do plano a partir de arquivos locais, sem credenciais e sem rede.

Porta de ClaudeQuota.cs:
1. cache do statusLine do Claude Code -> percentuais e renovações exatos;
2. histórico do app desktop (plan-usage-history.json) -> amostras "fh"/"sd";
   o reset de 5h é estimado pelo início da janela; o semanal nunca é inventado.
"""
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ..models import Snapshot, Window
from .http import ReadError, epoch, number

STALE_DESKTOP = 40*60
FRESH_STATUSLINE = 30*60
FIVE_HOURS = 18000
WEEKLY = 604800
SOURCE_HISTORY = "App Claude / histórico do plano"


@dataclass(frozen=True)
class Sample:
    at: float
    org: str | None
    fh: float | None
    sd: float | None


def statusline_path() -> Path:
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home()/".local/share")
    return base/"notutil"/"claude-limits.json"


def history_candidates() -> list[Path]:
    home = Path.home()
    config = Path(os.environ.get("XDG_CONFIG_HOME") or home/".config")
    return [config/"Claude"/"plan-usage-history.json",
            home/".local/share/Claude/plan-usage-history.json",
            home/".claude/plan-usage-history.json"]


def history_path() -> Path | None:
    try:
        existing = [path for path in history_candidates() if path.is_file()]
        return max(existing, key=lambda p: p.stat().st_mtime) if existing else None
    except OSError:
        return None


def _iso(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def read_statusline(now: float, path: Path | None = None) -> Snapshot | None:
    path = path or statusline_path()
    try:
        raw = json.loads(path.read_text())
        updated = _iso(raw.get("captured_at")) or path.stat().st_mtime
    except (OSError, ValueError, AttributeError):
        return None
    limits = raw.get("rate_limits") if isinstance(raw, dict) else None
    if not isinstance(limits, dict):
        return None
    windows = []
    for key, label, duration in (("five_hour", "5 horas", FIVE_HOURS),
                                 ("seven_day", "Semanal", WEEKLY)):
        item = limits.get(key)
        if not isinstance(item, dict):
            continue
        used = number(item.get("used_percentage"), 0, 100)
        reset = epoch(item.get("resets_at"))
        if used is None or (reset is not None and reset <= now):
            continue
        windows.append(Window(label, used, reset, duration))
    if not windows:
        return None
    stale = now-updated > FRESH_STATUSLINE
    note = ("statusLine vencido; abra o Claude Code." if stale
            else "statusLine do Claude Code (exato)")
    return Snapshot("claude", "Claude Code", "claude", tuple(windows), updated,
                    "Claude Code / statusLine", note=note, stale=stale)


def _samples(path: Path) -> list[Sample]:
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise ReadError("Não foi possível ler o histórico do app Claude.") from exc
    items = raw.get("samples") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise ReadError("Histórico do Claude em formato desconhecido.")
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        stamp = item.get("t")
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
            continue
        usage = item.get("u")
        usage = usage if isinstance(usage, dict) else {}
        org = item.get("org")
        rows.append(Sample(stamp/1000, org if isinstance(org, str) else None,
                           number(usage.get("fh"), 0, 100),
                           number(usage.get("sd"), 0, 100)))
    rows.sort(key=lambda sample: sample.at)
    if not rows:
        raise ReadError("O app Claude ainda não registrou uso do plano.")
    return [row for row in rows if row.org == rows[-1].org]


def _latest(rows: list[Sample], key: str) -> int | None:
    for index in range(len(rows)-1, -1, -1):
        if getattr(rows[index], key) is not None:
            return index
    return None


def estimate_reset(rows: list[Sample], key: str, index: int, now: float,
                   duration: int) -> tuple[float | None, str]:
    """Reset = meio do intervalo sem amostras + duração; sem fronteira próxima, não inventa."""
    if duration == WEEKLY:
        return None, "aguardando horário oficial de renovação"
    latest = rows[index]
    used = getattr(latest, key)
    if now-latest.at > duration:
        return None, "janela expirou desde a última amostra"
    if used is None or used <= 0:
        return None, "janela inicia no próximo uso"
    first, previous = index, None
    for j in range(index-1, -1, -1):
        value = getattr(rows[j], key)
        if value is None:
            continue
        if value <= 0 or value > used or latest.at-rows[j].at > duration:
            previous = j
            break
        first = j
    if previous is None or rows[first].at-rows[previous].at > 7200:
        return None, "horário de renovação indisponível"
    return (rows[previous].at+rows[first].at)/2+duration, "reset estimado pelo início da janela"


def read_history(now: float, path: Path | None = None) -> Snapshot | None:
    path = path or history_path()
    if path is None:
        return None
    try:
        rows = _samples(path)
    except (OSError, ValueError) as exc:
        raise ReadError("Não foi possível ler o histórico do app Claude.") from exc
    windows, hints, stale = [], [], False
    for key, label, duration in (("fh", "5 horas", FIVE_HOURS), ("sd", "Semanal", WEEKLY)):
        index = _latest(rows, key)
        if index is None:
            continue
        used = getattr(rows[index], key)
        reset, hint = estimate_reset(rows, key, index, now, duration)
        windows.append(Window(label, used, reset, duration, estimated=True))
        if reset is None:
            hints.append(hint)
        stale = stale or now-rows[index].at > STALE_DESKTOP
    last = rows[-1].at
    note = SOURCE_HISTORY
    if hints:
        note += " | "+" | ".join(dict.fromkeys(hints))
    if stale:
        note += " | abra o app Claude para atualizar"
    return Snapshot("claude", "Claude Code", "claude", tuple(windows), last,
                    SOURCE_HISTORY, note=note, stale=stale)


def collect() -> list[Snapshot]:
    now = time.time()
    if statusline_path().is_file() is False and history_path() is None:
        return [Snapshot("claude", "Claude Code", "claude", source=SOURCE_HISTORY,
                         disabled=True,
                         error="Sem dados locais do Claude: use o Claude Code com statusLine ou abra o app desktop.")]
    statusline = read_statusline(now)
    try:
        desktop = read_history(now)
    except ReadError as exc:
        desktop = Snapshot("claude", "Claude Code", "claude", source=SOURCE_HISTORY,
                           error=str(exc))
    candidates = [s for s in (statusline, desktop) if s and s.windows]
    if not candidates:
        return [desktop or Snapshot(
            "claude", "Claude Code", "claude",
            source=SOURCE_HISTORY,
            error="Sem dados locais do Claude: use o Claude Code com statusLine ou abra o app desktop.")]
    chosen = candidates[0]
    if len(candidates) > 1:
        chosen = max(candidates, key=lambda s: s.updated_at or 0)
        exact = statusline if chosen is not statusline else None
        if exact:
            chosen = Snapshot(chosen.id, chosen.name, chosen.pet, tuple(
                Window(w.label, w.used,
                       next((e.resets_at for e in exact.windows
                             if e.label == w.label and e.resets_at), w.resets_at),
                       w.duration, estimated=w.estimated)
                for w in chosen.windows), chosen.updated_at, chosen.source,
                chosen.error, chosen.stale, chosen.note)
    return [chosen]
