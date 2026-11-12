# DEMO.md

The one flow everything is built toward. If a feature isn't in here, it's a render or a slide.

## Setup on stage

- Device app full screen on a phone (or a laptop window sized like the device).
- Dock screen on a second tab.
- Laptop screen on the projector, running the PC agent.
- Phone hotspot, not venue Wi-Fi.
- `docker stats` visible for the container moment.

## Flow

1. **Dump:** press talk, say a messy thought out loud.
2. **Note:** it's saved instantly and shows on screen.
3. **Suggestion:** the device proposes tasks ("this looks like 2 tasks").
4. **Accept:** one press hands a task to an agent.
5. **Act:** the PC agent does the task on the laptop over Tailscale. The room watches the projector change.
6. **Approve:** a risky step pauses. Approval press with a haptic click. It continues.
7. **Dock:** the dock screen shows the result, today's tasks and "Claude limits reset in X min".
8. **Proof:** show the device container staying inside 512 MB.

Exact task to show: TBD (must be visible on the laptop and reliable).

## Before Sunday

- [ ] Flow runs end to end 20 times in a row
- [ ] Under 2 s from end of speech to first visible reaction
- [ ] No site with captchas or bot protection in the flow
- [ ] Recorded backup video
- [ ] Renders and pitch slides done

## Questions judges will ask

1. Why not just a phone app?
2. Who exactly buys this, and what do they do on day one?
3. What's the one task it does better than anything else?
4. How do agents control my devices, and what stops them deleting my files?
5. Where are keys stored, and what if the device is lost?
6. How fast does it respond?
7. Battery life and board?
8. Hardware cost, and cloud cost per user per month?
9. What works offline?
10. Why flip and buttons?
11. Why would developers build for a device with no users?
12. What did you build this weekend, and what's a render?
13. Why buy your hardware instead of flashing your OS onto my Pi?
