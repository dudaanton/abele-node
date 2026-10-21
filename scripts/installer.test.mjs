import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readlink,
  access,
  symlink,
  chmod,
  realpath,
  stat,
  lstat,
  readdir,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const script = resolve('install.sh')
for (const platform of ['mac', 'linux']) {
  test(`upgrade retains all authenticated owner service flags: ${platform}`, async () => {
    const h = await home()
    const env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    const first = await install(h, ['--version', '0.2.0'], env)
    assert.equal(first.code, 0, first.stderr)
    const configPath = join(h, '.local/share/abele-node/config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const flags = [
      '--permission-ttl-ms',
      '3600000',
      '--pi-deadline-ms',
      '1800000',
      '--pi-max-tokens',
      '32768',
      '--future-owner-flag',
      'space & quote',
    ]
    const text = await readFile(config.service_file, 'utf8')
    const updated =
      platform === 'mac'
        ? text.replace(
            '</array>',
            flags.map((s) => '<string>' + s.replaceAll('&', '&amp;') + '</string>').join('') +
              '</array>'
          )
        : text.replace(/^(ExecStart=.*)$/m, '$1 ' + flags.map((s) => '"' + s + '"').join(' '))
    await writeFile(config.service_file, updated)
    config.service_sha256 = createHash('sha256').update(updated).digest('hex')
    await writeFile(configPath, JSON.stringify(config))
    if (platform === 'mac') {
      const jobFile = join(h, '.fake-launch-job')
      const job = JSON.parse(await readFile(jobFile, 'utf8'))
      job.arguments.push(...flags)
      await writeFile(jobFile, JSON.stringify(job))
    }
    const upgrade = await install(h, ['--version', '0.2.3'], env)
    assert.equal(upgrade.code, 0, upgrade.stderr)
    const after = await readFile(config.service_file, 'utf8')
    for (const flag of flags)
      assert.ok(after.includes(flag.replaceAll('&', platform === 'mac' ? '&amp;' : '&')), flag)
    assert.ok(after.includes('/0.2.3/packages/node-daemon/dist/cli.js'))
  })
}
for (const unknownTotal of [false, true]) {
  test(`installer emits structured stages and download bytes (unknown total: ${unknownTotal})`, async () => {
    const h = await home()
    const asset = `/releases/download/v0.2.0/abele-node-0.2.0-${platform}.tar.gz`
    if (unknownTotal) chunked.add(asset)
    try {
      const result = await install(h, ['--version', '0.2.0', '--no-service'], {
        ABELE_INSTALL_PROGRESS: 'json',
      })
      assert.equal(result.code, 0, result.stderr)
      const events = result.stderr
        .split('\n')
        .filter((line) => line.startsWith('ABELE_PROGRESS '))
        .map((line) => JSON.parse(line.slice(15)))
      const stages = events.filter((event) => event.bytes === undefined).map((event) => event.stage)
      assert.ok(
        stages.indexOf('Verifying archive and checksums') <
          stages.indexOf('Installing (validating runtime before service stop)')
      )
      assert.ok(
        stages.indexOf('Installing (validating runtime before service stop)') <
          stages.indexOf('Waiting for health (15 attempts, 1 s between attempts)')
      )
      const download = events.find(
        (event) => event.stage.startsWith('Downloading AbeleNode') && event.bytes > 0
      )
      assert.ok(download)
      assert.equal(unknownTotal ? download.total === null : download.total > 0, true)
      assert.ok(download.elapsed >= 0)
      assert.ok(!result.stderr.includes('\r'))
    } finally {
      chunked.delete(asset)
    }
  })
}
test('installer reports verification, deployment and health stages', async () => {
  const h = await home()
  const result = await install(h, ['--version', '0.2.0', '--no-service'])
  assert.equal(result.code, 0, result.stderr)
  const output = result.stdout + result.stderr
  assert.match(output, /Downloading AbeleNode 0.2.0/)
  assert.match(output, /Verifying/)
  assert.match(output, /Installing/)
  assert.match(output, /Waiting for health/)
})
for (const platform of ['mac', 'linux']) {
  test(`installer debugger flags persist and adoption rejects unrelated edits: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    for (const args of [
      ['--version', '0.2.0', '--debugger'],
      ['--version', '0.2.3'],
      ['--version', '0.2.3'],
    ]) {
      const result = await install(h, args, env)
      assert.equal(result.code, 0, result.stderr)
      const c = JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8'))
      assert.equal(c.debugger_enabled, true)
      assert.match(await readFile(c.service_file, 'utf8'), /--debugger/)
    }
    const off = await install(h, ['--version', '0.2.3', '--no-debugger'], env)
    assert.equal(off.code, 0, off.stderr)
    const file = join(h, '.local/share/abele-node/config.json')
    const before = await readFile(file, 'utf8'),
      c = JSON.parse(before)
    assert.equal(c.debugger_enabled, false)
    const text = await readFile(c.service_file, 'utf8')
    assert.doesNotMatch(text, /--debugger/)
    const edited =
      platform === 'mac'
        ? text.replace('</array>', '<string>--debugger</string></array>')
        : text.replace(/^(ExecStart=.*)$/m, '$1 "--debugger"')
    await writeFile(c.service_file, edited + '\n# unrelated\n')
    assert.notEqual((await install(h, ['--adopt-debugger'], env)).code, 0)
    assert.equal(await readFile(file, 'utf8'), before)
    await writeFile(c.service_file, edited)
    assert.notEqual((await install(h, ['--version', '0.2.3'], env)).code, 0)
    const adopted = await install(h, ['--adopt-debugger'], env)
    assert.equal(adopted.code, 0, adopted.stderr)
    const after = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(after.debugger_enabled, true)
    assert.equal(after.service_sha256, createHash('sha256').update(edited).digest('hex'))
    assert.equal(await readFile(c.service_file, 'utf8'), edited)
  })
}
for (const platform of ['mac', 'linux']) {
  test(`service debugger choice survives reinstall and strict adoption: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    let result = await install(h, ['--version', '0.2.0', '--debugger'], env)
    assert.equal(result.code, 0, result.stderr)
    const configFile = join(h, '.local/share/abele-node/config.json')
    const recorded = async (enabled) => {
      const c = JSON.parse(await readFile(configFile, 'utf8'))
      const text = await readFile(c.service_file, 'utf8')
      assert.equal(c.debugger_enabled, enabled)
      assert.equal(text.includes('--debugger'), enabled)
      assert.equal(c.service_sha256, createHash('sha256').update(text).digest('hex'))
      return { c, text }
    }
    await recorded(true)
    result = await install(h, ['--version', '0.2.3'], env)
    assert.equal(result.code, 0, result.stderr)
    await recorded(true)
    result = await install(h, ['--service-action', 'enable', '--no-debugger'], env)
    assert.equal(result.code, 0, result.stderr)
    const { c, text } = await recorded(false)
    const modified =
      platform === 'mac'
        ? text.replace('</array>', '<string>--debugger</string></array>')
        : text.replace(/^(ExecStart=.*)$/m, '$1 "--debugger"')
    await writeFile(c.service_file, modified)
    result = await install(h, ['--version', '0.2.3'], env)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /ownership missing or modified/)
    await writeFile(c.service_file, modified + '\n# foreign edit\n')
    result = await install(h, ['--service-action', 'adopt-debugger'], env)
    assert.notEqual(result.code, 0)
    assert.equal(await readFile(configFile, 'utf8'), JSON.stringify(c) + '\n')
    await writeFile(c.service_file, modified)
    if (platform === 'mac') {
      // Model the owner reloading the manually edited LaunchAgent.
      for (const name of ['.fake-launch-job', '.test-service-running']) {
        const file = join(h, name),
          job = JSON.parse(await readFile(file, 'utf8'))
        job.arguments.push('--debugger')
        await writeFile(file, JSON.stringify(job))
      }
    }
    result = await install(h, ['--service-action', 'adopt-debugger'], env)
    assert.equal(result.code, 0, result.stderr)
    await recorded(true)
    result = await install(h, ['--version', '0.2.3'], env)
    assert.equal(result.code, 0, result.stderr)
    await recorded(true)
  })
}
test('installer retains launcher symlinks across version-directory replacement', async () => {
  const h = await home(),
    bin = join(h, 'launchers'),
    versions = join(h, 'versions'),
    old = join(versions, 'old'),
    current = join(versions, 'new')
  for (const dir of [bin, old, current]) await mkdir(dir, { recursive: true })
  for (const provider of ['claude', 'codex']) {
    for (const dir of [old, current])
      await writeFile(join(dir, provider), '#!/bin/sh\necho 2.1.292\n', { mode: 0o755 })
    await symlink(join(old, provider), join(bin, provider))
  }
  const result = await install(h, ['--no-service', '--claude-path', join(bin, 'claude')], {
    PATH: bin + ':' + process.env.PATH,
  })
  assert.equal(result.code, 0, result.stderr)
  const configPath = join(h, '.local/share/abele-node/config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  for (const provider of ['claude', 'codex']) {
    assert.equal(config[provider], join(bin, provider))
    await rm(join(bin, provider))
    await symlink(join(current, provider), join(bin, provider))
  }
  await rm(old, { recursive: true })
  for (const provider of ['claude', 'codex'])
    assert.equal(await realpath(config[provider]), await realpath(join(current, provider)))
  const wrapper = await readFile(join(h, '.local/bin/abele-node'), 'utf8')
  assert.ok(wrapper.includes(join(bin, 'claude')))
  assert.ok(wrapper.includes(join(bin, 'codex')))
})
test('downloads survive a transient 504 or 503 and never retry a 404', async () => {
  const asset = `/releases/download/v0.2.3/abele-node-0.2.3-${platform}.tar.gz`,
    sums = '/releases/download/v0.2.3/SHA256SUMS'
  failures.set(asset, [504])
  failures.set(sums, [503])
  hits.clear()
  const h = await home()
  const ok = await install(h, ['--version', '0.2.3', '--no-service'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(hits.get(asset), 2)
  assert.equal(hits.get(sums), 2)
  const missing = '/releases/download/v0.9.9/abele-node-0.9.9-' + platform + '.tar.gz'
  const refused = await install(await home(), ['--version', '0.9.9', '--no-service'])
  assert.notEqual(refused.code, 0)
  assert.equal(hits.get(missing), 1)
})
test('Claude discovery records normalized paths and probes with service PATH', async () => {
  const h = await home(),
    bin = join(h, 'custom-bin'),
    target = join(bin, 'claude-real.cjs')
  await mkdir(bin, { recursive: true })
  await writeFile(
    target,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(h, 'claude-probe.json'))},JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));console.log('2.1.292');\n`,
    { mode: 0o755 }
  )
  const alias = join(bin, 'claude')
  await symlink(target, alias)
  const result = await install(h, ['--no-service', '--claude-path', alias], {
    ABELE_CLAUDE_PATH: '/missing/env-claude',
  })
  assert.equal(result.code, 0, result.stderr)
  const config = JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8'))
  assert.equal(config.claude, alias)
  assert.equal(config.prefix, join(h, '.local'))
  const probe = JSON.parse(await readFile(join(h, 'claude-probe.json'), 'utf8'))
  assert.deepEqual(probe.args, ['--version'])
  assert.equal(probe.path.split(':')[0], bin)
  assert.ok(
    probe.path.split(':').includes(process.execPath.slice(0, process.execPath.lastIndexOf('/')))
  )
})
test('Codex discovery records common-location executable and no node model override, preserving explicit overrides on upgrade', async () => {
  const h = await home(),
    bin = join(h, '.local/bin')
  await mkdir(bin, { recursive: true })
  const codex = join(bin, 'codex')
  await writeFile(codex, '#!/bin/sh\necho codex-cli 0.160.1\n', { mode: 0o755 })
  const first = await install(h, ['--no-service'], { PATH: bin + ':' + process.env.PATH })
  assert.equal(first.code, 0, first.stderr)
  const configPath = join(h, '.local/share/abele-node/config.json')
  let config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.codex, codex)
  assert.equal(config.codex_model, '')
  assert.equal(config.codex_enabled, true)
  const wrapper = await readFile(join(h, '.local/bin/abele-node'), 'utf8')
  assert.match(wrapper, /--codex-path/)
  assert.doesNotMatch(wrapper, /--codex-model/)
  const override = await install(h, [
    '--no-service',
    '--version',
    '0.2.3',
    '--codex-model',
    'custom-small',
    '--no-codex',
  ])
  assert.equal(override.code, 0, override.stderr)
  const upgrade = await install(h, ['--no-service', '--version', '0.3.1'])
  assert.equal(upgrade.code, 0, upgrade.stderr)
  config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.codex_model, 'custom-small')
  assert.equal(config.codex_enabled, false)
  assert.match(await readFile(join(h, '.local/bin/abele-node'), 'utf8'), /--no-codex/)
})
test('Codex PATH discovery reaches systemd service arguments and survives its restricted PATH', async () => {
  const h = await home(),
    bin = join(h, 'custom-codex')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'codex'), '#!/bin/sh\necho codex-cli 0.160.1\n', { mode: 0o755 })
  const env = await mockedLinuxService(h)
  const result = await install(h, [], { ...env, PATH: bin + ':' + env.PATH })
  assert.equal(result.code, 0, result.stderr)
  const unit = await readFile(join(h, '.config/systemd/user/abele-node.service'), 'utf8')
  assert.ok(unit.includes('"--codex-path" "' + join(bin, 'codex') + '"'))
  assert.doesNotMatch(unit, /--codex-model/)
})
test('missing Claude still installs and explains how to configure it later', async () => {
  const h = await home()
  const result = await install(h, ['--no-service'], {
    ABELE_CLAUDE_PATH: join(h, 'missing-claude'),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /pi still works.*sh install.sh --claude-path/)
  const config = JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8'))
  assert.equal(config.claude, join(h, 'missing-claude'))
})
const platform = `${process.platform}-${process.arch === 'x64' ? 'x64' : 'arm64'}`
let scratch, server, base, archive
const routes = new Map()
const chunked = new Set()
// Statuses answered before the real body, one per request; every request is counted.
const failures = new Map(),
  hits = new Map()
async function run(command, args, env = {}, input = '') {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      detached: args.includes('--service-action'),
    })
    let stdout = '',
      stderr = ''
    child.stdin.on('error', reject)
    child.stdin.end(input || undefined)
    child.stdout.on('data', (b) => {
      stdout += b
    })
    child.stderr.on('data', (b) => {
      stderr += b
    })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}
async function release(version, broken = false, badChecksum = false) {
  const tree = join(scratch, `release-${version}`)
  await mkdir(join(tree, 'packages/node-daemon/dist'), { recursive: true })
  await writeFile(join(tree, 'package.json'), JSON.stringify({ version, type: 'module' }))
  await writeFile(
    join(tree, 'service-transition.mjs'),
    await readFile('scripts/service-transition.mjs', 'utf8')
  )
  await writeFile(
    join(tree, 'packages/node-daemon/dist/service-arguments.js'),
    await readFile('packages/node-daemon/dist/service-arguments.js', 'utf8')
  )
  await writeFile(
    join(tree, 'packages/node-daemon/dist/cli.js'),
    `import fs from 'node:fs';
import { retainServiceArguments } from './service-arguments.js';
import {fileURLToPath} from 'node:url';
const marker=process.env.HOME+'/.test-service-running';
const isMac=process.env.TEST_MAC_SERVICE==='1', args=process.argv.slice(2);
let state=args[args.indexOf('--state-dir')+1] || process.env.HOME+'/.local/state/abele-node';
const missing=[];while(!fs.existsSync(state)){missing.unshift(state.slice(state.lastIndexOf('/')+1));state=state.slice(0,state.lastIndexOf('/')) || '/'}
state=fs.realpathSync(state)+(missing.length?'/'+missing.join('/'):'');
const cliPath=fs.realpathSync(fileURLToPath(import.meta.url));
const paired=args.includes('--paired-config')?args[args.indexOf('--paired-config')+1]:'';
if(paired){let ok=false;try{ok=new URL(JSON.parse(fs.readFileSync(paired,'utf8')).endpoint).hostname.endsWith('.ts.net')}catch{}if(!ok){console.error('invalid paired configuration');process.exit(1)}}
const lateDropin=process.env.HOME+'/dropin-on-preflight.json';
if(args[0]==='status' && cliPath.includes('/.download.') && fs.existsSync(lateDropin)){
  const s=JSON.parse(fs.readFileSync(lateDropin,'utf8'));fs.mkdirSync(s.directory,{recursive:true});fs.writeFileSync(s.directory+'/10-late.conf','[Service]\\nEnvironment=LATE_OVERRIDE=yes\\n');fs.rmSync(lateDropin);
}
const plist=process.env.HOME+'/Library/LaunchAgents/dev.abele.node.plist',job=process.env.HOME+'/.fake-launch-job';
let service_unloaded;
const journal=args.includes('--installer-journal')?args[args.indexOf('--installer-journal')+1]:'';
const completed=(action,target)=>{if(journal && !fs.existsSync(process.env.HOME+'/legacy-cli-ignores-journal'))fs.appendFileSync(journal,JSON.stringify({action,target,state})+'\\n')};
if(isMac && args[0]==='install'){
  if(fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker,'utf8')).state===state){console.error('stop_before_install');process.exit(1)}
  fs.mkdirSync(state,{recursive:true,mode:0o700});fs.mkdirSync(process.env.HOME+'/Library/LaunchAgents',{recursive:true});
  let command=[process.execPath,cliPath,'start','--state-dir',state,'--claude-path',args[args.indexOf('--claude-path')+1] || '/nonexistent/claude',...(paired?['--paired-config',paired]:[]),...(args.includes('--debugger')?['--debugger']:[])];
  if(process.env.ABELE_PREVIOUS_SERVICE_FILE)command=retainServiceArguments(command,fs.readFileSync(process.env.ABELE_PREVIOUS_SERVICE_FILE,'utf8'),'darwin',JSON.parse(process.env.ABELE_SERVICE_ARGUMENT_OVERRIDES || '{}'));
  const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const text='<plist><dict><key>ProgramArguments</key><array>'+command.map(s=>'<string>'+xml(s)+'</string>').join('')+'</array></dict></plist>';
  if(process.env.ABELE_SERVICE_TRANSITION)fs.writeFileSync(process.env.ABELE_SERVICE_TRANSITION+'/next-service',text,{mode:0o600});
  fs.writeFileSync(plist,text,{mode:0o600});
  completed('write-service',plist);
  if(fs.existsSync(process.env.HOME+'/fail-bootstrap')){console.error('launchctl bootstrap failed');process.exit(1)}
  const record={state,arguments:command,runtime:{cli_path:cliPath,version:${JSON.stringify(version)}}};
  fs.writeFileSync(job,JSON.stringify(record));fs.writeFileSync(marker,JSON.stringify(record));
  if(fs.existsSync(process.env.HOME+'/foreground-on-start')){fs.writeFileSync(job,JSON.stringify({...record,pid:2337}));fs.copyFileSync(process.env.HOME+'/foreground-on-start',marker)}
  completed('started-service',plist);console.log('{}');process.exit(0);
}
if(args[0]==='stop'){
  fs.appendFileSync(process.env.HOME+'/cli-stop.log',state+'\\n');
  const swap=process.env.HOME+'/swap-state-on-stop.json';
  if(fs.existsSync(swap)){
    const s=JSON.parse(fs.readFileSync(swap,'utf8'));fs.renameSync(s.parent,s.moved);fs.symlinkSync(s.replacement,s.parent);fs.rmSync(swap);
  }
  if(!isMac)fs.rmSync(marker,{force:true});
  else{
    const current=fs.existsSync(job)?JSON.parse(fs.readFileSync(job,'utf8')):null;
    const legacy=process.env.HOME+'/legacy-stop-unconfirmed';
    if(current?.state===state && ${JSON.stringify(version)}==='0.3.1' && fs.existsSync(legacy)){
      fs.writeFileSync(process.env.HOME+'/legacy-unload-polls',fs.readFileSync(legacy,'utf8'));
      console.error('launch_agent_stop_unconfirmed');process.exit(1);
    }
    if(current?.state===state && !fs.existsSync(process.env.HOME+'/block-unload')){
      fs.rmSync(job,{force:true});fs.rmSync(marker,{force:true});completed('stopped-service',plist);
    }
    service_unloaded=!fs.existsSync(job);
    // CLI stop also signals a manual daemon even when no launchd job exists.
    if(service_unloaded && fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker,'utf8')).state===state)fs.rmSync(marker);
  }
}
if(process.argv[2]==='doctor' && ${broken}){
  const late=process.env.HOME+'/override-after-doctor';if(fs.existsSync(late)){fs.writeFileSync(process.env.HOME+'/simulate-loaded-dropins',fs.readFileSync(late,'utf8'));fs.rmSync(late)}
  process.exit(1);
}
const daemonPending=process.env.HOME+'/legacy-daemon-polls';
if(args[0]==='status' && fs.existsSync(daemonPending)){
  const failure=process.env.HOME+'/legacy-status-fails';
  if(fs.existsSync(failure)){fs.rmSync(failure);fs.rmSync(daemonPending);console.error('legacy status unavailable');process.exit(1)}
  const count=Number(fs.readFileSync(daemonPending,'utf8'));
  fs.appendFileSync(process.env.HOME+'/legacy-stop-events','status '+count+'\\n');
  if(count===0){fs.rmSync(marker,{force:true});fs.rmSync(daemonPending)}
  else fs.writeFileSync(daemonPending,String(count-1));
}
const present=fs.existsSync(marker), reported=present && fs.readFileSync(marker,'utf8');
const running=present && (!isMac || JSON.parse(reported).state===state);
const runtime=reported ? JSON.parse(reported).runtime : {cli_path:fs.realpathSync(fileURLToPath(import.meta.url)),version:${JSON.stringify(version)}};
console.log(JSON.stringify({running,service_unloaded,state_dir:state,pid:running?1337:null,port:running?Number(process.env.TEST_NODE_PORT || 7777):undefined,runtime,node:process.version,state_mode:null,version:${JSON.stringify(version)}}));`
  )
  const file = join(scratch, `${version}.tar.gz`)
  assert.equal((await run('tar', ['-czf', file, '-C', tree, '.'])).code, 0)
  const bytes = await readFile(file)
  const name = `abele-node-${version}-${platform}.tar.gz`
  const names = [
    ...new Set([
      name,
      `abele-node-${version}-linux-${process.arch}.tar.gz`,
      `abele-node-${version}-darwin-arm64.tar.gz`,
    ]),
  ]
  for (const asset of names) routes.set(`/releases/download/v${version}/${asset}`, bytes)
  routes.set(
    `/releases/download/v${version}/SHA256SUMS`,
    names
      .map(
        (asset) =>
          `${badChecksum ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`
      )
      .join('')
  )
  return file
}
async function home() {
  return mkdtemp(join(scratch, 'home-'))
}
async function install(homeDir, args = [], extra = {}) {
  let installer = script
  if (extra.TEST_MAC_SERVICE === '1') {
    // Even an unexpected rollback must never reach the host's live launchctl.
    const fake = join(homeDir, 'mocks/launchctl.cjs')
    await writeFile(
      fake,
      `#!${process.execPath}
const fs=require('node:fs'),home=process.env.HOME,args=process.argv.slice(2),file=home+'/.fake-launch-job';
if(args[0]==='print'){
  const unload=home+'/legacy-unload-polls';
  if(fs.existsSync(unload)){
    fs.appendFileSync(home+'/legacy-stop-events','print\\n');
    const count=Number(fs.readFileSync(unload,'utf8'));
    if(count===0){fs.rmSync(file,{force:true});fs.rmSync(unload);fs.writeFileSync(home+'/legacy-daemon-polls','2')}
    else if(count>0)fs.writeFileSync(unload,String(count-1));
  }
  const pending=home+'/bootstrap-polls';
  if(fs.existsSync(pending)){
    const count=Number(fs.readFileSync(pending,'utf8'));
    if(count>0){fs.writeFileSync(pending,String(count-1));console.error('Could not find service dev.abele.node in domain');process.exit(113)}
    fs.rmSync(pending);
  }
  if(!fs.existsSync(file)){console.error('Could not find service dev.abele.node in domain');process.exit(113)}
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  console.log('job = {\\n\\tpid = '+(record.pid || 1337)+'\\n\\targuments = {\\n'+record.arguments.map(s=>'\\t\\t'+s).join('\\n')+'\\n\\t}\\n}');
}else if(args[0]==='bootout'){
  if(fs.existsSync(home+'/block-unload'))process.exit(1);
  const job=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null, marker=home+'/.test-service-running';
  const daemon=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')):null;
  fs.rmSync(file,{force:true});if((job?.pid || 1337)===(daemon?.pid || 1337))fs.rmSync(marker,{force:true});
}else if(args[0]==='bootstrap'){
  const text=fs.readFileSync(args[2],'utf8'),array=text.match(/<array>(.*?)<\\/array>/s)[1];
  const command=[...array.matchAll(/<string>(.*?)<\\/string>/gs)].map(m=>m[1].replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  const state=command[command.indexOf('--state-dir')+1],cli=command[1],version=JSON.parse(fs.readFileSync(cli.replace('/packages/node-daemon/dist/cli.js','/package.json'),'utf8')).version;
  const record={state,arguments:command,runtime:{cli_path:fs.realpathSync(cli),version}};
  fs.writeFileSync(file,JSON.stringify(record));fs.writeFileSync(home+'/.test-service-running',JSON.stringify(record));
  if(fs.existsSync(home+'/async-rollback-bootstrap')){fs.writeFileSync(home+'/bootstrap-polls','3');console.error('Operation now in progress');process.exit(36)}
}else if(args[0]==='kickstart'){
  fs.appendFileSync(home+'/launch-kickstarts',args.join(' ')+'\\n');
  if(!fs.existsSync(file))process.exit(113);
}else process.exit(99);
`,
      { mode: 0o755 }
    )
    const root = join(homeDir, '.local/share/abele-node')
    if (
      await access(root).then(
        () => true,
        () => false
      )
    ) {
      for (const name of await readdir(root)) {
        if (!/^\d+\.\d+\.\d+$/.test(name)) continue
        const helper = join(root, name, 'service-transition.mjs')
        if (
          await access(helper).then(
            () => true,
            () => false
          )
        )
          await writeFile(
            helper,
            (await readFile(helper, 'utf8')).replaceAll("'/bin/launchctl'", JSON.stringify(fake))
          )
      }
    }
    installer = join(homeDir, 'isolated-install.sh')
    await writeFile(
      installer,
      (await readFile(script, 'utf8'))
        .replaceAll("'/bin/launchctl'", JSON.stringify(fake))
        .replaceAll('/bin/launchctl', JSON.stringify(fake))
    )
  }
  return run('/bin/sh', [installer, ...args], {
    HOME: homeDir,
    ABELE_INSTALL_BASE_URL: base,
    ABELE_INSTALL_API_URL: `${base}/latest`,
    ABELE_CLAUDE_PATH: '/nonexistent/claude',
    ABELE_CODEX_PATH: '',
    ABELE_CODEX_MODEL: '',
    ABELE_CODEX_HOME: '',
    ABELE_TAILSCALE_PATH: '/nonexistent/tailscale',
    ...extra,
  })
}
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'abele-installer-'))
  archive = await release('0.2.0')
  await release('0.2.1', true)
  await release('0.2.2', false, true)
  await release('0.2.3')
  await release('0.3.1')
  await release('0.3.2', true)
  await release('0.3.3')
  routes.set('/latest', JSON.stringify({ tag_name: 'v0.2.0' }))
  server = createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1)
    const failure = failures.get(req.url)?.shift()
    if (failure) {
      res.statusCode = failure
      return res.end('temporarily unavailable')
    }
    const body = routes.get(req.url)
    res.statusCode = body === undefined ? 404 : 200
    if (chunked.has(req.url) && body !== undefined) {
      res.write(body)
      return res.end()
    }
    res.end(body ?? 'not found')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((done) => server.close(done))
  await rm(scratch, { recursive: true, force: true })
})
for (const platform of ['mac', 'linux']) {
  test(`service-only transitions preserve deployment and installer ownership: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
    const root = join(h, '.local/share/abele-node'),
      configFile = join(root, 'config.json')
    const state = JSON.parse(await readFile(configFile, 'utf8')).state
    await writeFile(join(state, 'keep'), 'state stays')
    // Deliberately unusable download endpoints: service changes must be offline.
    const offline = {
      ...env,
      ABELE_INSTALL_BASE_URL: 'http://127.0.0.1:1',
      ABELE_INSTALL_API_URL: 'http://127.0.0.1:1',
    }
    const enable = await install(h, ['--service-action', 'enable'], offline)
    assert.equal(enable.code, 0, enable.stderr)
    let config = JSON.parse(await readFile(configFile, 'utf8'))
    assert.equal(config.service, 1)
    assert.equal(
      config.service_sha256,
      createHash('sha256')
        .update(await readFile(config.service_file))
        .digest('hex')
    )
    const original = await readFile(config.service_file, 'utf8')
    assert.equal((await install(h, ['--service-action', 'enable'], offline)).code, 0)
    assert.equal(await readFile(config.service_file, 'utf8'), original)
    assert.equal(await readlink(join(root, 'current')), '0.2.0')
    // A regular installer rerun must accept the ownership record.
    const rerun = await install(h, ['--version', '0.2.3'], env)
    assert.equal(rerun.code, 0, rerun.stderr)
    const disable = await install(h, ['--service-action', 'disable'], offline)
    assert.equal(disable.code, 0, disable.stderr)
    config = JSON.parse(await readFile(configFile, 'utf8'))
    assert.equal(config.service, 0)
    assert.equal(config.service_sha256, undefined)
    await assert.rejects(
      access(
        platform === 'mac'
          ? join(h, 'Library/LaunchAgents/dev.abele.node.plist')
          : join(h, '.config/systemd/user/abele-node.service')
      )
    )
    await assert.rejects(access(join(h, '.test-service-running')))
    assert.equal((await install(h, ['--service-action', 'disable'], offline)).code, 0)
    assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'state stays')
    assert.equal(await readlink(join(root, 'current')), '0.2.3')
  })
  test(`service-only refuses modified files before stopping: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
    const configFile = join(h, '.local/share/abele-node/config.json'),
      before = await readFile(configFile, 'utf8')
    const file = JSON.parse(before).service_file
    await writeFile(file, (await readFile(file, 'utf8')) + '\nforeign modification')
    await rm(join(h, 'cli-stop.log'), { force: true })
    const result = await install(h, ['--service-action', 'disable'], env)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /ownership.*modified/i)
    await assert.rejects(access(join(h, 'cli-stop.log')))
    await access(join(h, '.test-service-running'))
    assert.equal(await readFile(configFile, 'utf8'), before)
  })
}

for (const platform of ['mac', 'linux']) {
  test(`service-only enable refuses a foreground daemon appearing under the install lock: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
    const configFile = join(h, '.local/share/abele-node/config.json'),
      before = await readFile(configFile, 'utf8')
    const config = JSON.parse(before),
      record = {
        state: config.state,
        pid: process.pid,
        runtime: {
          cli_path: join(h, '.local/share/abele-node/0.2.0/packages/node-daemon/dist/cli.js'),
          version: '0.2.0',
        },
      }
    await writeFile(join(h, 'late-daemon.json'), JSON.stringify(record))
    const fault = join(h, 'late-daemon.cjs')
    await writeFile(
      fault,
      `const fs=require('node:fs'),original=fs.symlinkSync;fs.symlinkSync=(target,file,...rest)=>{const r=original(target,file,...rest);if(String(file).endsWith('/.install-lock')){fs.copyFileSync(process.env.HOME+'/late-daemon.json',process.env.HOME+'/.local/state/abele-node/daemon.lock');fs.copyFileSync(process.env.HOME+'/late-daemon.json',process.env.HOME+'/.test-service-running')}return r}`
    )
    env.NODE_OPTIONS = '--require=' + fault
    const result = await install(h, ['--service-action', 'enable'], env)
    assert.notEqual(result.code, 0, result.stderr)
    assert.match(result.stderr, /foreground daemon is running/)
    assert.equal(await readFile(configFile, 'utf8'), before)
    await access(join(h, '.test-service-running'))
    await assert.rejects(access(join(h, 'cli-stop.log')))
    await assert.rejects(lstat(join(h, '.local/share/abele-node/.service-transition')))
    await assert.rejects(lstat(join(h, '.local/share/abele-node/.install-lock')))
    await assert.rejects(
      access(
        platform === 'mac'
          ? join(h, 'Library/LaunchAgents/dev.abele.node.plist')
          : join(h, '.config/systemd/user/abele-node.service')
      )
    )
  })
}

