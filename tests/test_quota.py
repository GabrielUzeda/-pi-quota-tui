import io
import json
import os
import re
import tempfile
import unittest
from dataclasses import asdict, replace
from datetime import datetime, timezone
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

from notutil import calendar as agenda
from notutil.models import Snapshot, Window
from notutil.providers import antigravity, claude, commandcode, openai, opencode
from notutil.providers.http import ReadError, epoch, number, read_json
from notutil.rules import delta, forecast, health, pace, pace_label, reset_text
from notutil.service import INTERVAL, Monitor
from notutil.ui import clean, plain, render

NOW = 1_800_000_000.0


def sample(used=20, reset=None):
    return Snapshot("opencode", "OpenCode Go", "opencode",
                    (Window("5 horas", used, NOW+9000 if reset is None else reset, 18000),),
                    NOW, "fixture de teste")


def groups(remaining=.8):
    return [{"displayName": "Gemini Models", "buckets": [
        {"window": "5h", "remainingFraction": remaining, "resetTime": NOW+9000},
        {"window": "weekly", "remainingFraction": .6, "resetTime": NOW+302400},
    ]}]


class RulesTests(unittest.TestCase):
    def test_pace_and_slack_match_quotadesk(self):
        window = sample().windows[0]
        self.assertEqual(pace(window, NOW), 50)
        self.assertEqual(delta(window, NOW), -30)
        self.assertEqual(pace_label(delta(window, NOW)), "FOLGA 30%")
        self.assertEqual(pace_label(3), "NO RITMO")
        self.assertEqual(pace_label(-3), "NO RITMO")
        self.assertEqual(pace_label(3.1), "ADIANTADO 3%")
        self.assertEqual(pace_label(None), "RITMO INDISPONIVEL")

    def test_past_renewal_preserves_usage_and_disables_pace(self):
        snapshot = sample(78, NOW-1)
        self.assertTrue(snapshot.outdated(NOW))
        self.assertEqual(snapshot.windows[0].used, 78)
        self.assertIsNone(pace(snapshot.windows[0], NOW))
        self.assertEqual(reset_text(snapshot.windows[0], NOW), "AGUARDANDO NOVA LEITURA")
        self.assertEqual(health(snapshot, NOW), ("triste", "DESATUALIZADO"))
        self.assertIn("78% USADO", plain([snapshot], NOW))
        self.assertNotIn("FOLGA", plain([snapshot], NOW))

    def test_unknown_duration_stale_or_impossible_reset_has_no_pace(self):
        for window in (Window("Mensal", 20, NOW+9000),
                       Window("5 horas", 20, NOW+18001, 18000),
                       Window("5 horas", 20, None, 18000)):
            self.assertIsNone(pace(window, NOW))
        self.assertIsNone(pace(sample().windows[0], NOW, stale=True))
        self.assertTrue(replace(sample(), updated_at=NOW-121).outdated(NOW))
        self.assertTrue(replace(sample(), updated_at=NOW+61).outdated(NOW))

    def test_forecasts_and_estimated_labels_are_explicit(self):
        window = sample().windows[0]
        self.assertIn("~sobram 60%", forecast(window, NOW))
        self.assertIn("~esgota", forecast(replace(window, used=80), NOW))
        self.assertIn("ESGOTADA", forecast(replace(window, used=100), NOW))
        self.assertEqual(forecast(window, NOW, stale=True), "")
        self.assertIn("~", reset_text(replace(window, estimated=True), NOW))

    def test_pet_is_quota_health_not_agent_activity(self):
        self.assertEqual(health(sample(10), NOW)[0], "comemorando")
        self.assertEqual(health(sample(55), NOW)[0], "concentrado")
        self.assertEqual(health(sample(65), NOW)[0], "desesperado")
        self.assertEqual(health(sample(95), NOW)[0], "desesperado")
        self.assertEqual(health(replace(sample(), cooldown_until=NOW+60), NOW)[1], "COOLDOWN")
        self.assertEqual(health(Snapshot("x", "x", "opencode"), NOW)[1], "SEM SINAL")

    def test_invalid_usage_is_never_silently_displayed(self):
        for value in (-1, 101, float("nan"), float("inf"), True):
            with self.assertRaises(ValueError):
                Window("x", value)
        for value in (None, -1, True, float("nan"), 10**1000, "90"):
            self.assertIsNone(number(value))
        self.assertEqual(epoch(NOW), NOW)
        self.assertEqual(epoch(NOW*1000), NOW)
        self.assertIsNotNone(epoch("2026-10-01T10:00:00Z"))
        self.assertIsNone(epoch("invalid"))


