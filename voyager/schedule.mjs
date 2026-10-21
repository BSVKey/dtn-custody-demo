// A mission's DSN tracks as a contact plan in this repo's format, compiled to ION and
// HDTN and signed as a dtn.contact-plan/1 record (contact-plans/sign.mjs). The run reads
// its link windows only from a plan that verifies under the scheduler's pinned key, and
// each gap record names the signed plan and is checked against it.
//
// Two links: UP (DSN -> spacecraft, commanding tracks only) and DOWN (spacecraft -> DSN,
// every track). DOWN contacts are in the spacecraft's time, a light time before the
// track, which is how ION reads "a contact" (the sender's transmit interval).
import { toIon, toHdtn } from "../contact-plans/compile.mjs";
import { signPlan, verifyPlan, contactAt } from "../contact-plans/sign.mjs";

const T = (iso) => Date.parse(iso);

// One track a day from a pattern; every Nth track (counting from the first) can command.
export function expandTracks(p) {
  const out = [];
  for (let d = 0; d < p.days; d++) {
    const day = new Date(T(`${p.firstDay}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
    if (p.missedDays.includes(day)) continue;
    const from = T(`${day}T${p.startUtc}:00Z`), to = from + p.hours * 3.6e6;
    const uplink = d % p.commandEveryNthDay === 0;
    out.push({ station: uplink ? p.commandStation ?? p.station : p.station, uplink, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  }
  return out;
}

export function missionPlan(m, common) {
  const epoch = T(m.planEpoch);
  const owltMs = Math.round(m.oneWayLightTimeH * 3.6e6);
  const sec = (ms) => Math.round((ms - epoch) / 1000);
  const dsn = common.dsnIpn, sc = m.ipn;
  const tracks = expandTracks(m.tracks);
  const contacts = [];
  for (const t of tracks) {
    if (t.uplink) contacts.push({ link: "UP", up_s: sec(T(t.from)), down_s: sec(T(t.to)), note: t.station });
  }
  for (const t of tracks) {
    contacts.push({ link: "DOWN", up_s: sec(T(t.from) - owltMs), down_s: sec(T(t.to) - owltMs), note: `${t.station} track, sent a light time early` });
  }
  return {
    name: m.spacecraft.toLowerCase().replace(" ", "-") + "-dsn",
    description: m.tracksNote,
    epoch: m.planEpoch,
    nodes: [{ ipn: dsn, name: "Deep Space Network" }, { ipn: sc, name: m.spacecraft }],
    links: [{ id: "UP", from: dsn, to: sc }, { id: "DOWN", from: sc, to: dsn }],
    delays: {
      UP: { one_way_ms: owltMs, rate_bps: m.uplinkBps },
      DOWN: { one_way_ms: owltMs, rate_bps: m.downlinkBps },
    },
    contacts,
  };
}

export function exportsOf(plan) {
  return { ion: toIon(plan), hdtn: JSON.stringify(toHdtn(plan), null, 2) };
}

export function signSchedule(kp, plan) {
  const last = Math.max(...plan.contacts.map((c) => c.down_s));
  return signPlan(kp, {
    plan, exports: exportsOf(plan), network: "dsn-voyager", version: 1,
    validFrom: plan.epoch, validTo: new Date(T(plan.epoch) + last * 1000).toISOString(),
  });
}

// Link windows (absolute ms) for one link, only from a plan that verifies. Throws otherwise.
export function windowsFrom(record, plan, pub, linkId) {
  const v = verifyPlan(record, { pub, plan, exports: exportsOf(plan) });
  if (!v.ok) throw new Error(`contact plan refused: ${v.problems.join(", ")}`);
  const epoch = T(plan.epoch);
  return plan.contacts.filter((c) => c.link === linkId).map((c) => [epoch + c.up_s * 1000, epoch + c.down_s * 1000]);
}

// A gap is backed by the plan if no contact on that link was in force at any time inside it.
export function gapBackedByPlan(gap, plan, linkId) {
  const epoch = T(plan.epoch), link = plan.links.find((l) => l.id === linkId);
  const from = gap.downAt ?? -Infinity, to = gap.upAt;
  const inForce = plan.contacts.filter((c) => c.link === linkId
    && epoch + c.up_s * 1000 < to && epoch + c.down_s * 1000 > from);
  // contactAt is the plan's own query; use it at the gap's midpoint as a cross-check.
  const mid = Number.isFinite(from) ? (from + to) / 2 : to - 1000;
  return inForce.length === 0 && contactAt(plan, link.from, link.to, (mid - epoch) / 1000).length === 0;
}
