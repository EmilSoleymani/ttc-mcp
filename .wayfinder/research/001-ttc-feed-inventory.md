# TTC Feed Inventory — Empirical Research (Ticket 001)

**Date collected:** 2026-07-23/24 (all endpoints fetched live)
**Method:** Direct `curl` fetches + CKAN API + protobuf decode with `gtfs-realtime-bindings` (Python). Findings below are evidence-backed unless marked "(doc claim)".

---

## Summary of decision-relevant facts

- **GTFS-RT wire format = standard protobuf ONLY.** All three feeds return `Content-Type: application/x-google-protobuf`. `?format=json` is **ignored** (still returns protobuf). A protobuf dependency is **forced**.
- **TripUpdates carry REAL predicted times.** `arrival.time` / `departure.time` are populated with **absolute epoch timestamps** (23,233 arrival times in one sample, 0 `delay` fields). These are real "next arrival" predictions, not schedule-adherence deltas. The official feed covers next-arrivals without an unofficial prediction API — **for surface routes only.**
- **`transfers.txt` does NOT exist** in either GTFS dataset. Also missing everywhere: `fare_attributes.txt`, `fare_rules.txt`, `frequencies.txt`.
- **Subway is absent from RT.** VehiclePositions and TripUpdates are **bus + streetcar only** — Lines 1/2/4 never appear. (Transitland classifies the RT feed as `…~surface~rt`.)

---

## STATIC GTFS — "TTC Routes and Schedules" (CKAN)

There are **two** distinct CKAN datasets on `ckan0.cf.opendata.inter.prod-toronto.ca`. Both are single, **merged all-modes** ZIPs (subway + streetcar + bus), not per-mode files. They differ in file set, size, and cadence.

### Q1 — Download URLs & CKAN resolution

**Dataset A — `ttc-routes-and-schedules`** (primary, more current)
- CKAN API: `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules`
- Package id `7795b45e-e65a-4465-81fc-c36b9dfff169`, single resource `cfb6b2b8-6191-41e3-bda1-b175c51148cb`.
- **ZIP:** `https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip`
- Verified: HTTP 200, `application/zip`, **35,002,571 bytes (~35 MB)**.

**Dataset B — `merged-gtfs-ttc-routes-and-schedules`** (larger, richer file set, lags on refresh)
- CKAN API: `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=merged-gtfs-ttc-routes-and-schedules`
- Package id `b811ead4-6eaf-4adb-8408-d389fb5a069c`, resource `c920e221-7a1c-488b-8c5b-6d8cd4e85eaf`.
- **ZIP:** `https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/completegtfs.zip`
- Verified: HTTP 200, **80,951,202 bytes (~81 MB)**.

**How to resolve "latest" programmatically:** call `package_show`, read `result.resources[0].url` (stable per-resource download URL) and `result.resources[0].last_modified`. The resource UUIDs above are stable; the file is re-uploaded in place.

> Note: Dataset A's own CKAN `notes` field points users to the merged dataset ("The new merged GTFS … can be found here"), yet Dataset A had a **more recent** refresh (2026-07-13) than Dataset B (2026-06-19) at collection time. Both are all-modes. Choose per file-set needs (see Q2).

### Q2 — Files present in each ZIP (verified via `unzip -l` / row counts)

**Dataset A (`opendata_ttc_schedules.zip`) — 8 files, ~230 MB uncompressed:**

| file | size (uncompressed) | rows (excl header) |
|---|---|---|
| agency.txt | 185 B | 1 |
| calendar.txt | 532 B | ~11 service_ids |
| calendar_dates.txt | 1,816 B | — |
| routes.txt | 9,520 B | **233** |
| shapes.txt | 17,033,538 B | — |
| stops.txt | 674,388 B | **9,361** |
| stop_times.txt | 199,945,930 B (~200 MB) | **4,200,777** |
| trips.txt | 12,143,103 B | **133,682** |

**Dataset B (`completegtfs.zip`) — 11 files, ~415 MB uncompressed:** all of the above set **minus** `shapes`/`stop_times` sizes differ, **plus** `feed_info.txt`, `levels.txt`, `pathways.txt`. (stop_times.txt = 358 MB, shapes.txt = 43 MB.) Adds station accessibility/pathway graph (`pathways.txt`, `levels.txt`).