class ProviderTests(unittest.TestCase):
    def test_antigravity_groups_preserve_window_and_group(self):
        windows = antigravity.parse_summary({"response": {"groups": groups()}})
        self.assertEqual(len(windows), 2)
        self.assertAlmostEqual(windows[0].used, 20)
        self.assertEqual(windows[0].group, "Gemini")
        self.assertEqual(windows[0].duration, 18000)
        self.assertEqual(windows[1].duration, 604800)

    def test_antigravity_ignores_amounts_disabled_and_malformed_values(self):
        data = groups()
        data[0]["buckets"] += [
            {"window": "5h", "remainingAmount": 10},
            {"remainingFraction": True},
            {"remainingFraction": 1.1},
            {"remainingFraction": .8, "disabled": True},
            {"remainingFraction": float("nan")},
            None,
        ]
        self.assertEqual(len(antigravity.parse_groups(data)), 2)
        for bad in (None, [], {"response": None}, {"response": {"groups": {}}}):
            if isinstance(bad, dict):
                self.assertEqual(antigravity.parse_summary(bad), ())
        root = {"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": "Gemini", "quotaInfo": {"remainingFraction": .8, "resetTime": NOW+60}}
        ]}}}
        legacy = antigravity.parse_legacy(root)
        self.assertAlmostEqual(legacy[0].used, 20)
        self.assertIsNone(legacy[0].duration)

    def test_proxy_does_not_average_accounts_or_expose_emails(self):
        accounts = [{"email": "a@example.test", "quota": {"groups": groups(.1)}},
                    {"email": "b@example.test", "quota": {"groups": groups(.9)}}]
        root = {"quotaAgeMs": 1000, "quotaTtlMs": 30000, "accounts": accounts}
        snapshots = antigravity.parse_proxy(root, NOW)
        self.assertEqual(len(snapshots), 2)
        self.assertAlmostEqual(snapshots[0].windows[0].used, 90)
        self.assertAlmostEqual(snapshots[1].windows[0].used, 10)
        normalized = json.dumps([asdict(s) for s in snapshots])
        self.assertNotIn("@", normalized)
        reordered = antigravity.parse_proxy(dict(root, accounts=accounts[::-1]), NOW)
        self.assertEqual(snapshots[0].id, reordered[1].id)
        self.assertEqual(snapshots[0].name, reordered[1].name)
        self.assertTrue(all(s.updated_at == NOW-1 for s in snapshots))

    def test_antigravity_collapses_into_paid_account_with_free_bonus(self):
        accounts = [{"email": "free@example.test", "claudeIds": ["a"], "quota": {"groups": groups(.1)}},
                    {"email": "paid@example.test", "claudeIds": ["a", "b", "c"],
                     "quota": {"groups": groups(.9)}}]
        root = {"accounts": accounts}
        snapshots = antigravity.parse_proxy(root, NOW)
        self.assertEqual(antigravity.paid_index(root), 1)
        merged = antigravity.collapse(snapshots, 1, NOW)
        self.assertEqual(merged.id, "antigravity")
        self.assertEqual(merged.windows, snapshots[1].windows)
        self.assertIn("PAGA", merged.note)
        self.assertIn("BONUS 1 contas", merged.note)
        self.assertIn("semanal 60% livre", merged.note)
        self.assertNotIn("@", merged.note)
        by_hint = antigravity.collapse(
            snapshots, antigravity.paid_index(root, "free@example.test"), NOW)
        self.assertAlmostEqual(by_hint.windows[0].used, 90)
        self.assertEqual(antigravity.paid_index(root, "nao-existe"), 1)

    def test_proxy_freshness_and_cooldowns_are_not_invented(self):
        root: dict = {"accounts": [{"quota": {"groups": groups()}, "coolingDownSec": 60,
                              "modelCooldowns": {"test-model": 100}}]}
        result = antigravity.parse_proxy(root, NOW)[0]
        self.assertTrue(result.stale)
        self.assertIsNone(result.updated_at)
        self.assertEqual(result.cooldown_until, NOW+60)
        self.assertIn("1 modelo(s)", result.note)
        root.update(quotaAgeMs=2000, quotaTtlMs=1000)
        self.assertTrue(antigravity.parse_proxy(root, NOW)[0].stale)

    def test_direct_adapter_falls_back_only_to_legacy_quota(self):
        with patch("notutil.providers.antigravity.discover", return_value=(12345, "ephemeral")), \
                patch("notutil.providers.antigravity.read_json", side_effect=[
                    ReadError("método ausente"),
                    {"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
                        {"label": "Gemini", "quotaInfo": {"remainingFraction": .5}}
                    ]}}},
                ]) as request:
            result = antigravity.collect_direct()[0]
        self.assertEqual(result.windows[0].used, 50)
        self.assertNotIn("ephemeral", repr(result))
        self.assertTrue(request.call_args.args[0].startswith("http://127.0.0.1:12345/"))
        self.assertTrue(request.call_args.args[0].endswith("GetUserStatus"))

    def test_opencode_only_uses_subscription_usage(self):
        result = opencode.parse({"usage": {
            "rolling": {"percent": 20, "resetsAt": NOW+9000},
            "weekly": {"percent": 30, "resetsAt": NOW+302400},
            "monthly": {"percent": 40, "resetsAt": NOW+600000},
        }}, NOW)
        self.assertEqual([w.used for w in result.windows], [20, 30, 40])
        self.assertEqual([w.duration for w in result.windows], [18000, 604800, None])
        for root in ({}, {"usage": None}, {"usage": {"rolling": {"percent": True}}},
                     {"tokens": 12000, "cost": 2.5}):
            with self.assertRaises(ReadError):
                opencode.parse(root, NOW)

    def test_opencode_uses_env_then_local_pi_key(self):
        with patch.dict("os.environ", {}, clear=True), \
                patch("notutil.credentials.entry", return_value={}), \
                patch("notutil.providers.opencode.read_json") as request:
            result = opencode.collect()[0]
        request.assert_not_called()
        self.assertEqual(result.windows, ())
        self.assertIn("OPENCODE_GO_KEY", result.error)
        with patch.dict("os.environ", {"OPENCODE_GO_KEY": "test-only-key"}, clear=True), \
                patch("notutil.providers.opencode.read_json",
                      return_value={"rolling": {"percent": 12}}) as request:
            result = opencode.collect()[0]
        self.assertEqual(result.windows[0].used, 12)
        self.assertNotIn("test-only-key", repr(result))
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer test-only-key")

    def test_http_rejects_unsafe_urls_and_redacts_errors(self):
        for url in ("file:///tmp/anything", "http://example.com/quota",
                    "https://name:password@example.com", "ftp://example.com"):
            with self.assertRaises(ReadError):
                read_json(url)
        with patch("notutil.providers.http.build_opener") as opener:
            opener.return_value.open.side_effect = HTTPError(
                "https://example.test?secret=never", 401, "secret-body", Message(), io.BytesIO())
            with self.assertRaisesRegex(ReadError, "HTTP 401") as error:
                read_json("https://example.test")
            self.assertNotIn("secret", str(error.exception))


