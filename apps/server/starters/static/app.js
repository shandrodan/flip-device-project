// State lives in memory: the Device preview is a sandboxed frame where localStorage throws.
let clicks = 0;
const button = document.getElementById("count");
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = `Clicked ${clicks} time${clicks === 1 ? "" : "s"}`;
});
