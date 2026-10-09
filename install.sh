#!/bin/sh
# Native, per-user installer. Read before running; never run with sudo.
# Parse the complete function before executing anything from a curl | sh stream.
abele_install() {
set -eu
umask 077
fail() { printf 'abele-node: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sh install.sh [--version X.Y.Z] [--prefix PATH] [--state-dir PATH]' \
    '  [--claude-path PATH] [--no-service] [--uninstall]' \
    '  [--purge-state --confirm-purge-state ABSOLUTE_STATE_PATH]' \
    'Default prefix: ~/.local; Node 22.23.2 must already be installed.'
}
version='' prefix=${HOME:?HOME must be set}/.local state='' claude='' no_service=0 uninstall=0 purge=0 confirmation=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--prefix|--state-dir|--claude-path|--confirm-purge-state)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then fail "$1 requires a value"; fi
      case "$2" in --*) fail "$1 requires a value" ;; esac
      case "$1" in
        --version) version=${2#v} ;; --prefix) prefix=$2 ;; --state-dir) state=$2 ;;
        --claude-path) claude=$2 ;; --confirm-purge-state) confirmation=$2 ;;
      esac
      shift 2 ;;
    --no-service) no_service=1; shift ;; --uninstall) uninstall=1; shift ;;
    --purge-state) purge=1; shift ;; --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ "$purge" = 0 ] || [ "$uninstall" = 1 ] || fail '--purge-state requires --uninstall'
[ -z "$confirmation" ] || [ "$purge" = 1 ] || fail '--confirm-purge-state requires --purge-state'
[ "$(id -u)" != 0 ] || fail 'Refusing root. Run as your ordinary user, without sudo.'
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'Unsupported OS: use macOS or Linux.' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Unsupported architecture: use arm64 or x64.' ;; esac
node_fix='Install Node.js 22.23.2 yourself, then retry: nvm install 22.23.2 && nvm use 22.23.2 (https://nodejs.org/en/download). The installer does not install Node.'
command -v node >/dev/null 2>&1 || fail "$node_fix"
node=$(command -v node)
"$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22 || minor<23) process.exit(1); const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.close()' >/dev/null 2>&1 || fail "$node_fix"
# Resolve the executable now: services do not read shell startup files.
node=$("$node" -p 'process.execPath')
for tool in curl tar mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool; install it with your OS package manager."; done
if command -v shasum >/dev/null 2>&1; then checksum=shasum
elif command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
else fail 'Install shasum (Perl) or sha256sum (coreutils).'; fi
[ -x /usr/bin/git ] || fail 'Git >=2.31 required at /usr/bin/git. macOS: xcode-select --install; Debian/Ubuntu: sudo apt-get install git procps'
git_version=$(/usr/bin/git --version)
"$node" -e 'const m=process.argv[1].match(/git version (\d+)\.(\d+)/); if(!m || +m[1]<2 || (+m[1]===2 && +m[2]<31)) process.exit(1)' "$git_version" || fail 'Git >=2.31 required at /usr/bin/git. Upgrade your OS Git package.'
valid_version() { "$node" -e 'if(!/^\d+\.\d+\.\d+$/.test(process.argv[1]))process.exit(1)' "$1"; }
[ -z "$version" ] || valid_version "$version" || fail 'Invalid version; expected X.Y.Z.'
physical_path() {
  "$node" - "$1" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
let current=path.resolve(process.argv[2]); const missing=[];
for (;;) {
  try { console.log(path.join(fs.realpathSync(current), ...missing)); break; }
  catch (error) {
    if(error.code!=='ENOENT')throw error;
    // A dangling symlink is not a missing directory: never follow it later.
    try { fs.lstatSync(current); throw new Error('dangling_symlink'); }
    catch (e) { if(e.code!=='ENOENT')throw e; }
    missing.unshift(path.basename(current)); current=path.dirname(current);
  }
}
NODE
}
# Existing directories are compared by device/inode, not realpath spelling:
# APFS realpath can preserve a case alias. Virtual descendants are compared
# using read-only case-sensitivity evidence; unknown directories fail closed.
path_relation() {
  "$node" - "$@" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const id=p=>{const s=fs.statSync(p,{bigint:true});return s.dev+':'+s.ino};
function describe(p){
  let ancestor=path.resolve(p); const tail=[];
  for(;;){try{ancestor=fs.realpathSync(ancestor);break}catch(e){
    if(e.code!=='ENOENT')throw e;
    try{fs.lstatSync(ancestor);throw new Error('dangling_symlink')}catch(s){if(s.code!=='ENOENT')throw s}
    tail.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);
  }}
  const chain=[]; let current=ancestor, relative=[];
  for(;;){chain.push({id:id(current),relative:[...relative]});const parent=path.dirname(current);
    if(parent===current)break;relative.unshift(path.basename(current));current=parent;
  }
  return {ancestor,tail,id:id(ancestor),chain};
}
function caseSensitive(dir){
  let names;try{names=fs.readdirSync(dir)}catch{return undefined}
  for(const name of names){
    const alternate=name.replace(/[a-zA-Z]/g,c=>c===c.toLowerCase()?c.toUpperCase():c.toLowerCase());
    if(alternate===name)continue;
    try{const original=id(path.join(dir,name));
      try{return id(path.join(dir,alternate))!==original}catch(e){if(e.code==='ENOENT')return true;throw e}
    }catch(e){if(e.code!=='ENOENT')return undefined}
  }
  return undefined;
}
const fold=s=>s.toUpperCase().normalize('NFD');
function contains(parent,child){
  if(!parent.tail.length)return child.chain.some(entry=>entry.id===parent.id);
  const common=child.chain.find(entry=>entry.id===parent.id);if(!common)return false;
  const parts=[...common.relative,...child.tail];if(parts.length<parent.tail.length)return false;
  let dir=parent.ancestor, sensitive=caseSensitive(dir);
  for(let i=0;i<parent.tail.length;i++){
    if(sensitive===true?parent.tail[i]!==parts[i]:fold(parent.tail[i])!==fold(parts[i]))return false;
    dir=path.join(dir,parent.tail[i]);
    try{if(fs.statSync(dir).isDirectory())sensitive=caseSensitive(dir)}catch(e){if(e.code!=='ENOENT')sensitive=undefined}
  }
  return true;
}
const [op,...args]=process.argv.slice(2), values=args.map(describe);
let result;
if(op==='contains')result=contains(values[0],values[1]);
else if(op==='same')result=values[0].id===values[1].id && JSON.stringify(values[0].tail)===JSON.stringify(values[1].tail);
else if(op==='overlaps'){const [r,s,b]=values;result=contains(r,s)||contains(s,r)||contains(b,s)||contains(s,b)}
else throw new Error('invalid_path_relation');
console.log(result);
NODE
}
physical_home=$(physical_path "$HOME") || fail 'Cannot resolve physical HOME.'
valid_path() {
  "$node" -e 'const p=process.argv[1]; if(!p.startsWith("/") || /[\x00-\x1f\x7f]/.test(p) || require("node:path").resolve(p)!==p)process.exit(1)' "$1" || return 1
  physical=$(physical_path "$1") || return 1
  relation=$(path_relation contains "$physical" "$physical_home") || return 1
  [ "$relation" = false ]
}
valid_path "$prefix" || fail 'Invalid prefix: use an absolute normalized path other than / or HOME.'
root=$prefix/share/abele-node
config=$root/config.json
get_config() { "$node" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]] ?? "")' "$config" "$1"; }
old='' old_state='' old_claude='' old_service=0
expected_state_identity=''
state_path_pinned=0
state_identity() {
  "$node" - "$1" <<'NODE'
const fs=require('node:fs');
try{const s=fs.statSync(process.argv[2],{bigint:true});if(!s.isDirectory())throw new Error('state_is_not_a_directory');console.log(s.dev+':'+s.ino)}
catch(e){if(e.code!=='ENOENT')throw e;console.log('missing')}
NODE
}
verify_state_identity() {
  if [ "$state_path_pinned" = 1 ]; then
    observed_state_path=$(physical_path "$1") || return 1
    if [ "$observed_state_path" != "$1" ]; then
      printf '%s\n' 'Pinned state path identity changed; refusing to follow a new alias.' >&2
      return 1
    fi
  fi
  observed_state_identity=$(state_identity "$1") || return 1
  if [ -z "$expected_state_identity" ]; then expected_state_identity=$observed_state_identity; fi
  if [ "$expected_state_identity" != "$observed_state_identity" ]; then
    printf '%s\n' 'Installed state identity changed or disappeared; refusing to stop or purge an unknown state.' >&2
    return 1
  fi
}
if [ -f "$config" ]; then
  [ -f "$root/.installer-owned" ] || fail 'Existing installation is not owned by this installer.'
  old=$(get_config version); valid_version "$old" || fail 'Invalid installed version in config.'
  old_state=$(get_config state); old_claude=$(get_config claude); old_service=$(get_config service)
  expected_state_identity=$(get_config state_identity)
  [ -L "$root/current" ] || fail 'Installed current pointer is missing; refusing to adopt an unknown deployment.'
  [ "$(readlink "$root/current")" = "$old" ] || fail 'Installed current pointer differs from the recorded version.'
  if [ "$old_service" = 0 ] && [ -z "$expected_state_identity" ]; then
    fail 'Recorded foreground state identity is missing; inspect the legacy installation manually before stop or purge.'
  fi
