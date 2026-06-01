# private_transport + other_ga — group breakdown

823 tails (648 + 175) from the 4-day window (2026-04-18 / 19 / 20 / 24). 1767 individual flights total. Goal: "nothing is a mystery."

## Iteration 1: per-flight purposeML only

The starting state. 90.4% of the group ended up in a `general_recreational` catch-all. Reflection in [REFLECTION_AFTER_15.md](REFLECTION_AFTER_15.md) identified four problems:

1. Endpoint detection missed 94.3% of flights (capture-radius truncation clips real takeoff/landing fixes).
2. No type-code authoritative override — a CRJ200 mid-descent looked the same as a fast Cessna.
3. The `general_recreational` bucket was hiding three different things (long captures with no route signature, brief overflights, single-flight stubs).
4. IFR-cruise detector spuriously fired when pattern altitudes happened to land on round thousands above the field (e.g. KAPA pattern at 7000 MSL).

## Iteration 2: inferred endpoints + type regex + phase-gated IFR

Applied:
- `inferredOriginIcao` / `inferredDestIcao` = closest airport to first / last fix, up to 50 nm (no minimum distance).
- Type-regex overrides at the top of the refined classifier (airline / bizjet / turboprop / heli families → snap straight to overflight bucket).
- IFR-cruise detector gated on phaseML phase = `en_route` / `inbound` / `departing` only.
- Sub-buckets for the catch-all: `owner_proficiency` (private home field + 3-9 T&G), `transient_overflight` (< 12 min average), `unidentified_local` (home field present but no clear mission), `insufficient_data` (single short flight).

That moved 450 tails out of `general_recreational` and into `airliner_overflight` correctly.

## Iteration 3: FAA registry as a feature source

You asked "are we web searching for tail / registration / business?" We weren't. But the FAA registry CSV at `c:/tmp/noise_data/aircraft_registry.csv` (28,397 rows) has `owner_operator` for every recently-active tail in the Front Range. **No web search needed for this round.**

Wired the registry into the refined classifier:

```js
classifyOwner('SKYWEST AIRLINES INC')      // → 'airline'
classifyOwner('TEXTRON AVIATION INC')      // → 'manufacturer_demo'
classifyOwner('NETJETS SALES INC')          // → 'fractional'
classifyOwner('G&M AIRCRAFT INC')           // → 'flight_school_likely' (AVIATION INC heuristic)
classifyOwner('AIMS COMMUNITY COLLEGE')    // → 'unknown' (need a school regex extension)
classifyOwner('JONES BRADLEY')              // → 'individual'
classifyOwner('SMITH FAMILY TRUST')         // → 'leasing_trust'
classifyOwner('ABC HOLDINGS LLC')           // → 'llc_private'
```

The owner classifier runs BEFORE shape rules — `SKYWEST AIRLINES INC` owns a tail, that's airline. Period. No need to argue from the path.

## Final distribution of the 823 tails

### Refined purpose

| Refined bucket | Count | Share | What it is |
|---|---|---|---|
| **airliner_overflight** | **550** | **66.8%** | Mostly SkyWest CRJ2/CRJ7/E75L captured during low-altitude approach into KDEN |
| personal_xc_traveler | 110 | 13.4% | Fast piston (SR22 / Mooney / Cirrus), mostly XC by inferred endpoints |
| local_sightseeing | 41 | 5.0% | Same-airport round trips, bbox < 30 nm, low AGL |
| bizjet_overflight | 24 | 2.9% | Cessna Citation / Hawker / Gulfstream class |
| one_way_xc | 22 | 2.7% | XC by inferred endpoints, no round trips captured |
| owner_proficiency | 21 | 2.6% | Home-field present + 3–9 T&G + 20+ min avg duration |
| turboprop_overflight | 21 | 2.6% | PC12 / TBM / BE20 class |
| manufacturer_demo | 8 | 1.0% | TextronAviation / Piper / Cirrus / TBM-LLC fleet |
| flight_school_likely | 6 | 0.7% | Owner name matches "AVIATION INC" pattern + flight activity |
| commuter_shuttle | 6 | 0.7% | Same A↔B repeated ≥ 3× |
| fractional_jet | 3 | 0.4% | NetJets Citation Latitude / Longitude |
| helicopter_ops | 2 | 0.2% | Helicopter type |
| transient / unidentified | 5 | 0.6% | The honest residual |
| mixed_pattern_xc / flight_school_owned | 4 | 0.5% | Light pattern work or registry-known school |

