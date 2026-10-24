"""Polling independente da animação; preserva leituras em falhas temporárias."""
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace

from .models import Snapshot
from .providers.antigravity import collect as collect_antigravity
from .providers.claude import collect as collect_claude
from .providers.commandcode import collect as collect_commandcode
from .providers.http import ReadError
from .providers.openai import collect as collect_openai
from .providers.opencode import collect as collect_opencode

# 60 s: cada leitura do Codex abre um subprocesso local.
INTERVAL = 60


class Monitor:
    def __init__(self):
        self.collectors = {"antigravity": collect_antigravity, "opencode": collect_opencode,
                           "openai": collect_openai, "claude": collect_claude,
                           "commandcode": collect_commandcode}
        self.data: dict[str, list[Snapshot]] = {
            name: [Snapshot(name, name.title(), name, error="Aguardando primeira leitura.",
                            disabled=True)]
            for name in self.collectors}
        self.pool = ThreadPoolExecutor(max_workers=len(self.collectors), thread_name_prefix="quota")
        self.pending: dict[str, Future] = {}
        self.last_poll = float("-inf")

    def start(self, now: float, force=False):
        if not force and now-self.last_poll < INTERVAL:
            return
        for name, collector in self.collectors.items():
            if name not in self.pending:
                self.pending[name] = self.pool.submit(collector)
        self.last_poll = now

    def apply(self, provider: str, fresh: list[Snapshot]):
        if fresh and all(s.disabled for s in fresh):
            self.data[provider] = fresh
            return
        if not fresh or not any(s.windows and not s.error for s in fresh):
            if fresh and not any(s.windows for s in self.data[provider]):
                self.data[provider] = fresh
            else:
                reason = fresh[0].error if fresh else "Nenhuma leitura disponível."
                self.fail(provider, reason)
            return
        old = {s.id: s for s in self.data[provider] if s.windows}
        merged = []
        for current in fresh:
            previous = old.pop(current.id, None)
            if not current.windows and previous:
                current = replace(previous, stale=True, error=current.error)
            merged.append(current)
        merged.extend(replace(s, stale=True, error="Conta ausente na leitura atual.")
                      for s in old.values())
        self.data[provider] = merged

    def fail(self, provider: str, message: str):
        self.data[provider] = [replace(s, stale=bool(s.windows), error=message)
                               for s in self.data[provider]]

    def finish(self, wait=False):
        for name, future in list(self.pending.items()):
            if not wait and not future.done():
                continue
            try:
                self.apply(name, future.result())
            except ReadError as exc:
                self.fail(name, str(exc))
            except Exception:
                # Não propaga corpo HTTP, tokens nem detalhes de exceções para a tela.
                self.fail(name, "Falha interna na leitura; última quota preservada.")
            del self.pending[name]

    def snapshots(self) -> list[Snapshot]:
        return [s for values in self.data.values() for s in values]

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)


def collect_once() -> list[Snapshot]:
    monitor = Monitor()
    try:
        monitor.start(time.monotonic())
        monitor.finish(wait=True)
        return monitor.snapshots()
    finally:
        monitor.close()
