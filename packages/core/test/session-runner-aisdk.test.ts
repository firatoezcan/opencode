import { APICallError } from "@ai-sdk/provider"
import { AISDK } from "@opencode-ai/core/aisdk"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
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
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { streamAISDK, type AISDKRequest } from "@opencode-ai/core/session/runner/aisdk-runtime"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { GenerationOptions, LLMEvent, Message, ModelID } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const providerID = ProviderV2.ID.make("aisdk-fixture")
const integrationID = Integration.ID.make("aisdk-fixture")
const genericModelID = ModelV2.ID.make("generic-model")
const nativeModelID = ModelV2.ID.make("native-model")
const nativeRouteModelID = ModelID.make("native-model")
const rateLimitModelID = ModelV2.ID.make("rate-limit-model")

const successfulLanguage = new MockLanguageModelV3({
  provider: providerID,
  modelId: genericModelID,
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

const rateLimitLanguage = new MockLanguageModelV3({
  provider: providerID,
  modelId: rateLimitModelID,
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        {
          type: "error",
          error: new APICallError({
            message: "Rate limited",
            url: "https://provider.example/v1/responses",
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { "retry-after": "2", "x-request-id": "request-123" },
            responseBody: '{"error":"rate limit"}',
            isRetryable: true,
          }),
        },
      ],
    }),
  }),
})

const aisdk = Layer.mock(AISDK.Service, {
  hook: {
    sdk: () => Effect.succeed({ dispose: Effect.void }),
    language: () => Effect.succeed({ dispose: Effect.void }),
  },
  runSDK: Effect.succeed,
  runLanguage: Effect.succeed,
  language: (model) =>
    Effect.sync(() => {
      if (model.id === nativeModelID) throw new Error("native catalog model used the AI SDK runtime")
      if (model.request.body.apiKey !== "fixture-secret")
        throw new Error("active Integration credential was not applied")
      return model.id === rateLimitModelID ? rateLimitLanguage : successfulLanguage
    }),
})

const llm = Layer.mock(LLMClient.Service, {
  stream: (request) =>
    request.model.id === nativeRouteModelID
      ? Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "native-text" }),
          LLMEvent.textDelta({ id: "native-text", text: "Hello from native runtime." }),
          LLMEvent.textEnd({ id: "native-text" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      : Stream.die("native LLM runtime should not execute"),
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

test("AI SDK requests omit implicit output limits and preserve explicit limits", async () => {
  const language = new MockLanguageModelV3({
    provider: providerID,
    modelId: genericModelID,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 0, text: 0, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  })
  const model = ModelV2.Info.make({
    ...ModelV2.Info.empty(providerID, genericModelID),
    api: { type: "aisdk", package: "@ai-sdk/fixture", id: genericModelID },
    limit: { context: 500_000, output: 500_000 },
  })
  const request: AISDKRequest = {
    system: [],
    messages: [Message.user("Say hello.")],
    tools: [],
  }

  await Effect.runPromise(Stream.runDrain(streamAISDK(model, language, request)))
  await Effect.runPromise(
    Stream.runDrain(
      streamAISDK(model, language, {
        ...request,
        generation: GenerationOptions.make({ maxTokens: 4_096 }),
      }),
    ),
  )

  expect(language.doStreamCalls.map((call) => call.maxOutputTokens)).toEqual([undefined, 4_096])
})

type SessionFixture = {
  readonly sessionID: SessionV2.ID
  readonly modelID: ModelV2.ID
  readonly package: string
  readonly url?: string
}

const runSession = (input: SessionFixture) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.gen(function* () {
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
        const services = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const integrations = yield* Integration.Service
          yield* integrations.transform((editor) =>
            editor.method.update({ integrationID, method: { type: "key", label: "API key" } }),
          )
          yield* integrations.connection.key({ integrationID, key: "fixture-secret" })
          yield* Catalog.Service.use((catalog) =>
            catalog.transform((editor) => {
              editor.provider.update(providerID, (provider) => {
                provider.integrationID = integrationID
                provider.api = { type: "aisdk", package: input.package }
              })
              editor.model.update(providerID, input.modelID, (model) => {
                model.api = {
                  type: "aisdk",
                  package: input.package,
                  id: input.modelID,
                  ...(input.url === undefined ? {} : { url: input.url }),
                }
                model.capabilities = { tools: true, input: ["text"], output: ["text"] }
                model.limit = { context: 100_000, output: 1_024 }
              })
            }),
          )

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
              id: input.sessionID,
              project_id: Project.ID.global,
              slug: "test",
              directory: location.directory,
              title: "test",
              version: "test",
              model: { providerID, id: input.modelID },
            })
            .run()
            .pipe(Effect.orDie)

          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID: input.sessionID,
            prompt: Prompt.make({ text: "Say hello." }),
            resume: false,
          })
          yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: input.sessionID, force: true })).pipe(
            Effect.exit,
          )
          const events = yield* db
            .select({ type: EventTable.type, data: EventTable.data })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, input.sessionID))
            .orderBy(EventTable.seq)
            .all()
            .pipe(Effect.orDie)
          return { messages: yield* session.context(input.sessionID), events }
        }).pipe(Effect.provide(services.get(location)))
      }),
    ),
  )

describe("SessionRunnerLLM catalog runtimes", () => {
  it.live("executes a generic AI SDK model through a V2 Session", () =>
    Effect.gen(function* () {
      const result = yield* runSession({
        sessionID: SessionV2.ID.make("ses_runner_aisdk"),
        modelID: genericModelID,
        package: "@ai-sdk/fixture",
      })

      expect(result.messages).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Hello from AI SDK." }] },
      ])
      expect(result.events.map((event) => event.type)).toEqual([
        "session.next.prompt.admitted.1",
        "session.next.prompted.1",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])
    }),
  )

  it.live("keeps a native-supported catalog model on the native runtime", () =>
    Effect.gen(function* () {
      const result = yield* runSession({
        sessionID: SessionV2.ID.make("ses_runner_native"),
        modelID: nativeModelID,
        package: "@ai-sdk/openai",
        url: "https://openai.example/v1",
      })

      expect(result.messages).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Hello from native runtime." }] },
      ])
    }),
  )

  it.live("preserves AI SDK rate-limit details in V2 Session events", () =>
    Effect.gen(function* () {
      const result = yield* runSession({
        sessionID: SessionV2.ID.make("ses_runner_aisdk_rate_limit"),
        modelID: rateLimitModelID,
        package: "@ai-sdk/fixture",
      })
      const retry = result.events.find((event) => event.type === EventV2.versionedType(SessionEvent.Retried.type, 1))

      expect(result.messages).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "error", error: { message: "Rate limited" } },
      ])
      expect(retry?.data).toMatchObject({
        attempt: 1,
        error: {
          message: "Rate limited",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "2", "x-request-id": "request-123" },
          responseBody: '{"error":"rate limit"}',
        },
      })
    }),
  )
})
