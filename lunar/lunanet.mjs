// A LunaNet-shaped custody run: three providers carry one BPv7 bundle from a lunar lander
// to an Earth ground station, through a surface relay that does not sign, across a far-side
// occultation and the Earth-Moon light time. Every step uses the real block 224 code path
// (receipt v2, COSE_Sign1) and a payload BIB (RFC 9172/9173) beside it.
//
// LunaNet Interoperability Specification v5 (29 January 2025), section 3.1.2: BPv7 "shall
// be used"; bundles ride TCPCL or UDPCL over IP, or LTPCL / EPPCL over AOS or USLP.
// Extension blocks travel inside the bundle, so the convergence layer does not change them.
import { encode } from "../transport/bpv7/cbor.mjs";
import { encodeBundle, decodeBundle, encodeEid, putBlock, BLOCK, CRC16, CRC32C } from "../transport/bpv7/bundle.mjs";
import { stampBundleV2, verifyBundleV2, readBlockItems, receiptFields } from "../transport/bpv7/receipt-v2.mjs";
import { addBib, verifyBibs } from "../transport/bpv7/bpsec.mjs";
import { genKeypair } from "../agent/lib/keys.mjs";
import { moonDistanceKm, minEarthMoonLightMs, R_MOON_KM } from "./ephemeris.mjs";

// Speed of light, and the one-way delays used below. The trunk distance is not fixed: it
// comes from the lunar ephemeris at the time of the contact (ephemeris.mjs).
export const C_KM_PER_MS = 299.792458;
export const lightMs = (km) => km / C_KM_PER_MS;
export const LINKS = {
  surface: { km: 2, label: "lander to surface relay (lunar surface wireless)" },
  proximity: { km: 3000, label: "surface relay to relay orbiter (proximity link)" },
  trunk: { km: null, label: "relay orbiter to Earth ground station (direct-with-Earth), from the ephemeris" },
};

// DTN time is milliseconds since 2000-01-01T00:00:00Z (RFC 9171 section 4.2.6).
const DTN_EPOCH = Date.parse("2000-01-01T00:00:00Z");
export const dtnTime = (iso) => Date.parse(iso) - DTN_EPOCH;
const unixMs = (dtn) => dtn + DTN_EPOCH;

// The relay orbiter's greatest distance from the Moon's centre (a low lunar orbit here; an
// NRHO relay would pass tens of thousands of km and loosen the bound accordingly).
export const ORBIT_RADIUS_KM = R_MOON_KM + 3000;

export const EID = {
  source: "ipn:101.1",       // the lander's science instrument
  lander: "ipn:101.0",       // provider A: lander operator (custodian)
  surface: "ipn:102.0",      // a surface relay that forwards but does not sign
  orbiter: "ipn:201.0",      // provider B: lunar relay orbiter (custodian)
  ground: "ipn:301.0",       // provider C: Earth ground station (custodian)
  missionOps: "ipn:401.1",   // destination: the science team on Earth
};

function withPreviousNode(bytes, eid) {
  const b = decodeBundle(bytes);
  return encodeBundle(putBlock(b, { type: BLOCK.PREVIOUS_NODE, crcType: CRC16, data: encode(encodeEid(eid)) }));
}

// Timing audit: a custodian cannot receive a bundle before light could have carried it
// from the previous custodian. tolerance covers clock offset between providers (LunaNet
// provides a common time service; the default here is 50 ms).
export function auditLightTime(bytes, minDelayMs, { toleranceMs = 50 } = {}) {
  const { items } = readBlockItems(decodeBundle(bytes));
  const hops = items.map(receiptFields);
  const findings = [];
  for (let i = 1; i < hops.length; i++) {
    const a = hops[i - 1], b = hops[i];
    const floor = minDelayMs[`${a.thisHop}>${b.thisHop}`];
    if (floor === undefined) continue;
    const actual = b.receivedAt - a.forwardedAt;
    findings.push({ from: a.thisHop, to: b.thisHop, minMs: Math.round(floor), actualMs: actual, ok: actual + toleranceMs >= floor });
  }
  return { ok: findings.every((f) => f.ok), findings };
}

// Build the scenario. backdate: the ground station claims it received the bundle before
// light could have arrived (the timing audit must catch it).
export function lunanetRun({ backdateGroundMs = 0, payload } = {}) {
  const keys = { lander: genKeypair(), orbiter: genKeypair(), ground: genKeypair() };
  const pinned = { [EID.lander]: keys.lander.pub, [EID.orbiter]: keys.orbiter.pub, [EID.ground]: keys.ground.pub };
  const bibKey = Buffer.alloc(32, 7);
  const data = payload ?? Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131) & 0xff));

  const t0 = dtnTime("2026-11-02T14:00:00Z");
  const created = [t0, 1];
  let bytes = encodeBundle(addBib({
    primary: { crcType: CRC32C, dest: EID.missionOps, source: EID.source, created, lifetime: 86400000 },
    blocks: [{ type: BLOCK.PAYLOAD, number: 1, crcType: CRC32C, data }],
  }, { targets: [1], key: bibKey, source: EID.source, scope: 7 }));

  const surfaceMs = lightMs(LINKS.surface.km), proxMs = lightMs(LINKS.proximity.km);
  // 1. Lander takes custody from its instrument and holds briefly before its contact.
  const landerIn = t0 + 200, landerOut = t0 + 60_000;
  bytes = stampBundleV2(bytes, { kp: keys.lander, eid: EID.lander }, { prevHop: EID.source, receivedAt: landerIn, forwardedAt: landerOut });
  // 2. The surface relay forwards without signing; BPv7 sets its Previous Node block.
  const surfaceIn = landerOut + Math.ceil(surfaceMs), surfaceOut = surfaceIn + 1_000;
  bytes = withPreviousNode(bytes, EID.surface);
  // 3. The relay orbiter holds the bundle through a 47-minute far-side occultation.
  const orbiterIn = surfaceOut + Math.ceil(proxMs), occultationMs = 47 * 60_000;
  const orbiterOut = orbiterIn + occultationMs;
  bytes = stampBundleV2(bytes, { kp: keys.orbiter, eid: EID.orbiter }, { receivedAt: orbiterIn, forwardedAt: orbiterOut });
  bytes = withPreviousNode(bytes, EID.orbiter);
  // 4. The Earth ground station receives after the Earth-Moon light time at that moment.
  const trunkKm = moonDistanceKm(unixMs(orbiterOut)) - 6378.137;
  const trunkMs = lightMs(trunkKm);
  const groundIn = orbiterOut + Math.ceil(trunkMs) - backdateGroundMs, groundOut = groundIn + 2_000;
  bytes = stampBundleV2(bytes, { kp: keys.ground, eid: EID.ground }, { receivedAt: groundIn, forwardedAt: groundOut });
  bytes = withPreviousNode(bytes, EID.ground);

  const chain = verifyBundleV2(bytes, { keys: pinned, origin: EID.source });
  const bib = verifyBibs(decodeBundle(bytes), bibKey);
  const timing = auditLightTime(bytes, {
    [`${EID.lander}>${EID.orbiter}`]: surfaceMs + proxMs,
    [`${EID.orbiter}>${EID.ground}`]: minEarthMoonLightMs(unixMs(orbiterOut), { orbitRadiusKm: ORBIT_RADIUS_KM }),
  });
  return { bytes, chain, bib, timing, occultationMs, trunkMs, trunkKm, moonKm: moonDistanceKm(unixMs(orbiterOut)), receiptBytes: bytes.length };
}
