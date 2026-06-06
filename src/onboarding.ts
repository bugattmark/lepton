// Per-tenant onboarding state. The /start-onboarding wizard + checklist write here;
// /dashboard (built separately) reads getOnboarding() to know if onboarding is complete.
import { db } from './db.ts'
import type { OnboardingRow } from './db.ts'

// The onboarding-step checklist, in order. A step unlocks only when all before it are done.
export const STEP_KEYS = ['link', 'pitch', 'followup', 'first_send', 'ten_pitches'] as const
export type StepKey = (typeof STEP_KEYS)[number]
export const PITCH_GOAL = 10

export interface IntakeProfile {
  name: string
  roles: string[]
  pitchTo: string
  journey: string
  heardFrom: string
  brandCategories: string[]
}

function ensureRow(tenantId: string): OnboardingRow {
  let row = db.prepare('SELECT * FROM onboarding WHERE tenant_id = ?').get(tenantId) as OnboardingRow | undefined
  if (!row) {
    db.prepare('INSERT INTO onboarding (tenant_id, updated_at) VALUES (?, ?)').run(tenantId, Date.now())
    row = db.prepare('SELECT * FROM onboarding WHERE tenant_id = ?').get(tenantId) as OnboardingRow
  }
  return row
}

export function getOnboarding(tenantId: string): OnboardingRow | undefined {
  return db.prepare('SELECT * FROM onboarding WHERE tenant_id = ?').get(tenantId) as OnboardingRow | undefined
}

export function isComplete(tenantId: string): boolean {
  return !!getOnboarding(tenantId)?.completed_at
}

export function hasIntake(tenantId: string): boolean {
  return !!getOnboarding(tenantId)?.intake_done_at
}

// Step 1 + Step 2 of the intake wizard.
export function saveIntake(tenantId: string, p: IntakeProfile): void {
  ensureRow(tenantId)
  db.prepare(
    `UPDATE onboarding SET name=?, roles=?, pitch_to=?, journey=?, heard_from=?, brand_categories=?,
       intake_done_at=COALESCE(intake_done_at, ?), updated_at=? WHERE tenant_id=?`,
  ).run(
    p.name.trim() || null,
    JSON.stringify(p.roles ?? []),
    p.pitchTo.trim() || null,
    p.journey || null,
    p.heardFrom || null,
    JSON.stringify(p.brandCategories ?? []),
    Date.now(),
    Date.now(),
    tenantId,
  )
}

export function stepsDone(tenantId: string): StepKey[] {
  const row = getOnboarding(tenantId)
  if (!row) return []
  try {
    return JSON.parse(row.steps_done) as StepKey[]
  } catch {
    return []
  }
}

function markStep(tenantId: string, key: StepKey): void {
  const done = new Set(stepsDone(tenantId))
  done.add(key)
  db.prepare('UPDATE onboarding SET steps_done=?, updated_at=? WHERE tenant_id=?').run(
    JSON.stringify([...done]),
    Date.now(),
    tenantId,
  )
  maybeComplete(tenantId)
}

export function setLink(tenantId: string, link: string): void {
  ensureRow(tenantId)
  db.prepare('UPDATE onboarding SET link=?, updated_at=? WHERE tenant_id=?').run(link.trim(), Date.now(), tenantId)
  if (link.trim()) markStep(tenantId, 'link')
}

export function setPitchTemplate(tenantId: string, body: string): void {
  ensureRow(tenantId)
  db.prepare('UPDATE onboarding SET pitch_template=?, updated_at=? WHERE tenant_id=?').run(body, Date.now(), tenantId)
  if (body.trim()) markStep(tenantId, 'pitch')
}

export function setFollowupTemplate(tenantId: string, body: string): void {
  ensureRow(tenantId)
  db.prepare('UPDATE onboarding SET followup_template=?, updated_at=? WHERE tenant_id=?').run(body, Date.now(), tenantId)
  if (body.trim()) markStep(tenantId, 'followup')
}

export function markFirstSend(tenantId: string): void {
  ensureRow(tenantId)
  markStep(tenantId, 'first_send')
}

// Record progress toward the 10-pitch goal; completes the step (and onboarding) at the goal.
export function addPitchesSent(tenantId: string, n = 1): number {
  ensureRow(tenantId)
  db.prepare('UPDATE onboarding SET pitches_sent=pitches_sent+?, updated_at=? WHERE tenant_id=?').run(n, Date.now(), tenantId)
  const sent = getOnboarding(tenantId)?.pitches_sent ?? 0
  if (sent >= PITCH_GOAL) markStep(tenantId, 'ten_pitches')
  return sent
}

function maybeComplete(tenantId: string): void {
  const done = new Set(stepsDone(tenantId))
  if (STEP_KEYS.every((k) => done.has(k))) {
    db.prepare('UPDATE onboarding SET completed_at=COALESCE(completed_at, ?), updated_at=? WHERE tenant_id=?').run(
      Date.now(),
      Date.now(),
      tenantId,
    )
  }
}

// The shape the wizard/checklist client and the dashboard consume.
export function snapshot(tenantId: string) {
  const row = getOnboarding(tenantId)
  const done = stepsDone(tenantId)
  return {
    intakeDone: !!row?.intake_done_at,
    completed: !!row?.completed_at,
    profile: row
      ? {
          name: row.name ?? '',
          roles: safeArr(row.roles),
          pitchTo: row.pitch_to ?? '',
          journey: row.journey ?? '',
          heardFrom: row.heard_from ?? '',
          brandCategories: safeArr(row.brand_categories),
        }
      : null,
    link: row?.link ?? '',
    pitchTemplate: row?.pitch_template ?? '',
    followupTemplate: row?.followup_template ?? '',
    stepsDone: done,
    pitchesSent: row?.pitches_sent ?? 0,
    pitchGoal: PITCH_GOAL,
  }
}

function safeArr(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
