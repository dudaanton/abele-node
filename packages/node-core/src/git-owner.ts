import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { ChannelError } from '@abele/channel-protocol'

export interface OwnerGitResult {
  code: number
  stdout: Buffer
  /** Bounded tail of stderr and stdout, credentials removed, for plain-language reports. */
  output: string
}
/** Remove user/password from every URL a git message may quote. */
export function stripCredentials(text: string) {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
}
const tail = (text: string, bytes = 4000) => {
  const clean = stripCredentials(text)
    .replace(/\r/g, '\n')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  return Buffer.byteLength(clean) <= bytes
    ? clean.trim()
    : Buffer.from(clean).subarray(-bytes).toString('utf8').replace(/^�+/, '').trim()
}

/**
 * Git as the owner runs it, for explicit owner writes: the repository and user configuration,
 * hooks, filters and credential helpers apply as they do in a terminal. What never applies:
 * a client-supplied argument list or shell, an editor, pager or prompt, the daemon's own GIT_*
 * environment or $EMAIL, and transports other than file, git, http(s) and ssh.
 */
export class OwnerGit {
  constructor(
    readonly executable = '/usr/bin/git',
    readonly timeoutMs = 120000
  ) {}
  run(
    cwd: string,
    args: string[],
    options: { stdin?: string; timeoutMs?: number; outputBytes?: number; probe?: boolean } = {}
  ): Promise<OwnerGitResult> {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && key !== 'EMAIL' && key !== 'SSH_ASKPASS'
      )
    )
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
      GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh',
      GIT_CEILING_DIRECTORIES: dirname(cwd),
      SSH_ASKPASS_REQUIRE: 'never',
      LC_ALL: 'C',
    })
    const argv = [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.editor=true',
      '-c',
      'sequence.editor=true',
      '-c',
      'core.pager=cat',
      '-c',
      'color.ui=false',
      '-c',
      'core.quotepath=false',
      // Never invent an author from the host name or the environment.
      '-c',
      'user.useConfigOnly=true',
      '-c',
      'advice.detachedHead=false',
      // Reads around a write need no monitor program.
      ...(options.probe ? ['-c', 'core.fsmonitor=false'] : []),
      ...args,
    ]
    const limit = options.outputBytes ?? 8 * 1024 * 1024
    return new Promise((resolve, reject) => {
      // A session of its own: no controlling terminal to prompt on, one group to stop.
      const child = spawn(this.executable, argv, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = [],
        err: Buffer[] = []
      let bytes = 0,
        failure: string | undefined
      const stop = () => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > limit) {
          failure = 'output_limit'
          stop()
        } else into.push(chunk)
      }
      child.stdout!.on('data', collect(out))
      child.stderr!.on('data', collect(err))
      if (options.stdin !== undefined) {
        child.stdin!.on('error', () => {})
        child.stdin!.end(options.stdin)
      }
      const timer = setTimeout(() => {
        failure = 'git_timeout'
        stop()
      }, options.timeoutMs ?? this.timeoutMs)
      child.once('error', () => {
        clearTimeout(timer)
        reject(new ChannelError('repository_unavailable'))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (failure) return reject(new ChannelError(failure))
        const stdout = Buffer.concat(out)
        resolve({
          code: code ?? 1,
          stdout,
          output: tail(Buffer.concat(err).toString('utf8') + '\n' + stdout.toString('utf8')),
        })
      })
    })
  }
}
