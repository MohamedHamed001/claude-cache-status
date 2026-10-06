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

/** What the band shows: a dot, its colour, and the text beside it. */
export type BandLine = { dot: string; tone: 'success' | 'warning' | 'error'; text: string }

/**
 * Turn the last request into the band's line.
 * The countdown is "last request + assumed lifetime", so it is an estimate ("~").
 * `percentPerMillion` is the learned rate; when it is null no percentage is shown.
 */
export function describe(
  last: LastRequest,
  ttlMs: number,
  now: number,
  isWorking: boolean,
  percentPerMillion: number | null,
): BandLine {
  const size = formatTokens(last.contextTokens)
  const cost =
    percentPerMillion === null
      ? null
      : formatPercent((reingestUnits(last.contextTokens, ttlMs) / 1_000_000) * percentPerMillion)

  // While a turn is running, every request restarts the timer, so there is no countdown.
  if (isWorking) {
    return { dot: '●', tone: 'success', text: `cache in use · ${size} context` }
  }

  const left = last.at + ttlMs - now
  if (left <= 0) {
    return {
      dot: '○',
      tone: 'error',
      text:
        `cache cold · next message re-ingests about ${size} tokens` +
        (cost ? ` (≈ ${cost} of 5h window)` : ''),
    }
  }

  return {
    dot: '●',
    tone: left < FIVE_MINUTES_MS ? 'warning' : 'success',
    text:
      `cache warm · ~${formatLeft(left)} left · ${size} context` +
      (cost ? ` · re-ingest ≈ ${cost} of 5h` : ''),
  }
}
