---
id: "006"
title: "Grilling: GTFS Ingestion & Storage Design"
type: grilling
status: open
blocked_by: ["001", "003"]
blocks: ["009"]
---

## Question

**The crux of the map** — the concern go-planner never had. TTC has no live schedule-query API; its schedule data is a GTFS ZIP the server must ingest, store, and query itself. Using the feed facts (001) and the approaches survey (003), decide the ingestion & storage design that works on **both** cloned targets (Vercel Hobby serverless + Docker). Work one question at a time.

**Confirmed inputs from ticket 001:** two candidate feeds — `opendata_ttc_schedules.zip` (**35 MB**, 8 files, ~6-week refresh, freshest) vs. `completegtfs.zip` (**81 MB**, 11 files incl. `pathways`/`levels`/`feed_info`, quarterly). **`transfers.txt` and `frequencies.txt` are ABSENT from both**; `calendar` + `calendar_dates` + `shapes` are present. Ticket 003 leans node-gtfs/better-sqlite3 → read-only SQLite baked into the deploy artifact (Turso/libSQL fallback).

Decisions needed:
0. **Which dataset.** Pick `opendata_ttc_schedules` (smaller, fresher, but no pathways/levels) vs. `merged/completegtfs` (pathways/levels aid subway station/platform modelling & plan_trip, but 81 MB & only quarterly). This choice drives the `.db` size measurement below.
1. **Substrate** — SQLite bundled at build time / `/tmp` hydration / external hosted DB (Turso/libSQL) / in-memory / pre-derived JSON. Pick one that satisfies the Vercel ephemeral-FS + 4.5 MB constraints AND the Docker case, without divergent codepaths where avoidable. **First action: build the derived `.db` from the chosen ZIP and MEASURE it against Vercel's function-size + cold-start budget — this is the open unknown that decides bake-in vs. Turso (ticket 003).**
2. **Ingest pipeline** — when/where the ZIP is fetched, parsed, and loaded: build-time step baked into the deploy artifact, first-cold-start hydration, or scheduled job. Who owns it (CI workflow vs. runtime).
3. **Refresh model** — how the ~6-week feed update is picked up (cron rebuild+redeploy vs. runtime re-ingest vs. `last_modified` check). What staleness is acceptable; how a self-hoster triggers a refresh.
4. **Query layer** — the interface the tools call (a thin repository over SQLite? node-gtfs helpers?). Must serve stop/route lookups AND leave a path for `plan_trip`'s graph/transfer queries (009). **Note (ticket 001): `transfers.txt` does NOT exist — the transfer model cannot rely on it; it must derive interchanges from stop proximity and/or (if the merged feed is chosen) `pathways`/`levels`. Flag this hand-off to ticket 009.**
5. **Config surface** — env vars this introduces (feed URL, cache/DB path, refresh toggle) — feeds back into ticket 002 and the ticket-004 CI/Docker deltas.

**Deliverable:** `docs/spec/gtfs-ingestion.md` in the repo. **Graduates the "CI/CD & Docker deltas from GTFS ingestion" fog line** — after this resolves, spin out the concrete CI-refresh-workflow and Docker-bake tickets if they need their own decisions.

## Answer
