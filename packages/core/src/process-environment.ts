export * as ProcessEnvironment from "./process-environment"

const privateKeys = ["OPENCODE_AUTH_CONTENT", "OPENCODE_SERVER_PASSWORD"] as const

export function sanitize(input: NodeJS.ProcessEnv) {
  const environment = { ...input }
  for (const key of privateKeys) delete environment[key]
  return environment
}

export function model(overrides: NodeJS.ProcessEnv = {}) {
  return sanitize({ ...process.env, ...overrides })
}
