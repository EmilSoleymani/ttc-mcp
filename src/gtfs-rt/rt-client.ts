// gtfs-realtime-bindings is a CommonJS module whose named exports are
// assigned dynamically at runtime (not a static `module.exports = {...}`
// literal), so cjs-module-lexer can't detect `transit_realtime` as a named
// export — a real Node ESM `import { transit_realtime } from
// "gtfs-realtime-bindings"` throws at runtime despite type-checking fine.
// Go through the default (guaranteed = the whole `module.exports`) for the
// runtime value; the type-only import is unaffected (erased at compile time,
// reads the .d.ts directly regardless of the module's runtime shape).
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";

import { fetchWithRetry, type RetryOptions } from "./http.js";

const { transit_realtime: GtfsRt } = GtfsRealtimeBindings;

export const DEFAULT_RT_BASE_URL = "https://bustime.ttc.ca/gtfsrt";
export const DEFAULT_RT_CACHE_TTL_SECONDS = 25;

// The three GTFS-RT feed names TTC publishes at
// `${baseUrl}/{vehicles,trips,alerts}` (docs/spec/realtime-integration.md
// "Confirmed constraints"). This ticket (#8) only wires up `vehicles`; the
// others are plumbed through the same cache for #10/#11 to use unchanged.
export type RtFeedName = "vehicles" | "trips" | "alerts";

export interface RtClientOptions {
  baseUrl?: string;
  ttlSeconds?: number;
  /** CACHE_ENABLED=false → every call re-fetches, no coalescing. */
  cacheEnabled?: boolean;
  fetchImpl?: typeof fetch;
  retryOptions?: RetryOptions;
}

interface CacheEntry {
  expiresAt: number;
  feed: Promise<transit_realtime.FeedMessage>;
}

/**
 * Decodes GTFS-RT feeds behind a short coalescing TTL cache
 * (docs/spec/realtime-integration.md "Caching"): each feed is fetched +
 * decoded at most once per `ttlSeconds` (default 25s, matching TTC's publish
 * cadence) — every call within the window, including concurrent in-flight
 * ones, shares the same decoded `FeedMessage` promise.
 */
export class RtClient {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly cacheEnabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly retryOptions: RetryOptions;
  private readonly cache = new Map<RtFeedName, CacheEntry>();

  constructor(options: RtClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_RT_BASE_URL;
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_RT_CACHE_TTL_SECONDS) * 1000;
    this.cacheEnabled = options.cacheEnabled ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryOptions = options.retryOptions ?? {};
  }

  private async decodeFeed(
    name: RtFeedName,
  ): Promise<transit_realtime.FeedMessage> {
    const response = await fetchWithRetry(`${this.baseUrl}/${name}`, {
      ...this.retryOptions,
      fetchImpl: this.fetchImpl,
    });
    if (!response.ok) {
      throw new Error(
        `GTFS-RT ${name} feed request failed: HTTP ${String(response.status)}`,
      );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return GtfsRt.FeedMessage.decode(buffer);
  }

  /** Decoded feed, served from the coalescing cache when enabled. */
  async getFeed(name: RtFeedName): Promise<transit_realtime.FeedMessage> {
    if (!this.cacheEnabled) return this.decodeFeed(name);

    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now) return cached.feed;

    const feed = this.decodeFeed(name);
    this.cache.set(name, { expiresAt: now + this.ttlMs, feed });
    // A failed decode shouldn't poison the cache for the rest of the TTL
    // window — clear it so the next call retries the fetch.
    feed.catch(() => {
      if (this.cache.get(name)?.feed === feed) this.cache.delete(name);
    });
    return feed;
  }

  async getVehiclePositions(): Promise<transit_realtime.IVehiclePosition[]> {
    const feed = await this.getFeed("vehicles");
    return feed.entity
      .map((entity) => entity.vehicle)
      .filter((v): v is transit_realtime.IVehiclePosition => v != null);
  }

  /** Decoded TripUpdates from the `trips` feed (the arrival-prediction feed
   * `get_arrivals` consumes). Mirrors `getVehiclePositions`. */
  async getTripUpdates(): Promise<transit_realtime.ITripUpdate[]> {
    const feed = await this.getFeed("trips");
    return feed.entity
      .map((entity) => entity.tripUpdate)
      .filter((t): t is transit_realtime.ITripUpdate => t != null);
  }

  /** Decoded alerts, paired with their FeedEntity id (the Alert protobuf
   * itself carries no id of its own). Subway-inclusive — unlike vehicles/trip
   * updates, TTC publishes this feed for all modes. */
  async getAlerts(): Promise<AlertEntity[]> {
    const feed = await this.getFeed("alerts");
    const entities: AlertEntity[] = [];
    for (const entity of feed.entity) {
      if (entity.alert) entities.push({ id: entity.id, alert: entity.alert });
    }
    return entities;
  }
}

export interface AlertEntity {
  id: string;
  alert: transit_realtime.IAlert;
}

/**
 * Resolves the RT client from env, mirroring `resolveQueryClient`
 * (src/gtfs/db-client.ts): `GTFS_RT_BASE_URL` (default the prod TTC
 * endpoint), `RT_CACHE_TTL_SECONDS` (default 25), `CACHE_ENABLED` (default
 * true — inherited from go-planner's cache spec).
 */
export function resolveRtClient(): RtClient {
  const baseUrl = process.env.GTFS_RT_BASE_URL ?? DEFAULT_RT_BASE_URL;
  const ttlSeconds = process.env.RT_CACHE_TTL_SECONDS
    ? Number(process.env.RT_CACHE_TTL_SECONDS)
    : DEFAULT_RT_CACHE_TTL_SECONDS;
  const cacheEnabled = process.env.CACHE_ENABLED !== "false";
  return new RtClient({ baseUrl, ttlSeconds, cacheEnabled });
}
