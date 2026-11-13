# 0012: Voice conversations with Task agents

Status: Accepted
Date: 2026-11-13

## Decision

Supersedes the mic routing in 0005, 0007 and 0009. The Notes mic still makes a Dump.
The Home mic addresses the main Task agent. An agent screen mic addresses that Task agent.
The Device sends the target with the audio. The server saves the transcript and routes it.

## Why

The user can speak to the main Task agent or to a chosen Task agent without making a Suggestion first.

## Consequences

Offline Dumps keep the existing Note flow. Offline agent speech waits on the Device until it can send a transcript.
Risky app and PC actions still need an approval press under 0004.
