"""Dados normalizados; nunca guardam credenciais nem respostas brutas."""
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Window:
    label: str
    used: float
    resets_at: float | None = None
    duration: int | None = None
    group: str = ""
    estimated: bool = False

    def __post_init__(self):
        if isinstance(self.used, bool) or not math.isfinite(self.used) or not 0 <= self.used <= 100:
            raise ValueError("percentual inválido")
        if self.resets_at is not None and not math.isfinite(self.resets_at):
            raise ValueError("renovação inválida")
        if self.duration not in (None, 18000, 604800):
            raise ValueError("duração não suportada para ritmo")

    @property
    def remaining(self) -> float:
        return 100-self.used


@dataclass(frozen=True)
class Snapshot:
    id: str
    name: str
    pet: str
    windows: tuple[Window, ...] = ()
    updated_at: float | None = None
    source: str = ""
    error: str = ""
    stale: bool = False
    note: str = ""
    cooldown_until: float | None = None
    disabled: bool = False

    def outdated(self, now: float) -> bool:
        if self.disabled:
            return False
        return (self.stale or bool(self.error) or self.updated_at is None
                or self.updated_at > now+60 or now-self.updated_at > 120
                or any(w.resets_at is not None and w.resets_at <= now for w in self.windows))
