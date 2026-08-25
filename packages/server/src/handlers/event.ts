import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

export function subscription(events: EventV2.Interface, pendingQuestions: QuestionV2.PendingRequestsInterface) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const connected = {
        id: EventV2.ID.create(),
        type: "server.connected",
        data: {},
      }
      const live = yield* EventV2.allBounded(events, subscriberCapacity)
      const replay = yield* pendingQuestions.list()
      const replayed = new Set(replay.map((event) => event.data.id))
      const isAsked = Schema.is(QuestionV2.Event.Asked)
      return Stream.fromIterable([connected, ...replay]).pipe(
        Stream.concat(live.pipe(Stream.filter((event) => !isAsked(event) || !replayed.has(event.data.id)))),
      )
    }),
  )
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pendingQuestions = yield* QuestionV2.PendingRequests
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const output = subscription(events, pendingQuestions).pipe(
          Stream.map(eventData),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
