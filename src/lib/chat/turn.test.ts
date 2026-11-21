// Turn orchestration with scripted model replies. These check *our* ordering
// guarantees, not model quality: an emergency never waits on a model, a dose
// question never reaches the answer model, a bad answer never reaches the patient,
// and a dose-flagged session waits for the monitor. Model calls are counted because
// each one costs money (ADR-0012).

import { describe, expect, it } from 'vitest'
import type { CompleteFn } from '../agent'
import type { ChatMessage } from '../types'
import { buildIndex, type KbPassage } from './retrieve'
import { planOnRequest, runTurn, type TurnModels } from './turn'
import { cardsToText } from './persist'
import { doseAdviceIn } from './guard'
import { buildCardIndex, CARD_FALLBACK_SCORE, CARD_MIN_SCORE, loadApprovedCards, parsePick, type CardIndex, type TopicCard } from './cards'
import { DataError, type DataClient } from '../neon/data'
import type { Profile } from './triage'
import type { Regimen } from '../patients/readback'
import robertFixture from '../../../patients/fixtures/demo-robert.json'
import dorothyFixture from '../../../patients/fixtures/demo-dorothy.json'

const NONE: Profile = { history_of_dka: false, pregnant: false, uses_pump: false }
const P = (id: string, section: string, body: string, tags: string[] = []): KbPassage => ({
  id, doc_title: 'Doc', source_label: 'ADA', section, body, tags,
})
const index = buildIndex([
  P('fruit', 'What fruit can I eat?', 'Berries, apples and pears tend to raise blood glucose less than melon or bananas. Keep fruit to one cup.'),
  P('hypo', 'Treating low blood glucose', 'To treat low blood glucose below 70 mg/dL, use the Rule of 15: eat 15 grams of fast-acting carbohydrate and recheck after 15 minutes.', ['urgent']),
  P('high', 'High blood sugar', 'If blood sugar stays very high, or you are vomiting or have ketones, seek medical attention.', ['urgent']),
  P('corr', 'Correction insulin', 'Follow your provider instructions for correction insulin if you have not taken insulin in the last 4 hours.', ['dose_related', 'medication']),
])

// A question that retrieves the dose-tagged 'corr' passage WITHOUT tripping the
// dose-question rules. Regression note (2026-11-16): the hidden-passage test used
// "what about correction insulin and fruit", but "correction insulin" is itself a
// dose-question pattern (triage.ts), so the refusal card ended the turn before any
// model call. The test asserted only that the passage was absent from an empty
// prompt, and passed without checking anything. Both tests below now also assert
// that the model was asked.
const PROVIDER_Q = 'What do my provider instructions say about insulin in the last few hours?'

const cls = (tier: string, happening_now = true, dose_intent = false) =>
  JSON.stringify({ tier, happening_now, dose_intent, reason: 'test' })

function models(o: { classify?: string | null | Error; answers?: string[]; monitor?: string | null; pick?: string | null | Error }) {
  const calls = { classify: 0, complete: 0, monitor: 0, pick: 0 }
  const answers = [...(o.answers ?? [])]
  const m: TurnModels = {
    async classify() {
      calls.classify++
      if (o.classify instanceof Error) throw o.classify
      return o.classify ?? cls('none', false)
    },
    complete: (async () => {
      calls.complete++
      const content = answers.shift() ?? 'I do not have information on that. [kb:fruit]'
      return { message: { role: 'assistant', content } as ChatMessage }
    }) as CompleteFn,
    async monitor() {
      calls.monitor++
      return o.monitor === undefined ? JSON.stringify({ veto: false, raise_tier: 'none', reason: 'ok' }) : o.monitor
    },
    async pick() {
      calls.pick++
      if (o.pick instanceof Error) throw o.pick
      return o.pick === undefined ? 'none' : o.pick
    },
  }
  return { m, calls }
}
// The monitor is on here unless a test says otherwise, as in the live app since
// 2026-11-17 (MONITOR_PAUSED = false, ADR-0007 QST-MONITOR-UNPAUSE: A).
const turn = (message: string, m: TurnModels, extra: { doseSession?: boolean; profile?: Profile; monitorEnabled?: boolean } = {}) =>
  runTurn({
    message, history: [], profile: extra.profile ?? NONE, index, doseSession: extra.doseSession ?? false, models: m, timeoutMs: 50,
    monitorEnabled: extra.monitorEnabled ?? true,
  })

