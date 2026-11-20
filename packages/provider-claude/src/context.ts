const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/** Current main context, never cumulative billing usage or a control estimate. */
export class ClaudeContext {
  private used: number | null = null
  private metadata: Record<string, any> = {}
  private request = 0

  constructor(private readonly publish: (data: Record<string, unknown>) => void = () => {}) {}

  async refresh(control: () => Promise<Record<string, any>>): Promise<void> {
    const request = ++this.request
    try {
      const metadata = await control()
      if (request !== this.request) return
      this.metadata = metadata
      this.publish(this.report())
    } catch {}
  }

  observe(record: Record<string, any>): boolean {
    if (record.parent_tool_use_id) return false
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      this.used = null
      ++this.request
      this.metadata = { ...this.metadata, categories: [] }
      this.publish(this.report())
      return true
    }
    if (record.type !== 'assistant') return false
    // API failures are assistant-shaped placeholders, not context measurements.
    if (record.message?.model === '<synthetic>' || record.isApiErrorMessage === true) return false
    const usage = record.message?.usage
    if (!usage || count(usage.input_tokens) === null) return false
    const counters = [
      usage.input_tokens,
      usage.cache_creation_input_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
    ].map(count)
    if (counters.some((n) => n === null)) return false
    if (counters.every((n) => n === 0) && (usage.output_tokens ?? 0) === 0) return false
    const total = counters.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    if (!Number.isFinite(total)) return false
    this.used = total
    this.publish(this.report())
    return true
  }

  report(u: Record<string, any> = this.metadata) {
    const max = count(u.maxTokens)
    return {
      total_tokens: this.used,
      max_tokens: max,
      percentage: this.used !== null && max ? (this.used * 100) / max : null,
      auto_compact_threshold: count(u.autoCompactThreshold),
      auto_compact_enabled:
        typeof u.isAutoCompactEnabled === 'boolean' ? u.isAutoCompactEnabled : null,
      model: typeof u.model === 'string' ? u.model : null,
      // Estimated categories are useful only when they describe the same measured total.
      categories:
        this.used !== null && u.totalTokens === this.used && Array.isArray(u.categories)
          ? u.categories
              .filter((c: any) => typeof c?.name === 'string' && count(c.tokens) !== null)
              .slice(0, 32)
              .map((c: any) => ({
                name: c.name.slice(0, 128),
                tokens: c.tokens,
                ...(c.isDeferred === true ? { deferred: true } : {}),
              }))
          : [],
    }
  }
}
