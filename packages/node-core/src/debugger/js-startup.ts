/** Reach Node's first pause before js-debug can evaluate runtime metadata.
 * V8 can crash if an evaluation interrupts entry into the main module while
 * --inspect-brk is still arming that pause (nodejs/node#57606). No evaluations,
 * breakpoints or user expressions are sent through this temporary connection.
 */
export async function holdJsStartup(url: string): Promise<() => void> {
  const socket = new WebSocket(url)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('debugger_startup_pause_timeout')), 10000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        socket.removeEventListener('open', open)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
        if (error) reject(error)
        else resolve()
      }
      const failed = () => finish(new Error('debugger_startup_pause_lost'))
      const open = () => socket.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }))
      const message = (event: MessageEvent) => {
        try {
          const value = JSON.parse(String(event.data))
          if (value.error) return finish(new Error('debugger_startup_pause_rejected'))
          if (value.id === 1)
            socket.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }))
          if (value.method === 'Debugger.paused') finish()
        } catch {
          finish(new Error('debugger_startup_pause_invalid'))
        }
      }
      socket.addEventListener('open', open)
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', failed)
    })
    return () => socket.close()
  } catch (error) {
    socket.close()
    throw error
  }
}
