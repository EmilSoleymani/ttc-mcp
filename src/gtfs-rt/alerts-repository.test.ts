// See rt-client.ts for why this goes through the default export.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";

import type { Mode } from "../schemas/stop.js";
import {
  alertsMatching,
  deriveCategory,
  matchesFilters,
  toAlert,
} from "./alerts-repository.js";
import type { AlertEntity } from "./rt-client.js";

const { transit_realtime } = GtfsRealtimeBindings;
const { Cause, Effect } = transit_realtime.Alert;

const ROUTE_MODE_BY_ID: ReadonlyMap<string, Mode> = new Map([
  ["1", "subway"],
  ["900", "bus"],
]);

function alertEntity(
  id: string,
  overrides: Partial<Parameters<typeof transit_realtime.Alert.create>[0]> = {},
): AlertEntity {
  return {
    id,
    alert: transit_realtime.Alert.create(overrides),
  };
}

describe("deriveCategory", () => {
  it("prefers 'elevator' from header text over the raw effect", () => {
    expect(
      deriveCategory(
        Effect.ACCESSIBILITY_ISSUE,
        "Elevator out of service",
        undefined,
      ),
    ).toBe("elevator");
  });

  it("prefers 'escalator' from description text over the raw effect", () => {
    expect(
      deriveCategory(
        Effect.ACCESSIBILITY_ISSUE,
        "Service alert",
        "Escalator closed for repair",
      ),
    ).toBe("escalator");
  });

  it("prefers 'planned' wording in the text over the raw effect", () => {
    expect(
      deriveCategory(
        Effect.DETOUR,
        "Planned diversion for road work",
        undefined,
      ),
    ).toBe("planned");
  });

  it("maps NO_SERVICE to 'no_service'", () => {
    expect(deriveCategory(Effect.NO_SERVICE, "Line closed", undefined)).toBe(
      "no_service",
    );
  });

  it("maps DETOUR/MODIFIED_SERVICE/STOP_MOVED to 'detour'", () => {
    expect(deriveCategory(Effect.DETOUR, "", undefined)).toBe("detour");
    expect(deriveCategory(Effect.MODIFIED_SERVICE, "", undefined)).toBe(
      "detour",
    );
    expect(deriveCategory(Effect.STOP_MOVED, "", undefined)).toBe("detour");
  });

  it("maps SIGNIFICANT_DELAYS/REDUCED_SERVICE to 'delay'", () => {
    expect(deriveCategory(Effect.SIGNIFICANT_DELAYS, "", undefined)).toBe(
      "delay",
    );
    expect(deriveCategory(Effect.REDUCED_SERVICE, "", undefined)).toBe("delay");
  });

  it("defaults ACCESSIBILITY_ISSUE without device wording to 'elevator'", () => {
    expect(
      deriveCategory(
        Effect.ACCESSIBILITY_ISSUE,
        "Accessibility alert",
        undefined,
      ),
    ).toBe("elevator");
  });

  it("falls back to 'detour' for an unmapped/unset effect", () => {
    expect(deriveCategory(Effect.OTHER_EFFECT, "", undefined)).toBe("detour");
    expect(deriveCategory(undefined, "", undefined)).toBe("detour");
  });
});

