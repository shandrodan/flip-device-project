import "./style.css";

// State lives in memory: the Device preview is a sandboxed frame where localStorage throws.
let clicks = 0;
const app = document.getElementById("app");
app.innerHTML = `<main><h1>{{title}}</h1><p>Say what to build next.</p><button type="button">Clicked 0 times</button></main>`;
const button = app.querySelector("button");
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = `Clicked ${clicks} time${clicks === 1 ? "" : "s"}`;
});
