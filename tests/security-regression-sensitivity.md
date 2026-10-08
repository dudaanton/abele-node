# Security regression sensitivity

The offline pairing tests use real WebCrypto/SQLite and fake transports/providers/CLI.
No live Tailscale configuration or device access is needed. Build before running the
filters below: the daemon imports the compiled channel-server and node-core packages.

## Authentication-timeout cleanup

`tests/paired-timeout.test.ts` delays the injected opener until after the auth timer
has rejected, then returns a transport. Both claim and connect must close it exactly
once without sending records. The losing handshake branch must explicitly close
this newly acquired transport; the already-completed outer `Promise.race` catch
cannot do it.

## Additional key-store coverage

`tests/paired-security.test.ts` holds an accepted claim response while either the
private/public key pair or the pinned node key is explicitly changed. Both cases
must reject stale binding, preserve the exact replacement state without attaching
an installation ID, and still allow fresh owner-authorized re-enrollment/connect.

Another test creates **two independent adapter objects** over one simulated storage
namespace. The first key generation is held while both adapters request transactions.
Only one callback/key generation may enter. Both claim replies are lost; a third
adapter must recover the single accepted key. Reads return structured-cloned snapshots,
including non-extractable CryptoKeys. This tests the connector/adapter contract, not
production IndexedDB or actual cross-WebView synchronization; those remain device gates.

## Sensitivity checks

The tests detect removal of the security checks below. For a local mutation check,
disable only one check at a time, build, run the named filter and confirm that it
fails. Restore the production check and rebuild before running other tests. No
bypass flag or mutant is shipped.

| Temporarily disabled check                                                                                           | Target filter                            | Failure when disabled                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `serveChannel` scheduler's `core.authority.check(actor, 'publish')` immediately before `transport.send`              | `revocation after a valid artifact read` | The revoked request receives an artifact response containing `AQI=` instead of a closed channel. |
| `NodeCore.operationReceipt`'s `this.authority.check(actor, 'mutate')`, called inside `commitOperation`'s transaction | `revocation after request admission`     | A pending `prompt.answer` commits instead of throwing `unauthorized`.                            |
| Late claim-binding checks comparing the current device public key and node pin with the enrolling snapshot           | `late claim binding`                     | Both key-change and pin-change cases resolve the stale claim instead of rejecting.               |

Run a targeted filter using:

```sh
npm run build
npx vitest run tests/paired-security.test.ts -t 'revocation after a valid artifact read'
npx vitest run tests/paired-security.test.ts -t 'revocation after request admission'
npx vitest run tests/paired-security.test.ts -t 'late claim binding'
```

With production checks intact, all three filters must pass. These focused checks
supplement the full offline suite; they do not establish live device interoperability.
