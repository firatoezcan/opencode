import { LLMClient } from "@opencode-ai/llm/route"
import { LLMEvent } from "@opencode-ai/llm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const providerID = ProviderV2.ID.make("ready-provider")
const modelID = ModelV2.ID.make("ready-model")
const uncredentialedModelID = ModelV2.ID.make("uncredentialed-model")
const sessionID = SessionV2.ID.make("ses_workspace_location_resume")

const catalog = {
  [providerID]: {
    id: providerID,
    name: "Ready Provider",
    env: ["READY_PROVIDER_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://ready-provider.test/v1",
    models: {
      [modelID]: {
        id: modelID,
        name: "Ready Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 100_000, output: 1_024 },
        modalities: { input: ["text"], output: ["text"] },
      },
      [uncredentialedModelID]: {
        id: uncredentialedModelID,
        name: "Uncredentialed Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 100_000, output: 1_024 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
} satisfies Record<string, ModelsDev.Provider>

describe("workspace Location session resume", () => {
  testEffect(Layer.empty).live(
    "boots the reassigned Location before the first model resolution",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        (dirs) =>
          Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
      ).pipe(
        Effect.flatMap(([source, target]) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(target.path, "opencode.json"),
                JSON.stringify({
                  provider: {
                    [providerID]: {
                      models: { [modelID]: { options: { apiKey: "fixture-secret" } } },
                    },
                  },
                }),
              ),
            )
            const modelStarts: { model: string; authorization: string | undefined }[] = []
            const modelsDev = Layer.succeed(
              ModelsDev.Service,
              ModelsDev.Service.of({
                get: () => Effect.succeed(catalog),
                refresh: () => Effect.void,
              }),
            )
            const llm = Layer.mock(LLMClient.Service, {
              stream: (request) =>
                Stream.fromEffect(
                  Effect.gen(function* () {
                    const headers = yield* request.model.route.auth
                      .apply({
                        request,
                        method: "POST",
                        url: "https://ready-provider.test/v1/chat/completions",
                        body: "{}",
                        headers: Headers.empty,
                      })
                      .pipe(Effect.orDie)
                    modelStarts.push({
                      model: `${request.model.provider}/${request.model.id}`,
                      authorization: headers.authorization,
                    })
                  }),
                ).pipe(
                  Stream.flatMap(() =>
                    Stream.fromIterable([
                      LLMEvent.stepStart({ index: 0 }),
                      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                      LLMEvent.finish({ reason: "stop" }),
                    ]),
                  ),
                ),
            })
            const project = Layer.mock(ProjectV2.Service, {
              resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
              directories: () => Effect.succeed([]),
              commit: () => Effect.void,
            })
            const locationMap = buildLocationServiceMap([
              [ModelsDev.node, modelsDev],
              [LayerNodePlatform.llmClient, llm],
              [PermissionV2.node, Layer.mock(PermissionV2.Service, {})],
              [ProjectV2.node, project],
              [
                SkillGuidance.node,
                Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
              ],
              [
                ReferenceGuidance.node,
                Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
              ],
              [Snapshot.node, Snapshot.noopLayer],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ])
            const layer = AppNodeBuilder.build(
              LayerNode.group([Database.node, EventV2.node, LocationServiceMap.node, SessionV2.node]),
              [
                [LocationServiceMap.node, locationMap],
                [SessionExecution.node, SessionExecutionLocal.node],
                [ProjectV2.node, project],
              ],
            )

            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const events = yield* EventV2.Service
              const locations = yield* LocationServiceMap.Service
              const sessions = yield* SessionV2.Service
              const sourceLocation = Location.Ref.make({ directory: AbsolutePath.make(source.path) })
              const targetLocation = Location.Ref.make({
                directory: AbsolutePath.make(target.path),
                workspaceID: WorkspaceV2.ID.make("wrk_location_resume"),
              })

              yield* sessions.create({
                id: sessionID,
                location: sourceLocation,
                model: { providerID, id: modelID },
              })
              const serialized = (yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, sessionID))
                .orderBy(EventTable.seq)
                .all()
                .pipe(Effect.orDie)).map((event) => ({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              }))

              yield* events.remove(sessionID)
              yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
              yield* events.replayAll(serialized)
              yield* events.publish(SessionEvent.Moved, {
                sessionID,
                location: targetLocation,
                timestamp: yield* DateTime.now,
              })
              yield* sessions.prompt({
                sessionID,
                prompt: Prompt.make({ text: "Start immediately after reassignment." }),
                resume: false,
              })
              const catalogModels = yield* Catalog.Service.use((catalog) => catalog.model.all()).pipe(
                Effect.provide(locations.get(targetLocation)),
              )

              expect(catalogModels.map((model) => `${model.providerID}/${model.id}`)).toContain(
                `${providerID}/${modelID}`,
              )
              yield* sessions.resume(sessionID)

              expect((yield* sessions.get(sessionID)).location).toEqual(targetLocation)
              expect(modelStarts).toEqual([
                { model: `${providerID}/${modelID}`, authorization: "Bearer fixture-secret" },
              ])
              expect(
                (yield* db
                  .select({ type: EventTable.type })
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, sessionID))
                  .orderBy(EventTable.seq)
                  .all()
                  .pipe(Effect.orDie)).map((event) => event.type),
              ).toContain(EventV2.versionedType(SessionEvent.Step.Started.type, 1))

              const unavailableSessionID = SessionV2.ID.make("ses_workspace_location_unavailable")
              yield* sessions.create({
                id: unavailableSessionID,
                location: targetLocation,
                model: { providerID, id: uncredentialedModelID },
              })
              yield* sessions.prompt({
                sessionID: unavailableSessionID,
                prompt: Prompt.make({ text: "Fail at the durable step boundary." }),
                resume: false,
              })
              const failure = yield* sessions.resume(unavailableSessionID).pipe(Effect.flip)
              const failureTypes = (yield* db
                .select({ type: EventTable.type })
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, unavailableSessionID))
                .orderBy(EventTable.seq)
                .all()
                .pipe(Effect.orDie)).map((event) => event.type)

              expect(failure).toMatchObject({
                _tag: "SessionRunnerModel.ModelUnavailableError",
                providerID,
                modelID: uncredentialedModelID,
              })
              expect(modelStarts).toHaveLength(1)
              expect(failureTypes.slice(-2)).toEqual([
                EventV2.versionedType(SessionEvent.Step.Started.type, 1),
                EventV2.versionedType(SessionEvent.Step.Failed.type, 2),
              ])
            }).pipe(Effect.provide(layer))
          }),
        ),
      ),
    10_000,
  )
})
