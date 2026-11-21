// Which messages go back to the portal menu (ADR-0023). Two sets, like triage's:
// messages that ask for a portal task and must get the card, and health questions that
// only mention a visit, a medicine, a pump or a bill and must still be answered. A false
// hit is the costlier mistake here: it replaces a real answer with "use the menu".

import { describe, expect, it } from 'vitest'
import { adminLane, adminRules, type AdminLane } from './admin'

describe('must point to the portal menu', () => {
  it.each([
    // ADR-0023's table: the five live phrasings that got four different answers
    ['I need a refill of my insulin.', 'refill'],
    ['i need a refill of my insulin', 'refill'],
    ['i need an insulin refill', 'refill'],
    ['I need to refill my meds', 'refill'], // DHF 6.3 (f), 2026-11-10
    ['can you refil my metformin', 'refill'], // typo (Katie McGovern, 11/18: test spelling mistakes)
    ["I'm almost out of insulin", 'refill'],
    ['I ran out of my pills', 'refill'],
    ['I need to renew my prescription', 'refill'],
    ['I need an appointment', 'appointment'],
    ['can I make an apointment with my endocrinologist', 'appointment'],
    ['I need to reschedule my visit', 'appointment'],
    ['how do I cancel my appt on friday', 'appointment'],
    ['when is my next appointment?', 'appointment'],
    ['I got a bill I do not understand', 'billing'],
    ['why was I billed twice', 'billing'],
    ['how much is my copay', 'billing'],
    ['my insurance claim was denied', 'billing'],
    ["My insulin pump won't turn on.", 'pump'], // Taylor Lee, 11/18
    ['my pump stopped working', 'pump'],
    ['my pump screen is blank', 'pump'],
    ['I think I need a replacement pump', 'pump'],
  ] as [string, AdminLane][])('%s -> %s', (msg, lane) => expect(adminRules(msg)).toBe(lane))
})

describe('must not deflect: health questions that only mention the subject', () => {
  it.each([
    "How do I prepare for my doctor's appointment?", // kb/routing-questions.txt
    'What should I eat before my appointment?',
    'How do insulin pumps work?', // kb/routing-questions.txt
    "I'm getting a new pump, how do I count carbs with it?",
    'How do I refill my pump reservoir?', // the patient does this; it is not a prescription
    'I have to visit the bathroom all night', // a symptom, not a visit to book
    'Can I change my insulin schedule?', // a dose question: the refusal handles it
    'What is a healthy snack?',
    'my husband bill is shaky and sweaty', // "bill" as a name, a low
    'Does metformin cause stomach upset?',
  ])('%s', (msg) => expect(adminRules(msg)).toBeNull())
})

describe('rules decide, the classifier only widens (QST-ADMIN-GATE: C)', () => {
  it('the classifier can raise a phrasing the rules missed', () => {
    expect(adminLane('can someone send more lantus to my pharmacy', 'refill')).toEqual({ lane: 'refill', via: 'classifier' })
  })

  it('the classifier cannot clear or change a rules hit', () => {
    expect(adminLane('I need a refill of my insulin', null)).toEqual({ lane: 'refill', via: 'rules' })
    expect(adminLane('I need a refill of my insulin', 'billing')).toEqual({ lane: 'refill', via: 'rules' })
  })
})
