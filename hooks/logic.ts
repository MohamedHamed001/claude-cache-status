// The cache mod's rules, as plain functions with no access to the app.
// Keeping them here means they can be tested on their own (see logic.test.ts) and
// register.tsx is left with only the wiring: which event calls which rule.

import type { Daily } from '../types'

export const FIVE_MINUTES_MS = 5 * 60 * 1000
export const ONE_HOUR_MS = 60 * 60 * 1000

/** The four token counts the API reports for one request. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * Tokens the request sent to the model. They arrive in three buckets:
 *   cache_read      already in the cache, cheap
 *   cache_creation  processed fresh and written to the cache, expensive
 *   input           processed fresh and not cached
 */
export function promptTokens(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

// Below this size a request is too small for the cache to matter.
const MIN_PROMPT_TOKENS = 20_000
// "Cold" means almost nothing came from the cache. It is not exactly zero because a
// small shared part (the system prompt) can still be cached on its own.
const MAX_CACHED_SHARE_WHEN_COLD = 0.25

/**
 * Did this request have to process the conversation from scratch?
 * True when the request was large and less than a quarter of it came from the cache.
 */
export function isReingest(usage: Usage): boolean {
  const sent = promptTokens(usage)
  if (sent < MIN_PROMPT_TOKENS) {
    return false
  }

  return usage.cache_read_input_tokens / sent < MAX_CACHED_SHARE_WHEN_COLD
}

// ---------------------------------------------------------------------------
// Estimating how much of the 5-hour window a re-ingest will use.
//
// Nothing tells us "N tokens = X% of your limit". So we learn it from your own turns:
// after each turn we know what it sent (tokens) and how far the window moved (percent).
//
// Tokens are not all equal. A token read from the cache is far cheaper than one
// processed fresh, and an answer token costs the most. So a turn is first turned into
// "cost units", using the same ratios the API's price list uses. Whether the
// subscription limit follows these exact ratios is NOT documented: it is an assumption,
// which is one reason the result is shown as an estimate.
// ---------------------------------------------------------------------------

const WEIGHT_FRESH_INPUT = 1
const WEIGHT_CACHE_READ = 0.1
const WEIGHT_OUTPUT = 5
// Writing to the cache costs more when the cache is kept for longer.
const WEIGHT_CACHE_WRITE_5M = 1.25
const WEIGHT_CACHE_WRITE_1H = 2

function cacheWriteWeight(ttlMs: number): number {
  return ttlMs <= FIVE_MINUTES_MS ? WEIGHT_CACHE_WRITE_5M : WEIGHT_CACHE_WRITE_1H
}

/** One request expressed in cost units (1 unit = one fresh, uncached input token). */
export function costUnits(usage: Usage, ttlMs: number): number {
  return (
    usage.input_tokens * WEIGHT_FRESH_INPUT +
    usage.cache_read_input_tokens * WEIGHT_CACHE_READ +
    usage.cache_creation_input_tokens * cacheWriteWeight(ttlMs) +
    usage.output_tokens * WEIGHT_OUTPUT
  )
}

/** What a re-ingest costs: the whole context processed fresh and written to the cache. */
export function reingestUnits(contextTokenCount: number, ttlMs: number): number {
  return contextTokenCount * cacheWriteWeight(ttlMs)
}

/** The middle value. Unlike an average, a few wild samples do not move it. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// The window is reported to one decimal (41.3%). A small turn moves it by 0.1 or not
// at all, so its ratio is mostly rounding noise. Only larger turns are used.
const MIN_UNITS_FOR_SAMPLE = 100_000
const MAX_SAMPLES = 40
const MIN_SAMPLES_TO_ESTIMATE = 5

/**
 * Add one finished turn to the list of samples for its model.
 * A sample is "percent of the window per million cost units". Returns the same list
 * when the turn cannot be used.
 */
export function addSample(
  samples: readonly number[],
  units: number,
  percentBefore: number | null,
  percentAfter: number | null,
): readonly number[] {
  if (percentBefore === null || percentAfter === null || units < MIN_UNITS_FOR_SAMPLE) {
    return samples
  }
  // The window went down: it reset during the turn, so the difference means nothing.
  if (percentAfter < percentBefore) {
    return samples
  }

  const sample = (percentAfter - percentBefore) / (units / 1_000_000)

  // Keep only the most recent samples, so the estimate follows changes over time.
  return [...samples, sample].slice(-MAX_SAMPLES)
}

/**
 * The learned rate, or null while there are too few samples to trust.
 * The median is used because your other sessions spend the same window: a turn here
 * that overlapped work elsewhere looks far more expensive than it was.
 */
export function learnedRate(samples: readonly number[]): number | null {
  return samples.length < MIN_SAMPLES_TO_ESTIMATE ? null : median(samples)
}

/** 2.84 -> "2.8%", 14.2 -> "14%", 0.03 -> "<0.1%". */
export function formatPercent(percent: number): string {
  if (percent < 0.1) {
    return '<0.1%'
  }

  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

/** Tokens a handoff brief is assumed to take, for the estimate. */
export const BRIEF_TOKENS = 2_000
/** A fresh conversation's own size (system prompt, tools, instructions) before it is learned. */
export const DEFAULT_BASELINE_TOKENS = 30_000

/** What starting fresh costs now: reading the conversation for the brief, plus the new start. */
export function freshStartUnits(contextTokenCount: number, baselineTokens: number, ttlMs: number, isWarm: boolean): number {
  const readForBrief = isWarm ? contextTokenCount * WEIGHT_CACHE_READ : reingestUnits(contextTokenCount, ttlMs)

  return readForBrief + BRIEF_TOKENS * WEIGHT_OUTPUT + reingestUnits(baselineTokens + BRIEF_TOKENS, ttlMs)
}

/** The prompt that asks Claude for the handoff brief. */
export const BRIEF_PROMPT = [
  'Write a handoff brief so a new conversation can carry on this work without the old transcript.',
  'Use these headings: Goal; Done so far; Current state (files touched, with paths); Decisions and why;',
  'Open questions; Next step (one concrete action). Be specific: paths, commands, names, numbers.',
  'No preamble and no closing remarks. Under 400 words.',
].join(' ')

/** One request's colour in the history strip: mostly cached, partly, or a re-ingest. */
export function historyTone(hit: number): 'success' | 'warning' | 'error' {
  return hit >= 0.75 ? 'success' : hit >= 0.25 ? 'warning' : 'error'
}

/**
 * Cost units the cache saved on one request: every token it served would otherwise have
 * been processed fresh (weight 1) instead of read from the cache (weight 0.1).
 */
export function savedUnits(usage: Usage): number {
  return usage.cache_read_input_tokens * (WEIGHT_FRESH_INPUT - WEIGHT_CACHE_READ)
}

/** The calendar day of a time, as YYYY-MM-DD in local time. */
export function dayOf(ms: number): string {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Add one request to today's totals; a new day starts from zero. */
export function addToDaily(daily: Daily | null, day: string, saved: number, reingest: number): Daily {
  const base = daily && daily.day === day ? daily : { day, savedUnits: 0, reingestUnits: 0, reingests: 0 }

  return {
    day,
    savedUnits: base.savedUnits + saved,
    reingestUnits: base.reingestUnits + reingest,
    reingests: base.reingests + (reingest > 0 ? 1 : 0),
  }
}

/**
 * After how many requests a fresh start (made now, while warm) has paid for itself: each
 * later request re-reads the baseline instead of the whole conversation.
 */
export function payoffRequests(contextTokenCount: number, baselineTokens: number, ttlMs: number): number {
  const savedPerRequest = (contextTokenCount - baselineTokens) * WEIGHT_CACHE_READ
  if (savedPerRequest <= 0) {
    return Infinity
  }

  return Math.ceil(freshStartUnits(contextTokenCount, baselineTokens, ttlMs, true) / savedPerRequest)
}

/**
 * The countdown as drawn. Every change of this text redraws the whole band, and a redraw
 * replaces every plugin's buttons there, so a click landing during one is lost. So the
 * text changes rarely: whole minutes while there is plenty of time ("58m"), then minutes
 * and seconds in 5-second steps for the last five minutes ("4:35").
 */
export function calmClock(leftMs: number): string {
  if (leftMs <= 0) {
    return '0:00'
  }
  if (leftMs > FIVE_MINUTES_MS) {
    return `${Math.ceil(leftMs / 60_000)}m`
  }
  const seconds = Math.ceil(leftMs / 5_000) * 5

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
