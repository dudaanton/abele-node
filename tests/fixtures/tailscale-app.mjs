#!/usr/bin/env node
// Offline double of the macOS app bundle's CLI: without TAILSCALE_BE_CLI it tries to
// start the GUI, which a background service cannot do, and still exits 0.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2).join(' ')
const state = process.env.FAKE_TAILSCALE_SERVE_STATE
if (!process.env.TAILSCALE_BE_CLI) {
  console.log('The Tailscale GUI failed to start: The operation could not be completed.\n')
} else if (args === 'status --json') {
  console.log(
    JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'node.example.ts.net.' },
      CurrentTailnet: { MagicDNSEnabled: true },
      CertDomains: ['node.example.ts.net'],
    })
  )
} else if (args === 'serve status --json') {
  console.log(state && existsSync(state) ? readFileSync(state, 'utf8') : '{}')
} else if (process.env.FAKE_TAILSCALE_REFUSE) {
  console.error(process.env.FAKE_TAILSCALE_REFUSE)
  process.exitCode = 1
} else {
  const match = /^serve --bg --https=(\d+) (http:\/\/127\.0\.0\.1:\d+)$/.exec(args)
  if (!match || !state) {
    console.error('unexpected command')
    process.exitCode = 1
  } else {
    const [, port, proxy] = match
    writeFileSync(
      state,
      JSON.stringify({
        TCP: { [port]: { HTTPS: true } },
        Web: { [`node.example.ts.net:${port}`]: { Handlers: { '/': { Proxy: proxy } } } },
      })
    )
  }
}
