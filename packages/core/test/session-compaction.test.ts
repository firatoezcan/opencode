import { expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { GenerationOptions, LLMEvent, Message } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"

const events = EventV2.Service.of({
  publish: (definition, data) =>
    Effect.succeed({
      id: EventV2.ID.create(),
      type: definition.type,
      data,
    }),
  subscribe: () => Stream.empty,
  all: () => Stream.empty,
  durable: () => Stream.empty,
  listen: () => Effect.succeed(Effect.void),
  project: () => Effect.void,
  replay: () => Effect.void,
  replayAll: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  claim: () => Effect.void,
})

const compact = async (input: {
  readonly context: number
  readonly output: number
  readonly history: string
  readonly maxTokens?: number
}) => {
  const created = DateTime.makeUnsafe(0)
  const messages = [
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: input.history,
      time: { created },
    }),
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "current request",
      time: { created },
    }),
  ]
  const summaryTokens: number[] = []
  const result = await Effect.runPromise(
    SessionCompaction.make({ events, config: [] }).compactIfNeeded({
      sessionID: SessionV2.ID.make("ses_compaction_output_budget"),
      entries: messages.map((message, seq) => ({ message, seq })),
      limits: { context: input.context, output: input.output },
      request: {
        system: [],
        messages: messages.map((message) => Message.user(message.text)),
        tools: [],
        generation:
          input.maxTokens === undefined ? undefined : GenerationOptions.make({ maxTokens: input.maxTokens }),
      },
      summarize: (_prompt, maxTokens) => {
        summaryTokens.push(maxTokens)
        return Stream.make(LLMEvent.textDelta({ id: "summary", text: "summary" }))
      },
    }),
  )
  return { result, summaryTokens }
}

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction reserves explicit generation budgets, not catalog output capability", async () => {
  const ordinary = await compact({
    context: 500_000,
    output: 500_000,
    history: "a".repeat(120_000),
  })
  const explicit = await compact({
    context: 100_000,
    output: 100_000,
    history: "a".repeat(160_000),
    maxTokens: 64_000,
  })

  expect([ordinary, explicit]).toEqual([
    { result: false, summaryTokens: [] },
    { result: true, summaryTokens: [4_096] },
  ])
})
