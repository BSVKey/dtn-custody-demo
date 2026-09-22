// Gap object: turn a link outage (an occultation window) into a first-class record
// instead of an unexplained silence. Built from the link event log and the set of
// bundles that were delayed by the outage. Silence is documented, never read as
// "nothing happened."
//
// linkEvents: [{ link, event: "down"|"up", t }] for the occulted link.
// delayed:    bundleIds that departed during the outage and arrived after it.
// lost:       bundleIds confirmed never delivered (custody guarantees delivery, so
//             this is normally empty; a nonempty set is itself a documented fact).
export function gapObject({ link, linkEvents, delayed = [], lost = [] }) {
  const evs = [...linkEvents].filter((e) => e.link === link).sort((a, b) => a.t - b.t);
  const down = evs.find((e) => e.event === "down");
  const up = evs.find((e) => e.event === "up" && (!down || e.t >= down.t));
  return {
    kind: "gap/1",
    link,
    downAt: down ? down.t : null,
    upAt: up ? up.t : null,
    durationMs: down && up ? up.t - down.t : null,
    bundlesDelayed: [...delayed].sort(),
    bundlesLostConfirmed: [...lost].sort(),
    // The whole point: an outage is a recorded fact with a boundary, not a void.
    note: "occultation window; delivery resumed on link reopen (store-and-forward).",
  };
}
