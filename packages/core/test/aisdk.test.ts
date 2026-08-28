import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { MockLanguageModelV3 } from "ai/test"
import { testEffect } from "./lib/effect"

const model = (apiKey: string) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("credential-model"),
    providerID: ProviderV2.ID.make("credential-provider"),
    name: "Credential model",
    api: { type: "aisdk", package: "@ai-sdk/fixture", id: ModelV2.ID.make("credential-model") },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { apiKey } },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_000, output: 100 },
  })

const it = testEffect(AISDK.locationLayer)

describe("AISDK", () => {
  it.effect("constructs a language model with the current credential", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* aisdk.hook.sdk((event) => {
        const credential = String(event.options.apiKey)
        event.sdk = { languageModel: () => new MockLanguageModelV3({ provider: credential }) }
      })

      const first = yield* aisdk.language(model("credential-one"))
      const second = yield* aisdk.language(model("credential-two"))

      expect(first.provider).toBe("credential-one")
      expect(second.provider).toBe("credential-two")
    }),
  )
})
