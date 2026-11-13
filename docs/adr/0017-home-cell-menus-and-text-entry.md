# 0017: Home cell menus, agent editing, and text entry

Status: Accepted
Date: 2026-11-13
Supersedes the Home D part of 0015. The rest of 0015 stands.

## Decision
On Home, the blue D button opens a menu for the selected cell. The menu sits over the left column and the comb dims around the selected cell. Wheel or D-pad picks a row, A chooses, B or D closes.

| Cell | Menu |
| --- | --- |
| App | Open · Add agent · Change agent · Delete agent. Each one opens the app agent screen at that step (0015 rules: one app per agent, the last agent can't be deleted). |
| Task agent | Open · Rename · Personality · Look · Join an app (only free agents) · Delete agent (push bar). Main, Mail and PC agents have no Delete. Main has no Join. |
| New bot | D still opens pending Suggestions. |

With a Task agent's menu open, holding the mic talks to that agent.

Every Task agent assigned to an app is drawn joined to that app on Home (before, only Notes and Main were). If an app and its agents don't fit in the rest of a row, the rest of the row stays empty and they start on the next row. Browsing skips the empty spots.

Apps have no Delete or Update: they are built-in, and third-party apps are "maybe later" (APPS.md).

**Agent editing.** `Agent` gains an optional `personality` (up to 280 characters), and the Device sends `agent.update` with a name, personality, shape or colour. The server adds the personality to the agent's instructions. It changes how the agent talks, not what it may do. Editing isn't risky (nothing is sent, deleted, paid for or leaves the user's machines), so it needs no approval press. Look reuses the Create body and colour picker.

**Text entry.** Every text field opens one screen. Dictation comes first: hold the mic, speak, and the words replace the text. A saves, B cancels. C opens a keyboard for when talking won't do:

| Control | Keyboard |
| --- | --- |
| D-pad | Move between keys. Stops at the edges. |
| In-app wheel | Walk every key. Never ends. |
| A | Type the key. Shift, Space, Delete and Done are keys too. |
| B | Delete a letter. On an empty field: back to dictation. |
| C | Back to dictation. |
| D | Save. |

The first letter, and the letter after a full stop, are capitals. On Create's name step, C opens the keyboard directly.

## Why
D already meant "more about this thing" on Home. One menu per cell keeps every action next to the thing it changes, instead of spread across screens. Voice is the device's main input, so dictation is the default. A keyboard is still needed for names voice gets wrong and for rooms where you can't talk.

## Consequences
- The protocol change is additive: `Agent.personality`, `agent.update`, `AGENT_SHAPES`, and the name and personality limits.
- Talk targets now stack on the Device. A sheet that borrows the mic gives it back to the screen underneath when it closes.
- There is no way to leave an app without deleting the agent or swapping it out (Change agent). Add a "Leave app" message if that's needed.
