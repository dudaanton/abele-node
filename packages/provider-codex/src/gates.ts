export interface CodexExecutionGate {
  name: string
  status: 'verified' | 'unverified' | 'failed'
  evidence?: string
  error?: string
}
/** Pinned native checkpoint; configuration/authentication still require per-launch checks. */
export function codexExecutionGates(platform: string = process.platform): CodexExecutionGate[] {
  if (platform !== 'darwin')
    return [
      {
        name: 'platform_confinement',
        status: 'unverified',
        error: 'codex_platform_confinement_uncertified',
      },
    ]
  return [
    {
      name: 'native_approvals',
      status: 'verified',
      evidence: '0.160.1-loopback-replay-durable-allow-deny',
    },
    {
      name: 'builtin_reader',
      status: 'verified',
      evidence: '0.160.1-view-image-workspace-allow-synthetic-credential-deny',
    },
    {
      name: 'native_lifecycle',
      status: 'verified',
      evidence: '0.160.1-loopback-replay-exact-resume-interrupt',
    },
    {
      name: 'native_delegation',
      status: 'verified',
      evidence: '0.160.1-loopback-replay-isolated-child-mailbox',
    },
    {
      name: 'detached_descendants',
      status: 'verified',
      evidence: '0.160.1-native-setsid-marker-sweep-with-sampled-descendants',
    },
    { name: 'host_temp', status: 'unverified' },
    { name: 'live_acceptance', status: 'unverified' },
  ]
}
export function codexExecutionError() {
  return codexExecutionGates().find((g) => g.error)?.error ?? undefined
}
