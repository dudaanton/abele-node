/** Immutable Git payloads only. Working files, refs and index state must never enter this cache. */
export class RepositoryObjectCache {
  private entries = new Map<string, Buffer>()
  private bytes = 0
  constructor(
    readonly maxBytes = 16 * 1024 * 1024,
    readonly maxEntries = 512,
    readonly maxItem = 1024 * 1024
  ) {}
  get(key: string) {
    const bytes = this.entries.get(key)
    if (!bytes) return undefined
    this.entries.delete(key)
    this.entries.set(key, bytes)
    return Buffer.from(bytes)
  }
  set(key: string, bytes: Buffer) {
    const old = this.entries.get(key)
    if (old) {
      this.bytes -= old.length
      this.entries.delete(key)
    }
    if (bytes.length > this.maxItem || bytes.length > this.maxBytes) return
    this.entries.set(key, Buffer.from(bytes))
    this.bytes += bytes.length
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const key = this.entries.keys().next().value!
      this.bytes -= this.entries.get(key)!.length
      this.entries.delete(key)
    }
  }
  clear() {
    this.entries.clear()
    this.bytes = 0
  }
}