describe('turn orchestration', () => {
  it('emergency: 911 card first and the approved passage, with no model call at all', async () => {
    const { m, calls } = models({})
    const o = await turn("my husband won't wake up and his sugar was low", m)
    expect(o.tier).toBe('emergency')
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'emergency' })
    expect(o.cards[1]).toMatchObject({ kind: 'passage', why: 'urgent', passage: { id: 'hypo' } })
    expect(calls).toEqual({ classify: 0, complete: 0, monitor: 0, pick: 0 })
  })

  it('a dose question gets the fixed refusal card; the answer model is never called', async () => {
    const { m, calls } = models({ classify: cls('none', true, true) })
    const o = await turn('How many units of insulin should I take for dinner?', m)
    expect(o.cards.map((c) => c.kind)).toEqual(['dose_refusal'])
    expect(calls.complete).toBe(0)
  })

  it('an ordinary question: classifier, then a cited, guarded answer; monitor reviews in the background', async () => {
    const { m, calls } = models({ answers: ['Berries and apples raise glucose less than bananas. Keep fruit to one cup. [kb:fruit]'] })
    const o = await turn('What fruit can I eat?', m)
    expect(o.tier).toBe('none')
    expect(o.cards).toHaveLength(1)
    expect(o.cards[0]).toMatchObject({ kind: 'answer', text: 'Berries and apples raise glucose less than bananas. Keep fruit to one cup.' })
    expect(o.monitor).toBe('background')
    expect(await o.background).toMatchObject({ veto: false })
    expect(calls).toEqual({ classify: 1, complete: 1, monitor: 1, pick: 0 })
  })

  it('a red flag puts the escalation card first, then the written answer, with nothing quoted beside it (ADR-0021)', async () => {
    const { m } = models({ classify: cls('urgent'), answers: ['If it stays very high, seek medical attention. [kb:high]'] })
    const o = await turn('my sugar is 380, what does high blood sugar mean', m)
    expect(o.tier).toBe('urgent')
    expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'answer'])
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'urgent' })
  })

  it('an urgent turn with no written answer quotes the "what to do" passage after the help notice (ADR-0021)', async () => {
    const { m } = models({ classify: cls('urgent'), answers: [''] }) // the answer is blocked
    const o = await turn('my sugar is 380, what does high blood sugar mean', m)
    expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'passage'])
    expect(o.cards[1]).toMatchObject({ kind: 'passage', why: 'urgent', passage: { id: 'high' } })
  })

  it('a model answer with dose advice never reaches the patient: the best passage is shown instead', async () => {
    const { m } = models({ answers: ['Eat some fruit and take 4 units before dinner. [kb:fruit]'] })
    const o = await turn('What fruit can I eat?', m)
    expect(o.guard).toMatch(/^dose_advice/)
    expect(o.cards.find((c) => c.kind === 'answer')).toBeUndefined()
    expect(o.cards).toContainEqual({ kind: 'passage', why: 'fallback', passage: expect.objectContaining({ id: 'fruit' }) })
  })

  it('never gives a dose-tagged passage to the model', async () => {
    let prompt = ''
    const { m } = models({})
    m.complete = (async (msgs: ChatMessage[]) => {
      prompt = msgs.map((x) => x.content).join('\n')
      return { message: { role: 'assistant', content: 'Berries are a good choice. [kb:fruit]' } as ChatMessage }
    }) as CompleteFn
    await turn(`${PROVIDER_Q} And what fruit can I eat?`, m) // fruit gives the model something to answer from
    expect(prompt).toContain('Passages:') // the model really was asked (see the regression note below)
    expect(prompt).not.toContain('correction insulin if you have not taken insulin')
  })

  it('with dose passages shown to the model (test runs only), the guard still blocks dose advice', async () => {
    // ADR-0013 (Kay, 2026-11-16): rule 1 is off in kb:eval-faq runs, so the model can
    // read passages like "sugar over 250, what to do" that merely mention insulin. The
    // dose-advice block (rule 2) must then be the line that holds.
    let prompt = ''
    const { m } = models({ answers: ['If you have not taken insulin in the last 4 hours, take 2 units of correction insulin. [kb:corr]'] })
    const complete = m.complete
    m.complete = (async (msgs: ChatMessage[], ...rest: unknown[]) => {
      prompt = msgs.map((x) => x.content).join('\n')
      return (complete as (...a: unknown[]) => unknown)(msgs, ...rest)
    }) as CompleteFn
    const o = await runTurn({
      message: PROVIDER_Q, history: [], profile: NONE, index, doseSession: false,
      models: m, timeoutMs: 50, monitorEnabled: false, hideDosePassages: false,
    })
    expect(prompt).toContain('correction insulin if you have not taken insulin') // the model saw it
    expect(o.guard).toMatch(/^dose_advice/) // and its dose advice never reached the patient
    expect(o.cards.some((c) => c.kind === 'answer')).toBe(false)
  })

  it('with rules 2 and 3 paused (test runs only), a dose question reaches the model and its answer is not blocked', async () => {
    // ADR-0013 (Kay, 2026-11-16): "pause 2 and 3 for now on test". The default (the
    // live app) is covered above: the refusal card, and the guard blocking "4 units".
    const reply = 'Increase your insulin a little before dinner. [kb:corr]' // rule 2 catches this; no number, so the separate number check doesn't
    const { m, calls } = models({ classify: cls('none', true, true), answers: [reply] })
    const o = await runTurn({
      message: 'How many units of insulin should I take for dinner with fruit?', history: [], profile: NONE, index, doseSession: false,
      models: m, timeoutMs: 50, monitorEnabled: false, enforceDoseRules: false, hideDosePassages: false, // as kb:eval-faq runs
    })
    expect(o.triage.doseIntent).toBe(true) // still detected, so a test run can report it
    expect(calls.complete).toBe(1)
    expect(o.cards).toEqual([{ kind: 'answer', text: 'Increase your insulin a little before dinner.', sources: [expect.objectContaining({ id: 'corr' })] }])
    expect(doseAdviceIn(reply)).toMatch(/^dose_advice/) // so the test run would mark it
  })

  it('in a dose-flagged session the monitor must approve first, and its veto replaces the answer', async () => {
    const { m, calls } = models({
      answers: ['Berries and apples are good choices. [kb:fruit]'],
      monitor: JSON.stringify({ veto: true, raise_tier: 'none', reason: 'dose across turns' }),
    })
    const o = await turn('What fruit can I eat?', m, { doseSession: true })
    expect(o.monitor).toBe('blocking')
    expect(o.guard).toBe('monitor_veto')
    expect(o.cards.map((c) => c.kind)).toEqual(['dose_refusal'])
    expect(calls.monitor).toBe(1)
  })

  it('a monitor that fails in a dose session still shows help inline (never silently none)', async () => {
    const { m } = models({ answers: ['Berries are good. [kb:fruit]'], monitor: null })
    const o = await turn('What fruit can I eat?', m, { doseSession: true })
    expect(o.tier).toBe('checkin')
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'checkin' })
  })

  it('a failed classifier counts as check-in, and the answer still comes', async () => {
    const { m } = models({ classify: new Error('timeout'), answers: ['Berries are good. [kb:fruit]'] })
    const o = await turn('What fruit can I eat?', m)
    expect(o.tier).toBe('checkin')
    expect(o.triage.classifierFailed).toBe(true)
    expect(o.cards.some((c) => c.kind === 'answer')).toBe(true)
  })

  it('with the monitor paused, no monitor call is made, even in a dose session, and the guard still blocks dose advice', async () => {
    const { m, calls } = models({ answers: ['Berries are good. [kb:fruit]', 'Take 4 units before dinner. [kb:fruit]'] })
    const ok = await turn('What fruit can I eat?', m, { doseSession: true, monitorEnabled: false })
    expect(ok.monitor).toBe('paused')
    expect(ok.cards.map((c) => c.kind)).toEqual(['answer'])
    const bad = await turn('What fruit can I eat?', m, { doseSession: true, monitorEnabled: false })
    expect(bad.guard).toMatch(/^dose_advice/)
    expect(calls.monitor).toBe(0)
  })

  it('nothing relevant in the knowledge base: "no information", and no answer model call', async () => {
    const { m, calls } = models({})
    const o = await turn('How do I renew my passport?', m)
    expect(o.cards.map((c) => c.kind)).toEqual(['no_info'])
    expect(calls.complete).toBe(0)
  })
})

describe('small talk (ADR-0016)', () => {
  it('a greeting with a red flag still escalates; it is not answered as small talk', async () => {
    // The fixed rules alone must catch this: the classifier here says "none".
    const { m } = models({})
    const o = await turn('hi, my sugar is 400 and I have ketones', m)
    expect(o.tier).not.toBe('none')
    expect(o.cards[0]).toMatchObject({ kind: 'escalation' })
    expect(o.cards.some((c) => c.kind === 'social')).toBe(false)
  })

  it('a greeting followed by a question gets the normal cited answer', async () => {
    const { m, calls } = models({ answers: ['Berries and apples raise glucose less than bananas. [kb:fruit]'] })
    const o = await turn('Hi! What fruit can I eat?', m)
    expect(o.cards[0]).toMatchObject({ kind: 'answer' })
    expect(calls.complete).toBe(1)
  })

  it('small talk the classifier flags (e.g. distress) is not brushed off with a fixed reply', async () => {
    const { m } = models({ classify: cls('distress') })
    const o = await turn('bye', m)
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'distress' })
    expect(o.cards.some((c) => c.kind === 'social')).toBe(false)
  })
})

