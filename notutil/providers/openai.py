"""OpenAI/Codex: quotas da assinatura via 'codex app-server --stdio' (JSON-RPC local).

Sem OAuth próprio e sem ler credenciais: o processo do Codex usa a sessão já logada.
"""
import json
import select
import shutil
import subprocess
import time

from ..models import Snapshot, Window
from .http import ReadError, epoch, number

DURATIONS = {300: ("5 horas", 18000), 10080: ("Semanal", 604800)}


def _bucket(result: dict) -> dict:
    by_id = result.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and by_id:
        first = by_id.get("codex")
        if isinstance(first, dict):
            return first
        for value in by_id.values():
            if isinstance(value, dict):
                return value
    fallback = result.get("rateLimits")
    if isinstance(fallback, dict):
        return fallback
    raise ReadError("O Codex não informou limites de quota para esta conta.")


def _window(item, fallback: str) -> Window | None:
    if not isinstance(item, dict):
        return None
    used = number(item.get("usedPercent"), 0, 100)
    if used is None:
        return None
    minutes = item.get("windowDurationMins")
    if isinstance(minutes, int) and minutes in DURATIONS:
        label, duration = DURATIONS[minutes]
    else:
        label, duration = None, None
    return Window(label or fallback, used, epoch(item.get("resetsAt")), duration)


def parse(result: dict, now: float) -> Snapshot:
    bucket = _bucket(result)
    windows = tuple(w for w in (_window(bucket.get("primary"), "5 horas"),
                                _window(bucket.get("secondary"), "Semanal")) if w)
    if not windows:
        raise ReadError("O Codex informou limites sem percentual utilizável.")
    note = ""
    credits = result.get("rateLimitResetCredits")
    if isinstance(credits, dict):
        count = credits.get("availableCount")
        if isinstance(count, int) and count > 0:
            note = f"{count} reset(s) de limite disponível(is)"
    return Snapshot("openai", "OpenAI Codex", "openai", windows, now,
                    "codex app-server", note=note)


def _request(proc) -> dict | None:
    assert proc.stdout is not None
    deadline = time.monotonic()+20
    while time.monotonic() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline-time.monotonic()))
        if not ready:
            break
        line = proc.stdout.readline()
        if not line:
            break
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("id") == 2:
            if isinstance(message.get("error"), dict):
                raise ReadError("O Codex recusou a leitura de quotas.")
            result = message.get("result")
            return result if isinstance(result, dict) else None
    return None


def collect() -> list[Snapshot]:
    binary = shutil.which("codex")
    if not binary:
        return [Snapshot("openai", "OpenAI Codex", "openai", source="codex app-server",
                         disabled=True, error="Codex CLI não encontrado no PATH.")]
    proc = subprocess.Popen(
        [binary, "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    try:
        assert proc.stdin is not None
        for message in ({"method": "initialize", "id": 1,
                         "params": {"clientInfo": {"name": "notutil", "title": "notutil", "version": "0"}}},
                        {"method": "initialized"},
                        {"method": "account/rateLimits/read", "id": 2}):
            proc.stdin.write(json.dumps(message)+"\n")
            proc.stdin.flush()
        result = _request(proc)
        if result is None:
            raise ReadError("O Codex não respondeu à leitura de quotas.")
        return [parse(result, time.time())]
    finally:
        proc.kill()
        proc.wait(timeout=5)
