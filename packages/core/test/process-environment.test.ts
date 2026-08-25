import path from "node:path"
import { expect, test } from "bun:test"

test("keeps model processes from reading boot auth through their parent", () => {
  if (process.platform !== "linux") return

  const result = Bun.spawnSync({
    cmd: [process.execPath, path.join(import.meta.dir, "fixture/model-process-environment.ts")],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: crypto.randomUUID(),
      OPENCODE_AUTH_CONTENT: JSON.stringify({ test: { type: "api", key: crypto.randomUUID() } }),
    },
    stdout: "ignore",
    stderr: "ignore",
  })

  expect(result.exitCode).toBe(0)
})

test("keeps boot auth out of native PTY processes", () => {
  if (process.platform !== "linux") return

  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      path.join(import.meta.dir, "pty/pty-session.test.ts"),
      "--test-name-pattern",
      "omits server and boot auth",
    ],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: crypto.randomUUID(),
      OPENCODE_AUTH_CONTENT: JSON.stringify({ test: { type: "api", key: crypto.randomUUID() } }),
    },
    stdout: "ignore",
    stderr: "ignore",
  })

  expect(result.exitCode).toBe(0)
})