fi
if [ -z "$old" ] && { [ -e "$root/current" ] || [ -L "$root/current" ]; }; then fail 'Unrecorded current pointer; refusing to replace it.'; fi
plist=$HOME/Library/LaunchAgents/dev.abele.node.plist
unit=$HOME/.config/systemd/user/abele-node.service
service=1
[ "$no_service" = 0 ] || service=0
[ "$uninstall" = 0 ] || service=$old_service
[ "$old_service" != 1 ] || [ "$service" = 1 ] || [ "$uninstall" = 1 ] || fail 'Existing install uses a service; omit --no-service for upgrades.'
case "$old_service" in 0|1) ;; *) fail 'Invalid service ownership configuration.' ;; esac
if [ "$os" = darwin ]; then service_file=$plist; other_service_file=$unit
else service_file=$unit; other_service_file=$plist; fi
file_digest() { "$node" -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
service_state() {
  "$node" - "$service_file" "$os" <<'NODE'
const fs=require('node:fs');const [file,os]=process.argv.slice(2),text=fs.readFileSync(file,'utf8');let args;
if(os==='darwin'){
  const array=text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];if(!array)throw new Error('missing_service_arguments');
  args=[...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m=>m[1].replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
}else{
  const command=text.match(/^ExecStart=(.*)$/m)?.[1];if(!command)throw new Error('missing_service_arguments');
  args=[...command.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m=>m[1].replace(/\\([\\"])/g,'$1').replaceAll('%%','%').replaceAll('$$','$'));
}
if(args.filter(a=>a==='--state-dir').length!==1)throw new Error('ambiguous_service_state');
const state=args[args.indexOf('--state-dir')+1];if(!state?.startsWith('/') || /[\x00-\x1f\x7f]/.test(state))throw new Error('invalid_service_state');console.log(state);
NODE
}
# A runtime install is not proof of service ownership. Check before any stop/write,
# including uninstall and a foreground-to-service transition.
if [ "$old_service" = 1 ]; then
  if [ ! -f "$service_file" ] || [ -L "$service_file" ]; then fail 'Service ownership missing or modified; inspect the service before reinstalling.'; fi
  owned_file=$(get_config service_file)
  owned_digest=$(get_config service_sha256)
  actual_file=$(physical_path "$service_file") || fail 'Cannot resolve service ownership path.'
  actual_digest=$(file_digest "$service_file") || fail 'Cannot read service ownership file.'
  owned_matches=$(path_relation same "$owned_file" "$actual_file") || fail 'Cannot compare service ownership paths.'
  if [ "$owned_matches" != true ] || [ "$owned_digest" != "$actual_digest" ]; then fail 'Service ownership missing or modified; refusing to stop or overwrite it.'; fi
  service_file=$actual_file
  # The authenticated service file, not a possibly retargeted caller alias,
  # defines the state used by the loaded service.
  old_state=$(service_state) || fail 'Cannot read the installed service state.'
  canonical_old_state=$(physical_path "$old_state") || fail 'Cannot resolve installed service state.'
  [ "$old_state" = "$canonical_old_state" ] || fail 'Legacy service state is not canonical; stop it manually before migrating.'
  if [ -e "$other_service_file" ] || [ -L "$other_service_file" ]; then fail 'An unmanaged service already exists.'; fi
elif [ -e "$plist" ] || [ -L "$plist" ] || [ -e "$unit" ] || [ -L "$unit" ]; then
  fail 'An unmanaged service already exists; stop and remove it manually first.'
fi
# Check the recorded object before resolving paths or inspecting a daemon, for
# foreground deployments as well as services. Never adopt a replacement inode.
if [ -n "$old" ]; then verify_state_identity "$old_state" || fail 'Installed state identity changed; nothing was stopped or removed.'; fi
if [ -n "$old" ] && [ -n "$state" ]; then
  state_matches=$(path_relation same "$state" "$old_state") || fail 'Cannot compare installed state paths.'
  [ "$state_matches" = true ] || fail 'Changing an installed state directory is unsafe; uninstall without purging first.'
fi
if [ -n "$old" ]; then state=$old_state; fi
state=${state:-${old_state:-$HOME/.local/state/abele-node}}
discover_claude() {
  [ -z "$claude" ] || return 0
  claude=${ABELE_CLAUDE_PATH:-}
  [ -z "$claude" ] || return 0
  claude=$(command -v claude 2>/dev/null || true)
  [ -z "$claude" ] || return 0
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then claude=$candidate; return 0; fi
  done
  # Record a stable path even when Claude has not been installed yet.
  claude=$HOME/.local/bin/claude
}
# End Claude discovery
if [ "$uninstall" = 1 ]; then claude=${old_claude:-$HOME/.local/bin/claude}
else discover_claude; fi
claude=$(physical_path "$claude") || fail 'Cannot resolve claude-path.'
valid_path "$state" || fail 'Invalid state-dir: use an absolute normalized path other than / or HOME.'
valid_path "$claude" || fail 'Invalid claude-path: use an absolute normalized executable path.'
service_path=${claude%/*}:${node%/*}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
if [ "$uninstall" = 0 ]; then
  if [ ! -f "$claude" ] || [ ! -x "$claude" ]; then
    printf 'Claude not found or not executable at %s. Install continues; pi still works. Run sh install.sh --claude-path /absolute/path/to/claude later.\n' "$claude"
  elif ! PATH="$service_path" "$node" - "$claude" <<'NODE'
const {spawnSync}=require('node:child_process');
const r=spawnSync(process.argv[2],['--version'],{encoding:'utf8',timeout:5000,maxBuffer:65536});
if(r.status!==0){console.error((r.error?.message || r.stderr || 'exit '+r.status).trim());process.exit(1)}
NODE
  then
    printf 'Claude --version failed under service PATH %s. Install continues; pi still works. Fix the Claude executable/shebang, then run sh install.sh --claude-path "%s" and abele-node doctor.\n' "$service_path" "$claude"
  fi
fi
verify_state_identity "$state" || fail 'Installed state identity changed; nothing was stopped or removed.'
physical_root=$(physical_path "$root") || fail 'Cannot resolve physical installation directory.'
physical_state=$(physical_path "$state") || fail 'Cannot resolve physical state directory.'
physical_bin=$(physical_path "$prefix/bin") || fail 'Cannot resolve physical bin directory.'
overlap=$(path_relation overlaps "$physical_root" "$physical_state" "$physical_bin") || fail 'Cannot compare physical installation paths.'
[ "$overlap" = false ] || fail 'Physical state must be separate from installed versions and bin directory.'
if [ "$purge" = 1 ]; then
  valid_path "$confirmation" || fail "--purge-state requires explicit confirmation: --confirm-purge-state '$physical_state'"
  confirmed=$(path_relation same "$confirmation" "$physical_state") || fail 'Cannot compare purge confirmation.'
  [ "$confirmed" = true ] || fail "--purge-state requires explicit confirmation: --confirm-purge-state '$physical_state'"
  [ ! -L "$state" ] || fail 'Refusing to purge a symlink state directory.'
fi
state=$physical_state
state_path_pinned=1
verify_state_identity "$state" || fail 'Pinned state identity changed during validation.'
if [ -n "$old_state" ]; then old_state=$(physical_path "$old_state") || fail 'Cannot resolve previous state.'; fi
manager_unit_paths=''
check_dropins() {
  "$node" - "$manager_unit_paths" "$HOME" "$(id -u)" "${unit%/*}" <<'NODE'
const fs=require('node:fs'),path=require('node:path');const [manager,home,uid,installedRoot]=process.argv.slice(2),env=process.env;
const list=(value,fallback)=>((value || fallback).split(':').filter(Boolean));
const config=env.XDG_CONFIG_HOME || path.join(home,'.config'),data=env.XDG_DATA_HOME || path.join(home,'.local/share'),runtime=env.XDG_RUNTIME_DIR || '/run/user/'+uid;
const roots=new Set([installedRoot,path.join(config,'systemd/user'),path.join(config,'systemd/user.control'),path.join(data,'systemd/user'),
  ...['user','user.control','transient','generator.early','generator','generator.late'].map(name=>path.join(runtime,'systemd',name)),
  '/etc/systemd/user','/run/systemd/user','/usr/local/lib/systemd/user','/usr/lib/systemd/user','/lib/systemd/user',
  ...list(env.XDG_CONFIG_DIRS,'/etc/xdg').map(dir=>path.join(dir,'systemd/user')),
  ...list(env.XDG_DATA_DIRS,'/usr/local/share:/usr/share').map(dir=>path.join(dir,'systemd/user')),
  ...list(env.SYSTEMD_UNIT_PATH,'')]);
if(manager){const value=JSON.parse(manager);if(value.type!=='as' || !Array.isArray(value.data) || value.data.some(dir=>typeof dir!=='string'||!path.isAbsolute(dir)||dir.includes('\0')))throw new Error('invalid_manager_unit_paths');for(const dir of value.data)roots.add(dir)}
// systemd applies type-wide, dash-prefix and exact-unit drop-ins. Scan them
// before reload, including paths known only to the manager's environment.
for(const root of roots){
  if(!path.isAbsolute(root))throw new Error('non_absolute_unit_search_path');
  for(const name of ['service.d','abele-.service.d','abele-node.service.d']){
    const dir=path.join(root,name);
    try{if(fs.readdirSync(dir).some(entry=>entry.endsWith('.conf')))throw new Error('unmanaged systemd drop-in overrides')}
    catch(e){if(e.code!=='ENOENT')throw e;
      try{fs.lstatSync(dir);throw new Error('unreadable systemd drop-in directory')}catch(s){if(s.code!=='ENOENT')throw s}
    }
  }
}
NODE
}
check_manager_dropins() {
  command -v busctl >/dev/null 2>&1 || { printf '%s\n' 'Cannot inspect all user unit paths: install busctl (systemd tools), or use --no-service/manual deployment.' >&2; return 1; }
  manager_unit_paths=$(busctl --user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager UnitPath) || return 1
  check_dropins
}
check_effective_unit() {
  loaded_dropins=$(systemctl --user show abele-node.service --property=DropInPaths --value) || return 1
  if [ -n "$loaded_dropins" ]; then printf '%s\n' 'Unmanaged systemd drop-in overrides are loaded.' >&2; return 1; fi
  fragment=$(systemctl --user show abele-node.service --property=FragmentPath --value) || return 1
  if [ "$1" = 0 ]; then
    if [ -n "$fragment" ]; then printf '%s\n' 'Unmanaged systemd fragment is already loaded.' >&2; return 1; fi
  else
    if [ -z "$fragment" ]; then printf '%s\n' 'Cannot confirm systemd fragment ownership.' >&2; return 1; fi
    fragment_matches=$(path_relation same "$fragment" "$unit") || return 1
    if [ "$fragment_matches" != true ]; then printf '%s\n' 'Loaded systemd fragment differs from the owned unit.' >&2; return 1; fi
  fi
}
if [ "$service" = 1 ] || [ "$old_service" = 1 ]; then
  if [ "$os" = linux ]; then
    check_dropins || fail 'Unmanaged systemd drop-in overrides; refusing to stop or overwrite the service.'
    command -v systemctl >/dev/null 2>&1 || fail 'systemctl --user unavailable; use --no-service.'
    systemctl --user show-environment >/dev/null 2>&1 || fail 'No systemd user manager; use --no-service and start manually.'
    check_manager_dropins || fail 'Cannot exclude unloaded systemd drop-in overrides before stopping anything.'
    check_effective_unit "$old_service" || fail 'Cannot confirm systemd service ownership before stopping anything.'
  fi
fi
# A fresh service installation must not adopt or signal a manual daemon.
if [ "$service" = 1 ] && [ "$old_service" = 0 ]; then
  "$node" - "$state" <<'NODE' || fail 'stop_before_install: stop the non-installer/foreground daemon yourself before installing a service.'
const fs=require('node:fs'),path=require('node:path');let lock;
try{lock=JSON.parse(fs.readFileSync(path.join(process.argv[2],'daemon.lock'),'utf8'))}catch(e){if(e.code==='ENOENT')process.exit(0);throw e}
if(!Number.isSafeInteger(lock.pid)||lock.pid<1)throw new Error('unverifiable_daemon_lock');
try{process.kill(lock.pid,0);process.exit(1)}catch(e){if(e.code!=='ESRCH')throw e}
NODE
fi
work=''
backup=''
retain_backup=0
transaction=0
journal=''
journal_recording=0
journal_intent() {
  journal_action_id=''
  [ "$journal_recording" = 1 ] || return 0
  journal_action_id=$("$node" - "$journal" "$1" "$2" "${3:-}" "$state" "$backup" "$old" "$old_state" "$work" "$expected_state_identity" <<'NODE'
const fs=require('node:fs'),path=require('node:path');const [file,action,target,runtime,state,backup,previousRuntime,previousState,work,stateIdentity]=process.argv.slice(2);
const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean),entries=lines.map(JSON.parse);
const id=String(entries.filter(e=>e.phase==='intent').length+1);
const previousFile=action==='write-service'&&backup?path.join(backup,'previous-service'):action.startsWith('published-')?path.join(work,action+'.previous'):null;
const entry={phase:'intent',id,action,target,runtime,state,stateIdentity,backup:previousFile,previousRuntime,previousState,previousCurrent:previousRuntime||null};
fs.appendFileSync(file,JSON.stringify(entry)+'\n',{mode:0o600});const fd=fs.openSync(file,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
const dir=fs.openSync(path.dirname(file),fs.constants.O_RDONLY);try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)};
console.log(id);
NODE
  ) || { journal_sync; return 1; }
  transaction=1
}
journal_done() {
  [ "$journal_recording" = 1 ] || return 0
  "$node" - "$journal" "$1" <<'NODE' || return 1
const fs=require('node:fs');const [file,id]=process.argv.slice(2);
fs.appendFileSync(file,JSON.stringify({phase:'done',id})+'\n');const fd=fs.openSync(file,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
NODE
}
journal_sync() {
  if [ "$journal_recording" = 1 ] && [ -n "$journal" ] && [ -f "$journal" ]; then
    if "$node" -e 'const fs=require("node:fs"),text=fs.readFileSync(process.argv[1],"utf8"),lines=text.split("\n");let found=false;for(let i=0;i<lines.length;i++){if(!lines[i])continue;try{if(JSON.parse(lines[i]).phase==="intent")found=true}catch(e){if(i!==lines.length-1||text.endsWith("\n"))throw e}}if(!found)process.exit(1)' "$journal"; then transaction=1; fi
  fi
}
check_journal_capacity() {
  "$node" - "$journal" "$backup" "$config" "$prefix/bin/abele-node" <<'NODE'
const fs=require('node:fs'),path=require('node:path');const [journal,backup,config,wrapper]=process.argv.slice(2),budget=1024n*1024n;
const size=p=>fs.existsSync(p)?fs.statSync(p,{bigint:true}).size:0n;
const enough=(dir,bytes)=>{const s=fs.statfsSync(dir,{bigint:true});if(s.bavail*s.bsize<bytes)throw new Error('insufficient_space_for_journal_and_backups')};
// Include both publication snapshots and the service restoration candidate.
enough(path.dirname(journal),budget+size(config)*2n+size(wrapper)*2n);
if(backup)enough(backup,budget+size(path.join(backup,'previous-service'))*2n);
const reserve=path.join(path.dirname(journal),'journal.reserve');fs.writeFileSync(reserve,Buffer.alloc(Number(budget),1),{mode:0o600});
const fd=fs.openSync(reserve,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
fs.appendFileSync(journal,JSON.stringify({phase:'capacity-verified'})+'\n');const log=fs.openSync(journal,fs.constants.O_RDONLY);try{fs.fsyncSync(log)}finally{fs.closeSync(log)};
NODE
}
cli() { "$node" "$root/$1/packages/node-daemon/dist/cli.js" "$2" --state-dir "$state" --claude-path "$claude"; }
switch_to() {
  rm -f "$work/current" || return 1
  ln -s "$1" "$work/current" || return 1
  # Node rename replaces the symlink itself atomically on both macOS and Linux.
  "$node" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$work/current" "$root/current"
}
mac_manager_inspect() {
  "$node" - "$service_file" "gui/$(id -u)/dev.abele.node" "$1" <<'NODE'
const fs=require('node:fs'),cp=require('node:child_process');const [file,job,absent]=process.argv.slice(2);
const result=cp.spawnSync('/bin/launchctl',['print',job],{encoding:'utf8'});
if((result.status===3 || result.status===113) && /could not find (?:specified )?service|no such process/i.test(result.stderr || '')){if(absent==='2')console.log('0');process.exit(0)}
if(result.status!==0 || absent==='1')throw new Error('launch_agent_stop_unconfirmed');
const array=fs.readFileSync(file,'utf8').match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];if(!array)throw new Error('unknown_launch_arguments');
const expected=[...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m=>m[1].replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
const body=result.stdout.match(/\n[ \t]*arguments = \{\r?\n([\s\S]*?)\r?\n[ \t]*\}/)?.[1];if(!body)throw new Error('unknown_loaded_launch_arguments');
const lines=body.split(/\r?\n/),indent=lines[0].match(/^[ \t]+/)?.[0];
if(!indent || lines.some(line=>!line.startsWith(indent)) || JSON.stringify(lines.map(line=>line.slice(indent.length)))!==JSON.stringify(expected))throw new Error('loaded_launch_arguments_mismatch');
if(absent==='2')console.log('1');
NODE
}
confirm_linux_stopped() {
  remaining_pid=$(systemctl --user show abele-node.service --property=MainPID --value) || return 1
  remaining_state=$(systemctl --user show abele-node.service --property=ActiveState --value) || return 1
  [ "$remaining_pid" = 0 ] || return 1
  case "$remaining_state" in inactive|failed) return 0 ;; *) return 1 ;; esac
}
preflight_stop() {
  verify_state_identity "$state" || return 1
  if [ "$os" = linux ] && { [ "$service" = 1 ] || [ "$old_service" = 1 ]; }; then check_manager_dropins || return 1; fi
  if [ "$old_service" = 1 ]; then
    if [ "$os" = darwin ]; then old_mac_loaded=$(mac_manager_inspect 2) || return 1
    else
      manager_before_state=$(systemctl --user show abele-node.service --property=ActiveState --value) || return 1
      manager_pid=$(systemctl --user show abele-node.service --property=MainPID --value) || return 1
      before_stop_report=$(cli "$old" status) || return 1
      "$node" - "$before_stop_report" "$manager_pid" "$root/$old/packages/node-daemon/dist/cli.js" "$old" <<'NODE' || return 1
const fs=require('node:fs'),path=require('node:path'),[report,pid,cli,version]=process.argv.slice(2),r=JSON.parse(report);
const same=(a,b)=>{const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});return x.dev===y.dev && x.ino===y.ino};
if(!/^\d+$/.test(pid) || (pid!=='0' && (!r.running || String(r.pid)!==pid)))throw new Error('manager_pid_does_not_belong_to_recorded_state');
if(pid==='0' && r.running)throw new Error('unmanaged_running_daemon_in_service_state');
if(r.running && (!r.runtime?.cli_path || !same(r.runtime.cli_path,cli) || !same(path.dirname(r.runtime.cli_path),path.dirname(cli)) || r.runtime.version!==version))throw new Error('unowned_running_state');
NODE
    fi
  fi
}
stop_service() {
  preflight_stop || return 1
  if [ "$old_service" = 1 ] && [ "$os" = linux ]; then
    verify_state_identity "$state" || return 1
    stopped_id=''
    if [ "$manager_pid" != 0 ] || { [ "$manager_before_state" != inactive ] && [ "$manager_before_state" != failed ]; }; then
      journal_intent stopped-service "$service_file" "$old" || return 1
      stopped_id=$journal_action_id
    fi
    systemctl --user stop abele-node.service || return 1
    if [ -n "$stopped_id" ]; then journal_done "$stopped_id" || return 1; fi
    confirm_linux_stopped || return 1
  fi
  if [ -n "$old" ]; then
    verify_state_identity "$state" || return 1
    if [ "$os" = darwin ] && [ "$old_service" = 1 ] && [ "$journal_recording" = 1 ]; then
      stopped_id=''
      if [ "$old_mac_loaded" = 1 ]; then journal_intent stopped-service "$service_file" "$old" || return 1; stopped_id=$journal_action_id; fi
      cli "$old" stop > "$work/stop.json" || return 1
      if [ -n "$stopped_id" ]; then journal_done "$stopped_id" || return 1; fi
      mac_manager_inspect 1 || return 1
    else
      cli "$old" stop > "$work/stop.json" || return 1
      if [ "$os" = darwin ] && [ "$old_service" = 1 ]; then mac_manager_inspect 1 || return 1; fi
    fi
  fi
  count=0
  while [ -n "$old" ]; do
    verify_state_identity "$state" || return 1
    cli "$old" status > "$work/stopped.json" || return 1
    if "$node" -e 'if(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).running)process.exit(1)' "$work/stopped.json"; then break; fi
    count=$((count + 1)); [ "$count" -lt 45 ] || return 1; sleep 1
  done
}
prepare_state() {
  verify_state_identity "$state" || return 1
  journal_intent retained-state "$state" || return 1
  retained_state_id=$journal_action_id
  mkdir -p "$state" || return 1
  if [ "$expected_state_identity" = missing ]; then
    created_state=$(physical_path "$state") || return 1
    [ "$created_state" = "$state" ] || return 1
    expected_state_identity=$(state_identity "$state") || return 1
  fi
  verify_state_identity "$state" || return 1
  chmod 700 "$state" || return 1
  journal_done "$retained_state_id" || return 1
}
start_service() {
  runtime=$1
  prepare_state || return 1
  if [ "$os" = darwin ]; then
    # Treat install as a possibly partial write+bootstrap. The caller journals
    # both intents before calling any runtime, including legacy CLIs.
    mac_manager_inspect 1 || return 1
    journal_intent write-service "$service_file" "$runtime" || return 1
    write_id=$journal_action_id
    journal_intent started-service "$service_file" "$runtime" || return 1
    started_id=$journal_action_id
    "$node" "$root/$runtime/packages/node-daemon/dist/cli.js" install --runtime-dir "$root/$runtime" --state-dir "$state" --claude-path "$claude" > "$work/install.json" || return 1
    journal_done "$write_id" || return 1
    journal_done "$started_id" || return 1
  else
    mkdir -p "$(dirname "$unit")" || return 1
    journal_intent write-service "$service_file" "$runtime" || return 1
    write_id=$journal_action_id
    "$node" - "$unit" "$node" "$root/$runtime" "$state" "$claude" <<'NODE' || return 1
const fs=require('node:fs'),path=require('node:path'); const [unit,node,root,state,claude]=process.argv.slice(2);
if(fs.existsSync(unit))fs.accessSync(unit,fs.constants.W_OK);
const temporary=fs.mkdtempSync(path.join(path.dirname(unit),'.abele-unit-write-')),candidate=path.join(temporary,'unit');
try{
const q=(s,expand=false)=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=>expand?'$$':'$')+'"';
fs.writeFileSync(candidate, `[Unit]\nDescription=AbeleNode local coding daemon\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${q(state)}\nExecStart=${[node,root+'/packages/node-daemon/dist/cli.js','start','--state-dir',state,'--claude-path',claude].map(s=>q(s,true)).join(' ')}\nEnvironment=${q('PATH='+[path.dirname(claude),path.dirname(node),process.env.HOME+'/.local/bin','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':'))}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`, {mode:0o600});
const fd=fs.openSync(candidate,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
fs.renameSync(candidate,unit);
}finally{fs.rmSync(temporary,{recursive:true,force:true})}
NODE
    journal_done "$write_id" || return 1
    check_manager_dropins || return 1
    journal_intent reloaded-service "$service_file" "$runtime" || return 1
    reloaded_id=$journal_action_id
    systemctl --user daemon-reload || return 1
    journal_done "$reloaded_id" || return 1
    check_manager_dropins || return 1
    check_effective_unit 1 || return 1
    enabled_id=''
    if [ "$old_service" = 0 ]; then journal_intent enabled-service "$service_file" "$runtime" || return 1; enabled_id=$journal_action_id; fi
    systemctl --user enable abele-node.service || return 1
    if [ -n "$enabled_id" ]; then journal_done "$enabled_id" || return 1; fi
    journal_intent started-service "$service_file" "$runtime" || return 1
    started_id=$journal_action_id
    systemctl --user start abele-node.service || return 1
    journal_done "$started_id" || return 1
  fi
}
check_health() {
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    if cli "$1" status > "$work/status.json" && cli "$1" doctor > "$work/doctor.json" &&
      "$node" -e 'const fs=require("node:fs"),path=require("node:path"),expected=process.argv[4];const same=(a,b)=>{const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});return x.dev===y.dev && x.ino===y.ino}; for(const p of process.argv.slice(1,3)){const r=JSON.parse(fs.readFileSync(p,"utf8")); if(process.argv[3]==="1" && (!r.running || !r.runtime?.cli_path || !same(r.runtime.cli_path,expected) || !same(path.dirname(r.runtime.cli_path),path.dirname(expected)) || r.runtime.version!==process.argv[5]))process.exit(1)}' "$work/status.json" "$work/doctor.json" "$2" "$root/$1/packages/node-daemon/dist/cli.js" "$1"; then return 0; fi
    [ "$2" = 1 ] || break
    attempt=$((attempt + 1)); sleep 1
  done
  return 1
}
restore_written_service() {
  verify_state_identity "$state" || return 1
  if [ "$old_service" = 1 ]; then
    "$node" - "$backup" "$service_file" <<'NODE' || return 1
const fs=require('node:fs'),path=require('node:path');const [backup,destination]=process.argv.slice(2);
const source=path.join(backup,'previous-service'),candidate=path.join(backup,'restore-candidate');
const crypto=require('node:crypto'),digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expected=fs.statSync(source),matches=p=>fs.existsSync(p)&&digest(p)===digest(source)&&(fs.statSync(p).mode&0o777)===(expected.mode&0o777);
if(!fs.existsSync(candidate)){
  // The rename may already have succeeded before a later step failed.
  if(!matches(destination))throw new Error('missing_prestaged_service_restore_candidate');
}else{
  if(!matches(candidate)||fs.statSync(candidate).dev!==fs.statSync(path.dirname(destination)).dev)
    throw new Error('invalid_prestaged_service_restore_candidate');
  fs.renameSync(candidate,destination);
}
const fd=fs.openSync(path.dirname(destination),fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
NODE
  else rm -f "$service_file" || return 1; fi
  if [ "$os" = linux ]; then systemctl --user daemon-reload || return 1; fi
}
restart_stopped_service() {
  # Only the inverse of a journaled stop of OUR old service may restart it.
  state=$old_state; claude=$old_claude
  verify_state_identity "$state" || return 1
  restored_digest=$(file_digest "$service_file") || return 1
  [ "$restored_digest" = "$owned_digest" ] || { printf '%s\n' 'Previous service file was not restored; refusing to restart a different unit.' >&2; return 1; }
  if [ "$os" = linux ]; then
    systemctl --user daemon-reload || rollback_failed=1
    recovery_overrides=0
    if ! check_manager_dropins; then recovery_overrides=1; fi
    if ! check_effective_unit 1; then recovery_overrides=1; fi
    if [ "$recovery_overrides" = 1 ]; then
      printf '%s\n' 'Restarting previous restored unit despite user overrides or unverifiable effective configuration; overrides are unchanged. Inspect the effective service configuration.' >&2
    fi
    if ! systemctl --user enable abele-node.service; then rollback_failed=1; fi
    # A timer may have reactivated a rejected runtime. Restart, never just enable.
    systemctl --user restart abele-node.service || return 1
  else
    restore_loaded=$(mac_manager_inspect 2) || return 1
    if [ "$restore_loaded" = 1 ]; then
      /bin/launchctl kickstart -k "gui/$(id -u)/dev.abele.node" || return 1
    else
      /bin/launchctl bootstrap "gui/$(id -u)" "$plist" || return 1
      /bin/launchctl kickstart "gui/$(id -u)/dev.abele.node" || return 1
    fi
  fi
  if ! check_health "$old" 1; then
    printf '%s\n' 'Previous unit was restored and restart was attempted, but the previous runtime could not be verified. User overrides remain unchanged; inspect service status and logs.' >&2
    return 1
  fi
}
rollback() {
  printf '%s\n' 'Install failed; rolling back completed journal actions (state is retained).' >&2
  rollback_failed=0
  journal_recording=0
  # Release the physically allocated reserve so disk-full recovery has headroom.
  rm -f "$work/journal.reserve" || return 1
  verify_state_identity "$state" || return 1
  undo_actions=$("$node" -e 'const fs=require("node:fs"),text=fs.readFileSync(process.argv[1],"utf8"),lines=text.split("\n"),intents=[];for(let i=0;i<lines.length;i++){if(!lines[i])continue;try{const e=JSON.parse(lines[i]);if(e.phase==="intent")intents.push(e)}catch(e){if(i!==lines.length-1||text.endsWith("\n"))throw e}}console.log(intents.reverse().map(e=>e.action).join("\n"))' "$journal") || return 1
  for undo_action in $undo_actions; do
    case "$undo_action" in
      started-service)
        # A pending start may have done nothing. Never signal a manual daemon
        # when no matching service job exists, especially after legacy CLI refusal.
        if [ "$os" = linux ]; then
          undo_pid=$(systemctl --user show abele-node.service --property=MainPID --value) || undo_pid=unknown
          undo_state=$(systemctl --user show abele-node.service --property=ActiveState --value) || undo_state=unknown
          if [ "$undo_pid" != 0 ] || { [ "$undo_state" != inactive ] && [ "$undo_state" != failed ]; }; then
            systemctl --user stop abele-node.service >/dev/null 2>&1 || rollback_failed=1
            confirm_linux_stopped || rollback_failed=1
          fi
        else
          if undo_loaded=$(mac_manager_inspect 2); then
            if [ "$undo_loaded" = 1 ]; then
              if ! cli "$version" stop > "$work/rollback-stop.json" || ! mac_manager_inspect 1; then rollback_failed=1; fi
            fi
          else rollback_failed=1; fi
        fi
        if [ "$rollback_failed" != 0 ]; then printf '%s\n' 'New-service stop could not be confirmed; recovery will attempt only journaled inverse actions.' >&2; fi ;;
      enabled-service)
        systemctl --user disable abele-node.service || rollback_failed=1 ;;
      write-service)
        restore_written_service || rollback_failed=1 ;;
      switched-current)
        if [ -n "$old" ]; then switch_to "$old" || rollback_failed=1
        else rm -f "$root/current" || rollback_failed=1; fi ;;
      deployed-version)
        # An effective user override may refer to this immutable cached runtime.
        # Never remove code still active, unverifiable, or needed by that override.
        preserve_deployment=$rollback_failed
        if [ "$old_service" = 1 ] && [ "$os" = linux ]; then
          if referenced_dropins=$(systemctl --user show abele-node.service --property=DropInPaths --value); then
            if [ -n "$referenced_dropins" ]; then preserve_deployment=1; fi
          else preserve_deployment=1; fi
        fi
        if [ "$preserve_deployment" = 0 ]; then rm -rf "${root:?}/${version:?}" || rollback_failed=1; fi ;;
      stopped-service)
        restart_stopped_service || rollback_failed=1 ;;
      reloaded-service)
        # Cache follows the file; write-service's inverse reloads its restoration.
        : ;;
      retained-state)
        # State creation/modes are durable by design, never delete migrated data.
        : ;;
      published-wrapper|published-config)
        "$node" - "$work" "$undo_action" "$prefix/bin/abele-node" "$config" <<'NODE' || rollback_failed=1
const fs=require('node:fs'),path=require('node:path');const [work,action,wrapper,config]=process.argv.slice(2);
const target=action==='published-wrapper'?wrapper:config, backup=path.join(work,action+'.previous');
if(fs.existsSync(backup))fs.copyFileSync(backup,target);else fs.rmSync(target,{force:true});
NODE
        ;;
      *) printf 'Unknown journal action: %s\n' "$undo_action" >&2; rollback_failed=1 ;;
    esac
  done
  return "$rollback_failed"
}
cleanup() {
  result=$?
  trap - 0 HUP INT TERM
  journal_sync
  if [ "$transaction" = 1 ]; then
    if rollback; then :
    else retain_backup=1; printf '%s\n' 'Automatic service rollback failed; inspect the retained state and service logs.' >&2; fi
  fi
  if [ -n "$backup" ]; then
    if [ "$retain_backup" = 1 ]; then
      if [ -n "$journal" ] && [ -f "$journal" ]; then cp -p "$journal" "$backup/actions.jsonl" || :; fi
      printf 'Previous service backup retained: %s\n' "$backup" >&2
    else rm -rf "$backup"; fi
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
  rmdir "$root/.install-lock" 2>/dev/null || :
  exit "$result"
}
preflight_stop || fail 'Cannot confirm ownership before mutation; nothing was stopped or changed.'
[ ! -L "$root" ] || fail 'Refusing a symlink installation directory.'
[ ! -e "$root" ] || [ -f "$root/.installer-owned" ] || fail "Refusing unmanaged directory: $root"
mkdir -p "$root" "$prefix/bin"
: > "$root/.installer-owned"
mkdir "$root/.install-lock" 2>/dev/null || fail "Another install is active (lock: $root/.install-lock)."
trap cleanup 0
trap 'exit 1' HUP INT TERM
work=$(mktemp -d "$root/.download.XXXXXX") || fail 'Cannot create installer scratch directory.'
journal=$work/actions.jsonl
: > "$journal"
if [ "$old_service" = 1 ]; then
  # The backup and restore candidate must live on the service file's volume,
  # not the arbitrary runtime prefix. Keep the original until recovery succeeds.
  service_directory=$(physical_path "${service_file%/*}") || fail 'Cannot resolve service directory.'
  backup=$(mktemp -d "$service_directory/.abele-node-backup.XXXXXX") || fail 'Cannot create service backup directory.'
  cp -p "$service_file" "$backup/previous-service" || fail 'Cannot preserve previous service configuration.'
  "$node" - "$backup" <<'NODE' || fail 'Cannot pre-stage and persist previous service configuration.'
const fs=require('node:fs'),path=require('node:path'),dir=process.argv[2];
const source=path.join(dir,'previous-service'),candidate=path.join(dir,'restore-candidate');
// Allocate the *entire* restore candidate on the service's own volume before
// any stop. Recovery must only rename it, never allocate on a newly full HOME.
fs.copyFileSync(source,candidate,fs.constants.COPYFILE_EXCL);
fs.chmodSync(candidate,fs.statSync(source).mode&0o777);
for(const p of [source,candidate,dir,path.dirname(dir)]){
  const fd=fs.openSync(p,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
}
NODE
fi
if [ "$uninstall" = 1 ]; then
  preflight_stop || fail 'Cannot confirm ownership before uninstall; nothing was changed.'
  check_journal_capacity || fail 'Journal/backups are not writable or have insufficient free space; nothing was stopped.'
  journal_recording=1
  stop_service || fail 'Could not confirm daemon stop; nothing was removed.'
  verify_state_identity "$state" || fail 'Installed state identity changed after stop; nothing was removed.'
  # Explicit uninstall commits the verified stop before irreversible erasure.
  # Installation/upgrade recovery never attempts to undo a requested state purge.
  transaction=0
  journal_recording=0
  if [ "$old_service" = 1 ]; then
    if [ "$os" = linux ]; then
      verify_state_identity "$state" || fail 'Installed state identity changed; refusing service removal.'
      systemctl --user disable abele-node.service
      verify_state_identity "$state" || fail 'Installed state identity changed; refusing service removal.'
      rm -f "$unit"
      systemctl --user daemon-reload
    else
      verify_state_identity "$state" || fail 'Installed state identity changed; refusing service removal.'
      rm -f "$plist"
    fi
  fi
  # Only remove our wrapper, never a replacement installed by the user.
  if [ -f "$prefix/bin/abele-node" ] && grep -q '# abele-node installer wrapper' "$prefix/bin/abele-node"; then
    verify_state_identity "$state" || fail 'Installed state identity changed; refusing wrapper removal.'
    rm -f "$prefix/bin/abele-node"
  fi
  verify_state_identity "$state" || fail 'Installed state identity changed; refusing runtime removal.'
  rm -rf "$root"
  if [ "$purge" = 1 ]; then
    verify_state_identity "$state" || fail 'Installed state identity changed; refusing purge.'
    rm -rf "$state"
  fi
  printf '%s\n' 'AbeleNode uninstalled. State retained unless explicitly purged; provider credentials and original projects were not touched.'
  exit 0
fi
base=${ABELE_INSTALL_BASE_URL:-https://github.com/dudaanton/abele-node}
api=${ABELE_INSTALL_API_URL:-https://api.github.com/repos/dudaanton/abele-node/releases/latest}
if [ -z "$version" ]; then
  curl -fsSL --retry 3 "$api" -o "$work/latest.json" || fail 'Cannot resolve latest GitHub release; try --version X.Y.Z.'
  version=$("$node" -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).tag_name; if(typeof v!=="string")process.exit(1); console.log(v.replace(/^v/,""))' "$work/latest.json") || fail 'Invalid latest release response.'
  valid_version "$version" || fail 'Invalid release version; expected vX.Y.Z.'
fi
asset=abele-node-$version-$os-$arch.tar.gz
url=$base/releases/download/v$version
printf 'Downloading AbeleNode %s (%s-%s)...\n' "$version" "$os" "$arch"
curl -fsSL --retry 3 "$url/$asset" -o "$work/$asset" || fail "Cannot download $asset. Select a release with native installer assets."
curl -fsSL --retry 3 "$url/SHA256SUMS" -o "$work/SHA256SUMS" || fail 'Cannot download SHA256SUMS.'
expected=$("$node" -e 'const lines=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/); const matches=lines.map(l=>l.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter(m=>m&&m[2]===process.argv[2]); if(matches.length!==1)process.exit(1); console.log(matches[0][1].toLowerCase())' "$work/SHA256SUMS" "$asset") || fail 'Invalid checksum manifest.'
if [ "$checksum" = shasum ]; then actual=$(shasum -a 256 "$work/$asset"); else actual=$(sha256sum "$work/$asset"); fi
actual=${actual%% *}
[ "$expected" = "$actual" ] || fail 'SHA256 checksum mismatch; no runtime was changed.'
mkdir "$work/runtime"
tar -tzf "$work/$asset" > "$work/entries"
"$node" -e 'const entries=require("node:fs").readFileSync(process.argv[1],"utf8").split("\n"); if(entries.some(p=>p.startsWith("/")||p.split("/").includes("..")))process.exit(1)' "$work/entries" || fail 'Unsafe archive paths.'
tar -xzf "$work/$asset" -C "$work/runtime"
[ -f "$work/runtime/packages/node-daemon/dist/cli.js" ] || fail 'Archive has no built daemon.'
"$node" -e 'if(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version!==process.argv[2])process.exit(1)' "$work/runtime/package.json" "$version" || fail 'Archive version mismatch.'
# Validate imports/diagnostics before disrupting the previous service.
"$node" "$work/runtime/packages/node-daemon/dist/cli.js" status --state-dir "$state" --claude-path "$claude" > "$work/preflight.json" || fail 'Preflight status failed; previous install retained (no rollback needed).'
if [ "$service" = 0 ] || [ "$old_service" = 0 ]; then
  "$node" -e 'if(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).running)process.exit(1)' "$work/preflight.json" || fail 'stop_before_install: stop the foreground/manual daemon before installation or conversion.'
fi
preflight_stop || fail 'Cannot confirm ownership before mutation; nothing was stopped or changed.'
check_journal_capacity || fail 'Journal/backups are not writable or have insufficient free space; nothing was stopped.'
journal_recording=1
stop_service || fail 'Could not confirm old daemon stopped.'
# Never replace an existing immutable version. A repeated install can repair its service.
if [ ! -d "$root/$version" ]; then
  journal_intent deployed-version "$root/$version" "$version" || fail 'Cannot persist version deployment intent.'
  deployed_id=$journal_action_id
  mv "$work/runtime" "$root/$version"
  journal_done "$deployed_id" || fail 'Cannot mark version deployment done.'
fi
if [ "$service" = 0 ]; then prepare_state || fail 'Cannot bind the foreground state directory safely.'; fi
journal_intent switched-current "$root/current" "$version" || fail 'Cannot persist current switch intent.'
current_id=$journal_action_id
switch_to "$version"
journal_done "$current_id" || fail 'Cannot mark current switch done.'
if [ "$service" = 1 ]; then start_service "$version" || fail 'Service installation failed.'; fi
check_health "$version" "$service" || fail 'New runtime failed status/doctor health checks.'
# Publish wrapper and configuration only after validation. No secrets are generated.
verify_state_identity "$state" || fail 'Pinned state identity changed before recording installation.'
if [ "$service" = 1 ]; then
  installed_state=$(service_state) || fail 'Cannot read newly installed service state.'
  [ "$installed_state" = "$state" ] || fail 'Service state differs from the canonical installation state.'
fi
"$node" - "$work/wrapper" "$work/config.json" "$node" "$root" "$state" "$claude" "$version" "$service" "$service_file" "$expected_state_identity" <<'NODE'
const fs=require('node:fs'); const [wrapper,config,node,root,state,claude,version,service,serviceFile,expectedIdentity]=process.argv.slice(2);
const stateStat=fs.statSync(state,{bigint:true}),state_identity=stateStat.dev+':'+stateStat.ino;
if(!stateStat.isDirectory() || state_identity!==expectedIdentity || fs.realpathSync(state)!==state)throw new Error('state_identity_changed_before_publication');
const q=s=>"'"+s.replaceAll("'", "'\\''")+"'";
fs.writeFileSync(wrapper, '#!/bin/sh\n# abele-node installer wrapper\nexec '+[node,root+'/current/packages/node-daemon/dist/cli.js'].map(q).join(' ')+' "$@" --state-dir '+q(state)+' --claude-path '+q(claude)+'\n',{mode:0o755});
const ownership=service==='1'?{service_file:fs.realpathSync(serviceFile),service_sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(serviceFile)).digest('hex')}:{};
fs.writeFileSync(config,JSON.stringify({version,state,state_identity,claude,service:Number(service),...ownership})+'\n',{mode:0o600});
NODE
if [ -f "$prefix/bin/abele-node" ]; then cp -p "$prefix/bin/abele-node" "$work/published-wrapper.previous"; fi
if [ -f "$config" ]; then cp -p "$config" "$work/published-config.previous"; fi
journal_intent published-wrapper "$prefix/bin/abele-node" "$version" || fail 'Cannot persist wrapper publication intent.'
wrapper_id=$journal_action_id
mv "$work/wrapper" "$prefix/bin/abele-node"
journal_done "$wrapper_id" || fail 'Cannot mark wrapper publication done.'
journal_intent published-config "$config" "$version" || fail 'Cannot persist configuration publication intent.'
config_id=$journal_action_id
mv "$work/config.json" "$config"
journal_done "$config_id" || fail 'Cannot mark configuration publication done.'
transaction=0
journal_recording=0
case ":${PATH:-}:" in *":$prefix/bin:"*) ;; *) printf 'Add %s/bin to PATH before running abele-node.\n' "$prefix" ;; esac
printf '%s\n' 'AbeleNode installed. Next: abele-node token create desktop' \
  'This prints an installation ID and token ONCE. Store them only in device-local secret storage.' \
  'In an Abele plugin version with node enrollment, add ws://127.0.0.1:7777/channel,' \
  'the installation ID/token, and node_id from abele-node status when requested.' \
  'Never put enrollment secrets in synced settings or notes.'
[ "$service" = 1 ] || printf '%s\n' 'No service installed. Start in a terminal with: abele-node start'
}
abele_install "$@"
