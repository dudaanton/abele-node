import { waitForProcessCondition } from './process-test-budget.mjs'

// Shared by CLI acceptance and its virtual-clock regression: terminal provider
// failure must be checked during approval waiting, not after its deadline.
export function waitForPiPrompt({ prompt, failIfTerminal, completed }, ms) {
  return waitForProcessCondition(
    async () => {
      const value = await prompt()
      if (value) return value
      await failIfTerminal()
      if (await completed()) throw Error('provider_finished_without_required_prompt')
    },
    'Pi approval wait',
    ms
  )
}