**CRITICAL absences — in BOTH datasets:**
- ❌ **`transfers.txt`** — NOT present in either ZIP. No official transfer/interchange rules.
- ❌ **`fare_attributes.txt` / `fare_rules.txt`** — NOT present. No fare data in GTFS.
- ❌ **`frequencies.txt`** — NOT present. All trips are explicitly scheduled (frequency-based service is fully enumerated in stop_times).
- ✅ `calendar.txt` **and** `calendar_dates.txt` — both present (calendar_dates used for exception adds/removals).
- ✅ `shapes.txt` — present (route geometry available).
- `feed_info.txt` — **only in Dataset B** (merged). Absent from Dataset A.

Route mode breakdown (route_type in routes.txt), Dataset A: `0`=streetcar → 20 routes, `1`=subway/metro → 3 routes (Lines 1, 2, 4), `3`=bus → 210 routes. Confirms single merged all-modes feed.

### Q3 — Refresh cadence & version detection

- **Dataset A** CKAN `refresh_rate: "Monthly"`; free-text notes say **"approx. every 6 weeks."** `last_refreshed: 2026-07-13`. HTTP `Last-Modified: Mon, 13 Jul 2026 21:28:32 GMT`, `ETag: "1783978112.191-35002571-1158615510"`, `Content-Length` present.
- **Dataset B** CKAN `refresh_rate: "Quarterly"`; `last_refreshed: 2026-06-19`.
- **Detecting a new version (recommended, in order):**
  1. CKAN `package_show` → `resources[0].last_modified` (and top-level `metadata_modified`). Cheapest reliable signal.
  2. HTTP `Last-Modified` / `ETag` / `Content-Length` on the ZIP URL (all present — an `If-Modified-Since` / `HEAD` poll works).
  3. `feed_info.txt` `feed_version` — **only available in Dataset B.** Observed value `S1000533` with `feed_start_date 20260621 / feed_end_date 20260725`. Dataset A has no feed_info, so version-string detection is impossible there; use (1)/(2).

### Q4 — Licensing

- **Portal license (governing):** open.toronto.ca states the dataset is released under the **Open Government Licence – Toronto** (`https://open.toronto.ca/open-data-licence/`). That licence explicitly permits **copy, modify, publish, translate, adapt, distribute, and commercial use, including derivative works and app integration**, for any lawful purpose. **Redistribution and derivative real-time use ARE permitted for an open-source project.**
- **Attribution required:** "Contains information licensed under the Open Government Licence – Toronto" (link the licence).
- **Data is "as is,"** no warranty, City assumes no liability.
- **⚠ Metadata discrepancy:** The CKAN API reports `license_id: "notspecified"` and `isopen: false` for **both** datasets, which contradicts the portal's OGL-Toronto statement. The portal HTML is the authoritative public license statement; the CKAN field appears to be unset metadata. Flagged in Open Items.
- No separate GTFS "Access-and-Use" click-through agreement was found gating the download (the ZIP is fetched anonymously with no token).

---

## GTFS-REALTIME — `bustime.ttc.ca/gtfsrt/` (Clever Devices BusTime backend)

### Q5 — Endpoint URLs (all verified HTTP 200)

- **VehiclePositions:** `https://bustime.ttc.ca/gtfsrt/vehicles`
- **TripUpdates:** `https://bustime.ttc.ca/gtfsrt/trips`
- **Alerts:** `https://bustime.ttc.ca/gtfsrt/alerts`

(The path segments are `vehicles` / `trips` / `alerts` — not `tripupdates`/`vehiclepositions`.)

### Q6 — Wire format: protobuf only, no JSON

- All three return `Content-Type: application/x-google-protobuf`. Raw bytes decode cleanly as standard **GTFS-RT v2.0** `FeedMessage` (`header.gtfs_realtime_version = "2.0"`, `incrementality = 0` = FULL_DATASET).
- **`?format=json` is ignored** — `https://bustime.ttc.ca/gtfsrt/vehicles?format=json` still returns `application/x-google-protobuf` binary. **No JSON variant.** A protobuf parser (e.g. `gtfs-realtime-bindings`) is a hard dependency.
- Response headers: `Cache-Control: private`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, HSTS. No CORS headers observed (server-side fetch assumed).

### Q7 — TripUpdates contain REAL predictions (not just deltas)

Decoded sample (1,531 trip_update entities): `stop_time_update` entries populate **absolute `arrival.time` / `departure.time` epoch timestamps**. In one snapshot: 23,233 `arrival.time` + 695 `departure.time` values set, and **zero `delay` fields** anywhere. `trip_update.timestamp` present per entity. → These are genuine **predicted arrival/departure clock times**. The official feed answers "when is the next vehicle" directly for surface routes; **no unofficial NextBus/prediction API is required** for bus/streetcar.

