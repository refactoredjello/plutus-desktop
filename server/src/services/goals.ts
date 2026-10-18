/**
 * Savings goals and their progress (R8).
 *
 * Divisions to cents round half to even once, on the exact quotient. The divisors are 3 and a
 * month count.
 */

import { asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { goals } from '../db/schema.js'
import { type MonthKey, type PlainDate, addDays, fromParts, toParts } from '../lib/dates.js'
import { DomainError, NotFoundError } from '../lib/errors.js'
import { type Cents, ZERO, cents, divHalfEven } from '../lib/money.js'
import { currentTotalBalance, monthRange, monthlyTotals } from './aggregates.js'
import { today } from './schedule.js'

export type Goal = typeof goals.$inferSelect

export const COMPLETE_MONTHS_FOR_AVERAGE = 3

/** GoalProgress, in cents; the route formats it. */
export interface GoalProgress {
  saved_so_far: Cents
  remaining: Cents
  months_left: number
  required_monthly: Cents
  actual_monthly_average: Cents
  on_track: boolean
}

/** GoalRead, in cents. */
export interface GoalView {
  id: number
  name: string
  target_amount: Cents
  target_date: PlainDate
  starting_amount: Cents
  is_active: boolean
  progress: GoalProgress
}

/** GoalCreate after parsing. */
export interface GoalCreate {
  name: string
  target_amount: Cents
  target_date: PlainDate | string
}

/**
 * `body.model_dump(exclude_unset=True)`: a key that is absent was not sent; a key that is null
 * was sent as null.
 */
export interface GoalChanges {
  name?: string | null
  target_amount?: Cents | null
  target_date?: PlainDate | string | null
  is_active?: boolean | null
}

/** The `count` calendar months before the current one, oldest first. */
export function previousCompleteMonths(count: number): MonthKey[] {
  const { year, month } = toParts(today())
  const lastComplete = addDays(fromParts(year, month, 1), -1)
  return monthRange(lastComplete, count)
}

/** Whole calendar months from start to end; 0 if end is not after start. */
export function monthsBetween(start: PlainDate, end: PlainDate): number {
  if (end <= start) return 0
  const s = toParts(start)
  const e = toParts(end)
  let months = (e.year - s.year) * 12 + (e.month - s.month)
  if (e.day < s.day) months -= 1
  return Math.max(months, 0)
}

export function computeProgress(db: Db, goal: Goal): GoalProgress {
  const saved = cents(currentTotalBalance(db) - goal.starting_amount)
  const remaining = cents(Math.max(goal.target_amount - saved, ZERO))
  const monthsLeft = monthsBetween(today(), goal.target_date)
  const required = divHalfEven(remaining, Math.max(monthsLeft, 1))
  const nets = monthlyTotals(db, previousCompleteMonths(COMPLETE_MONTHS_FOR_AVERAGE)).map((m) => m.net)
  const actual = divHalfEven(cents(nets.reduce((a, b) => a + b, 0)), nets.length)
  return {
    saved_so_far: saved,
    remaining,
    months_left: monthsLeft,
    required_monthly: required,
    actual_monthly_average: actual,
    on_track: actual >= required,
  }
}

export function toRead(db: Db, goal: Goal): GoalView {
  return {
    id: goal.id,
    name: goal.name,
    target_amount: goal.target_amount,
    target_date: goal.target_date,
    starting_amount: goal.starting_amount,
    is_active: goal.is_active,
    progress: computeProgress(db, goal),
  }
}

export function getGoal(db: Db, goalId: number): Goal {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get()
  if (goal === undefined) throw new NotFoundError(`Goal ${goalId} not found`)
  return goal
}

export function listGoals(db: Db): Goal[] {
  return db.select().from(goals).orderBy(desc(goals.is_active), asc(goals.target_date), asc(goals.id)).all()
}

export function createGoal(db: Db, body: GoalCreate): Goal {
  if (body.target_date <= today()) throw new DomainError('target_date must be in the future')
  return db
    .insert(goals)
    .values({
      name: body.name,
      target_amount: body.target_amount,
      target_date: body.target_date as PlainDate,
      starting_amount: currentTotalBalance(db),
    })
    .returning()
    .get()
}

const REQUIRED = ['name', 'target_amount', 'target_date', 'is_active'] as const

export function updateGoal(db: Db, goalId: number, changes: GoalChanges): Goal {
  const goal = getGoal(db, goalId)
  for (const name of REQUIRED) {
    if (name in changes && changes[name] === null) throw new DomainError(`${name} cannot be null`)
  }
  const newDate = changes.target_date
  if (newDate != null && newDate !== goal.target_date && newDate <= today()) {
    throw new DomainError('target_date must be in the future')
  }
  const patch = changes as Partial<typeof goals.$inferInsert>
  if (Object.keys(patch).length === 0) return goal
  return db.update(goals).set(patch).where(eq(goals.id, goalId)).returning().get()
}
