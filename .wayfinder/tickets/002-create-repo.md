---
id: "002"
title: "Task: Create ttc-mcp Repo & Deployment"
type: task
status: open
assignee:
blocked_by: []
blocks: []
---

## Question

The repo `ttc-mcp` needs to exist as a public GitHub repository (and Vercel project) before the implementation agent can land the scaffold. Mirror go-planner's repo-creation task, **noting the TTC deltas**:

- Create public GitHub repo `ttc-mcp` under the user's account (`EmilSoleymani`).
- Initial commit: `LICENSE` (MIT), `README.md` (placeholder), `.gitignore` (Node.js). The `.wayfinder/` map + tickets created during charting live locally at `~/Documents/Personal/ttc-mcp/.wayfinder/` — bring them along in the first push.
- Default branch `main`; GitHub Actions on by default.
- Wire up Vercel: connect the repo, create the project.
- **DELTA vs go-planner: there is NO API-key secret to configure.** The TTC official feeds are keyless, so no `*_API_KEY` Actions secret / Vercel env var is required for auth. (Any env vars will instead concern GTFS ingestion — e.g. feed URLs, cache toggles — determined by ticket 006.)
- Confirm npm + ghcr package names to reserve (e.g. `ttc-mcp` / `toronto-transit-mcp`) consistent with go-planner's tag-triggered dual-publish pattern.

**This is a HITL task** — the user creates the repo and connects Vercel. Provide a precise checklist. Record the resulting repo URL and Vercel project URL as the resolution so downstream tickets can reference them.

## Answer
