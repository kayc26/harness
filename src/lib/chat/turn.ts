// One patient turn, end to end (ADR-0005..0008). Model calls are injected, so the
// ordering guarantees are testable offline:
//   1. fixed-rule triage first; an emergency short-circuits with no model call;
//   2. classifier (timeout counts as check-in), combined with the rules;
//   2c. a task for another portal lane (refill, appointment, billing, a broken pump) gets
//      a fixed card naming where to go (ADR-0023), before the plan and dose steps;
//   3. a dose question gets the fixed refusal card, and the answer model is never called;
//   4. dose-tagged passages are never given to the model; one is shown verbatim only if
//      it's the best match and the question is about glucose/insulin/medicine;
//   3b. approved topic cards (ADR-0013): search shortlists up to 3, a model picks one
//      id or "none", code checks the pick is on the shortlist, and a picked card is
//      shown word for word; no model writes text on that path;
//   5. nothing relevant in the knowledge base -> "no information" with no model call;
//   6. the agent loop writes an answer from shown passages (search_kb tool, few rounds);
//   7. the guard checks it; a blocked answer falls back to the best passage verbatim;
//   8. in a dose-flagged session the monitor must approve before display; otherwise it
//      reviews in the background and can raise the tier on the next screen (ADR-0007).

import { runAgent, type CompleteFn } from '../agent'
import type { ChatMessage, ToolSpec } from '../types'
import { CARD_FALLBACK_SCORE, CARD_MIN_SCORE, CARD_SHORTLIST, parsePick, type CardHit, type CardIndex, type TopicCard } from './cards'
import { combineTriage, parseClassifier, type CombinedTriage } from './combine'
import { checkAnswer, clarifyingQuestion, stripCitations, trimBookNumbers } from './guard'
import { ANSWER_SYSTEM, ANSWER_TOOL_ROUNDS, CARDS_PAUSED, MONITOR_PAUSED } from './prompts'
import { direction, lean, type DiabetesType, type Hit, type Index, type KbPassage, type SearchOptions } from './retrieve'
import { detectLanguage, type Lang } from './language'
import { socialIntent, type SocialIntent } from './social'
import { sectionPassages, type Topic } from './topics'
import { maxTier, triageRules, type Profile, type Tier } from './triage'
import { OFFER_PLAN_AFTER_REFUSAL, planBlocker } from './plan'
import { hasPlanOnFile, planReply, type PlanReply, type Regimen } from '../patients/readback'
import { adminLane, type AdminLane } from './admin'

export type Card =
  | { kind: 'escalation'; tier: Tier; criteria: string[] }
  | { kind: 'passage'; passage: KbPassage; why: 'urgent' | 'dose' | 'fallback' }
  /** `offerPlan`: ADR-0022, the wording may only mean "what's on my plan?", so the refusal
   *  offers a button that reads the record back by code (planOnRequest). */
  | { kind: 'dose_refusal'; offerPlan?: boolean }
  /** ADR-0020: the patient's plan read back by code, never by a model. */
  | { kind: 'plan'; reply: PlanReply }
  | { kind: 'no_info' }
  /** A fixed reply to small talk (ADR-0016); no model wrote it. */
  | { kind: 'social'; intent: SocialIntent }
  /** One short question the model asks when it needs a detail to answer (ADR-0018 it. 5); uncited, checked in guard.ts. */
  | { kind: 'clarify'; text: string }
  /** The message isn't English: help buttons and an "English only" note (ADR-0017). */
  | { kind: 'language'; lang: Lang }
  /** A task for another lane of the portal menu, or the pump maker (ADR-0023); fixed text. */
  | { kind: 'admin'; lane: AdminLane }
  | { kind: 'answer'; text: string; sources: KbPassage[] }
  | { kind: 'topic_card'; card: TopicCard; sources: KbPassage[] }

/** What the card step did, for the care-team log (ADR-0013's falsifier: which card or
 *  passage answered each turn). */
export interface CardStep {
  /** The card shown, if one was. */
  id: string | null
  how:
    | 'picked' // the model picked a shortlisted card
    | 'fallback' // the pick call failed; the top card scored high enough on its own
    | 'none' // the model said none, or named a card that wasn't offered
    | 'failed' // the pick call failed and no card scored high enough
    | 'no_match' // no card scored high enough to shortlist; no pick call
  shortlist: string[]
}

