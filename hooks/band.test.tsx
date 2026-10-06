// Drives the real hooks the way a session does: a saved session reopens, the app draws the
// band, and "Start fresh" is pressed. Catches wiring mistakes that logic.test.ts cannot see.

import { expect, test } from 'claude-code/testing'

const NOW = 10_000_000
// The session's last request finished 20 minutes ago: warm, 40 minutes left.
const SAVED = { at: NOW - 20 * 60_000, contextTokens: 186_000, model: 'claude-opus-5-5', readTokens: 184_000, newTokens: 1_500, ttlMs: 3_600_000 }

const BAND = {
  plugin: 'cache-status',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/** A reopened session with SAVED as its last request; returns what the press did. */
async function reopenedSession($: any, on: any, fork: { isAnswered: boolean; text?: string; reason?: string }) {
  const ran: string[] = []
  const sent: string[] = []
  on('session.start', (_$: unknown, e: object) => ({ ...e, cwd: 'D:/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: e.key === 'sessions' ? { s1: SAVED } : undefined }))
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
  on('ui.render', { component: 'AbovePrompt' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>ENGINE</Text>
  })

  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)

  return { ran, sent }
}

test('the band shows the hit rate, the countdown and a Start fresh button', async ($, on) => {
  await reopenedSession($, on, { isAnswered: true, text: 'brief' })
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ text: /99%/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /40:00/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /warm: keep going/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'cache-start-fresh' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /ENGINE/ })) !== undefined).toBe(true) // what others drew stays
})

test('Start fresh writes the brief, clears, then sends the brief', async ($, on) => {
  const { ran, sent } = await reopenedSession($, on, { isAnswered: true, text: 'Goal: ship it.' })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cache-start-fresh' })

  expect(ran).toEqual(['clear'])
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Goal: ship it.')
})

test('if the brief cannot be written, nothing is cleared', async ($, on) => {
  const { ran, sent } = await reopenedSession($, on, { isAnswered: false, reason: 'api-error' })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'cache-start-fresh' })

  expect(ran).toEqual([])
  expect(sent).toEqual([])
})
