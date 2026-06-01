// db.test.js — UTC-boundary correctness for live-tracks loading.
//
// Pins the contract that's failed three times before: a query whose
// lookback window crosses UTC midnight must not collapse to a single-
// day SELECT. The prior implementation did `ORDER BY id DESC LIMIT 1`,
// returning only the latest UTC day — so at 03:00 UTC, yesterday's
// 21 hours of traffic silently disappeared.
//
// The fix lives in db.js → resolveLiveDateRange, a pure function that
// takes (hoursBack, nowMs) and produces a (fromDate, toDate) range
// covering at least the requested lookback PLUS a +24 h safety pad.
// Testing it directly here means we never accept a date math fix
// without a regression net under it.
//
// Run:  cd noise/web && npx vitest run db.test.js

import { describe, it, expect } from 'vitest'
import { resolveLiveDateRange } from './db.js'

const t = (iso) => Date.parse(iso)

describe('resolveLiveDateRange', () => {
  it('mid-day query covers prior day via the +24 h pad', () => {
    // 15:00 UTC, well clear of midnight. hoursBack=4 + 24 h pad = 28 h back.
    const { fromDate, toDate } = resolveLiveDateRange(4, t('2026-06-01T15:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).toBe('2026-05-31')
  })

  it('00:01 UTC with hoursBack=12 spans both yesterday and today', () => {
    // 1 minute past UTC midnight — the failure window for the prior bug.
    // 12 h + 24 h pad = 36 h back from 00:01 UTC on Jun 1 → 12:01 UTC May 30.
    const { fromDate, toDate } = resolveLiveDateRange(12, t('2026-06-01T00:01:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).toBe('2026-05-30')
  })

  it('03:00 UTC with hoursBack=24 still covers yesterday cleanly', () => {
    // The original "kiosk shows 5 flights" hour.
    // 24 h + 24 h pad = 48 h back from 03:00 UTC on Jun 1 → 03:00 UTC on May 30.
    const { fromDate, toDate } = resolveLiveDateRange(24, t('2026-06-01T03:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).toBe('2026-05-30')
  })

  it('23:59 UTC with the default hoursBack=4 still pads the prior day', () => {
    // Last minute of the UTC day. 4 h + 24 h pad = 28 h back → 19:59 UTC May 30.
    const { fromDate, toDate } = resolveLiveDateRange(4, t('2026-05-31T23:59:00Z'))
    expect(toDate).toBe('2026-05-31')
    expect(fromDate).toBe('2026-05-30')
  })

  it('hoursBack=1 (airborne-only) still pads the prior day at midnight', () => {
    // An airborne flight in its 30th minute may have first appeared at
    // 23:35 UTC yesterday. 1 h + 24 h pad = 25 h back from 00:05 UTC Jun 1
    // = 23:05 UTC May 30 — well clear of the bug window.
    const { fromDate, toDate } = resolveLiveDateRange(1, t('2026-06-01T00:05:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).toBe('2026-05-30')
    // Critical guarantee: at any time of day, the range must cross
    // yesterday's UTC date.
    expect(fromDate).not.toBe(toDate)
  })

  it('hoursBack=0 still returns a multi-day range — the structurally-impossible bug case', () => {
    // The pre-fix code path: at midnight UTC with no lookback, the query
    // would have collapsed to today's-only row. The +24 h pad makes
    // fromDate === toDate IMPOSSIBLE regardless of clock.
    const { fromDate, toDate } = resolveLiveDateRange(0, t('2026-06-01T12:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).toBe('2026-05-31')
    expect(fromDate).not.toBe(toDate)
  })

  it('exactly at UTC midnight — the precise failure moment', () => {
    // 2026-06-01T00:00:00.000Z — the exact instant the bug used to fire.
    const { fromDate, toDate } = resolveLiveDateRange(6, t('2026-06-01T00:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    expect(fromDate).not.toBe(toDate)
    // 6 h + 24 h = 30 h back from 00:00 UTC Jun 1 → 18:00 UTC May 30.
    expect(fromDate).toBe('2026-05-30')
  })

  it('large hoursBack (48 h) returns a 3-day range', () => {
    const { fromDate, toDate } = resolveLiveDateRange(48, t('2026-06-01T12:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    // 48 h + 24 h pad = 72 h back from 12:00 UTC Jun 1 → 12:00 UTC May 29.
    expect(fromDate).toBe('2026-05-29')
  })

  it('toDate is always the current UTC date, never tomorrow', () => {
    // No matter the lookback, toDate is anchored to nowMs's UTC date.
    for (const hb of [0, 1, 4, 12, 24, 48]) {
      const { toDate } = resolveLiveDateRange(hb, t('2026-06-01T17:30:00Z'))
      expect(toDate).toBe('2026-06-01')
    }
  })

  it('crossing month boundary works (May 31 → June 1)', () => {
    const { fromDate, toDate } = resolveLiveDateRange(4, t('2026-06-01T01:00:00Z'))
    expect(toDate).toBe('2026-06-01')
    // 4 h + 24 h = 28 h back from 01:00 Jun 1 → 21:00 May 30.
    expect(fromDate).toBe('2026-05-30')
  })

  it('crossing year boundary works (Dec 31 → Jan 1)', () => {
    const { fromDate, toDate } = resolveLiveDateRange(12, t('2026-01-01T03:00:00Z'))
    expect(toDate).toBe('2026-01-01')
    // 12 h + 24 h = 36 h back → 15:00 Dec 30.
    expect(fromDate).toBe('2025-12-30')
  })
})