describe('messages that are not English (ADR-0017)', () => {
  it('a Spanish emergency the classifier misses still gets help, and no answer model', async () => {
    // The floor: the fixed rules are English patterns, and here the classifier says "none".
    const { m, calls } = models({})
    const o = await turn('no puedo respirar y me duele el pecho', m)
    expect(o.cards).toEqual([{ kind: 'language', lang: 'es' }])
    expect(calls.complete).toBe(0)
  })

  it('when the classifier does catch it, its 911 card comes first', async () => {
    const { m } = models({ classify: cls('emergency') })
    const o = await turn('我的血糖很低，站不起来', m)
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'emergency' })
    expect(o.cards[1]).toEqual({ kind: 'language', lang: 'zh' })
  })

  it('an urgent non-English message gets no English "what to do" passage', async () => {
    const { m } = models({ classify: cls('urgent') })
    const o = await turn('혈당이 너무 높아요', m)
    expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'language'])
  })

  it('an English question with a Spanish food word is answered normally', async () => {
    const { m, calls } = models({ answers: ['Berries and apples raise glucose less than bananas. [kb:fruit]'] })
    const o = await turn('What fruit can I eat with jalapeños?', m)
    expect(o.cards[0]).toMatchObject({ kind: 'answer' })
    expect(calls.complete).toBe(1)
  })
})

describe('plan read-back in chat (ADR-0020)', () => {
  // A plan question is answered by code from the record; the plan never enters a model
  // call. Anything that turns it into "what should I do now?" keeps today's refusal.
  const robertRegimen = robertFixture.regimen as unknown as Regimen
  const planCls = (tier = 'none', dose_intent = true) =>
    JSON.stringify({ tier, happening_now: false, dose_intent, plan_question: true, reason: 'test' })
  const planTurn = (message: string, m: TurnModels, regimen: Regimen = robertRegimen) =>
    runTurn({ message, history: [], profile: NONE, index, doseSession: false, models: m, timeoutMs: 50, monitorEnabled: true, regimen })

  it("reads Robert's plan back with no answer model, and no model call ever sees it", async () => {
    const seen: string[] = []
    const { m, calls } = models({ classify: planCls() })
    const spy: TurnModels = { ...m, classify: async (msg, hist) => (seen.push(msg, JSON.stringify(hist)), m.classify(msg, hist)) }
    const o = await planTurn("What's my insulin dose today?", spy)
    expect(o.cards.map((c) => c.kind)).toEqual(['plan'])
    expect(o.plan).toEqual({ blocker: null, mode: 'special' })
    expect(calls).toMatchObject({ complete: 0, monitor: 0 })
    expect(seen.join(' ')).not.toMatch(/16 units|prednisone 30/i)
  })

  it('a reading in the message keeps the refusal, even when the classifier calls it a plan question', async () => {
    const { m, calls } = models({ classify: planCls() })
    const o = await planTurn('My sugar is 300, what is my dose today?', m)
    expect(o.cards.map((c) => c.kind)).not.toContain('plan')
    expect(o.plan?.blocker).toBeTruthy()
    expect(calls.complete).toBe(0)
  })

  it('any triage concern escalates as before and never shows the plan', async () => {
    const { m } = models({ classify: planCls('checkin') })
    const o = await planTurn("What's my insulin today?", m)
    expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'dose_refusal'])
    expect(o.plan).toEqual({ blocker: 'tier_checkin', mode: null })
  })

  it('without the classifier saying "plan question", a dose question is refused, with the record offered (ADR-0022)', async () => {
    // Before ADR-0022 this was a bare refusal; the wording has no reading, symptom or
    // change word, so the refusal now offers the insulin on file instead of a dead end.
    const { m } = models({ classify: cls('none', true, true) })
    const o = await planTurn("What's my insulin dose today?", m)
    expect(o.cards).toEqual([{ kind: 'dose_refusal', offerPlan: true }])
    expect(o.plan).toEqual({ blocker: null, mode: null, offered: true })
  })

  describe('the refusal offers the insulin on file when the question may only be about the plan (ADR-0022)', () => {
    // Kay, live site, 2026-11-19: "hwo much insulin should i take" got a dead-end refusal,
    // though "what's my insulin on file" would have read the record back.
    const doseCls = cls('none', true, true) // dose_intent, not a plan question: what the classifier said live

    it('"how much insulin should I take?" gets the refusal plus the offer, and no answer model', async () => {
      const { m, calls } = models({ classify: doseCls })
      const o = await planTurn('how much insulin should I take?', m)
      expect(o.cards).toEqual([{ kind: 'dose_refusal', offerPlan: true }])
      expect(o.plan).toMatchObject({ offered: true, mode: null })
      expect(calls).toMatchObject({ complete: 0, monitor: 0 })
    })

    it('a decision for today never gets the offer: a reading, a symptom, or a change word', async () => {
      for (const message of ['my sugar is 300, how much should I take', 'I feel shaky, how much insulin should I take', 'should I take more insulin', 'can I skip my insulin']) {
        const o = await planTurn(message, models({ classify: doseCls }).m)
        expect(o.cards.some((c) => c.kind === 'dose_refusal'), message).toBe(true)
        expect(o.cards.some((c) => c.kind === 'dose_refusal' && c.offerPlan), message).toBe(false)
      }
    })

    it('no offer when nothing is on file, or when triage raised a concern', async () => {
      const empty = await planTurn('how much insulin should I take?', models({ classify: doseCls }).m, {} as Regimen)
      expect(empty.cards).toEqual([{ kind: 'dose_refusal' }])
      const concern = await planTurn('how much insulin should I take?', models({ classify: cls('checkin', true, true) }).m)
      expect(concern.cards.some((c) => c.kind === 'dose_refusal' && c.offerPlan)).toBe(false)
    })

    it('the tap reads the record back by code, and the history the next model reads holds no doses', () => {
      const o = planOnRequest(robertRegimen, false)
      expect(o.cards.map((c) => c.kind)).toEqual(['plan'])
      expect(o.modelCalls).toBe(0)
      expect(o.plan).toEqual({ blocker: null, mode: 'special', via: 'offer' })
      const shown = o.cards[0].kind === 'plan' ? o.cards[0].reply.lines.join(' ') : ''
      expect(shown).toMatch(/units/) // the patient sees the record…
      expect(cardsToText(o.cards)).not.toMatch(/units|mg/i) // …the chat history never carries it
    })
  })

  it('no regimen passed in (the rules-only path, an older screen): refused as before', async () => {
    const { m } = models({ classify: planCls() })
    const o = await runTurn({ message: "What's my insulin today?", history: [], profile: NONE, index, doseSession: false, models: m, timeoutMs: 50 })
    expect(o.cards.map((c) => c.kind)).toEqual(['dose_refusal'])
    expect(o.plan).toEqual({ blocker: 'no_regimen', mode: null })
  })
})

