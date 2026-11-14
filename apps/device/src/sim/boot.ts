// Runs before every other module. In studio mode the page's timers go through the studio
// clock, so a recorder can freeze time and step it one frame at a time (see clock.ts).
import { clock } from "./clock";

if (new URLSearchParams(location.search).has("studio")) clock.install();