export interface MonitorVerdict {
  veto: boolean
  raise_tier: Tier
  reason: string
}

export interface TurnModels {
  /** Raw classifier reply (JSON text), or throws/null on failure. */
  classify(message: string, recent: ChatMessage[]): Promise<string | null>
  /** One streamed/non-streamed completion for the agent loop. */
  complete: CompleteFn
  /** Raw monitor reply (JSON text) for the conversation plus the draft. */
  monitor(transcript: string, draft: string): Promise<string | null>
  /** Raw pick reply: one shortlisted card id, or "none". */
  pick(message: string, recent: ChatMessage[], shortlist: TopicCard[]): Promise<string | null>
}

export interface TurnInput {
  message: string
  history: ChatMessage[] // earlier user/assistant turns, plain text
  profile: Profile
  index: Index
  /** Approved topic cards (ADR-0013). Absent or empty: the raw-passage path, as before cards. */
  cards?: CardIndex
  doseSession: boolean // sticky once a dose/medication topic has come up (ADR-0007)
  models: TurnModels
  timeoutMs?: number
  /** All loaded passages, for the curated topic sections (ADR-0018). Absent: word search only. */
  passages?: KbPassage[]
  /** Overrides MONITOR_PAUSED (tests run both ways). */
  monitorEnabled?: boolean
  /** Overrides CARDS_PAUSED (tests run both ways). */
  cardsEnabled?: boolean
  /** The patient's diabetes type: passages for the other type rank lower (ADR-0013, QST-KB-RAG-FIXES: B). */
  diabetesType?: DiabetesType
  /** Hide dose-tagged passages from the model (default true; only test runs set false). */
  hideDosePassages?: boolean
  /** Rules 2 and 3 (dose-advice block, dose refusal card). Default true; only test runs set false. */
  enforceDoseRules?: boolean
  /** The patient's regimen, for the plan read-back (ADR-0020). Read by code only: it is
   *  never put into a model call (ADR-0005, rule 1). Absent: plan questions are refused. */
  regimen?: Regimen
}

export interface TurnOutcome {
  triage: CombinedTriage
  tier: Tier
  cards: Card[]
  doseSession: boolean
  guard: string | null // why an answer was blocked, if it was
  /** The model's draft when the guard blocked it, kept for the care-team log so a
   *  block can be diagnosed later (the patient never sees it). */
  blockedDraft?: string
  /** The classifier's topics (ADR-0018). */
  topics?: Topic[]
  /** ADR-0020: set when the classifier called it a plan question. `blocker` says why the
   *  plan was not read back (null: it was), `mode` which reply was shown. */
  /** ADR-0022: `offered` when the refusal offered the record; `via: 'offer'` on the tap's turn. */
  plan?: { blocker: string | null; mode: PlanReply['mode'] | null; offered?: boolean; via?: 'offer' } | null
  /** ADR-0023: the portal lane the message was pointed to, and whether the fixed rules
   *  or the classifier found it. Null when it was not an admin message. */
  admin?: { lane: AdminLane; via: 'rules' | 'classifier' } | null
  /** How the answer's material was found: whole topic sections, or word search. Null when no answer was attempted. */
  retrieval?: 'topics' | 'search' | null
  monitor: 'none' | 'blocking' | 'background' | 'paused'
  monitorVerdict: MonitorVerdict | null
  /** For background review: resolves after display; may raise the tier next screen. */
  background: Promise<MonitorVerdict | null> | null
  modelCalls: number
  /** Null when the card step didn't run (emergency, dose question, no approved cards). */
  card: CardStep | null
}