describe('portal tasks go back to the portal menu (ADR-0023)', () => {
  const PUMP_USER: Profile = { history_of_dka: true, pregnant: false, uses_pump: true } // George
  const adminCls = (admin: string) => JSON.stringify({ tier: 'none', happening_now: false, dose_intent: false, admin, reason: 'test' })

  it('a refill request gets the refill card and no answer model', async () => {
    const { m, calls } = models({})
    const o = await turn('I need a refill of my insulin', m)
    expect(o.cards).toEqual([{ kind: 'admin', lane: 'refill' }])
    expect(o.admin).toEqual({ lane: 'refill', via: 'rules' })
    expect(calls).toMatchObject({ complete: 0, monitor: 0 })
  })

  it('the classifier widens a phrasing the rules miss', async () => {
    const { m } = models({ classify: adminCls('refill') })
    const o = await turn('can someone send more lantus to my pharmacy', m)
    expect(o.cards).toEqual([{ kind: 'admin', lane: 'refill' }])
    expect(o.admin?.via).toBe('classifier')
  })

  it("a pump that won't turn on: the nurse line first, then the pump card (Taylor Lee, 2026-11-18)", async () => {
    // Taylor: the manufacturer fixes the pump, the care team covers injections meanwhile.
    // The urgent alert carries the second half; the card carries the first.
    const { m } = models({ classify: cls('urgent', true) }) // a report, happening now
    const o = await turn("My insulin pump won't turn on.", m, { profile: PUMP_USER })
    expect(o.cards.map((c) => (c.kind === 'escalation' ? `escalation:${c.tier}` : c.kind))).toEqual(['escalation:urgent', 'admin'])
    expect(o.triage.criteria).toContain('pump_failure_pump_user') // the fixed rule, not only the classifier
  })

  it('an emergency still short-circuits before any card or model call', async () => {
    const { m, calls } = models({})
    const o = await turn("my pump died and my husband won't wake up", m, { profile: PUMP_USER })
    expect(o.tier).toBe('emergency')
    expect(o.cards.some((c) => c.kind === 'admin')).toBe(false)
    expect(calls.classify).toBe(0)
  })

  it('a health question that only mentions an appointment is still answered', async () => {
    // (This test's small index has nothing on appointments, so the turn ends at "no
    // information"; the live knowledge base has a support section for it.)
    const { m } = models({})
    const o = await turn("How do I prepare for my doctor's appointment?", m)
    expect(o.cards.some((c) => c.kind === 'admin')).toBe(false)
    expect(o.admin ?? null).toBeNull()
  })
})

