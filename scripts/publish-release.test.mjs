import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

async function publish(mode) {
  const home = await mkdtemp(join(tmpdir(), 'abele-release-test-'))
  try {
    const assets = join(home, 'release'),
      bin = join(home, 'bin')
    await mkdir(assets)
    await mkdir(bin)
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      await writeFile(
        join(assets, `abele-node-0.2.0-${platform}.tar.gz`),
        `test release ${platform}`
      )
    }
    await writeFile(
      join(bin, 'sha256sum'),
      `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const args=process.argv.slice(2);
if(args[0]==='-c'){
  for(const line of fs.readFileSync(args[1],'utf8').trim().split('\\n')){
    const [sum,file]=line.split(/  /); if(hash(file)!==sum)process.exit(1);
  }
}else for(const file of args)console.log(hash(file)+'  '+file);
`,
      { mode: 0o755 }
    )
    await writeFile(
      join(bin, 'gh'),
      `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const home=process.env.HOME,mode=process.env.TEST_RELEASE_MODE,args=process.argv.slice(2);
const file=home+'/remote.json', storage=home+'/remote-assets';
fs.mkdirSync(storage,{recursive:true});
const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{exists:mode==='published',isDraft:false,assets:[],exposed_incomplete:false};
fs.appendFileSync(home+'/gh.log',JSON.stringify(args)+'\\n');
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const flag=name=>args[args.indexOf(name)+1];
switch(args[1]){
  case 'view':
    save(); if(!state.exists)process.exit(1);
    if(flag('--json')==='isDraft')console.log(state.isDraft);
    if(flag('--json')==='assets')console.log(state.assets.join('\\n'));
    break;
  case 'create':
    state.exists=true; state.isDraft=args.includes('--draft');
    state.exposed_incomplete=!state.isDraft; save(); break;
  case 'upload':
    if(mode==='upload-failure')process.exit(1);
    for(const asset of args.slice(3).filter(arg=>!arg.startsWith('--'))){
      const name=path.basename(asset); fs.copyFileSync(asset,path.join(storage,name));
      if(!state.assets.includes(name))state.assets.push(name);
    }
    save(); break;
  case 'download':
    fs.mkdirSync(flag('--dir'),{recursive:true});
    for(const name of state.assets)fs.copyFileSync(path.join(storage,name),path.join(flag('--dir'),name));
    if(mode==='corrupt-download')fs.writeFileSync(path.join(flag('--dir'),state.assets.find(name=>name.endsWith('.tar.gz'))),'corrupt');
    break;
  case 'edit':
    state.isDraft=false; if(state.assets.length!==5)state.exposed_incomplete=true; save(); break;
  default: throw new Error('unexpected gh operation '+args);
}
`,
      { mode: 0o755 }
    )
    const workflow = await readFile('.github/workflows/release.yml', 'utf8')
    // Run the actual publishing code wired into the workflow, including the old
    // inline implementation when checking a regression to premature publication.
    const command = workflow.includes('sh scripts/publish-release.sh release')
      ? ['/bin/sh', [resolve('scripts/publish-release.sh'), assets]]
      : [
          '/bin/bash',
          [
            '-c',
            workflow
              .split('run: |\n')
              .at(-1)
              .split('\n')
              .map((line) => line.slice(10))
              .join('\n'),
          ],
        ]
    const result = await new Promise((done, reject) => {
      const child = spawn(command[0], command[1], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_TAG: 'v0.2.0',
          TEST_RELEASE_MODE: mode,
        },
      })
      let stderr = ''
      child.stderr.on('data', (b) => {
        stderr += b
      })
      child.on('error', reject)
      child.on('close', (code) => done({ code, stderr }))
    })
    return {
      ...result,
      remote: JSON.parse(await readFile(join(home, 'remote.json'), 'utf8')),
      log: await readFile(join(home, 'gh.log'), 'utf8'),
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
test('release remains draft until all five assets have been downloaded and verified', async () => {
  const result = await publish('success')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.remote.exposed_incomplete, false)
  assert.equal(result.remote.isDraft, false)
  assert.equal(result.remote.assets.length, 5)
  const operations = result.log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)[1])
  assert.ok(operations.indexOf('upload') < operations.indexOf('download'))
  assert.ok(operations.indexOf('download') < operations.indexOf('edit'))
})
test('upload failure leaves the incomplete release unpublished', async () => {
  const result = await publish('upload-failure')
  assert.notEqual(result.code, 0)
  assert.equal(result.remote.isDraft, true)
  assert.equal(result.remote.exposed_incomplete, false)
  assert.doesNotMatch(result.log, /"edit"/)
})
test('a corrupted downloaded asset prevents publication', async () => {
  const result = await publish('corrupt-download')
  assert.notEqual(result.code, 0)
  assert.equal(result.remote.isDraft, true)
  assert.doesNotMatch(result.log, /"edit"/)
})
test('an already published release cannot be overwritten by a retry', async () => {
  const result = await publish('published')
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(result.log, /"upload"|"create"|"edit"/)
})
