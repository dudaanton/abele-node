// Model names are account/configuration data, never node-selected defaults.
export function validCodexModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}
export function validCodexCatalog(catalog: any): boolean {
  return Array.isArray(catalog?.data) && catalog.data.length <= 100
}
function entries(catalog: any): any[] {
  return validCodexCatalog(catalog) ? catalog.data : []
}
export function exposedCodexModel(
  config: any,
  catalog: any,
  override?: string
): string | undefined {
  if (override) return override
  if (validCodexModel(config?.model)) return config.model
  const defaults = entries(catalog).filter(
    (m) => m?.isDefault === true && m.hidden !== true && validCodexModel(m.model)
  )
  return defaults.length === 1 ? defaults[0].model : undefined
}
export function codexModelAvailable(catalog: any, model: string): boolean {
  return entries(catalog).some(
    (m) =>
      m?.model === model &&
      m.hidden !== true &&
      m.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === 'low')
  )
}
