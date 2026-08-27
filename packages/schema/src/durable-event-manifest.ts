export * as DurableEventManifest from "./durable-event-manifest"

import { Schema } from "effect"
import { Event } from "./event"
import { Question } from "./question"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

const currentSessionDefinitions = Event.inventory(
  ...SessionEvent.DurableDefinitions,
  ...Question.Event.DurableDefinitions,
)
const sessionDefinitions = Event.inventory(
  SessionV1.Event.Created,
  SessionV1.Event.Updated,
  SessionV1.Event.Deleted,
  ...currentSessionDefinitions,
)

export const SessionDurable = {
  definitions: Event.durable(sessionDefinitions),
  schema: Schema.Union(sessionDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type")),
} as const
export type SessionDurableEvent = typeof SessionDurable.schema.Type

export const Durable = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...currentSessionDefinitions,
])
