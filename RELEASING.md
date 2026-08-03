# Releasing

`ttc-mcp` publishes to npm (`ttc-mcp`) and ghcr (`ghcr.io/emilsoleymani/ttc-mcp`) whenever a `v*` tag is pushed (`.github/workflows/publish.yml`).

1. Bump `version` in `package.json` (semver).
2. Commit the bump (e.g. `chore: release vX.Y.Z`) and merge it to `main`.
3. Tag the merge commit and push the tag:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. The `Publish` workflow runs lint/typecheck/test, then:
   - publishes the built package to npm (needs the `NPM_TOKEN` repo secret — an npm automation token with publish rights)
   - builds the Docker image (baking a fresh local libSQL file from the live TTC feed) and pushes `X.Y.Z`, `X.Y`, and `X` tags to ghcr (uses the built-in `GITHUB_TOKEN`, no extra secret)
5. Verify both landed: <https://www.npmjs.com/package/ttc-mcp> and <https://github.com/EmilSoleymani/ttc-mcp/pkgs/container/ttc-mcp>.

## Data freshness

The published package/image ship whatever the schedule tables looked like at Docker-image build time (for the image) or however the consumer configures `LIBSQL_URL` (for the npm package, which has no baked-in data). The `GTFS Refresh` workflow (`.github/workflows/gtfs-refresh.yml`) keeps the shared Turso database current on its own weekly schedule, independent of releases — a version bump/tag is not required to pick up new schedule data on Vercel or a Docker image pointed at Turso.
