export function waitForPiPrompt<T>(
  probes: {
    prompt: () => T | Promise<T>
    failIfTerminal: () => void | Promise<void>
    completed: () => boolean | Promise<boolean>
  },
  ms?: number
): Promise<NonNullable<T>>
