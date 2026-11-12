# 0005: Notes are saved first, offline-first transcription

Status: Accepted
Date: 2026-11-12

## Decision
Every dump is saved as a note instantly, with no question asked. Cloud transcription by default; local model when offline, then cloud re-transcription once online, but only if the user hasn't edited the note. The device then suggests tasks; one press accepts.

## Why
Asking "note or todo?" while you talk adds friction and fights the "just dump it" idea.

## Consequences
One todo integration for the hackathon (our own list or Todoist). Others come later.
