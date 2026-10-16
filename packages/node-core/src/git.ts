import { spawn, fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { systemProcessProbe } from '@abele/provider-claude'
import type { ProcessIdentity } from '@abele/provider-contract'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ChannelError } from '@abele/channel-protocol'

/** Internal typed commands, never a client-supplied argv or shell string. */
export type GitCommand =
  | { kind: 'branch.validate'; branch: string }
  | { kind: 'empty.tree' }
  | { kind: 'init'; branch: string }
  | { kind: 'divergence'; base: string; head: string }
  | { kind: 'root' }
  | { kind: 'common' }
  | { kind: 'identity' }
  | { kind: 'directory' }
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
  | { kind: 'config.origins' }
  | { kind: 'config.excludes' }
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
  | { kind: 'refs' }
  | { kind: 'tree'; object: string; recursive?: boolean }
  | { kind: 'blob.size'; object: string }
  | { kind: 'blob'; object: string }
  | { kind: 'tracked' }
  | { kind: 'visible.untracked' }
  | { kind: 'history'; commit: string; offset: number; limit: number; path?: string }
  | { kind: 'changes'; base: string; head?: string; staged?: boolean; unstaged?: boolean }
  | {
      kind: 'patch'
      base: string
      head?: string
      staged?: boolean
      unstaged?: boolean
      path: string
    }
  | {
      kind: 'blame'
      commit: string
      path: string
      start: number
      count: number
      contents?: Uint8Array
    }

