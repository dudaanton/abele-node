import {
  mkdirSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  readdirSync,
  existsSync,
  chmodSync,
  realpathSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/** Disposable installed layouts: npm hoisting and pnpm-style virtual-store symlinks. */
export function monorepo(dir: string, layout: 'npm' | 'pnpm', dependencies: string) {
  const repo = join(dir, 'main'),
    linked = join(dir, 'linked'),
    state = join(dir, 'state')
  const file = (name: string, content: string | object) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    writeFileSync(join(repo, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  const gitPath = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
    ? '/Library/Developer/CommandLineTools/usr/bin/git'
    : '/usr/bin/git'
  const git = (...args: string[]) => execFileSync(gitPath, args, { cwd: repo, stdio: 'pipe' })
  mkdirSync(repo)
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  file('.gitignore', 'node_modules\n')
  file('package.json', {
    private: true,
    type: 'module',
    packageManager: layout === 'npm' ? 'npm@10.9.2' : 'pnpm@9.15.0',
    workspaces: ['apps/*', 'packages/*'],
  })
  file('turbo.json', {
    tasks: {
      build: { dependsOn: ['^build'], outputs: ['dist/**'] },
      test: { dependsOn: ['^build'] },
    },
  })
  if (layout === 'pnpm') file('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n')
  file('tsconfig.json', {
    files: [],
    references: [{ path: 'packages/a' }, { path: 'packages/b' }, { path: 'apps/web' }],
  })
  file('packages/tsconfig/package.json', { name: '@repo/tsconfig', version: '1.0.0' })
  file('packages/tsconfig/base.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      composite: true,
      declaration: true,
      skipLibCheck: true,
    },
  })
  for (const pkg of ['a', 'b']) {
    file(`packages/${pkg}/package.json`, {
      name: `@repo/${pkg}`,
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
      dependencies: pkg === 'a' ? { '@repo/b': layout === 'pnpm' ? 'workspace:*' : '*' } : {},
    })
    file(`packages/${pkg}/tsconfig.json`, {
      extends: '@repo/tsconfig/base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
      include: ['src/**/*.ts'],
      ...(pkg === 'a' ? { references: [{ path: '../b' }] } : {}),
    })
  }
  file(
    'packages/b/src/index.ts',
    'export function greet(name: string): string { return `Hello ${name}` }\n'
  )
  file('packages/a/src/index.ts', "export { greet } from '@repo/b'\n")
  const path = 'packages/a/src/x.test.ts'
  file(
    path,
    "import { greet } from '@repo/b'\nconst unused = 1\nconst wrong: number = greet('world')\ngreet('friend')\nfunction needsStrict(value) { return value }\n"
  )
  file('apps/web/package.json', { name: '@repo/web', version: '1.0.0', type: 'module' })
  file('apps/web/tsconfig.json', {
    extends: '@repo/tsconfig/base.json',
    include: ['src'],
    references: [{ path: '../../packages/a' }],
  })
  file(
    'apps/web/src/index.ts',
    "import { greet } from '@repo/a'; export const text = greet('web')\n"
  )
  file(
    'eslint.config.mjs',
    "import parser from '@typescript-eslint/parser'; export default [{ files:['**/*.ts'], languageOptions:{parser}, rules:{'no-unused-vars':'error'} }]\n"
  )
  for (let i = 0; i < 1500; i++)
    file(`packages/b/src/generated/file${i}.ts`, `export const value${i}: number = ${i}\n`)
  for (let i = 0; i < 20; i++) {
    file(`packages/extra${i}/package.json`, { name: `@repo/extra${i}`, version: '1.0.0' })
    file(`packages/extra${i}/tsconfig.json`, {
      extends: '@repo/tsconfig/base.json',
      include: ['src'],
    })
    for (let j = 0; j < 20; j++)
      file(`packages/extra${i}/src/file${j}.ts`, `export const v = ${j}\n`)
  }
  git('add', '.')
  git('commit', '-m', 'synthetic Turborepo')
  git('worktree', 'add', '-b', 'linked', linked)
  const nodeModules = join(linked, 'node_modules')
  if (layout === 'npm') cpSync(dependencies, nodeModules, { recursive: true })
  else {
    const store = join(nodeModules, '.pnpm/fixture/node_modules')
    cpSync(dependencies, store, { recursive: true })
    for (const name of readdirSync(store).filter((n) => !n.startsWith('.'))) {
      if (name.startsWith('@')) {
        mkdirSync(join(nodeModules, name), { recursive: true })
        for (const sub of readdirSync(join(store, name)))
          symlinkSync(join(store, name, sub), join(nodeModules, name, sub))
      } else symlinkSync(join(store, name), join(nodeModules, name))
    }
  }
  mkdirSync(join(nodeModules, '@repo'), { recursive: true })
  for (const pkg of ['a', 'b', 'tsconfig'])
    symlinkSync(join(linked, 'packages', pkg), join(nodeModules, '@repo', pkg))
  for (const language of ['typescript', 'eslint']) {
    const bin =
      language === 'typescript' ? 'typescript-language-server' : 'vscode-eslint-language-server'
    const executable = join(state, 'lsp', language, 'node_modules/.bin', bin)
    mkdirSync(dirname(executable), { recursive: true })
    const realServer = pathToFileURL(realpathSync(join(dependencies, '.bin', bin))).href
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(state, language + '.cwd'))}, process.cwd())\nawait import(${JSON.stringify(realServer)})\n`
    )
    chmodSync(executable, 0o700)
  }
  return { repo, linked, state, gitPath, path }
}