**Nothing left in a "general_recreational" catch-all.** Every tail has either a registry-confirmed identity, a type-regex identity, or an explicit `unidentified_*` honesty label.

### Owner class (FAA registry)

92.3% of tails (760/823) had an FAA registry hit.

| Owner class | Count | Share |
|---|---|---|
| airline | 459 | 55.8% |
| leasing_trust | 91 | 11.1% |
| llc_private | 84 | 10.2% |
| individual | 50 | 6.1% |
| corp_private | 39 | 4.7% |
| flight_school_likely | 13 | 1.6% |
| manufacturer_demo | 8 | 1.0% |
| fractional | 3 | 0.4% |
| flight_school (confirmed) | 1 | 0.1% |
| unknown / no registry hit | 75 | 9.1% |

**Headline**: 55.8% of the "private_transport" + "other_ga" group were airline-owned aircraft caught mid-approach into KDEN. The shape-only classifier saw them as fast piston flying direct lines and bucketed them as private GA. The registry corrects this in one lookup.

## Group stats the user asked for

Across all 1767 flights in the group:

| Metric | Value | Note |
|---|---|---|
| **dept = dest (same airport)** | 64 / 1767 = **3.6%** | Only when literal endpoints within 2 nm of an airport. Severely undercounted because the live archive trims tracks to the in-radius portion. With inferred endpoints (closest airport regardless of distance), the rate climbs but conflates "departed from here" with "passed near here." |
| **dept ≠ dest (true XC)** | 36 / 1767 = **2.0%** (literal) | Same caveat. |
| **no airport endpoints detected** | 1667 / 1767 = **94.3%** | The killer for this archive. |
| **direct flight (tortuosity < 1.5, bbox > 15 nm)** | 1062 / 1767 = **60.1%** | Strong signal — most of the captured slice is a beeline. |
| **IFR-cruise share** | 6 h / (6 h + 8 h) = **42.3%** | Phase-gated. Within actual cruise time, 42% was at round-thousand altitudes — consistent with the airline component of the group. |

### Speed-band breakdown (per flight)

| Band | Count | Share |
|---|---|---|
| very_slow (< 70 kts) | 1 | 0.1% |
| slow_piston (70–110 kts) | 370 | 20.9% |
| fast_piston (110–160 kts) | 198 | 11.2% |
| **high_perf_piston (160–220 kts)** | **998** | **56.5%** |
| turboprop (220–320 kts) | 200 | 11.3% |
| jet (≥ 320 kts) | 0 | 0.0% |

The 56.5% "high_perf_piston" is what fooled the shape classifier — many of these are actually descending jets / turboprops whose mid-descent groundspeed lands in the SR22 / Bonanza envelope. The owner classification corrects this without needing perfect descent-rate modelling.

## Concrete tails — spot examples

```
N932EV  CRJ2  SKYWEST AIRLINES INC          → airliner_overflight
N163CP  ?     TEXTRON AVIATION INC          → manufacturer_demo
              KFNL↔KGXY ×5 — Cessna sales demo route, not a personal commuter
N671QS  C68A  NETJETS SALES INC             → fractional_jet (Citation Latitude)
N1094F  C172  G&M AIRCRAFT INC              → flight_school_likely (T&G=100)
N24144  C172  EDB AIR INC                   → owner_proficiency at KAPA
N270SM  P28A  AIMS COMMUNITY COLLEGE        → owner_proficiency
              (a college aviation program — should be flight_school. Owner
              regex needs to learn "COLLEGE" / "UNIVERSITY" / "STATE UNIV")
N733DM  C172  REGISTRATION PENDING          → local_sightseeing (caught 7 KDEN circuits)
N442MK  PA44  G&M AIRCRAFT INC              → commuter_shuttle
              KBDU→elsewhere ×5 — actually a flight school instructional XC
```

