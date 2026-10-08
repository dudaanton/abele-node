import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertPairedEndpoint } from '@abele/channel-protocol'

export const DEFAULT_TAILSCALE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
export type TailscaleRunner = (args: string[]) => Promise<string>
export function tailscaleRunner(
  executable = process.env.ABELE_TAILSCALE_PATH ?? DEFAULT_TAILSCALE_CLI
): TailscaleRunner {
  return async (args) => {
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('tailscale_command_failed')
    return result.stdout
  }
}
type Mapping = { endpoint: string; backend_port: number; state: 'pending' | 'confirmed' }
export interface ServeOwnershipStore {
  load(): Mapping | undefined
  save(mapping: Mapping | undefined): void
}
export class FileServeOwnershipStore implements ServeOwnershipStore {
  constructor(private path: string) {}
  load(): Mapping | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Mapping | null
      if (parsed === null) return undefined
      if (
        !parsed ||
        typeof parsed.endpoint !== 'string' ||
        !Number.isSafeInteger(parsed.backend_port) ||
        (parsed.state !== undefined && parsed.state !== 'pending' && parsed.state !== 'confirmed')
      )
        throw new Error('invalid_serve_ownership')
      assertPairedEndpoint(parsed.endpoint)
      // The old format cannot distinguish a successful operation from a lost/failed CLI reply.
      return { ...parsed, state: parsed.state ?? 'pending' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  save(mapping: Mapping | undefined) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.path), 0o700)
    writeFileSync(this.path, JSON.stringify(mapping ?? null), { mode: 0o600 })
    chmodSync(this.path, 0o600)
  }
}
// Serve JSON is extensible; do not write it wholesale or discard unknown configuration.
type ServeConfig = {
  TCP?: Record<string, unknown>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
  Foreground?: Record<string, ServeConfig>
}
function parts(endpoint: string, backend_port: number) {
  assertPairedEndpoint(endpoint)
  if (!Number.isSafeInteger(backend_port) || backend_port < 1 || backend_port > 65535)
    throw new Error('invalid_backend_port')
  const url = new URL(endpoint)
  return {
    port: url.port || '443',
    host: url.hostname,
    hostPort: url.host,
    proxy: `http://127.0.0.1:${backend_port}`,
  }
}
function occupied(config: ServeConfig, port: string): boolean {
  return (
    !!config.TCP?.[port] ||
    Object.entries(config.AllowFunnel ?? {}).some(
      ([h, enabled]) => enabled && (new URL('https://' + h).port || '443') === port
    ) ||
    Object.keys(config.Web ?? {}).some((h) => (new URL('https://' + h).port || '443') === port) ||
    Object.values(config.Foreground ?? {}).some((c) => occupied(c, port))
  )
}
function exactMapping(config: ServeConfig, endpoint: string, backend_port: number): boolean {
  const p = parts(endpoint, backend_port)
  return (
    JSON.stringify(config.TCP?.[p.port]) === JSON.stringify({ HTTPS: true }) &&
    JSON.stringify(config.Web?.[p.hostPort]?.Handlers) ===
      JSON.stringify({ '/': { Proxy: p.proxy } }) &&
    Object.keys(config.Web ?? {}).filter((h) => (new URL('https://' + h).port || '443') === p.port)
      .length === 1 &&
    !Object.entries(config.AllowFunnel ?? {}).some(
      ([h, enabled]) => enabled && (new URL('https://' + h).port || '443') === p.port
    ) &&
    !Object.values(config.Foreground ?? {}).some((c) => occupied(c, p.port))
  )
}
function targetsPort(value: unknown, port: number): boolean {
  if (typeof value === 'string') {
    try {
      const u = new URL(value.includes('://') ? value : 'http://' + value)
      return (
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
        Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port
      )
    } catch {
      return false
    }
  }
  return (
    !!value && typeof value === 'object' && Object.values(value).some((v) => targetsPort(v, port))
  )
}
/** Explicit operator commands only. Start/stop never change Serve, and no reset/Funnel command exists. */
export class TailscaleServeManager {
  private memory?: Mapping
  private serial: Promise<unknown> = Promise.resolve()
  constructor(
    private run: TailscaleRunner = tailscaleRunner(),
    private ownership?: ServeOwnershipStore
  ) {}
  private owned() {
    return this.ownership ? this.ownership.load() : this.memory
  }
  private save(mapping?: Mapping) {
    if (this.ownership) this.ownership.save(mapping)
    else this.memory = mapping
  }
  private async config(): Promise<ServeConfig> {
    const parsed: unknown = JSON.parse(await this.run(['serve', 'status', '--json']))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('invalid_serve_status')
    return parsed as ServeConfig
  }
  private exclusive<T>(work: () => Promise<T>) {
    const task = this.serial.then(work)
    this.serial = task.catch(() => {})
    return task
  }
  enable(endpoint: string, backend_port: number, local_port: number) {
    return this.exclusive(async () => {
      const p = parts(endpoint, backend_port),
        owned = this.owned()
      if (backend_port === local_port) throw new Error('local_token_backend_refused')
      const config = await this.config()
      if (targetsPort(config, local_port)) throw new Error('local_token_mapped')
      if (occupied(config, p.port)) {
        if (
          owned?.endpoint === endpoint &&
          owned.backend_port === backend_port &&
          owned.state === 'confirmed' &&
          exactMapping(config, endpoint, backend_port)
        )
          return
        throw new Error('serve_port_occupied')
      }
      if (p.port === '443' || p.port === '80') throw new Error('reserved_serve_port')
      if (owned && (owned.endpoint !== endpoint || owned.backend_port !== backend_port))
        throw new Error('remove_owned_mapping_first')
      const status = await this.doctor(endpoint, backend_port, local_port)
      if (!status.logged_in || !status.magicdns || !status.https || !status.endpoint_matches)
        throw new Error('tailscale_prerequisites_missing')
      if (occupied(await this.config(), p.port)) throw new Error('serve_port_occupied')
      // Intent is not ownership. A failed/lost write or verification must never confer deletion rights.
      this.save({ endpoint, backend_port, state: 'pending' })
      await this.run(['serve', '--bg', `--https=${p.port}`, p.proxy])
      if (!exactMapping(await this.config(), endpoint, backend_port))
        throw new Error('serve_mapping_unverified')
      this.save({ endpoint, backend_port, state: 'confirmed' })
    })
  }
  disable(endpoint: string, backend_port: number) {
    return this.exclusive(async () => {
      const p = parts(endpoint, backend_port),
        owned = this.owned()
      if (p.port === '443' || p.port === '80') throw new Error('reserved_serve_port')
      if (owned?.endpoint !== endpoint || owned.backend_port !== backend_port)
        throw new Error('serve_mapping_not_owned')
      if (owned.state !== 'confirmed') throw new Error('serve_ownership_uncertain')
      const config = await this.config()
      if (!occupied(config, p.port)) {
        this.save()
        return
      }
      if (!exactMapping(config, endpoint, backend_port)) throw new Error('serve_mapping_changed')
      // An uncertain removal also loses authority over any subsequently recreated identical mapping.
      this.save({ endpoint, backend_port, state: 'pending' })
      await this.run(['serve', `--https=${p.port}`, 'off'])
      if (occupied(await this.config(), p.port)) throw new Error('serve_mapping_unverified')
      this.save()
    })
  }
  async doctor(endpoint?: string, backend_port?: number, local_port = 7777) {
    try {
      const status = JSON.parse(await this.run(['status', '--json'])) as {
        BackendState?: string
        Self?: { DNSName?: string }
        CurrentTailnet?: { MagicDNSEnabled?: boolean }
        CertDomains?: string[] | null
      }
      const config = await this.config()
      const dns = status.Self?.DNSName?.replace(/\.$/, '')
      return {
        present: true,
        logged_in: status.BackendState === 'Running',
        magicdns: status.CurrentTailnet?.MagicDNSEnabled === true,
        https: !!dns && (status.CertDomains ?? []).includes(dns),
        endpoint_matches: !!endpoint && new URL(endpoint).hostname === dns,
        node_mapping: !!endpoint && !!backend_port && exactMapping(config, endpoint, backend_port),
        local_token_unmapped: !targetsPort(config, local_port),
        policy_verified: false,
      }
    } catch (error) {
      return {
        present: (error as NodeJS.ErrnoException).code !== 'ENOENT',
        logged_in: false,
        magicdns: false,
        https: false,
        node_mapping: false,
        local_token_unmapped: false,
        policy_verified: false,
        error: 'tailscale_diagnostics_unavailable',
      }
    }
  }
}
