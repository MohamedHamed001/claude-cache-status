# claude-cache-status

A plugin for [Claude Code](https://docs.claude.com/en/docs/claude-code): **cache-status**, a
prompt-cache meter above the prompt.

Built on [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control)
by Daniel Ávila (MIT): its cache rules, band and pane. This plugin adds what a re-ingest costs
in your 5-hour window, what the cache saved today, **Keep warm**, **Start fresh** and a history
strip. See [NOTICE.md](NOTICE.md).

Part of [claude-mods](https://github.com/MohamedHamed001/claude-mods), which lists this plugin and its siblings.

## Install

```
/plugin marketplace add MohamedHamed001/claude-cache-status
/plugin install cache-status@claude-cache-status
```

Then start a new session: a session reads its plugins once, when it starts. Update later with
`/plugin marketplace update claude-cache-status`.

## Requirements

- **Claude Code 2.1.287 or newer.** The plugin uses function hooks (TypeScript modules the app
  loads), which older versions do not run.
- Windows, macOS or Linux; terminal and desktop app.

## What the prompt cache is

Every message re-sends the whole conversation to the model. The server keeps the processed
part for a while (5 minutes, or 1 hour on a Claude subscription within its plan), so the next
request only pays a small "read" price (about a tenth). Every request that reads it restarts the
clock. If none arrives in time it lapses, and the next request pays full price to write the
whole conversation again: a re-ingest. On a big conversation that is the expensive moment.

## The band

One row above the prompt:

```
● cache ██████████ 99% read 409k wrote 1.2k new 300 ⏱ 42:00 1h · warm: keep going · saved ≈ 41% of 5h today
▲ cache ██████████ 99% read 409k wrote 1.2k new 300 ⏱ 0:48 1h · expires soon: any message refreshes it for free · 3.0% of 5h at stake   [Keep warm]
✖ cache ██████████ 99% ⏱ 0:00 1h · expired: the next message rewrites 411k tokens. /compact first, or /clear if the task is done · ≈ 3.0% of 5h   [Start fresh]
✖ cache ░░░░░░░░░░ 0% read 0 wrote 412k new 300 ⏱ 1:00:00 1h · cache missed: model changed (…)
```

| Part | Means |
|---|---|
| Bar and `99%` | Share of the last request read from the cache |
| `read · wrote · new` | The last request: served by the cache, written to it, sent uncached (a narrow window shows the total instead) |
| `⏱ 42:00` | Time left, counted from the start of the last request; green, yellow below 40% of the lifetime, red in the last minute |
| `1h` | The cache lifetime in use (see below) |
| Advice | What to do: keep going, send a message soon, start fresh or `/compact`, or why the cache missed |
| `3.0% of 5h` | What a re-ingest of this conversation would cost in your 5-hour window, learned from your own turns |
| `saved ≈ 41% of 5h today` | What the cache saved today across your sessions: every token it served would otherwise have been processed fresh |

Pop-ups come at the warning threshold (60 s by default) and again at 10, 3, 2 and 1 seconds, for
conversations of 20k tokens or more. After a re-ingest a pop-up says what it cost:
`Cache was cold: re-wrote 186k tokens. 5h window 41% → 44% this turn.`

**Keep warm** (in the last minute). One tiny request over the conversation, read from the
cache. A cache hit restarts the cache's lifetime, so for about a tenth of the conversation's
size it buys another full lifetime instead of a full re-ingest later.

**Start fresh** (once expired on a big conversation, and always in the pane). Claude writes a
handoff brief (goal, what is done, files, decisions, open questions, next step), the
conversation is cleared with `/clear`, and the brief is sent as the new conversation's first
message. If the brief cannot be written, nothing is cleared. Writing the brief reads the whole
conversation once: cheap while the cache is warm, a full re-ingest once it has lapsed, so the
best time is while it is still warm.

## The /cache pane

`/cache` (or `/cache stop` to close): the time left as a draining bar, the last request as a
stacked read / wrote / new bar, a history strip (one cell per request, red where the cache was
written again), one row per turn, today's totals (saved, re-ingests and what they cost), what
this conversation would cost to re-ingest or to start fresh now, after how many requests a fresh
start pays off, and the Keep warm and Start fresh buttons. The band hides while the pane is open.

## Which lifetime

From prompt-cache-control, following Claude Code's own rules: the plugin's `ttl` setting, then
`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting,
`ENABLE_PROMPT_CACHING_1H`, then the account (1 hour on a Claude subscription within its plan,
5 minutes on usage credits, an API key or a cloud provider). It then corrects itself from the
traffic: a hit more than 5 minutes after the previous request proves 1 hour; a miss 5 to 60
minutes later says 5 minutes.

## Settings

In `/config` (or `pluginConfigs` in settings):

| Setting | Default | Means |
|---|---|---|
| `ttl` | `auto` | `auto`, `5m` or `1h` |
| `warnSeconds` | 60 | When the band turns yellow, Keep warm appears and the first pop-up comes |
| `compactAtTokens` | 100000 | From this size up, an expired cache offers Start fresh |
| `toast` | on | The pop-ups near expiry |

## What is exact and what is estimated

- Token counts, hit rate, misses: exact, from each response.
- Time left: an estimate. The server never reports when the cache expires; this is "start of the
  last request + lifetime", with the lifetime worked out as above.
- Share of the 5-hour window: an estimate learned from your own turns. It weighs tokens by the
  API price list's ratios (cache read 0.1, fresh input 1, cache write 1.25 or 2, output 5). How
  subscription limits really weigh them is not documented. Turns that are small, use a subagent
  or two models, or span a window reset are not used; the rate is the median of the last 40
  usable turns per model, shared across your sessions on one machine. Until then the band shows
  tokens instead of percentages.

**Switch it off.** `/plugin` and disable `cache-status`. It listens to every model request, so
this is the first thing to try if replies ever stall after installing it.

## Developing

```
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed version, add this folder to
`CLAUDE_CODE_PLUGIN_DIRS` (separated by `;` on Windows, `:` elsewhere), for example in the `env`
block of `~/.claude/settings.json`, then start a new session.

## Licence

MIT, see [LICENSE](LICENSE). Includes code from prompt-cache-control (MIT), see
[NOTICE.md](NOTICE.md).

Not affiliated with Anthropic.
