// What the toolkit keeps in $.state: values that must survive a hot reload of the plugin (an update,
// /reload-plugins), which starts its module variables over.

// Each value names the session it belongs to: after a /clear or a resume the process goes on under
// another session id, and the old conversation's values must not come back with a reload.

// The context budget (`isSet` once Claude set it), the last decision note sent (`step`: the share of
// the budget, 0.9, 1.0, 1.1, ...; 0 none), and a compaction Claude asked for.
export type ToolkitContext = {
  sessionId?: string
  budget: number
  isSet?: boolean
  step?: number
  noted?: boolean // before 0.6.5
  pending?: { carryOn: boolean }
}

// The guard notes already sent (session|loop|window|reset|stage), and the task's own handoff file.
export type ToolkitGuard = {
  sessionId?: string
  warned: string[]
  taskHandoff?: string
}

declare module 'claude-code' {
  interface PluginState {
    toolkit: { context: ToolkitContext; guard: ToolkitGuard }
  }
}