const MIN_SCORE = 2.0
/** The model's "nothing in the passages" reply (ANSWER_SYSTEM asks for this wording). */
const NO_INFO = /\bI don[’']?t have (?:any )?information (?:on|about) (?:that|this)\b/i

/**
 * A reply that says nothing but "no information", however the model words it, even
 * with citations attached. Every sentence is a decline ("I don't have information…",
 * "The passages don't list…"), a referral ("Your care team can help."), or the help
 * reminder. Shown as an answer, it credited a source for a non-answer (baseline FAQ
 * run, 2026-11-16).
 */
const DECLINE_SENTENCE =
  /^(?:I don[’']?t have (?:any )?information\b|I can[’']?t (?:tell|say|answer)\b|The (?:passages|sources|material)s? (?:don[’']?t|do not|doesn[’']?t)\b|(?:Your|The) care team (?:can|will) help\b|If you feel (?:very )?unwell\b)/i
export function isOnlyDecline(text: string): boolean {
  const sentences = stripCitations(text).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  return sentences.length > 0 && sentences.every((s) => DECLINE_SENTENCE.test(s))
}
const MEDICAL_TOPIC = /\b(sugar|glucose|insulin|ketone|medic|dose|pump|shot|injection|metformin|pill|high|low|a1c|dka)\w*/i
const isDose = (p: KbPassage) => p.tags.includes('dose_related')
/** Only ADA (and care-team) passages are ever shown word for word. A book passage is
 *  first-person and copyrighted, so it can inform a written answer but is never shown
 *  as the urgent, dose, or fallback passage (ADR-0013, QST-KB-BOOK-ROLE: A). */
const showable = (p: KbPassage) => p.source_label !== 'book'

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

export function parseMonitor(text: string | null): MonitorVerdict | null {
  if (!text) return null
  try {
    const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
    if (typeof o.veto !== 'boolean') return null
    const tiers: Tier[] = ['none', 'checkin', 'distress', 'urgent', 'emergency']
    return {
      veto: o.veto,
      raise_tier: tiers.includes(o.raise_tier as Tier) ? (o.raise_tier as Tier) : 'none',
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
    }
  } catch {
    return null
  }
}

/** The approved passage to show on an escalation: lows get the low card, highs the high one. */
/** The approved "what to do" passage for a red flag, only when the message says which
 *  way the problem points (a reading, or words like "low" / "high"). Without that,
 *  the escalation card stands alone: a check-in that came from a failed classifier on
 *  "What fruit can I eat?" must not arrive with the Rule of 15 for lows attached. */
function urgentPassage(index: Index, message: string, glucose: number | null, opts: SearchOptions = {}): KbPassage | null {
  const dir = glucose !== null ? (glucose > 180 ? 'high' : glucose < 70 ? 'low' : null) : direction(message)
  if (!dir) return null
  const q = dir === 'high' ? `${message} high blood sugar ketones` : `${message} low blood glucose treat`
  const found = index
    .search(q, 12, opts)
    .map((h) => h.passage)
    .filter((p) => p.tags.includes('urgent') && showable(p))
    .filter((p) => {
      const l = lean(`${p.section ?? ''} ${p.body}`)
      return l === null || l === dir // never the opposite problem's "what to do"
    })
  // ADR-0021 (Kay, 2026-11-19): the care team's own passage first ("faq -> ada -> book").
  // Search alone picked ADA chunks that explain what hyperglycemia or DKA *is* (for a
  // type 2 patient, one that opens with how to prevent lows) over the care team's
  // "What do I do when I have a high blood sugar".
  return found.find((p) => p.source_label === 'care_team') ?? found[0] ?? null
}

/**
 * The tap on "Show my insulin on file" under a dose refusal (ADR-0022). The record is
 * read back by code, as in ADR-0020: no classifier, no answer model, no monitor. The
 * triage source is logged as rules (code), with the criterion naming the tap.
 */
export function planOnRequest(regimen: Regimen, doseSession: boolean): TurnOutcome {
  const reply = planReply(regimen)
  return {
    triage: { tier: 'none', criteria: ['plan_offer_tap'], doseIntent: false, softened: false, classifierFailed: true },
    tier: 'none', cards: [{ kind: 'plan', reply }], doseSession, guard: null, monitor: 'none', monitorVerdict: null, background: null, modelCalls: 0, card: null,
    plan: { blocker: null, mode: reply.mode, via: 'offer' },
  }
}

/** One alert box per reply (ADR-0021, Kay 2026-11-19): raising the level replaces the
 *  reply's help notice instead of adding a second box. The highest tier wins; criteria
 *  are kept, plus the one that raised it. */
export function raiseEscalation(cards: Card[], to: Tier, criterion: string): Card[] {
  const old = cards.filter((c): c is Extract<Card, { kind: 'escalation' }> => c.kind === 'escalation')
  const tier = old.reduce<Tier>((t, c) => maxTier(t, c.tier), to)
  const criteria = [...new Set([...old.flatMap((c) => c.criteria), criterion])]
  return [{ kind: 'escalation', tier, criteria }, ...cards.filter((c) => c.kind !== 'escalation')]
}

const SEARCH_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'search_kb',
    description: 'Search the approved diabetes education passages. Returns passages with ids to cite as [kb:id].',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}

