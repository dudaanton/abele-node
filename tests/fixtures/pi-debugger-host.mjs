// Fake host: no SDK/auth/model import and no inference.
export function createHost(config, _ask, signal, emit, hooks) {
  return {
    async prompt(text) {
      const cancelled = text === 'cancel-sleep'
      const tool = config.debugger_tools?.find(
        (t) => t.name === (cancelled ? 'debug_sleep' : 'debug_status')
      )
      if (!tool || !hooks?.debugger) throw new Error('debugger_binding_missing')
      const stop = new AbortController()
      if (cancelled) stop.abort()
      const result = await hooks.debugger.call(
        tool.name,
        { debug_session_id: 'selected', ...(cancelled ? { duration_ms: 0 } : {}) },
        cancelled ? stop.signal : signal
      )
      emit({ type: 'pi.debugger.fixture', data: { result } })
      return { subtype: 'success', is_error: false }
    },
    completionResult: (result) => result,
    async abort() {},
    async dispose() {},
  }
}
