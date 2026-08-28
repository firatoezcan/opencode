import {
  isJSONObject,
  isJSONValue,
  type JSONValue,
  type LanguageModelV3,
  type SharedV3ProviderOptions,
} from "@ai-sdk/provider"
import {
  LLMRequest,
  fromAISDKError,
  type ContentPart,
  type ProviderOptions,
  type ToolContent,
  type ToolResultPart,
} from "@opencode-ai/llm"
import { AISDKAdapter } from "../../aisdk-adapter"
import { ModelV2 } from "../../model"
import { Effect, Stream } from "effect"
import { jsonSchema, streamText, tool, type ModelMessage, type ToolModelMessage } from "ai"

export type AISDKRequest = Omit<LLMRequest.Input, "model">
type AISDKToolResultPart = Extract<ToolModelMessage["content"][number], { readonly type: "tool-result" }>

const json = (value: unknown): JSONValue => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Tool result is not JSON serializable")
  const decoded: unknown = JSON.parse(encoded)
  if (!isJSONValue(decoded)) throw new Error("Tool result is not JSON serializable")
  return decoded
}

const aisdkOptions = (value: ProviderOptions | undefined): SharedV3ProviderOptions | undefined => {
  if (!value) return
  const result: SharedV3ProviderOptions = {}
  for (const [provider, options] of Object.entries(value)) {
    const decoded = json(options)
    if (!isJSONObject(decoded)) throw new Error(`AI SDK provider options for ${provider} must be a JSON object`)
    result[provider] = decoded
  }
  return result
}

const text = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const data = (value: string | Uint8Array) => {
  if (typeof value !== "string") return value
  try {
    return new URL(value)
  } catch {
    return value
  }
}

const toolResult = (part: ToolResultPart): AISDKToolResultPart => {
  const output = ((): AISDKToolResultPart["output"] => {
    switch (part.result.type) {
      case "text":
        return { type: "text" as const, value: text(part.result.value) }
      case "json":
        return { type: "json" as const, value: json(part.result.value) }
      case "error":
        return { type: "error-text" as const, value: text(part.result.value) }
      case "content":
        return {
          type: "content" as const,
          value: part.result.value.map((item: ToolContent) =>
            item.type === "text"
              ? { type: "text" as const, text: item.text }
              : { type: "file-url" as const, url: item.uri },
          ),
        }
      default:
        throw new Error("Unsupported AI SDK tool result")
    }
  })()
  return {
    type: "tool-result",
    toolCallId: part.id,
    toolName: part.name,
    output,
    providerOptions: aisdkOptions(part.providerMetadata),
  }
}

const userPart = (part: ContentPart) => {
  switch (part.type) {
    case "text":
      return { type: "text" as const, text: part.text, providerOptions: aisdkOptions(part.providerMetadata) }
    case "media": {
      const value = data(part.data)
      return part.mediaType.startsWith("image/")
        ? { type: "image" as const, image: value, mediaType: part.mediaType }
        : { type: "file" as const, data: value, mediaType: part.mediaType, filename: part.filename }
    }
    default:
      throw new Error(`Unsupported ${part.type} content in an AI SDK user message`)
  }
}

const assistantPart = (part: ContentPart) => {
  switch (part.type) {
    case "text":
      return { type: "text" as const, text: part.text, providerOptions: aisdkOptions(part.providerMetadata) }
    case "reasoning":
      return { type: "reasoning" as const, text: part.text, providerOptions: aisdkOptions(part.providerMetadata) }
    case "media":
      return {
        type: "file" as const,
        data: data(part.data),
        mediaType: part.mediaType,
        filename: part.filename,
      }
    case "tool-call":
      return {
        type: "tool-call" as const,
        toolCallId: part.id,
        toolName: part.name,
        input: part.input,
        providerExecuted: part.providerExecuted,
        providerOptions: aisdkOptions(part.providerMetadata),
      }
    case "tool-result":
      return toolResult(part)
  }
}

const messages = (request: AISDKRequest): ModelMessage[] =>
  request.messages.map((item) => {
    switch (item.role) {
      case "system":
        return {
          role: "system",
          content: item.content
            .map((part) => {
              if (part.type !== "text") throw new Error(`Unsupported ${part.type} content in an AI SDK system message`)
              return part.text
            })
            .join("\n"),
        }
      case "user":
        return { role: "user", content: item.content.map(userPart) }
      case "assistant":
        return { role: "assistant", content: item.content.map(assistantPart) }
      case "tool":
        return {
          role: "tool",
          content: item.content.map((part) => {
            if (part.type !== "tool-result")
              throw new Error(`Unsupported ${part.type} content in an AI SDK tool message`)
            return toolResult(part)
          }),
        }
    }
  })

const providerOptions = (model: ModelV2.Info, language: LanguageModelV3, request: AISDKRequest) => {
  const body = Object.fromEntries(Object.entries(model.request.body).filter(([key]) => key !== "apiKey"))
  const http = request.http?.body ?? {}
  if (Object.keys(body).length === 0 && Object.keys(http).length === 0) return aisdkOptions(request.providerOptions)
  const key = language.provider.split(".")[0] || model.providerID
  return aisdkOptions({
    ...request.providerOptions,
    [key]: { ...request.providerOptions?.[key], ...body, ...http },
  })
}

const failure = (error: unknown) => fromAISDKError(error, { module: "ai-sdk", method: "streamText" })

export const streamAISDK = (model: ModelV2.Info, language: LanguageModelV3, request: AISDKRequest) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      ).pipe(
        Effect.map((controller) => {
          const definitions = Object.fromEntries(
            request.tools.map((item) => [
              item.name,
              item.outputSchema
                ? tool({
                    description: item.description,
                    inputSchema: jsonSchema(item.inputSchema),
                    outputSchema: jsonSchema(item.outputSchema),
                  })
                : tool({ description: item.description, inputSchema: jsonSchema(item.inputSchema) }),
            ]),
          )
          const choice = (() => {
            if (request.toolChoice?.type !== "tool") return request.toolChoice?.type
            if (!request.toolChoice.name) throw new Error("Named AI SDK tool choice requires a tool name")
            return { type: "tool" as const, toolName: request.toolChoice.name }
          })()
          const generation = request.generation
          const result = streamText({
            model: language,
            system:
              request.system.length === 0
                ? undefined
                : request.system.map((part) => ({ role: "system" as const, content: part.text })),
            messages: messages(request),
            tools: definitions,
            toolChoice: choice,
            maxRetries: 0,
            abortSignal: controller.signal,
            headers: { ...model.request.headers, ...request.http?.headers },
            providerOptions: providerOptions(model, language, request),
            maxOutputTokens: generation?.maxTokens,
            temperature: generation?.temperature,
            topP: generation?.topP,
            topK: generation?.topK,
            presencePenalty: generation?.presencePenalty,
            frequencyPenalty: generation?.frequencyPenalty,
            seed: generation?.seed,
            stopSequences: generation?.stop ? [...generation.stop] : undefined,
          })
          const state = AISDKAdapter.adapterState()
          return Stream.fromAsyncIterable(result.fullStream, failure).pipe(
            Stream.mapEffect((event) => AISDKAdapter.toLLMEvents(state, event)),
            Stream.flatMap(Stream.fromIterable),
            Stream.mapError(failure),
          )
        }),
      ),
    ),
  )
