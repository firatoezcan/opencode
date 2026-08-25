import path from "node:path"
import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

const docker = Bun.which("docker")
const supportedArchitecture = process.arch === "arm64" || process.arch === "x64"

test.skipIf(!docker || !supportedArchitecture)("starts a sanitized child from the musl artifact", async () => {
  await using tmp = await tmpdir()
  const target = process.arch === "arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-baseline-musl"
  const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64"
  const outfile = path.join(tmp.path, "process-environment")
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/model-process-environment.ts")],
    compile: {
      target,
      outfile,
    },
    define: {
      OPENCODE_LIBC: '"musl"',
    },
  })
  expect(build.success).toBeTrue()

  const result = Bun.spawnSync({
    cmd: [
      docker ?? "docker",
      "run",
      "--rm",
      "--platform",
      platform,
      "--env",
      "OPENCODE_SERVER_PASSWORD=",
      "--env",
      "OPENCODE_AUTH_CONTENT=",
      "--volume",
      `${tmp.path}:/probe:ro`,
      "alpine:3.20",
      "sh",
      "-lc",
      "apk add --no-cache libgcc libstdc++ >/dev/null && /probe/process-environment",
    ],
    stdout: "ignore",
    stderr: "inherit",
  })

  expect(result.exitCode).toBe(0)
})