test('service-only enable cannot nest its lock inside an active deployment lock', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
  const root = join(h, '.local/share/abele-node'),
    file = join(root, 'config.json'),
    before = await readFile(file, 'utf8')
  await mkdir(join(root, '.install-lock'), { mode: 0o700 })
  const result = await install(h, ['--service-action', 'enable'], env)
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /Another install is active/)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.deepEqual(await readdir(join(root, '.install-lock')), [])
})

for (const platform of ['mac', 'linux']) {
  for (const point of [
    'disable-remove',
    'disable-publish',
    'enable-publish',
    'disable-cleanup',
    'enable-cleanup',
    'enable-write',
    'enable-start',
    'disable-stop',
  ]) {
    test(`service-only recovers SIGKILL at ${point}: ${platform}`, async () => {
      const h = await home(),
        env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
      const action = point.startsWith('disable') ? 'disable' : 'enable'
      assert.equal(
        (
          await install(
            h,
            ['--version', '0.2.0', ...(action === 'enable' ? ['--no-service'] : [])],
            env
          )
        ).code,
        0
      )
      const root = join(h, '.local/share/abele-node'),
        file =
          platform === 'mac'
            ? join(h, 'Library/LaunchAgents/dev.abele.node.plist')
            : join(h, '.config/systemd/user/abele-node.service')
      const tool = point === 'disable-remove' || point.endsWith('cleanup') ? 'rm' : 'mv',
        target = point === 'disable-remove' ? await realpath(file) : join(root, 'config.json')
      await writeFile(
        join(h, 'mocks', tool),
        `#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs'),args=process.argv.slice(2);const r=cp.spawnSync('/bin/${tool}',args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status);if(${point.endsWith('cleanup') ? "args.at(-1).includes('/.download.')" : 'args.at(-1)===' + JSON.stringify(target)}){fs.unlinkSync(__filename);process.kill(process.ppid,'SIGKILL')}\n`,
        { mode: 0o755 }
      )
      if (['enable-write', 'enable-start', 'disable-stop'].includes(point)) {
        await rm(join(h, 'mocks', tool))
        const fault = join(h, 'kill-mutation.cjs')
        await writeFile(
          fault,
          `const fs=require('node:fs'),originalWrite=fs.writeFileSync,originalRename=fs.renameSync,originalRm=fs.rmSync;const kill=()=>{process.kill(process.ppid,'SIGKILL');process.exit(0)};const active=()=>fs.existsSync(${JSON.stringify(join(root, '.service-transition'))});fs.renameSync=(from,to,...rest)=>{const r=originalRename(from,to,...rest);if(active()&&${JSON.stringify(point)}==='enable-write'&&String(to).endsWith('abele-node.service'))kill();return r};fs.writeFileSync=(file,...rest)=>{const r=originalWrite(file,...rest);if(active()&&((${JSON.stringify(point)}==='enable-write'&&String(file).endsWith('dev.abele.node.plist'))||(${JSON.stringify(point)}==='enable-start'&&String(file).endsWith('.test-service-running'))))kill();return r};fs.rmSync=(file,...rest)=>{const r=originalRm(file,...rest);if(active()&&${JSON.stringify(point)}==='disable-stop'&&String(file).endsWith('.test-service-running'))kill();return r}`
        )
        env.NODE_OPTIONS = '--require=' + fault
      }
      const killed = await install(h, ['--service-action', action], env)
      delete env.NODE_OPTIONS
      assert.notEqual(killed.code, 0)
      const next = await install(
        h,
        ['--service-action', action === 'disable' ? 'enable' : 'disable'],
        env
      )
      assert.equal(next.code, 0, next.stderr)
      assert.match(next.stderr, /Recovering interrupted service transition/)
      const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      assert.equal(config.service, action === 'disable' ? 1 : 0)
      assert.equal(await readlink(join(root, 'current')), '0.2.0')
      await assert.rejects(access(join(root, '.service-transition')))
      await assert.rejects(lstat(join(root, '.install-lock')))
      if (config.service === 1)
        assert.equal(
          config.service_sha256,
          createHash('sha256')
            .update(await readFile(config.service_file))
            .digest('hex')
        )
      else await assert.rejects(access(file))
    })
  }
}

