/** A node bridge failure is a completed tool result, never a missing IPC reply. */
export function nodeToolFailure(name: string, error: unknown) {
  const reason = error instanceof Error ? error.message : 'Node tool failed'
  const explanations: Record<string, string> = {
    untrusted_folder: 'Language intelligence is disabled because this folder is not trusted.',
    lsp_unavailable:
      'No language server is available for this file. Install a server and check the project dependencies.',
    lsp_timeout:
      'The language server timed out. Check the server and project dependencies, or use file search.',
  }
  return {
    code: name === 'lsp' ? 'lsp_failed' : 'tool_failed',
    message:
      name === 'lsp'
        ? (explanations[reason] ?? `Language intelligence failed: ${reason.slice(0, 1024)}`)
        : reason.slice(0, 1024),
  }
}