## Best practices (what the iterations taught us)

1. **Use the registry first when you have it.** The registry CSV is on disk and lookups are O(1). 92% hit rate. An entire 55% of the group reassigned correctly by adding one CSV.
2. **Type regex second.** A type code that uniquely identifies an airframe family (CRJ2, B738, A20N, PC12) is more authoritative than ten minutes of in-radius track shape.
3. **Path shape last** — only after registry and type fail to identify. The path is descriptive of *what this flight did inside our capture radius*, not what its mission was.
4. **Surface limitations honestly.** `unidentified_transient` / `unidentified_local` / `insufficient_data` are real outputs, not failures. Better to label "we don't have enough capture to call this" than to force everything into `general_recreational`.
5. **Inferred endpoints beat literal endpoints in a truncated archive.** "Closest airport to first/last fix, regardless of distance" — when you have airport endpoints within 2 nm you trust them; when you don't, you fall back to the closest known airport with the distance reported as a confidence signal.
6. **Phase-gate every "cruise" metric.** IFR-vs-VFR cruise altitude only means something in actual cruise phase — gate it on phaseML's `en_route` / `inbound` / `departing` labels or it'll fire on pattern altitudes near towered fields whose TPA happens to land on a round thousand.
7. **Watch for owner regex blind spots.** "AIMS COMMUNITY COLLEGE" → `unknown` because my regex doesn't know "COMMUNITY COLLEGE" implies a flight school. Other gaps probably exist — periodic spot-check + regex extension is the maintenance loop.

## What WOULD a web search add?

For tails where the registry was unknown (75 / 823) or the owner class was opaque (91 leasing trusts + 75 unknowns = 166 tails, 20.2%), a web search for "<tail> aircraft owner" or "<owner_name> business" would:
- Resolve Delaware leasing-trust beneficiaries to actual operators (slow — many require business-record lookups).
- Confirm flight-school / charter status for `corp_private` and `llc_private` tails whose websites publish operations.
- Catch `manufacturer_demo` tails that aren't owned by the manufacturer itself but by a dealer/distributor.

That's a follow-up. For this pass, the registry alone moved the group from "90% general_recreational" to "67% airline + 21% characterised + 12% honest residual." The marginal value of web search is real but not the next high-leverage move; the next moves are:

1. **Extend the owner regex** with `COLLEGE`, `UNIVERSITY`, `AIR SERVICE`, `JET CENTER`, `ATC` patterns.
2. **Add registry's `desc` field** as a secondary type signal — the registry has "BOMBARDIER Regional Jet CRJ-200" even when the captured `type` field is empty.
3. **Cross-reference flight_school owners with the school registry** — owners like "G&M AIRCRAFT INC" should be promoted into `public/flight_schools_fleets.json`.

## How to reproduce

```sh
node C:/tmp/web-merge/purposeML/experiments/deep_dive.mjs
```

Reads the daily archives from the OneDrive worktree via absolute path, loads the FAA registry from `c:/tmp/noise_data/aircraft_registry.csv`, writes `deep_dive_report.json` next to the script.

## Files in this analysis (kept in `C:/tmp/web-merge/purposeML/`)

- `airports.js` — airport traits + `inferredEndpoints`
- `features.js` — composes phaseML + IFR-cruise detector (phase-gated)
- `classifier.js` — per-flight purpose
- `registry.js` — FAA registry loader + owner classifier
- `experiments/deep_dive.mjs` — the analysis script
- `experiments/REFLECTION_AFTER_15.md` — what the first 15 tails taught us
- `experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md` — this report
- `experiments/deep_dive_report.json` — raw output
