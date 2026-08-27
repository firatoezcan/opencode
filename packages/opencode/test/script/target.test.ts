import { describe, expect, test } from "bun:test"
import { BuildTarget } from "../../script/target"

describe("build target selection", () => {
  test("selects one baseline artifact for an x86_64 Nix build", () => {
    const targets = BuildTarget.select({ single: true, baseline: true, platform: "linux", arch: "x64" })

    expect(targets.map((target) => BuildTarget.name("opencode", target))).toEqual(["opencode-linux-x64-baseline"])
  })
})
