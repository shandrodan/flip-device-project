# Device onboarding

Start with the Device closed, as it would be in Dock mode. Teach the exposed controls first, then show the lower panel sliding out to reveal the D-pad and A/B/C/D. End with a practice Approval press. The quoted lines below are on-screen copy. Each step has an animation cue and a completion condition.

| Step | On-screen copy | Animation cue | Advance when |
| --- | --- | --- | --- |
| power | “Slide the power switch to turn on the Device.” | Side close-up. Move the switch to its On stop, then light the screen. | Power switches on. In the simulator, show this as a preview and continue with a tutorial prompt. |
| system-wheel | “Turn the System Wheel to switch functions. Find Focus.” | Highlight the side wheel. Move the function selector one item per detent. | Focus is selected. |
| in-app-wheel | “Turn the In-App Wheel to choose a duration.” | Highlight the round wheel on the top edge. Update the duration with each turn. | The duration changes. |
| push-bar | “Press the Push Bar to start. Press it again to end.” | Depress the long top bar and show the timer running, then stopped. | The learner starts and ends the practice timer. |
| reveal-controls | “Slide the lower panel open to reveal the rest of the controls.” | Slide the lower panel straight out from under the screen. Reveal the D-pad and the four lettered buttons together. | The reveal is complete. Use a tutorial cue in the simulator until slide input exists. |
| d-pad | “Press the D-pad to move the highlight.” | Show a small practice grid. Highlight the direction pressed and move focus to the adjacent item. | Focus moves to a different item. |
| confirm-back | “Press A to open. Press B to go back.” | Highlight green A at the bottom of the diamond, open the selected practice item, then highlight red B on the right. | The learner opens the item and returns. |
| microphone | “Hold the red Microphone Button while you speak. Release to save your Note.” | Show the side button held, a listening waveform, then a Note appearing on release. | The button is released and the practice Note appears. |
| contextual-actions | “Check the hints at the bottom of the screen. C and D change with the current function.” | On the practice Suggestion screen, highlight yellow C at the top for “Just the note” and blue D on the left for “Keep as todos.” Reset the example after each choice. | The learner tries both choices. |
| approval | “When a Risky action needs approval, press the Push Bar to approve or B to cancel.” | Show a practice request with the action and its destination. Highlight the Push Bar and B. Show the result of the chosen action. | The learner approves or cancels the simulated request. |
| finish | “You’re ready. Hold the Microphone Button whenever you have something to say.” | Return to the normal screen with its control hints. | The learner exits the tutorial. |

The In-App Wheel can also be pressed. Show a brief press in the wheel close-up and keep it out of the completion condition because its press is reserved. The Power switch has two positions. The opening shot demonstrates On and can briefly label Off. In To-Do, the In-App Wheel browses Tasks and the Push Bar completes the selected Task. Include that as an optional replay after the Focus lesson.

## Animation and input handoff

- Use the step IDs above for storyboard shots and tutorial state. Give each shot a setup pose, an idle cue, an input response, and a final pose. Keep the copy on screen after the motion ends.
- Drive practice from the existing control events in `apps/device/src/input/controls.ts`. Use CSS transforms for wheel turns, presses, and the panel reveal. Keep the camera and controls legible with reduced motion by replacing movement with static highlights and updated screen states.
- The physical labels are **A, B, C, D**. In the current simulator, C maps to the legacy `y` event (keyboard **I**) and D maps to `x` (**J**). Use C/D in learner-facing copy. Align the simulator glyphs and hints before shipping the tutorial. Power and panel reveal currently need scripted previews.
- Keep the practice timer, Note, Suggestion, and approval in tutorial-local state. Consume practice inputs before normal app handlers, including unexpected inputs, so a tutorial press cannot launch a real Task or answer a real approval. A real pending approval takes priority over the tutorial. Skip or replay should preserve the current app state.
- Follow ADR 0007 for approvals. A confirms selections and may approve a soft request. A Risky action requires the Push Bar. B declines either kind. The approval practice should show that pressing A leaves the Risky action pending and repeats the Push Bar hint.

## Shot breakdown

Timings are animation targets in milliseconds. Hold the final pose until the learner acts. Show a static hint after about five seconds of inactivity and let the learner continue at their own pace.

| Step | Setup and timing | Feedback and retry |
| --- | --- | --- |
| power | Side close-up. Slide to On over 220 ms and bring the screen up over 350 ms. Label the power switch by its symbol and position. | Wait for On on hardware. In the simulator, play the preview once and show “Continue.” |
| system-wheel | Frame the side wheel and the function selector together. Animate each detent over 120 ms. | Show the selected function name on every turn. The learner can turn either way to reach Focus. |
| in-app-wheel | Frame the top wheel and timer together. Animate a detent over 120 ms and update the number immediately. Show the wheel press once in the control preview. | A turn completes the step. If the learner presses the wheel, show “Turn the wheel to change the duration.” |
| push-bar | Show the full bar moving inward over 90 ms and releasing over 140 ms. Switch the timer from ready to running on the first press. | Change the prompt to “Press again to end.” Show “Session ended” after the second distinct press. |
| reveal-controls | Use a three-quarter view. Slide the lower panel out over 420 ms and hold long enough to see the button layout. | Keep the D-pad and all four letters in frame. Show “Continue” after the simulator preview. |
| d-pad | Start at the center of a 3 × 3 practice grid. Move the outline over 110 ms per valid direction. | Each direction is available from the center. At the boundary, keep the highlight on the current cell. |
| confirm-back | Show the D-pad selection, then cut to the A/B diamond. Open a practice item on A and return to the same cell on B. | Change the hint from “A · Open” to “B · Back” when the item opens. |
| microphone | Frame the red side button separately from the microphone inlet. Hold the pressed pose while the listening waveform runs. Show a saving state on release. | Use a scripted sample such as “Remind me to review the prototype.” If released too soon, show “Hold the button while you speak. Try again.” |
| contextual-actions | Use the saved practice Note and a sample Suggestion. Show the C and D hints with letters and names. | C keeps the Note. D creates a practice To-Do. Show the result and reset the example so the other choice can be tried. |
| approval | Show a simulated request to send a prototype summary to a sample recipient. Keep the action and recipient visible while highlighting the bar. | Push Bar shows “Approved in practice.” B shows “Canceled.” A keeps the request pending and repeats the Push Bar hint. |
| finish | Fade the tutorial highlight over 180 ms and show the ordinary control hints. | Leave the app on the screen the learner started from. |

## Implementation checklist

- Enter from the first-run tutorial prompt. Provide a replay entry in Settings and make Skip available throughout. Save completion only after the learner finishes or explicitly skips.
- Reset the current practice step after an interrupted session. Treat key repeat as one press for start, end, and approval. Release any active microphone practice when the window loses focus.
- Render the hardware highlight and the screen response together. Identify C and D by letter, position, and action so the tutorial also works without color or sound. Use steady outlines in reduced-motion mode.
- In Dock mode, teach the exposed controls first. Use the slide-open preview for the hidden controls so the learner can see where they are before practicing. Keep the same step IDs in both modes.
- Review the sequence with simulator controls and keyboard input. Check that C/D hints match the physical labels, both Push Bar paths work, and practice leaves Notes, Tasks, the focus timer, and real approvals untouched.

References: [Device controls](../device-controls.md), [button-only UI decision](adr/0007-button-only-ui.md), [demo flow](DEMO.md), and [shared terminology](../CONTEXT.md).
