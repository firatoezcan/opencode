import { AISDKAdapter } from "@opencode-ai/core/aisdk-adapter"
import { ProviderError } from "@/provider/error"
import { errorMessage } from "@/util/error"

export const adapterState = AISDKAdapter.adapterState

export const toLLMEvents = (state: ReturnType<typeof AISDKAdapter.adapterState>, event: AISDKAdapter.Event) =>
  AISDKAdapter.toLLMEvents(state, event, {
    errorMessage,
    networkError: (message) => new ProviderError.ResponseStreamError(message),
  })

export * as LLMAISDK from "./ai-sdk"
