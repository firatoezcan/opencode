import fs from "node:fs/promises"
import path from "node:path"
import { Database as SqliteDatabase } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  test("keeps protected-server credentials usable without persisting their plaintext", async () => {
    const firstKey = crypto.randomUUID()
    const connectedKey = crypto.randomUUID()
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode.db")
    const database = Database.layerFromPath(filename)
    const app = (protectedServer: boolean) =>
      AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]), [
        [Database.node, database],
        [Credential.node, Credential.nodeWithProtection(protectedServer)],
      ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const integrationID = Integration.ID.make("openai")
        yield* credentials.create({
          integrationID,
          value: Credential.Key.make({ type: "key", key: firstKey }),
        })
      }).pipe(Effect.provide(app(false)), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const integrations = yield* Integration.Service
        const { db } = yield* Database.Service
        const integrationID = Integration.ID.make("openai")

        const internalized = (yield* credentials.list(integrationID))[0]
        expect(internalized?.value.type === "key" && internalized.value.key === firstKey).toBe(true)

        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID,
            method: { type: "key", label: "API key" },
          }),
        )
        yield* integrations.connection.key({
          integrationID,
          key: connectedKey,
        })

        const active = yield* integrations.connection.active(integrationID)
        const resolved = active ? yield* integrations.connection.resolve(active) : undefined
        expect(resolved?.type === "key" && resolved.key === connectedKey).toBe(true)
        expect((yield* db.select().from(CredentialTable).all()).length).toBe(0)
      }).pipe(Effect.provide(app(true)), Effect.scoped),
    )

    for (const entry of await fs.readdir(tmp.path)) {
      const content = await fs.readFile(path.join(tmp.path, entry))
      expect(content.includes(Buffer.from(firstKey))).toBe(false)
      expect(content.includes(Buffer.from(connectedKey))).toBe(false)
    }
  })

  test(
    "fails promptly when protected credential plaintext cannot leave the WAL",
    async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "opencode.db")
      const database = Database.layerFromPath(filename)
      const app = (protectedServer: boolean) =>
        AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]), [
          [Database.node, database],
          [Credential.node, Credential.nodeWithProtection(protectedServer)],
        ])

      await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("openai"),
            value: Credential.Key.make({ type: "key", key: crypto.randomUUID() }),
          })
        }).pipe(Effect.provide(app(false)), Effect.scoped),
      )

      using reader = new SqliteDatabase(filename)
      reader.run("PRAGMA busy_timeout = 0")
      reader.run("BEGIN")
      expect(reader.query("SELECT id FROM credential").all()).toHaveLength(1)

      const started = performance.now()
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Credential.Service
        }).pipe(Effect.provide(app(true)), Effect.scoped, Effect.exit),
      )

      expect(performance.now() - started).toBeLessThan(1_000)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("could not be removed from SQLite WAL")
    },
    { timeout: 15_000 },
  )
})
