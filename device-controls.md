# Device Controls — Docked Operation

## Overview

This document describes how the device's physical controls behave while the device is charging on the dock.

The device has five physical controls:

- **System Wheel** — supports rotation only. 
**Location:** Located on the left side of the screen housing, near the upper third of the device. The wheel is recessed into the side edge.

- **Push Bar** — supports pressing only.
**Location:** Located along the top edge of the screen housing. It is the long bar extending across most of the device's width, to the left of the In-App Wheel.

- **In-App Wheel** — supports both rotation and pressing.
**Location:** Located on the top edge of the screen housing, near the upper-right corner, immediately to the right of the Push Bar

- **Microphone Button** — supports pressing and holding

- **ON/OFF**

The behavior of each control depends on the currently selected mode. Locations are described from the user's perspective while facing the screen.

**Future Expansion:** The In-App Wheel's press functionality is reserved for future features. Developers can assign actions to it when adding new functions to the device.


**In-App Wheel rule (every mode):** The wheel cycles through the options and has no end. Turning past the last option brings you back to the first, and turning back past the first brings you to the last. The D-pad still stops at the edges.

## 1. System Function Selection Mode

**Purpose:** Navigate between the device's main functions outside individual applications.

- **System Wheel:** Rotate to switch between functions.
- **Push Bar:** No action.
- **In-App Wheel:** Rotate to browse every cell on the home screen.
- **C Button (yellow):** Open the command center. Only from the home screen: inside an app, go back to Home first.
- **D Button (blue):** Open the menu for the selected app or Task agent. On the New bot cell, open pending Suggestions.

### Home cell menu

**Purpose:** Act on one app or Task agent without leaving Home (ADR 0017).

- **App:** Open, Add agent, Change agent, Delete agent.
- **Task agent:** Open, Rename, Personality, Look, Join an app, Delete agent. Delete asks for the push bar. Main, Mail and PC agents can't be deleted.
- **In-App Wheel / D-Pad up and down:** Pick a row. **A:** choose it. **B or D:** close.
- **Microphone Button:** With a Task agent's menu open, talk to that agent.

### Text entry

**Purpose:** Fill any text field, such as a name or a personality (ADR 0017).

- **Dictation (opens first):** Hold the microphone and speak. The words replace the text. **A** saves, **B** cancels, **C** opens the keyboard.
- **Keyboard:** **D-Pad** moves between keys (it stops at the edges). **In-App Wheel** walks every key and never ends. **A** types the key. **B** deletes a letter (on an empty field, back to dictation). **C** goes back to dictation. **D** saves.

### Command Center

**Purpose:** Turn Wi-Fi, Bluetooth, Tailscale, Battery saver and Do Not Disturb on or off, and see recent notifications.

- Opens as a shade from the top of the screen. Five switches sit on a flywheel; the one in the centre is selected.
- **In-App Wheel / D-Pad left and right:** Turn the flywheel. Forward or right brings the next switch on the right to the centre. It never ends.
- **A Button:** Turn the centre switch on or off.
- **D-Pad down / up:** Move into the notifications below the flywheel, and back up to it. A opens the selected notification's agent.
- **C Button or B Button:** Close the command center.

## 2. Active Agents Mode

**Purpose:** Display information about currently active agents.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:** No action.
- **In-App Wheel:** Rotate to pick an agent.
- **Screen:** Automatically displays the status of active agents.

## Notes Mode

**Purpose:** Talk, and the main agent files it in the right note (ADR 0011).

- **In-App Wheel / D-Pad up and down:** Browse the notes. The pad shows the selected one.
- **A Button:** Read the note full width. The wheel then scrolls it, and B goes back to the list. Reading, A opens the note's tasks when it has some.
- **C Button:** Delete the note (asks for the push bar).
- **D Button:** Suggest tasks from the note, or review them when they're ready.
- **Microphone Button:** Hold and talk. The app drops down and the agent listens above it. Release, and it adds to the open note, another note, or a new one. The result stays up for 5 seconds. B closes it early, and holding the mic again starts the next one.

## 3. Focus Mode

**Purpose:** Select and manage focus sessions.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:**
  - First press: Start the focus session.
  - Second press: End the active focus session.
- **In-App Wheel:** Rotate to select the focus session duration.

## 4. To-Do Mode

**Purpose:** Navigate through tasks and manage their completion. Lists on the left (Today, Inbox, Scheduled, Completed, projects), tasks on the right. See `docs/adr/0016-todo-lists-and-spotlight.md`.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:** Press to mark the currently selected task as completed. In Completed, it restores the task.
- **In-App Wheel:** Rotate to browse and select tasks (or lists, when the sidebar has focus).
- **D-pad:** Left and right move between the lists and the tasks, and between days on the Scheduled board.
- **A / B / C / D:** A opens the task, B goes back to the lists, C moves the task to Today (on Overdue: all of it), D hands it to an agent.
- **Microphone:** Hold to say a task. It is saved as a note, then filed as a task with its day, project or agent.
- **Task Completion:** Once a task is marked as completed, it leaves the list and waits in Completed.

## 5. Microphone Button
**Location:** Red button with a microphone icon on the lower edge of the screen housing, above the action buttons.

**Purpose:** Record voice input while the button is held. Home addresses the main Task agent.
An agent screen addresses that Task agent. To-Do, Focus, Agents, and Settings address one of
their assigned Task agents. Notes makes a Dump. With a Task agent's menu open on Home, the mic talks
to that agent. In a text field, the mic dictates into it.
- Press and hold: Start recording and continue while held.
- Release: Stop recording.


## 6. ON/OFF
**Location:** located on the front bezel near the lower-right corner of the screen. It is the small round button marked with a power symbol.


## Additional Controls
The following controls provide confirmation, cancellation, contextual actions, and directional navigation. The action buttons sit in a diamond: C (yellow) at the top, A (green) at the bottom, D (blue) on the left, and B (red) on the right.

## 6. A Button
**Location:** Green button at the bottom of the action-button cluster on the right side of the device.
**Purpose:** Confirm the current selection or approve a pending request.
- Press: Activate the selected option or approve the currently displayed request.


## 7. B Button
**Location:** Red button on the right of the action-button cluster.

**Purpose:** Cancel the current interaction or return to the previous screen.
- During a pending request: Press to cancel.
- During navigation: Press to return to the previous screen.

## 8. C Button
**Location:** Yellow button at the top of the action-button cluster.

**Purpose:** Perform an additional action defined by the current application or mode.
- Press: Execute the assigned action.
- Screen: Display the assigned action when available.
- Unassigned: No action.

## 9. D Button
**Location:** Blue button on the left of the action-button cluster.

**Purpose:** Perform another additional action defined by the current application or mode.
- Press: Execute the assigned action.
- Screen: Display the assigned action when available.
- Unassigned: No action.

**Future Expansion:** Developers can assign actions to the C and D buttons when adding new functions to the device.

## 10. Directional Pad (D-Pad)
**Location:** Cross-shaped control on the left side of the device, below the screen.

**Purpose:** Navigate menus, lists, and selectable interface elements.
- Up: Move the selection upward.
- Down: Move the selection downward.
- Left: Move the selection to the left.
- Right: Move the selection to the right.
- Unavailable Direction: No action.
- Selection Confirmation: Press the A Button to confirm the selected item.
