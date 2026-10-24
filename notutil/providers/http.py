"""HTTP limitado, sem proxy de ambiente, redirects ou exposição de exceções."""
import json
import math
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 2*1024*1024


class ReadError(Exception):
    """Mensagem segura para a UI, sem URL, headers ou corpo da resposta."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_json(url: str, *, headers=None, data=None, timeout=5):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ReadError("Endereço de quota não permitido.")
    if parsed.scheme == "http" and parsed.hostname != "127.0.0.1":
        raise ReadError("HTTP sem TLS permitido apenas em loopback.")
    request = Request(url, headers=headers or {}, data=data)  # noqa: S310 - esquema validado acima
    try:
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_BYTES+1)
        if len(body) > MAX_BYTES:
            raise ReadError("Resposta excede o limite de leitura.")
        result = json.loads(body)
        if not isinstance(result, dict):
            raise ReadError("Formato de quota não reconhecido.")
        return result
    except HTTPError as exc:
        code = exc.code
        exc.close()
        raise ReadError(f"Consulta recusada (HTTP {code}).") from None
    except (URLError, OSError, TimeoutError):
        raise ReadError("Fonte indisponível ou tempo de consulta esgotado.") from None
    except (ValueError, UnicodeError):
        raise ReadError("Resposta de quota inválida.") from None


def number(value, low: float = 0, high: float = 100) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    if not math.isfinite(value) or not low <= value <= high:
        return None
    return value


def epoch(value):
    numeric = number(value, 1, 1e15)
    if numeric is not None:
        numeric = numeric/1000 if numeric > 100_000_000_000 else numeric
        return numeric if numeric < 253402300800 else None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()  # noqa: UP017 - requer_python 3.10, sem datetime.UTC
        except (ValueError, OverflowError, OSError):
            return None
    return None
