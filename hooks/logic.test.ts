// Checks for the rules in logic.ts. Run with: claude plugin test <this mod's folder>
// Each test builds a small, realistic situation and states what the rule must say.

import { expect, test } from 'claude-code/testing'

import {
  FIVE_MINUTES_MS,
  ONE_HOUR_MS,
  addSample,
  contextTokens,
  costUnits,
  barCells,
  describe,
  formatClock,
  formatLeft,
  freshStartUnits,
  hitShare,
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


// 186k context; the last request read 184k from the cache and processed 1.5k fresh.
const LAST = { at: 1_000_000, contextTokens: 186_000, model: 'claude-opus-5-5', readTokens: 184_000, newTokens: 1_500 }

test('clock: minutes and seconds, hours when the full hour is left', () => {
  expect(formatClock(54 * MINUTE + 36_000)).toBe('54:36')
  expect(formatClock(5_000)).toBe('0:05')
  expect(formatClock(ONE_HOUR_MS)).toBe('1:00:00')
  expect(formatClock(-1)).toBe('0:00')
})

test('hit share and bar: how much of the last request came from the cache', () => {
  expect(Math.round((hitShare(LAST) ?? 0) * 1000)).toBe(992)
  expect(hitShare({ at: 0, contextTokens: 1, model: 'm' })).toBe(null) // older saved record
  expect(barCells(0.99, 12)).toEqual({ filled: 12, empty: 0 })
  expect(barCells(0.5, 12)).toEqual({ filled: 6, empty: 6 })
  expect(barCells(1.5, 12)).toEqual({ filled: 12, empty: 0 })
})

test('band: warm with the countdown and the token split', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 18 * MINUTE, false, null)).toMatchObject({
    dot: '●',
    tone: 'success',
    stats: '186k ctx · read 184k · new 2k',
    timer: '42:00',
    advice: 'warm: keep going',
  })
})

test('band: in the last five minutes it says to send now or start fresh while cheap', () => {
  // Fresh start while warm: 186k read at 0.1 + 2k brief at 5 + 32k new start at 2 = 92.6k units.
  const view = describe(LAST, ONE_HOUR_MS, LAST.at + 57 * MINUTE, false, 8)
  expect(view.tone).toBe('warning')
  expect(view.timer).toBe('3:00')
  expect(view.advice).toBe('send now to keep it warm, or start fresh while it is cheap (≈ 0.7%)')
})

test('band: cold says what the next message will cost', () => {
  // 186k context x2 = 372k units; at 8% per million that is about 3.0%.
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 61 * MINUTE, false, 8)).toMatchObject({
    dot: '○',
    tone: 'error',
    hit: 0,
    timer: null,
    advice: 'cold: next message re-reads 186k ≈ 3.0% of 5h',
  })
})

test('band: no countdown while a turn is running', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 61 * MINUTE, true, 8)).toMatchObject({ timer: null, advice: 'in use' })
})

test('band: with a learned rate, the warm line shows the cost of letting it go cold', () => {
  expect(describe(LAST, ONE_HOUR_MS, LAST.at + 18 * MINUTE, false, 8).stats).toBe(
    '186k ctx · read 184k · new 2k · re-ingest ≈ 3.0%',
  )
})

test('a fresh start costs far less while warm than once cold', () => {
  const warm = freshStartUnits(186_000, 30_000, ONE_HOUR_MS, true)
  const cold = freshStartUnits(186_000, 30_000, ONE_HOUR_MS, false)
  expect(warm).toBe(92_600)
  expect(cold).toBe(186_000 * 2 + 10_000 + 64_000)
})
