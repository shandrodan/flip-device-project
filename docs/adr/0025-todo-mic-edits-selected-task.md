# 0025: The To-Do mic can change the selected task; DeepSeek V4 Flash by default

Status: Accepted
Date: 2026-11-14

## Decision
Changes the To-Do mic in ADR 0016 and the default OpenRouter model in ADR 0018.

A To-Do dump now carries the selected task (`VoiceTarget` `{ kind: "task", taskId }`). The model decides between two actions:
- **add:** a new task, as before.
- **edit:** a change to the selected task. It can move the task to a new day or time, rename it, move it to another project, mark it done, or hand it to an agent.

"Move this task tomorrow" moves the selected task; it no longer adds a task called "Move this task". The dump is still saved as a note first. When the model fails, rules cover the same edits.

The default OpenRouter model is `deepseek/deepseek-v4-flash-0731`. `OPENROUTER_MODEL` still overrides it.

## Why
In the demo, people talk to the task they are looking at. The mic only ever added tasks, so any instruction about the selected task turned into a nonsense new task. The free model was also rate limited during testing. DeepSeek V4 Flash costs little, supports tools, and answered our test lines correctly in about 2 s.

## Consequences
The mic hint stays "Hold to add a task", but edits work too. Deleting by voice is not offered: it is a risky action and needs its own approval flow. Each request costs a little OpenRouter credit, since the model is no longer free.
