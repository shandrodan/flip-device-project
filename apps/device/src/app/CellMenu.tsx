// The Home cell menu (ADR 0017). Blue D on an app or a bot opens it over the left column, so the
// selected cell stays in view on the comb. Wheel or D-pad picks a row, A chooses, B or D closes.
// While it is open on a bot, holding the mic talks to that bot.
import { useState, type ReactNode } from "react";
import { AGENT_NAME_MAX, AGENT_PERSONALITY_MAX, APP_IDS, minAppAgents, type Agent, type AppId } from "@app/protocol";
import { useControls, step, LAYER } from "../input/controls";
import { net } from "../net/client";
import { FN_LABEL, useApp, useTalkTarget } from "./context";
import { AgentBot } from "./ui";
import { toneVars, type Tone } from "./tone";
import { TextEntry } from "./TextEntry";

export type MenuCell = { kind: "app"; fn: AppId; icon: ReactNode; tone?: Tone } | { kind: "bot"; agent: Agent; tone?: Tone };
type Item = { label: string; detail?: string; off?: string; run(): void };

export function CellMenu({ cell, onClose }: { cell: MenuCell; onClose(): void }) {
  const { snap, go, push, online, toast } = useApp();
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"menu" | "apps" | "name" | "personality">("menu");
  const agent = cell.kind === "bot" ? cell.agent : null;
  useTalkTarget(agent ? { kind: "agent", agentId: agent.id } : null, [agent?.id], !!agent);

  const nameOf = (id: string) => snap.agents.find(a => a.id === id)?.name ?? "Unavailable";
  const needOnline = (what: string, run: () => void) => () => online ? run() : toast(`Connect to the server to ${what}.`);

  let title: string, sub: string, items: Item[];
  if (cell.kind === "app") {
    const members = snap.appAgents[cell.fn];
    const free = snap.agents.filter(a => a.id !== "main" && !APP_IDS.some(app => snap.appAgents[app].includes(a.id)));
    const manage = (start: "add" | "change" | "remove" | "delete") => () => { onClose(); push({ name: "appAgents", app: cell.fn, start }); };
    title = FN_LABEL[cell.fn];
    // Build with no agent of its own falls back to the main agent (ADR 0021).
    sub = members.length ? `${members.length} Task agent${members.length === 1 ? "" : "s"}: ${members.map(nameOf).join(", ")}` : "Omni works here until you add one";
    items = [
      { label: "Open", run: () => { onClose(); go(cell.fn); } },
      { label: "Add agent", detail: "Give it a free agent or make a new one.", run: manage("add") },
      { label: "Change agent", detail: "Swap one agent for a free one.", off: !members.length ? "No agent to change. Add one first." : free.length ? undefined : "No free agent. Add a new agent first.", run: manage("change") },
      { label: "Disconnect agent", detail: members.length === 1 && !minAppAgents(cell.fn) ? "Keeps the agent. Omni takes over." : "Keeps the agent in your list.",
        off: !members.length ? "No agent to disconnect." : members.length > minAppAgents(cell.fn) ? undefined : "Add another agent before disconnecting the last one.", run: manage("remove") },
      { label: "Delete agent", detail: members.length > minAppAgents(cell.fn) && members.length === 1 ? "Asks for the push bar. Omni takes over." : "Asks for the push bar.",
        off: !members.length ? "No agent to delete." : members.length > minAppAgents(cell.fn) ? undefined : "Add another agent before deleting the last one.", run: manage("delete") },
    ];
  } else {
    const a = cell.agent;
    const app = APP_IDS.find(x => snap.appAgents[x].includes(a.id));
    const fixed = a.builtin && a.purpose !== "app"; // main, mail and pc stay
    title = a.name;
    sub = app ? `Works in ${FN_LABEL[app]}` : a.id === "main" ? "Runs your other agents" : a.role;
    items = [
      { label: "Open", run: () => { onClose(); push({ name: "agent", agentId: a.id }); } },
      { label: "Rename", run: () => setView("name") },
      { label: "Personality", detail: a.personality || "How it talks to you. Not set.", run: () => setView("personality") },
      { label: "Look", detail: "Body and colour.", run: () => { onClose(); push({ name: "agentLook", agentId: a.id }); } },
      ...(a.id === "main" ? [] : app ? [{
        label: `Leave ${FN_LABEL[app]}`, detail: "Disconnects it from the app. The agent stays.",
        off: snap.appAgents[app].length <= minAppAgents(app) ? `It’s the last ${FN_LABEL[app]} agent. Add another first.` : undefined,
        run: needOnline("disconnect an agent", () => { net.send({ type: "app.agent.remove", app, agentId: a.id }); onClose(); }),
      }] : [{ label: "Join an app", detail: "It takes that app’s work.", run: () => { setView("apps"); setSel(0); } }]),
      ...(fixed ? [] : [{
        label: "Delete agent", detail: "Asks for the push bar.",
        off: app && snap.appAgents[app].length <= minAppAgents(app) ? `It’s the last ${FN_LABEL[app]} agent. Add another first.` : undefined,
        run: needOnline("delete an agent", () => { net.send({ type: "agent.delete", agentId: a.id }); onClose(); }),
      }]),
    ];
  }

  if (view === "apps" && agent) {
    title = `${agent.name} joins…`;
    sub = "Pick the app it works for.";
    items = APP_IDS.map(app => ({
      label: FN_LABEL[app], detail: snap.appAgents[app].map(nameOf).join(", ") || "Omni for now",
      run: needOnline("assign an agent", () => { net.send({ type: "app.agent.add", app, agentId: agent.id }); onClose(); }),
    }));
  }

  const i = Math.min(sel, items.length - 1);
  useControls(e => {
    if (e.c === "mic" || e.c === "systemWheel") return false;
    if (e.c === "b" && view === "apps") { setView("menu"); setSel(0); return true; }
    if (e.c === "b" || e.c === "d") { onClose(); return true; }
    const n = step(i, e, items.length);
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") { const it = items[i]; if (it.off) toast(it.off); else it.run(); }
    return true;
  }, {
    wheel: "Choose", dpad: "Choose", a: items[i]?.off ? "" : "Choose", b: view === "apps" ? "Back" : "Close", d: "Close", c: "", push: "",
    mic: agent ? `Talk to ${agent.name}` : undefined,
  }, view === "menu" || view === "apps", LAYER.sheet);

  const save = (patch: { name?: string; personality?: string }) => {
    if (!agent) return;
    if (!online) toast("Connect to the server to change an agent.");
    else net.send({ type: "agent.update", agentId: agent.id, patch });
    setView("menu");
  };

  return <>
    <div className="cm in">
      <div className="cm-head">
        <span className={"cm-ico" + (cell.tone ? " toned" : "")} style={toneVars(cell.tone)}>{cell.kind === "app" ? cell.icon : <AgentBot agent={cell.agent} size={40} fps={20} onTone={cell.tone} />}</span>
        <span style={{ minWidth: 0 }}><b>{title}</b><span className="mute">{sub}</span></span>
      </div>
      <div className="cm-list">
        {items.map((it, k) => <div key={it.label} className={"cm-row" + (k === i ? " sel" : "") + (it.off ? " off" : "")}>
          <b>{it.label}</b>
          {k === i && (it.off || it.detail) && <span className="mute">{it.off || it.detail}</span>}
        </div>)}
      </div>
    </div>
    {agent && view === "name" && <TextEntry title={`Rename ${agent.name}`} initial={agent.name} max={AGENT_NAME_MAX} purpose="name" placeholder="Say a name"
      onSave={name => save({ name })} onCancel={() => setView("menu")} />}
    {agent && view === "personality" && <TextEntry title={`${agent.name}’s personality`} initial={agent.personality ?? ""} max={AGENT_PERSONALITY_MAX} purpose="text"
      placeholder="Calm and short, no emoji…" onSave={personality => save({ personality })} onCancel={() => setView("menu")} />}
  </>;
}
