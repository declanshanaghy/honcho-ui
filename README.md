# honcho-ui

A web UI for exploring [Honcho](https://github.com/plasticlabs/honcho) memory — sessions, metadata, documents, and dialectic insights.

It is built as the memory explorer/debugging console for [Hermes Agent](https://github.com/nousresearch/hermes), but it is **not dependent on Hermes**: it talks directly to any Honcho instance (local or hosted) via the Honcho API, so it works standalone with any agent that uses Honcho for memory.

## Why

Honcho stores an agent's long-term memory as session metadata, user representations, documents, and generated insights. When a recall goes wrong or a fact goes stale, there has been no easy way to look inside and see what the agent actually "knows". This project gives that memory a face: browse it, search it, inspect it, and repair it.

## Status

Very early development. Expect nothing usable yet — this repo is a scaffold.

## Goals

- Connect to a local or hosted Honcho server (URL + API key)
- Browse projects, sessions, and users with their metadata
- Inspect and search documents and dialectic insights
- Edit or remove memory entries to repair bad recall
- Zero hard dependency on Hermes — integration is a deployment concern, not a code one

## License

[MIT](LICENSE)