/** What the model is told about each passage, including its source, so it can follow
 *  the priority (ANSWER_SYSTEM): the care-team FAQ, then ADA, then the book. */
const SOURCE_NAME: Record<KbPassage['source_label'], string> = { care_team: 'care-team FAQ', ADA: 'ADA', book: 'book' }
const fmt = (p: KbPassage) => `[kb:${p.id}] (${SOURCE_NAME[p.source_label]}) ${p.doc_title}${p.section ? ` (${p.section})` : ''}\n${p.body}`
/** Source priority among passages already relevant (Kay, 2026-11-16: "faq -> ada -> book"); stable, so score order holds within a source. */
const PRIORITY: Record<KbPassage['source_label'], number> = { care_team: 0, ADA: 1, book: 2 }
const byPriority = (ps: KbPassage[]) => [...ps].sort((a, b) => PRIORITY[a.source_label] - PRIORITY[b.source_label])

export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { message, profile, index, models } = input
  const timeoutMs = input.timeoutMs ?? 6000
  let modelCalls = 0
  const rules = triageRules(message, profile)
  const byType: SearchOptions = { diabetesType: input.diabetesType }
  // The three dose rules. All on in the live app; test runs may pause them (ADR-0013,
  // Kay 2026-11-16: rule 1 "drop the dose-related constraint for testing", then
  // "pause 2 and 3 for now on test").
  //   1. dose-tagged passages hidden from the model, shown only word for word (ADR-0005);
  //   2. the guard blocks dose advice in what the model writes;
  //   3. a dose question gets the fixed refusal card and no answer model.
  const hidden = (p: KbPassage) => (input.hideDosePassages ?? true) && isDose(p)
  const enforceDose = input.enforceDoseRules ?? true
  const cards: Card[] = []

  // 1. Emergency: no model call, 911 first, approved "while you wait" passage.
  if (rules.tier === 'emergency') {
    const p = urgentPassage(index, message, rules.glucose, byType)
    cards.push({ kind: 'escalation', tier: 'emergency', criteria: rules.criteria })
    if (p) cards.push({ kind: 'passage', passage: p, why: 'urgent' })
    const triage: CombinedTriage = { tier: 'emergency', criteria: rules.criteria, doseIntent: rules.doseIntent, softened: false, classifierFailed: false }
    return { triage, tier: 'emergency', cards, doseSession: input.doseSession, guard: null, monitor: 'none', monitorVerdict: null, background: null, modelCalls, card: null }
  }

  // 2. Classifier.
  modelCalls++
  const classified = parseClassifier(await withTimeout(models.classify(message, input.history.slice(-4)), timeoutMs))
  const triage = combineTriage(rules, classified)
  const topics = classified?.topics ?? [] // ADR-0018: which knowledge-base sections to read
  let tier = triage.tier
  const doseSession = input.doseSession || triage.doseIntent || MEDICAL_TOPIC.test(message) && /\b(insulin|dose|medic|pump|shot|injection)\w*/i.test(message)

  // One question, one reply (Kay, 2026-11-14: "I ask one question and it gives me
  // several cards"). Besides the help notice, a turn shows ONE body: the answer, or a
  // single approved passage, or a fixed card. Only an urgent red flag adds its "what
  // to do" passage, because there that passage is the point.
  const lang = detectLanguage(message)
  if (tier !== 'none') cards.push({ kind: 'escalation', tier, criteria: triage.criteria })
  // ADR-0021 (Kay, 2026-11-19: "written answer only"): an urgent turn is one message,
  // the help notice and the written answer. The "what to do" passage is held back and
  // quoted only when no written answer is shown (a dose refusal, a blocked answer, no
  // information): see settleUrgent below. It is English, so only for English messages
  // (the language card carries the help otherwise).
  const urgentHeld = tier === 'urgent' && lang === 'en' ? urgentPassage(index, message, rules.glucose, byType) : null
  const settleUrgent = (): void => {
    if (!urgentHeld || cards.some((c) => c.kind === 'answer' || c.kind === 'topic_card')) return
    // No written answer: the held passage is the body, in place of "no information" or
    // a weaker passage (as before ADR-0021), right after the help notice.
    const rest: Card[] = cards.filter((c) => c.kind !== 'no_info' && c.kind !== 'passage')
    const at = rest.findIndex((c) => c.kind !== 'escalation')
    rest.splice(at === -1 ? rest.length : at, 0, { kind: 'passage', passage: urgentHeld, why: 'urgent' })
    cards.splice(0, cards.length, ...rest)
  }
  const hasPassage = () => cards.some((c) => c.kind === 'passage')

  let cardStep: CardStep | null = null
  let retrieval: TurnOutcome['retrieval'] = null
  // Set when a book-number sentence was trimmed from an answer that is still shown.
  let trimNote: Pick<TurnOutcome, 'guard' | 'blockedDraft'> = { guard: null }
  let plan: TurnOutcome['plan'] = null
  const done = (extra: Partial<TurnOutcome> = {}): TurnOutcome => {
    settleUrgent()
    return { triage, tier, cards, doseSession, monitor: 'none', monitorVerdict: null, background: null, modelCalls, card: cardStep, topics, retrieval, plan, ...trimNote, ...extra }
  }

  // 2b. Not English (ADR-0017, QST-LANG-FLOOR: A). The fixed rules above are English
  // patterns, so here only the classifier could have caught a red flag. Whatever it
  // said, show help (nurse line and 911) with an "English only" note, and stop: the
  // dose rules, search, the guard and small talk are English-only too.
  if (lang !== 'en') {
    cards.push({ kind: 'language', lang })
    return done()
  }

  // 2c. A task for another lane of the portal menu (ADR-0023). After triage, so a red
  // flag keeps its alert above the card (a broken pump is urgent: the nurse line, then
  // the pump card). Before the plan read-back and the dose refusal (QST-ADMIN-ORDER: A):
  // "I need a refill of my insulin" is not a dose question and not a plan question, and
  // was answered as both. Fixed rules first, the classifier only widens (GATE: C).
  const admin = adminLane(message, classified?.admin)
  if (admin) {
    cards.push({ kind: 'admin', lane: admin.lane })
    return done({ admin })
  }

  // 3-plan. A question about what the patient's own plan says (ADR-0020). Read back by
  // code from the record, no model. Only when the classifier says it's a plan question,
  // nothing in triage, and no fixed check finds a reading, symptom, change word or
  // request for advice; otherwise a dose question still gets the refusal below.
  if (classified?.plan_question) {
    const blocker = tier !== 'none' ? `tier_${tier}` : !input.regimen ? 'no_regimen' : planBlocker(message, rules.glucose)
    plan = { blocker, mode: null }
    if (blocker === null && input.regimen) {
      const reply = planReply(input.regimen)
      plan = { blocker: null, mode: reply.mode }
      cards.push({ kind: 'plan', reply })
      return done()
    }
  }

  // 3. Dose question: fixed card, no answer model.
  if (triage.doseIntent && enforceDose) {
    // ADR-0022: "how much insulin should I take?" may only mean "what's on my plan?".
    // The refusal offers the record (a button; the tap reads it back by code) only when
    // nothing in the message makes it a decision for today: no reading, symptom or change
    // word (planBlocker), no red flag, and something actually on file.
    const blocker = planBlocker(message, rules.glucose)
    const offer = OFFER_PLAN_AFTER_REFUSAL && tier === 'none' && hasPlanOnFile(input.regimen) && (blocker === null || blocker === 'advice')
    cards.push(offer ? { kind: 'dose_refusal', offerPlan: true } : { kind: 'dose_refusal' })
    if (offer) plan = { blocker: plan?.blocker ?? blocker, mode: null, offered: true }
    return done()
  }

  // 3a. Small talk (ADR-0016, QST-SOCIAL-PATH: A). Only after triage says `none`, so a
  // greeting with a red flag has already escalated above. A fixed, approved reply; the
  // answer model is not called, because the guard would block an uncited greeting.
  const social = tier === 'none' ? socialIntent(message) : null
  if (social) {
    cards.push({ kind: 'social', intent: social })
    return done()
  }

  // 3b. Approved topic cards. A picked card is the reply's body, shown as approved, so
  // the answer guard and the monitor have nothing to check: no model wrote it, and the
  // sponsor approved it as dose-free (ADR-0013, decision item 5).
  // Cards are paused (CARDS_PAUSED: Kay, 2026-11-16, QST-KB-RAG-FIRST: "try c first"):
  // the trial answers from RAG only.
  if (input.cards && input.cards.size > 0 && (input.cardsEnabled ?? !CARDS_PAUSED)) {
    const shortlist = input.cards.search(message, CARD_SHORTLIST).filter((h) => h.score >= CARD_MIN_SCORE)
    const ids = shortlist.map((h) => h.card.id)
    let shown: CardHit | undefined
    let how: CardStep['how'] = 'no_match'
    if (shortlist.length > 0) {
      modelCalls++
      const pick = parsePick(await withTimeout(models.pick(message, input.history.slice(-4), shortlist.map((h) => h.card)), timeoutMs), ids)
      if (pick === null) {
        shown = shortlist[0].score >= CARD_FALLBACK_SCORE ? shortlist[0] : undefined
        how = shown ? 'fallback' : 'failed'
      } else if ('id' in pick) {
        shown = shortlist.find((h) => h.card.id === pick.id)
        how = 'picked'
      } else {
        how = 'none'
      }
    }
    cardStep = { id: shown?.card.id ?? null, how, shortlist: ids }
    if (shown) {
      cards.push({ kind: 'topic_card', card: shown.card, sources: shown.sources })
      return done()
    }
  }

  // 4–5. Retrieval. Word search always runs: it picks the dose passage below and ranks
  // passages by relevance for the fallback after a blocked answer.
  const hits: Hit[] = index.search(message, 8, byType)
  const top = hits[0]
  // A dose-tagged best match is never given to the model; it is shown word for word,
  // but only when no answer is shown (as the one passage in place of an answer).
  const dosePassage = top && hidden(top.passage) && showable(top.passage) && MEDICAL_TOPIC.test(message) ? top.passage : null
  // ADR-0018 (QST-RETRIEVAL-SHAPE: A): the whole curated sections for the classifier's
  // topics, plus the few best book passages. No topic, no loaded passages, or a failed
  // classifier: word search's top 4, as before.
  const routed = input.passages ? sectionPassages(topics, message, input.passages, index, { diabetesType: input.diabetesType, hidden }) : []
  retrieval = routed.length ? 'topics' : 'search'
  const context = routed.length ? routed : hits.filter((h) => !hidden(h.passage) && h.score >= MIN_SCORE).slice(0, 4).map((h) => h.passage)
  if (context.length === 0) {
    if (dosePassage && !hasPassage()) cards.push({ kind: 'passage', passage: dosePassage, why: 'dose' })
    else if (!hasPassage()) cards.push({ kind: 'no_info' })
    return done()
  }

  // 6. Agent loop.
  const shown = new Map(context.map((p) => [p.id, p]))
  const messages: ChatMessage[] = [
    { role: 'system', content: ANSWER_SYSTEM },
    ...input.history.slice(-6),
    { role: 'user', content: `${message}\n\nPassages:\n\n${byPriority(context).map(fmt).join('\n\n')}` },
  ]
  let draft = ''
  const complete: CompleteFn = async (...args) => {
    modelCalls++
    return input.models.complete(...args)
  }
  await runAgent({
    history: messages,
    tools: [SEARCH_TOOL],
    maxToolRounds: ANSWER_TOOL_ROUNDS,
    complete,
    runTool: async (call) => {
      const q = String((JSON.parse(call.function.arguments || '{}') as { query?: string }).query ?? '')
      const found = index.search(q, 4, byType).filter((h) => !hidden(h.passage)).map((h) => h.passage)
      for (const p of found) shown.set(p.id, p)
      return found.length ? byPriority(found).map(fmt).join('\n\n') : 'No matching passages.'
    },
    emit: (e) => {
      if (e.type === 'assistant_message' && !e.message.tool_calls?.length) draft = e.message.content ?? ''
    },
  })

  // 7. Guard.
  const verdict = checkAnswer(draft, [...shown.values()], message, { doseAdvice: enforceDose })
  // A book-only number costs its sentence, not the whole answer (QST-KB-RAG-ROUND3: B).
  const trimmed = verdict.ok ? null : trimBookNumbers(draft, [...shown.values()], message, { doseAdvice: enforceDose })
  if (trimmed) trimNote = { guard: `trimmed_book_number:${verdict.ok ? '' : verdict.reason.slice('unsupported_number:'.length)}`, blockedDraft: draft }
  const fallback = (): void => {
    if (hasPassage()) return // an urgent passage is already the reply's body
    if (dosePassage) return void cards.push({ kind: 'passage', passage: dosePassage, why: 'dose' })
    // By relevance, not priority: a less relevant FAQ passage must not stand in for an
    // answer. Routed sections are in priority order, so rank them by the search hits.
    const inContext = new Set(context.map((p) => p.id))
    const best = routed.length
      ? index.search(message, 60, byType).map((h) => h.passage).find((p) => inContext.has(p.id) && showable(p) && !hidden(p))
      : context.find(showable)
    cards.push(best ? { kind: 'passage', passage: best, why: 'fallback' } : { kind: 'no_info' })
  }
  // A short clarifying question, uncited, checked in guard.ts (ADR-0018 iteration 5).
  if (!verdict.ok && verdict.reason === 'no_citation') {
    const question = clarifyingQuestion(draft, message, { doseAdvice: enforceDose })
    if (question) {
      cards.push({ kind: 'clarify', text: question })
      return done()
    }
  }
  if (!verdict.ok && !trimmed) {
    // The prompt tells the model to say "I don't have information on that" when the
    // passages don't answer. That reply carries no citation, and showing the top
    // passage in its place answers a question the model just said it couldn't.
    if (verdict.reason === 'no_citation' && NO_INFO.test(draft)) cards.push({ kind: 'no_info' })
    else fallback()
    return done({ guard: verdict.reason, blockedDraft: draft })
  }
  const text = trimmed ? trimmed.text : draft
  const citations = trimmed ? trimmed.citations : verdict.ok ? verdict.citations : []
  if (isOnlyDecline(text)) {
    cards.push({ kind: 'no_info' })
    return done({ guard: 'decline_with_citation', blockedDraft: draft })
  }
  const answer: Card = { kind: 'answer', text: stripCitations(text), sources: citations.map((id) => shown.get(id)!).filter(Boolean) }

  // 8. Monitor (ADR-0007; on again since 2026-11-17, QST-MONITOR-UNPAUSE: A). If it is
  // paused (MONITOR_PAUSED), no monitor call is made; the fixed-rule guard above still
  // blocks dose advice in numbers, and dose questions still get the refusal card.
  if (!(input.monitorEnabled ?? !MONITOR_PAUSED)) {
    cards.push(answer)
    return done({ monitor: 'paused' })
  }
  const transcript = [...input.history, { role: 'user', content: message }]
    .map((m) => `${m.role === 'user' ? 'Patient' : 'Assistant'}: ${m.content ?? ''}`)
    .join('\n')
  if (doseSession) {
    modelCalls++
    const mv = parseMonitor(await withTimeout(models.monitor(transcript, text), timeoutMs))
    if (!mv) {
      tier = maxTier(tier, 'checkin') // monitor down: fixed checks still applied; show help inline
      if (!cards.some((c) => c.kind === 'escalation')) cards.unshift({ kind: 'escalation', tier, criteria: ['monitor_unavailable'] })
      cards.push(answer)
      return done({ tier, monitor: 'blocking' })
    }
    if (mv.raise_tier && maxTier(tier, mv.raise_tier) !== tier) {
      tier = maxTier(tier, mv.raise_tier)
      cards.splice(0, cards.length, ...raiseEscalation(cards, tier, 'monitor_raised')) // one alert box (ADR-0021)
    }
    if (mv.veto) {
      cards.push({ kind: 'dose_refusal' })
      return done({ tier, monitor: 'blocking', monitorVerdict: mv, guard: 'monitor_veto' })
    }
    cards.push(answer)
    return done({ tier, monitor: 'blocking', monitorVerdict: mv })
  }

  cards.push(answer)
  modelCalls++
  const background = withTimeout(models.monitor(transcript, text), timeoutMs * 2).then(parseMonitor)
  return done({ monitor: 'background', background })
}
