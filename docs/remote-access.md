# Remote access through Tailscale

Remote access is available through separately enabled **node-side paired WSS**.
The plugin pairing UI is not yet released. TLS terminates in the locally installed
Tailscale Serve process; device authorization is independent of tailnet membership.
No Noise, custom key exchange, public relay or new crypto dependency is introduced. The application identity proof is **not TLS certificate pinning**.

## Prerequisites and exposure

Use an installed, logged-in Tailscale client, MagicDNS and HTTPS certificates. The
macOS adapter defaults to the installed app's CLI; `--tailscale-path CLI_PATH`
selects another supported CLI. It does not install or reconfigure Tailscale, run
`up`/`set`, change ACLs, advertise routes or enable Funnel.

The owner must inspect effective tailnet policy and restrict access to intended
clients on the dedicated HTTPS port. Confirm that local-token, paired backend and
unrelated service ports cannot be reached directly, over **both IPv4 and IPv6**.
This is especially important with userspace netstack forwarding. The CLI cannot
prove effective ACL policy; `--tailnet-policy-verified` is an explicit operator
attestation, **not an automated security check**. Pairing is still mandatory.

Create a protected, stable configuration file. Replace `YOUR_PAIRED_WSS_ENDPOINT`
with your full Tailscale WSS endpoint and `YOUR_VERIFIED_CLIENT_ORIGIN` with the exact
Origin measured on your supported client; these placeholders are not valid deployment
values. For multiple supported clients, list each verified Origin explicitly.

```json
{
  "endpoint": "YOUR_PAIRED_WSS_ENDPOINT",
  "backend_port": 47124,
  "origins": ["YOUR_VERIFIED_CLIENT_ORIGIN"],
  "allow_missing_origin": false,
  "allow_null_origin": false
}
```

Construct the endpoint from `wss://`, your full Tailscale DNS name and
`:8443/channel`. It must be a canonical full `ts.net` WSS URL, without secrets,
queries or fragments. Omitted HTTPS port defaults to **8443**; configure
another dedicated port in the endpoint. Do not use ports 80/443: those are reserved
and the manager will not write them. Certificates cover the full DNS name, not an
IP or short hostname; names appear in public Certificate Transparency logs.
Set `PAIRED_CONFIG` to the protected configuration file you created.

```sh
node packages/node-daemon/dist/cli.js start --paired-config "$PAIRED_CONFIG"
node packages/node-daemon/dist/cli.js doctor
# Only after owner review and actual policy verification:
node packages/node-daemon/dist/cli.js serve enable --tailnet-policy-verified
node packages/node-daemon/dist/cli.js status
# Explicitly remove only the node's own unchanged mapping:
node packages/node-daemon/dist/cli.js serve disable
```

All commands also accept `--state-dir`. Both node listeners stay on **127.0.0.1**.
The local listener accepts only local tokens; Serve must target the separate paired
listener. The paired listener never accepts `local-token-v1`, even from loopback.
Starting/stopping/restarting the daemon does **not** modify Serve. Disable its mapping
before stopping if you want to remove reachability. Installation can persist
`--paired-config`, but the configuration file must remain at its stable protected
path; installing or redeploying a LaunchAgent is an owner-controlled operation.

`TailscaleServeManager` reads `serve status --json` before any write. It refuses
foreign, duplicate, foreground or Funnel-enabled entries on its port, refuses any
mapping to the local-token listener, and keeps a protected ownership/intent record.
An identical foreign mapping is not adopted. Removal requires ownership **and** an
exact unchanged HTTPS/root-proxy mapping. It never resets the Serve configuration
or overwrites another service's entries. Do not run concurrent external Serve
configuration writers while enabling/disabling: the CLI provides no atomic CAS
against another administrator. Ownership is confirmed only after a successful CLI
reply **and** verified mapping. Failed/lost enable, verification or removal results
leave a **pending**, non-owning record; matching configuration is never automatically
adopted or removed after such a result. Legacy records without a confirmation state
are also treated as pending. Inspect uncertain configuration with the administrator,
not `serve reset`; a fresh enable may retry only after the port is empty.

