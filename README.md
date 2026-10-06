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

A meter under the prompt showing the prompt cache for the current session.

**What the prompt cache is.** Every message re-sends the whole conversation to the model. The
server keeps the already-processed conversation for a while, so the next message only pays a
small "read" price for it. If no request arrives before that timer runs out, the cache is
dropped ("cold") and the next message pays full price to process everything again. That is a
re-ingest. Every request restarts the timer.

**What you see.**

One line on the hint line under the prompt, apart from other plugins' bands above it. The app's
own hint (`? for shortcuts`, `esc to interrupt`) stays at its end.

```
● cache [■■■■■■■   ] 42:00 [▪▪▪▪▪▪▪▪▪▪▪▪] 411k ctx · hit 99% · warm · saved ≈ 41% of 5h today  [Start fresh]
```

| Part | Means |
|---|---|
| Battery | Time left before the cache goes cold, draining and turning amber, then red. Drawn as solid colour blocks |
| `42:00` | The countdown, minutes and seconds (an estimate, see below) |
| History strip | One cell per recent request: green read from the cache, amber partly, red a re-ingest |
| `411k ctx · hit 99%` | Conversation size, and the share of the last request read from the cache |
| Advice | `warm`; past 300k tokens, `big context: a fresh start pays off after ~4 requests`; in the last 5 minutes `going cold: 3.0% of 5h at stake`; once cold `cold: next message re-reads 411k ≈ 3.0% of 5h` |
| `saved ≈ 41% of 5h today` | What the cache saved today across your sessions: every token it served would otherwise have been processed fresh. In tokens until the rate is learned |
| After a re-ingest | pop-up: `Cache was cold: re-ingested 186k tokens. 5h window 41% → 44% this turn.` |

The percentages appear once it has seen enough of your turns to estimate them.

**Keep warm** (last 5 minutes). One tiny request over the conversation, read from the cache. A
cache hit restarts the cache's lifetime, so for about a tenth of the conversation's size it buys
another full lifetime instead of a full re-ingest later.

**Start fresh.** One press: Claude writes a handoff brief (goal, what is done, files, decisions,
open questions, next step), the conversation is cleared with `/clear`, and the brief is sent as
the new conversation's first message. If the brief cannot be written, nothing is cleared.

Writing the brief reads the whole conversation once: cheap while the cache is warm, a full
re-ingest once it is cold. So start fresh while it is still warm. For a big conversation the
meter says after how many requests a fresh start has paid for itself: each later request re-reads
a small new conversation instead of the big one.

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