class MonitorTests(unittest.TestCase):
    def test_failures_preserve_last_usage_and_refresh_recovers(self):
        monitor = Monitor()
        try:
            monitor.apply("opencode", [sample(78)])
            monitor.fail("opencode", "offline")
            old = monitor.data["opencode"][0]
            self.assertEqual(old.windows[0].used, 78)
            self.assertTrue(old.outdated(NOW))
            monitor.apply("opencode", [sample(5)])
            self.assertFalse(monitor.data["opencode"][0].outdated(NOW))
        finally:
            monitor.close()

    def test_polling_is_independent_from_animation_and_rate_limited(self):
        monitor = Monitor()
        monitor.collectors = {"opencode": lambda: [sample()]}
        try:
            monitor.start(0)
            monitor.finish(wait=True)
            monitor.start(1)
            self.assertEqual(monitor.pending, {})
            monitor.start(INTERVAL+1)
            self.assertIn("opencode", monitor.pending)
            monitor.finish(wait=True)
            self.assertEqual(monitor.data["opencode"][0].windows[0].used, 20)
        finally:
            monitor.close()

    def test_exception_text_does_not_leak(self):
        monitor = Monitor()
        def broken() -> list[Snapshot]:
            raise RuntimeError("Bearer never-show-this")
        monitor.collectors = {"opencode": broken}
        try:
            monitor.start(0)
            monitor.finish(wait=True)
            self.assertNotIn("never-show-this", repr(monitor.snapshots()))
        finally:
            monitor.close()