async function killedDisable() {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const root = join(h, '.local/share/abele-node'),
    configFile = join(root, 'config.json'),
    before = await readFile(configFile, 'utf8'),
    file = JSON.parse(before).service_file
  await writeFile(
    join(h, 'mocks/rm'),
    `#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs'),args=process.argv.slice(2);const r=cp.spawnSync('/bin/rm',args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status);if(args.at(-1)===${JSON.stringify(file)}){fs.unlinkSync(__filename);process.kill(process.ppid,'SIGKILL')}\n`,
    { mode: 0o755 }
  )
  assert.notEqual((await install(h, ['--service-action', 'disable'], env)).code, 0)
  return { h, env, root, configFile, before, file }
}
for (const change of ['service-file', 'state', 'config', 'live-owner']) {
  test(`service-only crash recovery refuses changed ${change} without touching evidence`, async () => {
    const f = await killedDisable(),
      config = JSON.parse(f.before)
    if (change === 'service-file') await writeFile(f.file, 'foreign service file')
    else if (change === 'state') {
      await rename(config.state, join(f.h, 'original-state'))
      await mkdir(config.state)
    } else if (change === 'config')
      await writeFile(f.configFile, JSON.stringify({ ...config, claude: '/foreign/selection' }))
    else {
      const file = join(f.root, '.service-transition/transaction.json'),
        m = JSON.parse(await readFile(file, 'utf8'))
      await writeFile(file, JSON.stringify({ ...m, pid: process.pid, pgid: process.pid }))
    }
    await writeFile(join(f.h, 'systemctl.log'), '')
    const result = await install(f.h, ['--service-action', 'enable'], f.env)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /recovery refused|changed|transition is active/i)
    await access(join(f.root, '.service-transition/transaction.json'))
    assert.equal(await readFile(join(f.h, 'systemctl.log'), 'utf8'), '')
    if (change === 'service-file')
      assert.equal(await readFile(f.file, 'utf8'), 'foreign service file')
    if (change !== 'config') assert.equal(await readFile(f.configFile, 'utf8'), f.before)
  })
}
test('service-only recovery refuses a surviving mutation process group after its shell dies', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
  const root = join(h, '.local/share/abele-node'),
    fault = join(h, 'surviving-child.cjs'),
    release = join(h, 'release-child'),
    ready = join(h, 'survivor.json'),
    published = join(h, 'child-published')
  await writeFile(
    fault,
    `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(from,to,...rest)=>{if(String(to).endsWith('/abele-node.service')&&process.env.ABELE_SERVICE_TRANSITION){fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));fs.closeSync(1);fs.closeSync(2);process.kill(process.ppid,'SIGKILL');const until=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);const r=rename(from,to,...rest);fs.writeFileSync(${JSON.stringify(published)},'published');return r}return rename(from,to,...rest)}`
  )
  let pid
  try {
    const killed = await install(h, ['--service-action', 'enable'], {
      ...env,
      NODE_OPTIONS: '--require=' + fault,
    })
    assert.notEqual(killed.code, 0)
    pid = JSON.parse(await readFile(ready, 'utf8')).pid
    const next = await install(h, ['--service-action', 'disable'], env)
    assert.notEqual(next.code, 0, next.stderr)
    assert.match(next.stderr, /process group.*active/i)
    await access(join(root, '.service-transition/transaction.json'))
  } finally {
    await writeFile(release, 'exit')
    for (
      let i = 0;
      i < 500 &&
      !(await access(published).then(
        () => true,
        () => false
      ));
      i++
    )
      await new Promise((done) => setTimeout(done, 10))
    assert.equal(
      await access(published).then(
        () => true,
        () => false
      ),
      true,
      'surviving mutation child must finish before test cleanup'
    )
    if (pid)
      for (let i = 0; i < 500; i++) {
        try {
          process.kill(pid, 0)
        } catch (e) {
          if (e.code === 'ESRCH') break
          throw e
        }
        await new Promise((done) => setTimeout(done, 10))
      }
  }
  const retried = await install(h, ['--service-action', 'disable'], env)
  assert.equal(retried.code, 0, retried.stderr)
})

test('service-only crash recovery can itself be killed and retried', async () => {
  const f = await killedDisable(),
    fault = join(f.h, 'kill-recovery.cjs')
  await writeFile(
    fault,
    `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(from,to,...rest)=>{const r=rename(from,to,...rest);if(String(from).endsWith('restore-candidate')){process.kill(process.pid,'SIGKILL')}return r}`
  )
  const interrupted = await install(f.h, ['--service-action', 'enable'], {
    ...f.env,
    NODE_OPTIONS: '--require=' + fault,
  })
  assert.notEqual(interrupted.code, 0)
  await access(join(f.root, '.service-transition'))
  const next = await install(f.h, ['--service-action', 'enable'], f.env)
  assert.equal(next.code, 0, next.stderr)
  await access(join(f.h, '.test-service-running'))
  assert.equal(await readFile(f.configFile, 'utf8'), f.before)
  await assert.rejects(access(join(f.root, '.service-transition')))
})

async function awaitMarker(file) {
  for (let i = 0; i < 1000; i++) {
    if (
      await access(file).then(
        () => true,
        () => false
      )
    )
      return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Timed out waiting for test marker: ' + file)
}
test('service-only stale recovery takeover is exclusive when contenders observe the same owner', async () => {
  const f = await killedDisable(),
    kill = join(f.h, 'stale-recovery.cjs')
  await writeFile(
    kill,
    `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(from,to,...rest)=>{const r=rename(from,to,...rest);if(String(from).endsWith('restore-candidate'))process.kill(process.pid,'SIGKILL');return r}`
  )
  assert.notEqual(
    (
      await install(f.h, ['--service-action', 'enable'], {
        ...f.env,
        NODE_OPTIONS: '--require=' + kill,
      })
    ).code,
    0
  )
  const physicalRoot = await realpath(f.root),
    lock = join(physicalRoot, '.service-recovery-lock'),
    stale = join(physicalRoot, await readlink(lock))
  const fault = join(f.h, 'contended-recovery.cjs'),
    paused = join(f.h, 'B-paused'),
    ready = join(f.h, 'A-ready'),
    releaseA = join(f.h, 'release-A'),
    releaseB = join(f.h, 'release-B')
  await writeFile(
    fault,
    `const fs=require('node:fs'),rename=fs.renameSync,unlink=fs.unlinkSync,symlink=fs.symlinkSync;let paused=false;const wait=file=>{const until=Date.now()+15000;while(!fs.existsSync(file)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)};const pause=()=>{if(process.env.TEST_RECOVERY_WORKER==='B'&&!paused){paused=true;fs.writeFileSync(${JSON.stringify(paused)},'observed stale owner');wait(${JSON.stringify(releaseB)})}};fs.unlinkSync=(file,...rest)=>{if(String(file)===${JSON.stringify(lock)})pause();return unlink(file,...rest)};fs.renameSync=(from,to,...rest)=>{if(String(from)===${JSON.stringify(stale)})pause();return rename(from,to,...rest)};fs.symlinkSync=(target,file,...rest)=>{const r=symlink(target,file,...rest);if(String(file)===${JSON.stringify(lock)}&&process.env.TEST_RECOVERY_WORKER==='A'){fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({target,pid:process.pid}));wait(${JSON.stringify(releaseA)})}return r}`
  )
  const helper = join(f.root, 'current/service-transition.mjs'),
    env = { ...f.env, HOME: f.h, NODE_OPTIONS: '--require=' + fault }
  let a, b
  try {
    b = run(process.execPath, [helper, 'recover', f.root], { ...env, TEST_RECOVERY_WORKER: 'B' })
    await awaitMarker(paused)
    a = run(process.execPath, [helper, 'recover', f.root], { ...env, TEST_RECOVERY_WORKER: 'A' })
    await awaitMarker(ready)
    const owner = JSON.parse(await readFile(ready, 'utf8'))
    await writeFile(releaseB, 'continue')
    const loser = await b
    assert.notEqual(loser.code, 0, loser.stderr)
    assert.equal(await readlink(lock), owner.target, "loser must not unlink the winner's lock")
    await writeFile(releaseA, 'continue')
    const winner = await a
    assert.equal(winner.code, 0, winner.stderr)
  } finally {
    await writeFile(releaseB, 'continue')
    await writeFile(releaseA, 'continue')
    await Promise.all([a, b].filter(Boolean))
  }
})
test('service-only stale recovery takeover can itself be killed and resumed', async () => {
  const f = await killedDisable(),
    first = join(f.h, 'leave-stale-recovery.cjs'),
    second = join(f.h, 'kill-takeover.cjs')
  await writeFile(
    first,
    `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(from,to,...rest)=>{const r=rename(from,to,...rest);if(String(from).endsWith('restore-candidate'))process.kill(process.pid,'SIGKILL');return r}`
  )
  assert.notEqual(
    (
      await install(f.h, ['--service-action', 'enable'], {
        ...f.env,
        NODE_OPTIONS: '--require=' + first,
      })
    ).code,
    0
  )
  await writeFile(
    second,
    `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(from,to,...rest)=>{const r=rename(from,to,...rest);if(String(to).includes('.service-recovery-owner.')&&String(to).includes('.claimed-'))process.kill(process.pid,'SIGKILL');return r}`
  )
  assert.notEqual(
    (
      await install(f.h, ['--service-action', 'enable'], {
        ...f.env,
        NODE_OPTIONS: '--require=' + second,
      })
    ).code,
    0
  )
  const next = await install(f.h, ['--service-action', 'enable'], f.env)
  assert.equal(next.code, 0, next.stderr)
  await assert.rejects(lstat(join(f.root, '.service-recovery-lock')))
  await assert.rejects(lstat(join(f.root, '.service-transition')))
})

test('service-only recovery never releases a replacement lock owned by another recovery', async () => {
  const f = await killedDisable(),
    root = await realpath(f.root),
    lock = join(root, '.service-recovery-lock'),
    fault = join(f.h, 'replace-recovery-lock.cjs')
  await writeFile(
    fault,
    `const fs=require('node:fs'),rm=fs.rmSync;let replaced=false;fs.rmSync=(file,...rest)=>{const r=rm(file,...rest);if(!replaced&&String(file).includes('.service-transition-retired.')){replaced=true;fs.unlinkSync(${JSON.stringify(lock)});fs.symlinkSync('replacement-owned-by-test',${JSON.stringify(lock)})}return r}`
  )
  const result = await run(
    process.execPath,
    [join(f.root, 'current/service-transition.mjs'), 'recover', f.root],
    { ...f.env, HOME: f.h, NODE_OPTIONS: '--require=' + fault }
  )
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readlink(lock), 'replacement-owned-by-test')
})

