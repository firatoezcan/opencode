import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  handlers
    .handle(
      "location.get",
      Effect.fn(function* () {
        const location = yield* Location.Service
        return new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        })
      }),
    )
    .handle(
      "location.reload",
      Effect.fn(function* () {
        const location = yield* Location.Service
        const locations = yield* LocationServiceMap.Service
        yield* locations.invalidate(
          Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
        )
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
