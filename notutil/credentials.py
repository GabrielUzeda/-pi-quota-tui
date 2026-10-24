"""Chaves só em memória: variáveis de ambiente primeiro, depois o auth.json local do Pi.

Nunca imprime, registra, persiste ou inclui a chave em URLs/argumentos.
"""
import json
import os
from pathlib import Path

PI_AUTH = Path.home()/".pi/agent/auth.json"


def _load() -> dict:
    try:
        info = PI_AUTH.stat()
        if info.st_mode & 0o077:
            return {}
        data = json.loads(PI_AUTH.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def entry(section: str) -> dict:
    item = _load().get(section)
    return item if isinstance(item, dict) else {}


def secret(env_names: tuple[str, ...], section: str) -> str:
    for name in env_names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    value = entry(section).get("key")
    return value.strip() if isinstance(value, str) else ""
