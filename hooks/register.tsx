// cache-status: a prompt-cache meter above the prompt, and a /cache pane.
//
// Built on prompt-cache-control from davila7/claude-code-templates (MIT, see ../NOTICE.md):
// its rules (./pcc.ts, unchanged) and its band and pane design. Added here:
//   - what a re-ingest costs in your 5-hour window, learned from your own turns
//   - what the cache saved today, across your sessions
//   - Keep warm: one tiny request that re-reads the cache and restarts its lifetime
//   - Start fresh: a handoff brief, /clear, and the brief as the new first message
//   - a history strip (one cell per request) and the big-context payoff, in the pane
//
// Background: every message re-sends the whole conversation. The prompt cache keeps the
// processed part for a while (5 minutes, or 1 hour on a subscription), so the next request
// only pays a small "read" price. If none arrives in time it lapses, and the next request
// pays full price to write everything again: a re-ingest.
//
// What happens when:
//   each main request    -> one Sample (read / wrote / new tokens), the lifetime rules,
//                           today's totals, and the 5h-rate bookkeeping for the turn
//   every second         -> redraw the countdown when its text changes (once a minute, or every
//                           5 s near the end: a redraw replaces the band's buttons, so a click
//                           landing during one is lost); countdown pop-ups
//   end of a turn        -> learn the 5h rate from the turn; a pop-up after a re-ingest
//   drawing              -> the band (all surfaces), and /cache

import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Daily } from '../types'
import {
  BRIEF_PROMPT,
  DEFAULT_BASELINE_TOKENS,
  addSample,
  addToDaily,
  calmClock,
  costUnits,
  dayOf,
  formatPercent,
  freshStartUnits,
  historyTone,
  isReingest as isReingestUsage,
  learnedRate,
  median,
  payoffRequests,
  reingestUnits,
  savedUnits,
} from './logic'
import {
  COUNTDOWN_MARKS,
  accountOf,
  advise,
  bar,
  byTurn,
  decideTtl,
  fit,
  fmtClock,
  fmtTokens,
  hitRatio,
  isCachingDisabled,
  lifeColor,
  lifeRatio,
  nextToastMark,
  observeTtl,
  positive,
  promptTokens,
  remainingMs,
  rowRatio,
  segments,
  ttlMs,
} from './pcc'
import type { Account, Advice, CacheEnv, Sample, Ttl } from './pcc'

const PANE = 'cache'
const COMMAND = 'cache'
const KEEP = 200
// Below this a lapsing cache costs too little to interrupt anyone about.
const TOAST_MIN_TOKENS = 20_000
const HISTORY_CELLS = 24
// Shared by all sessions on this machine.
const CALIBRATION_KEY = 'calibration' // per model: recent "percent of 5h per million cost units"
const BASELINE_KEY = 'baseline' // sizes of conversations' first requests
const DAILY_KEY = 'daily' // today's saved and re-ingest totals
// Per session id: its last request, so a reopened session shows its meter at once instead
// of waiting for the next request. Entries older than three days are dropped.
const SESSIONS_KEY = 'sessions'
const KEEP_SAVED_MS = 3 * 24 * 60 * 60 * 1000
const MAX_BASELINE_SAMPLE = 100_000
// The smallest possible request: it re-reads the conversation from the cache, which
// restarts the cache's lifetime, and answers with one word.
const KEEP_WARM_PROMPT = 'Reply with the single word: ok.'

