import { AISDK } from "@opencode-ai/core/aisdk"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { LLMClient } from "@opencode-ai/llm/route"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const providerID = ProviderV2.ID.make("aisdk-fixture")
const modelID = ModelV2.ID.make("fixture-model")
const integrationID = Integration.ID.make("aisdk-fixture")
const resolved: ModelV2.Info[] = []
const language = new MockLanguageModelV3({
  provider: providerID,
  modelId: modelID,
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hello from AI SDK." },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          logprobs: undefined,
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
        },
      ],
    }),
  }),
})
const aisdk = Layer.mock(AISDK.Service, {
  hook: {
    sdk: () => Effect.succeed({ dispose: Effect.succeed(undefined) }),
    language: () => Effect.succeed({ dispose: Effect.succeed(undefined) }),
  },
  runSDK: Effect.succeed,
  runLanguage: Effect.succeed,
  language: (model) =>
    Effect.sync(() => {
      resolved.push(model)
      return language
    }),
})
const llm = Layer.mock(LLMClient.Service, {
  stream: () => Stream.die("native LLM runtime should not execute"),
})
const permission = Layer.mock(PermissionV2.Service, {})
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const systemContext = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const locations = buildLocationServiceMap([
  [AISDK.node, aisdk],
  [LayerNodePlatform.llmClient, llm],
  [PermissionV2.node, permission],
  [Config.node, config],
  [SkillGuidance.node, systemContext],
  [ReferenceGuidance.node, referenceGuidance],
  [Snapshot.node, Snapshot.noopLayer],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, LocationServiceMap.node, SessionV2.node]), [
    [LocationServiceMap.node, locations],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)

describe("SessionRunnerLLM AI SDK", () => {
  it.live("executes a catalog AI SDK model through a V2 Session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          resolved.length = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const services = yield* LocationServiceMap.Service
          yield* Effect.gen(function* () {
            const integrations = yield* Integration.Service
            yield* integrations.transform((editor) =>
              editor.method.update({
                integrationID,
                method: { type: "key", label: "API key" },
              }),
            )
            yield* integrations.connection.key({ integrationID, key: "fixture-secret" })
            yield* Catalog.Service.use((catalog) =>
              catalog.transform((editor) => {
                editor.provider.update(providerID, (provider) => {
                  provider.integrationID = integrationID
                  provider.api = { type: "aisdk", package: "@ai-sdk/fixture" }
                })
                editor.model.update(providerID, modelID, (model) => {
                  model.api = { type: "aisdk", package: "@ai-sdk/fixture", id: modelID }
                  model.capabilities = { tools: true, input: ["text"], output: ["text"] }
                  model.limit = { context: 100_000, output: 1_024 }
                })
              }),
            )
            expect(
              (yield* Catalog.Service.use((catalog) => catalog.model.available())).map((model) => model.id),
            ).toEqual([modelID])

            const sessionID = SessionV2.ID.make("ses_runner_aisdk")
            const { db } = yield* Database.Service
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "test",
                directory: location.directory,
                title: "test",
                version: "test",
                model: { providerID, id: modelID },
              })
              .run()
              .pipe(Effect.orDie)

            const session = yield* SessionV2.Service
            yield* session.prompt({
              sessionID,
              prompt: Prompt.make({ text: "Say hello." }),
              resume: false,
            })
            yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: true }))

            const messages = yield* session.context(sessionID)
            expect(messages).toHaveLength(2)
            expect(messages[1]).toMatchObject({
              type: "assistant",
              finish: "stop",
              content: [{ type: "text", text: "Hello from AI SDK." }],
            })
            expect(resolved).toHaveLength(1)
            expect(resolved[0]?.request.body.apiKey).toBe("fixture-secret")
            expect(
              (yield* db
                .select({ type: EventTable.type })
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, sessionID))
                .orderBy(EventTable.seq)
                .all()).map((event) => event.type),
            ).toEqual([
              "session.next.prompt.admitted.1",
              "session.next.prompted.1",
              "session.next.step.started.1",
              "session.next.text.started.1",
              "session.next.text.ended.1",
              "session.next.step.ended.2",
            ])
          }).pipe(Effect.provide(services.get(location)))
        }),
      ),
    ),
  )
})
