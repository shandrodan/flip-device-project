# apps/device

React + Vite PWA. Two views on one WebSocket:

- `/` device screen: orb with states (idle, listening, thinking, acting, awaiting-approval, done), notes, suggestions, approval press.
- `/dock` dock screen: focus timer, today's tasks, agent activity, Claude limit reset countdown.

Rules: thin client, types from `@app/protocol`, CSS transforms for animation, vibration API for haptics on Android.

Scaffold: `pnpm create vite . --template react-ts`