describe("toAlert", () => {
  it("maps a decoded subway-wide Alert to the Alert DTO", () => {
    const entity = alertEntity("alert-1", {
      cause: Cause.MAINTENANCE,
      effect: Effect.SIGNIFICANT_DELAYS,
      severityLevel: transit_realtime.Alert.SeverityLevel.WARNING,
      headerText: { translation: [{ text: "Line 1 delays", language: "en" }] },
      descriptionText: {
        translation: [{ text: "Signal problem near Bloor", language: "en" }],
      },
      url: {
        translation: [{ text: "https://ttc.ca/alerts/1", language: "en" }],
      },
      informedEntity: [{ routeId: "1" }],
      activePeriod: [{ start: 1_780_000_000, end: 1_780_003_600 }],
    });

    const alert = toAlert(entity, ROUTE_MODE_BY_ID);
    expect(alert).toMatchObject({
      id: "alert-1",
      header: "Line 1 delays",
      description: "Signal problem near Bloor",
      severity: "warning",
      cause: "maintenance",
      effect: "significant_delays",
      category: "delay",
      informed: { routes: ["1"], modes: ["subway"] },
      url: "https://ttc.ca/alerts/1",
    });
    expect(alert.active_period).toHaveLength(1);
    expect(alert.active_period?.[0]?.start).toBeDefined();
    expect(alert.active_period?.[0]?.end).toBeDefined();
  });

  it("resolves mode from an explicit route_type when the selector carries one", () => {
    const entity = alertEntity("alert-2", {
      headerText: { translation: [{ text: "System-wide bus delays" }] },
      informedEntity: [{ routeType: 3 }],
    });

    const alert = toAlert(entity, new Map());
    expect(alert.informed.modes).toEqual(["bus"]);
    expect(alert.informed.routes).toBeUndefined();
  });

  it("falls back to the static route catalog when the selector carries only a route_id", () => {
    // No explicit route_type on the selector (TTC's common case) — mode must
    // come from the static join, not default to route_type 0 (streetcar).
    const entity = alertEntity("alert-2b", {
      headerText: { translation: [{ text: "Line 1 shuttle bus" }] },
      informedEntity: [{ routeId: "1" }],
    });

    const alert = toAlert(entity, ROUTE_MODE_BY_ID);
    expect(alert.informed.modes).toEqual(["subway"]);
  });

  it("defaults an untranslated header to an empty string, not undefined", () => {
    const entity = alertEntity("alert-3", {});
    const alert = toAlert(entity, ROUTE_MODE_BY_ID);
    expect(alert.header).toBe("");
  });
});

describe("matchesFilters / alertsMatching", () => {
  const subwayAlert = alertEntity("subway-alert", {
    effect: Effect.NO_SERVICE,
    headerText: { translation: [{ text: "Line 1 shuttle bus" }] },
    informedEntity: [{ routeId: "1" }],
  });
  const busAlert = alertEntity("bus-alert", {
    effect: Effect.ACCESSIBILITY_ISSUE,
    headerText: { translation: [{ text: "Elevator out at stop" }] },
    informedEntity: [{ routeId: "900", stopId: "662" }],
  });

  it("filters by mode", () => {
    const result = alertsMatching([subwayAlert, busAlert], ROUTE_MODE_BY_ID, {
      mode: "subway",
    });
    expect(result.map((a) => a.id)).toEqual(["subway-alert"]);
  });

  it("filters by route_id", () => {
    const result = alertsMatching([subwayAlert, busAlert], ROUTE_MODE_BY_ID, {
      routeId: "900",
    });
    expect(result.map((a) => a.id)).toEqual(["bus-alert"]);
  });

  it("filters by stop_id", () => {
    const result = alertsMatching([subwayAlert, busAlert], ROUTE_MODE_BY_ID, {
      stopId: "662",
    });
    expect(result.map((a) => a.id)).toEqual(["bus-alert"]);
  });

  it("filters by derived category", () => {
    const result = alertsMatching([subwayAlert, busAlert], ROUTE_MODE_BY_ID, {
      category: "elevator",
    });
    expect(result.map((a) => a.id)).toEqual(["bus-alert"]);
  });

  it("returns every alert when no filter is given", () => {
    const result = alertsMatching(
      [subwayAlert, busAlert],
      ROUTE_MODE_BY_ID,
      {},
    );
    expect(result.map((a) => a.id).sort()).toEqual([
      "bus-alert",
      "subway-alert",
    ]);
  });

  it("matchesFilters AND-combines multiple filters", () => {
    const alert = toAlert(subwayAlert, ROUTE_MODE_BY_ID);
    expect(
      matchesFilters(alert, { mode: "subway", category: "no_service" }),
    ).toBe(true);
    expect(matchesFilters(alert, { mode: "subway", category: "delay" })).toBe(
      false,
    );
    expect(matchesFilters(alert, { mode: "bus" })).toBe(false);
  });
});
