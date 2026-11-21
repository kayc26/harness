// Fixed-rule triage (ADR-0006). These are the must-catch and must-not-alarm sets the
// ADR calls for, written as the kinds of messages an older adult might actually type
// or dictate: plain phrasing, typos, speech-to-text slips, reports about a spouse.
// A miss here means an urgent message reaches an answer without the help it needs.

import { describe, expect, it } from 'vitest'
import { parseGlucose, triageRules, TIER_RANK, type Profile, type Tier } from './triage'

const NONE: Profile = { history_of_dka: false, pregnant: false, uses_pump: false }
const tierOf = (msg: string, p: Profile = NONE) => triageRules(msg, p).tier
const atLeast = (msg: string, min: Tier, p: Profile = NONE) =>
  expect(TIER_RANK[tierOf(msg, p)], `"${msg}" -> ${tierOf(msg, p)}`).toBeGreaterThanOrEqual(TIER_RANK[min])

describe('reading glucose numbers out of messages', () => {
  it.each([
    ['my sugar is 380', 380],
    ['My blood sugar was 45 this morning', 45],
    ['380 on my meter', 380],
    ["I'm at 62", 62],
    ['glucose 7.8 mmol', 140],
    ['the meter says HI', 600],
    ['my reading is 112 mg/dl', 112],
  ])('%s -> %i', (msg, v) => expect(parseGlucose(msg)).toBe(v))

  it.each([
    'I took 12 units last night',
    'a snack with 15 grams of carbs',
    "I'm 74 years old",
    'I eat at 6 pm',
    'walk for 30 minutes',
  ])('does not mistake other numbers for glucose: %s', (msg) => expect(parseGlucose(msg)).toBeNull())
})

describe('must catch: emergency (911 first)', () => {
  it.each([
    "my husband won't wake up and his sugar was low",
    "I'm shaky and confused and can't find my words",
    'sugar is 45 and I cant swallow the juice',
    "I've been vomiting all day and my sugar is 400",
    'my sugar is high and my stomach hurts and Im breathing fast',
    'chest pain and sweating',
    'I want to end my life',
    'I feel suicidal',
    'she had a seizure',
    'he is convulsing',
  ])('%s', (msg) => expect(tierOf(msg)).toBe('emergency'))
})

describe('must catch: urgent (the clinic red flags)', () => {
  it.each([
    ['my sugar is 380', NONE],
    ['my meter says HI', NONE],
    ['I have moderate ketones', NONE],
    ['my sugar is 290', { ...NONE, history_of_dka: true }], // high + DKA history (profile flag)
    ['I was at 48 an hour ago', NONE], // severe low (< 54)
    ['my wife had to give me juice when I went low last night', NONE], // needed help
    ['this is the third low since yesterday', NONE],
    ['I keep going low', NONE],
    ['my pump alarm keeps going off, it says occlusion', { ...NONE, uses_pump: true }],
    ['the site came out of my pump', NONE],
    ["I'm pregnant and my sugar is 210", NONE],
    ['my sugar is 210', { ...NONE, pregnant: true }], // pregnant profile + glucose concern
  ] as const)('%s', (msg, profile) => atLeast(msg, 'urgent', profile))
})

describe('must catch: check-in at least (help shown inline)', () => {
  it.each([
    'my sugar is 300', // 250–350
    "I'm at 62", // single low 54–69
    'I feel shaky and sweaty', // low symptoms, no number
    'feeling hippo', // speech-to-text slip for "hypo"
    'I am so thirsty and peeing a lot',
  ])('%s', (msg) => atLeast(msg, 'checkin'))

  it('flags emotional distress', () => {
    expect(tierOf("I'm overwhelmed and can't cope with all this")).toBe('distress')
  })
})

describe('must not alarm: ordinary education questions', () => {
  it.each([
    'What fruit can I eat?',
    'How do I plan a diabetes plate?',
    'Are sugar substitutes safe?',
    'What is a healthy snack before bed?',
    'How many carbs should I eat at a meal?',
    'Is it ok to drink coffee?',
  ])('%s', (msg) => expect(tierOf(msg)).toBe('none'))
})

describe('dose questions go to the fixed refusal card (ADR-0005)', () => {
  it.each([
    'How many units of insulin should I take for dinner?',
    'should I take more insulin since my sugar is 300',
    'Can I skip my basal tonight?',
    'should I increase my Lantus',
    'what dose of insulin do I need',
    'how much to inject for 60 grams of carbs',
    'do I need a correction dose',
  ])('%s', (msg) => expect(triageRules(msg, NONE).doseIntent).toBe(true))

  it.each([
    'When do I take my insulin with meals?', // timing, answered from the FAQ
    'What is insulin?',
    'What fruit can I eat?',
  ])('does not treat as a dose question: %s', (msg) => expect(triageRules(msg, NONE).doseIntent).toBe(false))

  it('still escalates a dose question that also reports a red flag', () => {
    const r = triageRules('my sugar is 400, how many units should I take?', NONE)
    expect(r.doseIntent).toBe(true)
    expect(r.tier).toBe('urgent')
  })
})

describe('Regression tests', () => {
  it('a pump that will not turn on is a pump failure (Taylor Lee, 2026-11-18; ADR-0023)', () => {
    // Bug: Taylor typed "My insulin pump won't turn on." in the clinician session.
    // PUMP_FAILURE listed "stopped", "not working", "broke" and alarms, but not "won't
    // turn on", so the fixed rules returned "none" and the nurse line depended on the
    // classifier happening to call it urgent. A pump user with a dead pump has no
    // insulin going in, which is the red flag ADR-0006 lists.
    for (const msg of ["My insulin pump won't turn on.", 'my pump is dead', 'my pump died last night', 'the pump screen is cracked']) {
      expect(tierOf(msg, { ...NONE, uses_pump: true }), msg).toBe('urgent')
    }
  })
})
