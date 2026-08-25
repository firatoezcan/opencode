import type { GroupInfo, GroupItem, LocationRef, PersistentPtyInfo } from "@opencode-ai/client"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useData } from "./data"
import { useStorage } from "./storage"
import { useEvent } from "./event"
import { createSignal, onCleanup } from "solid-js"

type PaneWorkspace = {
  sessionID?: string
  groupID: string
  items: GroupItem[]
  terminals: PersistentPtyInfo[]
  selectedTerminalID?: string
}

type PaneLayoutState = {
  workspaces: Record<string, PaneWorkspace>
}

export const { use: usePaneLayout, provider: PaneLayoutProvider } = createSimpleContext({
  name: "PaneLayout",
  init: () => {
    const client = useClient()
    const data = useData()
    const event = useEvent()
    const [focus, setFocus] = createSignal<string>()
    const [store, update] = useStorage().store<PaneLayoutState>("pane-workspace-v1", {
      initial: { workspaces: {} },
    })

    const save = async (key: string, group: GroupInfo, sessionID?: string, selectedTerminalID?: string) => {
      const terminals = await client.api["server.persistentPty"].list({ groupID: group.id })
      await update((draft) => {
        if (group.items.length === 0) {
          delete draft.workspaces[key]
          return
        }
        const current = draft.workspaces[key]?.selectedTerminalID
        const selected = selectedTerminalID ?? current
        draft.workspaces[key] = {
          sessionID,
          groupID: group.id,
          items: group.items,
          terminals,
          selectedTerminalID: terminals.some((terminal) => terminal.id === selected) ? selected : terminals.at(-1)?.id,
        }
      })
    }

    const syncGroup = (groupID: string) => {
      const workspaces = Object.entries(store.workspaces).filter((entry) => entry[1].groupID === groupID)
      if (workspaces.length === 0) return
      void client.api["server.persistentPty"].group
        .get({ groupID })
        .then((group) => Promise.all(workspaces.map(([key, workspace]) => save(key, group, workspace.sessionID))))
        .catch((error) => console.error("Failed to sync terminal workspace", error))
    }

    onCleanup(
      event.on("group.item.added", (evt) => {
        syncGroup(evt.data.groupID)
      }),
    )

    onCleanup(
      event.on("group.item.removed", (evt) => {
        syncGroup(evt.data.groupID)
      }),
    )

    return {
      get(sessionID: string) {
        return store.workspaces[sessionID]
      },
      async load(sessionID: string) {
        const current = store.workspaces[sessionID]
        if (current) {
          const group = await client.api["server.persistentPty"].group.get({ groupID: current.groupID })
          await save(sessionID, group, sessionID)
          return
        }
        const groups = await client.api["server.persistentPty"].group.list()
        const group = groups.find((item) =>
          item.items.some((entry) => entry.type === "session" && entry.id === sessionID),
        )
        if (group) await save(sessionID, group, sessionID)
      },
      getGroup(groupID: string) {
        return store.workspaces[groupID]
      },
      async loadGroup(groupID: string) {
        await save(groupID, await client.api["server.persistentPty"].group.get({ groupID }))
      },
      async refresh(key: string) {
        const current = store.workspaces[key]
        if (!current) return
        const group = await client.api["server.persistentPty"].group.get({ groupID: current.groupID })
        await save(key, group, current.sessionID)
      },
      selectTerminal(key: string, ptyID: string) {
        setFocus(ptyID)
        return update((draft) => {
          const workspace = draft.workspaces[key]
          if (!workspace?.terminals.some((terminal) => terminal.id === ptyID)) return
          workspace.selectedTerminalID = ptyID
        })
      },
      async newTerminal(sessionID: string, options?: { focus?: boolean }): Promise<PersistentPtyInfo> {
        const api = client.api["server.persistentPty"]
        const current = store.workspaces[sessionID]
        const existing = current
          ? await api.group.get({ groupID: current.groupID })
          : (await api.group.list()).find((group) =>
              group.items.some((item) => item.type === "session" && item.id === sessionID),
            )
        const group = existing ?? (await api.group.create({ items: [{ type: "session", id: sessionID }] }))
        const session = data.session.get(sessionID)
        const terminal = await api.create({
          groupID: group.id,
          command: process.env.SHELL || "/bin/sh",
          args: [],
          cwd: session?.location.directory ?? process.cwd(),
          title: "Terminal",
          env: {},
        })
        const next = await api.group.get({ groupID: group.id })
        if (options?.focus !== false) setFocus(terminal.id)
        await save(sessionID, next, sessionID, terminal.id)
        return terminal
      },
      async newTerminalInGroup(groupID: string, cwd: string): Promise<PersistentPtyInfo> {
        const api = client.api["server.persistentPty"]
        const terminal = await api.create({
          groupID,
          command: process.env.SHELL || "/bin/sh",
          args: [],
          cwd,
          title: "Terminal",
          env: {},
        })
        setFocus(terminal.id)
        await save(groupID, await api.group.get({ groupID }), undefined, terminal.id)
        return terminal
      },
      async newTerminalWorkspace(location: LocationRef) {
        const api = client.api["server.persistentPty"]
        const group = await api.group.create({ items: [] })
        const terminal = await api
          .create({
            groupID: group.id,
            command: process.env.SHELL || "/bin/sh",
            args: [],
            cwd: location.directory,
            title: "Terminal",
            env: {},
          })
          .catch(async (error) => {
            await api.group.remove({ groupID: group.id }).catch(() => undefined)
            throw error
          })
        await save(group.id, await api.group.get({ groupID: group.id }), undefined, terminal.id)
        return { group, terminal }
      },
      shouldFocus(ptyID: string) {
        return focus() === ptyID
      },
      clearFocus(ptyID: string) {
        setFocus((current) => (current === ptyID ? undefined : current))
      },
    }
  },
})
