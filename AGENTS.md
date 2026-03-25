# AGENTS.md

## Scope

You are working in a local-first Electron + React + SQLite application.

- Main process: `electron/`
- Renderer: `src/`
- Shared types: `types/`

Do not introduce new layers or restructure the project unless explicitly required.

---

## Commands

- Dev: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint`

---

## Rules

- Do not break IPC contracts between main and renderer
- Do not change database schema without explicit instruction
- Do not introduce new dependencies unless necessary
- Prefer modifying existing files over creating new abstractions
- Keep logic explicit and readable (no over-engineering)

---

## Architecture Constraints

- Strategy logic runs in worker threads
- Main process owns DB and filesystem access
- Renderer must not access DB directly
- All cross-boundary communication goes through IPC

---

## Coding Style

- TypeScript only
- 4-space indentation
- Follow existing patterns in each folder
- Avoid unnecessary abstractions

---

## When unsure

- Search for existing patterns in the repo and follow them
- Do not invent new architecture