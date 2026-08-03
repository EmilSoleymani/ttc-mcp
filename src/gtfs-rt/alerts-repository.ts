// gtfs-realtime-bindings is a CommonJS module whose named exports are
// assigned dynamically at runtime, so cjs-module-lexer can't detect
// `transit_realtime` as a named export — go through the default for the
// runtime value (see rt-client.ts for the full explanation).
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import { modeForRouteType } from "../gtfs/stops-repository.js";
import type {
  Alert,
  AlertCategory,
  AlertCause,
  AlertEffect,
  AlertSeverity,
} from "../schemas/alert.js";
import type { Mode } from "../schemas/stop.js";
import type { AlertEntity } from "./rt-client.js";
import { toTorontoIso } from "./vehicles-repository.js";

const { transit_realtime: GtfsRt } = GtfsRealtimeBindings;

// Reverse (number -> lower_snake_case name) maps, built off the enums
// protobufjs generates (same technique as vehicles-repository's
// OCCUPANCY_STATUS_NAMES) rather than hand-maintained parallel tables.
const CAUSE_NAMES = GtfsRt.Alert.Cause as unknown as Record<number, string>;
const EFFECT_NAMES = GtfsRt.Alert.Effect as unknown as Record<number, string>;
const SEVERITY_NAMES = GtfsRt.Alert.SeverityLevel as unknown as Record<
  number,
  string
>;

function causeName(
  cause: transit_realtime.Alert.Cause | null | undefined,
): AlertCause | undefined {
  if (cause === null || cause === undefined) return undefined;
  return CAUSE_NAMES[cause]?.toLowerCase() as AlertCause | undefined;
}

function effectName(
  effect: transit_realtime.Alert.Effect | null | undefined,
): AlertEffect | undefined {
  if (effect === null || effect === undefined) return undefined;
  return EFFECT_NAMES[effect]?.toLowerCase() as AlertEffect | undefined;
}

function severityName(
  severity: transit_realtime.Alert.SeverityLevel | null | undefined,
): AlertSeverity | undefined {
  if (severity === null || severity === undefined) return undefined;
  return SEVERITY_NAMES[severity]?.toLowerCase() as AlertSeverity | undefined;
}

/** The English (or, absent a language tag, first) translation's text. */
function translatedText(
  value: transit_realtime.ITranslatedString | null | undefined,
): string | undefined {
  const translations = value?.translation;
  if (!translations || translations.length === 0) return undefined;
  const english = translations.find(
    (t) => t.language === "en" || t.language == null,
  );
  return (english ?? translations[0])?.text;
}

function toOptionalTorontoIso(
  value: number | Long | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = typeof value === "number" ? value : value.toNumber();
  return toTorontoIso(seconds);
}

function activePeriods(
  periods: transit_realtime.ITimeRange[] | null | undefined,
): Alert["active_period"] {
  if (!periods || periods.length === 0) return undefined;
  return periods.map((p) => {
    const start = toOptionalTorontoIso(p.start);
    const end = toOptionalTorontoIso(p.end);
    return {
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    };
  });
}

/** A `route_type` an EntitySelector carries directly maps 1:1 to `mode`
 * (TTC only ever uses 0/1/3); unlike the ingested static catalog, a live RT
 * feed isn't a value this code controls, so an out-of-range value degrades
 * to "no mode resolved" rather than throwing. */
function safeModeForRouteType(routeType: number): Mode | undefined {
  try {
    return modeForRouteType(routeType);
  } catch {
    return undefined;
  }
}

/**
 * The static-catalog maps `get_alerts` joins each RT alert against
 * (docs/spec/realtime-integration.md #4 "Static <-> RT join"): a GTFS-RT
 * `EntitySelector` usually carries only a `route_id` (occasionally a bare
 * `stop_id`) with no `route_type`, so `mode` is resolved from the ingested
 * static catalog rather than the RT feed itself.
 */
export interface AlertModeIndex {
  /** `route_id -> mode` (routes-repository `routeModeIndex`). */
  routeModeById: ReadonlyMap<string, Mode>;
  /** `stop_id -> mode` (stops-repository `stopModeIndex`). */
  stopModeById: ReadonlyMap<string, Mode>;
}

/**
 * `informed.routes/stops/modes` from the alert's `informed_entity` list
 * (docs/spec/realtime-integration.md #3 "Alerts -> get_alerts"). `mode` is
 * resolved from whichever signal the selector carries: an explicit
 * `route_type`, else a `route_id` (via `routeModeById`), and independently a
 * `stop_id` (via `stopModeById`) — the latter is how a subway-station alert
 * that informs only a `stop_id`, with no subway `route_id`, still surfaces
 * under `mode: subway`.
 */
