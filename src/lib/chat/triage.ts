// Fixed-rule triage: runs on every patient message, before any model call, locally
// and instantly (ADR-0006). It cannot fail at runtime, so it is the floor: the model
// classifier can raise its result, and can soften it by one step for questions
// *about* symptoms, but never clear it (see combine.ts).
//
// Tiers (ADR-0006, iterations 1, 5, and 6):
//   emergency  danger now: can't be woken, seizure, a low the person can't treat,
//              DKA signs, chest pain, self-harm. Shows 911 first.
//   urgent     the clinic's RED FLAGS: glucose > 350; high with ketones or a DKA
//              history; severe low (< 54 or needing help) or > 2 lows in 48 h; pump
//              failure; out of insulin now (ADR-0023); pregnancy (with a glucose concern).
//              Shows the nurse line, same day.
//   distress   emotional distress. Shows the nurse line, and 911 if in danger.
//   checkin    250–350, or a single low of 54–69, or low/high symptoms without a
//              number. Help buttons appear inline with the approved card.
//   none
// False negatives cost far more than false positives, so patterns lean broad.

export type Tier = 'none' | 'checkin' | 'distress' | 'urgent' | 'emergency'
export const TIER_RANK: Record<Tier, number> = { none: 0, checkin: 1, distress: 2, urgent: 3, emergency: 4 }
export const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b)

export interface Profile {
  history_of_dka: boolean
  pregnant: boolean
  uses_pump: boolean
}

export interface TriageResult {
  tier: Tier
  criteria: string[] // machine-readable reasons, logged to triage_events
  glucose: number | null // mg/dL, if the message reported one
  doseIntent: boolean // asks how much insulin to take or whether to change a dose
}

const has = (re: RegExp, s: string) => re.test(s)

