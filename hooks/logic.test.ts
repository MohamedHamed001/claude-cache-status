// Checks for this plugin's own rules in logic.ts: the 5h-window estimate, what the cache
// saved, and what starting fresh costs. The cache rules from prompt-cache-control are
// tested in pcc.test.ts. Run with: claude plugin test <this plugin's folder>

import { expect, test } from 'claude-code/testing'

import {
  ONE_HOUR_MS,
  addSample,
  addToDaily,
  costUnits,
  dayOf,
  formatPercent,
  freshStartUnits,
  historyTone,
  isReingest,
  learnedRate,
  median,
  payoffRequests,
  reingestUnits,
  savedUnits,
} from './logic'

/** A request's token counts; anything not given is 0. */
const usage = (parts: Partial<Parameters<typeof isReingest>[0]>) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...parts,
})

test('a warm request is not a re-ingest; one that writes almost everything is', () => {
  expect(isReingest(usage({ cache_read_input_tokens: 180_000, cache_creation_input_tokens: 2_000 }))).toBe(false)
  expect(isReingest(usage({ cache_read_input_tokens: 5_000, cache_creation_input_tokens: 180_000 }))).toBe(true)
  expect(isReingest(usage({ cache_creation_input_tokens: 5_000 }))).toBe(false) // too small to matter
})

test('cost units weigh each kind of token by its price ratio', () => {
  // 100 fresh x1 + 1000 read x0.1 + 100 written x2 (1h) + 10 output x5 = 450
  expect(
    costUnits(usage({ input_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100, output_tokens: 10 }), ONE_HOUR_MS),
  ).toBe(450)
  expect(reingestUnits(186_000, ONE_HOUR_MS)).toBe(372_000)
})

test('the 5h rate is the median of usable turns, after five of them', () => {
  expect(median([1, 9, 2])).toBe(2)
  // 400k units moved the window 3.2 points: about 8 percent per million units.
  expect(Math.round(addSample([], 400_000, 40, 43.2)[0])).toBe(8)
  expect(addSample([], 50_000, 40, 41)).toEqual([]) // too small to measure
  expect(addSample([], 400_000, 90, 2)).toEqual([]) // the window reset during the turn
  expect(learnedRate([8, 8, 8, 8])).toBe(null)
  expect(learnedRate([8, 8, 100, 8, 8])).toBe(8)
})

test('percentages are shortened', () => {
  expect(formatPercent(2.84)).toBe('2.8%')
  expect(formatPercent(14.2)).toBe('14%')
  expect(formatPercent(0.03)).toBe('<0.1%')
})

test('a fresh start costs far less while warm than once cold', () => {
  // warm: 186k read at 0.1 + 2k brief at 5 + 32k new start written at 2
  expect(freshStartUnits(186_000, 30_000, ONE_HOUR_MS, true)).toBe(92_600)
  expect(freshStartUnits(186_000, 30_000, ONE_HOUR_MS, false)).toBe(186_000 * 2 + 10_000 + 64_000)
})

test('a big conversation says when a fresh start pays off', () => {
  // 411k context, 30k baseline: a warm fresh start costs 41.1k + 10k + 64k = 115.1k units;
  // each later request saves (411k - 30k) x 0.1 = 38.1k, so it pays off after 4 requests.
  expect(payoffRequests(411_000, 30_000, ONE_HOUR_MS)).toBe(4)
  expect(payoffRequests(20_000, 30_000, ONE_HOUR_MS)).toBe(Infinity)
})

test('history: colours by hit share', () => {
  expect(historyTone(0.99)).toBe('success')
  expect(historyTone(0.5)).toBe('warning')
  expect(historyTone(0.02)).toBe('error')
})

test('today: saved units add up per day and a new day starts over', () => {
  // 100k tokens read from the cache saved 100k x (1 - 0.1) = 90k units.
  expect(savedUnits(usage({ cache_read_input_tokens: 100_000 }))).toBe(90_000)
  const first = addToDaily(null, '2026-10-07', 90_000, 0)
  const second = addToDaily(first, '2026-10-07', 10_000, 372_000)
  expect(second).toEqual({ day: '2026-10-07', savedUnits: 100_000, reingestUnits: 372_000, reingests: 1 })
  expect(addToDaily(second, '2026-10-08', 5, 0)).toEqual({ day: '2026-10-08', savedUnits: 5, reingestUnits: 0, reingests: 0 })
  expect(dayOf(new Date(2026, 9, 7, 23, 59).getTime())).toBe('2026-10-07')
})
