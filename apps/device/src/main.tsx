import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { installInputs } from "./input/controls";
import { Simulator } from "./sim/Simulator";
import { DeviceApp } from "./app/App";
import { DockGrid } from "./app/screens/Dock";
import { useNet } from "./net/client";
import { Bot } from "./bot/Bot";

installInputs();

/** Screen only, scaled to the window. What a kiosk browser on the real board would show. */
function Kiosk() {
  const [k, setK] = useState(1);
  useEffect(() => {
    const fit = () => setK(Math.min(window.innerWidth / 784, window.innerHeight / 504));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return <div className="kiosk"><div className="screen" style={{ transform: `scale(${k})` }}><DeviceApp /></div></div>;
}

/** /dock: the dock screen on a second tab, same WebSocket (DEMO.md). */
function DockPage() {
  const n = useNet();
  const [k, setK] = useState(1);
  useEffect(() => {
    const fit = () => setK(Math.min(window.innerWidth / 784, window.innerHeight / 504));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return <div className="dockpage">
    <div className="screen" style={{ transform: `scale(${k})`, borderRadius: 0 }}>
      <div className="status"><span className="tnum">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>{n.conn === "online" ? "Dock" : "Reconnecting…"} <span className="batt charge"><i /></span></span></div>
      {n.snap ? <DockGrid snap={n.snap} /> : <div className="fill" style={{ display: "grid", placeItems: "center" }}><Bot size={140} state="think" /></div>}
    </div>
  </div>;
}

const path = location.pathname;
const kiosk = new URLSearchParams(location.search).has("kiosk");
createRoot(document.getElementById("root")!).render(
  <StrictMode>{path.startsWith("/dock") ? <DockPage /> : kiosk ? <Kiosk /> : <Simulator />}</StrictMode>,
);