/** A reported glucose value in mg/dL, or null. Meter "HI" / "LO" map to the meter's limits. */
export function parseGlucose(text: string): number | null {
  const t = text.toLowerCase()
  if (/\b(meter|monitor|reading|cgm|sugar|glucose)\b[^.]{0,30}\bsays?\s+["“]?hi\b/.test(t) || /\breads?\s+["“]?hi\b/.test(t)) return 600
  if (/\b(meter|monitor|reading|cgm|sugar|glucose)\b[^.]{0,30}\bsays?\s+["“]?lo\b/.test(t) || /\breads?\s+["“]?lo\b/.test(t)) return 39
  const mmol = t.match(/\b(\d{1,2}(?:\.\d)?)\s*mmol/)
  if (mmol) return Math.round(Number(mmol[1]) * 18)
  const unit = t.match(/\b(\d{2,3})\s*mg\s*\/?\s*d[li]/)
  if (unit) return Number(unit[1])
  // A number near a glucose word, in either order ("my sugar is 380", "380 on my meter").
  const near =
    t.match(/\b(?:sugar|glucose|reading|readings|bg|level|meter|cgm|monitor|number)\b[^0-9.?!]{0,25}?\b(\d{2,3})\b/) ??
    t.match(/\b(\d{2,3})\b[^0-9.?!]{0,20}?\b(?:on (?:my|the) (?:meter|monitor|cgm)|sugar|glucose|reading)\b/) ??
    t.match(/\b(?:i'?m|i am|it'?s|it is|at|down to|up to|was)\s+(?:only\s+|just\s+|about\s+|around\s+)?(\d{2,3})\b(?!\s*(?:units?|grams?|g\b|minutes?|mins?|hours?|years?|lbs?|pounds?|kg|%|am\b|pm\b|o'?clock))/)
  if (!near) return null
  const v = Number(near[1])
  return v >= 20 && v <= 700 ? v : null
}

// Danger happening now.
const EMERGENCY_NOW =
  /\b(won'?t wake|can'?t wake|cannot wake|not waking|unresponsive|unconscious|passed out|passing out|fainted|blacked out|seizures?|having a fit|convuls\w*|chest pain|can'?t breathe|cannot breathe|trouble breathing|hard to breathe|struggling to breathe|breathing (?:fast|hard|heavy|deep)|fruity breath|can'?t swallow|cannot swallow|too confused to)\b/
// Word stems ("suicid", "vomit", "convuls") are followed by \w* so "suicidal",
// "vomiting", "convulsing" match: a stem followed directly by \b missed "vomiting"
// in the must-catch set.
const SELF_HARM = /\b(kill myself|suicid\w*|end my life|want to die|don'?t want to (?:live|be here)|hurt myself|no reason to live)\b/
const CANT_TREAT = /\b(can'?t|cannot|couldn'?t|unable to)\b[^.]{0,30}\b(eat|drink|swallow|treat|get sugar|get up|stand)\b|\bno sugar (?:in the house|left|on me)\b/
const VOMITING = /\b(vomit\w*|throwing up|threw up|being sick|can'?t keep (?:anything|food|water|fluids) down)\b/
const DKA_SIGNS = /\b(stomach (?:pain|ache|hurts)|belly pain|abdominal pain|fruity breath|breathing (?:fast|hard|deep))\b/
const CONFUSED = /\b(confus|disoriented|can'?t think|can'?t find my words|not making sense|slurr)\w*/
const KETONES = /\b(ketones?|ketoacidosis|dka)\b/
const KETONES_POSITIVE = /\b(positive|moderate|large|high|trace|small|\d+(?:\.\d)?\s*mmol)\b[^.]{0,20}\bketones?\b|\bketones?\b[^.]{0,20}\b(positive|moderate|large|high|are up|came back)\b/
const LOW_SYMPTOMS = /\b(shaky|shaking|trembl|sweaty|sweating|clammy|dizzy|light-?headed|heart (?:is )?(?:racing|pounding)|feel(?:ing)? (?:low|funny|weird|off)|going low|i'?m low|hypo|hippo)\w*/
const HIGH_SYMPTOMS = /\b(very thirsty|so thirsty|peeing (?:a lot|constantly)|urinating a lot|blurry vision|i'?m high|running high|sugar is high|really high)\b/
const REPEATED_LOWS =
  /\b(third|3rd|fourth|another|again)\b[^.]{0,20}\blow\b|\blow\b[^.]{0,30}\b(three|four|several|multiple|3|4|many) times\b|\b(keep|kept|keeps) (going|getting|dropping) low\b|\b(several|multiple|three|3) lows\b/
const NEEDED_HELP = /\b(had to|needed (?:my )?\w* to|somebody|someone|my (?:wife|husband|daughter|son|neighbou?r)|paramedics?|ambulance)\b[^.]{0,40}\b(help|give me|gave me|glucagon|juice|sugar|called)\b|\bglucagon\b/
const PUMP_FAILURE =
  /\bpump\b[^.]{0,40}\b(alarm|occlu|stopped|not working|isn'?t working|won'?t (?:turn on|start|work|power on)|not turning on|dead|died|cracked|broke|failed|failure|error|came out|fell out|kinked|blocked|no insulin|empty|battery)\w*|\b(site|cannula|tubing)\b[^.]{0,20}\b(came out|fell out|kinked|blocked|leak)\w*/
const PREGNANT = /\b(pregnan\w*|expecting a baby|having a baby|weeks along)\b/
const DISTRESS = /\b(can'?t cope|cannot cope|overwhelmed|hopeless|so scared|really scared|terrified|panick\w*|can'?t take (?:it|this) anymore|falling apart)\b/
// Insulin words, including common US brand names: "should I increase my Lantus" was
// missed when only generic words were listed.
const INSULIN =
  '(?:insulins?|units?|dose|doses|dosage|shots?|injections?|basal|bolus|pens?|lantus|basaglar|toujeo|semglee|levemir|tresiba|humalog|admelog|lyumjev|novolog|fiasp|apidra|humulin|novolin|glargine|degludec|detemir|aspart|lispro|glulisine)'
const DOSE_INTENT = new RegExp(
  [
    `\\bhow (?:much|many)\\b[^.?]{0,25}\\b${INSULIN}\\b`,
    `\\bshould i\\b[^.?]{0,25}\\b(?:take|give|inject|skip|increase|decrease|lower|raise|change|double|cut|stop)\\b[^.?]{0,25}\\b${INSULIN}\\b`,
    `\\b(?:increase|decrease|adjust|change|double|skip|lower|raise|up|cut|stop)\\b[^.?]{0,15}\\b(?:my )?${INSULIN}\\b`,
    `\\bcorrection (?:dose|bolus|insulin)\\b`,
    `\\bwhat dose\\b`,
    `\\bhow much to (?:take|inject|give)\\b`,
  ].join('|'),
)

// Out of insulin NOW (ADR-0023, QST-ADMIN-OUT-OF-INSULIN: B, Kay 2026-11-21): no insulin
// going in, like a dead pump. "Almost out" and "running out" are not here: there is
// still time, and the refill card (admin.ts) answers those.
const OUT_OF_INSULIN = new RegExp(
  `\\b(?:ran|have run|'?ve run|i'?m|i am|completely|totally|all) out of (?:my )?${INSULIN}\\b|\\bno (?:more )?${INSULIN} left\\b|\\b(?:have|got) no (?:more )?${INSULIN}\\b`,
)

export function triageRules(message: string, profile: Profile): TriageResult {
  const t = message.toLowerCase().replace(/[’`]/g, "'")
  const criteria: string[] = []
  let tier: Tier = 'none'
  const raise = (to: Tier, why: string) => {
    tier = maxTier(tier, to)
    criteria.push(why)
  }
  const glucose = parseGlucose(t)
  const low = glucose !== null && glucose < 70
  const high = glucose !== null && glucose > 250
  const glucoseConcern = (glucose !== null && (glucose < 70 || glucose > 180)) || has(LOW_SYMPTOMS, t) || has(HIGH_SYMPTOMS, t)

  // Emergency: danger now.
  if (has(SELF_HARM, t)) raise('emergency', 'self_harm')
  if (has(EMERGENCY_NOW, t)) raise('emergency', 'danger_now')
  if ((low || has(LOW_SYMPTOMS, t)) && (has(CANT_TREAT, t) || has(CONFUSED, t))) raise('emergency', 'low_cannot_treat')
  if ((high || has(KETONES, t)) && (has(VOMITING, t) || has(DKA_SIGNS, t) || has(CONFUSED, t))) raise('emergency', 'dka_signs')

  // Urgent: the clinic's red flags.
  if (glucose !== null && glucose > 350) raise('urgent', 'glucose_over_350')
  if (has(KETONES_POSITIVE, t) || (has(KETONES, t) && high)) raise('urgent', 'ketones')
  if (profile.history_of_dka && high) raise('urgent', 'high_with_dka_history')
  if (glucose !== null && glucose < 54) raise('urgent', 'severe_low')
  if (has(NEEDED_HELP, t) && (low || has(LOW_SYMPTOMS, t) || /\blow\b/.test(t))) raise('urgent', 'severe_low_needed_help')
  if (has(REPEATED_LOWS, t)) raise('urgent', 'repeated_lows')
  if (has(PUMP_FAILURE, t)) raise('urgent', profile.uses_pump ? 'pump_failure_pump_user' : 'pump_failure')
  if (has(OUT_OF_INSULIN, t)) raise('urgent', 'out_of_insulin')
  if (has(PREGNANT, t) && glucoseConcern) raise('urgent', 'pregnancy_glucose_concern')
  if (profile.pregnant && glucoseConcern) raise('urgent', 'pregnant_profile_glucose_concern')

  // Distress.
  if (has(DISTRESS, t)) raise('distress', 'distress')

  // Check-in.
  if (glucose !== null && glucose > 250 && glucose <= 350) raise('checkin', 'glucose_250_350')
  if (glucose !== null && glucose >= 54 && glucose < 70) raise('checkin', 'single_low')
  if (glucose === null && has(LOW_SYMPTOMS, t)) raise('checkin', 'low_symptoms')
  if (glucose === null && has(HIGH_SYMPTOMS, t)) raise('checkin', 'high_symptoms')
  if (has(PREGNANT, t) && tier === 'none') raise('checkin', 'pregnancy_mentioned')

  return { tier, criteria, glucose, doseIntent: has(DOSE_INTENT, t) }
}
