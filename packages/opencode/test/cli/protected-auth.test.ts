import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Auth } from "../../src/auth"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const target = ["opencode", process.platform === "win32" ? "windows" : process.platform, process.arch].join("-")
const executable = path.join(root, "dist", target, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")

beforeAll(async () => {
  const build = Bun.spawn({
    cmd: [process.execPath, "run", "build", "--single", "--skip-install", "--skip-embed-web-ui"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(build.stdout).text()
  const stderr = new Response(build.stderr).text()
  const exitCode = await build.exited
  if (exitCode !== 0) throw new Error(`Compiled OpenCode build failed\n${await stdout}\n${await stderr}`)
}, 120_000)

afterAll(async () => {
  await fs.rm(path.join(root, "dist"), { recursive: true, force: true })
})

function environment(directory: string, password: string) {
  const data = path.join(directory, "data")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(directory, "home"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: path.join(directory, "state"),
    OPENCODE_TEST_HOME: path.join(directory, "home"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_MODELS_URL: "http://127.0.0.1:1",
    OPENCODE_PRINT_LOGS: "1",
    OPENCODE_PURE: "1",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
  }
  delete env.OPENCODE_AUTH_CONTENT
  return { env, authPath: path.join(data, "opencode", "auth.json") }
}

async function run(directory: string, env: NodeJS.ProcessEnv, args: string[]) {
  const child = Bun.spawn({
    cmd: [executable, ...args],
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  return {
    exitCode: await child.exited,
    stdout: await stdout,
    stderr: await stderr,
  }
}

async function stop(child: Bun.Subprocess) {
  child.kill("SIGTERM")
  await Promise.race([child.exited, Bun.sleep(2_000)])
  if (child.exitCode !== null) return
  child.kill("SIGKILL")
  await child.exited
}

async function waitForServer(url: URL, child: Bun.Subprocess) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Compiled OpenCode server exited with ${child.exitCode}`)
    const response = await fetch(url, { signal: AbortSignal.timeout(500) }).catch(() => undefined)
    if (response) return response
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for compiled OpenCode server")
}

async function readLogs(directory: string) {
  const logDirectory = path.join(directory, "data", "opencode", "log")
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: logDirectory, onlyFiles: true })).catch(() => [])
  return (await Promise.all(files.map((file) => Bun.file(path.join(logDirectory, file)).text()))).join("\n")
}

function expectSecretsAbsent(output: string, secrets: string[]) {
  for (const secret of secrets) expect(output).not.toContain(secret)
}

for (const source of ["auth.json", "OPENCODE_AUTH_CONTENT"] as const) {
  test(`compiled serve retains ${source} auth in its protected listener`, async () => {
    await using tmp = await tmpdir()
    const password = crypto.randomUUID()
    const key = crypto.randomUUID()
    const runtime = environment(tmp.path, password)
    const auth = { "opencode-go": { type: "api", key } } satisfies Record<string, Auth.Info>

    if (source === "auth.json") {
      await fs.mkdir(path.dirname(runtime.authPath), { recursive: true })
      await Bun.write(runtime.authPath, JSON.stringify(auth))
      await fs.chmod(runtime.authPath, 0o600)
    } else {
      runtime.env.OPENCODE_AUTH_CONTENT = JSON.stringify(auth)
    }

    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port
    probe.stop(true)
    const child = Bun.spawn({
      cmd: [executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: tmp.path,
      env: runtime.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const url = new URL(`/provider?directory=${encodeURIComponent(tmp.path)}`, `http://127.0.0.1:${port}`)

    const authorization = Buffer.from(`opencode:${password}`).toString("base64")
    const response = await (async () => {
      try {
        const unauthorized = await waitForServer(url, child)
        const result = await createOpencodeClient({
          baseUrl: `http://127.0.0.1:${port}`,
          directory: tmp.path,
          headers: { Authorization: `Basic ${authorization}` },
        }).provider.list()
        return { unauthorized, result }
      } finally {
        await stop(child)
      }
    })()

    const processOutput = `${await stdout}\n${await stderr}`
    const logs = await readLogs(tmp.path)
    expect(response.unauthorized.status).toBe(401)
    expect(response.result.response.status).toBe(200)
    expect(response.result.data?.connected).toContain("opencode-go")
    expect(await Bun.file(runtime.authPath).exists()).toBe(false)
    expectSecretsAbsent(`${processOutput}\n${logs}`, [key, password, authorization])
  }, 30_000)
}

for (const command of [
  { name: "models --refresh", args: ["models", "--refresh"] },
  { name: "auth list", args: ["auth", "list"] },
]) {
  test(`${command.name} preserves file auth when a server password is inherited`, async () => {
    await using tmp = await tmpdir()
    const password = crypto.randomUUID()
    const key = crypto.randomUUID()
    const runtime = environment(tmp.path, password)
    const auth = { "opencode-go": { type: "api", key } } satisfies Record<string, Auth.Info>
    await fs.mkdir(path.dirname(runtime.authPath), { recursive: true })
    await Bun.write(runtime.authPath, JSON.stringify(auth))
    await fs.chmod(runtime.authPath, 0o600)

    const result = await run(tmp.path, runtime.env, command.args)
    const persisted = Schema.decodeUnknownSync(Schema.Record(Schema.String, Auth.Info))(
      await Bun.file(runtime.authPath).json(),
    )
    const logs = await readLogs(tmp.path)

    expect(result.exitCode).toBe(0)
    expect(persisted).toEqual(auth)
    expectSecretsAbsent(`${result.stdout}\n${result.stderr}\n${logs}`, [key, password])
  }, 30_000)
}
