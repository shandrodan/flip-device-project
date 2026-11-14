import { useSyncExternalStore } from "react";

/** The mic while it is held: how loud, and whether it is still listening.
 *  The Agent view reads it so its own bot pulses instead of a full-screen Talk overlay. */
export type TalkLive = { agentId: string; phase: "listen" | "saving"; level: number } | null;

let live: TalkLive = null;
const subs = new Set<() => void>();

export function setTalkLive(next: TalkLive) {
  live = next;
  subs.forEach(f => f());
}

export function useTalkLive(): TalkLive {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => live);
}