export function decodeGit(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ChannelError('unsupported_name')
  }
}
export interface GitEffectLifecycle {
  started(evidence: ProcessIdentity): void
  settled(): void
}
export class GitRunner {
  private locks = new Map<string, Promise<unknown>>()
  private deadlines = new AsyncLocalStorage<number>()
  /** A multi-command read consumes one execution budget, including filter inspection. */
  bounded<T>(milliseconds: number, work: () => Promise<T>): Promise<T> {
    return this.deadlines.run(
      Math.min(Date.now() + milliseconds, this.deadlines.getStore() ?? Infinity),
      work
    )
  }
  /**
   * Work a timer or a watcher starts gets a budget of its own. Their callbacks inherit the
   * context of the request that created them, whose budget ran out long ago.
   */
  detached<T>(milliseconds: number, work: () => Promise<T>): Promise<T> {
    return this.deadlines.run(Date.now() + milliseconds, work)
  }
  constructor(
    readonly timeoutMs = 15000,
    readonly outputBytes = 512 * 1024,
    readonly executable = '/usr/bin/git',
    readonly metadataOutputBytes = 64 * 1024 * 1024
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
  async run(
    cwd: string,
    command: GitCommand,
    beforeEffect?: () => void,
    deadlineMs?: number,
    effect?: GitEffectLifecycle,
    record?: (row: string) => void
  ): Promise<Buffer> {
    if (
      ['tree', 'blob', 'blob.size'].includes(command.kind) &&
      'object' in command &&
      !/^[a-f0-9]{40,64}$/.test(command.object)
    )
      throw new ChannelError('invalid_ref')
    if (
      'path' in command &&
      command.path !== undefined &&
      ['patch', 'blame', 'history', 'show'].includes(command.kind) &&
      (command.path.includes('\0') ||
        command.path.split('/').some((p) => p === '..' || p.toLowerCase() === '.git') ||
        command.path.startsWith('/'))
    )
      throw new ChannelError('unsafe_path')
    let args: string[]
    switch (command.kind) {
      case 'branch.validate':
        args = ['check-ref-format', '--branch', command.branch]
        break
      case 'empty.tree':
        args = ['hash-object', '-t', 'tree', '--stdin']
        break
      case 'init':
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(command.branch) || command.branch.includes('..'))
          throw new ChannelError('invalid_ref')
        args = ['init', '--template=', '--initial-branch=' + command.branch, '.']
        break
      case 'divergence':
        if (![command.base, command.head].every((c) => /^[a-f0-9]{40,64}$/.test(c)))
          throw new ChannelError('invalid_ref')
        args = ['rev-list', '--left-right', '--count', command.base + '...' + command.head, '--']
        break
      case 'root':
        args = ['rev-parse', '--path-format=absolute', '--show-toplevel']
        break
      case 'common':
        args = ['rev-parse', '--path-format=absolute', '--git-common-dir']
        break
      case 'identity':
        args = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']
        break
      case 'directory':
        args = ['rev-parse', '--absolute-git-dir']
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
        args = [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
        ]
        break
      case 'untracked':
        args = ['ls-files', '--others', '-z']
        break // includes ignored valuable files
      case 'diff':
        args = [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--ignore-submodules=all',
          'HEAD',
          '--',
        ]
        break
      case 'view.diff':
        args = [
          command.mode === 'commit' ? 'show' : 'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--ignore-submodules=all',
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
      case 'refs':
        args = [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00',
          'refs/heads',
          'refs/tags',
          'refs/remotes',
        ]
        break
      case 'tree':
        args = ['ls-tree', '-z', '-l', ...(command.recursive ? ['-r'] : []), command.object]
        break
      case 'blob.size':
        args = ['cat-file', '-s', command.object]
        break
      case 'blob':
        args = ['cat-file', 'blob', command.object]
        break
      case 'tracked':
        args = ['ls-files', '--stage', '-z']
        break
      case 'visible.untracked':
        args = ['ls-files', '--others', '--exclude-standard', '-z']
        break
      case 'history':
        args = [
          'log',
          '--no-show-signature',
          '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%B%x00',
          '--skip=' + command.offset,
          '-n',
          String(command.limit),
          command.commit,
          '--',
          ...(command.path ? [command.path] : []),
        ]
        break
      case 'changes':
      case 'patch':
        args = [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--ignore-submodules=all',
          ...(command.kind === 'changes'
            ? ['--name-status', '-z']
            : ['--src-prefix=a/', '--dst-prefix=b/']),
          ...(command.staged
            ? ['--cached', command.base]
            : command.unstaged
              ? []
              : [command.base, ...(command.head ? [command.head] : [])]),
          '--',
          ...(command.kind === 'patch' ? [command.path] : []),
        ]
        break
      case 'blame':
        args = [
          'blame',
          '--line-porcelain',
          '--no-textconv',
          '-L',
          `${command.start},+${command.count}`,
          ...(command.contents ? ['--contents', '-'] : [command.commit]),
          '--',
          command.path,
        ]
        break
      case 'config.origins':
        args = ['config', '--includes', '--null', '--show-origin', '--list']
        break
      case 'config.excludes':
        args = [
          'config',
          '--includes',
          '--null',
          '--show-origin',
          '--path',
          '--get-regexp',
          '^(core\\.excludesfile|include\\.path|includeif\\..*\\.path)$',
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
    if (
      [
        'worktree.add',
        'worktree.remove',
        'status',
        'diff',
        'view.diff',
        'changes',
        'patch',
        'blame',
      ].includes(command.kind)
    ) {
      // Both checkout and read-only hashing can run same-user filter programs.
      const filters = decodeGit(await this.run(cwd, { kind: 'filters' }))
      for (const entry of filters.split('\0').filter(Boolean)) {
        const key = entry.slice(0, entry.indexOf('\n'))
        if (!/^filter\.[^=\s]+\.(smudge|process|clean|required)$/.test(key))
          throw new ChannelError('git_failed')
        overrides.push('-c', key + (key.endsWith('.required') ? '=false' : '='))
      }
    }
    const remaining = (this.deadlines.getStore() ?? Infinity) - Date.now()
    if (remaining <= 0) throw new ChannelError('git_timeout')
    beforeEffect?.()
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    )
    return new Promise<Buffer>((resolve, reject) => {
      const argv = [
        '--no-pager',
        '--literal-pathspecs',
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
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'diff.ignoreSubmodules=all',
        ...overrides,
        ...args,
      ]
      const executionEnv = {
        ...env,
        // Repository metadata is needed, but host-level executable customization is not.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        // Recognized by current Git; older versions may ignore this best-effort pin.
        GIT_NO_LAZY_FETCH: '1',
        // Fail closed on older Git too: repository protocol.*.allow cannot override this.
        // No typed operation needs a transport, including local worktree mutations.
        GIT_ALLOW_PROTOCOL: '',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CEILING_DIRECTORIES: dirname(cwd),
        LC_ALL: 'C',
      }
      const worker = new URL('./git-effect-worker.js', import.meta.url)
      const child = effect
        ? fork(
            existsSync(worker) ? worker : new URL('../dist/git-effect-worker.js', import.meta.url),
            [],
            {
              cwd,
              detached: true,
              execArgv: [],
              env: executionEnv,
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            }
          )
        : spawn(this.executable, argv, {
            cwd,
            shell: false,
            stdio: [
              command.kind === 'blame' && command.contents ? 'pipe' : 'ignore',
              'pipe',
              'pipe',
            ],
            env: executionEnv,
          })
      let evidence: ProcessIdentity | undefined
      if (effect)
        child.on('message', (message: unknown) => {
          if ((message as { kind?: string }).kind !== 'ready' || evidence) return
          try {
            evidence = systemProcessProbe.identity(child.pid!)
            if (!evidence || evidence.pid !== evidence.group)
              throw new ChannelError('git_process_unconfirmed')
            effect.started(evidence)
            beforeEffect?.()
            child.send!({
              kind: 'start',
              executable: this.executable,
              args: argv,
              cwd,
              env: executionEnv,
            })
          } catch (e) {
            failure = e instanceof ChannelError ? e.code : 'storage_unavailable'
            child.kill('SIGKILL')
          }
        })
      if (command.kind === 'blame' && command.contents && child.stdin) {
        child.stdin.on('error', () => {})
        child.stdin.end(command.contents)
      }
      const chunks: Buffer[] = []
      let bytes = 0,
        failure: string | undefined,
        pending = Buffer.alloc(0)
      const limit =
        command.kind === 'diff'
          ? Math.min(this.outputBytes, 32768)
          : command.kind === 'blob'
            ? 16 * 1024 * 1024
            : ['view.diff', 'show', 'patch', 'blame', 'history'].includes(command.kind)
              ? 8 * 1024 * 1024
              : ['tracked', 'tree', 'untracked', 'visible.untracked', 'status'].includes(
                    command.kind
                  )
                ? this.metadataOutputBytes
                : this.outputBytes
      const collect = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.byteLength
        if (bytes > limit) {
          failure = 'output_limit'
          child.kill('SIGKILL')
        } else if (stdout) {
          if (!record) chunks.push(chunk)
          else {
            pending = Buffer.concat([pending, chunk])
            let end: number
            while ((end = pending.indexOf(0)) !== -1) {
              try {
                record(decodeGit(pending.subarray(0, end)))
              } catch (e) {
                failure = e instanceof ChannelError ? e.code : 'git_failed'
                child.kill('SIGKILL')
                break
              }
              pending = pending.subarray(end + 1)
            }
          }
        }
      }
      child.stdout!.on('data', (b: Buffer) => collect(b, true))
      child.stderr!.on('data', (b: Buffer) => collect(b, false))
      const timer = setTimeout(
        () => {
          failure = 'git_timeout'
          child.kill('SIGKILL')
        },
        Math.min(
          remaining,
          deadlineMs ?? this.timeoutMs,
          command.kind === 'blame' ? 5000 : this.timeoutMs
        )
      )
      child.once('error', () => {
        clearTimeout(timer)
        reject(new ChannelError('repository_unavailable'))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (effect) {
          try {
            if (evidence && systemProcessProbe.groupMembers(evidence).length)
              throw new ChannelError('git_process_unconfirmed')
            effect.settled()
          } catch (e) {
            failure = e instanceof ChannelError ? e.code : 'git_process_unconfirmed'
          }
        }
        if (record && pending.length && !failure) failure = 'git_failed'
        if (failure) reject(new ChannelError(failure))
        else if (
          code !== 0 &&
          !(['filters', 'config.excludes'].includes(command.kind) && code === 1)
        )
          reject(new ChannelError('git_failed'))
        else resolve(Buffer.concat(chunks))
      })
    })
  }
  /** Resolve exclude/config dependencies with the exact hardened Git configuration used by reads.
   * Global/system Git config stays disabled; Git's default XDG ignore file remains effective.
   */
  async excludeSources(cwd: string) {
    const configs = new Set<string>()
    const origins = decodeGit(await this.run(cwd, { kind: 'config.origins' })).split('\0')
    for (let i = 0; i + 1 < origins.length; i += 2)
      if (origins[i]!.startsWith('file:')) configs.add(resolve(cwd, origins[i]!.slice(5)))
    const fields = decodeGit(await this.run(cwd, { kind: 'config.excludes' })).split('\0')
    let excludes: string | undefined
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const origin = fields[i]!
      const field = fields[i + 1]!
      const split = field.indexOf('\n')
      const key = field.slice(0, split).toLowerCase()
      const value = field.slice(split + 1)
      if (key === 'core.excludesfile') excludes = resolve(cwd, value)
      else if (origin.startsWith('file:'))
        configs.add(resolve(dirname(resolve(cwd, origin.slice(5))), value))
    }
    return {
      configs: [...configs],
      excludes:
        excludes ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git/ignore'),
    }
  }
  /** Consume NUL-delimited metadata incrementally, under a separate bounded scan ceiling. */
  async records(cwd: string, command: GitCommand, consume: (row: string) => void) {
    await this.run(cwd, command, undefined, undefined, undefined, consume)
  }
  async text(cwd: string, command: GitCommand) {
    return decodeGit(await this.run(cwd, command)).replace(/\n$/, '')
  }
  /** The worktree's top level and common git directory, both from one process. */
  async identity(cwd: string): Promise<{ root: string; common: string }> {
    const [root, common, ...rest] = (await this.text(cwd, { kind: 'identity' })).split('\n')
    if (!root || !common || rest.length) throw new ChannelError('repository_unavailable')
    return { root, common }
  }
}
export interface GitWorktree {
  path: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}
export function parseWorktrees(bytes: Uint8Array): GitWorktree[] {
  const result: GitWorktree[] = []
  for (const block of decodeGit(bytes).split('\0\0').filter(Boolean)) {
    const fields = block.split('\0')
    const path = fields.find((f) => f.startsWith('worktree '))?.slice(9)
    const head = fields.find((f) => f.startsWith('HEAD '))?.slice(5)
    const bare = fields.includes('bare')
    if (!path || (!head && !bare)) throw new ChannelError('git_failed')
    result.push({
      path,
      head: head ?? '',
      branch: fields.find((f) => f.startsWith('branch '))?.slice(7) ?? null,
      detached: fields.includes('detached'),
      bare,
      locked: fields.some((f) => f === 'locked' || f.startsWith('locked ')),
      prunable: fields.some((f) => f === 'prunable' || f.startsWith('prunable ')),
    })
  }
  return result
}
