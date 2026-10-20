import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ChannelError } from '@abele/channel-protocol'
import type { DebuggerLaunchTargetsResult } from '@abele/node-protocol'

function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
async function json(path: string) {
  if ((await stat(path)).size > 1024 * 1024) throw new Error('file_too_large')
  return JSON.parse(await readFile(path, 'utf8'))
}

/** A bounded physical walk includes ignored compiler output, never symlinked trees. */
export async function discoverLaunchTargets(folder: string): Promise<DebuggerLaunchTargetsResult> {
  const root = await realpath(folder)
  const targets: DebuggerLaunchTargetsResult['targets'] = []
  let budget = 4096
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (--budget < 0 || targets.length >= 256) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 8 && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
          await visit(path, depth + 1)
      } else if (entry.isFile()) {
        try {
          if (entry.name === 'package.json' && dir === root) {
            const pkg = await json(path)
            if (pkg.scripts && typeof pkg.scripts === 'object')
              for (const [name, command] of Object.entries(pkg.scripts)) {
                if (targets.length >= 256) break
                if (name.length > 0 && name.length <= 256 && typeof command === 'string')
                  targets.push({ program: relative(root, path), npm_script: name })
              }
          } else if (/\.[cm]?js\.map$/.test(entry.name)) {
            const program = await realpath(path.slice(0, -4))
            if (!inside(root, program) || !(await stat(program)).isFile()) continue
            const map = await json(path)
            if (!Array.isArray(map.sources)) continue
            for (const name of map.sources.slice(0, 256)) {
              if (typeof name !== 'string' || targets.length >= 256) continue
              const source = await realpath(
                resolve(dirname(path), map.sourceRoot ?? '', name)
              ).catch(() => null)
              if (source && inside(root, source) && (await stat(source)).isFile())
                targets.push({ program: relative(root, program), source: relative(root, source) })
            }
          }
        } catch {
          /* Malformed or unavailable metadata is not a launch target. */
        }
      }
    }
  }
  await visit(root, 0)
  return { targets }
}

/** Parse only direct Node scripts. Shell evaluation would change process ownership and argv. */
export async function resolveNpmScript(
  root: string,
  packagePath: string,
  name: string,
  argv: string[]
) {
  const fail = () => {
    throw new ChannelError('debugger_npm_script_unsupported')
  }
  if (packagePath !== 'package.json') return fail()
  root = await realpath(root)
  const path = await realpath(resolve(root, packagePath))
  if (!inside(root, path)) throw new ChannelError('debugger_path_escape')
  const pkg = await json(path)
  const script = Object.hasOwn(pkg.scripts ?? {}, name) ? pkg.scripts[name] : undefined
  if (typeof script !== 'string' || script.length > 32768) return fail()
  const words: string[] = []
  let word = '',
    quote = '',
    started = false
  for (const char of script) {
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '$' || char === '`' || char === '\\') return fail()
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (char === '\n' || char === '\r') return fail()
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
    } else {
      if (/[#;&|<>$`\\(){}*?\[\]~]/.test(char)) return fail()
      word += char
      started = true
    }
  }
  if (quote) return fail()
  if (started) words.push(word)
  const [runtime, program, ...args] = words
  if (runtime !== 'node' || !program || program.startsWith('-') || !/\.[cm]?js$/.test(program))
    return fail()
  return { program, argv: [...args, ...argv] }
}