class UITests(unittest.TestCase):
    def test_ui_fits_small_and_large_terminals(self):
        snapshots = [sample(), replace(sample(), id="ag", name="Antigravity", pet="antigravity")]
        for cols, lines in ((52, 15), (80, 30), (112, 40), (160, 45)):
            screen, pages = render(snapshots, NOW, 0, 0, cols, lines)
            stripped = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen)
            self.assertLessEqual(len(stripped.splitlines()), lines-1)
            self.assertTrue(all(len(line) <= cols-1 for line in stripped.splitlines()))
            self.assertEqual(pages, 1)

    def test_compact_grid_uses_width_and_height_before_paginating(self):
        active = [replace(sample(), id=f"p{index}", name=f"Provedor {index}")
                  for index in range(5)]
        for cols, lines, pages_expected, visible in (
                (52, 15, 2, 3), (104, 11, 2, 4), (156, 23, 1, 5)):
            with self.subTest(cols=cols, lines=lines):
                screen, pages = render(active, NOW, 0, 0, cols, lines)
                self.assertEqual(pages, pages_expected)
                stripped = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen)
                self.assertEqual(sum(line.count("PROVEDOR ") for line in stripped.splitlines()
                                     if line.startswith("╭─")), visible)
                self.assertIn(f"n/p 1/{pages}", screen)
                for page in range(pages):
                    screen, _ = render(active, NOW, 0, page, cols, lines)
                    self.assertIn(f"PROVEDOR {page*visible}", screen)

    def test_compact_layout_fits_events_errors_and_long_names(self):
        two = replace(sample(), name="Provedor " * 20, note="Nota " * 30,
                      windows=sample().windows+(Window("Semanal", 70, NOW+300000, 604800),))
        snapshots = [two, replace(two, error="offline"), replace(two, windows=())]
        with patch.dict(os.environ, {"NOTUTIL_USER": "nome" * 40}):
            for cols in (52, 80, 104, 112, 156, 200):
                for height in (15, 22, 30):
                    for events in ((), ("Reuniao", "Entrega")):
                        screen, pages = render(snapshots, NOW, 0, 0, cols, height, events=events)
                        stripped = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen)
                        self.assertLessEqual(len(stripped.splitlines()), height-1)
                        self.assertTrue(all(len(line) <= cols-1 for line in stripped.splitlines()))
                        self.assertGreaterEqual(pages, 1)
                        self.assertIn("com leitura", stripped)

    def test_empty_compact_layout_fits_minimum_terminal(self):
        screen, pages = render([], NOW, 0, 0, 52, 15)
        stripped = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen)
        self.assertEqual(pages, 1)
        self.assertTrue(all(len(line) <= 51 for line in stripped.splitlines()))

    def test_ui_keeps_pets_below_the_cards(self):
        screen, pages = render([sample()], NOW, 0, 0, 140, 45)
        lines = screen.splitlines()
        self.assertEqual(pages, 1)
        stripped = [re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", line) for line in lines]
        bottom = next(index for index, line in enumerate(stripped) if line.startswith("╰"))
        self.assertFalse(any("▀" in line for line in stripped[:bottom+1]))
        self.assertTrue(any("▀" in line for line in stripped[bottom+1:]))

    def test_ui_hides_unconfigured_and_fits_every_card_on_one_page(self):
        active = [replace(sample(), id=f"p{index}", name=f"Provedor {index}")
                  for index in range(4)]
        hidden = replace(sample(), id="claude", name="Claude Code", disabled=True, windows=())
        screen, pages = render(active+[hidden], NOW, 0, 0, 140, 45)
        self.assertEqual(pages, 1)
        self.assertNotIn("CLAUDE CODE", screen)
        self.assertIn("4/4 com leitura", screen)
        self.assertIn("CLAUDE CODE", plain(active+[hidden], NOW).upper())

    def test_ui_shows_the_blocking_window_without_a_key(self):
        two = Snapshot("opencode", "OpenCode Go", "opencode",
                       (Window("5 horas", 10, NOW+9000, 18000),
                        Window("Semanal", 90, NOW+302400, 604800)), NOW, "fixture")
        screen, pages = render([two], NOW, 0, 0, 80, 30)
        stripped = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen)
        self.assertEqual(pages, 1)
        self.assertIn("90%", stripped)
        self.assertIn("outras janelas", stripped)
        self.assertIn("5 HORAS 10%", stripped)

    def test_external_text_cannot_inject_terminal_controls(self):
        self.assertNotIn("\x1b", clean("\x1b[31munsafe"))
        self.assertEqual(clean("não são"), "nao sao")
        self.assertNotIn("\u202e", clean("text\u202eevil"))
        self.assertIn("FOLGA 30%", plain([sample()], NOW))

    def test_interactive_terminal_is_restored_when_render_fails(self):
        from notutil import app
        stream = io.StringIO()
        with patch("notutil.app.sys.stdin") as stdin, \
                patch("notutil.app.sys.stdout", stream), \
                patch("notutil.app.termios") as termios, \
                patch("notutil.app.tty"), patch("notutil.app.Monitor") as monitor, \
                patch("notutil.app.shutil.get_terminal_size", return_value=(100, 40)), \
                patch("notutil.app.render", side_effect=RuntimeError("fixture")), \
                patch.object(stream, "isatty", return_value=True):
            stdin.isatty.return_value = True
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                app.run()
            termios.tcsetattr.assert_called_once()
            monitor.return_value.close.assert_called_once()
        self.assertTrue(stream.getvalue().endswith("\x1b[0m\x1b[?25h\x1b[?1049l"))

