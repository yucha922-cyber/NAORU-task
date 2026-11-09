import { describe, expect, it } from 'vitest'
import { occursOn, pendingOccurrences } from './recurrence'
import { dueState, endOfWeek } from './dates'
import type { TaskTemplate } from './types'

const base: TaskTemplate = {
  id: 't', store_id: 's', title: 'x', description: '', assignee_id: null, priority: 'medium', category: 'general',
  frequency: 'daily', interval_days: null, weekdays: [], day_of_month: null, due_time: null,
  start_date: '2026-11-01', end_date: null, last_generated_date: null, active: true, assignment_mode: 'single', color_id: null, assignee_ids: [],
}

describe('recurrence', () => {
  it('daily', () => {
    expect(pendingOccurrences(base, '2026-11-03', '2026-11-04')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])
  })
  it('does not regenerate already generated dates', () => {
    expect(pendingOccurrences({ ...base, last_generated_date: '2026-11-04' }, '2026-11-03', '2026-11-04')).toEqual([])
  })
  it('caps catch-up to 7 days', () => {
    const r = pendingOccurrences({ ...base, start_date: '2026-01-01' }, '2026-11-20', '2026-11-20')
    expect(r[0]).toBe('2026-11-13')
    expect(r.length).toBe(8)
  })
  it('every 3 days anchored to start', () => {
    const t = { ...base, frequency: 'interval' as const, interval_days: 3 }
    expect(pendingOccurrences(t, '2026-11-08', '2026-11-08')).toEqual(['2026-11-01', '2026-11-04', '2026-11-07'])
  })
  it('weekly on Monday', () => {
    expect(occursOn({ ...base, frequency: 'weekly', weekdays: [1] }, '2026-11-02')).toBe(true)
    expect(occursOn({ ...base, frequency: 'weekly', weekdays: [1] }, '2026-11-03')).toBe(false)
  })
  it('monthly clamps to month end', () => {
    const t = { ...base, start_date: '2026-01-01', frequency: 'monthly' as const, day_of_month: 31 }
    expect(occursOn(t, '2026-02-28')).toBe(true)
    expect(occursOn(t, '2026-03-30')).toBe(false)
    expect(occursOn(t, '2026-03-31')).toBe(true)
  })
  it('inactive / end_date', () => {
    expect(pendingOccurrences({ ...base, active: false }, '2026-11-03', '2026-11-03')).toEqual([])
    expect(occursOn({ ...base, end_date: '2026-11-02' }, '2026-11-03')).toBe(false)
  })
})

describe('dates', () => {
  it('dueState colors', () => {
    expect(dueState({ status: 'open', due_date: '2026-11-04' }, '2026-11-05')).toBe('overdue')
    expect(dueState({ status: 'open', due_date: '2026-11-06' }, '2026-11-05')).toBe('soon')
    expect(dueState({ status: 'open', due_date: '2026-11-09' }, '2026-11-05')).toBe('normal')
    expect(dueState({ status: 'done', due_date: '2026-11-01' }, '2026-11-05')).toBe('done')
  })
  it('endOfWeek (Mon start)', () => {
    expect(endOfWeek('2026-11-05')).toBe('2026-11-08')
    expect(endOfWeek('2026-11-08')).toBe('2026-11-08')
  })
})
