import { useState } from "react";

// State lives in memory: the Device preview is a sandboxed frame where localStorage throws.
export default function App() {
  const [clicks, setClicks] = useState(0);
  return (
    <main>
      <h1>{{title}}</h1>
      <p>Say what to build next.</p>
      <button type="button" onClick={() => setClicks(clicks + 1)}>
        Clicked {clicks} time{clicks === 1 ? "" : "s"}
      </button>
    </main>
  );
}
