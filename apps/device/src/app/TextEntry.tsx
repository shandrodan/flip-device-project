// Text entry (ADR 0017). Every text field on the Device opens here. Dictation comes first: hold
// the mic and speak, and the words fill the field. C opens a keyboard for when talking won't do:
// the D-pad moves between keys (it stops at the edges), the in-app wheel walks every key and
// never ends, A types. B deletes a letter, D saves, C goes back to dictation.
import { useState } from "react";
import { useControls, LAYER } from "../input/controls";
import { useTalkTarget } from "./context";
import { Ico } from "./ui";

type Key = { k: string; span?: number };
const SHIFT = "⇧", DEL = "⌫", SPACE = "space", DONE = "Done";
const ROWS: Key[][] = [
  "1234567890".split("").map(k => ({ k })),
  "qwertyuiop".split("").map(k => ({ k })),
  [..."asdfghjkl".split("").map(k => ({ k })), { k: "'" }],
  [{ k: SHIFT }, ..."zxcvbnm".split("").map(k => ({ k })), { k: "," }, { k: "." }],
  [{ k: "-" }, { k: "?" }, { k: SPACE, span: 4 }, { k: DEL, span: 2 }, { k: DONE, span: 2 }],
];
// Each key's place on a 10-column grid, so D-pad up/down lands on the key under the current one.
const GRID = ROWS.map(row => { let c = 0; return row.map(key => { const at = c; c += key.span ?? 1; return { ...key, col: at, mid: at + (key.span ?? 1) / 2 }; }); });
const FLAT = GRID.flatMap((row, r) => row.map((_, c) => [r, c] as const));

export function TextEntry({ title, initial = "", max, purpose, placeholder, keyboard = false, onSave, onCancel }: {
  title: string;
  initial?: string;
  max: number;
  /** "name" keeps the first three spoken words; "text" keeps the whole sentence. */
  purpose: "name" | "text";
  placeholder?: string;
  /** Open on the keyboard instead of dictation (when C already asked for it). */
  keyboard?: boolean;
  onSave(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(initial);
  const [kb, setKb] = useState(keyboard);
  const [pos, setPos] = useState<[number, number]>([1, 0]);
  const [shift, setShift] = useState(false);
  const required = purpose === "name";

  useTalkTarget({ kind: "text", purpose, label: title, onText: t => { if (t) { setText(t.slice(0, max)); setKb(false); } } }, []);

  const add = (s: string) => setText(t => (t + s).slice(0, max));
  // Capital at the start and after a full stop, or with shift.
  const cap = shift || !text.trim() || /[.?!]\s$/.test(text);
  const save = () => {
    const out = text.trim();
    if (required && !out) return;
    onSave(out);
  };
  const press = (k: string) => {
    if (k === SHIFT) return setShift(s => !s);
    if (k === DEL) return setText(t => t.slice(0, -1));
    if (k === DONE) return save();
    if (k === SPACE) return add(" ");
    add(cap ? k.toUpperCase() : k);
    setShift(false);
  };

  const move = (dr: number, dc: number) => {
    const [r, c] = pos;
    if (dc) return setPos([r, Math.max(0, Math.min(GRID[r].length - 1, c + dc))]);
    const nr = Math.max(0, Math.min(GRID.length - 1, r + dr));
    if (nr === r) return;
    const mid = GRID[r][c].mid;
    const nc = GRID[nr].findIndex(key => mid >= key.col && mid < key.col + (key.span ?? 1));
    setPos([nr, nc < 0 ? GRID[nr].length - 1 : nc]);
  };

  useControls(e => {
    if (e.c === "mic" || e.c === "systemWheel") return false;
    if (!kb) {
      if (e.c === "a") save();
      else if (e.c === "b") onCancel();
      else if (e.c === "c") setKb(true);
      return true;
    }
    if (e.c === "appWheel") {
      const i = FLAT.findIndex(([r, c]) => r === pos[0] && c === pos[1]);
      const [r, c] = FLAT[(i + (e.dir || 1) + FLAT.length) % FLAT.length];
      setPos([r, c]);
    }
    else if (e.c === "left" || e.c === "right") move(0, e.c === "left" ? -1 : 1);
    else if (e.c === "up" || e.c === "down") move(e.c === "up" ? -1 : 1, 0);
    else if (e.c === "a" || e.c === "appWheelPress") press(GRID[pos[0]][pos[1]].k);
    else if (e.c === "b") { if (text) setText(t => t.slice(0, -1)); else setKb(false); }
    else if (e.c === "c") setKb(false);
    else if (e.c === "d") save();
    return true;
  }, kb
    ? { mic: "Hold to dictate", wheel: "Keys", dpad: "Keys", a: "Type", b: text ? "Delete" : "Dictate", c: "Dictate", d: "Save", push: "" }
    : { mic: "Hold to dictate", wheel: "", dpad: "", a: required && !text.trim() ? "" : "Save", b: "Cancel", c: "Keyboard", d: "", push: "" },
    true, LAYER.sheet);

  return <div className={"te" + (kb ? " kb" : "")}>
    <div className="label">{title}</div>
    <div className="te-field">
      <span className="te-text">{text || <span className="mute">{placeholder}</span>}<i className="te-caret" /></span>
      <span className="te-count tnum">{text.length}/{max}</span>
    </div>
    {kb ? <div className="te-keys">
      {GRID.map((row, r) => <div key={r} className="te-row">
        {row.map((key, c) => <span key={key.k} style={{ gridColumn: `span ${key.span ?? 1}` }}
          className={"te-key" + (r === pos[0] && c === pos[1] ? " sel" : "") + (key.k === SHIFT && shift ? " on" : "") + (key.k.length > 1 || key.k === SHIFT ? " fn" : "")}>
          {key.k.length === 1 && key.k !== SHIFT && cap ? key.k.toUpperCase() : key.k}
        </span>)}
      </div>)}
    </div> : <div className="te-dict">
      <span className="te-mic">{Ico.mic(26)}</span>
      <div>
        <b>Hold the mic and say it.</b>
        <div className="mute">What you say replaces the text. Press <i className="g c">C</i> to type with the keyboard instead.</div>
      </div>
    </div>}
  </div>;
}
