"""OpenCode Go: quota real do endpoint de assinatura, não tokens de sessão."""
import time

from ..credentials import secret
from ..models import Snapshot, Window
from .http import ReadError, epoch, number, read_json

URL = "https://opencode.ai/zen/go/v1/usage"


def parse(root: dict, now: float) -> Snapshot:
    usage = root.get("usage", root)
    windows = []
    if isinstance(usage, dict):
        for key, label, duration in (("rolling", "5 horas", 18000),
                                     ("weekly", "Semanal", 604800),
                                     ("monthly", "Mensal", None)):
            item = usage.get(key)
            if not isinstance(item, dict):
                continue
            used = number(item.get("percent"))
            if used is not None:
                windows.append(Window(label, used, epoch(item.get("resetsAt")), duration))
    if not windows:
        raise ReadError("OpenCode não informou janelas de quota reconhecidas.")
    return Snapshot("opencode", "OpenCode Go", "opencode", tuple(windows), now,
                    "OpenCode Go / usage")


def collect() -> list[Snapshot]:
    # Variável explícita primeiro; senão a chave local do Pi. A chave nunca sai daqui.
    key = secret(("OPENCODE_GO_KEY",), "opencode-go")
    if not key:
        return [Snapshot("opencode", "OpenCode Go", "opencode",
                         source="OpenCode Go / usage", disabled=True,
                         error="Defina OPENCODE_GO_KEY para consultar a assinatura.")]
    return [parse(read_json(URL, headers={"Authorization": f"Bearer {key}",
                                         "User-Agent": "opencode/1.18.30"}, timeout=10), time.time())]
