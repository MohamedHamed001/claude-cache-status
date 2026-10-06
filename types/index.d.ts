// The values this mod keeps in the session's state, and their shapes.

/**
 * What we know from the most recent request this session sent to the model.
 * `at` is when it finished (milliseconds since 1970), which is when the cache timer
 * last restarted. `contextTokens` is how much the next request will send again.
 * `model` is which model answered, because the limit estimate is kept per model.
 */
export type LastRequest = { at: number; contextTokens: number; model: string }

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
      /** The current time, refreshed on a timer so the countdown redraws. */
      now: number
    }
  }
}
