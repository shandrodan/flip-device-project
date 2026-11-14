// What the Pi-class VM uses right now (ADR 0024), under the twin when `?remote=` is set.
// Read every second from the relay, which reads the kernel and each service's cgroup.
import { useEffect, useState } from "react";

interface Metrics {
  cores: number; memTotalMB: number; memUsedMB: number; swapMB: number; cpuPct: number; load: number;
  units: Record<string, { memMB: number; cpuPct: number }>;
  history?: { t: number; mem: number; cpu: number }[];
}

const NAMES: Record<string, string> = {
  "flip-kiosk": "Kiosk browser", "flip-server": "Server", "flip-device": "Device app files",
  "flip-display": "Screen", "flip-audio": "Microphone", "flip-relay": "Relay",
};
const SPAN = 120; // seconds of history in the graph
/** A missing or broken reading shows as 0, never takes the twin down. */
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function Spark({ values, max, label }: { values: number[]; max: number; label: string }) {
  const w = 240, h = 40;
  const pts = values.slice(-SPAN).map((v, i, a) => `${(i / Math.max(1, SPAN - 1)) * w + (SPAN - a.length) * (w / (SPAN - 1))},${h - (Math.min(v, max) / max) * h}`);
  return <svg className="bm-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

export function BoardMonitor({ url }: { url: string }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(`${url}/metrics?history`);
        const j = await r.json() as Metrics;
        if (live) { setM(j); setDown(false); }
      } catch { if (live) setDown(true); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { live = false; clearInterval(id); };
  }, [url]);

  if (!m) return <section className="bm"><p className="bm-note">{down ? "Can't reach the VM. Is pi-vm/tunnel.sh running?" : "Connecting to the VM…"}</p></section>;
  const total = n(m.memTotalMB) || 1, used = n(m.memUsedMB), cpu = n(m.cpuPct), pct = used / total;
  const units = Object.entries(m.units || {}).sort((a, b) => n(b[1].memMB) - n(a[1].memMB));
  return <section className="bm" aria-label="Resources used on the VM">
    <header className="bm-head">
      <div>
        <h2>Running on a Pi 5-class VM</h2>
        <p>arm64 · {n(m.cores)} cores · {n(m.memTotalMB)} MB RAM · {n(m.swapMB) ? `${n(m.swapMB)} MB swap` : "no swap"}{down && " · reconnecting…"}</p>
      </div>
      <p className="bm-fine">Proves memory fit, not Pi speed.</p>
    </header>
    <div className="bm-stats">
      <div className="bm-stat">
        <span>RAM used</span>
        <b>{used}<small> / {n(m.memTotalMB)} MB</small></b>
        <div className="bm-bar"><i style={{ width: `${pct * 100}%` }} data-high={pct > 0.8 || undefined} /></div>
        <Spark values={(m.history || []).map(h => n(h.mem))} max={total} label="RAM used, last 2 minutes" />
      </div>
      <div className="bm-stat">
        <span>CPU, all {n(m.cores)} cores</span>
        <b>{cpu.toFixed(0)}<small>%</small></b>
        <div className="bm-bar"><i style={{ width: `${Math.min(100, cpu)}%` }} data-high={cpu > 80 || undefined} /></div>
        <Spark values={(m.history || []).map(h => n(h.cpu))} max={100} label="CPU, last 2 minutes" />
      </div>
    </div>
    <table className="bm-table">
      <thead><tr><th>Service</th><th>RAM</th><th>CPU</th></tr></thead>
      <tbody>{units.map(([k, u]) => <tr key={k}><td>{NAMES[k] || k}</td><td>{n(u.memMB)} MB</td><td>{n(u.cpuPct).toFixed(1)}%</td></tr>)}</tbody>
    </table>
  </section>;
}
