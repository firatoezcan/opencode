# Legacy Session LLM Runtime Boundaries

`../llm.ts` owns legacy Session concerns: auth, config, model and provider resolution, plugins, permissions, telemetry headers, and runtime selection. Keep the full legacy request shape there.

This folder contains the legacy adapters behind that service:

- `ai-sdk.ts` supplies legacy error-message and `ResponseStreamError` policy to the shared `AISDKAdapter` in `packages/core/src/aisdk-adapter.ts`. It does not own stream-part conversion.
- `native-request.ts` lowers normalized legacy Session input into an `@opencode-ai/llm` request. It does not execute requests.
- `native-runtime.ts` selects and executes the opt-in legacy native route through `LLMClient` and `RequestExecutor`.

Both legacy runtime branches emit the shared `LLMEvent` contract. Keep tool execution Session-owned. Do not import Session services into `native-request.ts`; pass normalized data through `RequestInput`.

V2 runtime selection belongs to `packages/core/src/session/runner/llm.ts`. `SessionRunnerModel.fromCatalogModel` is the single catalog-to-native mapping owner. Native-supported catalog models use `LLMClient`; remaining `aisdk` models use `AISDK.Service.language` and the generic runtime in `packages/core/src/session/runner/aisdk-runtime.ts`.
