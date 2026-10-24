"""Ritmo portado de Models.cs/Theme.cs do QuotaDesk; saúde não é atividade."""
from .models import Snapshot, Window


def pace(window: Window, now: float, stale: bool = False) -> float | None:
    if stale or window.resets_at is None or window.duration is None:
        return None
    left = window.resets_at-now
    if not 0 < left <= window.duration:
        return None
    return (1-left/window.duration)*100


def delta(window: Window, now: float, stale: bool = False) -> float | None:
    reference = pace(window, now, stale)
    return None if reference is None else window.used-reference


def pace_label(value: float | None) -> str:
    if value is None:
        return "RITMO INDISPONIVEL"
    if value > 3:
        return f"ADIANTADO {value:.0f}%"
    if value < -3:
        return f"FOLGA {-value:.0f}%"
    return "NO RITMO"


def forecast(window: Window, now: float, stale: bool = False) -> str:
    reference = pace(window, now, stale)
    if reference is None:
        return ""
    if window.duration is None or reference < 2 or window.used < 1:
        return ""
    if window.used >= 100:
        return "COTA ESGOTADA; aguardando renovacao"
    projected = window.used*100/reference
    if projected > 100:
        elapsed = window.duration*reference/100
        left = max(0, elapsed*(100/window.used-1))
        return f"~esgota em {countdown(left)} antes de renovar"
    return f"~sobram {max(0, 100-projected):.0f}% na renovacao"


def countdown(seconds: float) -> str:
    minutes = max(1, int((seconds+59)//60))
    if minutes >= 1440:
        return f"{minutes//1440}d {(minutes%1440)//60}h"
    if minutes >= 60:
        return f"{minutes//60}h {minutes%60:02}min"
    return f"{minutes}min"


def reset_text(window: Window, now: float) -> str:
    if window.resets_at is None:
        return "RENOVA: horario indisponivel"
    if window.resets_at <= now:
        return "AGUARDANDO NOVA LEITURA"
    return "RENOVA EM " + ("~" if window.estimated else "") + countdown(window.resets_at-now)


def health(snapshot: Snapshot, now: float) -> tuple[str, str]:
    if not snapshot.windows:
        return "triste", "SEM SINAL"
    if snapshot.outdated(now):
        return "triste", "DESATUALIZADO"
    if snapshot.cooldown_until is not None and snapshot.cooldown_until > now:
        return "desesperado", "COOLDOWN"
    values = [v for v in (delta(w, now) for w in snapshot.windows) if v is not None]
    if any(w.used >= 90 for w in snapshot.windows) or any(v > 10 for v in values):
        return "desesperado", "ATENCAO"
    if any(v > 3 for v in values):
        return "concentrado", "AJUSTANDO A ROTA"
    if values and all(v < -3 for v in values):
        return "comemorando", "FOLGA"
    return "concentrado", "MONITORANDO"
