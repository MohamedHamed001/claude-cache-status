// The shapes this plugin keeps in the shared store.

/** Today's totals, shared by all sessions on this machine. */
export type Daily = { day: string; savedUnits: number; reingestUnits: number; reingests: number }
