# YouTube storyboard — Device introduction

**Format:** 16:9, 1920 × 1080, about 60 seconds.

**Working name:** «Омни». Product name is not confirmed in `AGENTS.md`.

**Video type:** an animated concept that uses the live Device UI. The white Device housing is a simulator/render, not finished hardware.

## Core idea

One thought becomes a Note, then a Task. An agent works on the PC. The person approves a risky action with the push bar. The Device then helps the person focus. Every close-up pairs a visible control action with a short text label.

| Time | Picture and motion | Voice and sound | Text on screen | Control shown |
| --- | --- | --- | --- | --- |
| 00–04 | Black field. A small clock appears: **10:08**. The white open Device enters slowly. The camera stops on its screen; the character looks at the viewer. | Soft start tone. No speech. | **A thought is enough.** | None. Give the viewer time to see the Device. |
| 04–10 | Close view of the screen and red mic. A light ring follows the mic while it is held. A speech line appears beside the character, word by word. | Person: «Привет, Омни. Поможешь мне?» A short listening sound follows the mic press. | **Hold to talk** beside the red button. | **Mic: hold and release.** Show both states. |
| 10–16 | The character turns to the person. Its answer appears as large subtitles. Three small cards move into view around it: Notes, To-Do, Focus. | Omni: «Да. Что тебе нужно: сохранить мысль, сделать задачу или начать фокус?» | **Notes · To-Do · Focus** | No button press yet. The cards introduce the choices. |
| 16–22 | The system wheel turns. The selected app changes from Notes to To-Do to Focus on the real screen. A thin arrow links the wheel to each screen change. The D-pad makes one selection move. | Three quiet wheel clicks. Omni: «Выбери действие.» | **System wheel: switch apps** / **D-pad: move** | **System wheel, D-pad.** Keep the physical wheel and changed screen in the same frame. |
| 22–29 | The camera returns to Notes. The person holds the mic and speaks one short thought. Words land on the ruled Note page. A small card says that the Note is saved. | Person: «Мне нужно записать идею и подготовить демо.» Omni: «Сохранил как Note.» | **Speech → Note** | **Mic.** Show the red button pressed and released. |
| 29–35 | The Device shows a suggestion made from the Note. The in-app wheel moves between two options. D opens suggestions; A accepts one Task. Use a green pulse on A only when the Task is accepted. | Omni: «Это две задачи. Начать с демо?» One click when A is pressed. | **Note → Task** / **A: accept** | **D, in-app wheel, A.** Show the selected option before the press. |
| 35–42 | Split frame: Device on the left, PC screen on the right. The Task moves to an agent. On the PC, a visible work step begins. The Device shows the agent state. | Omni: «Передал задачу агенту.» Sound moves from left to right. | **Agent works on your PC** | No new control. This shot proves where the work happens. |
| 42–48 | Work stops at a risky step. The Device fills the frame. The push bar glows orange; an arrow points to it. The bar is pressed once. The PC action continues only after the press. | Omni: «Это действие требует твоего подтверждения.» A firm click on the press. | **Approve with the push bar** | **Push bar.** Do not show A as an approval for this action. |
| 48–54 | The system wheel changes to Focus. The timer reads **25:00**. The push bar starts it. B returns to Home. Use a short camera pullback so the action and result stay visible. | Omni: «Теперь можно сосредоточиться.» A calm timer tone. | **Focus · 25:00** / **Push: start** / **B: back** | **System wheel, push bar, B.** |
| 54–58 | On Home, C opens the command center. The in-app wheel rotates the switch row. One switch moves into the centre; A changes its state. Keep this as a quick, clear sequence, not a fast blur. | Wheel clicks. No new dialogue. | **C: panel** / **Wheel: browse** / **A: change** | **C, in-app wheel, A.** |
| 58–60 | The Device sits in the Dock. The result, today’s Tasks and the Focus timer are visible. Cut to a clean end card with the character. | Omni: «Скажи мысль. Остальное сделаем вместе.» Music resolves. | **Say it. Agents do it. You approve.** | None. |

## Visual rules

- Keep the Device in its current white shell with a black screen. Use the existing character, app screens, control colours and typography from `apps/device`.
- Each control callout has the same pattern: **button highlight → physical action → screen change → one short label**. Hold the result long enough to read it.
- Use white for navigation, red for the mic, green for A, yellow for C, blue for D and orange for the push bar. Use the colours already in `apps/device/src/styles.css`.
- Show a wheel as a turn, not a tap. Show the mic as a hold and release. Show the push bar as one deliberate press.
- Use subtitles for every spoken line. Keep labels outside the Device screen when the app text needs to remain readable.
- Keep the PC action and Device status in one split frame. This makes the agent handoff clear.
- Do not call the rendered shell working hardware. Show the live UI in the shell and describe it as a software-first demo if a factual label is needed.

## Items to confirm before animation

1. The final product name and spoken voice. «Омни» is a working name from the brief.
2. The exact PC action in 35–48. `docs/DEMO.md` still marks the exact demo Task as TBD. Record a reliable action before this shot is produced.
3. The voice reply is a planned line for the video. I confirmed the Device screens and controls at `http://localhost:5173/`, but did not confirm an immediate spoken reply from the running app.
4. Decide whether the final video uses Russian speech with English UI, or whether to localize captions and labels too.
