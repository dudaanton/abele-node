import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdtempSync,
} from 'node:fs'
import { join, delimiter } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

export const servers = {
  typescript: {
    bin: 'typescript-language-server',
    packages: ['typescript-language-server@4.3.4', 'typescript@5.9.3'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'],
  },
  python: { bin: 'pyright-langserver', packages: ['pyright@1.1.396'], extensions: ['py', 'pyi'] },
  eslint: {
    bin: 'vscode-eslint-language-server',
    packages: ['vscode-langservers-extracted@4.10.0'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  },
  json: {
    bin: 'vscode-json-language-server',
    packages: ['vscode-langservers-extracted@4.10.0'],
    extensions: ['json', 'jsonc'],
  },
  css: {
    bin: 'vscode-css-language-server',
    packages: ['vscode-langservers-extracted@4.10.0'],
    extensions: ['css', 'scss', 'less'],
  },
  html: {
    bin: 'vscode-html-language-server',
    packages: ['vscode-langservers-extracted@4.10.0'],
    extensions: ['html'],
  },
  yaml: {
    bin: 'yaml-language-server',
    packages: ['yaml-language-server@1.17.0'],
    extensions: ['yaml', 'yml'],
  },
  bash: {
    bin: 'bash-language-server',
    packages: ['bash-language-server@5.4.3'],
    extensions: ['sh', 'bash'],
  },
  go: { bin: 'gopls', packages: [], extensions: ['go'] },
  rust: { bin: 'rust-analyzer', packages: [], extensions: ['rs'] },
} as const
export type Language = keyof typeof servers
export const popular = Object.keys(servers) as Language[]
export function installPlan(languages: string[], state: string) {
  return [...new Set(languages)].map((raw) => {
    const language = raw === 'javascript' ? 'typescript' : raw
    if (!Object.hasOwn(servers, language)) throw new Error('unknown_language: ' + raw)
    const spec = servers[language as Language]
    const prefix = join(state, 'lsp', language)
    return {
      language: language as Language,
      command: language === 'go' ? 'go' : 'npm',
      args:
        language === 'go'
          ? ['install', 'golang.org/x/tools/gopls@v0.17.1']
          : [
              'install',
              '--prefix',
              prefix,
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
              '--save-exact',
              ...spec.packages,
            ],
      prefix,
    }
  })
}
export function executable(name: string, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      /* next */
    }
  }
  return null
}
export function discover(state: string, language: Language) {
  const spec = servers[language]
  return executable(
    spec.bin,
    [
      join(state, 'lsp', language, 'node_modules', '.bin'),
      join(state, 'lsp', language, 'bin'),
      process.env.PATH ?? '',
    ].join(delimiter)
  )
}
export function projectEslint(root: string) {
  // Resolve only the project's installation, never a global fallback.
  return existsSync(join(root, 'node_modules', 'eslint', 'package.json'))
}
export async function status(state: string, root?: string) {
  return Promise.all(
    popular.map(async (language) => {
      const server = discover(state, language)
      let version: string | null = null
      if (server) {
        try {
          version = (await run(server, ['--version'], {}, 3000)).trim().slice(0, 256) || 'unknown'
        } catch {
          version = 'unknown'
        }
      }
      return {
        language,
        server,
        version,
        found: !!server,
        ...(language === 'eslint' && root
          ? {
              project_eslint: projectEslint(root)
                ? 'found'
                : 'missing: install eslint in this project',
            }
          : {}),
      }
    })
  )
}
export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeout = 120000,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      error = '',
      settled = false
    const timer = setTimeout(() => {
      error = 'process_timeout'
      child.kill('SIGKILL')
    }, timeout)
    const abort = () => {
      error = 'cancelled'
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (d) => {
      output = (output + d).slice(-32768)
    })
    child.stderr.on('data', (d) => {
      error = (error + d).slice(-32768)
    })
    const finish = (e?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      e ? reject(e) : resolve(output)
    }
    child.on('error', (e) => finish(e))
    child.on('exit', (code) =>
      finish(code === 0 ? undefined : new Error(error || 'install_failed'))
    )
  })
}
export type InstallIO = {
  run: typeof run
  download: (url: string, signal?: AbortSignal) => Promise<Buffer>
}
const io: InstallIO = {
  run,
  download: async (url, signal) => {
    const res = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error('download_failed: ' + res.status)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > 64 * 1024 * 1024) throw new Error('download_too_large')
    return bytes
  },
}
export const rustChecksums: Record<string, string> = {
  'aarch64-apple-darwin': 'a828dca71b122ea836572ef32dbf58648466981eeca1ce1448eeaf720a9032b6',
  'x86_64-apple-darwin': '875441dc8ec1297ad80d860e30778b0b68ba70b3d062ac393c56430239fa6def',
  'aarch64-unknown-linux-gnu': '0f69b75a4a6fa1ad8c0698155baa1af5fe7f4b83c2203dfcfdab220449d29667',
  'x86_64-unknown-linux-gnu': '5246a3b0d77b1980d0d8a53da6d9216b585402b6e4dda8c5edb1b9ffa12d18c3',
}
const installing = new Set<string>()
export async function install(
  state: string,
  languages: string[],
  signal?: AbortSignal,
  transport = io
) {
  const plans = installPlan(languages, state)
  if (installing.has(state)) throw new Error('install_in_progress')
  installing.add(state)
  const results: { language: string; message: string }[] = []
  try {
    for (const plan of plans) {
      if (signal?.aborted) throw new Error('cancelled')
      mkdirSync(plan.prefix, { recursive: true, mode: 0o700 })
      if (plan.language === 'rust') {
        const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
        const os =
          process.platform === 'darwin'
            ? 'apple-darwin'
            : process.platform === 'linux'
              ? 'unknown-linux-gnu'
              : null
        if (!arch || !os) throw new Error('unsupported_rust_platform')
        const url = `https://github.com/rust-lang/rust-analyzer/releases/download/2025-02-10/rust-analyzer-${arch}-${os}.gz`
        const checksum = rustChecksums[arch + '-' + os]!
        const compressed = await transport.download(url, signal)
        if (
          !/^[a-f0-9]{64}$/.test(checksum) ||
          createHash('sha256').update(compressed).digest('hex') !== checksum
        )
          throw new Error('checksum_mismatch')
        const bin = join(plan.prefix, 'bin')
        mkdirSync(bin, { recursive: true })
        const temp = mkdtempSync(join(plan.prefix, '.download-'))
        try {
          const file = join(temp, 'rust-analyzer')
          writeFileSync(file, gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }))
          chmodSync(file, 0o700)
          renameSync(file, join(bin, 'rust-analyzer'))
        } finally {
          rmSync(temp, { recursive: true, force: true })
        }
        writeFileSync(join(plan.prefix, 'version'), '2025-02-10\n')
      } else if (plan.language === 'go') {
        if (!executable('go')) {
          results.push({ language: 'go', message: 'skipped: Go is not installed' })
          continue
        }
        await transport.run(
          plan.command,
          plan.args,
          { GOBIN: join(plan.prefix, 'bin') },
          120000,
          signal
        )
      } else await transport.run(plan.command, plan.args, {}, 120000, signal)
      results.push({
        language: plan.language,
        message:
          'installed ' +
          (plan.language === 'rust'
            ? 'rust-analyzer@2025-02-10 (SHA-256 verified)'
            : plan.args.filter((a) => a.includes('@')).join(', ')),
      })
    }
    return results
  } finally {
    installing.delete(state)
  }
}
