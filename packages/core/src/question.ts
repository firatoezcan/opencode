export * as QuestionV2 from "./question"

import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { Context, DateTime, Deferred, Effect, Layer, Schema } from "effect"
import { Question } from "@opencode-ai/schema/question"
import { EventV2 } from "./event"
import { EventTable } from "./event/sql"
import { SessionSchema } from "./session/schema"
import { Location } from "./location"
import { Database } from "./database/database"
import { asc, inArray } from "drizzle-orm"
import { SessionEvent } from "./session/event"
import { SessionProjector } from "./session/projector"
import { SessionStore } from "./session/store"

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

export const toModelOutput = (questions: ReadonlyArray<Prompt>, answers: ReadonlyArray<Answer>) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

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

export type ReplyState = "active" | "recovered"

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<ReplyState, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

export type PendingRequest = EventV2.Payload<typeof Event.Asked>

export interface PendingRequestsInterface {
  readonly get: (requestID: ID) => Effect.Effect<PendingRequest | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<PendingRequest>>
}

export class PendingRequests extends Context.Service<PendingRequests, PendingRequestsInterface>()(
  "@opencode/v2/Question/PendingRequests",
) {}

const pendingRequestsLayer = Layer.effect(
  PendingRequests,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const definitions = {
      asked: Event.Asked,
      replied: Event.Replied,
      rejected: Event.Rejected,
      succeeded: SessionEvent.Tool.Success,
    }
    const durable = {
      asked: definitions.asked.durable,
      replied: definitions.replied.durable,
      rejected: definitions.rejected.durable,
      succeeded: definitions.succeeded.durable,
    }
    if (!durable.asked || !durable.replied || !durable.rejected || !durable.succeeded)
      return yield* Effect.die("Pending question events must be durable")
    const askedVersion = durable.asked.version
    const types = {
      asked: EventV2.versionedType(definitions.asked.type, askedVersion),
      replied: EventV2.versionedType(definitions.replied.type, durable.replied.version),
      rejected: EventV2.versionedType(definitions.rejected.type, durable.rejected.version),
      succeeded: EventV2.versionedType(definitions.succeeded.type, durable.succeeded.version),
    }
    const stored = yield* db
      .select()
      .from(EventTable)
      .where(inArray(EventTable.type, Object.values(types)))
      .orderBy(asc(EventTable.aggregate_id), asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    type PendingState = {
      readonly asked: PendingRequest
      readonly answers?: ReadonlyArray<Answer>
    }
    const requests = stored.reduce((pending, row) => {
      if (row.type === types.asked) {
        const data = Schema.decodeUnknownSync(Event.Asked.data)(row.data)
        pending.set(data.id, {
          asked: {
            id: row.id,
            type: Event.Asked.type,
            durable: {
              aggregateID: row.aggregate_id,
              seq: row.seq,
              version: askedVersion,
            },
            data,
          },
        })
        return pending
      }
      if (row.type === types.replied) {
        const data = Schema.decodeUnknownSync(Event.Replied.data)(row.data)
        const state = pending.get(data.requestID)
        if (!state) return pending
        if (state.asked.data.tool) pending.set(data.requestID, { ...state, answers: data.answers })
        else pending.delete(data.requestID)
        return pending
      }
      if (row.type === types.rejected) {
        pending.delete(Schema.decodeUnknownSync(Event.Rejected.data)(row.data).requestID)
        return pending
      }
      const data = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)(row.data)
      for (const [requestID, state] of pending) {
        const tool = state.asked.data.tool
        if (tool?.messageID === data.assistantMessageID && tool.callID === data.callID) pending.delete(requestID)
      }
      return pending
    }, new Map<ID, PendingState>())
    yield* events.project(Event.Asked, (event) =>
      Effect.sync(() => {
        requests.set(event.data.id, { asked: event })
      }),
    )
    yield* events.project(Event.Replied, (event) =>
      Effect.sync(() => {
        const state = requests.get(event.data.requestID)
        if (!state) return
        if (state.asked.data.tool) requests.set(event.data.requestID, { ...state, answers: event.data.answers })
        else requests.delete(event.data.requestID)
      }),
    )
    yield* events.project(Event.Rejected, (event) =>
      Effect.sync(() => {
        requests.delete(event.data.requestID)
      }),
    )
    yield* events.project(SessionEvent.Tool.Success, (event) =>
      Effect.sync(() => {
        for (const [requestID, state] of requests) {
          const tool = state.asked.data.tool
          if (tool?.messageID === event.data.assistantMessageID && tool.callID === event.data.callID)
            requests.delete(requestID)
        }
      }),
    )
    for (const state of requests.values()) {
      const tool = state.asked.data.tool
      if (!state.answers || !tool) continue
      yield* events.publish(SessionEvent.Tool.Success, {
        timestamp: yield* DateTime.now,
        sessionID: state.asked.data.sessionID,
        assistantMessageID: tool.messageID,
        callID: tool.callID,
        structured: { answers: state.answers.map((answer) => [...answer]) },
        content: [{ type: "text", text: toModelOutput(state.asked.data.questions, state.answers) }],
        result: { answers: state.answers.map((answer) => [...answer]) },
        provider: { executed: false },
      })
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => requests.clear()))
    return PendingRequests.of({
      get: Effect.fn("QuestionV2.PendingRequests.get")((requestID) =>
        Effect.sync(() => {
          const state = requests.get(requestID)
          return state?.answers ? undefined : state?.asked
        }),
      ),
      list: Effect.fn("QuestionV2.PendingRequests.list")(() =>
        Effect.sync(() => Array.from(requests.values()).flatMap((state) => (state.answers ? [] : [state.asked]))),
      ),
    })
  }),
)

