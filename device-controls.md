# Device Controls — Docked Operation

## Overview

This document describes how the device's physical controls behave while the device is charging on the dock.

The device has three physical controls:

- **System Wheel** — supports rotation only.
- **Push Bar** — supports pressing only.
- **In-App Wheel** — supports both rotation and pressing.
- **Microphone Button** — supports pressing and holding

The behavior of each control depends on the currently selected mode. Locations are described from the user's perspective while facing the screen.

**Future Expansion:** The In-App Wheel's press functionality is reserved for future features. Developers can assign actions to it when adding new functions to the device.


## 1. System Function Selection Mode

**Purpose:** Navigate between the device's main functions outside individual applications.

- **System Wheel:** Rotate to switch between functions.
- **Push Bar:** No action.
- **In-App Wheel:** No action.

## 2. Active Agents Mode

**Purpose:** Display information about currently active agents.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:** No action.
- **In-App Wheel:** No action.
- **Screen:** Automatically displays the status of active agents.

## 3. Focus Mode

**Purpose:** Select and manage focus sessions.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:**
  - First press: Start the focus session.
  - Second press: End the active focus session.
- **In-App Wheel:** Rotate to select the focus session duration.

## 4. To-Do Mode

**Purpose:** Navigate through tasks and manage their completion.

- **System Wheel:** Rotate to switch to another function.
- **Push Bar:** Press to mark the currently selected task as completed.
- **In-App Wheel:** Rotate to browse and select tasks.
- **Task Completion:** Once a task is marked as completed, it automatically disappears from the displayed task list.

## 5. Microphone Button
**Location:** Red button with a microphone icon on the lower edge of the screen housing, above the action buttons.

**Purpose:** Record voice input while the button is held.
- Press and hold: Start recording and continue while held.
- Release: Stop recording.


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
