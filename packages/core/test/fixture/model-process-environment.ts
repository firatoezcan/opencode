import { ProcessEnvironment } from "@opencode-ai/core/process-environment"

if (process.platform !== "linux") {
  try {
    ProcessEnvironment.model()
    process.exit(1)
  } catch {
    process.exit(0)
  }
}

const child = Bun.spawnSync({
  cmd: [
    "/bin/sh",
    "-c",
    '[ -z "${OPENCODE_SERVER_PASSWORD+x}" ] && [ -z "${OPENCODE_AUTH_CONTENT+x}" ] && ! grep -zEq "^(OPENCODE_SERVER_PASSWORD|OPENCODE_AUTH_CONTENT)=" /proc/$PPID/environ',
  ],
  env: ProcessEnvironment.model(),
  stdout: "ignore",
  stderr: "ignore",
})

process.exit(child.exitCode ?? 1)