// ---- State. Plain module variables, as in prompt-cache-control: a change calls
// $.ui.invalidate('ui.render') so the band and pane redraw.
let samples: Sample[] = []
let ttl: Ttl = '5m'
let baseTtl: Ttl = '5m'
let pinned = false
let observed: Ttl | undefined
let setting: unknown
let account: Account = 'other'
let ttlSource = 'default'
let envSource = 'default'
let env: CacheEnv = {}
let timer: { cancel: () => void } | undefined
let lastKey = ''
let toastedFor = 0
let toastLevel = Infinity
let isPaneOpen = false
// Ours: the 5h estimate, today's totals, and the two buttons' progress.
let rate: number | null = null // percent of the 5h window per million cost units
let rateModel = ''
let baseline = DEFAULT_BASELINE_TOKENS
let daily: Daily | null = null
let freshState: 'idle' | 'writing' | 'clearing' = 'idle'
let isWarming = false
// The turn in progress, for learning the 5h rate. A turn with a subagent or two models
// mixes price levels, so it is not used as a sample.
let fiveHourPercent: number | null = null
let percentAtTurnStart: number | null = null
let turnUnits = 0
let turnModel: string | null = null
let isTurnMixed = false
let reingestedTokens = 0

type Policy = { warnMs: number; compactAtTokens: number }

function current(policy: Policy, now: number) {
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = last ? isCachingDisabled(last.model, env) : isCachingDisabled('', env)
  const advice: Advice = advise(last, prev, { ttl, ...policy }, now, disabled)
  const left = last ? remainingMs(last, ttl, now) : 0

  return { last, advice, left }
}

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}

/** A share of the 5h window for some cost units, or null until the rate is learned. */
function percentOf(units: number): string | null {
  return rate === null ? null : formatPercent((units / 1_000_000) * rate)
}

/** A sample's token counts in the shape logic.ts takes. */
const usageOf = (s: Sample) => ({
  input_tokens: s.fresh,
  output_tokens: s.output,
  cache_read_input_tokens: s.read,
  cache_creation_input_tokens: s.write,
})

/** A request is a re-ingest when it is large and almost nothing came from the cache. */
const isReingest = (s: Sample) => isReingestUsage(usageOf(s))

// The promptCacheTtl setting, from the settings files that can carry it (local over
// project over user). From prompt-cache-control.
async function readSetting($: EngineInterface): Promise<unknown> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  for (const file of files) {
    if (!file) continue
    try {
      const value = JSON.parse(String(await $.fs.read(file))).promptCacheTtl
      if (value === '5m' || value === '1h') return value
    } catch {
      // missing or unreadable: the next file
    }
  }

  return undefined
}

/** Load the learned 5h rate for a model from the shared store. */
async function loadRate($: EngineInterface, model: string) {
  const all = ((await $.store.get(CALIBRATION_KEY)) ?? {}) as Record<string, readonly number[]>
  rate = learnedRate(all[model] ?? [])
  rateModel = model
}

/**
 * Record one request that read the conversation (a turn's request or a Keep warm): the
 * lifetime rules, today's totals, and the first request's size as a fresh-start baseline.
 */
async function recordSample($: EngineInterface, sample: Sample, options: Record<string, unknown>) {
  const isFirst = samples.length === 0
  samples.push(sample)
  if (samples.length > KEEP) samples = samples.slice(-KEEP)

  if (!pinned) {
    // The account can change under a session: a subscription running out of plan usage
    // moves to usage credits. From prompt-cache-control.
    account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
    const choice = decideTtl(options.ttl, env, setting, account)
    baseTtl = choice.ttl
    envSource = choice.source
    if (observed === undefined) {
      ttl = baseTtl
      ttlSource = envSource
    }
    const seen = observeTtl(samples[samples.length - 2], sample, observed)
    if (seen !== observed) {
      observed = seen
      ttl = seen ?? baseTtl
      ttlSource = `observed from request timing; ${envSource} said ${baseTtl}`
    }
  }

  if (sample.model !== rateModel) {
    await loadRate($, sample.model).catch(() => undefined)
  }
  if (isFirst && promptTokens(sample) <= MAX_BASELINE_SAMPLE) {
    const sizes = [...(((await $.store.get(BASELINE_KEY)) ?? []) as number[]), promptTokens(sample)].slice(-20)
    await $.store.set(BASELINE_KEY, sizes)
    baseline = median(sizes)
  }

  // Today's totals live in the shared store: other sessions add to them too.
  const reingest = !isFirst && isReingest(sample) ? costUnits(usageOf(sample), ttlMs(ttl)) : 0
  const stored = ((await $.store.get(DAILY_KEY)) ?? null) as Daily | null
  daily = addToDaily(stored, dayOf(sample.startedAt), savedUnits(usageOf(sample)), reingest)
  await $.store.set(DAILY_KEY, daily)

  // This session's last request, for when it is reopened.
  const id = await $.session.id()
  const saved = ((await $.store.get(SESSIONS_KEY)) ?? {}) as Record<string, Sample>
  saved[id] = sample
  for (const [key, old] of Object.entries(saved)) {
    if (old.startedAt < sample.startedAt - KEEP_SAVED_MS) delete saved[key]
  }
  await $.store.set(SESSIONS_KEY, saved)

  lastKey = ''
  $.ui.invalidate('ui.render')
}

