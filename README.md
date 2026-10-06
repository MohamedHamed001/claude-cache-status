# claude-cache-status

A plugin for [Claude Code](https://docs.claude.com/en/docs/claude-code): **cache-status**.

Shows this session's prompt-cache status above the prompt: time left before it goes cold, context size, and what a re-ingest would cost.

Part of [claude-mods](https://github.com/MohamedHamed001/claude-mods), which lists this plugin and its siblings.

## Install

```
/plugin marketplace add MohamedHamed001/claude-cache-status
/plugin install cache-status@claude-cache-status
```

Then start a new session: a session reads its plugins once, when it starts. Update later with `/plugin marketplace update claude-cache-status`.

## Requirements

- **Claude Code 2.1.28x or newer.** The plugins use function hooks (TypeScript modules the app
  loads), which older versions do not run.
- **Windows, macOS or Linux.** Process handling is detected per session: PowerShell on Windows,
  `ps` and `pkill` elsewhere. Developed on Windows; macOS has not been tested yet.

## What it does

One line above the prompt showing the prompt cache for the current session.

**What the prompt cache is.** Every message re-sends the whole conversation to the model. The
server keeps the already-processed conversation for a while, so the next message only pays a
small "read" price for it. If no request arrives before that timer runs out, the cache is
dropped ("cold") and the next message pays full price to process everything again. That is a
re-ingest. Every request restarts the timer.

**What you see.**

| State | Line |
|---|---|
| Turn running | `● cache in use · 186k context` |
| Warm | `● cache warm · ~42m left · 186k context` |
| Last 5 minutes | the same, with an amber dot |
| Cold | `○ cache cold · next message re-ingests about 186k tokens` |
| After a re-ingest | pop-up: `Cache was cold: re-ingested 186k tokens. 5h window 41% → 44% this turn.` |

Once it has seen enough of your turns, the warm and cold lines also show what a re-ingest would
cost: `re-ingest ≈ 3.0% of 5h`.

**What is exact and what is estimated.**

- Context size: exact, from the token counts of the last response.
- Whether a re-ingest happened: exact, seen after the fact (almost nothing was read from the
  cache).
- Time left: an estimate. The server never reports when the cache expires, so this is "last
  request + assumed lifetime". The lifetime starts at 1 hour (5 minutes if a usage window is
  used up, or whatever `promptCacheTtl` says in your settings) and is corrected by what later
  requests show.
- Share of the 5-hour window: an estimate learned from your own turns. It weighs tokens by the
  API price list's ratios (cache read 0.1, fresh input 1, cache write 1.25 or 2, output 5). How
  subscription limits really weigh them is not documented. Turns that are small, use a subagent
  or two models, or span a window reset are not used. The rate is the median of the last 40
  usable turns per model, shared across your sessions on one machine.

**Switch it off.** `/plugin` and disable `cache-status`. It listens to every model request, so
this is the first thing to try if replies ever stall after installing it.

## Developing

```
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed version, add this folder to `CLAUDE_CODE_PLUGIN_DIRS` (separated by `;` on Windows, `:` elsewhere), for example in the `env` block of `~/.claude/settings.json`, then start a new session.

## Licence

MIT, see [LICENSE](LICENSE).

Not affiliated with Anthropic.
