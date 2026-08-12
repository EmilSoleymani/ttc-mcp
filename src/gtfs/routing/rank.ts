import type { Itinerary } from "../../schemas/itinerary.js";

// Pure ranking/dedupe helpers for plan_trip alternates
// (docs/superpowers/specs/2026-08-04-plan-trip-design.md §"Alternates &
// ranking"). Two itineraries are "the same option" when their transit legs
// ride the same routes in the same order — so "same routes, next train" is not
// a distinct alternate.

/** The ordered route_ids of an itinerary's transit legs — its distinctness key. */
export function routeSignature(itinerary: Itinerary): string {
  return itinerary.legs
    .filter((leg) => leg.type === "transit")
    .map((leg) => (leg.type === "transit" ? leg.route_id : ""))
    .join(">");
}

/** Keep the first itinerary of each route-signature, preserving input order. */
export function dedupeBySignature(
  itineraries: readonly Itinerary[],
): Itinerary[] {
  const seen = new Set<string>();
  const out: Itinerary[] = [];
  for (const itinerary of itineraries) {
    const sig = routeSignature(itinerary);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(itinerary);
  }
  return out;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Earliest arrival first, then shortest duration (the depart-after order). */
export function sortByArrival(itineraries: readonly Itinerary[]): Itinerary[] {
  return [...itineraries].sort(
    (a, b) =>
      ms(a.arrive_time) - ms(b.arrive_time) ||
      a.duration_seconds - b.duration_seconds,
  );
}

/** Latest departure first, then shortest duration (the arrive_by order). */
export function sortByLatestDeparture(
  itineraries: readonly Itinerary[],
): Itinerary[] {
  return [...itineraries].sort(
    (a, b) =>
      ms(b.depart_time) - ms(a.depart_time) ||
      a.duration_seconds - b.duration_seconds,
  );
}
