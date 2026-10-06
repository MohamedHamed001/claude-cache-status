// Checks for the rules in logic.ts. Run with: claude plugin test <this mod's folder>
// Each test builds a small, realistic situation and states what the rule must say.

import { expect, test } from 'claude-code/testing'

import {
  FIVE_MINUTES_MS,
  ONE_HOUR_MS,
  addSample,
  contextTokens,
  costUnits,
  describe,
  formatLeft,
  formatPercent,
  formatTokens,
  isReingest,
  learnTtl,
  learnedRate,
  median,
  reingestUnits,
} from './logic'

const MINUTE = 60_000

/** A request's token counts; anything not given is 0. */
const usage = (parts: Partial<Parameters<typeof isReingest>[0]>) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...parts,
})

test('a warm request is not a re-ingest', () => {
  // 180k came from the cache, only 2k was new.
  expect(isReingest(usage({ cache_read_input_tokens: 180_000, cache_creation_input_tokens: 2_000 }))).toBe(false)
})

test('a request that writes almost everything fresh is a re-ingest', () => {
  // Only the 20k system prompt was still cached; 166k had to be processed again.
  expect(isReingest(usage({ cache_read_input_tokens: 20_000, cache_creation_input_tokens: 166_000 }))).toBe(true)
})

test('a big new file in a warm conversation is not a re-ingest', () => {
  // 50k cached conversation + a 100k file just read: a third still came from cache.
  expect(isReingest(usage({ cache_read_input_tokens: 50_000, cache_creation_input_tokens: 100_000 }))).toBe(false)
})

test('a tiny request is never called a re-ingest', () => {
  expect(isReingest(usage({ input_tokens: 3_000 }))).toBe(false)
})

test('context for the next request includes the answer', () => {
  expect(
    contextTokens(usage({ input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 50 })),
  ).toBe(1_260)
})

test('cache still warm after 20 minutes proves the 1-hour lifetime', () => {
  expect(learnTtl(FIVE_MINUTES_MS, 20 * MINUTE, false)).toBe(ONE_HOUR_MS)
})

test('cache gone after 20 minutes proves the 5-minute lifetime', () => {
  expect(learnTtl(ONE_HOUR_MS, 20 * MINUTE, true)).toBe(FIVE_MINUTES_MS)
})

test('gaps that fit both lifetimes change nothing', () => {
  expect(learnTtl(ONE_HOUR_MS, 2 * MINUTE, false)).toBe(ONE_HOUR_MS) // warm after 2m: both would be
  expect(learnTtl(ONE_HOUR_MS, 2 * MINUTE, true)).toBe(ONE_HOUR_MS) // lost after 2m: not the timer (a compaction, say)
  expect(learnTtl(FIVE_MINUTES_MS, 90 * MINUTE, true)).toBe(FIVE_MINUTES_MS) // cold after 90m: both would be
})

test('numbers are shortened for the band', () => {
  expect(formatTokens(186_432)).toBe('186k')
  expect(formatTokens(1_250_000)).toBe('1.3M')
  expect(formatTokens(950)).toBe('950')
  expect(formatLeft(42 * MINUTE + 30_000)).toBe('42m')
  expect(formatLeft(20_000)).toBe('<1m')
})

test('cost units weigh each kind of token by its price ratio', () => {
  // 1000 fresh + 10000 cached (x0.1) + 2000 written (x2 for a 1h cache) + 100 answer (x5)
  const request = usage({ input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 100 })
  expect(costUnits(request, ONE_HOUR_MS)).toBe(1_000 + 1_000 + 4_000 + 500)
  // The same request on a 5-minute cache writes at x1.25 instead.
  expect(costUnits(request, FIVE_MINUTES_MS)).toBe(1_000 + 1_000 + 2_500 + 500)
})

test('a re-ingest costs the whole context at the cache-write rate', () => {
  expect(reingestUnits(186_000, ONE_HOUR_MS)).toBe(372_000)
})

test('median ignores a wild sample that an average would follow', () => {
  expect(median([8, 9, 7, 8, 60])).toBe(8)
  expect(median([1, 3])).toBe(2)
})

test('a turn becomes a sample: percent moved per million cost units', () => {
  // 500k units moved the window from 41.0% to 45.0%: 8% per million.
  expect(addSample([], 500_000, 41, 45)).toEqual([8])
})

test('turns that cannot teach anything are not added', () => {
  const existing = [8]
  expect(addSample(existing, 20_000, 41, 41.1)).toBe(existing) // too small: rounding noise
  expect(addSample(existing, 500_000, 97, 3)).toBe(existing) // window reset mid-turn
  expect(addSample(existing, 500_000, null, 45)).toBe(existing) // no figure to compare
})

test('no estimate until there are five samples', () => {
  expect(learnedRate([8, 9, 7, 8])).toBe(null)
  expect(learnedRate([8, 9, 7, 8, 60])).toBe(8)
})

test('percentages are shortened for the band', () => {
  expect(formatPercent(2.84)).toBe('2.8%')
  expect(formatPercent(14.2)).toBe('14%')
  expect(formatPercent(0.03)).toBe('<0.1%')
})

const LAST = { at: 1_000_000, contextTokens: 186_000, model: 'claude-opus-5-5' }

test('band: warm with time left', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 18 * MINUTE, false, null)).toEqual({
    dot: '●',
    tone: 'success',
    text: 'cache warm · ~42m left · 186k context',
  })
})

test('band: amber in the last five minutes', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 57 * MINUTE, false, null).tone).toBe('warning')
})

test('band: cold once the lifetime has passed', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 61 * MINUTE, false, null)).toEqual({
    dot: '○',
    tone: 'error',
    text: 'cache cold · next message re-ingests about 186k tokens',
  })
})

test('band: no countdown while a turn is running', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 61 * MINUTE, true, 8).text).toBe('cache in use · 186k context')
})

test('band: with a learned rate, the cold line says what the re-ingest will cost', () => {
  // 186k context x2 = 372k units; at 8% per million that is about 3.0%.
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 61 * MINUTE, false, 8).text).toBe(
    'cache cold · next message re-ingests about 186k tokens (≈ 3.0% of 5h window)',
  )
})

test('band: with a learned rate, the warm line shows the cost of letting it go cold', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 18 * MINUTE, false, 8).text).toBe(
    'cache warm · ~42m left · 186k context · re-ingest ≈ 3.0% of 5h',
  )
})