describe('Regression tests', () => {
  it("a refill request no longer reads Dorothy's insulin back (Kay, live site, 2026-11-21; ADR-0023)", async () => {
    // Bug: "I need a refill of my insulin" on Dorothy's screen showed her regimen. The
    // classifier called it a plan question, and planBlocker (plan.ts) vetoes only a
    // reading, a symptom, a change word or an advice phrasing, none of which a refill
    // request has. The same intent got four different replies across patients and
    // phrasings (ADR-0023's table). The admin check now runs before the plan step.
    const { m, calls } = models({ classify: JSON.stringify({ tier: 'none', happening_now: false, dose_intent: false, plan_question: true, reason: 'test' }) })
    const o = await runTurn({
      message: 'I need a refill of my insulin', history: [], profile: NONE, index, doseSession: false, models: m, timeoutMs: 50,
      monitorEnabled: true, regimen: dorothyFixture.regimen as unknown as Regimen,
    })
    expect(o.cards).toEqual([{ kind: 'admin', lane: 'refill' }])
    expect(o.plan).toBeNull()
    expect(calls.complete).toBe(0)
  })

  it('"hi" gets the fixed greeting, not "I don\'t have information on that" (Kay, live site, 2026-11-17)', async () => {
    // Bug: "hi" ran the answer model, which wrote a friendly uncited greeting; the
    // guard blocked it (no_citation, by design: ADR-0005), no passage fit as a
    // fallback, and the tester's first reply was "I don't have information on that".
    // Fixed (ADR-0016): after triage says "none", small talk gets a fixed reply and
    // the answer model is not called.
    const { m, calls } = models({ answers: ['Hi! I can help with questions about diabetes care. What would you like to know?'] })
    const o = await turn('hi', m)
    expect(o.cards).toEqual([{ kind: 'social', intent: 'greeting' }])
    expect(calls.classify).toBe(1) // triage still ran
    expect(calls.complete).toBe(0)
    expect(o.guard).toBeNull()
  })

  it('"how to lower my blood sugar after a meal" never shows the treat-a-low passage in place of a "no information" reply (Kay, 2026-11-14)', async () => {
    // Bug: Kay asked how to LOWER their blood sugar and was shown how to treat a LOW.
    // The model followed ANSWER_SYSTEM and replied "I don't have information on
    // that…", which (as instructed) cites nothing; the guard blocked it as
    // no_citation, and the fallback then showed the top-ranked passage verbatim —
    // the Rule of 15 for hypoglycemia, the opposite problem.
    // Fixed: a no-citation "no information" reply becomes the no_info card, and the
    // blocked draft is kept for the care-team log so blocks can be diagnosed.
    const { m } = models({ answers: ["I don't have information on that. Your care team can help."] })
    const o = await turn('how to lower my blood sugar after a meal', m)
    expect(o.guard).toBe('no_citation')
    expect(o.cards.map((c) => c.kind)).toEqual(['no_info'])
    expect(o.blockedDraft).toContain("I don't have information")
  })

  it('a failed classifier on "What fruit can I eat?" shows the check-in card without the treat-a-low passage (Kay, 2026-11-14)', async () => {
    // Bug: the classifier failed (logged as classifier_unavailable), so the turn
    // became a check-in; with no glucose number, the urgent passage was searched as
    // "<message> low blood glucose treat", which attached the Rule of 15 for lows to
    // a question about fruit. Fixed: the urgent passage needs a direction (a reading,
    // or words like low/high); otherwise the check-in card stands alone.
    const { m } = models({ classify: new Error('timeout'), answers: ['Berries are good. [kb:fruit]'] })
    const o = await turn('What fruit can I eat?', m)
    expect(o.tier).toBe('checkin')
    expect(o.cards[0]).toMatchObject({ kind: 'escalation', tier: 'checkin' })
    expect(o.cards.some((c) => c.kind === 'passage' && c.passage.id === 'hypo')).toBe(false)
    // an urgent red flag that names a low still gets the low passage
    const low = await turn('I keep going low and feel shaky', models({ classify: cls('urgent') }).m)
    expect(low.cards).toContainEqual({ kind: 'passage', why: 'urgent', passage: expect.objectContaining({ id: 'hypo' }) })
  })

  it('one question gets one reply: a help notice at most, then a single body (Kay, 2026-11-14)', async () => {
    // Bug: "why is my blood sugar high" showed four blocks — a check-in card, an
    // "urgent" passage, a dose passage, and a fallback passage — for one question.
    // Fixed: a check-in adds no passage; a dose-tagged best match is shown only in place
    // of an answer; a blocked answer is replaced by exactly one passage.
    // Shaped like the real case: the best match is a dose-tagged "after eating" passage.
    const afterMeals = buildIndex([
      P('meal-dose', 'After eating', 'If blood sugar is high after eating, follow your provider plan for correction insulin after eating.', ['dose_related', 'medication', 'urgent']),
      P('high', 'High blood sugar', 'If blood sugar stays very high, or you are vomiting or have ketones, seek medical attention.', ['urgent']),
      // unrelated passages, so word rarity behaves as it does in a real corpus
      P('fruit', 'What fruit can I eat?', 'Berries, apples and pears are good choices. Keep fruit to one cup.'),
      P('plate', 'Plan your plate', 'Fill half the plate with non-starchy vegetables.'),
      P('drinks', 'Beverages', 'Water is the best choice. Limit soda and juice.'),
      P('walk', 'Activity', 'A short walk most days helps your heart and mood.'),
    ])
    const ask = (answer: string) =>
      runTurn({
        message: 'why is my blood sugar high after eating', history: [], profile: NONE, index: afterMeals, doseSession: false,
        models: models({ classify: cls('checkin'), answers: [answer] }).m, timeoutMs: 50, monitorEnabled: false,
      })

    // the answer gets through: the help notice and the answer, nothing else
    const answered = await ask('If it stays very high, seek medical attention. [kb:high]')
    expect(answered.cards.map((c) => c.kind)).toEqual(['escalation', 'answer'])

    // the answer is blocked: exactly one passage, the dose passage shown word for word
    const blocked = await ask('')
    expect(blocked.cards.map((c) => c.kind)).toEqual(['escalation', 'passage'])
    expect(blocked.cards[1]).toMatchObject({ why: 'dose', passage: { id: 'meal-dose' } })
  })

  it('a "no information" reply with citations attached is shown as no information, not as a sourced answer (RAG-only FAQ run, 2026-11-16)', async () => {
    // Bug: the guard only recognised the no-information wording when it carried no
    // citation. Two real replies cited a passage anyway, so the patient saw "I don't
    // have information on that." credited to ADA, and "The passages don't list which
    // fruits are best for you." (system talk) credited to the book.
    // Fixed: a reply made only of decline/referral sentences becomes the no_info card,
    // and the prompt forbids mentioning "passages".
    for (const reply of [
      "I don't have information on that. Your care team can help. [kb:fruit]",
      "The passages don't list which fruits are best for you. Your care team can help with that. [kb:fruit]",
    ]) {
      const o = await turn('What fruit can I eat?', models({ answers: [reply] }).m, { monitorEnabled: false })
      expect(o.cards.map((c) => c.kind), reply).toEqual(['no_info'])
      expect(o.guard).toBe('decline_with_citation')
      expect(o.blockedDraft).toBe(reply)
    }
    // A partial answer that opens with a decline but then says something useful stays an answer.
    const partial = await turn('What fruit can I eat?', models({ answers: ["I don't have information on a daily number. Berries and apples raise glucose less than bananas. [kb:fruit]"] }).m, { monitorEnabled: false })
    expect(partial.cards.map((c) => c.kind)).toEqual(['answer'])
  })

  describe('"my blood sugar is high, what do i do" (Kay, live site, 2026-11-19; ADR-0021)', () => {
    // Bug: an urgent high showed the help notice, then a quoted ADA passage, then the
    // written answer: two texts for one question ("why would the bot return two
    // messages"). For a type 2 patient the quote was ada-t2-guide-022, a chunk that opens
    // with how to prevent LOWS and then defines hyperglycemia ("why returning the
    // definition"): the own-type boost ranked it first, and the care team's own "What do
    // I do when I have a high blood sugar" (team-faqs-008) was never shown.
    // Fixed: one message (help notice + written answer); the quote is held back for
    // replies with no written answer, and prefers the care team's passage.
    const F = (id: string, section: string, body: string, tags: string[] = []): KbPassage => ({ ...P(id, section, body, tags), source_label: 'care_team', doc_title: 'Care team FAQs' })
    // Shaped like the real passages (text abridged; the real text isn't in the repo).
    const shaped = buildIndex([
      { ...P('t2-chunk', 'After eating', 'How can I prevent low blood glucose? Take medications as prescribed and carry a fast-acting carbohydrate. What is high blood glucose (hyperglycemia)? Hyperglycemia is when your blood glucose is too high. High blood glucose can happen when your body has too little insulin. Signs of high blood glucose include thirst.', ['urgent']), diabetes_type: 'type2' as const },
      F('faq-high', 'What do I do when I have a high blood sugar (>250 mg/dL)?', 'Drink water and monitor your blood sugar. If it remains very high, you are vomiting, or have positive ketones, seek medical attention immediately.', ['urgent']),
      P('hypo', 'Treating low blood glucose', 'To treat low blood glucose below 70 mg/dL, use the Rule of 15: eat 15 grams of fast-acting carbohydrate and recheck after 15 minutes.', ['urgent']),
      P('fruit', 'What fruit can I eat?', 'Berries, apples and pears are good choices. Keep fruit to one cup.'),
      P('plate', 'Plan your plate', 'Fill half the plate with non-starchy vegetables.'),
      P('walk', 'Activity', 'A short walk most days helps your heart and mood.'),
    ])
    const ask = (message: string, answer: string) =>
      runTurn({
        message, history: [], profile: NONE, index: shaped, diabetesType: 'type2', doseSession: false, timeoutMs: 50, monitorEnabled: false,
        models: models({ classify: cls('urgent'), answers: [answer] }).m,
      })

    it('precondition: search alone ranks the defining chunk first for a type 2 patient', () => {
      const urgent = shaped.search('my blood sugar is high, what do i do high blood sugar ketones', 12, { diabetesType: 'type2' }).filter((h) => h.passage.tags.includes('urgent'))
      expect(urgent[0].passage.id).toBe('t2-chunk')
    })

    it('with a written answer, the reply is one message: the help notice and the answer', async () => {
      const o = await ask('my blood sugar is high, what do i do', 'Drink water and monitor your blood sugar. Seek care now if you are vomiting. [kb:faq-high]')
      expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'answer'])
    })

    it("with no written answer, the quote is the care team's short passage, not the definition", async () => {
      const o = await ask('my blood sugar is high, what do i do', '')
      expect(o.cards).toEqual([expect.objectContaining({ kind: 'escalation' }), { kind: 'passage', why: 'urgent', passage: expect.objectContaining({ id: 'faq-high' }) }])
    })

    it("a low never gets the care team's high-sugar passage", async () => {
      const o = await ask('my blood sugar is low and I feel shaky, what do i do', '')
      expect(o.cards).toContainEqual({ kind: 'passage', why: 'urgent', passage: expect.objectContaining({ id: 'hypo' }) })
    })
  })

  it('a monitor that raises the level replaces the help notice: one alert box, not two (Kay, live site, 2026-11-18; ADR-0021)', async () => {
    // Bug: "my blood sugar is high and i have large ketones" showed an urgent box and,
    // above it, an emergency box the monitor added. Fixed: the raise replaces the notice.
    const { m } = models({
      classify: cls('urgent'),
      answers: ['If it stays very high, or you have ketones, seek medical attention. [kb:high]'],
      monitor: JSON.stringify({ veto: false, raise_tier: 'emergency', reason: 'ketones with a high' }),
    })
    const o = await turn('my blood sugar is high and I have ketones, what do i do', m, { doseSession: true })
    const boxes = o.cards.filter((c) => c.kind === 'escalation')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ tier: 'emergency', criteria: expect.arrayContaining(['monitor_raised']) })
    expect(o.cards.map((c) => c.kind)).toEqual(['escalation', 'answer'])
  })

  it('an empty model reply is its own guard reason, not "no citation"', async () => {
    // All three of Kay's answers on 2026-11-14 were logged as no_citation with no
    // draft kept, so an empty reply and an uncited one looked the same.
    const { m } = models({ answers: [''] })
    const o = await turn('What fruit can I eat?', m)
    expect(o.guard).toBe('empty_answer')
    expect(o.cards).toContainEqual({ kind: 'passage', why: 'fallback', passage: expect.objectContaining({ id: 'fruit' }) })
  })
})

