# 0018: OpenRouter for Task agents and transcription

Status: Accepted
Date: 2026-11-13

## Decision

Supersedes provider selection in 0008 and cloud transcription priority in 0009. One OpenRouter key, set in `/setup` or `OPENROUTER_API_KEY`, enables Nemotron 3.5 Super VL (free) for Task agents and Whisper Large V3 Turbo for transcription. `OPENROUTER_MODEL` selects the text model. With no OpenRouter key, Task agents use Claude when configured and otherwise use the planner.

OpenRouter receives client tool definitions via its Messages API. The existing runner executes tools and applies its approval rules. The OpenRouter model has access to the Device app tools and the bounded PC tools. Shell and Claude's hosted web search stay on the existing Claude path.

## Why

One provider key covers both models. The Home mic uses the final transcript as the Main agent's request, following 0012. Notes and To-Do keep their own routing.

## Consequences

Cloud transcription tries OpenRouter, then the configured OpenAI-compatible endpoint, then local Whisper. The Device transcript is the final fallback. Whisper usage may require OpenRouter credits. The model and transcription mode are visible in Device Settings.
