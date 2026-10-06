// The values this mod keeps in the session's state, and their shapes.

/**
 * What we know from the most recent request this session sent to the model.
 * `at` is when it finished (milliseconds since 1970), which is when the cache timer
 * last restarted. `contextTokens` is how much the next request will send again.
 * `model` is which model answered, because the limit estimate is kept per model.
 * `readTokens` came from the cache, `newTokens` were processed fresh; both are missing
 * in records saved by older versions of this mod.
 */
export type LastRequest = {
  at: number
  contextTokens: number
  model: string
  readTokens?: number
  newTokens?: number
}

/** Where a "Start fresh" press is: nothing running, writing the brief, or clearing. */
export type FreshState = 'idle' | 'writing' | 'clearing'

declare module 'claude-code' {
  interface PluginState {
    'cache-status': {
      /** The most recent request, or null before this session has made one. */
      last: LastRequest | null
      /** How long the cache is assumed to live after a request, in milliseconds. */
      ttlMs: number
      /**
       * Learned from your own turns: how many percent of the 5-hour window one million
       * cost units use up on this session's model. Null until there are enough turns.
       */
      percentPerMillion: number | null
      /** The current time, refreshed every second so the countdown redraws. */
      now: number
      /** A fresh conversation's own size, learned from first requests; for the estimate. */
      baselineTokens: number
      /** Progress of a "Start fresh" press. */
      fresh: FreshState
    }
  }
}
