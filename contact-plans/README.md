# contact-plans/

Per mission-tier link schedules. Each plan sets the one-way delay per link and a
scripted **occultation window** (a period where a link is fully down), so store-and-
forward and the gap object can be exercised deterministically.

Times may be scaled ("compressed") for the deep-space tiers so a run finishes in
minutes; each plan states its scale factor. One real-latency plan (Moon, 1.3 s) runs
unscaled as a fidelity check.

- `moon-occultation.json`   Moon: 1.3 s one-way, unscaled, far-side occultation.
- `mars-occultation.json`   Mars: 3-22 min, compressed, conjunction blackout. (TODO)
- `uranus-occultation.json` Uranus: ~2.6 light-hours, compressed. (TODO)

Schema (draft): `delays` sets per-link one-way delay + loss; `contacts` lists up/down
windows per link; `scale` is the wall-clock compression factor (1 = real time).