### Q8 — Mode coverage (empirical)

Cross-referenced RT `route_id`s against GTFS `route_type`:

- **TripUpdates:** bus 1,310 + streetcar 220 trips. **Subway (route_ids 1/2/4): 0.** (One anomalous `route 600`.)
- **VehiclePositions:** bus 809 + streetcar 142, plus 549 vehicles with **empty route_id** (deadheading / unassigned). **Subway: 0.**
- **Alerts:** 34 entities; these DO reference subway lines in text (e.g. "Line 6 Finch West", station elevator outages) via `informed_entity.route_id`, so service alerts cover all modes even though position/prediction feeds do not.
- **Gap confirmed:** No subway VehiclePositions and no subway TripUpdates. Transitland labels this feed `f-dpz8-ttc~surface~rt` ("surface"), consistent with surface-only RT.

### Q9 — Auth / rate limits / terms

- **No authentication:** anonymous `curl` returns 200; no API key, token, or header required (confirmed by Transitland registry too — no auth block).
- **No documented rate limits** found. `Cache-Control: private` suggests fair-use polling; treat as unofficial and poll conservatively (e.g. every 20–30 s to match feed timestamp cadence).
- **No published developer Terms of Use** specific to `bustime.ttc.ca` were located; the feed is the vendor (Clever Devices BusTime) product exposed by TTC. Reuse is generally treated under the same TTC open-data / OGL-Toronto umbrella, but a formal RT-specific ToU is **not documented** — see Open Items.

---

## OPEN ITEMS / RISKS

1. **License metadata contradiction.** CKAN API says `license_id: notspecified` / `isopen: false` for both GTFS datasets, while the open.toronto.ca portal states OGL-Toronto. Portal is the public statement, but confirm before relying on it commercially. No explicit license statement exists for the `bustime.ttc.ca` RT feeds at all (assumed same umbrella, unconfirmed).
2. **RT Terms of Use / rate limits are undocumented.** No official ToU, quota, or polling-interval guidance for `bustime.ttc.ca`. Risk of throttling/blocking if polled aggressively; behavior could change without notice (unofficial-style endpoint).
3. **No subway real-time.** Subway (Lines 1/2/4) has **no VehiclePositions and no TripUpdates**. "Next train" for subway is NOT available from the official feeds — only static schedule + service alerts. This is the biggest capability gap for a trip-planner.
4. **No `transfers.txt`.** Multi-modal routing across the subway/surface interchange must synthesize transfers (e.g. by stop proximity / parent_station) — the official GTFS gives no transfer rules or transfer times. Dataset B's `pathways.txt`/`levels.txt` partially help inside stations only.
5. **No fare data in GTFS** (`fare_attributes`/`fare_rules` absent). Fare/Presto logic must be modeled externally; `agency.fare_url` just links to the TTC fares web page.
6. **No `frequencies.txt`** — fine (fully enumerated stop_times), but stop_times is huge (~200–358 MB uncompressed, ~4.2 M rows). Ingestion needs streaming/DB, not in-memory naïve parse.
7. **Two overlapping static datasets** with different cadence and file sets, and Dataset A's notes deprecating itself toward Dataset B while being refreshed more recently. Decide which is canonical: **Dataset A** (freshest, but no `feed_info`/`pathways`) vs **Dataset B** (richer: `feed_info`, `pathways`, `levels`; quarterly, lags). Recommendation: use **A** for freshest schedules; pull `pathways`/`levels` from **B** if in-station accessibility routing is needed.
8. **`open.toronto.ca` page rendered a "Retired" marker** in one fetch, but the CKAN API reports `is_retired: false` and a 2026-07-13 refresh. Likely a fetch/parse artifact; verify the dataset is not being sunset before building on Dataset A specifically.
9. **JSON not offered** — must ship a protobuf dependency. Not a blocker, just a fixed constraint.

---

### Sources
- CKAN API: `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules` and `…?id=merged-gtfs-ttc-routes-and-schedules`
- GTFS ZIPs: `…/download/opendata_ttc_schedules.zip`, `…/download/completegtfs.zip` (fetched & unpacked)
- RT feeds: `https://bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}` (fetched & protobuf-decoded)
- License: `https://open.toronto.ca/dataset/ttc-routes-and-schedules/`, `https://open.toronto.ca/open-data-licence/`
- Registry cross-check: `https://github.com/transitland/transitland-atlas/blob/main/feeds/toronto.ca.dmfr.json`, `https://www.transit.land/feeds/f-dpz8-ttc~surface`
