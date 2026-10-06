// Prompt-cache status for this session, as one line above the prompt.
//
// Background: every message re-sends the whole conversation to the model. The prompt
// cache is the server keeping the already-processed conversation for a while, so the
// next message only pays a small "read" price. If no request arrives before the timer
// runs out, the cache is dropped ("cold") and the next message pays full price to
// process everything again: a re-ingest. Every request restarts the timer.
//
// What this file does (the rules themselves are in logic.ts):
//   each model request   -> remember when it finished and how big the context is,
//                           and notice if it was a re-ingest
//   every 30 seconds     -> refresh "now" so the countdown redraws
//   end of a turn        -> save the above, report a re-ingest in a pop-up, and use
//                           the turn to learn how much of the 5-hour window tokens cost
//   drawing the band     -> one line: warm with time left, or cold with the cost
//
// The server never reports when the cache expires. The countdown is an estimate:
// last request + assumed lifetime (1 hour, or 5 minutes), corrected by what requests show.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { LastRequest } from '../types'
import {
  FIVE_MINUTES_MS,
  ONE_HOUR_MS,
  addSample,
  contextTokens,
  costUnits,
  describe,
  formatTokens,
  isReingest,
  learnTtl,
  learnedRate,
  promptTokens,
} from './logic'
import type { Usage } from './logic'

const TICK_MS = 30_000
// Saved records older than this are dropped from the store.
const KEEP_SAVED_MS = 3 * 24 * 60 * 60 * 1000
const STORE_KEY = 'sessions'
// Shared by all sessions: per model, the recent "percent per million cost units" samples.
const CALIBRATION_KEY = 'calibration'
type Calibration = Record<string, readonly number[]>

// What is saved per session so a reopened session still knows its last request.
// `model` is optional because records saved by the first version of this mod lack it.
type Saved = Omit<LastRequest, 'model'> & { ttlMs: number; model?: string }

// An atom is a named value the app stores for this mod. Writing to one makes the app
// redraw whatever read it, which is how the band updates by itself.
const last = atom({ plugin: 'cache-status', key: 'last' } as const, null)
const ttlMs = atom({ plugin: 'cache-status', key: 'ttlMs' } as const, ONE_HOUR_MS)
const now = atom({ plugin: 'cache-status', key: 'now' } as const, 0)
const percentPerMillion = atom({ plugin: 'cache-status', key: 'percentPerMillion' } as const, null)

// Plain variables for the turn in progress. They are not drawn, and losing them on a
// reload only costs one pop-up.
let fiveHourPercent: number | null = null // latest known use of the 5-hour window
let percentAtTurnStart: number | null = null
let reingestedTokens = 0 // above 0 when a request in this turn was a re-ingest
let turnUnits = 0 // what this turn has cost so far, in cost units
let turnModel: string | null = null // the model answering this turn
// A turn that used a subagent or two models mixes price levels, so it cannot teach
// us the rate for one model. Such turns are not used as samples.
let isTurnMixed = false

/** Keep the latest 5-hour window figure, and treat a used-up window as overage. */
async function rememberLimits($: EngineInterface, limits: readonly SessionRateLimit[]) {
  fiveHourPercent = limits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null
  // Past a usage limit the cache lifetime drops from 1 hour to 5 minutes.
  if (limits.some(limit => limit.percentUsed >= 100)) {
    await update($, ttlMs, () => FIVE_MINUTES_MS)
  }
}

/** Load the learned rate for a model from the shared store into this session. */
async function loadRate($: EngineInterface, model: string) {
  const all = ((await $.store.get(CALIBRATION_KEY)) ?? {}) as Calibration
  const rate = learnedRate(all[model] ?? [])
  await update($, percentPerMillion, () => rate)
}

/** Called after every model request of the main conversation. */
async function recordRequest($: EngineInterface, usage: Usage & { model: string }) {
  const finishedAt = await $.clock.now()
  const previous = await read($, last)

  if (turnModel !== null && turnModel !== usage.model) {
    isTurnMixed = true
  }
  turnModel = usage.model
  turnUnits += costUnits(usage, await read($, ttlMs))
  // First request on this model in this session: fetch what is already known about it.
  if (previous?.model !== usage.model) {
    await loadRate($, usage.model)
  }

  // With a previous request to compare against, this one tells us two things:
  // whether the cache had gone cold, and (from the gap) how long it really lives.
  if (previous) {
    const wasReingest = isReingest(usage)
    const assumed = await read($, ttlMs)
    const learned = learnTtl(assumed, finishedAt - previous.at, wasReingest)
    if (learned !== assumed) {
      await update($, ttlMs, () => learned)
    }
    if (wasReingest) {
      reingestedTokens = promptTokens(usage)
    }
  }

  await update($, last, () => ({
    at: finishedAt,
    contextTokens: contextTokens(usage),
    model: usage.model,
  }))
  await update($, now, () => finishedAt)
}

