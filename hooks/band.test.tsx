// Drives the real hooks the way a session does: a saved session reopens, the app draws the
// hint line under the prompt, and the meter's buttons are pressed. Catches wiring mistakes
// that logic.test.ts cannot see.

import { expect, test } from 'claude-code/testing'

const NOW = 10_000_000
const SAVED = {
  contextTokens: 186_000,
  model: 'claude-opus-5-5',
  readTokens: 184_000,
  newTokens: 1_500,
  ttlMs: 3_600_000,
}

const hint = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'cache-status',
    surface,
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  }) as const

/** A reopened session whose last request finished `minutesAgo` ago; returns what buttons did. */
async function reopenedSession($: any, on: any, minutesAgo: number, fork: object) {
  const ran: string[] = []
  const sent: string[] = []
  on('session.start', (_$: unknown, e: object) => ({ ...e, cwd: 'D:/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_$: unknown, e: { key: string }) => ({
    value: e.key === 'sessions' ? { s1: { ...SAVED, at: NOW - minutesAgo * 60_000 } } : undefined,
  }))
  on('store.set', () => ({ value: undefined }))
  on('model.fork', () => ({ value: fork }))
  on('command.run', (_$: unknown, e: { command: string }) => {
    ran.push(e.command)

    return { text: '' }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    sent.push(e.text)

    return { value: { turnId: 't' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', { component: 'PromptHint' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>ENGINE HINT</Text>
  })

  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)

  return { ran, sent }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on ${surface}, the hint line shows the meter and keeps the app's own hint`, async ($, on) => {
    await reopenedSession($, on, 20, { isAnswered: true, text: 'brief' })
    const ui = await $.ui.mount(hint(surface))

    expect((await ui.find({ text: /40:00/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /hit 99%/ })) !== undefined).toBe(true)
    expect((await ui.find({ key: 'cache-start-fresh' })) !== undefined).toBe(true)
    expect((await ui.find({ key: 'cache-keep-warm' })) === undefined).toBe(true) // not ending yet
    expect((await ui.find({ text: /ENGINE HINT/ })) !== undefined).toBe(true)
  })
}

test('in the last minutes, Keep warm re-reads the cache and restarts the timer', async ($, on) => {
  const fork = {
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 186_000, cache_creation_input_tokens: 0 },
  }
  await reopenedSession($, on, 57, fork)
  const ui = await $.ui.mount(hint('desktop'))
  expect((await ui.find({ text: /3:00/ })) !== undefined).toBe(true)

  await ui.press({ key: 'cache-keep-warm' })
  // The clock stands still in the test, so a restarted timer reads the full hour again.
  expect((await ui.find({ text: /1:00:00/ })) !== undefined).toBe(true)
})

test('Start fresh writes the brief, clears, then sends the brief', async ($, on) => {
  const { ran, sent } = await reopenedSession($, on, 20, { isAnswered: true, text: 'Goal: ship it.' })
  const ui = await $.ui.mount(hint('desktop'))
  await ui.press({ key: 'cache-start-fresh' })

  expect(ran).toEqual(['clear'])
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Goal: ship it.')
})

test('if the brief cannot be written, nothing is cleared', async ($, on) => {
  const { ran, sent } = await reopenedSession($, on, 20, { isAnswered: false, reason: 'api-error' })
  const ui = await $.ui.mount(hint('desktop'))
  await ui.press({ key: 'cache-start-fresh' })

  expect(ran).toEqual([])
  expect(sent).toEqual([])
})
