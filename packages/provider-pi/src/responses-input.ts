type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// SDK 0.87.0 persists raw Responses reasoning items in thinkingSignature and
// replays them verbatim. Compatible backends can return logprobs:null in those
// items, but Responses input accepts only an array or an omitted field. Normalize
// at serialization so existing native histories work too; do not rewrite native
// evidence, opaque encrypted_content, tool arguments/results or other nulls.
export function normalizeResponsesInput(payload: unknown): unknown {
  if (!object(payload) || !Array.isArray(payload.input)) return payload
  return {
    ...payload,
    input: payload.input.map((item: unknown) => {
      if (
        !object(item) ||
        (item.type !== 'reasoning' && item.type !== 'message') ||
        !Array.isArray(item.content)
      )
        return item
      return {
        ...item,
        content: item.content.map((block: unknown) => {
          if (!object(block) || block.logprobs !== null) return block
          const { logprobs: _absent, ...content } = block
          return content
        }),
      }
    }),
  }
}
