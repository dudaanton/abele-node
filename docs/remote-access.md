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
  "accepted_routes": [],
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
abele-node pair
# One private code line; instructions on stderr. Default expiry: 5 minutes.
abele-node pair --json
# Scripts receive {code,node_name,invite}; --node-name sets the display label.
abele-node approve-pair --list
abele-node approve-pair
# Interactive name/number selection and approval on a terminal.
abele-node approve-pair "Test device"
# Non-interactive: exactly one pending device must have this name.
abele-node approve-pair "Test device" --installation-id INSTALLATION_ID
# Optional independent check: --fingerprint FULL_DEVICE_FINGERPRINT.
# Legacy invitation and exact-key confirmation remain supported:
node packages/node-daemon/dist/cli.js pair invite device --json
node packages/node-daemon/dist/cli.js pair list
node packages/node-daemon/dist/cli.js pair confirm INSTALLATION_ID DEVICE_FINGERPRINT
node packages/node-daemon/dist/cli.js pair revoke INSTALLATION_ID
```

The invitation binds endpoint, stable node ID, application-key fingerprint,
expiry and a random single-use secret. The node stores only the secret hash. The
device generates and persists a non-extractable ECDSA P-256 private key **before**
claiming. Claiming requires a fresh proof of possession and atomically creates a
**pending** installation; it does not grant access. The enrolling client supplies its
bounded device name after proving possession; retries cannot rename the principal.
Names are untrusted display labels, not authenticated identities. `approve-pair`
shows waiting names, short device fingerprints (first eight hex digits, grouped),
age and installation IDs. Name-only approval is the default; fingerprint comparison
is optional. Duplicate pending names refuse approval until an exact installation ID
is chosen. A non-terminal invocation without a selection never approves anything.
The captured ID and full key are checked atomically against pending state.

Keep the code private: it is base64url-encoded JSON, not encryption. Name-only approval
can authorize a device with a spoofed label or a stolen invite if the owner picks it.
For independent comparison, use the optional full `--fingerprint` check or the legacy
`pair confirm` command. Invite expiry, single use and revocation still apply.

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
pinned application key and its signature over the fresh client nonce before sending
**any invitation secret or device name**. Enrollment's first `paired.begin` carries
only the public device key, fresh nonce and non-secret invitation ID. The full
invitation and device label are sent with the subsequent device proof; the node
verifies the proof and exact invitation ID before consuming it. Challenges
expire after 10 seconds on the **server's** clock and are consumed by one connection.
The client verifies its fresh nonce within a local monotonic 10-second deadline,
including asynchronous signature verification/signing; device and server wall clocks
need not match. The signed server expiry remains bound into both proofs. No permanent bearer
token authenticates the paired profile. Protocol-version changes require an explicit
profile/transcript review; no opportunistic downgrade is permitted.

New enrollment requires updated clients and daemons. A legacy secret-bearing begin
is refused with `paired.error: pairing_upgrade_required`; a new client encountering
an old daemon's pre-challenge close reports the same upgrade requirement and never
falls back to disclosing the secret. Already-confirmed installations retain their
existing begin/proof format and can reconnect across this update. A pre-challenge
close cannot distinguish an old daemon from another prematurely closing endpoint.

This proof is not end-to-end encryption. A TLS-terminating proxy that relays the
real node's proof can still read/alter later traffic. Use only owner-trusted TLS
termination and routes; an application-key pin does not make an arbitrary relay safe.

## Edited addresses and accepted TLS routes

After decoding a code, a client may edit the transport host and port. The invitation's
canonical endpoint and node-key pin remain unchanged. The daemon accepts the canonical
Host plus exact hosts/ports from the owner's `accepted_routes` array in the paired
configuration. Each extra route is a complete canonical `wss://.../channel` URL, with
no credentials, query or fragment; at most 16 are allowed. Restart the daemon after
changing this setting. Inspect the effective configuration with:

```sh
abele-node pair routes
abele-node pair routes --json
# {endpoint,accepted_routes}; no invitation or credentials are returned.
```

For an extra route to work, the owner must provide a reachable, trusted TLS terminator
or forwarder targeting the **paired** loopback backend and preserving the edited HTTP
Host and permitted Origin. The daemon does not create these extra listeners, certificates
or proxy mappings. Valid TLS must cover the **edited** hostname or IP. The canonical
Tailscale DNS name with its certificate works; another hostname works with its own
valid certificate and an accepted route. A bare LAN or Tailscale IP does **not** work
with a certificate issued only for a DNS name: it needs a TLS route with a certificate
valid for that IP (or use the certified hostname instead). No certificate checks are
disabled and insecure `ws://` is never a remote fallback. Local-token access stays
loopback-only and is never forwarded by this setting.

Route errors carry typed `reason`/`address` details, validated by
`PairingRouteFailureSchema` in `@abele/node-protocol`: `tls`, `host_not_accepted`,
`unreachable`, or `different_node`. HTTP upgrade rejection exposes
`x-abele-pairing-error` to diagnostic-capable openers; native TLS/network error codes
are classified without exposing raw exception text. A custom `TransportOpener` should
preserve the native error's `code`/`cause`; translate a `host_not_accepted` upgrade
header to error code `PAIRED_HOST_NOT_ACCEPTED`, and another upgrade-policy refusal
to `PAIRED_ROUTE_REFUSED`. These are display diagnostics, never authority or a reason
to bypass the pin. Browser WebSocket APIs deliberately
hide TLS and HTTP-upgrade diagnostics: an opaque browser failure is reported honestly
as `tls_or_unreachable`, not guessed to be a certificate or Host error. A denied Origin
or path is `policy_not_accepted`. Clients can show these typed errors on the Address row.

The node still proves the original canonical endpoint and pinned key before receiving
the invitation secret/name over any accepted route. Changing the address never changes
the key or grants a different principal. Only owner-trusted TLS termination is in scope;
the application proof does not encrypt traffic independently of TLS.

Path remains exactly `/channel`. Origins are an explicit
allowlist, with no wildcard. Missing and `null` Origin each require their own explicit
client policy and still require device authentication. Mobile Origins must be measured
on the actual supported WebView; **do not** assume the desktop policy works on iOS.
Forwarded addresses, hosts and Tailscale identity headers are never authority.

## Pairing protocol and client API (browser compatible)

```ts
import { PairedWssConnector, NodeClient, type DeviceKeyStore } from '@abele/node-client'

import { decodePairCode, PairingRouteFailureSchema } from '@abele/node-protocol'

const payload = decodePairCode(pastedCode) // Validate and display fields locally first.
const connector = new PairedWssConnector(deviceLocalKeys satisfies DeviceKeyStore)
const claim = await connector.claim(payload.invite, { deviceName, endpoint: editedWssRoute })
// Display claim.device_fingerprint for owner comparison; wait for node-side confirmation.
const target = await connector.target(payload.invite.node_id)
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
loopback WebSockets emulating Serve's Host forwarding, and a real TLS test terminator
that dials the edited URL, validates its certificate and preserves its actual Host.
They exercise secret/name non-disclosure to a wrong key or invalid node signature,
legacy enrollment refusal, accepted-route admission and typed TLS/Host/network errors,
claim response
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
exposure, automatic extra-route TLS/proxy provisioning, push delivery, background socket survival, mixed-trust
shell containment, or protection against a compromised node/Serve process, device or TLS
termination. Journal state remains protected but **unencrypted at rest**.
