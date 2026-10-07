// Drives the real hooks the way a session does: a model request arrives, then the app draws
// the band and the /cache pane, and their buttons are pressed. The fake engine follows
// prompt-cache-control's tests (MIT, see ../NOTICE.md).

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Calls = {
  ran: string[]
  sent: string[]
  toasts: string[]
  opened: string[]
  filled: string[]
  asked: string[]
  copied: string[]
  /** The guard's answer. */
  answer: string
  /** Start fresh's answer. */
  fresh: string
  canCopy: boolean
}

/** The engine beneath the plugin: one main request that read 80k from the cache. */
function fakeEngine(on: On, fork: object = { isAnswered: true, text: 'Goal: ship it.' }, saved?: object): Calls {
  const calls: Calls = {
    ran: [],
    sent: [],
    toasts: [],
    opened: [],
    filled: [],
    asked: [],
    copied: [],
    answer: 'Send anyway',
    fresh: 'Clear and send the brief',
    canCopy: true,
  }
  on('ui.copy', ($, e) => {
    if (calls.canCopy) calls.copied.push((e as { text: string }).text)

    return { value: calls.canCopy ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never
  })
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
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.open', ($, e) => {
    calls.opened.push(String((e as { id: unknown }).id))

    return { value: undefined } as never
  })
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

    return { text: e.text } as never
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push((e as { text: string }).text)

    return { isFilled: true } as never
  })
  // The guard's question and Start fresh's: each answered with whatever the test set.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const questions = (e as { questions: Array<{ question: string }> }).questions
    const question = questions[0].question
    const isFresh = question.startsWith('Start fresh:')
    if (!isFresh) calls.asked.push(question)

    return { result: { questions, answers: { [question]: isFresh ? calls.fresh : calls.answer } } } as never
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
    // 80k read + 1k wrote + 300 new, as one size; the split is in the pane.
    expect((await ui.find({ text: /81\.3k tok/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /read 80k/ })) === undefined).toBe(true)
    expect((await ui.find({ key: 'open-cache' })) !== undefined).toBe(true)
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
  expect((await ui.find({ text: /302k tok/ })) !== undefined).toBe(true)
})

test('the Cache button opens the /cache pane', async ($, on) => {
  const calls = fakeEngine(on)
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await band($, 'desktop')
  await ui.press({ key: 'open-cache' })
  expect(calls.opened).toEqual(['cache'])
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

test('Start fresh, copy: the brief goes to the clipboard and nothing is cleared', async ($, on) => {
  const calls = fakeEngine(on)
  calls.fresh = 'Copy the brief for a new chat'
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await pane($)
  await ui.press({ key: 'pane-start-fresh' })

  expect(calls.ran).toEqual([])
  expect(calls.sent).toEqual([])
  expect(calls.copied.length).toBe(1)
  expect(calls.copied[0]).toContain('Goal: ship it.')
})

test('Start fresh, copy with no clipboard: the brief lands in the prompt box', async ($, on) => {
  const calls = fakeEngine(on)
  calls.fresh = 'Copy the brief for a new chat'
  calls.canCopy = false
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await pane($)
  await ui.press({ key: 'pane-start-fresh' })
  await settle()

  expect(calls.ran).toEqual([])
  expect(calls.filled.length).toBe(1)
  expect(calls.filled[0]).toContain('Goal: ship it.')
})

test('Start fresh, question dismissed: no brief is written and nothing is cleared', async ($, on) => {
  const calls = fakeEngine(on)
  calls.fresh = ''
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const ui = await pane($)
  await ui.press({ key: 'pane-start-fresh' })

  expect(calls.ran).toEqual([])
  expect(calls.copied).toEqual([])
  expect(calls.toasts).toEqual([])
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

// ---- The guard: a message typed after the cache expired on a big conversation.

/** A reopened session whose 300k-token conversation went cold two hours ago. */
async function coldSession($: Engine, on: On, answer: string) {
  const last = { turnId: 't0', index: 0, model: 'claude-opus-5-5', startedAt: Date.now() - 2 * 3_600_000, read: 300_000, write: 2_000, fresh: 100, output: 50 }
  const calls = fakeEngine(on, { isAnswered: true, text: 'Goal: ship it.' }, { s1: last })
  calls.answer = answer
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true } as never)

  return calls
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
/** Let work the guard left running (clear, then send) finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('guard: Send anyway lets the message through', async ($, on) => {
  const calls = await coldSession($, on, 'Send anyway')
  const result = await $.prompt.submit(typed('carry on'))
  expect(calls.asked.length).toBe(1)
  expect((result as { text?: string }).text).toBe('carry on')
  expect(calls.ran).toEqual([])
})

test('guard: Cancel holds the message and puts it back in the prompt box', async ($, on) => {
  const calls = await coldSession($, on, 'Cancel')
  const result = await $.prompt.submit(typed('carry on'))
  expect((result as { drop?: string }).drop).toContain('Not sent')
  await settle()
  expect(calls.filled).toEqual(['carry on'])
  expect(calls.sent).toEqual([])
})

test('guard: Clear and send starts a new conversation with only the message', async ($, on) => {
  const calls = await coldSession($, on, 'Clear and send, no brief')
  const result = await $.prompt.submit(typed('carry on'))
  expect((result as { drop?: string }).drop).toContain('Clearing')
  await settle()
  expect(calls.ran).toEqual(['clear'])
  expect(calls.sent).toEqual(['carry on'])
})

test('guard: Start fresh sends the brief with the message after it', async ($, on) => {
  const calls = await coldSession($, on, 'Start fresh with a brief')
  await $.prompt.submit(typed('carry on'))
  await settle()
  expect(calls.ran).toEqual(['clear'])
  expect(calls.sent.length).toBe(1)
  expect(calls.sent[0]).toContain('Goal: ship it.')
  expect(calls.sent[0]).toContain('My message:\ncarry on')
})

test('guard: slash commands, a warm cache and a switched-off guard are never held', async ($, on) => {
  const calls = await coldSession($, on, 'Cancel')
  expect(((await $.prompt.submit(typed('/cache'))) as { text?: string }).text).toBe('/cache')
  expect(calls.asked.length).toBe(0)
})

test('guard: off by setting', { options: { guard: false } }, async ($, on) => {
  const calls = await coldSession($, on, 'Cancel')
  expect(((await $.prompt.submit(typed('carry on'))) as { text?: string }).text).toBe('carry on')
  expect(calls.asked.length).toBe(0)
})
