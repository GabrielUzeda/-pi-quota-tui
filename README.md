# pi-quota-tui — AI subscription quotas inside pi

A panel with the quotas of your AI subscriptions, as plain ANSI text, inside [pi](https://pi.dev).
Works in any terminal: no images, no animation, no font or graphics protocol required.
It never sends prompts and never calls a model: it only reads each account's usage state.

![Quota panel right below the pi editor](https://raw.githubusercontent.com/GabrielUzeda/pi-quota-tui/main/assets/preview.svg)

Providers: **OpenCode Go**, **Antigravity** (straight to Google, no local proxy), **Claude Code** and **CommandCode**. **OpenAI Codex** too, but it needs the `codex` CLI (see below).

## Install

```sh
pi install npm:pi-quota-tui
```

Or straight from the repository:

```sh
pi install git:github.com/GabrielUzeda/pi-quota-tui
```

To remove it: `pi remove npm:pi-quota-tui`.

The panel shows up by itself when pi opens, as a list below the editor.
Data refreshes every 2 minutes.

## Layout

Provider name followed by its quota windows separated by `│`, each with a balance bar and the time until it renews.
Two providers share a row when there is room.

```text
Antigravity Gemini ████████ 6d │ Gemini ████████ 6h        OpenCode Go ███░░░░░░ 3.2h
            Claude ░░░░░░░░ 2d │ Argon ░░░░░░░░ 2d         OpenAI Codex ████████ 2.8h
CommandCode ██░░░░░░ 45m
Expired: Antigravity Argon 6d │ CommandCode 12.2d
```

- The bar shows the **remaining balance**; the `│` inside it is the pace mark (where the balance should be for it to last until renewal).
- The bar's color is pace, not balance: green with slack, yellow 3 to 10 points ahead, red above that. Without a known reset/duration it falls back to balance (blue, yellow from 75% used, red from 90%).
- When the windows do not fit, the row wraps with an indent aligned under the first window.
- An exhausted window (100% used) hides itself and the ones below it in the monthly > weekly > 5-hour hierarchy, within the same group. Monthly at zero removes the provider from the panel; weekly at zero leaves only the monthly. Windows without a rank (Antigravity's "Limite") never disappear.
- Whatever exhausted comes back in a final `Expired:` row with the time until it renews. Per group the governing window is the one that blocks the ones below it; rows are sorted from the soonest return to the latest. The tag is a fixed strong red and the time sits on a continuous green → yellow → red ramp, weighed against the window's own cycle: 18h of a weekly is green, 12d of a monthly is not. A provider whose only group is exhausted stays on screen through this row instead of vanishing.
- The wait ramp has no fixed thresholds: it interpolates between `#3fb950`, `#d29922` and `#f85149` in sRGB, easing from 15% of the cycle (fully green) to 60% (fully red). Without a known cycle, the fallback scale is 1h..1d.
- The panel writes no status words: no `OUTDATED`, no `TIGHT`. Diagnostics live in `/quota`.
- Name colors follow each brand: Antigravity blue, OpenAI green, Claude orange; OpenCode and CommandCode use the default text color, which follows light and dark themes. Without truecolor, colors fall back to 256 colors automatically.

## Commands and tool

| Command | What it does |
|---|---|
| `/quotas` | Shows or hides the panel |
| `/quota [all\|opencode\|agy\|commandcode]` | Text report in the chat (never enters the model context) |
| `/usage` | Alias of `/quota` |
| `/quota-login` | Imports the Antigravity accounts from AGY or runs the Google login inside the extension |

The `get_quotas` tool hands the same report to the model when you ask for it.

## Configuration

Each provider only appears if it is configured **and** has at least one quota window. A provider without configuration, or without any reading, stays out of the panel; `/quota` shows why.

| Provider | How to configure it |
|---|---|
| OpenCode Go | `opencode-go` entry in `~/.pi/agent/auth.json`; without it, the `OPENCODE_GO_KEY` env var |
| CommandCode | `commandcode` entry in `auth.json`; without it, `COMMAND_CODE_API_KEY` (or `COMMANDCODE_API_KEY`) |
| Antigravity | Account list in `~/.local/share/pi-quota-tui/agy-accounts.json` (`[{ email, projectId, refreshToken }]`, mode `600`), created by `/quota-login`. AGY's `accounts.json` is only a fallback and `PI_QUOTA_TUI_AGY_ACCOUNTS` overrides both. No proxy required. |
| OpenAI Codex | **Required to pull its quotas:** the `codex` CLI installed and on PATH (quotas are read through `codex app-server`). Without the CLI the provider simply does not show up. |
| Claude Code | Desktop app history (`plan-usage-history.json`) and, without it, the subscription OAuth (`/login` Claude Pro/Max in pi). The first source with data wins; with neither, the provider stays out of the panel |

`auth.json` is only read when its permissions are `600` (no group or other access). **It takes priority**; env vars are the fallback when the section is missing, empty, or the file is rejected.

Optional env var: `PI_QUOTA_TUI_AGY_PAID`, a hint to pick the paid Antigravity account.

## What each provider needs to work

Nothing below is installed by the extension: it only reads what already exists on the machine and talks to the network. If a prerequisite is missing, the provider leaves the panel and `/quota` shows why.

| Provider | Credential | External file or binary | Network |
|---|---|---|---|
| OpenCode Go | `opencode-go` section of `auth.json`, or `OPENCODE_GO_KEY` | — | `GET opencode.ai/zen/go/v1/usage` |
| CommandCode | `commandcode` section of `auth.json`, or `COMMAND_CODE_API_KEY`/`COMMANDCODE_API_KEY` | — | `GET api.commandcode.ai/alpha/billing/credits` and `/usage/summary` |
| Antigravity | `refreshToken` of each Google account (Antigravity CLI OAuth client, embedded in the code) | none: `/quota-login` keeps the file at mode `600` (see below) | Google OAuth + `v1internal:retrieveUserQuotaSummary` |
| OpenAI Codex | the `codex` login itself (the extension does **not** use `auth.json` for it) | **`codex` binary on PATH**, accepting `codex app-server --stdio` | no HTTP call: it speaks JSON-RPC with the subprocess |
| Claude Code | desktop app history, or an `anthropic` token of type `oauth` in `auth.json` (`/login` Claude Pro/Max) | `plan-usage-history.json` (optional) | `GET api.anthropic.com/api/oauth/usage` (OAuth fallback only) |

### `/quota-login`: where the Antigravity accounts come from

`/quota-login` keeps `~/.local/share/pi-quota-tui/agy-accounts.json` (mode `600`) and resolves the accounts in three steps:

1. **A valid file of its own** — refreshes each account's token; if all pass, it does nothing else.
2. **Import from AGY once** — reads `~/.local/share/agy-local-proxy/accounts.json` (the file of **AGY Local Proxy**, a third-party Node proxy at `~/.local/share/agy-local-proxy/server.mjs` that serves Antigravity as an OpenAI endpoint on `127.0.0.1:20128`; the proxy only reads that file, it has no write or login route, so it was born from manual editing). Accounts whose `refreshToken` Google still refreshes are copied into the extension's own file.
3. **Login inside the extension** — with no valid token to import, it opens an OAuth loopback (`127.0.0.1:<port>` + PKCE) with the Antigravity CLI client, shows the URL in the panel and stores the returned `refreshToken`. The account enters without a `projectId`, so collection uses the Cloud Code default project; to pin another one, edit the JSON and add `projectId`.

After that the extension is **self-contained**: the file is its own, AGY can be uninstalled, and `PI_QUOTA_TUI_AGY_ACCOUNTS` still points to another path. The coupling that remains is the credential: the `refreshToken` must have been issued to the Antigravity CLI OAuth client (the `client_id`/`client_secret` embedded in the code); a token from another client is refused on refresh.

## How the data is read

- Requests time out after 25 s. Responses are capped at 2 MiB and redirects are not followed.
- HTTP is only accepted on `127.0.0.1`. Errors surface as short messages, without URL, headers or response body.
- If a request fails, the panel keeps the last reading; the reason shows up in `/quota`.
- Antigravity refreshes the token with Google and queries `v1internal:retrieveUserQuotaSummary` directly, with no local process. Accounts come from a file (see Configuration); families appear separately (Gemini, Claude/GPT, Gemini 4 Argon) and different accounts are neither summed nor averaged. The access token lives in memory only.

## Limitations

- **Antigravity (embedded credential):** token refresh uses the Antigravity CLI OAuth client, published in the code by the author's decision. If Google revokes or restricts that client, the provider stops working and needs a client of its own again (`PI_QUOTA_TUI_AGY_CLIENT_ID`/`_SECRET` would be the path). Per-model cooldowns are not read: they only existed in the proxy.
- Tested on Linux.
- **Claude Code (debt):** the desktop history and the OAuth fallback are wired up, but the OAuth path (`GET https://api.anthropic.com/api/oauth/usage`, header `anthropic-beta: oauth-2025-04-20`, `anthropic` token with `type: "oauth"` from `auth.json`) has **no integration test** — it needs a real Claude Pro/Max login. Only `parseOauthUsage` is tested; cover network/401 once a test credential exists.

## Development

```sh
npm install
npm test          # unit tests plus the extension smoke test
npm run typecheck
```

## Changes

[`CHANGELOG.md`](CHANGELOG.md) records what changed in each version, and every release is a git tag
`vX.Y.Z` plus a GitHub release. Note that npm shows no changelog of its own: npmjs.com renders this
README for the published version and lists publish dates only.

## pi package

This repository is published on npm as [`pi-quota-tui`](https://www.npmjs.com/package/pi-quota-tui) with the `pi-package` keyword, which makes it eligible for the [pi package catalog](https://pi.dev/packages). The `pi.extensions` field points to `./src/index.ts` and `pi.image` to the preview above.

Note: the panel and `/quota` report itself are still written in Portuguese; this README is the English entry point.

## License

MIT. See `LICENSE`.
