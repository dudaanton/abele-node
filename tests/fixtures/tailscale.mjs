#!/usr/bin/env node
// Offline CLI fixture, including diagnostics. Never invokes the installed app.
if (process.argv.slice(2).join(' ') === 'status --json') {
  console.log(
    JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'node.example.ts.net.' },
      CurrentTailnet: { MagicDNSEnabled: true },
      CertDomains: ['node.example.ts.net'],
    })
  )
} else if (process.argv.slice(2).join(' ') === 'serve status --json') {
  console.log('{}')
} else {
  console.error('fixture refuses writes')
  process.exitCode = 1
}
