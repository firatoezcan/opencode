import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_recovered_question")
const layer = AppNodeBuilder.build(SessionExecutionLocal.node, [
  [SessionStore.node, Layer.mock(SessionStore.Service, { get: () => Effect.never })],
  [LocationServiceMap.node, buildLocationServiceMap()],
  [
    QuestionV2.pendingRequestsNode,
    Layer.mock(QuestionV2.PendingRequests, { recoverable: Effect.succeed(new Set([sessionID])) }),
  ],
])
const it = testEffect(layer)

describe("SessionExecutionLocal", () => {
  it.effect("starts recovered question sessions when the execution layer rebuilds", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service

      expect(Array.from(yield* execution.active)).toEqual([sessionID])
    }),
  )
})
