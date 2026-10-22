// What the toolkit keeps in $.state: values that must survive a hot reload of the plugin (an update,
// /reload-plugins), which starts its module variables over.

// The context budget Claude set for the task, and where its 90 % decision stands.
export type ToolkitContext = {
  budget: number
  noted: boolean
  pending?: { carryOn: boolean }
}

// The guard notes already sent (session|loop|window|reset|stage), and the task's own handoff file.
export type ToolkitGuard = {
  warned: string[]
  taskHandoff?: string
}

declare module 'claude-code' {
  interface PluginState {
    toolkit: { context: ToolkitContext; guard: ToolkitGuard }
  }
}
