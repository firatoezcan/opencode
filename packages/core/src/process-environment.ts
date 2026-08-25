export * as ProcessEnvironment from "./process-environment"

import { dlopen } from "bun:ffi"

declare const OPENCODE_LIBC: "glibc" | "musl" | undefined

const privateKeys = ["OPENCODE_AUTH_CONTENT", "OPENCODE_SERVER_PASSWORD"] as const
const PR_SET_DUMPABLE = 4
const protectedBootEnvironment = privateKeys.some((key) => process.env[key] !== undefined)
let protectedProcess = false

function protect() {
  if (protectedProcess) return
  if (process.platform !== "linux") {
    if (protectedBootEnvironment) throw new Error("The model process credential boundary is unavailable")
    protectedProcess = true
    return
  }
  const libcPath =
    typeof OPENCODE_LIBC === "undefined" || OPENCODE_LIBC === "glibc"
      ? "libc.so.6"
      : process.arch === "arm64"
        ? "/lib/libc.musl-aarch64.so.1"
        : process.arch === "x64"
          ? "/lib/libc.musl-x86_64.so.1"
          : undefined
  if (!libcPath) throw new Error("The model process credential boundary is unavailable")
  const libc = dlopen(libcPath, {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    unsetenv: { args: ["cstring"], returns: "i32" },
  })
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0)
      throw new Error("The model process credential boundary could not be applied")
    for (const key of privateKeys) {
      delete process.env[key]
      if (libc.symbols.unsetenv(Buffer.from(`${key}\0`)) !== 0)
        throw new Error("The private process environment could not be cleared")
    }
    protectedProcess = true
  } finally {
    libc.close()
  }
}

export function sanitize(input: NodeJS.ProcessEnv) {
  protect()
  const environment = { ...input }
  for (const key of privateKeys) delete environment[key]
  return environment
}

export function model(overrides: NodeJS.ProcessEnv = {}) {
  return sanitize({ ...process.env, ...overrides })
}
