// The cache mod's rules, as plain functions with no access to the app.
// Keeping them here means they can be tested on their own (see logic.test.ts) and
// register.tsx is left with only the wiring: which event calls which rule.

import type { LastRequest } from '../types'

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

/** Tokens the NEXT request will send: everything this one sent, plus its answer. */
export function contextTokens(usage: Usage): number {
  return promptTokens(usage) + usage.output_tokens
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

/**
 * Correct the assumed cache lifetime from what a request showed.
 *
 * The server never says how long the cache lives (5 minutes or 1 hour), so we watch:
 *   - the cache was still there after a gap longer than 5 minutes -> it must be 1 hour
 *   - the cache was gone after a gap between 5 minutes and 1 hour -> it must be 5 minutes
 * Any other case proves nothing (a short gap fits both; a gap over an hour is cold
 * either way), so the current assumption is kept.
 */
export function learnTtl(currentTtlMs: number, gapMs: number, wasReingest: boolean): number {
  if (!wasReingest && gapMs > FIVE_MINUTES_MS) {
    return ONE_HOUR_MS
  }
  if (wasReingest && gapMs > FIVE_MINUTES_MS && gapMs < ONE_HOUR_MS) {
    return FIVE_MINUTES_MS
  }

  return currentTtlMs
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

/** 186432 -> "186k", 1250000 -> "1.3M", 950 -> "950". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`
  }

  return String(tokens)
}

/** Time left as "42m", or "<1m" for the last minute. */
export function formatLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  return minutes < 1 ? '<1m' : `${minutes}m`
}

/** Time left as "54:36" (minutes and seconds), or "1:00:00" for a full hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Share of the last request that came from the cache, 0 to 1; null before any request. */
export function hitShare(last: LastRequest): number | null {
  const read = last.readTokens ?? null
  const fresh = last.newTokens ?? null
  if (read === null || fresh === null || read + fresh === 0) {
    return null
  }

  return read / (read + fresh)
}

/** A text bar of `width` cells for a share from 0 to 1: how many are filled. */
export function barCells(share: number, width: number): { filled: number; empty: number } {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width)

  return { filled, empty: width - filled }
}

// ---------------------------------------------------------------------------
// Starting fresh: Claude writes a handoff brief, the conversation is cleared, and the
// brief becomes the first message of the new one.
//
// Writing the brief reads the whole conversation once. While the cache is warm that read
// is cheap (cache-read price); once it is cold it costs a full re-ingest. So the best time
// to start fresh is while the cache is still warm, which the band says in its last minutes.
// ---------------------------------------------------------------------------

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

/** Everything the band shows, worked out from the last request and the clock. */
export type BandView = {
  dot: '●' | '○'
  tone: 'success' | 'warning' | 'error'
  /** Share of the last request read from the cache, or null when unknown. */
  hit: number | null
  /** "186k ctx · read 184k · new 1.5k" */
  stats: string
  /** "54:36" while warm; null while a turn runs or once cold. */
  timer: string | null
  /** One short piece of advice: what to do now. */
  advice: string
}

/**
 * Turn the last request into the band.
 * `percentPerMillion` is the learned rate; without it no percentages are shown.
 */
export function describe(
  last: LastRequest,
  ttlMs: number,
  now: number,
  isWorking: boolean,
  percentPerMillion: number | null,
  baselineTokens: number = DEFAULT_BASELINE_TOKENS,
): BandView {
  const size = formatTokens(last.contextTokens)
  const parts = [`${size} ctx`]
  if (last.readTokens !== undefined && last.newTokens !== undefined) {
    parts.push(`read ${formatTokens(last.readTokens)}`, `new ${formatTokens(last.newTokens)}`)
  }
  const percentOf = (units: number) =>
    percentPerMillion === null ? null : formatPercent((units / 1_000_000) * percentPerMillion)
  const reingestCost = percentOf(reingestUnits(last.contextTokens, ttlMs))
  const hit = hitShare(last)

  // While a turn runs, every request restarts the timer, so there is no countdown.
  if (isWorking) {
    return { dot: '●', tone: 'success', hit, stats: parts.join(' · '), timer: null, advice: 'in use' }
  }

  const left = last.at + ttlMs - now
  if (left <= 0) {
    return {
      dot: '○',
      tone: 'error',
      hit: 0,
      stats: parts.join(' · '),
      timer: null,
      advice: `cold: next message re-reads ${size}` + (reingestCost ? ` ≈ ${reingestCost} of 5h` : ''),
    }
  }

  const lastMinutes = left < FIVE_MINUTES_MS
  const freshCost = percentOf(freshStartUnits(last.contextTokens, baselineTokens, ttlMs, true))
  if (reingestCost) {
    parts.push(`re-ingest ≈ ${reingestCost}`)
  }

  return {
    dot: '●',
    tone: lastMinutes ? 'warning' : 'success',
    hit,
    stats: parts.join(' · '),
    timer: formatClock(left),
    advice: lastMinutes
      ? 'send now to keep it warm, or start fresh while it is cheap' + (freshCost ? ` (≈ ${freshCost})` : '')
      : 'warm: keep going',
  }
}
