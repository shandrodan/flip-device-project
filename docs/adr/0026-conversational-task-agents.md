# 0026: Conversational Task agents and PC shell access

Status: Accepted
Date: 2026-11-14

Supersedes the default planner fallback in 0008 and 0018, and extends the voice conversation in 0012.

## Decision

Task agents use the configured LLM for ordinary requests. The model receives up to five recent completed exchanges with the same agent and app target so it can handle follow-ups. It can inspect, act, verify results, and ask for missing details through its reply. The scripted planner is available with `DEMO_PLANNER=1`.

Both model providers can use the PC agent's optional shell. Shell runs with the PC agent account's OS permissions and accepts working folders outside the file-tool roots. Enable it at PC agent startup and configure a Device access token on the server. Manual and Auto show an approval with the command, working folder, and selected machine. Full retains the behavior defined in 0004.

## Why

Voice requests often refer to earlier work. Passing recent exchanges makes the references available to the model. Shell supports local tasks that need OS commands or installed applications.