/** Save this session's record so it survives the app closing. */
async function save($: EngineInterface) {
  const record = await read($, last)
  if (!record) {
    return
  }

  const id = await $.session.id()
  const all = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, Saved>
  all[id] = { ...record, ttlMs: await read($, ttlMs) }

  // Drop records of sessions not used for a few days, so the store does not grow forever.
  const cutoff = record.at - KEEP_SAVED_MS
  for (const [sessionId, saved] of Object.entries(all)) {
    if (saved.at < cutoff) delete all[sessionId]
  }
  await $.store.set(STORE_KEY, all)
}

/** Use a finished turn as one more sample of "how much window does a cost unit use". */
async function learnFromTurn($: EngineInterface, before: number | null, after: number | null) {
  if (isTurnMixed || turnModel === null) {
    return
  }

  const all = ((await $.store.get(CALIBRATION_KEY)) ?? {}) as Calibration
  const samples = all[turnModel] ?? []
  const updated = addSample(samples, turnUnits, before, after)
  if (updated === samples) {
    return // the turn was too small, or the window reset during it
  }

  await $.store.set(CALIBRATION_KEY, { ...all, [turnModel]: updated })
  const rate = learnedRate(updated)
  await update($, percentPerMillion, () => rate)
}

/** Called when a turn of the main conversation ends. */
async function finishTurn($: EngineInterface) {
  await save($)

  const before = percentAtTurnStart
  await rememberLimits($, (await $.session.usage()).rateLimits)
  const after = fiveHourPercent
  await learnFromTurn($, before, after)

  if (reingestedTokens === 0) {
    return
  }

  const tokens = formatTokens(reingestedTokens)

  // The window figures cover the whole turn, not only the re-ingest, so say "this turn".
  $.ui.toast(
    before !== null && after !== null
      ? `Cache was cold: re-ingested ${tokens} tokens. 5h window ${before}% → ${after}% this turn.`
      : `Cache was cold: re-ingested ${tokens} tokens.`,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Nothing here may stop the session from starting, so every step is optional.
    try {
      const saved = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, Saved>
      const mine = saved[await $.session.id()]
      if (mine) {
        // A record without a model gets '', which simply finds no learned rate.
        const model = mine.model ?? ''
        await update($, last, () => ({ at: mine.at, contextTokens: mine.contextTokens, model }))
        await update($, ttlMs, () => mine.ttlMs)
        await loadRate($, model)
      }

      // If you set the lifetime yourself in settings.json, that is not a guess.
      const settings = (await $.settings.read()) as { promptCacheTtl?: '5m' | '1h' }
      if (settings.promptCacheTtl) {
        const configured = settings.promptCacheTtl === '5m' ? FIVE_MINUTES_MS : ONE_HOUR_MS
        await update($, ttlMs, () => configured)
      }

      await rememberLimits($, (await $.session.usage()).rateLimits)
    } catch {
      // Start with what we have; the first request fills in the rest.
    }

    const tick = async () => {
      const time = await $.clock.now()
      await update($, now, () => time)
    }
    void tick()
    $.clock.every(TICK_MS, () => void tick())

    return next(e)
  })

  // The app raises this when a usage figure moves; we only keep the latest numbers.
  on('session.measure', async ($, e, next) => {
    try {
      await rememberLimits($, e.rateLimits)
    } catch {
      // Keeping a number up to date is never worth breaking the event for.
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    percentAtTurnStart = fiveHourPercent
    reingestedTokens = 0
    turnUnits = 0
    turnModel = null
    isTurnMixed = false

    return next(e)
  })

  // One model request. This event streams the answer piece by piece, so its hook is a
  // generator: `yield* next(e)` passes every piece through untouched and gives back
  // the final result, which carries the request's token counts.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    // Subagents have their own conversation and their own cache; skip them, but
    // note that this turn used one (see isTurnMixed).
    if (e.agentId) {
      isTurnMixed = true
    }
    if (!e.agentId && result.usage) {
      try {
        await recordRequest($, result.usage)
      } catch {
        // Never let bookkeeping break a model request.
      }
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (!e.agentId) {
      try {
        await finishTurn($)
      } catch {
        // Same rule: a failed save or pop-up must not affect the turn.
      }
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods (and the app) may draw here too. Ask for their content first and
    // put it under our line, so nobody hides anybody.
    const beneath = await next(e)
    const record = await read($, last)

    // No request yet in this session, or the app needs the band for a survey.
    if (!record || e.props.hasSurvey) {
      return beneath
    }

    const line = describe(
      record,
      await read($, ttlMs),
      await read($, now),
      e.props.isWorking,
      await read($, percentPerMillion),
    )
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" rowGap={1}>
        {/* Same three columns as other band mods, so stacked lines line up:
            [ 2-cell icon ] [ text, takes the free space ] [ buttons, none here ] */}
        <Box columnGap={1} alignItems="center">
          <Box width={2}>
            <Text color={line.tone}>{line.dot}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {line.text}
            </Text>
          </Box>
        </Box>
        {beneath}
      </Box>
    )
  })
}
