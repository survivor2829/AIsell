# Repository Guidelines

## Project Structure & Module Organization

This repository is a small Electron desktop app for the AI获客 active-touch workflow.

- `desktop/` contains the editable Electron + React + Vite source.
- `desktop/src/main/` contains Electron main-process code.
- `desktop/src/renderer/` contains the React UI, local state, mock/empty data, and CSS.
- `desktop/rpa/active_touch/` contains the local dry-run executor and state-machine blocking rules.
- `release/` contains generated portable app output. Do not edit files there directly; rebuild and resync from `desktop/`.
- `ACTIVE_TOUCH_PLAN.md`, `MODULE_MAP.md`, `PROJECT_STATUS.md`, and `design-qa.md` are project handoff and planning documents.

## Build, Test, and Development Commands

Run commands from `desktop/`.

```powershell
npm install
npm run dev
npm run desktop
npm run build
npm run preview
```

- `npm run dev` starts the Vite browser preview on `127.0.0.1:5173`.
- `npm run desktop` starts the Electron shell in development mode.
- `npm run build` creates the production renderer bundle in `desktop/dist/`.
- `npm run preview` serves the built renderer for a quick production preview.

## Coding Style & Naming Conventions

Use TypeScript/React patterns already present in `desktop/src/renderer/App.tsx`. Keep components small only when they remove real duplication. Use 2-space indentation, double quotes in TS/JS, and kebab-case for CSS class names. Keep UI state in the renderer, and keep WeChat/RPA execution behind the main-process IPC boundary and local executor.

## Testing Guidelines

There is no test framework configured yet. For now, the required check is:

```powershell
npm run build
node rpa\active_touch\self_check.cjs
```

For UI changes, also smoke-test `npm run desktop` or the portable exe. Keep active-touch state-machine changes covered by `node rpa\active_touch\self_check.cjs` before adding real WeChat operations.

## Commit & Pull Request Guidelines

This folder currently has no Git history. Use short, imperative commits such as `Add active-touch dry-run executor` or Conventional Commit style like `feat: add login persistence`. PRs should include a short summary, screenshots for UI changes, verification commands, and any safety notes about WeChat/RPA behavior.

## Safety & Scope

Default to dry-run behavior. Do not send real customer messages, add bulk sending, or wire automatic reply/朋友圈 behavior unless the task explicitly asks for it. Preserve the current boundary: UI first, active-touch only, one stable step at a time.
