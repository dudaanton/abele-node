export interface CodexExecutionGate {
  name: string
  status: 'verified' | 'unverified' | 'failed'
  evidence?: string
  error?: string
}
/** Pinned native checkpoint; configuration/authentication still require per-launch checks. */
export function codexExecutionGates(
  platform: string = process.platform,
  version = '0.160.1'
): CodexExecutionGate[] {
  if (platform !== 'darwin')
    return [
      {
        name: 'platform_confinement',
        status: 'unverified',
        error: 'codex_platform_confinement_uncertified',
      },
    ]
  const evidence = nativeEvidence[version]
  if (!evidence)
    return [
      'native_approvals',
      'builtin_reader',
      'native_lifecycle',
      'native_delegation',
      'detached_descendants',
      'host_temp',
      'live_acceptance',
    ].map((name) => ({
      name,
      status: 'unverified',
      error: `codex_${name}_uncertified`,
      evidence: `Codex ${version}: native proof required; other versions' evidence does not apply`,
    }))
  return [
    ...Object.entries(evidence).map(([name, proof]) => ({
      name,
      status: 'verified' as const,
      evidence: proof,
    })),
    { name: 'host_temp', status: 'unverified' },
    { name: 'live_acceptance', status: 'unverified' },
  ]
}
/** Native replay evidence per exact version (probes/codex-native.mjs and codex-stage5.mjs, macOS). */
const nativeEvidence: Record<string, Record<string, string>> = {
  '0.160.1': {
    native_approvals: '0.160.1-loopback-replay-durable-allow-deny',
    builtin_reader: '0.160.1-view-image-workspace-allow-synthetic-credential-deny',
    native_lifecycle: '0.160.1-loopback-replay-exact-resume-interrupt',
    native_delegation: '0.160.1-loopback-replay-isolated-child-mailbox',
    detached_descendants: '0.160.1-native-setsid-marker-sweep-with-sampled-descendants',
  },
  // From 0.161.0 an approved escalation would widen to every non-denied path; the
  // profile's root deny keeps it to the ordinary profile, which the replay proves.
  '0.162.1': {
    native_approvals: '0.162.1-loopback-replay-durable-allow-deny-escalation-confined-to-workspace',
    builtin_reader: '0.162.1-view-image-workspace-allow-synthetic-credential-deny',
    native_lifecycle: '0.162.1-loopback-replay-exact-resume-interrupt',
    native_delegation: '0.162.1-loopback-replay-isolated-child-mailbox',
    detached_descendants: '0.162.1-native-setsid-marker-sweep-with-sampled-descendants',
  },
}
/** Native replay evidence string for an enabled version. */
export function codexExecutionEvidence(version: string) {
  return nativeEvidence[version]
    ? `${version}-native-replay-sampled-descendants-marker-sweep`
    : undefined
}
export function codexExecutionError(version = '0.160.1') {
  return codexExecutionGates(process.platform, version).find((g) => g.error)?.error ?? undefined
}
