# Reflection after first 15 tails — what's working, what isn't

## What worked

- **N163CP** (no type, KFNL↔KGXY ×5) correctly tagged `commuter_shuttle`. The route-pair-frequency rule fired cleanly. This is the textbook case: when airport endpoints exist and a tail flies the same A↔B repeatedly, we can name the mission.
- **N932EV CRJ2** flagged the most important hole — a regional jet (Bombardier CRJ200, Skywest fleet) sitting in `other_ga / general_recreational` because we only captured its descent into KDEN. The type code says airline; nothing else needs to be looked at.
- **Cruise-altitude lists** (N24144 at 6200/7500/7100/7100/6700) are a strong signal even when we don't know origins. A 6200-ft cruise near KAPA (5885 ft field elev) is ~300 ft AGL — pattern, not cross-country. A 7100-ft cruise is ~1200 ft AGL — also pattern/practice area. The IFR-vs-VFR split correctly tagged 69% IFR-cruise for N24144 *because the patterns happen at round-thousand AGL above the field*, which matches the IFR detector even though it's not actually IFR. That's a false-positive worth noting.
- **Speed-band totals** are informative: 56.5% of flights are "high_perf_piston" (160-220 kts) — but a chunk of those are actually descending jets/turboprops. Speed alone doesn't separate them; type code + cruise altitude does.

## What broke

### 1. Endpoint detection misses 94.3% of flights

The archive captures only the in-radius portion of each track (~36 nm around Boulder). For a flight from KAPA to KFNL, the captured points may begin AT the capture-radius boundary, miles from either airport. My `endpointAirports` rule requires the first/last fix to be within 2 nm of an airport — almost no captured flights satisfy that.

Consequence: 94.3% have "no airport endpoints" → my rules that fire on `startIcao == endIcao` or `startIcao !== endIcao` never trigger → everything falls into `general_recreational`.

**Fix**: relax to "closest airport at first fix / last fix, regardless of distance, BUT report the distance so we can weight confidence." A flight whose first fix is 8 nm from KAPA on a vector heading toward KAPA is plausibly from KAPA. A flight whose first fix is 20 nm from any airport is genuinely transiting.

### 2. Type-code override is missing

Type codes like CRJ2, B738, E75L, B737, A20N are *unambiguous*: those airframes are commercial airliners or regional jets, period. We should NEVER classify them as `private_transport` or `other_ga` regardless of what their in-radius track shape looks like. The first 15 caught one (CRJ2). Across all 823 there will be many more.

**Fix**: before the refined classifier runs, if the typeCode matches an airliner / regional-jet / bizjet regex, snap the tail to `airliner_overflight` / `bizjet_overflight` based on type. Don't try to infer from shape — we don't have enough of the flight to do shape correctly.

### 3. Three categories of "general_recreational" need separating

The 744 tails dumped into `general_recreational` aren't homogeneous:
- **Pattern aircraft we missed** (e.g. N739ZC: 14 flights / 4.3 h, ALL slow_piston cruise at 6200 ft = pattern altitude near KAPA, 0% direct). These are owner-proficiency or unaffiliated pattern flying. The home-field detection failed because there's no centroid near a single field.
- **In-region transients** (e.g. N932EV CRJ2: 7 flights / 0.8 h = ~7 min average — these are aircraft transiting the capture radius, mostly during descent into KDEN). Short captures, varied altitudes.
- **Aircraft genuinely doing local recreational flying** without a clear identifiable purpose (occasional flights, no pattern, no XC).

The split shows up in **total active hours**:
- N739ZC: 14 flights / 4.3 h (long captures, lots of time in region) → likely pattern aircraft
- N932EV: 7 flights / 0.8 h (short captures = brief overflights) → transient

**Fix**: use `total_active_hours / total_flights` as a discriminator:
- > 20 min/flight average + low altitude = `unidentified_local`
- < 10 min/flight average = `transient_overflight`

### 4. The IFR-cruise detector has a false-positive mode

N24144's "69% IFR-cruise" is misleading. The aircraft was doing pattern work at KAPA (field elev 5885) at altitudes of 6500-7300 MSL — which happen to land on 7000 ± 100 (= "IFR") rather than 7500 ± 100 (= "VFR") because pattern altitude at KAPA is 7385 MSL and the *practice area* is at 7000-8000. So the rule fires but it's not actually IFR.

**Mitigation**: only count IFR vs VFR when the flight is NOT in pattern phase. Use phaseML's phase labels: count IFR/VFR cruise ONLY during `en_route` / `inbound` / `departing` phases, NOT during `pattern` / `practice_area`. The fix is cheap; I'll add it.

## Best practices going forward

1. **Fall back gracefully on distance**, not on null. Replace "is this fix within 2 nm of an airport" with "what's the *closest* airport, and how far?" The classifier reasons better with a distance than with a null.
2. **Type code remains authoritative** for airframes whose type code is unambiguous. Don't let path-shape override "this is a 737". The path is incomplete; the type is not.
3. **Capture-region asymmetry matters**. An aircraft fully captured (taxi → takeoff → cruise → landing → taxi) is a different beast from one captured for 7 minutes mid-descent. Use `total_active_hours` and `points_per_flight` to surface that.
4. **Phase context belongs in every rule.** "Cruise altitude" only means something in the cruise phase. "Same airport" only means something if we have both endpoints. Conditioning rules on phaseML phases prevents accidental false positives.
5. **Honest catch-all > forced classification.** The current `general_recreational` swallowing 90% of tails is a smell. Better to split it into `unidentified_local` (we know it's local but not the mission), `transient_overflight` (we just glimpsed it), and `insufficient_data` (single short flight). Each has different actionability.

## Refinement plan before running on all 823

1. Add `inferredOriginIcao` + `originDistanceNm` + same for destination, using closest-airport-regardless-of-distance with a 50 nm cap.
2. Add a type-regex override at the *top* of `refineTailPurpose` — airliner/bizjet/turboprop types go straight to overflight buckets.
3. Replace `general_recreational` with three sub-buckets driven by `avg_active_min_per_flight` and `dominantHome`.
4. Gate IFR/VFR cruise counting on phaseML phase = `en_route` or `inbound` or `departing` (not `pattern` or `practice_area`).
5. Add an `owner_proficiency` bucket: home field present + 3-9 T&G + private GA type + average duration ≥ 20 min.
