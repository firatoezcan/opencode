import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const questions = AppNodeBuilder.build(
  LayerNode.group([EventV2.node, QuestionV2.node, QuestionV2.pendingRequestsNode]),
  [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/workspace") }))),
    ],
  ],
)
const it = testEffect(questions)

const sessionID = SessionV2.ID.make("ses_question_test")
const question: QuestionV2.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

const waitForAsk = Effect.fn("QuestionV2Test.waitForAsk")(function* (
  service: QuestionV2.Interface,
  input: QuestionV2.AskInput,
) {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<QuestionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Asked.type
      ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("QuestionV2", () => {
  it.effect("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const pending = yield* QuestionV2.PendingRequests
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.v2.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(request.id).toMatch(/^que_/)
      expect(yield* service.list()).toEqual([request])
      const [pendingAsked] = yield* pending.list()
      expect(pendingAsked).toEqual(
        expect.objectContaining({
          type: QuestionV2.Event.Asked.type,
          data: request,
          location: expect.objectContaining({ directory: expect.any(String) }),
        }),
      )
      expect(pendingAsked?.id).toBe(published[0]?.id)
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
      expect(yield* pending.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [QuestionV2.Event.Asked.type, request],
        [QuestionV2.Event.Replied.type, { sessionID, requestID: request.id, answers: [["One"]] }],
      ])
    }),
  )

  it.effect("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === QuestionV2.Event.Rejected.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* service.reject(request.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])

      const unknown = QuestionV2.ID.ascending("que_unknown")
      expect(yield* service.reply({ requestID: unknown, answers: [] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.effect("settles a replayed pending question through the original tool call", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const request: QuestionV2.Request = {
        id: QuestionV2.ID.ascending(),
        sessionID,
        questions: [question],
        tool: { messageID: SessionMessage.ID.make("msg_recovered"), callID: "call_recovered" },
      }
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* events.publish(QuestionV2.Event.Asked, request, {
        location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
      })

      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.type)).toEqual([
        QuestionV2.Event.Asked.type,
        QuestionV2.Event.Replied.type,
        SessionEvent.Tool.Success.type,
      ])
      expect(published.at(-1)?.data).toMatchObject({
        sessionID,
        assistantMessageID: "msg_recovered",
        callID: "call_recovered",
        structured: { answers: [["One"]] },
        content: [
          {
            type: "text",
            text: 'User has answered your questions: "Which option?"="One". You can now continue with the user\'s answers in mind.',
          },
        ],
        provider: { executed: false },
      })
    }),
  )

  it.effect("isolates pending requests by location-layer instance and rejects them on finalization", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), firstScope), QuestionV2.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), secondScope), QuestionV2.Service)
      const fiber = yield* first.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const request = (yield* first.list())[0]!

      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: request.id }),
      )

      yield* Scope.close(firstScope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      yield* Scope.close(secondScope, Exit.void)
    }),
  )
})