function resolveInformed(
  selectors: transit_realtime.IEntitySelector[] | null | undefined,
  modeIndex: AlertModeIndex,
): Alert["informed"] {
  const routes = new Set<string>();
  const stops = new Set<string>();
  const modes = new Set<Mode>();

  for (const selector of selectors ?? []) {
    if (selector.routeId) routes.add(selector.routeId);
    if (selector.stopId) stops.add(selector.stopId);

    // protobufjs decodes an *absent* optional enum field to its zero value
    // (0, "streetcar" here), not null/undefined — `routeType: 0` and "no
    // route_type on the wire" are otherwise indistinguishable. `hasOwnProperty`
    // is true only when the field was actually present on the wire (verified
    // by round-tripping a real FeedMessage), so it's the only reliable way to
    // tell "explicitly streetcar" from "not set, fall back to the static join".
    if (Object.prototype.hasOwnProperty.call(selector, "routeType")) {
      const mode = safeModeForRouteType(selector.routeType as number);
      if (mode) modes.add(mode);
    } else if (selector.routeId) {
      const mode = modeIndex.routeModeById.get(selector.routeId);
      if (mode) modes.add(mode);
    }
    if (selector.stopId) {
      const mode = modeIndex.stopModeById.get(selector.stopId);
      if (mode) modes.add(mode);
    }
  }

  return {
    ...(routes.size > 0 ? { routes: [...routes] } : {}),
    ...(stops.size > 0 ? { stops: [...stops] } : {}),
    ...(modes.size > 0 ? { modes: [...modes] } : {}),
  };
}

/**
 * `category` derivation from effect + header/description text
 * (docs/spec/realtime-integration.md #3, tool-schemas #8).
 *
 * Text is the *primary* signal: TTC's real alerts feed sets `effect =
 * UNKNOWN_EFFECT` on every alert (verified against the live feed), so the
 * `Effect` switch below is only a fallback for a feed that does populate it —
 * for TTC the text checks carry the classification. Wording is matched most-
 * specific first (`elevator`/`escalator` before the generic buckets, `planned`
 * advance-notice wording before the disruption it schedules). An alert with no
 * recognizable wording *and* no usable effect falls to the neutral `other`
 * rather than being asserted to be a concrete `detour` — a fare or safety
 * notice ("have proof of payment ready", "please look both ways") is not a
 * reroute.
 */
export function deriveCategory(
  effect: transit_realtime.Alert.Effect | null | undefined,
  headerText: string | undefined,
  descriptionText: string | undefined,
): AlertCategory {
  const text = `${headerText ?? ""} ${descriptionText ?? ""}`.toLowerCase();
  if (text.includes("elevator")) return "elevator";
  if (text.includes("escalator")) return "escalator";
  if (text.includes("planned")) return "planned";
  if (text.includes("no service")) return "no_service";
  // "detour"/"bypass"/"not stopping at ..." are TTC's wording for a reroute or
  // stop closure/relocation — all localized route deviations, so they share the
  // `detour` bucket. ("bypass" is what the description carries when the header
  // is truncated to "...Buses are not stoppi".)
  if (
    text.includes("detour") ||
    text.includes("bypass") ||
    text.includes("not stopping")
  ) {
    return "detour";
  }
  if (text.includes("delay")) return "delay";

  const { Effect } = GtfsRt.Alert;
  switch (effect) {
    case Effect.NO_SERVICE:
      return "no_service";
    case Effect.DETOUR:
    case Effect.MODIFIED_SERVICE:
    case Effect.STOP_MOVED:
      return "detour";
    case Effect.SIGNIFICANT_DELAYS:
    case Effect.REDUCED_SERVICE:
      return "delay";
    case Effect.ACCESSIBILITY_ISSUE:
      return "elevator";
    case Effect.ADDITIONAL_SERVICE:
    case Effect.NO_EFFECT:
      return "planned";
    default:
      return "other";
  }
}

/** Decoded Alert (+ its FeedEntity id) -> the finalized `Alert` DTO. */
export function toAlert(entity: AlertEntity, modeIndex: AlertModeIndex): Alert {
  const { alert } = entity;
  const header = translatedText(alert.headerText) ?? "";
  const description = translatedText(alert.descriptionText);
  const url = translatedText(alert.url);
  const severity = severityName(alert.severityLevel);
  const cause = causeName(alert.cause);
  const effect = effectName(alert.effect);
  const category = deriveCategory(alert.effect, header, description);
  const informed = resolveInformed(alert.informedEntity, modeIndex);
  const active_period = activePeriods(alert.activePeriod);

  return {
    id: entity.id,
    header,
    ...(description !== undefined ? { description } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(effect !== undefined ? { effect } : {}),
    category,
    informed,
    ...(active_period !== undefined ? { active_period } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

export interface AlertFilters {
  mode?: Mode;
  routeId?: string;
  stopId?: string;
  category?: AlertCategory;
}

/** Whether an already-finalized `Alert` DTO matches the given (all-optional,
 * AND-combined) filters (docs/spec/tool-schemas.md #8 get_alerts). */
export function matchesFilters(alert: Alert, filters: AlertFilters): boolean {
  if (filters.mode && !(alert.informed.modes ?? []).includes(filters.mode)) {
    return false;
  }
  if (
    filters.routeId &&
    !(alert.informed.routes ?? []).includes(filters.routeId)
  ) {
    return false;
  }
  if (
    filters.stopId &&
    !(alert.informed.stops ?? []).includes(filters.stopId)
  ) {
    return false;
  }
  if (filters.category && alert.category !== filters.category) return false;
  return true;
}

/** Decoded alerts -> finalized `Alert` DTOs matching the given filters. */
export function alertsMatching(
  entities: AlertEntity[],
  modeIndex: AlertModeIndex,
  filters: AlertFilters,
): Alert[] {
  return entities
    .map((entity) => toAlert(entity, modeIndex))
    .filter((alert) => matchesFilters(alert, filters));
}
