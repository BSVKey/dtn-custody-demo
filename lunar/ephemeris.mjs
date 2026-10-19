// Earth-Moon distance from a low-precision lunar ephemeris: Jean Meeus, Astronomical
// Algorithms (2nd ed.), chapter 47, the distance series of Table 47.A. Accurate to a few
// kilometres, which is about 0.01 ms of light time: far finer than any clock tolerance a
// light-time audit can use. Time is treated as TT; the UT difference (about a minute)
// moves the Moon by tens of kilometres at most.

const RAD = Math.PI / 180;
const norm = (deg) => ((deg % 360) + 360) % 360;

// [D, M, M', F, coefficient of cos(argument) in 0.001 km]
const TERMS = [
  [0, 0, 1, 0, -20905355], [2, 0, -1, 0, -3699111], [2, 0, 0, 0, -2955968], [0, 0, 2, 0, -569925],
  [0, 1, 0, 0, 48888], [0, 0, 0, 2, -3149], [2, 0, -2, 0, 246158], [2, -1, -1, 0, -152138],
  [2, 0, 1, 0, -170733], [2, -1, 0, 0, -204586], [0, 1, -1, 0, -129620], [1, 0, 0, 0, 108743],
  [0, 1, 1, 0, 104755], [2, 0, 0, -2, 10321], [0, 0, 1, 2, 0], [0, 0, 1, -2, 79661],
  [4, 0, -1, 0, -34782], [0, 0, 3, 0, -23210], [4, 0, -2, 0, -21636], [2, 1, -1, 0, 24208],
  [2, 1, 0, 0, 30824], [1, 0, -1, 0, -8379], [1, 1, 0, 0, -16675], [2, -1, 1, 0, -12831],
  [2, 0, 2, 0, -10445], [4, 0, 0, 0, -11650], [2, 0, -3, 0, 14403], [0, 1, -2, 0, -7003],
  [2, -1, 1, -2, 0], [2, 0, -1, 2, 0], [2, -1, -2, 0, 10056], [1, 0, 1, 0, 6322],
  [2, -2, 0, 0, -9884], [0, 1, 2, 0, 5751], [0, 2, 0, 0, 0], [2, -2, -1, 0, -4950],
  [2, 0, 1, -2, 4130], [2, 0, 0, 2, 0], [4, -1, -1, 0, -3958], [0, 0, 2, 2, 0],
  [3, 0, -1, 0, 3258], [2, 1, 1, 0, 2616], [4, -1, -2, 0, -1897], [0, 2, -1, 0, -2117],
  [2, 2, -1, 0, 2354], [2, 1, -2, 0, 0], [2, -1, 0, -2, 0], [4, 0, 1, 0, -1423],
  [0, 0, 4, 0, -1117], [4, -1, 0, 0, -1571], [1, 0, -2, 0, -1739], [2, 1, 0, -2, 0],
  [0, 0, 2, -2, -4421], [1, 1, 1, 0, 0], [3, 0, -2, 0, 0], [4, 0, -3, 0, 0],
  [2, -1, 2, 0, 0], [0, 2, 1, 0, 1165], [1, 1, -1, 0, 0], [2, 0, 3, 0, 0], [2, 0, -1, -2, 8752],
];

// Julian Date of a JavaScript Date (or epoch milliseconds).
export const julianDate = (t) => (typeof t === "number" ? t : t.getTime()) / 86400000 + 2440587.5;

// Geocentric distance Earth centre to Moon centre, km.
export function moonDistanceKm(t) {
  const T = (julianDate(t) - 2451545.0) / 36525;
  const D = norm(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T);
  const M = norm(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T);
  const Mp = norm(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T);
  const F = norm(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T);
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  let sum = 0;
  for (const [d, m, mp, f, c] of TERMS) {
    if (!c) continue;
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sum += c * e * Math.cos((d * D + m * M + mp * Mp + f * F) * RAD);
  }
  return 385000.56 + sum / 1000;
}

export const R_EARTH_KM = 6378.137;   // equatorial radius (WGS 84)
export const R_MOON_KM = 1737.4;      // mean radius

// The shortest one-way light time between an Earth ground station and a spacecraft around
// the Moon at time t: geocentric distance less the Earth's radius (the station can be on
// the near side) less the orbiter's greatest distance from the Moon's centre (it can be on
// the Earth-facing side). A receipt claiming less than this is physically impossible.
export function minEarthMoonLightMs(t, { orbitRadiusKm = R_MOON_KM } = {}) {
  return (moonDistanceKm(t) - R_EARTH_KM - orbitRadiusKm) / 299.792458;
}
