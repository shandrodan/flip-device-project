// Debug mode: an agent on a computer is tweaking the Device over USB-C or Wi-Fi. The Device
// keeps running but takes no input until debugging ends (B).
import { useControls, LAYER } from "../../input/controls";
import { HintBar, useTick } from "../ui";
import "./debug.css";

export type DebugLink = "usb" | "wifi";

const VIA: Record<DebugLink, string> = { usb: "Connected over USB-C", wifi: "Connected over Wi-Fi" };

const LinkIcon = ({ via }: { via: DebugLink }) => via === "usb"
  ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><rect x="2" y="5" width="12" height="6" rx="3" /><path d="M5.5 8h5" /></svg>
  : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M1.5 6a9.5 9.5 0 0 1 13 0M4 8.7a6 6 0 0 1 8 0M6.4 11.2a2.5 2.5 0 0 1 3.2 0" /><circle cx="8" cy="13.4" r=".6" fill="currentColor" /></svg>;

/** The broken bot: built like <Bot> (circle body, eyes cut out as holes), with crosses for eyes. */
function BrokenBot({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="-160 -160 320 320" className="debug-bot" aria-hidden="true">
    <defs>
      <mask id="debug-eyes" maskUnits="userSpaceOnUse" x="-160" y="-160" width="320" height="320">
        <rect x="-160" y="-160" width="320" height="320" fill="#fff" />
        <g stroke="#000" strokeWidth="15" strokeLinecap="round">
          <path d="M-48 -32 L-14 2 M-14 -32 L-48 2" />
          <path d="M14 -32 L48 2 M48 -32 L14 2" />
        </g>
      </mask>
    </defs>
    <circle r="100" fill="#a1a1a6" mask="url(#debug-eyes)" />
  </svg>;
}

export function DebugMode({ via, host, onEnd }: { via: DebugLink; host?: string; onEnd: () => void }) {
  useTick(10000);
  // Top layer: every control stops here, only B does something.
  useControls(e => {
    if (e.c === "b") onEnd();
    return true;
  }, { b: "End debugging" }, true, LAYER.talk);

  return <div className="fill debug">
    <div className="status">
      <span className="tnum">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      <span>Debug<span className="batt"><i /></span></span>
    </div>
    <div className="debug-body">
      <div className="debug-left"><BrokenBot size={290} /></div>
      <div className="debug-right">
        <div className="debug-label"><i />Agent connected</div>
        <h1>Debug mode</h1>
        <p className="debug-sub">An agent is tweaking the Device. You can use it again once debugging ends.</p>
        <div className="debug-link"><LinkIcon via={via} />{VIA[via]}</div>
        {host && <div className="debug-host">{host}</div>}
      </div>
    </div>
    <HintBar />
  </div>;
}