// ADR-0013 (QST-KB-CARD-USE: A): a matched approved card is shown as written; the model
// only picks among a shortlist, and code checks its pick. Shaped like the real drafts.
describe('approved topic cards', () => {
  const card = (id: string, topic: string, asks: string[], body: string, source_ids: string[], status: TopicCard['status'] = 'approved'): TopicCard =>
    ({ id, topic, asks, body, source_ids, status })
  const fruitCard = card('card-fruit', 'Fruit and diabetes', ['What fruit can I eat?', 'Is fruit okay with diabetes?', 'Can I eat bananas?'],
    'Fruit can be part of your meals. Berries, apples and pears raise blood glucose less than melon or bananas. Keep fruit to one cup at a time.', ['fruit'])
  const lowCard = card('card-low-treat', 'How to treat a low blood sugar', ['What do I do if my sugar is low?', 'What is the rule of 15?'],
    'If your blood glucose is below 70 mg/dL, eat 15 grams of fast-acting carbohydrate and check again after 15 minutes.', ['hypo'])
  const draftCard = card('card-fruit-juice', 'Fruit juice', ['Can I drink fruit juice?', 'What fruit can I eat?'], 'DRAFT TEXT not yet approved.', ['fruit'], 'draft')
  const passages = [
    P('fruit', 'What fruit can I eat?', 'Berries, apples and pears tend to raise blood glucose less than melon or bananas. Keep fruit to one cup.'),
    P('hypo', 'Treating low blood glucose', 'To treat low blood glucose below 70 mg/dL, use the Rule of 15.', ['urgent']),
  ]
  // The turn's decisions depend on scores calibrated on the real knowledge base (cards.ts),
  // which a 4-passage fixture can't reproduce, so the turn tests below search a card
  // index whose scores are set on purpose; the real index has its own tests further down.
  const scored = (hits: { card: TopicCard; score: number }[]): CardIndex => ({
    size: hits.length,
    search: (_q, k = 3) => hits.slice(0, k).map((h) => ({ ...h, sources: passages.filter((p) => h.card.source_ids.includes(p.id)) })),
  })
  const strongFruit = scored([{ card: fruitCard, score: CARD_FALLBACK_SCORE + 2 }, { card: lowCard, score: 3 }])
  const ask = (message: string, m: TurnModels, cards: CardIndex = strongFruit) =>
    runTurn({ message, history: [], profile: NONE, index, cards, doseSession: false, models: m, timeoutMs: 50, monitorEnabled: false, cardsEnabled: true })

  it('a picked card is shown word for word, with its sources, and the answer model is never called', async () => {
    const { m, calls } = models({ pick: 'card-fruit' })
    const o = await ask('What fruit can I eat?', m)
    expect(o.cards).toEqual([{ kind: 'topic_card', card: fruitCard, sources: [expect.objectContaining({ id: 'fruit' })] }])
    expect(o.card).toMatchObject({ id: 'card-fruit', how: 'picked', shortlist: ['card-fruit', 'card-low-treat'] })
    expect(calls).toMatchObject({ classify: 1, pick: 1, complete: 0 })
  })

  it('a draft card is never shown or even offered, though it matches the question', async () => {
    // RLS serves members approved cards only; this is the second lock, for a wrong
    // query or a loosened policy.
    const real = buildCardIndex([fruitCard, lowCard, draftCard], passages)
    expect(real.size).toBe(2)
    expect(real.search('Can I drink fruit juice? What fruit can I eat?', 5).map((h) => h.card.id)).not.toContain('card-fruit-juice')
    // and a picker that names it anyway gets the raw-passage path, not the draft
    const { m } = models({ pick: 'card-fruit-juice', answers: ['Berries are a good choice. [kb:fruit]'] })
    const o = await ask('Can I drink fruit juice?', m, real)
    expect(o.cards.some((c) => c.kind === 'topic_card')).toBe(false)
    expect(JSON.stringify(o.cards)).not.toContain('DRAFT TEXT')
  })

  it('a pick that names a card not on the shortlist is treated as none: the raw-passage answer runs', async () => {
    const { m, calls } = models({ pick: 'card-snacks', answers: ['Berries are a good choice. [kb:fruit]'] }) // an approved id, but not offered
    const o = await ask('What fruit can I eat?', m)
    expect(o.card).toMatchObject({ id: null, how: 'none' })
    expect(o.cards.map((c) => c.kind)).toEqual(['answer'])
    expect(calls.complete).toBe(1)
  })

  it('"none" from the picker means the raw-passage path, as before cards', async () => {
    const { m } = models({ pick: 'none', answers: ['Berries are a good choice. [kb:fruit]'] })
    const o = await ask('What fruit can I eat?', m)
    expect(o.card).toMatchObject({ how: 'none' })
    expect(o.cards.map((c) => c.kind)).toEqual(['answer'])
  })

  it('when the pick call fails, the top card is shown only if its score clears CARD_FALLBACK_SCORE', async () => {
    const confident = await ask('What fruit can I eat?', models({ pick: new Error('timeout') }).m)
    expect(confident.card).toMatchObject({ id: 'card-fruit', how: 'fallback' })
    expect(confident.cards.map((c) => c.kind)).toEqual(['topic_card'])

    // just under the bar: the wrong-card first places seen in calibration reached 12.8
    const unsureIndex = scored([{ card: fruitCard, score: CARD_FALLBACK_SCORE - 0.5 }])
    const unsure = await ask('What fruit can I eat?', models({ pick: new Error('timeout'), answers: ['Bananas raise blood glucose more than berries. [kb:fruit]'] }).m, unsureIndex)
    expect(unsure.card).toMatchObject({ id: null, how: 'failed' })
    expect(unsure.cards.map((c) => c.kind)).toEqual(['answer'])
  })

  it('no card is close enough: no pick call is made (it would only cost money)', async () => {
    const { m, calls } = models({})
    const o = await ask('How do I renew my passport?', m, scored([{ card: fruitCard, score: CARD_MIN_SCORE - 0.1 }]))
    expect(o.card).toMatchObject({ how: 'no_match', shortlist: [] })
    expect(calls.pick).toBe(0)
  })

  it('emergencies and dose questions never reach the cards', async () => {
    const e = models({ pick: 'card-low-treat' })
    const emergency = await ask("my husband won't wake up and his sugar was low", e.m)
    expect(emergency.card).toBeNull()
    expect(e.calls.pick).toBe(0)

    const d = models({ classify: cls('none', true, true), pick: 'card-low-treat' })
    const dose = await ask('How much insulin should I take when my sugar is low?', d.m)
    expect(dose.cards.map((c) => c.kind)).toEqual(['dose_refusal'])
    expect(d.calls.pick).toBe(0)
  })

  it('with no approved cards, turns run exactly as before cards (no pick call)', async () => {
    const { m, calls } = models({ answers: ['Berries are a good choice. [kb:fruit]'] })
    const o = await runTurn({
      message: 'What fruit can I eat?', history: [], profile: NONE, index, cards: buildCardIndex([draftCard]), doseSession: false, models: m, timeoutMs: 50, monitorEnabled: false, cardsEnabled: true,
    })
    expect(o.card).toBeNull()
    expect(calls.pick).toBe(0)
    expect(o.cards.map((c) => c.kind)).toEqual(['answer'])
  })

  it('reads the picker reply the ways models write it, and trusts only shortlisted ids', () => {
    const list = ['card-fruit', 'card-snacks']
    expect(parsePick('card-fruit', list)).toEqual({ id: 'card-fruit' })
    expect(parsePick(' "card-fruit". ', list)).toEqual({ id: 'card-fruit' })
    expect(parsePick('The best match is card-snacks.', list)).toEqual({ id: 'card-snacks' })
    expect(parsePick('None', list)).toEqual({ none: true })
    expect(parsePick('card-fruit or card-snacks', list)).toEqual({ none: true }) // ambiguous
    expect(parsePick('card-low-treat', list)).toEqual({ none: true }) // not offered
    expect(parsePick('card-fruit-juice', list)).toEqual({ none: true }) // a longer id is not card-fruit
    expect(parsePick(null, list)).toBeNull() // failure, not "none"
  })

  it('loading cards never takes the patient view down: a missing table or a failed read gives no cards', async () => {
    // The site deploys on every push, before the database migration that creates
    // kb_cards; the Data API then answers 404 for the table.
    const missing: DataClient = { get: () => Promise.reject(new DataError(404, 'Data API 404')) }
    expect(await loadApprovedCards(missing)).toEqual([])
    const served: DataClient = { get: <T,>() => Promise.resolve([lowCard, draftCard] as T) }
    expect((await loadApprovedCards(served)).map((c) => c.id)).toEqual(['card-low-treat'])
  })

  it('while cards are paused (CARDS_PAUSED, the RAG-only trial), approved cards are never searched or picked', async () => {
    const { m, calls } = models({ pick: 'card-fruit', answers: ['Berries are a good choice. [kb:fruit]'] })
    const o = await runTurn({ message: 'What fruit can I eat?', history: [], profile: NONE, index, cards: strongFruit, doseSession: false, models: m, timeoutMs: 50, monitorEnabled: false })
    expect(o.card).toBeNull()
    expect(calls.pick).toBe(0)
    expect(o.cards.map((c) => c.kind)).toEqual(['answer'])
  })

  describe('Regression tests', () => {
    it("a card's score doesn't depend on how many cards are approved (found 2026-11-16)", () => {
      // Bug: card search took word rarity from the approved cards alone. With 2 cards
      // instead of 30, "What fruit can I eat?" scored under CARD_MIN_SCORE, so no pick
      // call was made and the card never showed, though it was approved and matched.
      // The sponsor may approve cards in batches, so this would have hidden cards
      // exactly while few were live. Fixed: rarity comes from the cards plus the whole
      // knowledge base (buildIndex's `background`), as in calibration.
      const kb = [
        ...passages,
        P('plate', 'Plan your plate', 'Fill half the plate with non-starchy vegetables.'),
        P('drinks', 'Beverages', 'Water is the best choice. Limit soda and juice.'),
        P('walk', 'Activity', 'A short walk most days helps your heart and mood.'),
        P('feet', 'Foot care', 'Check your feet every day for cuts and blisters.'),
      ]
      const q = 'What fruit can I eat?'
      const alone = buildCardIndex([fruitCard], kb).search(q)[0].score
      const among = buildCardIndex([fruitCard, lowCard], kb).search(q)[0].score
      expect(alone / among).toBeGreaterThan(0.85)
      expect(alone / among).toBeLessThan(1.15)
    })
  })
})

