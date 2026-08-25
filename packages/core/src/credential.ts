export * as Credential from "./credential"

import { asc, eq, isNotNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { Flag } from "./flag/flag"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }

    if (Flag.OPENCODE_SERVER_PASSWORD) {
      yield* db.run("PRAGMA secure_delete = ON").pipe(Effect.orDie)
      const credentials = new Map(
        (yield* db
          .select()
          .from(CredentialTable)
          .where(isNotNull(CredentialTable.integration_id))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie))
          .flatMap((row) => {
            const credential = stored(row)
            return credential ? [credential] : []
          })
          .map((credential) => [credential.id, credential]),
      )
      yield* db.delete(CredentialTable).where(isNotNull(CredentialTable.integration_id)).run().pipe(Effect.orDie)
      yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
      yield* db.run("PRAGMA secure_delete = OFF").pipe(Effect.orDie)

      return Service.of({
        all: Effect.fn("Credential.all")(() => Effect.sync(() => [...credentials.values()])),
        list: Effect.fn("Credential.list")((integrationID) =>
          Effect.sync(() =>
            [...credentials.values()].filter((credential) => credential.integrationID === integrationID),
          ),
        ),
        get: Effect.fn("Credential.get")((id) => Effect.sync(() => credentials.get(id))),
        create: Effect.fn("Credential.create")((input) =>
          Effect.sync(() => {
            for (const [id, credential] of credentials) {
              if (credential.integrationID === input.integrationID) credentials.delete(id)
            }
            const credential = new Info({
              id: ID.create(),
              integrationID: input.integrationID,
              label: input.label ?? "default",
              value: input.value,
            })
            credentials.set(credential.id, credential)
            return credential
          }),
        ),
        update: Effect.fn("Credential.update")((id, updates) =>
          Effect.sync(() => {
            if (!updates.label && !updates.value) return
            const credential = credentials.get(id)
            if (!credential) return
            credentials.set(
              id,
              new Info({
                ...credential,
                label: updates.label ?? credential.label,
                value: updates.value ?? credential.value,
              }),
            )
          }),
        ),
        remove: Effect.fn("Credential.remove")((id) => Effect.sync(() => void credentials.delete(id))),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
