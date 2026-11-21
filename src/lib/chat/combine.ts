// Merge fixed-rule triage with the model classifier (ADR-0006).
//   - OR-combined: the higher tier wins (QST-TRIAGE-LAYERS: B).
//   - The classifier may soften a *rules* hit by one step when the message is a
//     question about symptoms rather than a report of them, never to "none", and never
//     an emergency (QST-TRIAGE-ASKING-VS-HAVING: B).
//   - A failed, slow, or unreadable classifier counts as at least "check-in", never
//     as "none".

import { ADMIN_LANES, type AdminLane } from './admin'
import { validTopics, type Topic } from './topics'
import { maxTier, type Tier, type TriageResult } from './triage'

export interface ClassifierResult {
  tier: Tier
  happening_now: boolean
  dose_intent: boolean
  /** Asks what their own plan or schedule says (ADR-0020); fixed checks in plan.ts still veto. */
  plan_question: boolean
  /** A portal task the message asks for (ADR-0023); widens the fixed rules in admin.ts,
   *  never clears them. Null for anything else, or an unknown value. */
  admin: AdminLane | null
  reason: string
  /** Up to two knowledge-base topics for the answer (ADR-0018); empty when none fits. */
  topics: Topic[]
}

const TIERS: Tier[] = ['none', 'checkin', 'distress', 'urgent', 'emergency']

/** Parse the classifier's JSON reply; anything malformed is a failure (null). */
export function parseClassifier(text: string | null | undefined): ClassifierResult | null {
  if (!text) return null
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    if (!TIERS.includes(o.tier as Tier) || typeof o.happening_now !== 'boolean') return null
    return {
      tier: o.tier as Tier,
      happening_now: o.happening_now,
      dose_intent: o.dose_intent === true,
      plan_question: o.plan_question === true,
      admin: ADMIN_LANES.includes(o.admin as AdminLane) ? (o.admin as AdminLane) : null,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
      topics: validTopics(o.topics),
    }
  } catch {
    return null
  }
}

export interface CombinedTriage {
  tier: Tier
  criteria: string[]
  doseIntent: boolean
  softened: boolean
  classifierFailed: boolean
}

export function combineTriage(rules: TriageResult, cls: ClassifierResult | null): CombinedTriage {
  if (!cls) {
    return {
      tier: maxTier(rules.tier, 'checkin'),
      criteria: [...rules.criteria, 'classifier_unavailable'],
      doseIntent: rules.doseIntent,
      softened: false,
      classifierFailed: true,
    }
  }
  let fromRules = rules.tier
  let softened = false
  if (!cls.happening_now && rules.tier === 'urgent') {
    fromRules = 'checkin' // one step down, never to none; emergency/distress untouched
    softened = true
  }
  const tier = maxTier(fromRules, cls.tier)
  const criteria = [...rules.criteria]
  if (cls.tier !== 'none') criteria.push(`classifier_${cls.tier}`)
  if (softened) criteria.push('softened_informational')
  return { tier, criteria, doseIntent: rules.doseIntent || cls.dose_intent, softened, classifierFailed: false }
}
