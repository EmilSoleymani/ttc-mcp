# GTFS test fixtures

`mini-schedules.zip` is a **hand-built synthetic** GTFS static feed — not a
captured slice of the real TTC feed (Dataset A is ~35 MB / 4.2M
`stop_times` rows, far too large to fixture). Column layout mirrors the real
`opendata_ttc_schedules.zip` exactly (docs/spec/gtfs-ingestion.md,
`.wayfinder/research/001-ttc-feed-inventory.md`), including extra columns the
ingest pipeline ignores (`location_type`, `wheelchair_boarding`,
`trip_headsign`, `block_id`, `pickup_type`, `drop_off_type`), so the parser
sees the same shape it will against the real feed.

Contents: one subway station (`10001`) with two child platforms
(`10002`/`10003`, exercising `parent_station` aggregation), one standalone
bus stop (`10004`), a subway trip and a bus trip, a weekday `calendar` row, a
`calendar_dates` exception, and one `stop_times` pair using a
past-midnight GTFS time (`25:10:00`) to exercise the >24:00:00 case.
