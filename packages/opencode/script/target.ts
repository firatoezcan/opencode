export * as BuildTarget from "./target"

export interface Target {
  readonly os: string
  readonly arch: "arm64" | "x64"
  readonly abi?: "musl"
  readonly avx2?: false
}

export const all: ReadonlyArray<Target> = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

export interface Selection {
  readonly single: boolean
  readonly baseline: boolean
  readonly platform: string
  readonly arch: string
}

export function select(input: Selection): ReadonlyArray<Target> {
  if (!input.single) return all
  return all.filter((item) => {
    if (item.os !== input.platform || item.arch !== input.arch) return false
    if (item.abi !== undefined) return false
    if (item.arch !== "x64") return true
    return input.baseline ? item.avx2 === false : item.avx2 !== false
  })
}

export function name(packageName: string, target: Target) {
  return [
    packageName,
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter(Boolean)
    .join("-")
}
