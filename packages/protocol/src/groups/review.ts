import { Location } from "@opencode-ai/schema/location"
import { Revert } from "@opencode-ai/schema/revert"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { UnknownError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ReviewDiffQuery = Schema.Struct({
  ...LocationQuery.fields,
  context: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

export const ReviewGroup = HttpApiGroup.make("server.review")
  .add(
    HttpApiEndpoint.get("review.diff", "/api/review/diff", {
      query: ReviewDiffQuery,
      success: Location.response(Schema.Array(Revert.FileDiff)),
      error: UnknownError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.review.diff",
          summary: "Get review diff",
          description: "Get location-scoped changes against the default branch merge base.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "review",
      description: "Location-scoped review routes.",
    }),
  )
