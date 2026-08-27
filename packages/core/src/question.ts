export * as QuestionV2 from "./question"

import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
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

export type RecoveryState = "active" | "recovered"

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<RecoveryState, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<RecoveryState, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

export type PendingRequest = EventV2.Payload<typeof Event.Asked>

export type RecoveredRequest =
  | {
      readonly _tag: "Replied"
      readonly request: Request & { readonly tool: Tool }
      readonly answers: ReadonlyArray<Answer>
      readonly settled: boolean
    }
  | {
      readonly _tag: "Rejected"
      readonly request: Request & { readonly tool: Tool }
    }

export interface PendingRequestsInterface {
  readonly get: (requestID: ID) => Effect.Effect<PendingRequest | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<PendingRequest>>
  readonly recoverable: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly recoveries: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<RecoveredRequest>>
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
      failed: SessionEvent.Tool.Failed,
      continued: SessionEvent.Step.Started,
    }
    const durable = {
      asked: definitions.asked.durable,
      replied: definitions.replied.durable,
      rejected: definitions.rejected.durable,
      succeeded: definitions.succeeded.durable,
      failed: definitions.failed.durable,
      continued: definitions.continued.durable,
    }
    if (
      !durable.asked ||
      !durable.replied ||
      !durable.rejected ||
      !durable.succeeded ||
      !durable.failed ||
      !durable.continued
    )
      return yield* Effect.die("Pending question events must be durable")
    const askedVersion = durable.asked.version
    const types = {
      asked: EventV2.versionedType(definitions.asked.type, askedVersion),
      replied: EventV2.versionedType(definitions.replied.type, durable.replied.version),
      rejected: EventV2.versionedType(definitions.rejected.type, durable.rejected.version),
      succeeded: EventV2.versionedType(definitions.succeeded.type, durable.succeeded.version),
      failed: EventV2.versionedType(definitions.failed.type, durable.failed.version),
      continued: EventV2.versionedType(definitions.continued.type, durable.continued.version),
    }
    const stored = yield* db
      .select()
      .from(EventTable)
      .where(inArray(EventTable.type, Object.values(types)))
      .orderBy(asc(EventTable.aggregate_id), asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    type Resolution =
      | { readonly _tag: "Replied"; readonly answers: ReadonlyArray<Answer>; readonly settled: boolean }
      | { readonly _tag: "Rejected" }
    type PendingState = {
      readonly asked: PendingRequest
      readonly resolution?: Resolution
    }
    const replyRequest = (pending: Map<ID, PendingState>, data: EventV2.Data<typeof Event.Replied>) => {
      const state = pending.get(data.requestID)
      if (!state) return
      if (state.asked.data.tool)
        pending.set(data.requestID, {
          ...state,
          resolution: { _tag: "Replied", answers: data.answers, settled: false },
        })
      else pending.delete(data.requestID)
    }
    const rejectRequest = (pending: Map<ID, PendingState>, data: EventV2.Data<typeof Event.Rejected>) => {
      const state = pending.get(data.requestID)
      if (!state) return
      if (state.asked.data.tool) pending.set(data.requestID, { ...state, resolution: { _tag: "Rejected" } })
      else pending.delete(data.requestID)
    }
    const settleTool = (
      pending: Map<ID, PendingState>,
      identity: { readonly assistantMessageID: Tool["messageID"]; readonly callID: string },
      succeeded: boolean,
    ) => {
      for (const [requestID, state] of pending) {
        const tool = state.asked.data.tool
        if (tool?.messageID !== identity.assistantMessageID || tool.callID !== identity.callID) continue
        if (succeeded && state.resolution?._tag === "Replied")
          pending.set(requestID, { ...state, resolution: { ...state.resolution, settled: true } })
        else pending.delete(requestID)
      }
    }
    const continueSession = (pending: Map<ID, PendingState>, sessionID: SessionSchema.ID) => {
      for (const [requestID, state] of pending) {
        if (
          state.resolution?._tag === "Replied" &&
          state.resolution.settled &&
          state.asked.data.sessionID === sessionID
        )
          pending.delete(requestID)
      }
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
        replyRequest(pending, Schema.decodeUnknownSync(Event.Replied.data)(row.data))
        return pending
      }
      if (row.type === types.rejected) {
        rejectRequest(pending, Schema.decodeUnknownSync(Event.Rejected.data)(row.data))
        return pending
      }
      if (row.type === types.succeeded) {
        settleTool(pending, Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)(row.data), true)
        return pending
      }
      if (row.type === types.failed) {
        settleTool(pending, Schema.decodeUnknownSync(SessionEvent.Tool.Failed.data)(row.data), false)
        return pending
      }
      continueSession(pending, Schema.decodeUnknownSync(SessionEvent.Step.Started.data)(row.data).sessionID)
      return pending
    }, new Map<ID, PendingState>())
    yield* events.project(Event.Asked, (event) =>
      Effect.sync(() => {
        requests.set(event.data.id, { asked: event })
      }),
    )
    yield* events.project(Event.Replied, (event) =>
      Effect.sync(() => replyRequest(requests, event.data)),
    )
    yield* events.project(Event.Rejected, (event) =>
      Effect.sync(() => rejectRequest(requests, event.data)),
    )
    yield* events.project(SessionEvent.Tool.Success, (event) =>
      Effect.sync(() => settleTool(requests, event.data, true)),
    )
    yield* events.project(SessionEvent.Tool.Failed, (event) =>
      Effect.sync(() => settleTool(requests, event.data, false)),
    )
    yield* events.project(SessionEvent.Step.Started, (event) =>
      Effect.sync(() => continueSession(requests, event.data.sessionID)),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => requests.clear()))
    const findRecoveries = (sessionID?: SessionSchema.ID) => {
      const result: RecoveredRequest[] = []
      for (const state of requests.values()) {
        const tool = state.asked.data.tool
        const resolution = state.resolution
        if (!resolution || !tool || (sessionID !== undefined && state.asked.data.sessionID !== sessionID)) continue
        const request = { ...state.asked.data, tool }
        if (resolution._tag === "Rejected") result.push({ _tag: "Rejected", request })
        else
          result.push({
            _tag: "Replied",
            request,
            answers: resolution.answers,
            settled: resolution.settled,
          })
      }
      return result
    }
    return PendingRequests.of({
      get: Effect.fn("QuestionV2.PendingRequests.get")((requestID) =>
        Effect.sync(() => {
          const state = requests.get(requestID)
          return state?.resolution ? undefined : state?.asked
        }),
      ),
      list: Effect.fn("QuestionV2.PendingRequests.list")(() =>
        Effect.sync(() => Array.from(requests.values()).flatMap((state) => (state.resolution ? [] : [state.asked]))),
      ),
      recoverable: Effect.sync(() => new Set(findRecoveries().map((recovery) => recovery.request.sessionID))),
      recoveries: Effect.fn("QuestionV2.PendingRequests.recoveries")((sessionID) =>
        Effect.sync(() => findRecoveries(sessionID)),
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
          return existing ? "active" : "recovered"
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
