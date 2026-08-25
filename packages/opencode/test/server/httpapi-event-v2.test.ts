import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { subscription } from "@opencode-ai/server/handlers/event"
import { Effect, Stream } from "effect"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(LayerNode.group([EventV2.node, QuestionV2.pendingRequestsNode]))
const it = testEffect(layer)

describe("V2 event subscription", () => {
  it.effect("replays pending native questions on every subscription", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const pending = yield* QuestionV2.PendingRequests
      const request: QuestionV2.Request = {
        id: QuestionV2.ID.ascending("que_replay"),
        sessionID: SessionV2.ID.make("ses_question_replay"),
        questions: [
          {
            header: "Choice",
            question: "Which option?",
            options: [{ label: "One", description: "First option" }],
          },
        ],
      }
      const location = Location.Ref.make({ directory: AbsolutePath.make("/workspace") })
      yield* pending.add({ request, location })

      const read = subscription(events, pending).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("timed out waiting for pending question replay")),
        }),
      )
      const first = [...(yield* read)]
      const second = [...(yield* read)]

      for (const received of [first, second]) {
        expect(received[0]?.type).toBe("server.connected")
        expect(received[1]).toMatchObject({
          type: QuestionV2.Event.Asked.type,
          data: request,
          location,
        })
      }
    }),
  )
})