// ADR-0013 (QST-KB-BOOK-ROLE: A): the book informs written answers but is never shown
// word for word (first-person voice; copyright allows brief quotes only).
describe('the book is never shown word for word', () => {
  // Unrelated passages, so word rarity behaves as in the real knowledge base (in a
  // 5-passage index every shared word looks common and relevant passages score low).
  const FILLER = [
    P('f-feet', 'Foot care', 'Check your feet every day for cuts, blisters, and swelling.'),
    P('f-eyes', 'Eye exams', 'Get a dilated eye exam every year to look for retinopathy.'),
    P('f-kidney', 'Kidney health', 'A urine test checks how well your kidneys filter waste.'),
    P('f-sleep', 'Sleep', 'Most adults need seven or more hours of sleep each night.'),
    P('f-stress', 'Stress', 'Deep breathing and talking with friends can ease stress.'),
    P('f-teeth', 'Dental care', 'Brush twice a day and see the dentist twice a year.'),
    P('f-flu', 'Vaccines', 'A yearly flu shot is recommended for people with diabetes.'),
    P('f-smoke', 'Smoking', 'Quitting smoking lowers the risk of heart disease.'),
  ]
  const B = (id: string, section: string, body: string, tags: string[] = []): KbPassage => ({ ...P(id, section, body, tags), source_label: 'book', doc_title: 'Bright Spots & Landmines' })
  const withBook = buildIndex([
    // Strong enough to rank first even with the book weighted at 0.8 (SOURCE_WEIGHT).
    B('book-walk', 'Walking after meals', 'I walk for 15 minutes after dinner and my blood sugar after meals is much steadier. Walking after meals is one of my favorite habits. Walking after meals helps blood sugar after meals.'),
    B('book-low', 'Low blood sugar', 'When my blood sugar is low I treat it with glucose tabs, then check again.', ['urgent']),
    P('ada-walk', 'Physical activity', 'Regular physical activity helps manage blood glucose.'), // relevant, but a weaker match than the book's
    P('ada-low', 'Treating low blood glucose', 'To treat low blood glucose below 70 mg/dL, use the Rule of 15.', ['urgent']),
    P('plate', 'Plan your plate', 'Fill half the plate with non-starchy vegetables.'),
    P('drinks', 'Beverages', 'Water is the best choice. Limit soda and juice.'),
    ...FILLER,
  ])
  const go = (message: string, m: TurnModels) =>
    runTurn({ message, history: [], profile: NONE, index: withBook, doseSession: false, models: m, timeoutMs: 50, monitorEnabled: false })

  it("a blocked answer falls back to an ADA passage, not the book's, even when the book ranks first", async () => {
    expect(withBook.search('walking after meals blood sugar')[0].passage.id).toBe('book-walk') // precondition
    const o = await go('Does walking after meals help my blood sugar?', models({ answers: ['Walk for 15 minutes after dinner. [kb:book-walk]'] }).m)
    expect(o.guard).toBe('unsupported_number:15') // the book's number doesn't count
    expect(o.cards).toEqual([{ kind: 'passage', why: 'fallback', passage: expect.objectContaining({ id: 'ada-walk' }) }])
  })

  it("an ADA-backed answer loses only its book-number sentence, and the draft is kept for the log (QST-KB-RAG-ROUND3: B)", async () => {
    const draft = 'Regular walking helps manage blood glucose after meals. [kb:ada-walk] One writer walks for 15 minutes after dinner. [kb:book-walk]'
    const o = await go('Does walking after meals help my blood sugar?', models({ answers: [draft] }).m)
    expect(o.cards).toEqual([{ kind: 'answer', text: 'Regular walking helps manage blood glucose after meals.', sources: [expect.objectContaining({ id: 'ada-walk' })] }])
    expect(o.guard).toBe('trimmed_book_number:15')
    expect(o.blockedDraft).toBe(draft)
  })

  describe('source priority: care-team FAQ, then ADA, then the book (Kay, 2026-11-16)', () => {
    const F = (id: string, section: string, body: string): KbPassage => ({ ...P(id, section, body), source_label: 'care_team', doc_title: 'Care team FAQs' })
    const three = buildIndex([
      B('book-fruit', 'What fruit can I eat?', 'I love berries as fruit; they barely raise my blood sugar compared with melon or bananas.'),
      P('ada-fruit', 'What fruit can I eat?', 'Whole fruit like berries and apples can be part of a healthy eating plan for blood sugar.'),
      F('faq-fruit', 'What fruit can I eat?', 'Keep fruit to 1 cup or 1 small fruit. Berries raise blood sugar less than melon or bananas.'),
      P('plate', 'Plan your plate', 'Fill half the plate with non-starchy vegetables.'),
      P('walk', 'Activity', 'A short walk most days helps your heart and mood.'),
      ...FILLER,
    ])
    it('the model reads relevant passages in priority order, labelled by source', async () => {
      let prompt = ''
      const { m } = models({})
      m.complete = (async (msgs: ChatMessage[]) => {
        prompt = msgs.map((x) => x.content).join('\n')
        return { message: { role: 'assistant', content: 'Keep fruit to 1 cup. [kb:faq-fruit]' } as ChatMessage }
      }) as CompleteFn
      await runTurn({ message: 'What fruit can I eat?', history: [], profile: NONE, index: three, doseSession: false, models: m, timeoutMs: 50, monitorEnabled: false })
      const order = [...prompt.matchAll(/\[kb:([a-z-]+)\] \(([^)]+)\)/g)].map((x) => `${x[1]}:${x[2]}`)
      expect(order.slice(0, 3)).toEqual(['faq-fruit:care-team FAQ', 'ada-fruit:ADA', 'book-fruit:book'])
    })
    it("the FAQ's numbers count, like ADA's (only the book's don't)", async () => {
      const o = await runTurn({
        message: 'What fruit can I eat?', history: [], profile: NONE, index: three, doseSession: false, timeoutMs: 50, monitorEnabled: false,
        models: models({ answers: ['Keep fruit to 1 cup or 1 small fruit. [kb:faq-fruit]'] }).m,
      })
      expect(o.cards).toEqual([{ kind: 'answer', text: 'Keep fruit to 1 cup or 1 small fruit.', sources: [expect.objectContaining({ id: 'faq-fruit' })] }])
    })
  })

  it('the urgent "what to do" passage is always ADA, never the book', async () => {
    // With a written answer nothing is quoted (ADR-0021), so block the answer to see the quote.
    const o = await go('my sugar is 45 and I feel shaky', models({ classify: cls('urgent'), answers: [''] }).m)
    const shown = o.cards.filter((c) => c.kind === 'passage')
    expect(shown).toEqual([{ kind: 'passage', why: 'urgent', passage: expect.objectContaining({ id: 'ada-low' }) }])
  })
})
