"""Porta o contrato de grupos/modelos do QuotaDesk para Linux.

Prefere o proxy AGY já instalado; sem ele, tenta o language server local.
O token CSRF efêmero do processo só existe em memória.
"""
import hashlib
import os
import re
import time
from dataclasses import replace
from pathlib import Path

from ..models import Snapshot, Window
from ..rules import countdown
from .http import ReadError, epoch, number, read_json

PROXY_URL = "http://127.0.0.1:20128/v1/accounts/status"


def parse_groups(groups) -> tuple[Window, ...]:
    windows = []
    if not isinstance(groups, list):
        return ()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("displayName"), str):
            continue
        name = re.sub(r"\s+models$", "", group["displayName"].strip(), flags=re.I)
        name = re.sub(r"\band\b", "e", name)
        buckets = group.get("buckets", [])
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            if not isinstance(bucket, dict) or bucket.get("disabled") is True:
                continue
            fraction = number(bucket.get("remainingFraction"), 0, 1)
            if fraction is None:
                continue
            kind = bucket.get("window")
            label, duration = {"5h": ("5 horas", 18000), "weekly": ("Semanal", 604800)}.get(
                kind if isinstance(kind, str) else "", ("Limite", None))
            windows.append(Window(label, (1-fraction)*100, epoch(bucket.get("resetTime")),
                                  duration, name))
    return tuple(windows)


def parse_summary(root: dict) -> tuple[Window, ...]:
    response = root.get("response")
    return parse_groups(response.get("groups")) if isinstance(response, dict) else ()


def parse_legacy(root: dict) -> tuple[Window, ...]:
    status = root.get("userStatus", {})
    config = status.get("cascadeModelConfigData", {}) if isinstance(status, dict) else {}
    models = config.get("clientModelConfigs", []) if isinstance(config, dict) else []
    windows = []
    if not isinstance(models, list):
        return ()
    for model in models:
        if not isinstance(model, dict) or not isinstance(model.get("label"), str):
            continue
        info = model.get("quotaInfo", {})
        if not isinstance(info, dict):
            continue
        fraction = number(info.get("remainingFraction"), 0, 1)
        if fraction is not None:
            windows.append(Window(model["label"], (1-fraction)*100, epoch(info.get("resetTime"))))
    return tuple(windows)


def parse_proxy(root: dict, now: float) -> list[Snapshot]:
    accounts = root.get("accounts")
    if root.get("offline") or not isinstance(accounts, list) or not accounts:
        raise ReadError("Proxy AGY sem contas disponíveis.")
    age = number(root.get("quotaAgeMs"), 0, 1e12)
    ttl = number(root.get("quotaTtlMs"), 1, 1e12)
    # Ausência de idade não autoriza tratar uma quota em cache como recém-lida.
    updated = now-age/1000 if age is not None else None
    result = []
    for index, account in enumerate(accounts):
        if not isinstance(account, dict):
            continue
        quota = account.get("quota")
        windows = parse_groups(quota.get("groups")) if isinstance(quota, dict) and not quota.get("error") else ()
        cooldown = number(account.get("coolingDownSec"), 0, 1e9)
        identity = account.get("email") or account.get("projectId")
        key = hashlib.sha256(str(identity).encode()).hexdigest()[:10] if identity else str(index+1)
        model_cooldowns = account.get("modelCooldowns", {})
        cooling = sum(number(v, 0, 1e9) not in (None, 0) for v in model_cooldowns.values()) if isinstance(model_cooldowns, dict) else 0
        note = "Contas separadas; percentuais não são somados nem promediados."
        if cooling:
            note += f" COOLDOWN em {cooling} modelo(s); não significa bloqueio global."
        result.append(Snapshot(
            f"antigravity/{key}", f"Antigravity / conta {key[:6]}", "antigravity",
            windows, updated, "AGY / servidor local",
            "" if windows else "Conta sem leitura de quota reconhecida.",
            stale=age is None or (ttl is not None and age > ttl),
            note=note,
            cooldown_until=now+cooldown if cooldown else None))
    if not result:
        raise ReadError("Proxy AGY sem contas reconhecidas.")
    return result


def _identity(account: dict, index: int) -> str:
    value = account.get("email") or account.get("projectId")
    return hashlib.sha256(str(value).encode()).hexdigest()[:10] if value else str(index+1)


