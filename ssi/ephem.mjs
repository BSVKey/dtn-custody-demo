// Geometry for the accountable Solar System Internet run: where the Moon, Mars, relay
// orbiters, landers and Earth stations are, what each can see, and the light time between
// them. Geocentric, equatorial (J2000-like, precession ignored), kilometres, time in epoch ms.
//
// Accuracy is what visibility and light time need, not navigation:
// - Mars: Keplerian elements of Standish's "Approximate Positions of the Planets" (valid
//   1800-2050, Table 1), Earth taken as the Earth-Moon barycentre (about 4,700 km off).
// - Moon: direction from the Astronomical Almanac low-precision series (about 0.3 deg),
//   distance from Meeus (lunar/ephemeris.mjs, a few km).
// - Earth: a sphere turning at the sidereal rate (GMST), stations at their real coordinates.
// Relay orbits are circles in the plane through the Earth line, the case with the most
// occultation; landers and rovers sit on spheres that turn with their bodies.
import { moonDistanceKm, julianDate } from "../lunar/ephemeris.mjs";

const RAD = Math.PI / 180, AU = 149597870.7, C_KM_S = 299792.458, EPS = 23.43928 * RAD;
export const R = { EARTH: 6378.137, MOON: 1737.4, MARS: 3389.5 };
export const lightMs = (km) => (km / C_KM_S) * 1000;

const v = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] };
v.len = (a) => Math.sqrt(v.dot(a, a));
v.unit = (a) => v.mul(a, 1 / v.len(a));
export { v as vec };

const centuries = (t) => (julianDate(t) - 2451545.0) / 36525;
const eclToEq = ([x, y, z]) => [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)];

// Heliocentric ecliptic position (AU) from Keplerian elements [a, e, I, L, varpi, Omega] + rates per century.
function kepler(el, T) {
  const [a, e, I, L, wbar, O] = el.map(([x0, x1]) => x0 + x1 * T);
  const w = (wbar - O) * RAD, Om = O * RAD, inc = I * RAD;
  let M = ((L - wbar) % 360) * RAD, E = M;
  for (let k = 0; k < 8; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(inc), sI = Math.sin(inc);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}
const EMB = [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]];
const MARS = [[1.52371034, 0.00001847], [0.0933941, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]];

export function marsPos(t) {
  const T = centuries(t);
  const d = v.sub(kepler(MARS, T), kepler(EMB, T));
  return v.mul(eclToEq(d), AU);
}

export function moonPos(t) {
  const T = centuries(t), s = (x) => Math.sin(x * RAD);
  const lam = 218.32 + 481267.881 * T + 6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T)
    + 0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T) - 0.19 * s(357.5 + 35999.05 * T) - 0.11 * s(186.5 + 966404.03 * T);
  const bet = 5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T) - 0.28 * s(318.3 + 6003.15 * T) - 0.17 * s(217.6 - 407332.21 * T);
  const r = moonDistanceKm(t), cb = Math.cos(bet * RAD);
  return v.mul(eclToEq([cb * Math.cos(lam * RAD), cb * Math.sin(lam * RAD), Math.sin(bet * RAD)]), r);
}

// An Earth station (geodetic lat/lon in degrees, east positive) in the inertial frame.
export function stationPos(t, { lat, lon }) {
  const gmst = 280.46061837 + 360.98564736629 * (julianDate(t) - 2451545.0);
  const th = (gmst + lon) * RAD, ph = lat * RAD;
  return v.mul([Math.cos(ph) * Math.cos(th), Math.cos(ph) * Math.sin(th), Math.sin(ph)], R.EARTH);
}

// Elevation (deg) of `target` seen from a surface point `site` on a body centred at `centre`.
export function elevation(site, centre, target) {
  const up = v.unit(v.sub(site, centre)), d = v.sub(target, site);
  return Math.asin(v.dot(d, up) / v.len(d)) / RAD;
}

// Does the segment a->b pass through a sphere (centre c, radius r)? Endpoints on the surface count as clear.
export function blocked(a, b, c, r) {
  const ab = v.sub(b, a), s = Math.max(0, Math.min(1, v.dot(v.sub(c, a), ab) / v.dot(ab, ab)));
  return v.len(v.sub(v.add(a, v.mul(ab, s)), c)) < r - 1;
}

// A relay in a circular orbit round `centreFn`, its plane containing the Earth line.
export function orbiter(centreFn, { radius, periodH, phase = 0 }) {
  return (t) => {
    const c = centreFn(t), u = v.unit(c);
    const w = v.unit(v.sub([0, 0, 1], v.mul(u, u[2])));
    const th = (2 * Math.PI * t) / (periodH * 3.6e6) + phase;
    return v.add(c, v.add(v.mul(u, radius * Math.cos(th)), v.mul(w, radius * Math.sin(th))));
  };
}

// A point on a body: fixed above the far side (tidally locked Moon), or turning with Mars.
export function farSide(centreFn, radius, { latDeg = 0 } = {}) {
  return (t) => {
    const c = centreFn(t), u = v.unit(c), w = v.unit(v.sub([0, 0, 1], v.mul(u, u[2])));
    return v.add(c, v.mul(v.unit(v.add(v.mul(u, Math.cos(latDeg * RAD)), v.mul(w, Math.sin(latDeg * RAD)))), radius));
  };
}
const MARS_POLE = v.unit([Math.cos(52.886 * RAD) * Math.cos(317.681 * RAD), Math.cos(52.886 * RAD) * Math.sin(317.681 * RAD), Math.sin(52.886 * RAD)]);
export function marsSurface({ latDeg, lonDeg, rotH = 24.6229 }) {
  const a1 = v.unit(v.cross([0, 0, 1], MARS_POLE)), a2 = v.cross(MARS_POLE, a1);
  return (t) => {
    const ph = (2 * Math.PI * t) / (rotH * 3.6e6) + lonDeg * RAD, la = latDeg * RAD;
    const dir = v.add(v.add(v.mul(a1, Math.cos(la) * Math.cos(ph)), v.mul(a2, Math.cos(la) * Math.sin(ph))), v.mul(MARS_POLE, Math.sin(la)));
    return v.add(marsPos(t), v.mul(dir, R.MARS));
  };
}
