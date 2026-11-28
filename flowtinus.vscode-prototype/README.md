# PROTOTYPE: VS Code extension (#86), throwaway

Learning material for [#86](https://github.com/flowtinus-hub/flowtinus/issues/86). It lives only on the `feature/vscode-prototype` branch and gets deleted, not merged. No tests, no polish.

```
bun run vscode-prototype
```

This builds `out/`, writes a fresh sample repository to `%TEMP%/flowtinus-vscode-prototype-sample-WIPE-ME` (git init + one commit) and opens it in a VS Code Extension Development Host. The output channel "Flowtinus prototype" logs the index and the renames.

**The web editor's own page** opens a `*.flow.yaml` by default ("Reopen Editor With..." → "simple canvas" for the first try). `scripts/build-editor.ts` builds `flowtinus.editor`'s `FlowEditorPage` with the editor's Vite and Tailwind, untouched; in the webview, its `fetch('/api/...')` goes to the extension (`src/webview-editor/fetch-shim.ts`), and `src/fake-api.ts` answers from the repo files as a `LOCAL` server, refusing the rest. The output channel logs every `/api` path asked (`ok` or `REFUSED`): that list is the host interface the canvas needs. `bun scripts/serve-editor.ts` shows the same page in a browser at http://localhost:5198/.

What it has, a thin slice of each area:

- **Canvas**: a `*.flow.yaml` opens in a custom text editor (React Flow in a webview). Drag, connect, Delete, double-click to rename a card, "+ Add card". Each gesture parses the text, changes the flow and writes the canonical form back (`repoFlowToYaml`) as one edit, so undo, dirty and save come from the text document. "Text beside" opens the YAML next to it, and typing there re-renders the canvas.
- **Names behind ids**: in the YAML, an inlay hint after each connection or flow id, a hover, go to definition (F12), and completion on `connection:` (filtered by the node's accepted connection types) and `flowId:`. The core's `validateWorkspaceTree` shows as diagnostics.
- **Explorer**: right-click → New flow / New flow folder (`.gitkeep`) / New script / New connection, each with a fresh id and the core's name rules. "Rename (git mv)" records a case-only rename in git, and for a script it finds the files that import the old path. Saving a repo file formats it to the canonical form and warns when a comment is dropped (try `Hand written.flow.yaml`).
