import { beforeAll, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema, Effect } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Auth } from "../../src/auth"
import { cliIt } from "../lib/cli-process"

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

function authPath(home: string) {
  return path.join(home, ".local", "share", "opencode", "auth.json")
}

function environment(password: string, authContent: string) {
  return {
    OPENCODE_AUTH_CONTENT: authContent,
    OPENCODE_MODELS_URL: "http://127.0.0.1:1",
    OPENCODE_PRINT_LOGS: "1",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
  }
}

async function writeAuth(home: string, auth: Record<string, Auth.Info>) {
  const file = authPath(home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(auth), { mode: 0o600 })
}

function expectSecretsAbsent(output: string, secrets: string[]) {
  for (const secret of secrets) expect(output).not.toContain(secret)
}

for (const source of ["auth.json", "OPENCODE_AUTH_CONTENT"] as const) {
  cliIt.live(
    `compiled serve retains ${source} auth in its protected listener`,
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const password = crypto.randomUUID()
        const key = crypto.randomUUID()
        const auth = { "opencode-go": { type: "api", key } } satisfies Record<string, Auth.Info>
        if (source === "auth.json") yield* Effect.promise(() => writeAuth(home, auth))

        const server = yield* opencode.serve({
          env: environment(password, source === "auth.json" ? "" : JSON.stringify(auth)),
        })
        const authorization = Buffer.from(`opencode:${password}`).toString("base64")
        const unauthorized = yield* Effect.promise(() =>
          createOpencodeClient({ baseUrl: server.url, directory: home }).provider.list(),
        )
        const connected = yield* Effect.promise(() =>
          createOpencodeClient({
            baseUrl: server.url,
            directory: home,
            headers: { Authorization: `Basic ${authorization}` },
          }).provider.list(),
        )
        server.kill()
        const result = yield* server.result

        expect(unauthorized.response.status).toBe(401)
        expect(connected.response.status).toBe(200)
        expect(connected.data?.connected).toContain("opencode-go")
        expect(yield* Effect.promise(() => Bun.file(authPath(home)).exists())).toBe(false)
        expectSecretsAbsent(`${result.stdout}\n${result.stderr}`, [key, password, authorization])
      }),
    30_000,
    { executable },
  )
}

for (const command of [
  { name: "models --refresh", args: ["models", "--refresh"] },
  { name: "auth list", args: ["auth", "list"] },
]) {
  cliIt.live(
    `${command.name} preserves file auth when a server password is inherited`,
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const password = crypto.randomUUID()
        const key = crypto.randomUUID()
        const auth = { "opencode-go": { type: "api", key } } satisfies Record<string, Auth.Info>
        yield* Effect.promise(() => writeAuth(home, auth))

        const result = yield* opencode.spawn(command.args, { env: environment(password, "") })
        const persisted = Schema.decodeUnknownSync(Schema.Record(Schema.String, Auth.Info))(
          yield* Effect.promise(() => Bun.file(authPath(home)).json()),
        )

        expect(result.exitCode).toBe(0)
        expect(persisted).toEqual(auth)
        expectSecretsAbsent(`${result.stdout}\n${result.stderr}`, [key, password])
      }),
    30_000,
    { executable },
  )
}
