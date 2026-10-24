"""CommandCode: créditos da assinatura e janelas de 5h/semanal/mensal.

Mesmo contrato do TUI do Pi (extensions/quota.ts): somente leitura.
"""
import time
from datetime import datetime, timezone

from ..credentials import entry, secret
from ..models import Snapshot, Window
from .http import ReadError, epoch, number, read_json

BASE = "https://api.commandcode.ai/alpha"
HEADERS = {"Accept": "application/json", "User-Agent": "notutil/0.1"}


def _window(limits: dict, key: str, label: str, duration: int) -> Window | None:
    item = limits.get(key)
    if not isinstance(item, dict):
        return None
    cap = number(item.get("cap"), 0, 1e12)
    used = number(item.get("used"), 0, 1e12)
    if not cap or used is None:
        return None
    return Window(label, min(100, used/cap*100), epoch(item.get("resetAt")), duration)


def next_monthly_reset(day: int, now: float) -> float:
    moment = datetime.fromtimestamp(now, timezone.utc)  # noqa: UP017 -- Python 3.10
    year, month = moment.year, moment.month
    reset = datetime(year, month, min(max(day, 1), 28), tzinfo=timezone.utc)  # noqa: UP017
    if moment >= reset:
        year, month = (year+1, 1) if month == 12 else (year, month+1)
        reset = datetime(year, month, min(max(day, 1), 28), tzinfo=timezone.utc)  # noqa: UP017
    return reset.timestamp()


def parse(credits: dict, summary: dict | None, now: float, reset_day: int = 16) -> Snapshot:
    wallet = credits.get("credits")
    if not isinstance(wallet, dict):
        raise ReadError("CommandCode não informou créditos.")
    monthly = number(wallet.get("monthlyCredits"), 0, 1e12) or 0
    purchased = number(wallet.get("purchasedCredits"), 0, 1e12) or 0
    free = number(wallet.get("freeCredits"), 0, 1e12) or 0
    windows = []
    limits = credits.get("windowLimits")
    if isinstance(limits, dict):
        for key, label, duration in (("fiveHour", "5 horas", 18000), ("weekly", "Semanal", 604800)):
            window = _window(limits, key, label, duration)
            if window:
                windows.append(window)
    used = number(summary.get("totalMonthlyCredits"), 0, 1e12) if isinstance(summary, dict) else None
    cap = monthly+(used or 0)
    if cap > 0:
        windows.append(Window("Mensal", min(100, (cap-monthly)/cap*100),
                              next_monthly_reset(reset_day, now), None))
    balance = monthly+purchased+free
    note = f"Saldo {balance:,.2f} créditos".replace(",", " ")
    if isinstance(limits, dict) and limits.get("exceeded"):
        note += " | LIMITE EXCEDIDO"
    if not any(window.label != "Mensal" for window in windows):
        note += " | sem janela de 5h/semanal nesta conta"
    return Snapshot("commandcode", "CommandCode", "commandcode", tuple(windows), now,
                    "CommandCode / billing", note=note)


def collect() -> list[Snapshot]:
    key = secret(("COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"), "commandcode")
    if not key:
        return [Snapshot("commandcode", "CommandCode", "commandcode", source="CommandCode / billing",
                         disabled=True,
                         error="Defina COMMAND_CODE_API_KEY para consultar os créditos.")]
    headers = dict(HEADERS, Authorization=f"Bearer {key}")
    credits = read_json(BASE+"/billing/credits", headers=headers, timeout=10)
    try:
        summary = read_json(BASE+"/usage/summary", headers=headers, timeout=10)
    except ReadError:
        summary = None
    try:
        reset_day = int(entry("commandcode").get("resetDay", 16))
    except (TypeError, ValueError):
        reset_day = 16
    return [parse(credits, summary, time.time(), reset_day)]
