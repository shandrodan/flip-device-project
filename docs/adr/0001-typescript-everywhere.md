# 0001: TypeScript everywhere

Status: Accepted
Date: 2026-11-12

## Decision
React + Vite for the device and dock UI, Node + TypeScript for the server and PC agent. Shared types in `packages/protocol`.

## Why
The team knows React, and a weekend is too short to learn Rust or C++. One language means shared types and no glue.

## Consequences
Rust or C++ only appear in the pitch, as the language of future firmware speaking the same protocol.
