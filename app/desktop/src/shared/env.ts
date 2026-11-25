// Environment of child processes: shared by host and main, so the rule for removed variables lives in one place.

/** Copy of the environment without the ANTHROPIC_* and CLAUDE* variables: an API key would switch to pay-as-you-go billing. `strip` removes other names too. */
export function cleanEnv(strip: readonly string[] = []): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key) || strip.includes(key)) continue
    env[key] = value
  }
  return env
}
