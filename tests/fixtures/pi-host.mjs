// Deterministic SDK/runtime double. No SDK import, credentials, gateway or model call.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { materializeNativeState } from '../../packages/provider-pi/dist/native-state.js'
import {
  PiApprovalPolicy,
  PiExtensionUiBridge,
  PiSdkWorker,
} from '../../packages/provider-pi/dist/host.js'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
export async function createHost(config, ask, signal, emit, hooks) {
  const policy = new PiApprovalPolicy(ask, signal),
    ui = new PiExtensionUiBridge(ask, signal, emit)
  let rebind, beforeInvalidate
  const runtime = {
    setRebindSession: (fn) => (rebind = fn),
    setBeforeSessionInvalidate: (fn) => (beforeInvalidate = fn),
  }
  const createSession = (id = randomUUID(), file = join(config.sessionDir, id + '.jsonl')) => {
    const listeners = new Set()
    const event = (e) => {
      for (const fn of listeners) fn(e)
    }
    let bindings
    // Like 0.87.0, assignment alone does not create the file. The node host
    // must materialize it before publishing pi.session.bound.
    const sessionManager = {
      getSessionId: () => id,
      getSessionFile: () => file,
      getHeader: () => ({ type: 'session', version: 3, id, cwd: config.cwd }),
      getEntries: () => [],
      getLeafId: () => null,
      setSessionFile: () => {},
      resetLeaf: () => {},
      branch: () => {},
    }
    return {
      sessionManager,
      sessionId: id,
      sessionFile: file,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      bindExtensions: async (b) => {
        bindings = b
      },
      waitForIdle: async () => {},
      abort: async () => {},
      event,
      prompt: async (text, options) => {
        // Route the fake task independently of the node reporting instruction.
        text = text.split('\n\nWorker reporting:')[0]
        if (text === '/unsupported') {
          // SDK 0.87.0 registered commands swallow exceptions and report them
          // through the bound listener, then acknowledge handled preflight.
          try {
            await bindings.uiContext.custom(() => {})
          } catch (error) {
            bindings.onError({ event: 'command:/unsupported', error })
          }
          options.preflightResult(true)
          return
        }
        options.preflightResult(true)
        event({ type: 'message_start', message: { role: 'user', content: text } })
        event({ type: 'agent_start' })
        if (text === 'crash') process.exit(23)
        if (text === 'error') throw Error('Authorization Bearer FAKE_CREDENTIAL')
        if (text === 'badmap')
          emit({
            type: 'pi.session.bound',
            data: { native_session_id: id, native_session_file: '/outside/untrusted.jsonl' },
          })
        if (text === 'unsupported') await bindings.uiContext.custom(() => {})
        const reused = async (session) => {
          const toolCallId = 'reused-native-id',
            args = { path: 'same.txt' }
          session.event({ type: 'tool_execution_start', toolCallId, toolName: 'read', args })
          const blocked = await policy.intercept({
            tool_use_id: toolCallId,
            tool_name: 'read',
            input: args,
            native_session_id: session.sessionId,
          })
          session.event({
            type: 'tool_execution_end',
            toolCallId,
            toolName: 'read',
            result: { content: [] },
            isError: !!blocked,
          })
        }
        if (text === 'replacegrants') await reused(runtime.session)
        if (text === 'replace' || text === 'replacegrants') {
          beforeInvalidate?.()
          runtime.session = createSession()
          await rebind(runtime.session)
          // Emission through the stale session must not reach the node journal.
          event({
            type: 'message_end',
            message: { role: 'assistant', content: 'STALE_SECRET', stopReason: 'stop' },
          })
        }
        const active = runtime.session
        if (text === 'replacegrants') await reused(active)
        for (const action of text === 'allow-deny' ? ['allow', 'deny'] : [text]) {
          if (!['allow', 'deny', 'expiry', 'hang'].includes(action)) continue
          const path =
            action === 'allow'
              ? 'pi-allowed.txt'
              : action === 'deny'
                ? 'pi-denied.txt'
                : 'pi-expired.txt'
          const args = { path, content: 'approved' },
            toolCallId = randomUUID()
          active.event({ type: 'tool_execution_start', toolCallId, toolName: 'write', args })
          const blocked = await policy.intercept({
            tool_use_id: toolCallId,
            tool_name: 'write',
            input: args,
            native_session_id: active.sessionId,
          })
          if (!blocked) writeFileSync(join(config.cwd, path), 'approved')
          active.event({
            type: 'tool_execution_end',
            toolCallId,
            toolName: 'write',
            result: { content: [{ type: 'text', text: blocked ? 'denied' : 'done' }] },
            isError: !!blocked,
          })
        }
        if (text === 'durable' || text === 'anchored-descendants') {
          const toolCallId = randomUUID(),
            args = {
              command:
                text === 'durable'
                  ? 'printf effect > pi-effect.txt'
                  : 'sleep 60 >/dev/null 2>&1 & echo $! > pi-anchored-child.pid; wait',
            }
          active.event({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args })
          const blocked = await policy.intercept({
            tool_use_id: toolCallId,
            tool_name: 'bash',
            input: args,
            native_session_id: active.sessionId,
          })
          if (!blocked) {
            if (!hooks) throw Error('process supervisor required')
            await hooks
              .bashOperations()
              .exec(args.command, config.cwd, { onData: () => {}, signal })
            // Only reachable AFTER both durable admission and durable release ACK.
            writeFileSync(join(config.cwd, 'pi-release-ack.txt'), 'acknowledged')
            active.event({ type: 'fixture_release_ack' })
          }
        }
        if (text === 'detached') {
          const toolCallId = randomUUID(),
            args = { command: 'sleep 60 >/dev/null 2>&1 & echo $! > pi-detached.pid' }
          active.event({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args })
          const blocked = await policy.intercept({
            tool_use_id: toolCallId,
            tool_name: 'bash',
            input: args,
            native_session_id: active.sessionId,
          })
          if (!blocked) {
            // The real SDK's default: detached shell exits promptly and its
            // background child is no longer a descendant before the 250 ms poll.
            if (hooks)
              await hooks
                .bashOperations()
                .exec(args.command, config.cwd, { onData: () => {}, signal })
            else {
              const shell = spawn('/bin/bash', ['-c', args.command], {
                cwd: config.cwd,
                detached: true,
                stdio: 'ignore',
              })
              await new Promise((resolve, reject) => {
                shell.once('exit', resolve)
                shell.once('error', reject)
              })
            }
          }
        }
        if (text === 'descendants') {
          const toolCallId = randomUUID(),
            args = { command: 'disposable process fixture' }
          active.event({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args })
          const blocked = await policy.intercept({
            tool_use_id: toolCallId,
            tool_name: 'bash',
            input: args,
            native_session_id: active.sessionId,
          })
          if (!blocked) {
            const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
              stdio: 'ignore',
            })
            writeFileSync(join(config.cwd, 'pi-child.pid'), String(child.pid))
            await new Promise((r) => signal.addEventListener('abort', r, { once: true }))
          }
        }
        if (text === 'parallel') {
          for (const toolCallId of ['call-a', 'call-b'])
            active.event({
              type: 'tool_execution_start',
              toolCallId,
              toolName: 'read',
              args: { path: toolCallId },
            })
          const approvals = []
          for (const toolCallId of ['call-a', 'call-b'])
            approvals.push(
              await policy.intercept({
                tool_use_id: toolCallId,
                tool_name: 'read',
                input: { path: toolCallId },
                native_session_id: active.sessionId,
              })
            )
          for (const toolCallId of ['call-b', 'call-a'])
            active.event({
              type: 'tool_execution_end',
              toolCallId,
              toolName: 'read',
              result: { content: [{ type: 'text', text: toolCallId }] },
              isError: false,
            })
        }
        if (text === 'cancelui') {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 80)
          await bindings.uiContext.select('Cancelled dialog', ['A', 'B'], {
            signal: controller.signal,
          })
          clearTimeout(timer)
          const value = await bindings.uiContext.select('Fresh dialog', ['A', 'B'])
          writeFileSync(join(config.cwd, 'pi-cancel-ui.json'), JSON.stringify({ value }))
        }
        if (text === 'ui') {
          const context = bindings.uiContext
          const answers = {
            select: await context.select('Pick', ['A', 'B']),
            confirm: await context.confirm('Confirm', 'Really?'),
            input: await context.input('Name', 'hint'),
            trust: await ui.trust(config.cwd),
          }
          writeFileSync(join(config.cwd, 'pi-ui.json'), JSON.stringify(answers))
        }
        if (text === 'retry') {
          active.event({ type: 'agent_end', willRetry: true })
          active.event({
            type: 'auto_retry_start',
            attempt: 1,
            errorMessage: 'Authorization Bearer FAKE_CREDENTIAL',
          })
          await delay(75)
          active.event({
            type: 'compaction_end',
            reason: 'overflow',
            result: { summary: 'retained', firstKeptEntryId: 'entry' },
          })
          active.event({ type: 'agent_start' })
        }
        if (text === 'resume') {
          if (!config.native_session_file) throw Error('resume missing mapping')
          const header = JSON.parse(readFileSync(config.native_session_file, 'utf8'))
          if (header.id !== config.native_session_id) throw Error('resume wrong mapping')
          writeFileSync(join(config.cwd, 'pi-resumed.txt'), header.id)
        }
        if (signal.aborted) throw Error('aborted')
        if (text === 'delegation-report') {
          const report = (report_id, kind, value) => {
            active.event({ type: 'message_start', message: { role: 'assistant', content: [] } })
            active.event({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text:
                      '```abele-worker-report\n' +
                      JSON.stringify({ report_id, kind, text: value }) +
                      '\n```',
                  },
                ],
                stopReason: 'stop',
              },
            })
          }
          report('progress', 'progress', 'Working')
          report('progress', 'progress', 'Working')
          report('question', 'question', 'Which direction?')
          report('result', 'result', 'Structured final answer')
          active.event({ type: 'agent_end' })
          active.event({ type: 'agent_settled' })
          return
        }
        active.event({ type: 'message_start', message: { role: 'assistant', content: [] } })
        active.event({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'fixture' },
        })
        active.event({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: text === 'providererror' ? [] : [{ type: 'text', text: 'fixture' }],
            stopReason: text === 'providererror' ? 'error' : 'stop',
            ...(text === 'providererror'
              ? { errorMessage: '502 provider error FAKE_CREDENTIAL' }
              : {}),
          },
        })
        active.event({ type: 'agent_end' })
        active.event({ type: 'agent_settled' })
      },
    }
  }
  if (config.native_session_file) {
    const header = JSON.parse(readFileSync(config.native_session_file, 'utf8'))
    if (header.id !== config.native_session_id) throw Error('bad native id')
    runtime.session = createSession(header.id, config.native_session_file)
  } else runtime.session = createSession()
  const worker = new PiSdkWorker(
    runtime,
    (event) => {
      if (event.type === 'pi.session.bound') materializeNativeState(runtime.session.sessionManager)
      emit(event)
    },
    () => ({ mode: 'rpc', uiContext: ui.context })
  )
  await worker.bind()
  return {
    prompt: (text) => worker.prompt(text),
    completionResult: (result) => worker.completionResult(result),
    abort: () => worker.abort(),
    dispose: async () => worker.dispose(),
  }
}