export const pendingRequestsNode = makeGlobalNode({
  service: PendingRequests,
  layer: pendingRequestsLayer,
  deps: [EventV2.node, Database.node, SessionProjector.node],
})

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
    const sessions = yield* SessionStore.Service
    const requestLocation = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
    const pending = new Map<ID, PendingQuestion>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
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
          return yield* events.publish(Event.Asked, request, { id: asked.id, location: requestLocation }).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          const request = existing?.request ?? (yield* pendingRequests.get(input.requestID))?.data
          if (!request) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: request.sessionID,
            requestID: request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
          if (!existing && request.tool) {
            yield* events.publish(SessionEvent.Tool.Success, {
              timestamp: yield* DateTime.now,
              sessionID: request.sessionID,
              assistantMessageID: request.tool.messageID,
              callID: request.tool.callID,
              structured: { answers: input.answers.map((answer) => [...answer]) },
              content: [{ type: "text", text: toModelOutput(request.questions, input.answers) }],
              result: { answers: input.answers.map((answer) => [...answer]) },
              provider: { executed: false },
            })
          }
          if (existing) yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
          return existing ? "active" : "recovered"
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          const request = existing?.request ?? (yield* pendingRequests.get(requestID))?.data
          if (!request) return yield* new NotFoundError({ requestID })
          yield* events.publish(Event.Rejected, {
            sessionID: request.sessionID,
            requestID: request.id,
          })
          if (existing) yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      const requests = yield* pendingRequests.list()
      const visible = yield* Effect.forEach(
        requests,
        (event) => {
          if (event.location)
            return Effect.succeed(
              event.location.directory === location.directory && event.location.workspaceID === location.workspaceID,
            )
          return sessions
            .get(event.data.sessionID)
            .pipe(
              Effect.map(
                (session) =>
                  session?.location.directory === location.directory &&
                  session.location.workspaceID === location.workspaceID,
              ),
            )
        },
        { concurrency: "unbounded" },
      )
      return requests.flatMap((event, index) => (visible[index] ? [event.data] : []))
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, pendingRequestsNode, SessionStore.node],
})
