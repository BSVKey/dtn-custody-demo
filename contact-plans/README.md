# contact-plans/

Mission link schedules. Each plan names its nodes (ipn node numbers), its links, the
one-way light time and loss per link, the contact windows per link, and the outage
(occultation, station handover) that store-and-forward and the gap object must survive.

| Plan | Path | One-way light time on the space link | Outage |
|---|---|---|---|
| `moon-occultation.json` | far-side lander, lunar relay orbiter, Earth station, operations | 1.3 s (real) | orbiter behind the Moon, 120 s to 300 s |
| `l1-solar-wind.json` | L1 space-weather observatory, ground network, forecast center, customer | 5 s (real) | ground-station handover, 600 s to 780 s |
| `mars-relay.json` | rover, Mars relay orbiter, Deep Space Network, operations | 750 s (12.5 min, mid-range; real range about 3 to 22 min) | orbiter behind Mars, 1,200 s to 3,600 s |
| `uranus-latency.json` | Uranus orbiter, Deep Space Network, operations, archive | 9,360 s (about 2.6 light-hours) | planetary occultation, 28,800 s to 39,600 s |

Uranus is a latency and distance exemplar (the 2023 Decadal #1 flagship), not an ocean
world. The ocean-world targets are moons, canonically Enceladus and Europa.

## Compile to NASA formats

```bash
node contact-plans/compile.mjs contact-plans/mars-relay.json --hdtn mars.hdtn.json --ion mars.ionrc
```

- **HDTN (NASA Glenn):** JSON `{"contacts":[{contact, source, dest, startTime, endTime,
  rateBitsPerSec, owlt}]}`, the format of HDTN's own `module/router/contact_plans/`.
- **ION (JPL):** `a contact +start +end from to rate` and `a range +start +end from to owlt`.

Both formats take whole seconds; plans keep exact milliseconds for the simulator. HDTN and
ION get real mission timing by default; `--scaled` applies the plan's compression factor.
`generated/` holds the compiled output for every plan (checked by the test suite).

## Schema

`nodes` (ipn number and name), `links` (`id`, `from`, `to`; plain names are read as a
chain 1, 2, 3, ...), `delays` (per link: `one_way_ms`, `loss_pct`, `reorder_pct`,
`rate_bps`), `contacts` (per link: `up_s`, `down_s`), `occultation` (the outage the gap
object records) and `scale` (wall-clock compression for real-transport runs; 1 = real time).
The simulator's path is three links (L1, L2, L3).
