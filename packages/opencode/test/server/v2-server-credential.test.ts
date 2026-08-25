import fs from "node:fs/promises"
import path from "node:path"
import { Database as SqliteDatabase } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "../fixture/fixture"

async function readRegistration(file: string, server: Bun.Subprocess) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const data = await fs.readFile(file, "utf8").catch(() => undefined)
    if (data) {
      const registration: unknown = JSON.parse(data)
      if (
        typeof registration === "object" &&
        registration !== null &&
        "url" in registration &&
        typeof registration.url === "string"
      )
        return { url: registration.url }
      throw new Error("V2 server registered an invalid URL")
    }
    if (server.exitCode !== null) throw new Error("V2 server exited before registration")
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for V2 server registration")
}

test(
  "uses the native V2 Basic auth configuration to protect credentials",
  async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode.db")
    const database = Database.layerFromPath(filename)
    const seed = AppNodeBuilder.build(LayerNode.group([Credential.node, Database.node]), [
      [Database.node, database],
      [Credential.node, Credential.nodeWithProtection(false)],
    ])
    const key = crypto.randomUUID()

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Credential.Service).create({
          integrationID: Integration.ID.make("openai"),
          value: Credential.Key.make({ type: "key", key }),
        })
      }).pipe(Effect.provide(seed), Effect.scoped),
    )

    const state = path.join(tmp.path, "state")
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_DB: filename,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_STATE_HOME: state,
    }
    delete environment.OPENCODE_AUTH_CONTENT
    delete environment.OPENCODE_SERVER_PASSWORD

    const server = Bun.spawn({
      cmd: [
        process.execPath,
        path.resolve(import.meta.dir, "../../../cli/src/index.ts"),
        "serve",
        "--port",
        "0",
        "--register",
      ],
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    })

    try {
      const directory = path.join(state, "opencode")
      const registration = await readRegistration(path.join(directory, "server.json"), server)
      const password = await fs.readFile(path.join(directory, "password"), "utf8")
      const authorization = Buffer.from(`opencode:${password}`).toString("base64")
      const unauthorized = await fetch(new URL("/api/health", registration.url), {
        signal: AbortSignal.timeout(2_000),
      })
      const response = await fetch(new URL("/api/health", registration.url), {
        headers: { Authorization: `Basic ${authorization}` },
        signal: AbortSignal.timeout(2_000),
      })

      expect(unauthorized.status).toBe(401)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ healthy: true })
      using stored = new SqliteDatabase(filename, { readonly: true })
      expect(stored.query("SELECT id FROM credential").all()).toEqual([])
    } finally {
      server.kill("SIGTERM")
      await Promise.race([server.exited, Bun.sleep(2_000)])
      if (server.exitCode === null) {
        server.kill("SIGKILL")
        await server.exited
      }
    }
  },
  { timeout: 15_000 },
)
