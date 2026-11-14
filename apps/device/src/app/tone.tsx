// App tones and app glyphs.
// Every app has two colours: a bright one (its own screen colour, e.g. the Notes yellow) and a
// dark one in the same hue. On the Home comb an app with no bots is plain grey. Once a bot is
// linked to it, the app circle turns bright with a dark glyph, and the bot fused to it turns
// dark on the same bright circle (its eyes show the bright colour through). Opened anywhere
// else, a linked bot wears the bright colour: that is what tells you which app it works for.
import { useId, type CSSProperties, type ReactNode } from "react";
import type { Agent, AppId, Snapshot } from "@app/protocol";

export type Tone = { bg: string; ink: string };

export const APP_TONE: Record<AppId, Tone> = {
  notes: { bg: "#f5c443", ink: "#846a1c" }, // Notes header yellow
  todo: { bg: "#4aa3ff", ink: "#164a85" }, // To-Do header blue
  agents: { bg: "#a78bfa", ink: "#4a3592" },
  focus: { bg: "#ff8a5c", ink: "#8a3414" },
  settings: { bg: "#b8c4d6", ink: "#3f4b5e" },
  build: { bg: "#f4c534", ink: "#6b5208" }, // the caution-tape yellow around the Build preview
};

/** Bots that belong to an app besides its assigned Task agents (snapshot.appAgents). */
export const APP_BOTS: Partial<Record<AppId, string[]>> = {
  notes: ["main"], // the main agent hears every dump and files it in the right note
};

/** Every bot linked to an app: the fixed ones above, then its assigned Task agents. */
export const botsOf = (snap: Snapshot, fn: AppId) => [...new Set([...(APP_BOTS[fn] ?? []), ...snap.appAgents[fn]])];

/** The app a bot is linked to, if any (the first one, in Home order). */
export const APP_ORDER: AppId[] = ["notes", "todo", "build", "agents", "focus", "settings"];
export function appOfBot(snap: Snapshot | undefined, agentId: string): AppId | undefined {
  return snap ? APP_ORDER.find(fn => botsOf(snap, fn).includes(agentId)) : undefined;
}

/** The colour a bot wears away from the comb. The main agent stays white everywhere. */
export function botColor(agent: Agent, app: AppId | undefined) {
  return app && agent.id !== "main" ? APP_TONE[app].bg : agent.color;
}

/* ------------------------------ Glyphs ------------------------------ */
// Solid, soft-cornered shapes on a 24px grid. Details are cut out of the shape with a mask, so
// whatever sits behind (the bright tone, or grey) shows through, like the bots' eyes.
const CUT = { stroke: "#000", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };

const GLYPHS: Record<AppId, { shape: ReactNode; cut: ReactNode }> = {
  notes: {
    shape: <rect x="4" y="2.5" width="16" height="19" rx="4.5" />,
    cut: <g {...CUT} strokeWidth="2"><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></g>,
  },
  todo: {
    shape: <circle cx="12" cy="12" r="9.5" />,
    cut: <path {...CUT} strokeWidth="2.4" d="M7.8 12.4l2.9 2.9 5.6-6" />,
  },
  agents: {
    // Two bots: one behind, one in front with its eyes cut out.
    shape: <><circle cx="16.6" cy="8.4" r="4.6" /><ellipse cx="10" cy="14.6" rx="7.6" ry="6.6" /></>,
    cut: <><ellipse cx="10" cy="14.6" rx="7.6" ry="6.6" {...CUT} strokeWidth="3" />
      <g {...CUT} strokeWidth="2.3"><path d="M8.2 12.3v3M11.8 12.3v3" /></g></>,
  },
  focus: {
    shape: <><circle cx="12" cy="13.2" r="8.6" /><rect x="9.5" y="1.6" width="5" height="3" rx="1.5" /></>,
    cut: <><path {...CUT} strokeWidth="2.2" d="M12 13.2V8.6" /><circle cx="12" cy="13.2" r="1.7" fill="#000" /></>,
  },
  settings: {
    // A soft gear: a disc with eight round teeth and a hole.
    shape: <><circle cx="12" cy="12" r="7" />{Array.from({ length: 8 }, (_, k) => {
      const a = (k / 8) * Math.PI * 2;
      return <circle key={k} cx={12 + Math.cos(a) * 8} cy={12 + Math.sin(a) * 8} r="2.5" />;
    })}</>,
    cut: <circle cx="12" cy="12" r="3.2" fill="#000" />,
  },
  build: {
    // A window with code brackets cut out of it.
    shape: <rect x="2.5" y="3.5" width="19" height="17" rx="5" />,
    cut: <path {...CUT} strokeWidth="2.2" d="M9.6 9l-3 3 3 3M14.4 9l3 3-3 3" />,
  },
};

export function AppGlyph({ fn, size = 22 }: { fn: AppId; size?: number }) {
  const id = useId();
  const g = GLYPHS[fn];
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect width="24" height="24" fill="#fff" />{g.cut}
    </mask>
    <g fill="currentColor" mask={`url(#${id})`}>{g.shape}</g>
  </svg>;
}

/** CSS custom properties that paint a cell in an app's tone (see .toned in styles.css). */
export const toneVars = (t: Tone | undefined) => t ? { "--tone-bg": t.bg, "--tone-ink": t.ink } as CSSProperties : undefined;
