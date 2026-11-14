import { createContext, useContext, useEffect } from "react";
import type { AppId, Snapshot } from "@app/protocol";
import type { VoiceSource } from "../voice/capture";

export type Fn = "home" | "notes" | "todo" | "build" | "agents" | "focus" | "settings" | "dock";
export type Route =
  | { name: "suggest"; noteId: string }
  | { name: "note"; noteId: string }
  | { name: "task"; taskId: string }
  | { name: "agent"; agentId: string }
  | { name: "create"; app?: AppId }
  | { name: "appAgents"; app: AppId; start?: "add" | "change" | "remove" | "delete" }
  | { name: "agentLook"; agentId: string };

export const HANDHELD_FNS: Fn[] = ["home", "notes", "todo", "build", "agents", "focus", "settings"];
// device-controls.md: docked, the system wheel steps through the companion functions.
export const DOCK_FNS: Fn[] = ["dock", "agents", "focus", "todo"];
export const FN_LABEL: Record<Fn, string> = { home: "Home", notes: "Notes", todo: "To-Do", build: "Build", agents: "Agents", focus: "Focus", settings: "Settings", dock: "Dock" };

export type TalkTarget =
  | { kind: "note" }
  | { kind: "append"; noteId: string }
  | { kind: "main" }
  | { kind: "app"; app: AppId }
  | { kind: "agent"; agentId: string }
  /** Dictation into a text field (ADR 0017). "name" keeps the first three words, "text" the whole sentence. */
  | { kind: "text"; purpose: "name" | "text"; label: string; onText: (t: string) => void };

export interface AppCtx {
  snap: Snapshot;
  online: boolean;
  docked: boolean;
  fn: Fn;
  route: Route | null;
  go(fn: Fn): void;
  push(r: Route): void;
  replace(r: Route): void;
  back(): void;
  toast(text: string): void;
  voice: VoiceSource;
  /** Say what the mic does while something is shown. The newest one wins; call the result to remove it. */
  addTalkTarget(t: TalkTarget | null): () => void;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

/** A screen (or a sheet on top of it) says what holding the mic should do while it is shown.
 *  Targets stack: when a sheet closes, the screen under it gets the mic back. */
export function useTalkTarget(t: TalkTarget | null, deps: unknown[], active = true) {
  const { addTalkTarget } = useApp();
  useEffect(() => {
    if (!active) return;
    return addTalkTarget(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, active]);
}
