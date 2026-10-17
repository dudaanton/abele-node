export type Progress = { stage: string; bytes?: number; total?: number | null; elapsed?: number }
function size(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
export function formatProgress(p: Progress): string {
  if (p.bytes === undefined) return p.stage
  const rate = p.bytes / Math.max(p.elapsed ?? 0, 0.001)
  const total = p.total && p.total > 0 ? p.total : null
  return `${p.stage}: ${size(p.bytes)}${total ? ` / ${size(total)} (${Math.min(100, Math.floor((p.bytes / total) * 100))}%)` : ''}, ${size(rate)}/s${total && rate ? `, ${Math.ceil(Math.max(0, total - p.bytes) / rate)} s left` : ''}`
}
export function progressDue(
  bytes: number,
  total: number | null,
  now: number,
  previousBytes: number,
  previousTime: number
): boolean {
  return (
    now - previousTime >= 5000 ||
    !!(total && (bytes >= total || (bytes - previousBytes) / total >= 0.1))
  )
}