/**
 * Keep warm: one tiny request over the conversation. Reading it from the cache restarts
 * the cache's lifetime (a cache hit refreshes the entry), for about a tenth of the
 * conversation's size instead of a full re-ingest later.
 */
async function keepWarm($: EngineInterface, options: Record<string, unknown>) {
  const last = samples[samples.length - 1]
  if (isWarming || !last) return
  isWarming = true
  $.ui.invalidate('ui.render')
  try {
    const startedAt = Date.now()
    const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
    if (!reply.isAnswered || !reply.usage) {
      $.ui.toast(`Keep warm failed (${reply.isAnswered ? 'no usage' : reply.reason}).`)
      return
    }
    const sample: Sample = {
      turnId: `keep-warm-${startedAt}`,
      index: 0,
      model: last.model,
      startedAt,
      read: reply.usage.cache_read_input_tokens,
      write: reply.usage.cache_creation_input_tokens,
      fresh: reply.usage.input_tokens,
      output: reply.usage.output_tokens,
    }
    await recordSample($, sample, options)
    const cost = percentOf(costUnits(usageOf(sample), ttlMs(ttl)))
    $.ui.toast(isReingest(sample) ? 'The cache had already lapsed: it was written again.' : `Cache kept warm${cost ? ` for ≈ ${cost} of 5h` : ''}.`)
  } catch (error) {
    $.ui.toast(`Keep warm failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isWarming = false
    $.ui.invalidate('ui.render')
  }
}

/**
 * Start fresh: Claude writes a handoff brief, the conversation is cleared, and the brief
 * is sent as the new conversation's first message (with `followUp`, the message the guard
 * held back, after it). If the brief cannot be written, nothing is cleared.
 */
async function startFresh($: EngineInterface, followUp?: string) {
  if (freshState !== 'idle') return
  freshState = 'writing'
  $.ui.invalidate('ui.render')
  try {
    // Reads the conversation through the cache: cheap while it is warm.
    const reply = await $.model.fork({ prompt: BRIEF_PROMPT })
    if (!reply.isAnswered) {
      $.ui.toast(`Could not write the handoff brief (${reply.reason}). Nothing was cleared.`)
      return
    }
    freshState = 'clearing'
    $.ui.invalidate('ui.render')
    await $.command.run({ command: 'clear' })
    // Not awaited: it is queued and starts once the cleared session is idle.
    void $.prompt
      .submit({
        text:
          `Handoff brief from the previous conversation, which was cleared to start fresh:\n\n${reply.text.trim()}` +
          (followUp ? `\n\nMy message:\n${followUp}` : ''),
        asUser: true,
      })
      .catch(() => undefined)
    $.ui.toast('Started fresh: handoff brief sent')
  } catch (error) {
    $.ui.toast(`Start fresh failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    freshState = 'idle'
    $.ui.invalidate('ui.render')
  }
}

/** The guard's "Clear and send": a new conversation with only the held message. */
async function clearAndSend($: EngineInterface, text: string) {
  try {
    // Started from inside the prompt's own hook: wait until that hook has returned and the
    // held prompt is dropped, or the clear would be asked for while the prompt is in flight.
    await $.clock.sleep(100)
    await $.command.run({ command: 'clear' })
    void $.prompt.submit({ text, asUser: true }).catch(() => undefined)
  } catch (error) {
    $.ui.toast(`Could not clear: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The guard's answers, compared exactly with what the question dialog returns.
const GUARD_SEND = 'Send anyway'
const GUARD_FRESH = 'Start fresh with a brief'
const GUARD_CLEAR = 'Clear and send, no brief'
const GUARD_CANCEL = 'Cancel'

/** Keep the latest 5-hour window figure. */
function rememberLimits(limits: readonly SessionRateLimit[]) {
  fiveHourPercent = limits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null
}

/** End of a main turn: learn the 5h rate from it, and report a re-ingest. */
async function finishTurn($: EngineInterface) {
  const before = percentAtTurnStart
  rememberLimits((await $.session.usage()).rateLimits)
  const after = fiveHourPercent

  if (!isTurnMixed && turnModel !== null) {
    const all = ((await $.store.get(CALIBRATION_KEY)) ?? {}) as Record<string, readonly number[]>
    const known = all[turnModel] ?? []
    const updated = addSample(known, turnUnits, before, after)
    if (updated !== known) {
      await $.store.set(CALIBRATION_KEY, { ...all, [turnModel]: updated })
      rate = learnedRate(updated)
    }
  }

  if (reingestedTokens > 0) {
    const tokens = fmtTokens(reingestedTokens)
    $.ui.toast(
      before !== null && after !== null
        ? `Cache was cold: re-wrote ${tokens} tokens. 5h window ${before}% → ${after}% this turn.`
        : `Cache was cold: re-wrote ${tokens} tokens.`,
    )
  }
}

/** Open the /cache pane. The band hides while it is open: the pane says more. */
async function openPane($: EngineInterface) {
  isPaneOpen = true
  await $.ui.open({ id: PANE, title: 'Cache', focus: true })
  $.ui.invalidate('ui.render')
}

/** A /clear starts a new conversation: its cache is a new one. */
function forgetConversation() {
  samples = []
  lastKey = ''
  toastedFor = 0
  observed = undefined
  ttl = baseTtl
  ttlSource = envSource
}

export const register: Register = (on, options) => {
  const policy: Policy = {
    warnMs: positive(options.warnSeconds, 60) * 1000,
    compactAtTokens: positive(options.compactAtTokens, 100_000),
  }
  const wantToast = options.toast !== false
  const wantGuard = options.guard !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    forgetConversation()
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
      disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
      disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
      disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
      disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
    }
    pinned = options.ttl === '5m' || options.ttl === '1h'
    setting = await readSetting($)
    const usage = await $.session.usage().catch(() => undefined)
    account = accountOf(usage?.rateLimits ?? [])
    rememberLimits(usage?.rateLimits ?? [])
    const choice = decideTtl(options.ttl, env, setting, account)
    baseTtl = choice.ttl
    ttl = baseTtl
    envSource = choice.source
    ttlSource = envSource

    try {
      const sizes = ((await $.store.get(BASELINE_KEY)) ?? []) as number[]
      if (sizes.length > 0) baseline = median(sizes)
      const stored = ((await $.store.get(DAILY_KEY)) ?? null) as Daily | null
      daily = stored && stored.day === dayOf(Date.now()) ? stored : null
      // A reopened session: its last request, so the meter shows at once.
      const saved = ((await $.store.get(SESSIONS_KEY)) ?? {}) as Record<string, Sample>
      const mine = saved[await $.session.id()]
      if (mine && typeof mine.startedAt === 'number' && typeof mine.read === 'number') {
        samples = [mine]
        await loadRate($, mine.model).catch(() => undefined)
      }
    } catch {
      // The meter works without them.
    }

    await $.command
      .register({ name: COMMAND, description: 'Prompt cache: time left, per-turn table, Keep warm and Start fresh', argumentHint: '[stop]', immediate: true })
      .catch(() => undefined)

    timer?.cancel()
    timer = $.clock.every(1000, () => {
      const now = Date.now()
      const { last, advice, left } = current(policy, now)
      const key = `${advice.kind}|${advice.text}|${left > 0 ? calmClock(left) : ''}`
      if (key !== lastKey) {
        lastKey = key
        $.ui.invalidate('ui.render')
      }
      if (wantToast && last && left > 0 && promptTokens(last) >= TOAST_MIN_TOKENS) {
        if (toastedFor !== last.startedAt) {
          toastedFor = last.startedAt
          toastLevel = Infinity
        }
        // The first pop-up at warnSeconds, then at 10, 3, 2 and 1 seconds; a late tick
        // skips to the newest one. From prompt-cache-control.
        const secs = Math.ceil(left / 1000)
        const mark = nextToastMark(secs, policy.warnMs / 1000, toastLevel)
        if (mark !== undefined) {
          toastLevel = mark
          const stake = percentOf(reingestUnits(promptTokens(last), ttlMs(ttl)))
          const tail =
            secs <= COUNTDOWN_MARKS[0]
              ? 'send a message now'
              : `send a message or Keep warm to keep ${fmtTokens(promptTokens(last))} tokens warm${stake ? ` (${stake} of 5h at stake)` : ''}`
          $.ui.toast(`cache expires in ${secs >= 60 ? fmtClock(left) : `${secs}s`}: ${tail}`)
        }
      }
    })

    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      forgetConversation()
      $.ui.invalidate('ui.render')

      return next(e)
    }
    timer?.cancel()
    timer = undefined

    return next(e)
  })

  // The guard: a message typed after the cache expired on a big conversation re-writes all
  // of it at full price. Ask first. Only the person's own typed prompts are held; slash
  // commands and prompts a plugin sends pass.
  on('prompt.submit', async ($, e, next) => {
    if (!wantGuard || e.origin?.kind !== 'composer' || e.text.trimStart().startsWith('/')) {
      return next(e)
    }
    const { last, left } = current(policy, Date.now())
    if (!last || left > 0 || promptTokens(last) < policy.compactAtTokens) {
      return next(e)
    }

    const size = promptTokens(last)
    const cost = percentOf(reingestUnits(size, ttlMs(ttl)))
    let answer = GUARD_CANCEL
    try {
      answer = await $.ui.ask(
        `The prompt cache expired. This message will re-write ${fmtTokens(size)} tokens` +
          `${cost ? `, about ${cost} of your 5-hour limit` : ''}. ` +
          'Starting fresh costs the same once (the brief re-reads the conversation) but makes every later ' +
          'request cheap; clearing without a brief skips the cost and Claude forgets this conversation. What now?',
        { header: 'Cache expired', options: [GUARD_SEND, GUARD_FRESH, GUARD_CLEAR, GUARD_CANCEL] },
      )
    } catch {
      // Dismissed: treat it as Cancel, so nothing expensive happens by accident.
    }

    if (answer === GUARD_SEND) {
      return next(e)
    }
    // The other paths run after this hook returns: /clear only runs once the session is idle.
    if (answer === GUARD_FRESH) {
      void startFresh($, e.text)

      return { drop: 'Starting fresh: your message follows the handoff brief.' }
    }
    if (answer === GUARD_CLEAR) {
      void clearAndSend($, e.text)

      return { drop: 'Clearing, then sending your message to a new conversation.' }
    }
    void $.prompt.fill({ text: e.text }).catch(() => undefined)

    return { drop: 'Not sent: the cache had expired. Your message is back in the prompt box.' }
  })

  on('session.measure', async ($, e, next) => {
    rememberLimits(e.rateLimits)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    percentAtTurnStart = fiveHourPercent
    turnUnits = 0
    turnModel = null
    isTurnMixed = false
    reingestedTokens = 0

    return next(e)
  })

  // Each main-loop request: what the cache did with it. Subagents have their own
  // prefixes and are left out (but they make the turn useless as a 5h sample).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      isTurnMixed = true

      return yield* next(e)
    }
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      try {
        const sample: Sample = {
          turnId: e.turnId,
          index: e.index,
          model: r.usage.model || e.model,
          startedAt,
          read: r.usage.cache_read_input_tokens,
          write: r.usage.cache_creation_input_tokens,
          fresh: r.usage.input_tokens,
          output: r.usage.output_tokens,
        }
        if (turnModel !== null && turnModel !== sample.model) isTurnMixed = true
        turnModel = sample.model
        turnUnits += costUnits(usageOf(sample), ttlMs(ttl))
        if (samples.length > 0 && isReingest(sample)) reingestedTokens = promptTokens(sample)
        await recordSample($, sample, options)
      } catch {
        // Never let bookkeeping break a model request.
      }
    }

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await finishTurn($).catch(() => undefined)
    }

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'stop') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      isPaneOpen = false

      return { text: 'Cache pane closed.' }
    }
    await openPane($)
    const { advice } = current(policy, Date.now())

    return { text: `${ttl} cache (${ttlSource}) · ${advice.text}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isPaneOpen = false

    return next(e)
  })

  // ---- The band: one row in the prompt-cache-control style, with our extras.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods draw here too: ask for theirs first and keep it under our row.
    const beneath = await next(e)
    if (e.props.hasSurvey || isPaneOpen) return beneath
    const now = Date.now()
    const { last, advice, left } = current(policy, now)
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns ?? 100
    const color = COLOR[advice.kind]

    // Before this conversation's first request (a new session, or after /clear): a quiet
    // placeholder, so the meter is visibly there.
    if (!last) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{fit(`cache: ${advice.text}`, columns)}</Text>
          {beneath}
        </Box>
      )
    }

    const ratio = hitRatio(last)
    // From 90 columns the row has room for today's savings after the advice.
    const wide = columns >= 90
    const size = promptTokens(last)
    const isIdle = freshState === 'idle' && !isWarming && !e.props.isWorking
    const icon = advice.kind === 'warm' ? '●' : advice.kind === 'soon' ? '▲' : advice.kind === 'expired' || advice.kind === 'miss' ? '✖' : '○'

    // Our addition to the advice: what is at stake, or what was saved.
    let extra = ''
    const stake = percentOf(reingestUnits(size, ttlMs(ttl)))
    if (advice.kind === 'soon' && stake) extra = ` · ${stake} of 5h at stake`
    else if (advice.kind === 'expired' && stake) extra = ` · ≈ ${stake} of 5h`
    else if (advice.kind === 'warm' && wide && daily && daily.savedUnits > 0) {
      const saved = percentOf(daily.savedUnits)
      extra = saved ? ` · saved ≈ ${saved} of 5h today` : ` · saved ${fmtTokens(Math.round(daily.savedUnits))} today`
    }
    const status = freshState === 'writing' ? 'writing handoff brief…' : freshState === 'clearing' ? 'clearing…' : isWarming ? 'keeping warm…' : advice.text + extra

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text bold color={color}>{icon}</Text>
          <Text bold color="cyan">cache</Text>
          <Text color={color}>{bar(ratio, 10)}</Text>
          <Text bold>{`${Math.round(ratio * 100)}%`}</Text>
          {/* The conversation's size; the read / wrote / new split is in the pane. */}
          <Text dimColor>{`${fmtTokens(size)} tok`}</Text>
          {advice.kind !== 'uncached' && advice.kind !== 'off' && (
            <Text bold color={left > 0 ? lifeColor(left, ttl, policy.warnMs) : 'red'}>{left > 0 ? `⏱ ${calmClock(left)}` : '⏱ 0:00'}</Text>
          )}
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">{`${ttl} · ${status}`}</Text>
          </Box>
          {isIdle && advice.kind === 'soon' && <Button key="cache-keep-warm" label="Keep warm" onPress={() => keepWarm($, options)} />}
          {isIdle && advice.kind === 'expired' && size >= policy.compactAtTokens && (
            <Button key="cache-start-fresh" label="Start fresh" onPress={() => startFresh($)} />
          )}
          <Button key="open-cache" label="Cache" onPress={() => openPane($)} />
        </Box>
        {beneath}
      </Box>
    )
  })

  // ---- The pane: prompt-cache-control's layout, then history, today and the buttons.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 1)
    // HTML collapses runs of spaces and trims a text's ends; a no-break space keeps them.
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    const now = Date.now()
    const { last, advice, left } = current(policy, now)
    const all = byTurn(samples)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off'
    const clockColor = counting ? lifeColor(left, ttl, policy.warnMs) : undefined
    const stateColor = advice.kind === 'expired' || advice.kind === 'miss' ? 'red' : (clockColor ?? COLOR[advice.kind])
    const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')
    // Solid bars are filled Boxes, not block characters, so HTML draws no seams.
    const solid = (key: string, parts: [number, string | undefined][]) => (
      <Box key={key} flexDirection="row" height={1} flexShrink={0}>
        {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
      </Box>
    )
    const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
      </Box>
    )

    const barW = Math.min(width, 40)
    const life = lifeRatio(left, ttl)
    const lifeFilled = Math.round(life * barW)
    const [sr, sw, sn] = last ? segments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
    const rows = all.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 24))
    const icon = advice.kind === 'warm' ? '●' : advice.kind === 'soon' ? '▲' : advice.kind === 'expired' || advice.kind === 'miss' ? '✖' : '○'
    const strip = samples.slice(-HISTORY_CELLS)
    const size = last ? promptTokens(last) : 0
    const payoff = last ? payoffRequests(size, baseline, ttlMs(ttl)) : Infinity
    const isIdle = freshState === 'idle' && !isWarming
    const saved = daily && daily.savedUnits > 0 ? percentOf(daily.savedUnits) : null
    const lost = daily && daily.reingestUnits > 0 ? percentOf(daily.reingestUnits) : null
    const reingestNow = last ? percentOf(reingestUnits(size, ttlMs(ttl))) : null
    const freshNow = last ? percentOf(freshStartUnits(size, baseline, ttlMs(ttl), left > 0)) : null
    const costLine = [
      reingestNow && `this context re-ingests at ${reingestNow} of 5h`,
      Number.isFinite(payoff) && size >= policy.compactAtTokens && `a fresh start pays off after ~${payoff} requests`,
      freshNow && `starting fresh now ≈ ${freshNow}`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{sp('⚡ PROMPT CACHE')}</Text>
          <Text dimColor>{sp(`· ${ttl} lifetime (${ttlSource})`)}</Text>
        </Box>

        <Box key="clock" flexDirection="column" marginTop={1}>
          <Text bold color={clockColor}>{sp(counting ? `⏱ ${left > 0 ? calmClock(left) : '0:00'}` : '⏱ --:--')}</Text>
          {counting ? (
            <Box flexDirection="row" columnGap={1}>
              {solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']])}
              <Text dimColor>{sp(`${Math.round(life * 100)}%`)}</Text>
            </Box>
          ) : null}
        </Box>

        <Box key="advice" marginTop={1} flexDirection="column">
          <Text bold color={stateColor}>{sp(`${icon} ${advice.text}`)}</Text>
          {last ? <Text dimColor>{sp(fit(`${last.model} · prompt ${fmtTokens(size)} tokens`, width))}</Text> : null}
        </Box>

        {last ? (
          <Box key="stack" flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={1}>
              {solid('stack', [[sr, 'green'], [sw, 'yellow'], [sn, 'cyan']])}
              <Text bold color={hitColor(Math.round(hitRatio(last) * 100))}>{sp(`${Math.round(hitRatio(last) * 100)}% hit`)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{sp(`■ read ${fmtTokens(last.read)}`)}</Text>
              <Text color="yellow">{sp(`■ wrote ${fmtTokens(last.write)}`)}</Text>
              <Text color="cyan">{sp(`■ new ${fmtTokens(last.fresh)}`)}</Text>
            </Box>
          </Box>
        ) : null}

        {strip.length > 1 ? (
          <Box key="history" flexDirection="column" marginTop={1}>
            <Text dimColor>{sp('History · one cell per request · red = written again')}</Text>
            <Box flexDirection="row">
              {strip.map((s, i) => (
                <Box key={`hist:${i}`} width={2} height={1} flexShrink={0} marginRight={1} backgroundColor={historyColor(hitRatio(s))} />
              ))}
            </Box>
          </Box>
        ) : null}

        <Box key="table" flexDirection="column" marginTop={1}>
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:turn', 4, 'turn', 'cyan', true)}
            {cell('h:steps', 5, 'steps', 'cyan', true)}
            {cell('h:read', 6, 'read', 'green', true)}
            {cell('h:wrote', 6, 'wrote', 'yellow', true)}
            {cell('h:new', 5, 'new', 'cyan', true)}
            {cell('h:hit', 4, 'hit', 'magenta', true)}
          </Box>
          {rows.length === 0 ? <Text dimColor>{sp('no requests yet')}</Text> : null}
          {rows.map((row, i) => {
            const n = all.length - rows.length + i + 1
            const pct = Math.round(rowRatio(row) * 100)

            return (
              <Box key={`t:${row.turnId}`} flexDirection="row" columnGap={1}>
                {cell(`c:turn:${row.turnId}`, 4, String(n))}
                {cell(`c:steps:${row.turnId}`, 5, String(row.steps))}
                {cell(`c:read:${row.turnId}`, 6, fmtTokens(row.read), 'green')}
                {cell(`c:wrote:${row.turnId}`, 6, fmtTokens(row.write), 'yellow')}
                {cell(`c:new:${row.turnId}`, 5, fmtTokens(row.fresh), 'cyan')}
                {cell(`c:hit:${row.turnId}`, 4, `${pct}%`, hitColor(pct), true)}
              </Box>
            )
          })}
        </Box>

        <Box key="today" flexDirection="column" marginTop={1}>
          <Text bold color="cyan">{sp('Today, all sessions')}</Text>
          {daily ? (
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{sp(saved ? `saved ≈ ${saved} of 5h` : `saved ${fmtTokens(Math.round(daily.savedUnits))} tokens`)}</Text>
              <Text color={daily.reingests > 0 ? 'red' : undefined} dimColor={daily.reingests === 0}>
                {sp(`${daily.reingests} re-ingest${daily.reingests === 1 ? '' : 's'}${lost ? ` cost ${lost}` : ''}`)}
              </Text>
            </Box>
          ) : (
            <Text dimColor>{sp('nothing yet today')}</Text>
          )}
          {last ? <Text dimColor>{sp(costLine || 'the percentages appear once enough turns are learned')}</Text> : null}
        </Box>

        <Box key="foot" marginTop={1} flexDirection="row" columnGap={1}>
          {last && isIdle && left > 0 && <Button key="pane-keep-warm" label="Keep warm" onPress={() => keepWarm($, options)} />}
          {last && isIdle && <Button key="pane-start-fresh" label="Start fresh" onPress={() => startFresh($)} />}
          <Button
            key="close"
            label="Close"
            onPress={async () => {
              await $.ui.close({ id: PANE }).catch(() => undefined)
              isPaneOpen = false
              $.ui.invalidate('ui.render')
            }}
          />
        </Box>

        <Box key="legend" marginTop={1} flexDirection="column">
          <Text color="green">{sp('■ read: served by the cache')}</Text>
          <Text color="yellow">{sp('■ wrote: new cache entry')}</Text>
          <Text color="cyan">{sp('■ new: sent uncached')}</Text>
        </Box>
      </Box>
    )
  })
}

/** A history cell's colour from its hit share: green, yellow, or red for a re-write. */
function historyColor(hit: number): string {
  const tone = historyTone(hit)

  return tone === 'success' ? 'green' : tone === 'warning' ? 'yellow' : 'red'
}
