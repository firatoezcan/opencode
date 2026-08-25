import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  test("internalizes protected-server auth and removes its plaintext source", async () => {
    const previous = Flag.OPENCODE_SERVER_PASSWORD
    const previousEnv = process.env.OPENCODE_SERVER_PASSWORD
    const authPath = path.join(Global.Path.data, "auth.json")
    const key = crypto.randomUUID()
    await fs.mkdir(path.dirname(authPath), { recursive: true })
    await fs.writeFile(authPath, JSON.stringify({ anthropic: { type: "api", key } }), { mode: 0o600 })
    Flag.OPENCODE_SERVER_PASSWORD = crypto.randomUUID()
    process.env.OPENCODE_SERVER_PASSWORD = Flag.OPENCODE_SERVER_PASSWORD
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const resolved = yield* auth.get("anthropic")
          expect(resolved?.type === "api" && resolved.key === key).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(authPath)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
          expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
        }).pipe(Effect.provide(LayerNode.compile(Auth.node)), Effect.scoped),
      )
    } finally {
      Flag.OPENCODE_SERVER_PASSWORD = previous
      if (previousEnv === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousEnv
      await fs.rm(authPath, { force: true })
    }
  })

  test("internalizes boot auth without Basic auth", async () => {
    const previous = Flag.OPENCODE_SERVER_PASSWORD
    const previousAuth = process.env.OPENCODE_AUTH_CONTENT
    const apiKey = crypto.randomUUID()
    const access = crypto.randomUUID()
    const refresh = crypto.randomUUID()
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: { type: "api", key: apiKey },
      openai: { type: "oauth", access, refresh, expires: Date.now() + 60_000 },
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          expect(process.env.OPENCODE_AUTH_CONTENT === undefined).toBe(true)
          const api = yield* auth.get("anthropic")
          const oauth = yield* auth.get("openai")
          expect(api?.type === "api" && api.key === apiKey).toBe(true)
          expect(oauth?.type === "oauth" && oauth.access === access && oauth.refresh === refresh).toBe(true)
        }).pipe(Effect.provide(LayerNode.compile(Auth.node)), Effect.scoped),
      )
    } finally {
      Flag.OPENCODE_SERVER_PASSWORD = previous
      if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previousAuth
    }
  })
})
