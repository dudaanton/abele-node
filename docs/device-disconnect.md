# Disconnecting a device

Detect `capabilities.device_disconnect.status === 'supported'` before offering credential
revocation. `node.disconnect({})` revokes the authenticated installation's local token and
paired key, and invalidates its retained grants. It accepts no installation ID: another
device cannot be selected by this request. Other installations stay connected.

The response is `{disconnected: true}`. This acknowledgement contains no protected data and
is allowed after revocation; subsequent requests and publications under the old authority
fail. If the acknowledgement is lost, the client must reconnect with the old credential to
distinguish revocation from a transport failure. Do not create a new credential automatically.

The plugin should call this method before removing the device registration and closing its
channel. Ordinary socket disconnect/reload continues to preserve credentials and sessions.
On older nodes, explain that removing the local registration leaves the credential active.
