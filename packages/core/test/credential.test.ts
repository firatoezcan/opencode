import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
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
    const previous = Flag.OPENCODE_SERVER_PASSWORD
    const firstKey = crypto.randomUUID()
    const connectedKey = crypto.randomUUID()
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode.db")
    const database = Database.layerFromPath(filename)
    const app = () =>
      AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]), [
        [Database.node, database],
      ])

    try {
      Flag.OPENCODE_SERVER_PASSWORD = undefined
      await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          yield* credentials.create({
            integrationID,
            value: Credential.Key.make({ type: "key", key: firstKey }),
          })
        }).pipe(Effect.provide(app()), Effect.scoped),
      )

      Flag.OPENCODE_SERVER_PASSWORD = crypto.randomUUID()
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
        }).pipe(Effect.provide(app()), Effect.scoped),
      )

      for (const entry of await fs.readdir(tmp.path)) {
        const content = await fs.readFile(path.join(tmp.path, entry))
        expect(content.includes(Buffer.from(firstKey))).toBe(false)
        expect(content.includes(Buffer.from(connectedKey))).toBe(false)
      }
    } finally {
      Flag.OPENCODE_SERVER_PASSWORD = previous
    }
  })
})