class NewProviderTests(unittest.TestCase):
    def test_commandcode_parses_windows_balance_and_monthly_cap(self):
        credits = {"credits": {"monthlyCredits": 0, "purchasedCredits": 5.32, "freeCredits": 0},
                   "windowLimits": {"fiveHour": {"cap": 100, "used": 25, "resetAt": NOW+3600},
                                    "weekly": None}}
        summary = {"totalMonthlyCredits": 46}
        snapshot = commandcode.parse(credits, summary, NOW, 16)
        labels = [window.label for window in snapshot.windows]
        self.assertEqual(labels, ["5 horas", "Mensal"])
        self.assertAlmostEqual(snapshot.windows[0].used, 25)
        self.assertEqual(snapshot.windows[0].duration, 18000)
        self.assertAlmostEqual(snapshot.windows[1].used, 100)
        self.assertIsNone(snapshot.windows[1].duration)
        self.assertIn("5.32", snapshot.note)
        self.assertGreater(snapshot.windows[1].resets_at or 0, NOW)

    def test_commandcode_without_wallet_is_an_error_not_zero(self):
        with self.assertRaises(ReadError):
            commandcode.parse({"credits": None}, None, NOW)

    def test_openai_reads_both_windows_and_unknown_duration_gets_no_pace(self):
        result = {"rateLimitsByLimitId": {"codex": {
            "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": NOW+3600},
            "secondary": {"usedPercent": 16, "windowDurationMins": 10080, "resetsAt": NOW+600000}}},
            "rateLimitResetCredits": {"availableCount": 2}}
        snapshot = openai.parse(result, NOW)
        self.assertEqual([window.duration for window in snapshot.windows], [18000, 604800])
        self.assertAlmostEqual(snapshot.windows[1].used, 16)
        self.assertIn("2 reset", snapshot.note)
        odd = {"rateLimits": {"primary": {"usedPercent": 50, "windowDurationMins": 60}}}
        self.assertIsNone(openai.parse(odd, NOW).windows[0].duration)
        with self.assertRaises(ReadError):
            openai.parse({"rateLimits": {}}, NOW)

    def test_claude_statusline_is_exact_and_rejects_past_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "claude-limits.json")
            with open(path, "w") as handle:
                json.dump({"captured_at": "2026-12-02T00:00:00Z", "rate_limits": {
                    "five_hour": {"used_percentage": 40, "resets_at": NOW+3600},
                    "seven_day": {"used_percentage": 70, "resets_at": NOW-60}}}, handle)
            snapshot = claude.read_statusline(NOW, __import__("pathlib").Path(path))
        assert snapshot is not None
        self.assertEqual([window.label for window in snapshot.windows], ["5 horas"])
        self.assertFalse(snapshot.windows[0].estimated)

    def test_claude_history_estimates_five_hours_only_with_near_boundary(self):
        rows = [claude.Sample(NOW-5*3600, "org", 0.0, 10.0),
                claude.Sample(NOW-4*3600, "org", 10.0, 12.0),
                claude.Sample(NOW-1800, "org", 60.0, 14.0)]
        reset, hint = claude.estimate_reset(rows, "fh", 2, NOW, claude.FIVE_HOURS)
        self.assertAlmostEqual(reset or 0, (NOW-4*3600+NOW-5*3600)/2+5*3600)
        self.assertIn("estimado", hint)
        reset, hint = claude.estimate_reset(rows, "sd", 2, NOW, claude.WEEKLY)
        self.assertIsNone(reset)
        self.assertIn("oficial", hint)
        far = [claude.Sample(NOW-20*3600, "org", 0.0, 5.0),
               claude.Sample(NOW-3600, "org", 30.0, 6.0)]
        self.assertIsNone(claude.estimate_reset(far, "fh", 1, NOW, claude.FIVE_HOURS)[0])

    def test_claude_history_file_parses_latest_account_only(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "plan-usage-history.json")
            stamp = int(NOW*1000)
            with open(path, "w") as handle:
                json.dump({"samples": [
                    {"t": stamp-3600_000, "org": "old", "u": {"fh": 90, "sd": 90}},
                    {"t": stamp-60_000, "org": "now", "u": {"fh": 20, "sd": 30}},
                    {"t": stamp, "org": "now", "u": {"fh": 25, "sd": 31}}]}, handle)
            snapshot = claude.read_history(NOW, __import__("pathlib").Path(path))
        assert snapshot is not None
        self.assertEqual([window.used for window in snapshot.windows], [25, 31])
        self.assertTrue(snapshot.windows[1].estimated)
        self.assertIsNone(snapshot.windows[1].resets_at)

    def test_tips_advise_switching_and_rotate_every_ten_minutes(self):
        from notutil.banner import banner_for, tips
        tight = Snapshot("openai", "OpenAI Codex", "openai",
                         (Window("5 horas", 98, NOW+3600, 18000),), NOW, "fixture")
        roomy = Snapshot("opencode", "OpenCode Go", "opencode",
                         (Window("Semanal", 20, NOW+302400, 604800),), NOW, "fixture")
        advice = tips([tight, roomy], NOW)[0]
        self.assertIn("acabando", advice)
        self.assertIn("trocar para o OpenCode Go", advice)
        def fresh(stamp: float) -> str:
            pair = [replace(tight, updated_at=stamp), replace(roomy, updated_at=stamp)]
            return banner_for(pair, stamp).tip
        self.assertEqual(fresh(NOW), fresh(NOW+1))
        self.assertNotEqual(fresh(NOW), fresh(NOW+600))

    def test_render_animates_pet_frames(self):
        screen, _ = render([sample()], NOW, 0, 0, 80, 30)
        moved, _ = render([sample()], NOW, 2, 0, 80, 30)
        self.assertNotEqual(screen, moved)

    def test_calendar_parses_single_events_and_skips_cancelled(self):
        stamp = datetime.fromtimestamp(NOW+3600, timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: UP017 -- Python 3.10
        text = "\n".join([
            "BEGIN:VCALENDAR",
            "BEGIN:VEVENT", "UID:1", "SUMMARY:Reuniao", f"DTSTART:{stamp}", "END:VEVENT",
            "BEGIN:VEVENT", "UID:2", "SUMMARY:Cancelada", f"DTSTART:{stamp}", "STATUS:CANCELLED", "END:VEVENT",
            "BEGIN:VEVENT", "UID:1", "RECURRENCE-ID:"+stamp, "SUMMARY:Reuniao", f"DTSTART:{stamp}", "END:VEVENT",
            "END:VCALENDAR"])
        events = agenda.parse_ics(text, NOW)
        self.assertEqual([event.summary for event in events], ["Reuniao"])
        self.assertIn("HOJE", agenda.label(events[0], NOW))

    def test_calendar_expands_daily_and_weekly_recurrence(self):
        start = datetime.fromtimestamp(NOW-86400, timezone.utc).replace(hour=10, minute=0)  # noqa: UP017 -- Python 3.10
        text = "\n".join([
            "BEGIN:VEVENT", "SUMMARY:Daily", f"DTSTART:{start.strftime('%Y%m%dT%H%M%SZ')}",
            "RRULE:FREQ=DAILY;COUNT=5", "END:VEVENT"])
        events = agenda.parse_ics(text, NOW)
        self.assertTrue(events)
        self.assertEqual(events[0].summary, "Daily")
        self.assertIn("HOJE", agenda.label(events[0], NOW))
        weekly = "\n".join([
            "BEGIN:VEVENT", "SUMMARY:Weekly", f"DTSTART:{start.strftime('%Y%m%dT%H%M%SZ')}",
            "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "END:VEVENT"])
        self.assertGreaterEqual(len(agenda.parse_ics(weekly, NOW)), 2)

    def test_calendar_without_sources_has_no_events(self):
        empty = agenda.Calendar(places=[])
        empty.start(NOW)
        self.assertEqual(empty.finish(NOW), ())
        empty.close()

    def test_credentials_prefer_environment_and_never_expose_values(self):
        with patch.dict(os.environ, {"OPENCODE_GO_KEY": "env-key"}), \
                patch("notutil.credentials.entry", return_value={"key": "file-key"}):
            from notutil.credentials import secret
            self.assertEqual(secret(("OPENCODE_GO_KEY",), "opencode-go"), "env-key")
            self.assertEqual(secret(("MISSING",), "opencode-go"), "file-key")


if __name__ == "__main__":
    unittest.main()
