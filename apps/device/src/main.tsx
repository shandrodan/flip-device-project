import "./sim/boot"; // first: studio mode takes over the timers before anything keeps one
import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { installInputs } from "./input/controls";
import { Simulator } from "./sim/Simulator";
import { DeviceApp } from "./app/App";
import { StandBy } from "./app/screens/Dock";
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

/** /dock: the dock screen (StandBy, ADR 0020) on a second tab, same WebSocket (DEMO.md). W/S turn the wheel. */
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
      {n.snap ? <StandBy snap={n.snap} online={n.online} /> : <div className="fill" style={{ display: "grid", placeItems: "center" }}><Bot size={140} state="think" /></div>}
    </div>
  </div>;
}

// Studio mode (/?studio=1) loads on its own, with Three.js: the twin as a film set.
const Studio = lazy(() => import("./sim/StudioPage"));

const path = location.pathname;
const query = new URLSearchParams(location.search);
const kiosk = query.has("kiosk");
// No StrictMode in the studio: its double effects would build the 3D scene twice.
createRoot(document.getElementById("root")!).render(
  query.has("studio") ? <Suspense fallback={null}><Studio /></Suspense>
    : <StrictMode>{path.startsWith("/dock") ? <DockPage /> : kiosk ? <Kiosk /> : <Simulator />}</StrictMode>,
);