Status/doctor report presence, login, MagicDNS, certificate-domain availability,
configured endpoint matching the local DNS name, exact node mapping, and whether the
local-token port is unmapped. Unknown/unreadable diagnostics fail closed. These do
not prove certificate issuance/renewal, forwarding behavior or effective ACLs.

## Invitation and owner confirmation

```sh
node packages/node-daemon/dist/cli.js pair invite phone --json
# JSON is the QR/invite payload. Treat its secret as sensitive; default expiry: 5 minutes.
node packages/node-daemon/dist/cli.js pair list
node packages/node-daemon/dist/cli.js pair confirm INSTALLATION_ID DEVICE_FINGERPRINT
node packages/node-daemon/dist/cli.js pair revoke INSTALLATION_ID
```

The invitation binds endpoint, stable node ID, application-key fingerprint,
expiry and a random single-use secret. The node stores only the secret hash. The
device generates and persists a non-extractable ECDSA P-256 private key **before**
claiming. Claiming requires a fresh proof of possession and atomically creates a
**pending** installation; it does not grant access. The owner must independently
compare the full device fingerprint displayed on the enrolling device, then
confirm that exact fingerprint locally. Never blindly confirm an unexpected key
from `pair list`. A stolen invitation can consume it and cause denial of service,
but cannot authorize the thief without the owner's confirmation.

Lost claim replies recover the same principal only with the same invitation and
same device key plus a fresh proof, for 24 hours after consumption (even after the
original unused-invite expiry). Another key is refused. Revoked keys do not recover.
The protected local CLI IPC is the only database owner while the daemon is running.
A token-authenticated local owner session can also use `pairing.list` and
`pairing.confirm`; these methods are refused to remotely paired principals.

The WebCrypto challenge-response uses SHA-256 and ECDSA P-256. A fixed transcript
binds role, authentication profile, node protocol 0.0, purpose, connection nonce,
client nonce, node ID, endpoint, principal (or invitation ID during enrollment),
device fingerprint and expiry. The node signs first; the client verifies its
pinned application key before signing a distinct device-role transcript. Challenges
expire after 10 seconds on the **server's** clock and are consumed by one connection.
The client verifies its fresh nonce within a local monotonic 10-second deadline,
including asynchronous signature verification/signing; device and server wall clocks
need not match. The signed server expiry remains bound into both proofs. No permanent bearer
token authenticates the paired profile. Protocol-version changes require an explicit
profile/transcript review; no opportunistic downgrade is permitted.

Host and path must match the configured endpoint exactly. Origins are an explicit
allowlist, with no wildcard. Missing and `null` Origin each require their own explicit
client policy and still require device authentication. Mobile Origins must be measured
on the actual supported WebView; **do not** assume the desktop policy works on iOS.
Forwarded addresses, hosts and Tailscale identity headers are never authority.

## Plugin-facing client API (browser compatible)

```ts
import { PairedWssConnector, NodeClient, type DeviceKeyStore } from '@abele/node-client'

const connector = new PairedWssConnector(deviceLocalKeys satisfies DeviceKeyStore)
const claim = await connector.claim(inviteFromQr)
// Display claim.device_fingerprint for owner comparison; wait for node-side confirmation.
const target = await connector.target(inviteFromQr.node_id)
const client = new NodeClient(target, installationLocalClientStore, connector)
await client.connect()
// All existing session, replay, outbox, prompt, review and file APIs are unchanged.
```

`DeviceKeyStore.load(node_id)` returns an isolated device-local snapshot.
`transaction(node_id, work)` must serialize **every adapter/context sharing that
installation namespace**, atomically commit the callback's `{device, result}` and
roll back on rejection. The connector gets/creates and persists the private key in
one transaction **before** sending a claim; concurrent claims reuse that same key.
A separate transaction binds the response's installation ID only if key and pin
still match, so a late response cannot undo an explicit pin/key change. Pin recovery
uses the same transactional boundary. Separate atomic `load`/`save` calls are not
sufficient. Do not hold an IndexedDB transaction open across asynchronous WebCrypto
work; implement namespace serialization plus atomic persistence in the adapter.
Persist `CryptoKey`, public coordinates, endpoint, pinned node fingerprint and optional
installation ID. Use non-extractable CryptoKey structured cloning in IndexedDB where
supported; the plugin must verify real-device persistence across restarts. Keys are
not JSON settings, synced secrets, vault files or transferable configuration. Inject
an independent key store and transactional `ClientStore` namespace for each device.
A production Obsidian key-storage adapter is not provided here.

