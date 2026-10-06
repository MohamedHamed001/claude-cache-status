// Drives the real hooks the way a session does: a model request arrives, then the app draws
// the band and the /cache pane, and their buttons are pressed. The fake engine follows
// prompt-cache-control's tests (MIT, see ../NOTICE.md).

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Calls = { ran: string[]; sent: string[]; toasts: string[] }

/** The engine beneath the plugin: one main request that read 80k from the cache. */
function fakeEngine(on: On, fork: object = { isAnswered: true, text: 'Goal: ship it.' }, saved?: object): Calls {
  const calls: Calls = { ran: [], sent: [], toasts: [] }
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', () => ({ value: 'D:/repo' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('store.get', ($, e) => ({ value: (e as { key: string }).key === 'sessions' ? saved : undefined }))
  on('store.set', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: undefined }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    calls.toasts.push(String((e as { text: unknown }).text))

    return { value: undefined }
  })
  on('model.fork', () => ({ value: fork }) as never)
  on('command.run', ($, e) => {
    calls.ran.push(e.command)

    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    calls.sent.push(e.text)

    return { value: { turnId: 't' } } as never
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1_000 },
    } as never
  })
  // What the app and other plugins draw in the band: it must stay under ours.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>OTHERS</Text>
  })

  return calls
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const band = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'cache-status', surface, component: 'AbovePrompt', props: BAND } as never)
const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'cache-status', surface: 'desktop', component: 'Pane', requestId: 'cache', props: { bodyColumns: 80 } } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on ${surface}: a placeholder before the first request, then the meter above what others drew`, async ($, on) => {
    fakeEngine(on)
    await $.session.start({ cwd: 'D:/repo', surface, isInteractive: true } as never)
    let ui = await band($, surface)
    expect((await ui.find({ text: /no request yet/ })) !== undefined).toBe(true)

    await step($)
    ui = await band($, surface)
    expect((await ui.find({ text: /98%/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /read 80k/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /wrote 1k/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /⏱/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /warm: keep going/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /OTHERS/ })) !== undefined).toBe(true)
  })
}

test('a reopened session shows its meter at once, from its saved last request', async ($, on) => {
  const last = { turnId: 't0', index: 0, model: 'claude-opus-5-5', startedAt: Date.now() - 60_000, read: 300_000, write: 2_000, fresh: 100, output: 50 }
  fakeEngine(on, undefined, { s1: last })
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  const ui = await band($, 'desktop')
  expect((await ui.find({ text: /read 300k/ })) !== undefined).toBe(true)
})

// warnSeconds above the lifetime puts the cache in its last stretch at once.
test('when it is about to lapse, Keep warm re-reads the cache', { options: { ttl: '5m', warnSeconds: 3600 } }, async ($, on) => {
  const calls = fakeEngine(on, {
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 81_000, cache_creation_input_tokens: 0 },
  })
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await band($, 'desktop')
  expect((await ui.find({ text: /expires soon/ })) !== undefined).toBe(true)

  await ui.press({ key: 'cache-keep-warm' })
  expect(calls.toasts.some(text => text.startsWith('Cache kept warm'))).toBe(true)
})

test('the /cache pane shows the table, today and the buttons', async ($, on) => {
  fakeEngine(on)
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  await step($)
  const ui = await pane($)
  expect((await ui.find({ text: /PROMPT\u00a0CACHE/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /History/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Today,\u00a0all\u00a0sessions/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'pane-keep-warm' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'pane-start-fresh' })) !== undefined).toBe(true)
})

test('Start fresh writes the brief, clears, then sends the brief', async ($, on) => {
  const calls = fakeEngine(on)
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await pane($)
  await ui.press({ key: 'pane-start-fresh' })

  expect(calls.ran).toEqual(['clear'])
  expect(calls.sent.length).toBe(1)
  expect(calls.sent[0]).toContain('Goal: ship it.')
})

test('if the brief cannot be written, nothing is cleared', async ($, on) => {
  const calls = fakeEngine(on, { isAnswered: false, reason: 'api-error' })
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await pane($)
  await ui.press({ key: 'pane-start-fresh' })

  expect(calls.ran).toEqual([])
  expect(calls.sent).toEqual([])
})
