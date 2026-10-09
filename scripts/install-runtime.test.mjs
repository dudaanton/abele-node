// Exercise LaunchAgent generation without ever calling the real launchctl.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, symlink, realpath, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const mode of [
  'unload-ok',
  'already-unloaded',
  'still-loaded',
  'foreign-arguments',
  'case-alias',
]) {
  test(`CLI stop confirms launchd absence and preserves foreign jobs: ${mode}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'abele-stop-test-'))
    try {
      const state = join(home, 'A & state')
      await mkdir(state)
      const canonical = await realpath(state),
        command = [
          process.execPath,
          resolve('packages/node-daemon/dist/cli.js'),
          'start',
          '--state-dir',
          canonical,
        ]
      let requested = canonical
      if (mode === 'case-alias') {
        requested = join(await realpath(home), 'a & STATE')
        try {
          const a = await stat(requested),
            b = await stat(canonical)
          if (a.dev !== b.dev || a.ino !== b.ino) {
            t.skip('requires case-insensitive state directory lookup')
            return
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            t.skip('requires case-insensitive state directory lookup')
            return
          }
          throw error
        }
      }
      const directory = join(home, 'Library/LaunchAgents')
      await mkdir(directory, { recursive: true })
      const escape = (s) =>
        s
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
      await writeFile(
        join(directory, 'dev.abele.node.plist'),
        '<plist><dict><key>ProgramArguments</key><array>' +
          command.map((s) => '<string>' + escape(s) + '</string>').join('') +
          '</array></dict></plist>'
      )
      if (mode !== 'already-unloaded') await writeFile(join(home, 'loaded'), 'loaded')
      const shim = join(home, 'launch-shim.mjs')
      await writeFile(
        shim,
        `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
const command=${JSON.stringify(command)}, mode=${JSON.stringify(mode)}, home=process.env.HOME;
cp.spawnSync=(binary,args)=>{
  if(binary!=='/bin/launchctl')throw new Error('unexpected subprocess '+binary);
  fs.appendFileSync(home+'/calls',JSON.stringify(args)+'\\n');
  if(args[0]==='bootout'){
    if(mode!=='still-loaded')fs.rmSync(home+'/loaded',{force:true});
    return {status:0,stdout:'',stderr:''};
  }
  if(args[0]==='print'){
    if(!fs.existsSync(home+'/loaded'))return {status:113,stdout:'',stderr:'Could not find service dev.abele.node in domain'};
    const actual=[...command];if(mode==='foreign-arguments')actual[4]=home+'/foreign-state';
    return {status:0,stdout:'job = {\\n\\targuments = {\\n'+actual.map(s=>'\\t\\t'+s).join('\\n')+'\\n\\t}\\n}\\n',stderr:''};
  }
  throw new Error('unexpected launch operation '+args);
};syncBuiltinESMExports();`
      )
      const result = await new Promise((done, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', shim, 'packages/node-daemon/dist/cli.js', 'stop', '--state-dir', requested],
          { env: { ...process.env, HOME: home } }
        )
        let stdout = '',
          stderr = ''
        child.stdout.on('data', (b) => {
          stdout += b
        })
        child.stderr.on('data', (b) => {
          stderr += b
        })
        child.on('error', reject)
        child.on('close', (code) => done({ code, stdout, stderr }))
      })
      if (mode === 'unload-ok' || mode === 'already-unloaded' || mode === 'case-alias') {
        assert.equal(result.code, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).service_unloaded, true)
      } else {
        assert.notEqual(result.code, 0, result.stderr)
        await readFile(join(home, 'loaded'))
        if (mode === 'foreign-arguments')
          assert.doesNotMatch(await readFile(join(home, 'calls'), 'utf8'), /bootout/)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}
test('CLI install refuses an already loaded job before replacing the service file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'abele-loaded-install-test-'))
  try {
    const directory = join(home, 'Library/LaunchAgents'),
      plist = join(directory, 'dev.abele.node.plist')
    await mkdir(directory, { recursive: true })
    await writeFile(plist, 'foreign cached service')
    const shim = join(home, 'launch-shim.mjs')
    await writeFile(
      shim,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
cp.spawnSync=(binary)=>{if(binary!=='/bin/launchctl')throw new Error('unexpected subprocess');return {status:0,stdout:'loaded foreign job',stderr:''}};syncBuiltinESMExports();`
    )
    const result = await new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          shim,
          'packages/node-daemon/dist/cli.js',
          'install',
          '--runtime-dir',
          resolve('.'),
          '--state-dir',
          join(home, 'state'),
        ],
        { env: { ...process.env, HOME: home } }
      )
      let stderr = ''
      child.stderr.on('data', (b) => {
        stderr += b
      })
      child.on('error', reject)
      child.on('close', (code) => done({ code, stderr }))
    })
    assert.notEqual(result.code, 0, result.stderr)
    assert.equal(await readFile(plist, 'utf8'), 'foreign cached service')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
