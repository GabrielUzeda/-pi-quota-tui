# Changelog

All notable changes to this package. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versioning follows [Semantic Versioning](https://semver.org/).

The npm registry has no changelog field: npmjs.com renders only the README of the published
version and lists publish dates. This file is the human record; each release is also a git tag
`vX.Y.Z` (and a GitHub release).

## [0.4.1] - 2026-11-03

### Added
- `Expired:` row at the end of the panel listing everything that hit 100% used, with the time
  until it renews. Per group the governing window is the one that blocks the ones below it
  (monthly > weekly > 5h); rows are sorted from the soonest return to the latest. A provider whose
  only group is exhausted now stays on screen through this row instead of vanishing.
- Continuous wait ramp for that time, interpolated in sRGB between `#3fb950`, `#d29922` and
  `#f85149`. No fixed thresholds: the scale is relative to the window's own cycle (15% left of the
  cycle is green, 60% is red), falling back to 1h..1d when the cycle is unknown.

### Changed
- `expired()` in `rules.ts` carries the governing window's `duration`, so the wait can be judged
  against the cycle.
- README translated to English and updated with the `Expired:` row and the color ramp; package
  description in English too.

## [0.4.0] - 2026-11-02

### Changed
- An exhausted window (100% used, including 99.96% that rounds to zero) now hides itself and the
  windows below it in the monthly > weekly > 5-hour hierarchy, within the same group.
- Windows with no rank (Antigravity's "Limite") are never hidden and never exhaust a group.

## [0.3.0] - 2026-11-01

### Added
- `/quota-login`: keeps `~/.local/share/pi-quota-tui/agy-accounts.json` (mode `600`), imports the
  accounts AGY already had (validating each refresh token) and, with none valid, runs the Google
  OAuth loopback + PKCE login inside the extension.
- Package metadata for the pi catalog: `pi-package`/`pi-extension` keywords, `pi.image` preview.

### Changed
- Antigravity no longer depends on AGY running: quotas are queried straight from Google
  (`v1internal:retrieveUserQuotaSummary`) and accounts come from the extension's own file.
- Removed the Claude `statusLine` reader (`claude-limits.json`), a file nothing in this package
  produced.
- Repository moved to `github.com/GabrielUzeda/pi-quota-tui`.

## [0.2.0] - 2026-10-24

### Added
- First TypeScript release: the monitor became a pi extension with the quota panel below the
  editor, `/quota`/`/usage` reports and the `get_quotas` tool.
- Providers: OpenCode Go, Antigravity (via AGY at the time), OpenAI Codex, Claude Code and
  CommandCode, each behind its own parser and with pace, health and forecast rules.

[0.4.1]: https://github.com/GabrielUzeda/pi-quota-tui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/GabrielUzeda/pi-quota-tui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/GabrielUzeda/pi-quota-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/GabrielUzeda/pi-quota-tui/releases/tag/v0.2.0
