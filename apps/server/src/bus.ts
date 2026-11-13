// A tiny event bus so modules can say "state changed" or push an event without importing the hub.
import type { ServerMessage } from "@app/protocol";

type Emit = (msg: ServerMessage) => void;
let emitFn: Emit = () => {};
let changedFn: () => void = () => {};

export const bus = {
  attach(emit: Emit, changed: () => void) {
    emitFn = emit;
    changedFn = changed;
  },
  /** State changed: a snapshot goes out shortly (debounced). */
  changed() {
    changedFn();
  },
  emit(msg: ServerMessage) {
    emitFn(msg);
  },
  notice(text: string, tone: "info" | "ok" | "warn" | "happy" = "info") {
    emitFn({ type: "notice", text, tone });
  },
};