test('CLI bootstrap failure journals only the successful plist write, never a service start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'abele-journal-bootstrap-'))
  try {
    const shim = join(home, 'launch-shim.mjs'),
      journal = join(home, 'actions.jsonl')
    await writeFile(
      shim,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
cp.spawnSync=(command,args)=>{if(command!=='/bin/launchctl')throw new Error('unexpected subprocess');return args[0]==='print'?{status:113,stdout:'',stderr:'Could not find service dev.abele.node'}:{status:1,stdout:'',stderr:'bootstrap failed'}};syncBuiltinESMExports();`
    )
    const result = await new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          shim,
          'packages/node-daemon/dist/cli.js',
          'install',
          '--runtime-dir',
          resolve('.'),
          '--state-dir',
          join(home, 'state'),
          '--installer-journal',
          journal,
        ],
        { env: { ...process.env, HOME: home } }
      )
      let stderr = ''
      child.stderr.on('data', (b) => {
        stderr += b
      })
      child.on('error', reject)
      child.on('close', (code) => done({ code, stderr }))
    })
    assert.notEqual(result.code, 0, result.stderr)
    const entries = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      entries.map((entry) => entry.action),
      ['write-service']
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
for (const mode of ['direct', 'source', 'symlink']) {
  const direct = mode !== 'source'
  test(
    mode === 'symlink'
      ? 'CLI runtime-dir accepts a symlinked installation prefix'
      : direct
        ? 'CLI install points LaunchAgent directly at an immutable release runtime'
        : 'source CLI install skips absent optional dependencies in the lockfile',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'abele-launchagent-test-'))
      try {
        const shim = join(home, 'mock-launchctl.mjs')
        await writeFile(
          shim,
          `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', {value:'darwin'});
cp.spawnSync = (command,args) => { if(command==='/bin/launchctl') return args[0]==='print' ? {status:113,stdout:'',stderr:'Could not find service dev.abele.node in domain'} : {status:0,stdout:'',stderr:''}; throw new Error('unexpected subprocess: '+command) };
syncBuiltinESMExports();`
        )
        const root = resolve('.')
        const installedRoot = mode === 'symlink' ? join(home, 'release-alias') : root
        if (mode === 'symlink') await symlink(root, installedRoot)
        const reservation = createServer()
        await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
        const port = reservation.address().port
        await new Promise((done) => reservation.close(done))
        const result = await new Promise((done, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              shim,
              'packages/node-daemon/dist/cli.js',
              'install',
              ...(direct ? ['--runtime-dir', installedRoot] : []),
              '--claude-path',
              '/nonexistent/claude',
              '--tailscale-path',
              '/nonexistent/tailscale',
              '--port',
              String(port),
              '--installer-journal',
              join(home, 'actions.jsonl'),
            ],
            { env: { ...process.env, HOME: home } }
          )
          let stderr = ''
          child.stderr.on('data', (b) => {
            stderr += b
          })
          child.on('error', reject)
          child.on('close', (code) => done({ code, stderr }))
        })
        assert.equal(result.code, 0, result.stderr)
        const actions = (await readFile(join(home, 'actions.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse)
        assert.deepEqual(
          actions.map((entry) => entry.action),
          ['write-service', 'started-service']
        )
        const plist = await readFile(
          join(home, 'Library/LaunchAgents/dev.abele.node.plist'),
          'utf8'
        )
        const runtime = direct
          ? installedRoot
          : join(await realpath(home), '.local/state/abele-node/runtime')
        assert.ok(plist.includes(`<string>${runtime}/packages/node-daemon/dist/cli.js</string>`))
        const command = [
          ...plist
            .match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)[1]
            .matchAll(/<string>(.*?)<\/string>/gs),
        ].map((match) =>
          match[1]
            .replaceAll('&quot;', '"')
            .replaceAll('&gt;', '>')
            .replaceAll('&lt;', '<')
            .replaceAll('&amp;', '&')
        )
        // Execute precisely the generated command, without the launchctl shim.
        const daemon = spawn(command[0], command.slice(1), { env: { ...process.env, HOME: home } })
        const closed = once(daemon, 'close')
        let stderr = '',
          stdout = '',
          timer
        daemon.stderr.on('data', (b) => {
          stderr += b
        })
        try {
          const ready = await new Promise((done, reject) => {
            timer = setTimeout(
              () => reject(new Error('generated command timed out: ' + stderr)),
              10000
            )
            daemon.stdout.on('data', (b) => {
              stdout += b
              const line = stdout.split('\n').find((line) => line.includes('"type":"listening"'))
              if (line) done(JSON.parse(line))
            })
            daemon.on('error', reject)
            daemon.on('close', (code) =>
              reject(new Error(`generated command exited ${code}: ${stderr}`))
            )
          })
          assert.equal(ready.type, 'listening')
          assert.equal(ready.port, port)
          assert.equal(ready.pid, daemon.pid)
          const lock = JSON.parse(
            await readFile(join(home, '.local/state/abele-node/daemon.lock'), 'utf8')
          )
          assert.deepEqual(lock.runtime, {
            cli_path: await realpath(command[1]),
            version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
          })
        } finally {
          clearTimeout(timer)
          daemon.kill('SIGTERM')
          const forced = setTimeout(() => daemon.kill('SIGKILL'), 5000)
          await closed
          clearTimeout(forced)
        }
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
}
