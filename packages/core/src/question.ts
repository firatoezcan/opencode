export * as QuestionV2 from "./question"

import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Question } from "@opencode-ai/schema/question"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { Location } from "./location"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

export type PendingRequest = EventV2.Payload<typeof Event.Asked>

export interface PendingRequestsInterface {
  readonly add: (input: PendingRequest) => Effect.Effect<void>
  readonly remove: (requestID: ID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<PendingRequest>>
}

export class PendingRequests extends Context.Service<PendingRequests, PendingRequestsInterface>()(
  "@opencode/v2/Question/PendingRequests",
) {}

const pendingRequestsLayer = Layer.effect(
  PendingRequests,
  Effect.gen(function* () {
    const requests = new Map<ID, PendingRequest>()
    yield* Effect.addFinalizer(() => Effect.sync(() => requests.clear()))
    return PendingRequests.of({
      add: Effect.fn("QuestionV2.PendingRequests.add")((input) =>
        Effect.sync(() => void requests.set(input.data.id, input)),
      ),
      remove: Effect.fn("QuestionV2.PendingRequests.remove")((requestID) =>
        Effect.sync(() => void requests.delete(requestID)),
      ),
      list: Effect.fn("QuestionV2.PendingRequests.list")(() => Effect.sync(() => [...requests.values()])),
    })
  }),
)

export const pendingRequestsNode = makeGlobalNode({ service: PendingRequests, layer: pendingRequestsLayer, deps: [] })

interface PendingQuestion {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pendingRequests = yield* PendingRequests
    const location = yield* Location.Service
    const requestLocation = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
    const pending = new Map<ID, PendingQuestion>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        pending.values(),
        (item) =>
          Deferred.fail(item.deferred, new RejectedError()).pipe(
            Effect.andThen(pendingRequests.remove(item.request.id)),
          ),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input }
          const asked = {
            id: EventV2.ID.create(),
            type: Event.Asked.type,
            location: requestLocation,
            data: request,
          } satisfies PendingRequest
          pending.set(id, { request, deferred })
          yield* pendingRequests.add(asked)
          return yield* events.publish(Event.Asked, request, { id: asked.id, location: requestLocation }).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }).pipe(Effect.andThen(pendingRequests.remove(id))),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
          yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
          yield* pendingRequests.remove(input.requestID)
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) return yield* new NotFoundError({ requestID })
          yield* events.publish(Event.Rejected, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
          yield* pendingRequests.remove(requestID)
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, pendingRequestsNode],
})
