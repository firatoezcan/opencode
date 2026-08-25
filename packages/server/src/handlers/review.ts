import { Snapshot } from "@opencode-ai/core/snapshot"
import { UnknownError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ReviewHandler = HttpApiBuilder.group(Api, "server.review", (handlers) =>
  handlers.handle("review.diff", (ctx) =>
    response(
      Snapshot.Service.use((snapshot) => snapshot.review({ context: ctx.query.context })).pipe(
        Effect.catchTag("Snapshot.Error", (error) => {
          const ref = `err_${crypto.randomUUID().slice(0, 8)}`
          return Effect.logError("failed to generate review diff", { cause: error }).pipe(
            Effect.andThen(
              Effect.fail(
                new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
              ),
            ),
          )
        }),
      ),
    ),
  ),
)