def paid_index(root: dict, hint: str = "") -> int:
    """Índice da conta paga: aponta pelo id (ou email/projeto) ou usa a mais completa."""
    accounts = root.get("accounts")
    if not isinstance(accounts, list) or not accounts:
        return 0
    hint = hint.strip()
    if hint:
        for index, account in enumerate(accounts):
            if not isinstance(account, dict):
                continue
            identity = account.get("email") or account.get("projectId")
            if hint == identity or _identity(account, index).startswith(hint):
                return index if isinstance(account, dict) else 0
    def rank(account) -> tuple[int, int]:
        if not isinstance(account, dict):
            return (0, 0)
        ids = account.get("claudeIds")
        quota = account.get("quota")
        groups = quota.get("groups") if isinstance(quota, dict) else None
        buckets = sum(len(g.get("buckets") or []) for g in groups if isinstance(g, dict)) \
            if isinstance(groups, list) else 0
        return (len(ids) if isinstance(ids, list) else 0, buckets)
    return max(range(len(accounts)), key=lambda index: rank(accounts[index]))


def collapse(snapshots: list[Snapshot], primary: int, now: float) -> Snapshot:
    """Uma cota principal (a paga) e as demais como bônus; nada é somado."""
    chosen = snapshots[primary]
    others = [s for index, s in enumerate(snapshots) if index != primary]
    parts = [f"PAGA {chosen.id.rsplit('/', 1)[-1][:6]}"]
    usable = [s for s in others if s.windows and not s.error]
    if usable:
        def best(label: str) -> str:
            cells = [(w.remaining, w.resets_at) for s in usable for w in s.windows if w.label == label]
            if not cells:
                return f"{label.lower()} sem leitura"
            left, reset = max(cells, key=lambda cell: cell[0])
            tail = f" (renova {countdown(reset-now)})" if reset and reset > now else ""
            return f"{label.lower()} {left:.0f}% livre{tail}"
        parts.append(f"BONUS {len(others)} contas: " + " | ".join((best("5 horas"), best("Semanal"))))
    else:
        parts.append(f"BONUS {len(others)} contas sem leitura")
    if chosen.note:
        parts.append(chosen.note)
    return replace(chosen, id="antigravity", name="Antigravity", note=" | ".join(parts))


def discover() -> tuple[int, str]:
    proc = Path("/proc")
    if not proc.exists():
        raise ReadError("Descoberta direta disponível apenas em Linux.")
    for candidate in proc.iterdir():
        if not candidate.name.isdigit():
            continue
        try:
            if candidate.stat().st_uid != os.getuid():
                continue
            executable = os.readlink(candidate/"exe")
            if "antigravity" not in executable.lower() or "language_server" not in executable:
                continue
            command = (candidate/"cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            token = re.search(r'--csrf_token(?:=|\s+)["\x27]?([^\s"\x27]+)', command)
            if not token:
                continue
            logs = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home()/".config")))/"Antigravity/logs"
            paths = sorted(logs.rglob("*language_server*.log"),
                           key=lambda path: path.stat().st_mtime, reverse=True)[:10]
            for path in paths:
                with path.open("rb") as stream:
                    stream.seek(max(0, path.stat().st_size-128*1024))
                    text = stream.read(128*1024).decode(errors="replace")
                ports = re.findall(r"listening on \w+ port at (\d+) for HTTP\b(?!S)", text)
                if ports and 0 < int(ports[-1]) <= 65535:
                    return int(ports[-1]), token[1]
        except (OSError, ValueError):
            continue
    raise ReadError("Abra o Antigravity ou o proxy AGY para consultar quotas.")


def collect_direct() -> list[Snapshot]:
    port, token = discover()
    base = f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/"
    headers = {"X-Codeium-Csrf-Token": token, "Content-Type": "application/json"}
    try:
        windows = parse_summary(read_json(base+"RetrieveUserQuotaSummary", headers=headers, data=b"{}"))
    except ReadError:
        windows = ()
    if not windows:
        windows = parse_legacy(read_json(base+"GetUserStatus", headers=headers, data=b"{}"))
    if not windows:
        raise ReadError("Servidor local não informou quotas reconhecidas.")
    return [Snapshot("antigravity", "Antigravity", "antigravity", windows, time.time(),
                     "Antigravity / language server",
                     note="Contrato interno; não representa o chat Gemini.")]


def collect() -> list[Snapshot]:
    try:
        now = time.time()
        root = read_json(PROXY_URL)
        snapshots = parse_proxy(root, now)
        return [collapse(snapshots, paid_index(root, os.environ.get("NOTUTIL_AGY_PAID", "")), now)]
    except ReadError:
        return collect_direct()