for (const platform of ['mac', 'linux']) {
  test(`service-only enable never mistakes a late foreground daemon for service health: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
    const root = join(h, '.local/share/abele-node'),
      configFile = join(root, 'config.json'),
      before = await readFile(configFile, 'utf8'),
      config = JSON.parse(before)
    await writeFile(
      join(h, 'foreground-on-start'),
      JSON.stringify({
        state: config.state,
        runtime: {
          version: config.version,
          cli_path: join(root, config.version, 'packages/node-daemon/dist/cli.js'),
        },
      })
    )
    const result = await install(h, ['--service-action', 'enable'], env)
    assert.notEqual(result.code, 0, result.stderr)
    assert.equal(await readFile(configFile, 'utf8'), before)
    await access(join(h, '.test-service-running'))
    await assert.rejects(access(join(h, 'cli-stop.log')))
    if (platform === 'linux')
      assert.doesNotMatch(
        await readFile(join(h, 'systemctl.log'), 'utf8'),
        /--user stop abele-node/
      )
  })
}

test('service-only enable failure rolls back its newly registered unit and config', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
  const file = join(h, '.local/share/abele-node/config.json'),
    before = await readFile(file, 'utf8')
  await writeFile(join(h, 'fail-start-before-mutation'), 'start refuses')
  const result = await install(h, ['--service-action', 'enable'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /rolling back/)
  assert.equal(await readFile(file, 'utf8'), before)
  await assert.rejects(access(join(h, '.config/systemd/user/abele-node.service')))
  await assert.rejects(access(join(h, '.test-service-enabled')))
  await assert.rejects(access(join(h, '.test-service-running')))
})

test('service-only disable publication failure restores the owned running service', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const file = join(h, '.local/share/abele-node/config.json'),
    before = await readFile(file, 'utf8')
  const unit = JSON.parse(before).service_file,
    original = await readFile(unit, 'utf8')
  await writeFile(
    join(h, 'mocks/mv'),
    '#!/bin/sh\ncase "$*" in *config.json*) exit 1 ;; *) exec /bin/mv "$@" ;; esac\n',
    { mode: 0o755 }
  )
  const result = await install(h, ['--service-action', 'disable'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /rolling back/)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal(await readFile(unit, 'utf8'), original)
  await access(join(h, '.test-service-enabled'))
  await access(join(h, '.test-service-running'))
})

test('service-only foreground refusal gives an exact stop command and changes nothing', async () => {
  const h = await home()
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'])).code, 0)
  const file = join(h, '.local/share/abele-node/config.json'),
    before = await readFile(file, 'utf8')
  const state = JSON.parse(before).state
  await writeFile(join(state, 'daemon.lock'), JSON.stringify({ pid: process.pid }))
  const result = await install(h, ['--service-action', 'enable'])
  assert.notEqual(result.code, 0)
  assert.ok(result.stderr.includes("'" + join(h, '.local/bin/abele-node') + "' stop"))
  assert.equal(await readFile(file, 'utf8'), before)
  await assert.rejects(access(join(h, 'cli-stop.log')))
})

test('argument validation and help work without downloads', async () => {
  for (const args of [
    ['--bogus'],
    ['--version'],
    ['--version', '../bad'],
    ['--prefix', '/'],
    ['--purge-state'],
  ]) {
    const result = await install(await home(), args)
    assert.notEqual(result.code, 0, JSON.stringify(args))
    assert.match(result.stderr, /Unknown|requires|Invalid|absolute|purge/)
  }
  assert.equal((await install(await home(), ['--help'])).code, 0)
  const h = await home()
  const piped = await run(
    '/bin/sh',
    ['-s', '--', '--version', '0.2.0', '--no-service'],
    {
      HOME: h,
      ABELE_INSTALL_BASE_URL: base,
      ABELE_TAILSCALE_PATH: '/nonexistent/tailscale',
    },
    await readFile(script, 'utf8')
  )
  assert.equal(piped.code, 0, piped.stderr)
  assert.match(piped.stdout, /token create desktop/)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
})
test('next steps match plugin fields and use the reported service port', async () => {
  for (const port of [null, 50778]) {
    const h = await home()
    const result = await install(
      h,
      ['--version', '0.2.0', ...(port ? [] : ['--no-service'])],
      port ? { ...(await mockedMacService(h)), TEST_NODE_PORT: String(port) } : {}
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /abele-node token create desktop/)
    assert.match(result.stdout, /Label: any name you like/)
    assert.ok(result.stdout.includes(`URL: http://127.0.0.1:${port ?? 7777}`))
    assert.match(result.stdout, /Installation token: paste the token/)
    assert.match(result.stdout, /Add node/)
    assert.doesNotMatch(result.stdout, /ws:\/\/|installation ID|node_id|\/channel/)
  }
})
test('physical paths reject symlinked ancestors that overlap runtime or HOME', async () => {
  for (const target of ['share/abele-node/not-created/state', 'bin/not-created/state']) {
    const h = await home()
    await mkdir(join(h, '.local'))
    await symlink(join(h, '.local'), join(h, 'alias'))
    const result = await install(h, [
      '--no-service',
      '--version',
      '0.2.0',
      '--state-dir',
      join(h, 'alias', target),
    ])
    assert.notEqual(result.code, 0, result.stderr)
    assert.match(result.stderr, /separate|physical|Invalid/)
    await assert.rejects(access(join(h, '.local/share/abele-node')))
  }
  const h = await home(),
    alias = join(h, 'home-alias')
  await symlink(h, alias)
  await writeFile(join(h, 'keep'), 'never purge HOME')
  const state = join(alias, 'home-alias')
  const purge = await install(h, [
    '--no-service',
    '--uninstall',
    '--state-dir',
    state,
    '--purge-state',
    '--confirm-purge-state',
    state,
  ])
  assert.notEqual(purge.code, 0, purge.stderr)
  assert.equal(await readFile(join(h, 'keep'), 'utf8'), 'never purge HOME')
})
test('case-insensitive directory identity protects HOME and its ancestors from purge', async (t) => {
  const h = await home()
  const alternate = join(resolve(h, '..'), basename(h).toUpperCase())
  let aliasStat
  try {
    aliasStat = await stat(alternate)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const homeStat = await stat(h)
  if (!aliasStat || aliasStat.dev !== homeStat.dev || aliasStat.ino !== homeStat.ino) {
    t.skip(
      'requires a case-insensitive volume; missing-component case behavior is tested separately'
    )
    return
  }
  for (const target of [
    alternate,
    join(resolve(h, '../..'), basename(resolve(h, '..')).toUpperCase()),
  ]) {
    const current = await home()
    // The ancestor target contains every scratch HOME, so keep it away from an
    // actual rm even on a regression: a mocked rm records destructive attempts.
    const mocks = join(current, 'mocks')
    await mkdir(mocks)
    await writeFile(join(mocks, 'rm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/rm.log"\n', {
      mode: 0o755,
    })
    await writeFile(join(current, 'keep'), 'private state')
    const state =
      target === alternate ? join(resolve(current, '..'), basename(current).toUpperCase()) : target
    const result = await install(
      current,
      [
        '--no-service',
        '--uninstall',
        '--purge-state',
        '--state-dir',
        state,
        '--confirm-purge-state',
        state,
      ],
      { PATH: `${mocks}:${process.env.PATH}` }
    )
    assert.notEqual(result.code, 0, result.stderr)
    await assert.rejects(access(join(current, 'rm.log')))
    assert.equal(await readFile(join(current, 'keep'), 'utf8'), 'private state')
  }
})
test('missing path components respect case-insensitive overlaps and proven case-sensitive distinctions', async () => {
  const h = await home()
  await writeFile(join(h, 'CaseProbe'), 'case detection')
  let insensitive = false
  try {
    const a = await stat(join(h, 'CaseProbe')),
      b = await stat(join(h, 'caseprobe'))
    insensitive = a.dev === b.dev && a.ino === b.ino
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const suffix of ['share/abele-node/not-created/state', 'bin/not-created/state']) {
    const prefix = join(h, 'RuntimePrefix'),
      state = join(h, 'runtimeprefix', suffix)
    const result = await install(h, [
      '--no-service',
      '--version',
      '0.2.0',
      '--prefix',
      prefix,
      '--state-dir',
      state,
    ])
    if (insensitive) {
      assert.notEqual(result.code, 0, result.stderr)
      assert.match(result.stderr, /separate|physical|Invalid/)
    } else {
      assert.equal(result.code, 0, result.stderr)
      assert.equal((await install(h, ['--uninstall', '--prefix', prefix])).code, 0)
    }
  }
})
test('uninstall refuses a recorded state whose parent symlink now overlaps runtime', async () => {
  const h = await home(),
    alias = join(h, 'alias'),
    safe = join(h, 'safe')
  await mkdir(safe)
  await symlink(safe, alias)
  const state = join(alias, 'share/abele-node/state')
  assert.equal(
    (await install(h, ['--no-service', '--version', '0.2.0', '--state-dir', state])).code,
    0
  )
  // Keep the original regression for a legacy, unpinned foreground config.
  const configFile = join(h, '.local/share/abele-node/config.json')
  const legacy = JSON.parse(await readFile(configFile, 'utf8'))
  legacy.state = state
  delete legacy.state_identity
  await writeFile(configFile, JSON.stringify(legacy))
  await mkdir(join(h, '.local/share/abele-node/state'))
  await writeFile(join(h, '.local/share/abele-node/state/keep'), 'state')
  await rm(alias)
  await symlink(join(h, '.local'), alias)
  const result = await install(h, ['--uninstall'])
  assert.notEqual(result.code, 0, result.stderr)
  assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'state')
})
test('truncated piped scripts do not create or change an installation', async () => {
  const source = await readFile(script, 'utf8')
  for (const boundary of [
    'work=$(mktemp',
    'trap cleanup 0',
    'check_health "$version"',
    'transaction=0\njournal_recording=0',
  ]) {
    const cut = source.indexOf(boundary)
    assert.ok(cut > 0, boundary)
    const h = await home()
    const result = await run(
      '/bin/sh',
      ['-s', '--', '--no-service', '--version', '0.2.0'],
      {
        HOME: h,
        ABELE_INSTALL_BASE_URL: base,
        ABELE_TAILSCALE_PATH: '/nonexistent/tailscale',
      },
      source.slice(0, cut)
    )
    assert.equal(result.stdout, '', result.stderr)
    await assert.rejects(access(join(h, '.local/share/abele-node')))
  }
})
test('refuses root before writing anything', async () => {
  const h = await home(),
    bin = join(h, 'mocks')
  await mkdir(bin)
  await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
  const result = await install(h, ['--no-service'], { PATH: `${bin}:${process.env.PATH}` })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /root/)
  await assert.rejects(access(join(h, '.local/share/abele-node')))
})
test('unsupported Node prints the exact tested version fix', async () => {
  const h = await home(),
    bin = join(h, 'mocks')
  await mkdir(bin)
  await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const result = await install(h, ['--no-service'], { PATH: `${bin}:${process.env.PATH}` })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /22\.23\.2/)
  assert.match(result.stderr, /nvm install 22\.23\.2/)
})
test('latest resolution, pinned version and wrapper with spaces and quotes', async () => {
  const h = await home(),
    prefix = join(h, "custom ' prefix")
  const result = await install(h, [
    '--no-service',
    '--prefix',
    prefix,
    '--state-dir',
    join(h, 'state with spaces'),
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readlink(join(prefix, 'share/abele-node/current')), '0.2.0')
  const status = await run(join(prefix, 'bin/abele-node'), ['status', '--json'], { HOME: h })
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).version, '0.2.0')
  assert.match(result.stdout, /token create desktop/)
  assert.equal(
    (await install(h, ['--version', 'v0.2.0', '--no-service', '--prefix', prefix])).code,
    0
  )
})
test('fresh foreground installation binds a private state directory before recording its identity', async () => {
  const h = await home(),
    state = join(h, 'not-created/node')
  const result = await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])
  assert.equal(result.code, 0, result.stderr)
  const config = JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8'))
  assert.ok(config.state_identity)
  const physical = await realpath(state),
    s = await stat(physical, { bigint: true })
  assert.equal(config.state, physical)
  assert.equal(
    config.state_identity,
    'marker:' + s.ino + ':' + (await readFile(join(state, '.abele-state-identity'), 'utf8'))
  )
  assert.equal(Number(s.mode) & 0o777, 0o700)
  assert.equal(Number((await stat(join(state, '.abele-state-identity'))).mode) & 0o777, 0o600)
})
test('upgrade migrates legacy identity despite a changed device number', async () => {
  const h = await home(),
    state = join(h, 'state')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  const file = join(h, '.local/share/abele-node/config.json')
  const config = JSON.parse(await readFile(file, 'utf8'))
  const s = await stat(state, { bigint: true })
  config.state_identity = s.dev + ':' + s.ino + 'invalid'
  await writeFile(file, JSON.stringify(config))
  const malformed = await install(h, ['--version', '0.2.3', '--no-service'])
  assert.notEqual(malformed.code, 0, malformed.stderr)
  await assert.rejects(access(join(h, 'cli-stop.log')))
  config.state_identity = s.dev + 1n + ':' + s.ino
  await writeFile(file, JSON.stringify(config))
  const result = await install(h, ['--version', '0.2.3', '--no-service'])
  assert.equal(result.code, 0, result.stderr)
  const updated = JSON.parse(await readFile(file, 'utf8'))
  assert.match(updated.state_identity, /^marker:\d+:[a-f0-9]{64}$/)
  assert.equal(
    await readFile(join(state, '.abele-state-identity'), 'utf8'),
    updated.state_identity.split(':')[2]
  )
})
test('legacy foreground configurations cannot adopt a new state identity before destructive actions', async () => {
  const h = await home(),
    state = join(h, 'state')
  await mkdir(state)
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  const file = join(h, '.local/share/abele-node/config.json'),
    legacy = JSON.parse(await readFile(file, 'utf8'))
  delete legacy.state_identity
  await writeFile(file, JSON.stringify(legacy))
  const result = await install(h, [
    '--uninstall',
    '--no-service',
    '--purge-state',
    '--confirm-purge-state',
    state,
  ])
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /state identity.*missing|missing.*state identity/i)
  await assert.rejects(access(join(h, 'cli-stop.log')))
  await access(join(h, '.local/share/abele-node/current'))
})
test('legacy migration refuses a missing, non-directory or replaced state', async () => {
  const h = await home(),
    state = join(h, 'state'),
    moved = join(h, 'original')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  const file = join(h, '.local/share/abele-node/config.json'),
    config = JSON.parse(await readFile(file, 'utf8'))
  const s = await stat(state, { bigint: true })
  config.state_identity = s.dev + 1n + ':' + s.ino
  const before = JSON.stringify(config)
  await writeFile(file, before)
  await rename(state, moved)
  for (const damage of ['missing', 'file', 'directory']) {
    if (damage === 'file') await writeFile(state, 'foreign state')
    if (damage === 'directory') await mkdir(state)
    const result = await install(h, [
      '--uninstall',
      '--no-service',
      '--purge-state',
      '--confirm-purge-state',
      state,
    ])
    assert.notEqual(result.code, 0, result.stderr)
    await assert.rejects(access(join(h, 'cli-stop.log')))
    assert.equal(await readFile(file, 'utf8'), before)
    await access(join(moved, '.abele-state-identity'))
    await rm(state, { recursive: true, force: true })
  }
})
test('a recorded state moved behind an alias is refused even with the same inode and marker', async () => {
  const h = await home(),
    state = join(h, 'state'),
    moved = join(h, 'moved')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  await rename(state, moved)
  await symlink(moved, state)
  const result = await install(h, ['--version', '0.2.3', '--no-service'])
  assert.notEqual(result.code, 0, result.stderr)
  await assert.rejects(access(join(h, 'cli-stop.log')))
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
})
test('marker identity survives device changes and refuses missing, replaced or aliased markers', async () => {
  const h = await home(),
    state = join(h, 'state')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  const fault = join(h, 'changed-device.cjs')
  await writeFile(
    fault,
    `const fs=require('node:fs'),stat=fs.statSync;fs.statSync=(p,...args)=>{const s=stat(p,...args);if(String(p)===${JSON.stringify(state)})s.dev=typeof s.dev==='bigint'?s.dev+1n:s.dev+1;return s}`
  )
  const result = await install(h, ['--version', '0.2.3', '--no-service'], {
    NODE_OPTIONS: '--require=' + fault,
  })
  assert.equal(result.code, 0, result.stderr)
  const marker = join(state, '.abele-state-identity'),
    token = await readFile(marker, 'utf8')
  for (const damage of ['missing', 'replaced', 'alias']) {
    await rm(join(h, 'cli-stop.log'), { force: true })
    await rm(marker, { force: true })
    if (damage === 'replaced') await writeFile(marker, '0'.repeat(64))
    if (damage === 'alias') {
      const target = join(h, 'foreign-marker')
      await writeFile(target, token)
      await symlink(target, marker)
    }
    const rejected = await install(h, [
      '--uninstall',
      '--no-service',
      '--purge-state',
      '--confirm-purge-state',
      state,
    ])
    assert.notEqual(rejected.code, 0, rejected.stderr)
    await assert.rejects(access(join(h, 'cli-stop.log')))
    await access(join(h, '.local/share/abele-node/current'))
    await access(state)
  }
})
test('foreground state identity is verified before uninstall, purge or upgrade can stop anything', async () => {
  for (const action of ['uninstall', 'purge', 'upgrade']) {
    const h = await home(),
      parent = join(h, 'data'),
      state = join(parent, 'node'),
      replacement = join(h, 'foreign'),
      moved = join(h, 'original')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'keep'), 'original state')
    const first = await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])
    assert.equal(first.code, 0, first.stderr)
    const config = join(h, '.local/share/abele-node/config.json'),
      before = await readFile(config, 'utf8')
    assert.ok(JSON.parse(before).state_identity)
    await mkdir(join(replacement, 'node'), { recursive: true })
    await writeFile(join(replacement, 'node/keep'), 'foreign state')
    await rename(parent, moved)
    await symlink(replacement, parent)
    const args =
      action === 'upgrade'
        ? ['--version', '0.2.3', '--no-service']
        : ['--uninstall', '--no-service']
    if (action === 'purge') args.push('--purge-state', '--confirm-purge-state', state)
    const result = await install(h, args)
    assert.notEqual(result.code, 0, result.stderr)
    assert.match(result.stderr, /identity changed/)
    await assert.rejects(access(join(h, 'cli-stop.log')))
    assert.equal(await readFile(config, 'utf8'), before)
    assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
    assert.equal(await readFile(join(replacement, 'node/keep'), 'utf8'), 'foreign state')
    assert.equal(await readFile(join(moved, 'node/keep'), 'utf8'), 'original state')
  }
})
test('foreground state identity is rechecked after stop before removing runtime or purging state', async () => {
  const h = await home(),
    parent = join(h, 'data'),
    state = join(parent, 'node'),
    replacement = join(h, 'foreign'),
    moved = join(h, 'original')
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'keep'), 'original state')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  await mkdir(join(replacement, 'node'), { recursive: true })
  await writeFile(join(replacement, 'node/keep'), 'foreign state')
  await writeFile(
    join(h, 'swap-state-on-stop.json'),
    JSON.stringify({ parent, moved, replacement })
  )
  const result = await install(h, [
    '--uninstall',
    '--no-service',
    '--purge-state',
    '--confirm-purge-state',
    state,
  ])
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /identity changed/)
  await access(join(h, 'cli-stop.log'))
  await access(join(h, '.local/share/abele-node/current'))
  assert.equal(await readFile(join(replacement, 'node/keep'), 'utf8'), 'foreign state')
})
test('a late same-inode relocation into runtime is refused without re-resolving the pinned state', async () => {
  const h = await home(),
    parent = join(h, 'data'),
    state = join(parent, 'node')
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'keep'), 'state must survive runtime removal')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  const moved = join(h, '.local/share/abele-node/relocated-state')
  await writeFile(
    join(h, 'swap-state-on-stop.json'),
    JSON.stringify({ parent, moved, replacement: moved })
  )
  const result = await install(h, ['--uninstall', '--no-service'])
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /identity changed|pinned state path/i)
  await access(join(h, '.local/share/abele-node/current'))
  assert.equal(
    await readFile(join(moved, 'node/keep'), 'utf8'),
    'state must survive runtime removal'
  )
})
test('successful upgrade preserves state and selects the new immutable version', async () => {
  const h = await home(),
    state = join(h, 'saved-state')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'keep'), 'keep')
  const next = await install(h, ['--version', '0.2.3', '--no-service'])
  assert.equal(next.code, 0, next.stderr)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.3')
  await access(join(h, '.local/share/abele-node/0.2.0'))
  assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'keep')
})
test('checksum failure leaves existing install and state intact', async () => {
  const h = await home()
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'])).code, 0)
  const result = await install(h, ['--version', '0.2.2', '--no-service'])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /checksum/i)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
})
test('failed doctor/status rolls back the symlink and wrapper, keeping state', async () => {
  const h = await home(),
    state = join(h, 'custom-state')
  assert.equal(
    (await install(h, ['--version', '0.2.0', '--no-service', '--state-dir', state])).code,
    0
  )
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'keep'), 'private-state')
  const result = await install(h, ['--version', '0.2.1', '--no-service'])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /roll.*back/i)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
  assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'private-state')
  const status = await run(join(h, '.local/bin/abele-node'), ['status', '--json'], { HOME: h })
  assert.equal(JSON.parse(status.stdout).version, '0.2.0')
})
test('invalid latest response cannot become a filesystem path', async () => {
  routes.set('/invalid-latest', JSON.stringify({ tag_name: '../../bad' }))
  const result = await install(await home(), ['--no-service'], {
    ABELE_INSTALL_API_URL: `${base}/invalid-latest`,
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /version|release/i)
})
test('uninstall keeps state; purge requires explicit confirmation', async () => {
  const h = await home(),
    state = join(h, '.local/state/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'])).code, 0)
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'keep'), 'keep')
  assert.notEqual((await install(h, ['--uninstall', '--purge-state', '--no-service'])).code, 0)
  assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'keep')
  assert.equal((await install(h, ['--uninstall'])).code, 0)
  await assert.rejects(access(join(h, '.local/share/abele-node')))
  assert.equal(await readFile(join(state, 'keep'), 'utf8'), 'keep')
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'])).code, 0)
  assert.equal(
    (
      await install(h, [
        '--uninstall',
        '--purge-state',
        '--confirm-purge-state',
        state,
        '--no-service',
      ])
    ).code,
    0
  )
  await assert.rejects(access(state))
})
async function mockedMacService(h) {
  const bin = join(h, 'mocks')
  await mkdir(bin)
  await writeFile(
    join(bin, 'uname'),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n',
    { mode: 0o755 }
  )
  await writeFile(
    join(bin, 'node'),
    `#!/bin/sh
if [ "$1" = -p ] && [ "$2" = process.arch ]; then echo arm64
else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi
`,
    { mode: 0o755 }
  )
  return { PATH: `${bin}:${process.env.PATH}`, TEST_MAC_SERVICE: '1' }
}
for (const outcome of ['upgrade', 'never-unloads', 'status-fails', 'health-rollback']) {
  test(`macOS confirms legacy CLI stop failure independently: ${outcome}`, async () => {
    const h = await home(),
      env = await mockedMacService(h),
      root = join(h, '.local/share/abele-node'),
      plist = join(h, 'Library/LaunchAgents/dev.abele.node.plist')
    const first = await install(h, ['--version', '0.3.1'], env)
    assert.equal(first.code, 0, first.stderr)
    const original = await readFile(plist, 'utf8'),
      config = await readFile(join(root, 'config.json'), 'utf8')
    await writeFile(join(h, 'legacy-stop-unconfirmed'), outcome === 'never-unloads' ? '-1' : '3')
    if (outcome === 'status-fails')
      await writeFile(join(h, 'legacy-status-fails'), 'fail confirmation after unload')
    const target = outcome === 'health-rollback' ? '0.3.2' : '0.3.3'
    const result = await install(h, ['--version', target], env)
    const events = await readFile(join(h, 'legacy-stop-events'), 'utf8')
    assert.ok(events.split('\n').filter((line) => line === 'print').length >= 4, events)
    if (outcome === 'upgrade') {
      assert.equal(result.code, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /launch_agent_stop_unconfirmed/)
      assert.match(events, /status 2\nstatus 1\nstatus 0/)
      assert.equal(await readlink(join(root, 'current')), target)
      assert.equal(
        JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
        target
      )
    } else {
      assert.notEqual(result.code, 0)
      if (outcome === 'health-rollback') {
        assert.match(result.stderr, /New runtime failed status\/doctor health checks/)
        assert.doesNotMatch(result.stdout + result.stderr, /launch_agent_stop_unconfirmed/)
      } else {
        if (outcome === 'never-unloads')
          assert.match(result.stderr, /launch_agent_stop_unconfirmed: /)
        else assert.match(result.stderr, /legacy status unavailable/)
        assert.match(result.stderr, /^launch_agent_stop_unconfirmed$/m)
      }
      assert.equal(await readlink(join(root, 'current')), '0.3.1')
      assert.equal(await readFile(plist, 'utf8'), original)
      assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
      assert.equal(
        JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
        '0.3.1'
      )
      await access(join(h, '.fake-launch-job'))
      assert.match(await readFile(join(h, 'launch-kickstarts'), 'utf8'), /kickstart/)
      assert.doesNotMatch(result.stderr, /Automatic service rollback failed/)
      if (outcome === 'never-unloads')
        assert.match(await readFile(join(h, 'launch-kickstarts'), 'utf8'), /kickstart -k/)
    }
  })
}
test('failed macOS 0.3.2 upgrade restores a running 0.3.1 despite nonzero rollback bootstrap', async () => {
  const h = await home(),
    env = await mockedMacService(h),
    root = join(h, '.local/share/abele-node')
  const first = await install(h, ['--version', '0.3.1'], env)
  assert.equal(first.code, 0, first.stderr)
  await writeFile(join(h, 'async-rollback-bootstrap'), 'bootstrap accepted asynchronously')
  const result = await install(h, ['--version', '0.3.2'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readlink(join(root, 'current')), '0.3.1')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.3.1'
  )
  assert.doesNotMatch(
    result.stderr,
    /Automatic service rollback failed|previous runtime could not be verified/
  )
})
test('macOS uninstall uses the installed canonical service state after alias retargeting', async () => {
  const h = await home(),
    env = await mockedMacService(h),
    a = join(h, 'A'),
    b = join(h, 'B'),
    alias = join(h, 'state-alias')
  await mkdir(a)
  await mkdir(b)
  await symlink(a, alias)
  const installedResult = await install(
    h,
    ['--version', '0.2.0', '--state-dir', join(alias, 'node')],
    env
  )
  assert.equal(installedResult.code, 0, installedResult.stderr)
  const installed = JSON.parse(
    await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8')
  )
  const actual = await realpath(join(a, 'node'))
  // A prior installer saved the alias even though the authenticated plist used
  // the physical state. Migration must take the state from that plist.
  const legacy = { ...installed, state: join(alias, 'node') }
  delete legacy.state_identity
  await writeFile(join(h, '.local/share/abele-node/config.json'), JSON.stringify(legacy))
  await writeFile(join(actual, 'keep'), 'original state')
  await rm(alias)
  await symlink(b, alias)
  const result = await install(h, ['--uninstall'], env)
  assert.equal(result.code, 0, result.stderr)
  await assert.rejects(access(join(h, '.fake-launch-job')))
  await assert.rejects(access(join(h, '.test-service-running')))
  assert.equal(installed.state, actual)
  assert.equal(await readFile(join(actual, 'keep'), 'utf8'), 'original state')
})
test('missing daemon PID does not confirm macOS stop when launchd still has the job', async () => {
  const h = await home(),
    env = await mockedMacService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  await rm(join(h, '.test-service-running'))
  await writeFile(join(h, 'block-unload'), 'manager refuses to unload')
  const result = await install(h, ['--uninstall'], env)
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /confirm.*stop/i)
  await access(join(h, '.fake-launch-job'))
  await access(join(h, 'Library/LaunchAgents/dev.abele.node.plist'))
  await access(join(h, '.local/share/abele-node/current'))
})
test('state directory identity changes refuse uninstall without unloading the job', async () => {
  const h = await home(),
    env = await mockedMacService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const cfg = JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8'))
  const moved = join(h, 'retained-original')
  await rename(cfg.state, moved)
  await mkdir(cfg.state)
  await writeFile(join(cfg.state, 'keep'), 'unrelated replacement')
  const result = await install(h, ['--uninstall'], env)
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /identity changed/)
  await access(join(h, '.fake-launch-job'))
  assert.equal(await readFile(join(cfg.state, 'keep'), 'utf8'), 'unrelated replacement')
})
async function mockedLinuxService(h, prefix = join(h, '.local'), bin = join(h, 'mocks')) {
  await mkdir(bin)
  await writeFile(
    join(bin, 'uname'),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else exec /usr/bin/uname "$@"; fi\n',
    { mode: 0o755 }
  )
  await writeFile(
    join(bin, 'systemctl'),
    `#!${process.execPath}
import fs from 'node:fs';
const home=process.env.HOME, args=process.argv.slice(2).join(' ');
const root=(process.env.TEST_INSTALL_PREFIX || home+'/.local')+'/share/abele-node', unit=home+'/.config/systemd/user/abele-node.service';
fs.appendFileSync(home+'/systemctl.log',args+' current='+(fs.existsSync(root+'/current')?fs.readlinkSync(root+'/current'):'')+'\\n');
if(args==='--user show abele-node.service --property=FragmentPath --value')console.log(fs.existsSync(home+'/simulate-fragment')?fs.readFileSync(home+'/simulate-fragment','utf8'):(fs.existsSync(unit)?unit:''));
if(args==='--user show abele-node.service --property=DropInPaths --value')console.log(fs.existsSync(home+'/simulate-loaded-dropins')?fs.readFileSync(home+'/simulate-loaded-dropins','utf8'):'');
if(args==='--user show abele-node.service --property=MainPID --value')console.log(fs.existsSync(home+'/simulate-main-pid-zero')?'0':fs.existsSync(home+'/simulate-foreign-pid')?'2337':(fs.existsSync(home+'/.test-service-running')?'1337':'0'));
if(args==='--user show abele-node.service --property=ActiveState --value'){
  const active=(!fs.existsSync(home+'/simulate-main-pid-zero')&&fs.existsSync(home+'/.test-service-running'))||fs.existsSync(home+'/simulate-active-job');console.log(active?'active':'inactive');
  if(!active && fs.existsSync(home+'/reactivate-rejected-version') && fs.existsSync(home+'/loaded-unit-cli') && fs.readFileSync(home+'/loaded-unit-cli','utf8').includes('/0.2.1/'))fs.writeFileSync(home+'/timer-armed','armed');
}
if(args==='--user daemon-reload'){
  if(fs.existsSync(home+'/timer-armed')){
    const cli=fs.readFileSync(home+'/loaded-unit-cli','utf8'),version=JSON.parse(fs.readFileSync(cli.replace('/packages/node-daemon/dist/cli.js','/package.json'),'utf8')).version;
    fs.writeFileSync(home+'/.test-service-running',JSON.stringify({runtime:{cli_path:fs.realpathSync(cli),version}}));
    fs.appendFileSync(home+'/systemctl.log','timer-activation version='+version+'\\n');fs.rmSync(home+'/timer-armed');
  }
  if(fs.existsSync(unit))fs.writeFileSync(home+'/loaded-unit-cli',fs.readFileSync(unit,'utf8').split('"').find(part=>part.endsWith('/packages/node-daemon/dist/cli.js')));
  if(fs.existsSync(home+'/unloaded-override'))fs.writeFileSync(home+'/simulate-loaded-dropins',fs.readFileSync(home+'/unloaded-override','utf8'));
}
if(args==='--user stop abele-node.service'){
  if(fs.existsSync(home+'/simulate-loaded-dropins') && fs.existsSync(home+'/fail-stop-on-override'))process.exit(2);
  if(fs.existsSync(home+'/fill-service-volume-after-stop')){
    const backups=fs.readdirSync(home+'/.config/systemd/user').filter(name=>name.startsWith('.abele-node-backup.'));
    const candidate=backups.length===1?home+'/.config/systemd/user/'+backups[0]+'/restore-candidate':null;
    fs.writeFileSync(home+'/candidate-at-stop',candidate && fs.existsSync(candidate)?fs.readFileSync(candidate):'not-prestaged');
    fs.writeFileSync(home+'/service-volume-full','ENOSPC after service stop');
  }
  fs.rmSync(home+'/.test-service-running',{force:true});
  if(fs.existsSync(home+'/fail-journal-append-after-stop'))fs.writeFileSync(home+'/stopped-for-journal-fault','stopped');
}
if(args==='--user disable abele-node.service')fs.rmSync(home+'/.test-service-enabled',{force:true});
if(args==='--user enable abele-node.service')fs.writeFileSync(home+'/.test-service-enabled','enabled');
if(args==='--user enable --now abele-node.service'){
  fs.writeFileSync(home+'/.test-service-enabled','enabled');
  if(fs.existsSync(home+'/.test-service-running'))process.exit(0); // Enable is not restart.
}
if(args==='--user start abele-node.service' && fs.existsSync(home+'/foreground-on-start')){fs.copyFileSync(home+'/foreground-on-start',home+'/.test-service-running');fs.writeFileSync(home+'/simulate-main-pid-zero','foreground has no manager PID');process.exit(0)}
if(args==='--user start abele-node.service' && fs.existsSync(home+'/fail-start-before-mutation'))process.exit(3);
if(args==='--user start abele-node.service' && fs.existsSync(home+'/.test-service-running'))process.exit(0);
if(args==='--user enable --now abele-node.service' || args==='--user start abele-node.service' || args==='--user restart abele-node.service'){
  const content=fs.readFileSync(unit,'utf8');
  let cli=fs.existsSync(home+'/loaded-unit-cli')?fs.readFileSync(home+'/loaded-unit-cli','utf8'):content.split('"').find(part=>part.endsWith('/packages/node-daemon/dist/cli.js'));
  if(fs.existsSync(home+'/simulate-wrong-runtime'))cli=root+'/0.2.0/packages/node-daemon/dist/cli.js';
  if(fs.existsSync(home+'/simulate-loaded-dropins') && fs.existsSync(home+'/override-exec-runtime'))cli=fs.readFileSync(home+'/override-exec-runtime','utf8');
  const version=JSON.parse(fs.readFileSync(cli.replace('/packages/node-daemon/dist/cli.js','/package.json'),'utf8')).version;
  fs.writeFileSync(home+'/.test-service-enabled','enabled');
  fs.writeFileSync(home+'/.test-service-running',JSON.stringify({runtime:{cli_path:fs.realpathSync(cli),version}}));
}
`,
    { mode: 0o755 }
  )
  await writeFile(
    join(bin, 'busctl'),
    `#!${process.execPath}
import fs from 'node:fs';const home=process.env.HOME;
fs.appendFileSync(home+'/busctl.log',JSON.stringify(process.argv.slice(2))+'\\n');
const roots=fs.existsSync(home+'/manager-unit-paths.json')?JSON.parse(fs.readFileSync(home+'/manager-unit-paths.json','utf8')):[home+'/.config/systemd/user',home+'/.local/share/systemd/user'];
console.log(JSON.stringify({type:'as',data:roots}));
`,
    { mode: 0o755 }
  )
  return { PATH: `${bin}:${process.env.PATH}`, TEST_INSTALL_PREFIX: prefix }
}
async function serviceRestoreFault(h, code) {
  const file = join(h, 'restore-fault.cjs')
  await writeFile(
    file,
    `const fs=require('node:fs'), original=fs.renameSync;
fs.renameSync=(source,destination)=>{
  if(String(destination).endsWith('/.config/systemd/user/abele-node.service') &&
    ((${JSON.stringify(code)}==='EACCES' && String(source).includes('restore-candidate')) || String(source).includes('/share/abele-node/.download.'))){
    const error=new Error('simulated '+${JSON.stringify(code)});error.code=${JSON.stringify(code)};throw error;
  }
  return original(source,destination);
};`
  )
  return `--require=${file}`
}
test('journal writability and free-space checks refuse before the first service mutation', async () => {
  for (const kind of ['unwritable', 'no-space']) {
    const h = await home(),
      env = await mockedLinuxService(h),
      root = join(h, '.local/share/abele-node')
    assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
    const config = await readFile(join(root, 'config.json'), 'utf8')
    const fault = join(h, 'journal-preflight-fault.cjs')
    await writeFile(
      fault,
      `const fs=require('node:fs');
if(${JSON.stringify(kind)}==='unwritable'){const append=fs.appendFileSync;fs.appendFileSync=(file,...args)=>{if(String(file).endsWith('actions.jsonl')){const e=new Error('unwritable journal');e.code='EACCES';throw e}return append(file,...args)}}
else{const stat=fs.statfsSync;fs.statfsSync=(...args)=>({...stat(...args),bavail:0n})}`
    )
    await writeFile(join(h, 'systemctl.log'), '')
    const result = await install(h, ['--version', '0.2.3'], {
      ...env,
      NODE_OPTIONS: '--require=' + fault,
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /not writable|insufficient free space/i)
    assert.doesNotMatch(
      await readFile(join(h, 'systemctl.log'), 'utf8'),
      /stop abele-node|restart abele-node|daemon-reload|enable --now/
    )
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
    assert.equal(
      JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
      '0.2.0'
    )
  }
})
test('journal ENOSPC after a successful stop restores the previously running service from write-ahead intent', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service'),
    root = join(h, '.local/share/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8'),
    config = await readFile(join(root, 'config.json'), 'utf8')
  const fault = join(h, 'journal-full.cjs')
  await writeFile(
    fault,
    `const fs=require('node:fs'),append=fs.appendFileSync;
fs.appendFileSync=(file,...args)=>{if(String(file).endsWith('actions.jsonl') && fs.existsSync(process.env.HOME+'/stopped-for-journal-fault')){const e=new Error('journal ENOSPC after stop');e.code='ENOSPC';throw e}return append(file,...args)};`
  )
  await writeFile(join(h, 'fail-journal-append-after-stop'), 'simulate exhausted prefix volume')
  const result = await install(h, ['--version', '0.2.3'], {
    ...env,
    NODE_OPTIONS: '--require=' + fault,
  })
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.0'
  )
  assert.match(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /restart abele-node.service current=0.2.0/
  )
})
test('macOS cached legacy CLI can ignore journal flags and still recover its original plist after failed bootstrap', async () => {
  const h = await home(),
    env = await mockedMacService(h),
    root = join(h, '.local/share/abele-node'),
    plist = join(h, 'Library/LaunchAgents/dev.abele.node.plist')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(plist, 'utf8'),
    config = await readFile(join(root, 'config.json'), 'utf8')
  await writeFile(join(h, 'legacy-cli-ignores-journal'), 'old immutable runtime')
  await writeFile(join(h, 'fail-bootstrap'), 'next bootstrap fails')
  const result = await install(
    h,
    ['--version', '0.2.0', '--claude-path', join(h, 'different-claude')],
    env
  )
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(plist, 'utf8'), original)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.0'
  )
  await access(join(h, '.fake-launch-job'))
  assert.doesNotMatch(result.stderr, /Previous service file was not restored/)
})
test('full service volume after stop restores the prestaged unit without allocating on that volume', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service'),
    root = join(h, '.local/share/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8'),
    config = await readFile(join(root, 'config.json'), 'utf8'),
    mode = (await stat(unit)).mode & 0o777
  const fault = join(h, 'service-volume-full.cjs')
  await writeFile(
    fault,
    `const fs=require('node:fs'),copy=fs.copyFileSync;
fs.copyFileSync=(src,dst,...args)=>{if(String(dst).endsWith('/restore-candidate') && fs.existsSync(process.env.HOME+'/service-volume-full')){const e=new Error('service volume ENOSPC');e.code='ENOSPC';throw e}return copy(src,dst,...args)};`
  )
  await writeFile(join(h, 'fill-service-volume-after-stop'), 'fill HOME volume after stop')
  const result = await install(h, ['--version', '0.2.1'], {
    ...env,
    NODE_OPTIONS: '--require=' + fault,
  })
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(join(h, 'candidate-at-stop'), 'utf8'), original)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal((await stat(unit)).mode & 0o777, mode)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.0'
  )
  assert.doesNotMatch(result.stderr, /Automatic service rollback failed/)
  assert.match(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /restart abele-node.service current=0.2.0/
  )
})
test('service rollback restores bytes and mode without a cross-volume rename from prefix', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const previous = await readFile(unit, 'utf8'),
    mode = (await stat(unit)).mode & 0o777
  const result = await install(h, ['--version', '0.2.1'], {
    ...env,
    NODE_OPTIONS: await serviceRestoreFault(h, 'EXDEV'),
  })
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(result.stderr, /Automatic service rollback failed/)
  assert.equal(await readFile(unit, 'utf8'), previous)
  assert.equal((await stat(unit)).mode & 0o777, mode)
  await access(join(h, '.test-service-running'))
  assert.equal((await install(h, ['--uninstall'], env)).code, 0)
})
test(
  'real Linux cross-filesystem service rollback restores the HOME unit from an external prefix',
  { skip: process.platform !== 'linux' },
  async (t) => {
    let h
    try {
      h = await mkdtemp('/dev/shm/abele-installer-home-')
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes(error.code)) {
        t.skip('no writable separate tmpfs for a throwaway HOME')
        return
      }
      throw error
    }
    try {
      if ((await stat(h)).dev === (await stat(scratch)).dev) {
        t.skip('tmpfs and runtime prefix are on the same filesystem')
        return
      }
      const prefix = join(scratch, 'separate-filesystem-prefix'),
        // /dev/shm is normally noexec; tool mocks belong on the executable
        // prefix volume, while the unit and its backup stay in the RAM HOME.
        env = await mockedLinuxService(h, prefix, join(scratch, 'cross-volume-tools')),
        unit = join(h, '.config/systemd/user/abele-node.service')
      const initial = await install(h, ['--version', '0.2.0', '--prefix', prefix], env)
      assert.equal(initial.code, 0, initial.stderr)
      const previous = await readFile(unit, 'utf8')
      const result = await install(h, ['--version', '0.2.1', '--prefix', prefix], env)
      assert.notEqual(result.code, 0)
      assert.doesNotMatch(result.stderr, /Automatic service rollback failed/)
      assert.equal(await readFile(unit, 'utf8'), previous)
      await access(join(h, '.test-service-running'))
      assert.equal((await install(h, ['--uninstall', '--prefix', prefix], env)).code, 0)
    } finally {
      await rm(h, { recursive: true, force: true })
    }
  }
)
test('failed service restoration preserves the only backup outside download cleanup', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const previous = await readFile(unit, 'utf8')
  const result = await install(h, ['--version', '0.2.1'], {
    ...env,
    NODE_OPTIONS: await serviceRestoreFault(h, 'EACCES'),
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Automatic service rollback failed/)
  const retained = result.stderr.match(/Previous service backup retained: (.+)/)
  assert.ok(retained, result.stderr)
  const backup = retained[1].trim()
  assert.equal(await readFile(join(backup, 'previous-service'), 'utf8'), previous)
  assert.equal((await stat(backup)).mode & 0o777, 0o700)
  assert.ok(
    !(await readdir(join(h, '.local/share/abele-node'))).some((name) =>
      name.startsWith('.download.')
    )
  )
})
test('failed foreground-to-service upgrade removes the new unit and enablement', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--no-service', '--version', '0.2.0'], env)).code, 0)
  const result = await install(h, ['--version', '0.2.1'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /rolling back/i)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8')).service,
    0
  )
  await assert.rejects(access(join(h, '.config/systemd/user/abele-node.service')))
  await assert.rejects(access(join(h, '.test-service-enabled')))
  assert.equal((await install(h, ['--uninstall'], env)).code, 0)
})
test('every run refuses a foreign service, including foreground-to-service and uninstall', async () => {
  const foreign = '[Service]\\nExecStart=/other/daemon --state-dir /other/state\\n'
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--no-service', '--version', '0.2.0'], env)).code, 0)
  await mkdir(join(h, '.config/systemd/user'), { recursive: true })
  await writeFile(unit, foreign)
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /unmanaged|ownership|modified/i)
  assert.equal(await readFile(unit, 'utf8'), foreign)
  await assert.rejects(access(join(h, 'systemctl.log')))

  const other = await home(),
    otherEnv = await mockedLinuxService(other),
    otherUnit = join(other, '.config/systemd/user/abele-node.service')
  assert.equal((await install(other, ['--version', '0.2.0'], otherEnv)).code, 0)
  await writeFile(otherUnit, foreign)
  const before = await readFile(join(other, 'systemctl.log'), 'utf8')
  const removed = await install(other, ['--uninstall'], otherEnv)
  assert.notEqual(removed.code, 0)
  assert.equal(await readFile(otherUnit, 'utf8'), foreign)
  assert.equal(await readFile(join(other, 'systemctl.log'), 'utf8'), before)
  await access(join(other, '.test-service-running'))
})
test('a missing local PID cannot confirm stop while systemd still reports an active job', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  await rm(join(h, '.test-service-running'))
  await writeFile(join(h, 'simulate-active-job'), 'manager still active')
  const result = await install(h, ['--uninstall'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /confirm.*stop/i)
  await access(join(h, '.config/systemd/user/abele-node.service'))
  await access(join(h, '.local/share/abele-node/current'))
})
test('a manager PID belonging to another state is refused before stopping it', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  await writeFile(join(h, 'simulate-foreign-pid'), 'a different service process')
  await writeFile(join(h, 'systemctl.log'), '')
  const result = await install(h, ['--uninstall'], env)
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /stop abele-node|disable abele-node/
  )
  await access(join(h, '.test-service-running'))
})
test('foreign manager PID during upgrade refuses before mutation and never rolls back an untouched service', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    root = join(h, '.local/share/abele-node'),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8'),
    config = await readFile(join(root, 'config.json'), 'utf8'),
    marker = await readFile(join(h, '.test-service-running'), 'utf8')
  await writeFile(
    join(h, 'simulate-foreign-pid'),
    'different daemon under a cached foreign ExecStart'
  )
  await writeFile(join(h, 'systemctl.log'), '')
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /stop abele-node|restart abele-node|enable abele-node|enable --now|disable abele-node|daemon-reload/
  )
  assert.doesNotMatch(result.stderr, /rolling back/)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readFile(join(h, '.test-service-running'), 'utf8'), marker)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  await assert.rejects(access(join(root, '0.2.3')))
})
test('fresh macOS service install refuses a manual daemon without stopping it or creating deployment paths', async () => {
  const h = await home(),
    env = await mockedMacService(h),
    state = join(h, '.local/state/abele-node')
  await mkdir(state, { recursive: true })
  const record = {
    state: await realpath(state),
    runtime: { cli_path: join(h, 'manual-source/cli.js'), version: 'source' },
    manual: true,
  }
  await writeFile(join(h, '.test-service-running'), JSON.stringify(record))
  await writeFile(join(state, 'daemon.lock'), JSON.stringify({ pid: process.pid }))
  const result = await install(h, ['--version', '0.2.0'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /stop_before_install|manual.*daemon|non-installer.*daemon/i)
  assert.equal(await readFile(join(h, '.test-service-running'), 'utf8'), JSON.stringify(record))
  await assert.rejects(access(join(h, 'cli-stop.log')))
  await assert.rejects(access(join(h, 'Library/LaunchAgents/dev.abele.node.plist')))
  await assert.rejects(access(join(h, '.local/share/abele-node')))
  assert.doesNotMatch(result.stderr, /rolling back/)
})
test('failed first macOS bootstrap undoes the written plist but never stops an unstarted daemon', async () => {
  const h = await home(),
    env = await mockedMacService(h)
  await writeFile(join(h, 'fail-bootstrap'), 'bootstrap refuses the new job')
  const result = await install(h, ['--version', '0.2.0'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /rolling back completed journal actions/)
  await assert.rejects(access(join(h, 'cli-stop.log')))
  await assert.rejects(access(join(h, '.fake-launch-job')))
  await assert.rejects(access(join(h, 'Library/LaunchAgents/dev.abele.node.plist')))
  await assert.rejects(access(join(h, '.local/share/abele-node/current')))
})
test('rollback does not restart an old service that was already inactive before this run', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8')
  assert.equal(
    (
      await run(join(h, 'mocks/systemctl'), ['--user', 'stop', 'abele-node.service'], {
        ...env,
        HOME: h,
      })
    ).code,
    0
  )
  await writeFile(join(h, 'systemctl.log'), '')
  const result = await install(h, ['--version', '0.2.1'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), original)
  await assert.rejects(access(join(h, '.test-service-running')))
  assert.doesNotMatch(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /restart abele-node.service current=0.2.0/
  )
})
test('failed Linux start undoes enablement and unit write without stopping an unstarted service', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  await writeFile(join(h, 'fail-start-before-mutation'), 'start refused')
  const result = await install(h, ['--version', '0.2.0'], env)
  assert.notEqual(result.code, 0)
  const log = await readFile(join(h, 'systemctl.log'), 'utf8')
  assert.match(log, /disable abele-node.service/)
  assert.doesNotMatch(log, /stop abele-node|restart abele-node/)
  await assert.rejects(access(join(h, '.test-service-enabled')))
  await assert.rejects(access(join(h, '.config/systemd/user/abele-node.service')))
})
test('systemd drop-ins and foreign loaded fragments are refused before any stop or rewrite', async () => {
  for (const kind of ['local-dropin', 'loaded-dropin', 'foreign-fragment']) {
    const h = await home(),
      env = await mockedLinuxService(h),
      unit = join(h, '.config/systemd/user/abele-node.service')
    assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
    const original = await readFile(unit, 'utf8'),
      marker = await readFile(join(h, '.test-service-running'), 'utf8')
    if (kind === 'local-dropin') {
      await mkdir(unit + '.d')
      await writeFile(
        join(unit + '.d', 'override.conf'),
        '[Service]\\nExecStart=\\nExecStart=/foreign/runtime --state-dir /foreign/state\\n'
      )
    } else if (kind === 'loaded-dropin') {
      await writeFile(
        join(h, 'simulate-loaded-dropins'),
        '/runtime/abele-node.service.d/override.conf'
      )
    } else {
      await writeFile(join(h, 'simulate-fragment'), '/foreign/abele-node.service')
    }
    for (const args of [['--version', '0.2.3'], ['--uninstall']]) {
      await writeFile(join(h, 'systemctl.log'), '')
      const result = await install(h, args, env)
      assert.notEqual(result.code, 0, result.stderr)
      assert.match(result.stderr, /drop-in|fragment|ownership/i)
      assert.equal(await readFile(unit, 'utf8'), original)
      assert.equal(await readFile(join(h, '.test-service-running'), 'utf8'), marker)
      assert.doesNotMatch(
        await readFile(join(h, 'systemctl.log'), 'utf8'),
        /stop abele-node|disable abele-node|enable --now/
      )
    }
  }
})
test('unloaded type and prefix drop-ins in user search paths are refused before the first stop or reload', async () => {
  const locations = [
    'config-type',
    'config-prefix',
    'data-type',
    'runtime-prefix',
    'xdg-config',
    'xdg-data',
    'config-dirs',
    'data-dirs',
    'systemd-unit-path',
    'manager-only',
  ]
  for (const location of locations) {
    const h = await home(),
      env = await mockedLinuxService(h),
      unit = join(h, '.config/systemd/user/abele-node.service')
    assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
    let root = join(h, '.config/systemd/user'),
      drop = 'service.d'
    if (location === 'config-prefix') drop = 'abele-.service.d'
    if (location === 'data-type') root = join(h, '.local/share/systemd/user')
    if (location === 'runtime-prefix') {
      env.XDG_RUNTIME_DIR = join(h, 'runtime')
      root = join(env.XDG_RUNTIME_DIR, 'systemd/user')
      drop = 'abele-.service.d'
    }
    if (location === 'xdg-config') {
      env.XDG_CONFIG_HOME = join(h, 'xdg-config')
      root = join(env.XDG_CONFIG_HOME, 'systemd/user')
    }
    if (location === 'xdg-data') {
      env.XDG_DATA_HOME = join(h, 'xdg-data')
      root = join(env.XDG_DATA_HOME, 'systemd/user')
      drop = 'abele-.service.d'
    }
    if (location === 'config-dirs') {
      env.XDG_CONFIG_DIRS = join(h, 'config-one') + ':' + join(h, 'config-two')
      root = join(h, 'config-two/systemd/user')
    }
    if (location === 'data-dirs') {
      env.XDG_DATA_DIRS = join(h, 'share-one') + ':' + join(h, 'share-two')
      root = join(h, 'share-two/systemd/user')
      drop = 'abele-.service.d'
    }
    if (location === 'systemd-unit-path') {
      root = join(h, 'custom unit path')
      env.SYSTEMD_UNIT_PATH = root
    }
    if (location === 'manager-only') {
      root = join(h, 'manager-only path with spaces')
      await writeFile(
        join(h, 'manager-unit-paths.json'),
        JSON.stringify([join(h, '.config/systemd/user'), root])
      )
      drop = 'abele-.service.d'
    }
    await mkdir(join(root, drop), { recursive: true })
    const override = join(root, drop, '10-environment.conf')
    await writeFile(override, '[Service]\\nEnvironment=ABELE_OVERRIDE=yes\\n')
    await writeFile(join(h, 'unloaded-override'), override)
    const original = await readFile(unit, 'utf8'),
      running = await readFile(join(h, '.test-service-running'), 'utf8')
    for (const args of [['--version', '0.2.3'], ['--uninstall']]) {
      await writeFile(join(h, 'systemctl.log'), '')
      const result = await install(h, args, env)
      assert.notEqual(result.code, 0, result.stderr)
      assert.match(result.stderr, /drop-in/i)
      assert.doesNotMatch(
        await readFile(join(h, 'systemctl.log'), 'utf8'),
        /stop abele-node|daemon-reload|disable abele-node|enable --now/
      )
      assert.equal(await readFile(unit, 'utf8'), original)
      assert.equal(await readFile(join(h, '.test-service-running'), 'utf8'), running)
      assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
    }
  }
})
test('generic systemd drop-ins never participate in foreground install, upgrade, uninstall or purge', async () => {
  for (const action of ['install', 'upgrade', 'failed-upgrade', 'uninstall', 'purge']) {
    const h = await home(),
      env = await mockedLinuxService(h)
    if (action !== 'install')
      assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
    const directory = join(h, '.config/systemd/user/service.d')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, '10-defaults.conf'),
      '[Service]\\nEnvironment=USER_DEFAULT=yes\\n'
    )
    const state = join(h, '.local/state/abele-node')
    const args =
      action === 'install' || action === 'upgrade' || action === 'failed-upgrade'
        ? [
            '--version',
            action === 'failed-upgrade' ? '0.2.1' : action === 'upgrade' ? '0.2.3' : '0.2.0',
            '--no-service',
          ]
        : ['--uninstall', '--no-service']
    if (action === 'purge') args.push('--purge-state', '--confirm-purge-state', state)
    const result = await install(h, args, env)
    if (action === 'failed-upgrade') {
      assert.notEqual(result.code, 0)
      assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
    } else assert.equal(result.code, 0, result.stderr)
    await assert.rejects(access(join(h, 'systemctl.log')))
    await assert.rejects(access(join(h, 'busctl.log')))
    await assert.rejects(access(join(h, '.config/systemd/user/abele-node.service')))
    assert.equal(
      await readFile(join(directory, '10-defaults.conf'), 'utf8'),
      '[Service]\\nEnvironment=USER_DEFAULT=yes\\n'
    )
    if (action === 'install' || action === 'upgrade')
      assert.equal(
        JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8')).service,
        0
      )
    if (action === 'purge') await assert.rejects(access(state))
  }
})
test('rollback explicitly restarts the restored unit after a timer reactivates the rejected version', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    root = join(h, '.local/share/abele-node'),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const previous = await readFile(unit, 'utf8'),
    config = await readFile(join(root, 'config.json'), 'utf8')
  await writeFile(join(h, 'reactivate-rejected-version'), 'timer races with restoration')
  const result = await install(h, ['--version', '0.2.1'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), previous)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.0'
  )
  const log = await readFile(join(h, 'systemctl.log'), 'utf8')
  assert.match(log, /timer-activation version=0.2.1/)
  assert.match(log, /restart abele-node.service current=0.2.0/)
  assert.doesNotMatch(
    result.stderr,
    /Automatic service rollback failed|previous runtime could not be verified/
  )
})
test('alias overrides discovered by reload cannot veto restoring and restarting the previous service', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service'),
    root = join(h, '.local/share/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8'),
    mode = (await stat(unit)).mode & 0o777,
    config = await readFile(join(root, 'config.json'), 'utf8')
  const alias = join(h, '.config/systemd/user/worker.service'),
    directory = alias + '.d',
    override = join(directory, '10-override.conf')
  await symlink('abele-node.service', alias)
  await mkdir(directory)
  await writeFile(override, '[Service]\\nEnvironment=ALIAS_OVERRIDE=yes\\n')
  await writeFile(join(h, 'unloaded-override'), override)
  await writeFile(join(h, 'systemctl.log'), '')
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal((await stat(unit)).mode & 0o777, mode)
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), config)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  const running = JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8'))
  assert.equal(running.runtime.version, '0.2.0')
  assert.match(result.stderr, /restarting previous.*overrides/i)
  assert.doesNotMatch(result.stderr, /Automatic service rollback failed/)
  const recoveryLog = await readFile(join(h, 'systemctl.log'), 'utf8')
  assert.match(recoveryLog, /enable abele-node.service current=0.2.0/)
  assert.match(recoveryLog, /restart abele-node.service current=0.2.0/)
  assert.equal(await readlink(alias), 'abele-node.service')
  assert.equal(await readFile(override, 'utf8'), '[Service]\\nEnvironment=ALIAS_OVERRIDE=yes\\n')
})
test('rollback still starts the restored unit when user overrides select an unverifiable runtime', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service'),
    root = join(h, '.local/share/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8')
  const alias = join(h, '.config/systemd/user/worker.service'),
    override = join(alias + '.d', '10-exec.conf')
  await symlink('abele-node.service', alias)
  await mkdir(alias + '.d')
  await writeFile(override, '[Service]\\nExecStart=\\nExecStart=/user-selected/runtime\\n')
  await writeFile(join(h, 'unloaded-override'), override)
  await writeFile(
    join(h, 'override-exec-runtime'),
    join(root, '0.2.3/packages/node-daemon/dist/cli.js')
  )
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.3'
  )
  assert.match(result.stderr, /restarting previous.*overrides/i)
  assert.match(result.stderr, /Previous unit was restored and restart was attempted/)
  assert.match(result.stderr, /Previous service backup retained/)
  const recoveryLog = await readFile(join(h, 'systemctl.log'), 'utf8')
  assert.match(recoveryLog, /enable abele-node.service current=0.2.0/)
  assert.match(recoveryLog, /restart abele-node.service current=0.2.0/)
})
test('unconfirmed new-service stop cannot veto restoring the old unit and attempting its restart', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service'),
    root = join(h, '.local/share/abele-node')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const original = await readFile(unit, 'utf8')
  await writeFile(
    join(h, 'override-after-doctor'),
    '/user/alias.service.d/changed-stop-policy.conf'
  )
  await writeFile(join(h, 'fail-stop-on-override'), 'stop refused after reload')
  const result = await install(h, ['--version', '0.2.1'], env)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(unit, 'utf8'), original)
  assert.equal(await readlink(join(root, 'current')), '0.2.0')
  assert.match(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /restart abele-node.service current=0.2.0/
  )
  assert.match(result.stderr, /stop.*unconfirmed|could not be confirmed/i)
  assert.equal(
    JSON.parse(await readFile(join(h, '.test-service-running'), 'utf8')).runtime.version,
    '0.2.0'
  )
})
test('drop-in discovery is repeated after download and before stopping a foreground conversion', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    directory = join(h, '.config/systemd/user/service.d')
  assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
  await writeFile(join(h, 'dropin-on-preflight.json'), JSON.stringify({ directory }))
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0, result.stderr)
  await assert.rejects(access(join(h, 'cli-stop.log')))
  assert.doesNotMatch(
    await readFile(join(h, 'systemctl.log'), 'utf8'),
    /stop abele-node|daemon-reload|disable abele-node|enable --now/
  )
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
})
test('a failed unit write cannot publish the upgrade or start the stale unit', async () => {
  const h = await home(),
    env = await mockedLinuxService(h),
    unit = join(h, '.config/systemd/user/abele-node.service')
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  const previous = await readFile(unit, 'utf8')
  await chmod(unit, 0o400)
  await writeFile(join(h, 'systemctl.log'), '')
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0, result.stderr)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
  assert.equal(
    JSON.parse(await readFile(join(h, '.local/share/abele-node/config.json'), 'utf8')).version,
    '0.2.0'
  )
  assert.equal(await readFile(unit, 'utf8'), previous)
  const log = await readFile(join(h, 'systemctl.log'), 'utf8')
  assert.doesNotMatch(log, /enable --now abele-node.service current=0.2.3/)
  await access(join(h, '.test-service-running'))
})
test('health checks reject a live daemon from the wrong runtime despite running=true', async () => {
  const h = await home(),
    env = await mockedLinuxService(h)
  assert.equal((await install(h, ['--version', '0.2.0'], env)).code, 0)
  await writeFile(join(h, 'simulate-wrong-runtime'), 'start the old CLI instead')
  const result = await install(h, ['--version', '0.2.3'], env)
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, /health checks/)
  assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
})
test(
  'Linux service install, upgrade rollback and uninstall use the managed unit only',
  { skip: process.platform !== 'linux' },
  async () => {
    const h = await home(),
      bin = join(h, 'mocks'),
      state = join(h, 'state $ % space')
    await mkdir(bin)
    await writeFile(
      join(bin, 'systemctl'),
      `#!/bin/sh
printf '%s current=%s\\n' "$*" "$(readlink "$HOME/.local/share/abele-node/current" 2>/dev/null)" >> "$HOME/systemctl.log"
case "$*" in
  '--user show abele-node.service --property=FragmentPath --value')
    if [ -f "$HOME/.config/systemd/user/abele-node.service" ]; then printf '%s\\n' "$HOME/.config/systemd/user/abele-node.service"; fi ;;
  '--user show abele-node.service --property=DropInPaths --value') : ;;
  '--user show abele-node.service --property=MainPID --value')
    if [ -f "$HOME/.test-service-running" ]; then echo 1337; else echo 0; fi ;;
  '--user show abele-node.service --property=ActiveState --value')
    if [ -f "$HOME/.test-service-running" ]; then echo active; else echo inactive; fi ;;
  '--user enable abele-node.service') : > "$HOME/.test-service-enabled" ;;
  '--user enable --now abele-node.service'|'--user start abele-node.service'|'--user restart abele-node.service')
    if { [ "$*" = '--user enable --now abele-node.service' ] || [ "$*" = '--user start abele-node.service' ]; } && [ -f "$HOME/.test-service-running" ]; then exit 0; fi
    [ -d '${state}' ] || exit 9
    if [ -f "$HOME/fail-rollback" ]; then
      rm -f "$HOME/.test-service-running"
      [ "$(readlink "$HOME/.local/share/abele-node/current")" = 0.2.0 ] || exit 9
    else : > "$HOME/.test-service-running"; fi ;;
  '--user stop abele-node.service') rm -f "$HOME/.test-service-running" ;;
esac
`,
      { mode: 0o755 }
    )
    await writeFile(
      join(bin, 'busctl'),
      `#!${process.execPath}
console.log(JSON.stringify({type:'as',data:[process.env.HOME+'/.config/systemd/user',process.env.HOME+'/.local/share/systemd/user']}));
`,
      { mode: 0o755 }
    )
    const env = { PATH: `${bin}:${process.env.PATH}` }
    const first = await install(h, ['--version', '0.2.0', '--state-dir', state], env)
    assert.equal(first.code, 0, first.stderr)
    const unit = join(h, '.config/systemd/user/abele-node.service')
    const text = await readFile(unit, 'utf8')
    assert.ok(text.includes(`WorkingDirectory="${state.replaceAll('%', '%%')}"`))
    assert.ok(text.includes('/0.2.0/packages/node-daemon/dist/cli.js'))
    assert.ok(
      text.includes(`"--state-dir" "${state.replaceAll('%', '%%').replaceAll('$', () => '$$')}"`)
    )
    const failed = await install(h, ['--version', '0.2.1'], env)
    assert.notEqual(failed.code, 0)
    assert.match(failed.stderr, /rolling back/i)
    assert.equal(await readlink(join(h, '.local/share/abele-node/current')), '0.2.0')
    assert.ok((await readFile(unit, 'utf8')).includes('/0.2.0/packages/node-daemon/dist/cli.js'))
    await access(join(h, '.test-service-running'))
    const log = await readFile(join(h, 'systemctl.log'), 'utf8')
    assert.match(log, /stop abele-node.service current=0.2.0/)
    assert.match(log, /start abele-node.service current=0.2.1/)
    await writeFile(join(h, 'fail-rollback'), 'simulate a restored service that cannot start')
    const failedRollback = await install(h, ['--version', '0.2.3'], env)
    assert.notEqual(failedRollback.code, 0)
    assert.match(failedRollback.stderr, /Automatic service rollback failed/)
    assert.equal((await install(h, ['--uninstall'], env)).code, 0)
    await assert.rejects(access(unit))
    await assert.rejects(access(join(h, '.test-service-running')))
  }
)
test(
  'real production tarball installs and runs status/doctor in a throwaway HOME',
  { skip: !process.env.ABELE_INSTALLER_TARBALL },
  async () => {
    const tarball = resolve(process.env.ABELE_INSTALLER_TARBALL)
    const listing = await run('tar', ['-tzf', tarball])
    assert.equal(listing.code, 0, listing.stderr)
    assert.ok(
      listing.stdout.split('\n').includes('./install.sh'),
      'release must bundle the offline service installer'
    )
    assert.ok(
      listing.stdout.split('\n').includes('./service-transition.mjs'),
      'release must bundle service crash recovery'
    )
    const forbidden =
      /\.(map|tsbuildinfo)$|\/(test\.[^/]+|[^/]+\.(test|spec|tst)[.-][^/]+)$|\/(test|tests|__tests__|spec|probes)\/|\/node_modules\/(typescript|vitest|vite|prettier)\/|\.\/packages\/[^/]+\/src\//
    assert.deepEqual(
      listing.stdout.split('\n').filter((entry) => forbidden.test(entry)),
      []
    )
    const bytes = await readFile(tarball)
    const realVersion = basename(process.env.ABELE_INSTALLER_TARBALL).match(
      /^abele-node-(\d+\.\d+\.\d+)-/
    )[1]
    const name = `abele-node-${realVersion}-${platform}.tar.gz`
    routes.set(`/releases/download/v${realVersion}/${name}`, bytes)
    routes.set(
      `/releases/download/v${realVersion}/SHA256SUMS`,
      `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`
    )
    try {
      const h = await home()
      // Keep production doctor coverage independent of providers installed on the host.
      const missingCodex = join(h, 'missing-codex')
      const result = await install(h, ['--version', realVersion, '--no-service'], {
        ABELE_CODEX_PATH: missingCodex,
      })
      assert.equal(result.code, 0, result.stderr)
      for (const command of ['status', 'doctor']) {
        const check = await run(join(h, '.local/bin/abele-node'), [command, '--json'], {
          HOME: h,
          ABELE_CLAUDE_PATH: '/nonexistent/claude',
          ABELE_CODEX_PATH: missingCodex,
          ABELE_TAILSCALE_PATH: '/nonexistent/tailscale',
        })
        assert.equal(check.code, 0, check.stderr)
        const report = JSON.parse(check.stdout)
        assert.equal(report.running, false)
        if (command === 'doctor') assert.equal(report.codex.available, false)
        assert.equal(report.state_dir, join(await realpath(h), '.local/state/abele-node'))
      }
      const serviceStatus = await run(
        join(h, '.local/bin/abele-node'),
        ['service', 'status', '--json'],
        { HOME: h }
      )
      assert.equal(serviceStatus.code, 0, serviceStatus.stderr)
      assert.deepEqual(JSON.parse(serviceStatus.stdout), {
        mode: 'foreground',
        managed: true,
        enabled: false,
        running: false,
        ownership: 'none',
        service_file: null,
        state_dir: join(await realpath(h), '.local/state/abele-node'),
        paired_listener: null,
        // Service status reports the saved installer choice, even in foreground mode.
        debugger_enabled: false,
      })
      const help = await run(join(h, '.local/bin/abele-node'), ['service', '--help'], { HOME: h })
      assert.equal(help.code, 0, help.stderr)
      assert.match(help.stdout, /service enable/)
      const background = await run(join(h, '.local/bin/abele-node'), ['start', '--background'], {
        HOME: h,
      })
      assert.notEqual(background.code, 0)
      assert.match(background.stderr, /Unknown option: --background/)
      const updateCheck = await run(
        join(h, '.local/bin/abele-node'),
        ['update', '--check', '--json'],
        {
          HOME: h,
          ABELE_INSTALL_API_URL: `${base}/latest`,
          ABELE_INSTALL_BASE_URL: base,
          ABELE_CLAUDE_PATH: '/nonexistent/claude',
          ABELE_TAILSCALE_PATH: '/nonexistent/tailscale',
        }
      )
      assert.equal(updateCheck.code, 0, updateCheck.stderr)
      const updateReport = JSON.parse(updateCheck.stdout)
      assert.equal(updateReport.current, realVersion)
      assert.equal(updateReport.target, '0.2.0')
      assert.equal(updateReport.target_kind, 'latest')
      assert.equal(updateReport.status, 'checked')
      await assert.rejects(access(join(h, '.local/state/abele-node/update.lock')))
    } finally {
      if (realVersion === '0.2.0') {
        const bytes = await readFile(archive)
        routes.set(`/releases/download/v0.2.0/${name}`, bytes)
        routes.set(
          '/releases/download/v0.2.0/SHA256SUMS',
          `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`
        )
      }
    }
  }
)

