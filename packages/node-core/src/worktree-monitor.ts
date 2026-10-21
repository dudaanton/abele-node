import { watch, lstatSync, readFileSync, realpathSync, type FSWatcher } from 'node:fs'
import { join, basename, relative } from 'node:path'

export function pathMetadata(path: string): string | null {
  try {
    const s = lstatSync(path)
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`
  } catch {
    return null
  }
}

export function sourceMetadata(path: string): string | null {
  try {
    const real = realpathSync(path)
    return JSON.stringify([pathMetadata(path), real, pathMetadata(real)])
  } catch {
    return pathMetadata(path)
  }
}

/** Watch before capture, never trust a snapshot after an error/overflow.
 * Recursive watches are supported by Node 22 on both supported hosts (Linux/macOS).
 * If setup fails, callers use the conservative full-validation route instead.
 */
export class WorktreeMonitor {
  private watchers: FSWatcher[] = []
  private baseline: ReadonlyMap<string, string | null> = new Map()
  private ignoreBaseline: ReadonlyMap<string, string | null> = new Map()
  private gitBaseline: ReadonlyMap<string, string | null> = new Map()
  private capturedBefore = 0
  private boundaries = new Set<string>()
  private configSources: string[] = []
  private excludeSource: string | null = null
  private configured: string | null = null
  private listeners = new Set<(overflow: boolean) => void>()
  generation = 0
  private ignoredGeneration = 0
  private ignoredOutputRoots = new Map<string, string>()
  reliable = true
  closed = false
  touched = Date.now()
  constructor(
    readonly root: string,
    readonly gitdir: string,
    readonly common: string
  ) {
    for (const path of new Set([root, gitdir, common])) {
      try {
        const watcher = watch(path, { recursive: true }, (_event, name) => this.changed(path, name))
        watcher.on('error', () => {
          this.generation++
          this.reliable = false
          for (const listener of this.listeners) listener(true)
        })
        this.watchers.push(watcher)
      } catch {
        this.reliable = false
      }
    }
  }
  private settingsSources() {
    return [
      ...new Set([
        join(this.common, 'config'),
        join(this.gitdir, 'config.worktree'),
        ...this.configSources,
      ]),
    ]
  }
  private excludeSources() {
    return [
      ...this.settingsSources(),
      join(this.common, 'info/exclude'),
      join(this.root, '.gitignore'),
      ...(this.excludeSource ? [this.excludeSource] : []),
    ]
  }
  private configSignature() {
    // onbranch conditional includes can select a different excludes file even
    // though none of the config files themselves changed.
    return JSON.stringify([
      pathMetadata(join(this.gitdir, 'HEAD')),
      ...this.refStamps(),
      ...this.settingsSources().map((path) => [path, sourceMetadata(path)]),
    ])
  }
  needsConfiguration() {
    return this.configured !== this.configSignature()
  }
  configurationStale() {
    this.configured = null
  }
  configure(sources: { configs: string[]; excludes: string }) {
    this.configSources = sources.configs
    this.excludeSource = sources.excludes
    this.configured = this.configSignature()
  }
  ownsBaseline(stamps: Map<string, string | null>) {
    return this.baseline === stamps
  }
  releaseBaseline() {
    // Detach, never mutate a snapshot's shared maps. Event hints do not refill them.
    this.baseline = new Map()
    this.ignoreBaseline = new Map()
    this.gitBaseline = new Map()
    this.boundaries.clear()
    this.ignoredOutputRoots.clear()
    this.capturedBefore = 0
  }
  private hasBaseline(path: string) {
    return (
      this.baseline.has(relative(this.root, path)) ||
      this.ignoreBaseline.has(path) ||
      this.gitBaseline.has(path)
    )
  }
  private unchanged(path: string) {
    if (this.ignoreBaseline.has(path)) return this.ignoreBaseline.get(path) === sourceMetadata(path)
    if (this.gitBaseline.has(path)) return this.gitBaseline.get(path) === pathMetadata(path)
    const local = relative(this.root, path)
    return this.baseline.has(local) && this.baseline.get(local) === pathMetadata(path)
  }
  private changed(path: string, name: string | Buffer | null) {
    if (name) {
      const relative = String(name)
      if (path === this.root) {
        const parts = relative.split('/')
        if (parts.slice(1).some((part) => part.toLowerCase() === '.git')) return
        for (let i = 1; i < parts.length; i++)
          if (this.boundaries.has(parts.slice(0, i).join('/'))) return
      }
      const gitRelative =
        path === this.root
          ? relative.startsWith('.git/')
            ? relative.slice(5)
            : relative === '.git'
              ? ''
              : null
          : relative
      if (
        gitRelative !== null &&
        !this.excludeSources().includes(join(path, relative)) &&
        (gitRelative.endsWith('.lock') ||
          !/^(HEAD|index|packed-refs|config|commondir|gitdir|info\/exclude|refs\/.+)$/.test(
            gitRelative
          ))
      )
        return
      let full = join(path, relative)
      // A directory whose only ignore rule is '*' cannot expose new untracked
      // children. Recorder/build output there must not invalidate visible trees.
      // Tracked children and edits to the ignore rule itself remain fenced.
      for (const [root, source] of this.ignoredOutputRoots) {
        if (
          full.startsWith(root + '/') &&
          full !== source &&
          sourceMetadata(source) === this.ignoreBaseline.get(source)
        ) {
          this.generation++
          this.ignoredGeneration++
          return
        }
      }
      if (
        path === this.root &&
        relative === basename(path) &&
        !this.hasBaseline(full) &&
        pathMetadata(full) === null
      ) {
        // macOS reports the watched directory's own basename for a root-self
        // event, not a relative child. Known same-named children remain fenced.
        full = path
      }
      if (this.unchanged(full)) return
      const current = pathMetadata(full)
      if (!this.hasBaseline(full) && current !== null) {
        try {
          if (lstatSync(full).ctimeMs <= this.capturedBefore) {
            return
          }
        } catch {
          /* A concurrent removal is an invalidation. */
        }
      }
    }
    this.generation++
    for (const listener of this.listeners) listener(false)
  }
  /** Hears every change that moves the signature; `overflow` when a watcher failed. */
  listen(listener: (overflow: boolean) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  capture(
    stamps: Map<string, string | null>,
    started: number,
    boundaries: string[],
    ignores: Map<string, string | null>
  ) {
    this.capturedBefore = started
    this.boundaries = new Set(boundaries)
    // FSEvents can deliver pre-watch events late. Metadata-equivalent hints must not
    // invalidate a just-captured snapshot, but replacements/edits always do.
    this.baseline = stamps
    this.ignoreBaseline = ignores
    this.ignoredOutputRoots.clear()
    const visibleParents = new Set<string>()
    for (const path of stamps.keys()) {
      for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1))
        visibleParents.add(path.slice(0, slash))
    }
    for (const source of ignores.keys()) {
      try {
        if (lstatSync(source).size > 4096) continue
        if (readFileSync(source, 'utf8').trim() !== '*') continue
        const root = source.slice(0, -'/.gitignore'.length)
        const prefix = relative(this.root, root)
        if (!prefix || visibleParents.has(prefix)) continue
        this.ignoredOutputRoots.set(root, source)
      } catch {
        /* Missing or unreadable rules never establish an ignored boundary. */
      }
    }
    const gitBaseline = new Map<string, string | null>()
    for (const path of [
      join(this.gitdir, 'HEAD'),
      join(this.gitdir, 'index'),
      join(this.common, 'packed-refs'),
      ...this.excludeSources(),
    ])
      gitBaseline.set(path, pathMetadata(path))
    for (const [path, value] of this.refStamps()) gitBaseline.set(path, value)
    this.gitBaseline = gitBaseline
  }
  /** Also fences same-turn index/HEAD/ref changes before fs events are delivered. */
  signature(includeIgnored = false) {
    const rows: unknown[] = [this.generation - (includeIgnored ? 0 : this.ignoredGeneration)]
    for (const path of [
      this.root,
      join(this.root, '.git'),
      join(this.gitdir, 'HEAD'),
      join(this.gitdir, 'index'),
      join(this.common, 'packed-refs'),
    ])
      rows.push([path, pathMetadata(path)])
    rows.push(...this.excludeSources().map((path) => [path, sourceMetadata(path)]))
    rows.push(...this.refStamps())
    return JSON.stringify(rows)
  }
  private refStamps(): [string, string | null][] {
    const rows: [string, string | null][] = []
    let path = join(this.gitdir, 'HEAD')
    for (let i = 0; i < 10; i++) {
      let value: string
      try {
        value = readFileSync(path, 'utf8').trim()
      } catch {
        break
      }
      if (!value.startsWith('ref: ')) break
      const ref = value.slice(5)
      if (
        !/^refs\/[A-Za-z0-9._/-]+$/.test(ref) ||
        ref.split('/').some((p) => p === '..' || p === '.')
      )
        break
      path = join(this.common, ref)
      rows.push([path, pathMetadata(path)])
    }
    return rows
  }
  close() {
    this.releaseBaseline()
    this.closed = true
    this.reliable = false
    this.generation++
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.listeners.clear()
  }
}
