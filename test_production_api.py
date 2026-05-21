"""In-situ test of all deployed /api/excursions and /api/adsb endpoints.
Reports HTTP status, response time, payload size, and a sanity-check
field to confirm the JSON shape is what we expect.

Usage:
    python test_production_api.py              # Railway production
    python test_production_api.py --local      # localhost:5174
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = 'https://web-app-production-fedf.up.railway.app'
if '--local' in sys.argv:
    BASE = 'http://localhost:5174'

TESTS = [
    {
        'name': 'flight-ops (no base)',
        'path': '/api/excursions/flight-ops',
        'check': lambda d: ('total' in d and 'summary' in d and 'aircraft' in d),
        'summary': lambda d: f'{d["total"]} aircraft, {len(d["summary"])} intent groups',
    },
    {
        'name': 'flight-ops KBDU r=10',
        'path': '/api/excursions/flight-ops?base=KBDU&radius=10',
        'check': lambda d: d.get('base', {}).get('code') == 'KBDU',
        'summary': lambda d: f'KBDU r={d["base"]["radius_nm"]}nm: {d["total"]} aircraft',
    },
    {
        'name': 'flight-ops KBJC r=15',
        'path': '/api/excursions/flight-ops?base=KBJC&radius=15',
        'check': lambda d: d.get('base', {}).get('code') == 'KBJC',
        'summary': lambda d: f'KBJC r={d["base"]["radius_nm"]}nm: {d["total"]} aircraft',
    },
    {
        'name': 'flight-ops KLMO r=8',
        'path': '/api/excursions/flight-ops?base=KLMO&radius=8',
        'check': lambda d: d.get('base', {}).get('code') == 'KLMO',
        'summary': lambda d: f'KLMO r={d["base"]["radius_nm"]}nm: {d["total"]} aircraft',
    },
    {
        'name': 'flight-ops KAPA r=10',
        'path': '/api/excursions/flight-ops?base=KAPA&radius=10',
        'check': lambda d: d.get('base', {}).get('code') == 'KAPA',
        'summary': lambda d: f'KAPA r={d["base"]["radius_nm"]}nm: {d["total"]} aircraft',
    },
    {
        'name': 'flight-ops KGXY r=10',
        'path': '/api/excursions/flight-ops?base=KGXY&radius=10',
        'check': lambda d: d.get('base', {}).get('code') == 'KGXY',
        'summary': lambda d: f'KGXY r={d["base"]["radius_nm"]}nm: {d["total"]} aircraft',
    },
    {
        'name': 'segments (all, 24h)',
        'path': '/api/excursions/segments?hours=24&limit=10',
        'check': lambda d: 'tracks' in d and 'window' in d,
        'summary': lambda d: f'{len(d.get("tracks",[]))} tracks matched (of {d.get("matched",0)})',
    },
    {
        'name': 'segments (N52993, 720h)',
        'path': '/api/excursions/segments?tail=N52993&hours=720',
        'check': lambda d: 'tracks' in d,
        'summary': lambda d: f'N52993: {len(d.get("tracks",[]))} tracks in 30 days',
    },
    {
        'name': 'active (1h)',
        'path': '/api/excursions/active?hours=1',
        'check': lambda d: 'active' in d,
        'summary': lambda d: f'{len(d.get("active",[]))} aircraft with excursions',
    },
    {
        'name': 'boot',
        'path': '/api/excursions/boot',
        'check': lambda d: isinstance(d, dict),
        'summary': lambda d: f'{len(d.get("tracks",[]))} tracks, {len(d.get("excursions",[]))} excursions',
    },
    {
        'name': 'excursions?tail=N52993',
        'path': '/api/excursions?tail=N52993&from=2026-03-01&to=2026-04-24',
        'check': lambda d: d.get('tail') == 'N52993',
        'summary': lambda d: f'N52993: {d.get("total_offenses",0)} excursions',
    },
    {
        'name': 'adsb/live',
        'path': '/api/adsb/live',
        'check': lambda d: 'aircraft' in d,
        'summary': lambda d: f'{len(d.get("aircraft",[]))} aircraft in live feed',
    },
    {
        'name': 'adsb/flights',
        'path': '/api/adsb/flights',
        'check': lambda d: 'flights' in d,
        'summary': lambda d: f'{len(d.get("flights",[]))} fleet flights',
    },
    {
        'name': 'adsb/stats',
        'path': '/api/adsb/stats',
        'check': lambda d: 'groups' in d,
        'summary': lambda d: f'{len(d.get("groups",[]))} stat groups',
    },
    {
        'name': 'adsb/active-tow',
        'path': '/api/adsb/active-tow',
        'check': lambda d: 'tow_planes' in d,
        'summary': lambda d: f'{len(d.get("tow_planes",[]))} active tow planes',
    },
]


def run_test(t):
    url = BASE + t['path']
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            elapsed_ms = int((time.time() - t0) * 1000)
            status = resp.status
            body = resp.read()
            size = len(body)
            try:
                data = json.loads(body)
                ok = t['check'](data)
                detail = t['summary'](data) if ok else 'SHAPE MISMATCH'
            except json.JSONDecodeError:
                ok = False
                detail = f'NOT JSON (first 80 bytes: {body[:80]!r})'
            return {
                'name': t['name'], 'status': status, 'elapsed_ms': elapsed_ms,
                'size': size, 'ok': ok, 'detail': detail,
            }
    except urllib.error.HTTPError as e:
        return {
            'name': t['name'], 'status': e.code, 'elapsed_ms': int((time.time()-t0)*1000),
            'size': 0, 'ok': False, 'detail': f'HTTP {e.code}: {e.reason}',
        }
    except Exception as e:
        return {
            'name': t['name'], 'status': 0, 'elapsed_ms': int((time.time()-t0)*1000),
            'size': 0, 'ok': False, 'detail': f'{type(e).__name__}: {e}',
        }


def main():
    print(f'=== Testing {BASE} ===\n')
    print(f'{"Endpoint":<28} {"HTTP":>5} {"Time":>8} {"Size":>10} {"Status":<5} {"Detail"}')
    print(f'{"-"*28} {"-"*5} {"-"*8} {"-"*10} {"-"*5} {"-"*40}')

    results = []
    total_start = time.time()
    for t in TESTS:
        r = run_test(t)
        results.append(r)
        status_icon = 'OK' if r['ok'] else 'FAIL'
        size_str = f'{r["size"]//1024}K' if r['size'] >= 1024 else f'{r["size"]}B'
        print(f'{r["name"]:<28} {r["status"]:>5} {r["elapsed_ms"]:>6}ms {size_str:>10} {status_icon:<5} {r["detail"][:60]}')
    total_ms = int((time.time() - total_start) * 1000)

    print()
    ok_count = sum(1 for r in results if r['ok'])
    avg_ms = sum(r['elapsed_ms'] for r in results) / len(results)
    print(f'Summary: {ok_count}/{len(results)} passed, avg {avg_ms:.0f}ms, total {total_ms}ms')

    # Slowest endpoints
    slowest = sorted(results, key=lambda r: -r['elapsed_ms'])[:3]
    print(f'\nSlowest:')
    for r in slowest:
        print(f'  {r["elapsed_ms"]:>5}ms  {r["name"]}')


if __name__ == '__main__':
    main()