async function pairedConfigFile(h, endpoint = 'wss://node.example.ts.net:8444/channel') {
  const directory = join(h, 'remote'),
    file = join(directory, 'paired.json')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await writeFile(file, JSON.stringify({ endpoint, origins: ['app://obsidian.md'] }), {
    mode: 0o600,
  })
  await chmod(file, 0o600)
  return realpath(file)
}
for (const platform of ['mac', 'linux']) {
  test(`service enable records, keeps and removes a paired configuration: ${platform}`, async () => {
    const h = await home(),
      env = await (platform === 'mac' ? mockedMacService(h) : mockedLinuxService(h))
    assert.equal((await install(h, ['--version', '0.2.0', '--no-service'], env)).code, 0)
    const configFile = join(h, '.local/share/abele-node/config.json'),
      file = await pairedConfigFile(h)
    const offline = {
      ...env,
      ABELE_INSTALL_BASE_URL: 'http://127.0.0.1:1',
      ABELE_INSTALL_API_URL: 'http://127.0.0.1:1',
    }
    const recorded = async () => {
      const config = JSON.parse(await readFile(configFile, 'utf8'))
      const text = await readFile(config.service_file, 'utf8')
      assert.equal(config.service_sha256, createHash('sha256').update(text).digest('hex'))
      return { config, text }
    }
    const enable = await install(
      h,
      ['--service-action', 'enable', '--paired-config', file],
      offline
    )
    assert.equal(enable.code, 0, enable.stderr)
    let { config, text } = await recorded()
    assert.equal(config.paired_config, file)
    assert.ok(
      platform === 'mac'
        ? text.includes('<string>--paired-config</string><string>' + file + '</string>')
        : text.includes('"--paired-config" "' + file + '"'),
      text
    )
    // A running service is restarted onto the new command line, not left as it was.
    const job =
      platform === 'mac' ? JSON.parse(await readFile(join(h, '.fake-launch-job'), 'utf8')) : null
    if (job) assert.deepEqual(job.arguments.slice(-2), ['--paired-config', file])
    // Plain enable and upgrade keep the recorded configuration.
    assert.equal((await install(h, ['--service-action', 'enable'], offline)).code, 0)
    assert.equal((await recorded()).text, text)
    const upgrade = await install(h, ['--version', '0.2.3'], env)
    assert.equal(upgrade.code, 0, upgrade.stderr)
    ;({ config, text } = await recorded())
    assert.equal(config.paired_config, file)
    assert.equal(config.version, '0.2.3')
    assert.ok(text.includes(file))
    // Refusals change neither the record nor the service file.
    const before = await readFile(configFile, 'utf8')
    await chmod(file, 0o644)
    const loose = await install(h, ['--service-action', 'enable', '--paired-config', file], offline)
    assert.notEqual(loose.code, 0)
    assert.match(loose.stderr, /chmod 600/)
    await chmod(file, 0o600)
    const other = await pairedConfigFile(join(h, 'remote'), 'wss://example.com:8444/channel')
    const invalid = await install(
      h,
      ['--service-action', 'enable', '--paired-config', other],
      offline
    )
    assert.notEqual(invalid.code, 0)
    assert.match(invalid.stderr, /refused by the installed runtime/)
    const alias = join(h, 'paired-link.json')
    await symlink(file, alias)
    const linked = await install(
      h,
      ['--service-action', 'enable', '--paired-config', alias],
      offline
    )
    assert.notEqual(linked.code, 0)
    assert.match(linked.stderr, /symlink/)
    for (const args of [
      ['--service-action', 'disable', '--no-paired-config'],
      ['--uninstall', '--paired-config', file],
      ['--paired-config', file, '--no-paired-config'],
    ])
      assert.notEqual((await install(h, args, offline)).code, 0, args.join(' '))
    assert.equal(await readFile(configFile, 'utf8'), before)
    assert.equal((await recorded()).text, text)
    // Removal rewrites the service without it.
    const removal = await install(h, ['--service-action', 'enable', '--no-paired-config'], offline)
    assert.equal(removal.code, 0, removal.stderr)
    ;({ config, text } = await recorded())
    assert.equal(config.paired_config, '')
    assert.doesNotMatch(text, /--paired-config/)
  })
}
test('an installation records a paired configuration given at install time and refuses an unusable recorded one on upgrade', async () => {
  const h = await home(),
    file = await pairedConfigFile(h)
  const first = await install(h, ['--version', '0.2.0', '--no-service', '--paired-config', file])
  assert.equal(first.code, 0, first.stderr)
  const configFile = join(h, '.local/share/abele-node/config.json')
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).paired_config, file)
  await chmod(join(h, 'remote'), 0o777)
  const upgrade = await install(h, ['--version', '0.2.3', '--no-service'])
  await chmod(join(h, 'remote'), 0o700)
  assert.notEqual(upgrade.code, 0)
  assert.match(upgrade.stderr, /chmod go-w[\s\S]*--no-paired-config/)
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).version, '0.2.0')
  const removed = await install(h, ['--version', '0.2.3', '--no-service', '--no-paired-config'])
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).paired_config, '')
})