## Migration, revocation and recovery

To bind an existing local principal to a device key, issue an invitation with explicit
local authorization:

```sh
node packages/node-daemon/dist/cli.js pair invite desktop --json --pair-installation EXISTING_ID
```

After proof and confirmation, the installation ID is unchanged. Continue using the
existing `ClientStore`: journals, operation receipts, node/session references and
cursors are preserved. The local token remains local-only; revoke it separately if
that local access is no longer desired. `token revoke` revokes the entire installation,
including its paired access. `pair revoke` revokes only its device key, leaving any
existing local token valid. There is no remote owner enrollment or privilege escalation.

Revocation fences admitted requests, mutations, prompt resolution, receipt replay,
artifact reads and live/replayed publication. Live channels close
on the next publication check (normally within the 10 ms journal polling interval);
already-sent bytes cannot be recalled. Every queued record is rechecked at its actual
send boundary, not just at subscription creation. Installation/token revocation also
fences queued execution. Device-key revocation is not cancellation of already accepted
node-owned work, especially when the principal retains an authorized local token.

`pair rotate` explicitly replaces the node application key and revokes **all** device
grants/invitations while retaining stable node/principal/history identities. Existing
pins fail closed. To recover a revoked device, the owner can issue a new invitation
bound to its existing installation ID; claim and confirmation replace only that revoked
key. This is refused for a still-active/pending device or a revoked installation.
On the client, `authorizeNodeKeyChange(newInvite, expectedPreviousFingerprint)` is a
separate explicit UI action after out-of-band owner verification of the **new** pin.
It must never run automatically in response to failed connect. Invitation expiry is
enforced by the node when claiming, not by the device wall clock (including this
explicit pin-recovery action). Then claim the new invite and confirm again. The principal must remain unchanged to reuse old receipts.
A lost private key needs a fresh device-local key store and explicit owner re-enrollment;
no private keys are copied between devices.

## Verification and deployment checks

```sh
npm ci --ignore-scripts
npm run types
npm run acceptance:remote # offline fake-device/CLI acceptance; no live Serve writes
npm test
npm run format:check
```

Tests use fake providers/CLI, real WebCrypto and SQLite, two independent fake devices,
and loopback WebSockets emulating Serve's Host forwarding. They exercise claim response
loss, replay/expiry, exact owner confirmation, key substitution, revoked replay/artifact/
prompt boundaries with valid positive controls and revocation during processing,
transactional concurrent claims across independent adapters after lost responses,
late binding after explicit device-key/node-pin changes, late-open transport cleanup,
pending versus confirmed Serve ownership after uncertain CLI results, migration,
node rotation/recovery with skewed device clocks, offline input, prompt races,
reconnect and daemon restart. They do **not** establish real Tailscale TLS or mobile
interoperability. The node-side API is available, but automated tests do not verify
production mobile integration.

Deployment checks include authentication-protocol security review; real Serve
Host/Origin forwarding and certificate issuance/renewal; effective IPv4/IPv6 ACL denial;
real desktop/iOS Obsidian Origin and non-extractable key persistence; two devices on an
off-network/cellular path; idle/slow WebSockets, VPN/network changes, suspension,
screen lock and reconnect. These checks are deployment responsibilities; background
execution is not guaranteed.

Out of scope: plugin pairing UI, Sync/relay adoption, Noise/E2E transport, Funnel/public
exposure, non-Tailscale clients, push delivery, background socket survival, mixed-trust
shell containment, or protection against a compromised node/Serve process, device or TLS
termination. Journal state remains protected but **unencrypted at rest**.
