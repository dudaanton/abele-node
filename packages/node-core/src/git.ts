import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { ChannelError } from '@abele/channel-protocol'

/** Internal typed commands, never a client-supplied argv or shell string. */
export type GitCommand =
  | { kind: 'root' }
  | { kind: 'common' }
  | { kind: 'branch' }
  | { kind: 'resolve'; ref: string }
  | { kind: 'worktrees' }
  | { kind: 'branch.create'; branch: string; commit: string }
  | { kind: 'worktree.add'; branch: string; path: string }
  | { kind: 'worktree.remove'; path: string }
  | { kind: 'status' }
  | { kind: 'untracked' }
  | { kind: 'diff' }
  | { kind: 'filters' }
  | {
      kind: 'view.diff'
      mode: 'staged' | 'unstaged' | 'head' | 'base' | 'commit'
      head: string
      base?: string
      commit?: string
    }
  | { kind: 'merge-base'; head: string; base: string }
  | { kind: 'log'; offset: number; limit: number; head?: string }
  | { kind: 'show'; commit: string; path: string }

export function decodeGit(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ChannelError('unsupported_name')
  }
}
export class GitRunner {
  private locks = new Map<string, Promise<unknown>>()
  constructor(
    readonly timeoutMs = 15000,
    readonly outputBytes = 512 * 1024,
    private executable = '/usr/bin/git'
  ) {}
  /** Only metadata effects are serialized; reads and agent work remain independent. */
  serialize<T>(repository: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repository) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.locks.set(repository, next)
    void next
      .finally(() => {
        if (this.locks.get(repository) === next) this.locks.delete(repository)
      })
      .catch(() => {})
    return next
  }
  async run(cwd: string, command: GitCommand, beforeEffect?: () => void): Promise<Buffer> {
    let args: string[]
    switch (command.kind) {
      case 'root':
        args = ['rev-parse', '--path-format=absolute', '--show-toplevel']
        break
      case 'common':
        args = ['rev-parse', '--path-format=absolute', '--git-common-dir']
        break
      case 'branch':
        args = ['symbolic-ref', '--quiet', 'HEAD']
        break
      case 'resolve':
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:\^\{commit\})?$/.test(command.ref) ||
          command.ref.includes('..')
        )
          throw new ChannelError('invalid_ref')
        args = ['rev-parse', '--verify', '--end-of-options', command.ref + '^{commit}']
        break
      case 'worktrees':
        args = ['worktree', 'list', '--porcelain', '-z']
        break
      case 'branch.create':
        args = ['branch', '--', command.branch, command.commit]
        break
      case 'worktree.add':
        args = ['worktree', 'add', '--', command.path, command.branch]
        break
      case 'worktree.remove':
        args = ['worktree', 'remove', '--', command.path]
        break
      case 'status':
        args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
        break
      case 'untracked':
        args = ['ls-files', '--others', '-z']
        break // includes ignored valuable files
      case 'diff':
        args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--']
        break
      case 'view.diff':
        args = [
          command.mode === 'commit' ? 'show' : 'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          ...(command.mode === 'staged'
            ? ['--cached', command.head]
            : command.mode === 'unstaged'
              ? []
              : command.mode === 'base'
                ? [command.base!, command.head]
                : command.mode === 'commit'
                  ? [
                      '--no-show-signature',
                      '--format=',
                      '--root',
                      '--diff-merges=first-parent',
                      command.commit!,
                    ]
                  : [command.head]),
          '--',
        ]
        break
      case 'merge-base':
        args = ['merge-base', command.head, command.base]
        break
      case 'log':
        args = [
          'log',
          '--no-show-signature',
          '--format=%H%x00%s%x00',
          '--skip=' + command.offset,
          '-n',
          String(command.limit),
          command.head ?? 'HEAD',
          '--',
        ]
        break
      case 'show':
        args = [
          'show',
          '--no-show-signature',
          '--no-ext-diff',
          '--no-textconv',
          command.commit + ':' + command.path,
        ]
        break
      case 'filters':
        args = [
          'config',
          '--null',
          '--get-regexp',
          '^filter\\..*\\.(smudge|process|clean|required)$',
        ]
        break
    }
    const overrides: string[] = []
    if (['worktree.add', 'worktree.remove', 'status', 'diff', 'view.diff'].includes(command.kind)) {
      // Both checkout and read-only hashing can run same-user filter programs.
      const filters = decodeGit(await this.run(cwd, { kind: 'filters' }))
      for (const entry of filters.split('\0').filter(Boolean)) {
        const key = entry.slice(0, entry.indexOf('\n'))
        if (!/^filter\.[^=\s]+\.(smudge|process|clean|required)$/.test(key))
          throw new ChannelError('git_failed')
        overrides.push('-c', key + (key.endsWith('.required') ? '=false' : '='))
      }
    }
    beforeEffect?.()
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    )
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        this.executable,
        [
          '--no-pager',
          '-c',
          'log.showSignature=false',
          '-c',
          'gpg.program=/usr/bin/false',
          '-c',
          'gpg.openpgp.program=/usr/bin/false',
          '-c',
          'gpg.x509.program=/usr/bin/false',
          '-c',
          'gpg.ssh.program=/usr/bin/false',
          '-c',
          'commit.gpgSign=false',
          '-c',
          'tag.gpgSign=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.pager=/usr/bin/false',
          '-c',
          'core.quotepath=false',
          '-c',
          'diff.suppressBlankEmpty=false',
          '-c',
          'diff.submodule=short',
          '-c',
          'submodule.recurse=false',
          ...overrides,
          ...args,
        ],
        {
          cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...env,
            // Repository metadata is needed, but host-level executable customization is not.
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            // Recognized by current Git; older versions may ignore this best-effort pin.
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_CEILING_DIRECTORIES: dirname(cwd),
            LC_ALL: 'C',
          },
        }
      )
      const chunks: Buffer[] = []
      let bytes = 0,
        failure: string | undefined
      const limit =
        command.kind === 'diff'
          ? Math.min(this.outputBytes, 32768)
          : ['view.diff', 'show'].includes(command.kind)
            ? 8 * 1024 * 1024
            : this.outputBytes
      const collect = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.byteLength
        if (bytes > limit) {
          failure = 'output_limit'
          child.kill('SIGKILL')
        } else if (stdout) chunks.push(chunk)
      }
      child.stdout.on('data', (b: Buffer) => collect(b, true))
      child.stderr.on('data', (b: Buffer) => collect(b, false))
      const timer = setTimeout(() => {
        failure = 'git_timeout'
        child.kill('SIGKILL')
      }, this.timeoutMs)
      child.once('error', () => {
        clearTimeout(timer)
        reject(new ChannelError('repository_unavailable'))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (failure) reject(new ChannelError(failure))
        else if (code !== 0 && !(command.kind === 'filters' && code === 1))
          reject(new ChannelError('git_failed'))
        else resolve(Buffer.concat(chunks))
      })
    })
  }
  async text(cwd: string, command: GitCommand) {
    return decodeGit(await this.run(cwd, command)).replace(/\n$/, '')
  }
}
export interface GitWorktree {
  path: string
  head: string
  branch: string | null
}
export function parseWorktrees(bytes: Uint8Array): GitWorktree[] {
  const result: GitWorktree[] = []
  for (const block of decodeGit(bytes).split('\0\0').filter(Boolean)) {
    const fields = block.split('\0')
    const path = fields.find((f) => f.startsWith('worktree '))?.slice(9)
    const head = fields.find((f) => f.startsWith('HEAD '))?.slice(5)
    if (!path || !head) throw new ChannelError('git_failed')
    result.push({
      path,
      head,
      branch: fields.find((f) => f.startsWith('branch '))?.slice(7) ?? null,
    })
  }
  return result
}
