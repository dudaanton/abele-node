// account/read reports only the authentication kind; never inspect credentials.
export function isCodexAuthenticated(response: any): boolean {
  return response?.account?.type === 'chatgpt' || response?.account?.type === 'apiKey'
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export function codexLoginCommand(executable: string, home: string, isolated: boolean): string {
  return `CODEX_HOME=${quote(home)} ${quote(executable)}${isolated ? ' -c \'cli_auth_credentials_store="file"\'' : ''} login --device-auth`
}
export function codexApiKeyLoginCommand(executable: string, home: string): string {
  // The command names the environment variable, never its value.
  return `printf '%s' "$OPENAI_API_KEY" | CODEX_HOME=${quote(home)} ${quote(executable)} -c 'cli_auth_credentials_store="file"' login --with-api-key`
}
