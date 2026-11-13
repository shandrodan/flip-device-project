import { createContext, useContext, useEffect } from "react";
import type { Snapshot } from "@app/protocol";
import type { VoiceSource } from "../voice/capture";

export type Fn = "home" | "notes" | "todo" | "agents" | "focus" | "settings" | "dock";
export type Route =
  | { name: "suggest"; noteId: string }
  | { name: "note"; noteId: string }
  | { name: "task"; taskId: string }
  | { name: "agent"; agentId: string }
  | { name: "create" };

export const HANDHELD_FNS: Fn[] = ["home", "notes", "todo", "agents", "focus", "settings"];
// device-controls.md: docked, the system wheel steps through the companion functions.
export const DOCK_FNS: Fn[] = ["dock", "agents", "focus", "todo"];
export const FN_LABEL: Record<Fn, string> = { home: "Home", notes: "Notes", todo: "To-Do", agents: "Agents", focus: "Focus", settings: "Settings", dock: "Dock" };

export type TalkTarget = { kind: "note" } | { kind: "append"; noteId: string } | { kind: "name"; onText: (t: string) => void };

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
  setTalkTarget(t: TalkTarget | null): void;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

/** A screen says what holding the mic should do while it is shown. */
export function useTalkTarget(t: TalkTarget | null, deps: unknown[]) {
  const { setTalkTarget } = useApp();
  useEffect(() => {
    setTalkTarget(t);
    return () => setTalkTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
