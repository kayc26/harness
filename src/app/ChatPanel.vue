<script setup lang="ts">
// The patient chat (ADR-0005..0008), laid out as the mockup's chat window
// (docs/mockups/portal-assistant.html): a scrolling message area on the soft background,
// white assistant bubbles with source chips, the patient's bubbles in Penn Blue, and the
// "Ask" composer pinned at the bottom. Each message runs one turn (src/lib/chat/turn.ts)
// and is saved to Neon. Model calls go through the model proxy (ADR-0014, C): a Neon
// Function holding the shared OpenRouter key, which the browser never sees. The tester's
// sign-in token is the only credential here, and the proxy caps each tester at $1, shown
// below the Ask box as a percentage, never in dollars. If a model call fails, the
// fixed-rule triage still runs and still shows help: the help path never depends on it.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { LLM_PROXY_URL } from '../config'
import { allowanceText, fetchAllowance, type AllowanceView } from '../lib/proxy/client'
import type { ChatMessage } from '../lib/types'
import type { DataClient } from '../lib/neon/data'
import { buildIndex, type DiabetesType, type KbPassage } from '../lib/chat/retrieve'
import { buildCardIndex, type TopicCard } from '../lib/chat/cards'
import { openRouterModels, type CostMeter } from '../lib/chat/models'
import { ConversationLog, cardsToText } from '../lib/chat/persist'
import { NO_INFO_REPLY, SOCIAL_REPLY } from '../lib/chat/social'
import { ADMIN_CARD, adminRules, PORTAL_MENU } from '../lib/chat/admin'
import { detectLanguage, LANGUAGE_NOTE } from '../lib/chat/language'
import { planOnRequest, raiseEscalation, runTurn, type Card, type TurnOutcome } from '../lib/chat/turn'
import type { Regimen } from '../lib/patients/readback'
import { maxTier, triageRules, TIER_RANK, type Profile, type Tier } from '../lib/chat/triage'
import { OpenRouterError } from '../lib/openrouter'

const props = defineProps<{
  data: Required<DataClient>
  patientId: string
  profile: Profile
  passages: KbPassage[]
  /** Approved topic cards (ADR-0013); empty until the sponsor approves some. */
  cards: TopicCard[]
  /** The demo patient's diabetes type: search ranks their type's guide first (ADR-0013, QST-KB-RAG-FIXES: B). */
  diabetesType: DiabetesType
  /** For the plan read-back (ADR-0020): read by code, never sent to a model. */
  regimen?: Regimen
}>()

// The tester's sign-in token, fresh for each call (tokens last 15 minutes).
const getJwt = () => props.data.getJwt()
const allowance = ref<AllowanceView | null>(null)
async function refreshAllowance(): Promise<void> {
  allowance.value = await fetchAllowance(LLM_PROXY_URL, getJwt)
}
onMounted(refreshAllowance)
const allowanceUsedUp = computed(() => allowance.value?.percent !== null && (allowance.value?.percent ?? 0) >= 100)

interface Item {
  who: 'you' | 'assistant' | 'note'
  text?: string
  cards?: Card[]
}
const items = ref<Item[]>([])
const draft = ref('')
const busy = ref(false)
const saveProblem = ref('')
const index = computed(() => buildIndex(props.passages))
const cardIndex = computed(() => buildCardIndex(props.cards, props.passages))
const meter: CostMeter = { dollars: 0, calls: 0 }
let history: ChatMessage[] = []
let doseSession = false
let tier: Tier = 'none'
let log = new ConversationLog(props.data, props.patientId)

watch(
  () => props.patientId,
  () => {
    items.value = []
    history = []
    doseSession = false
    tier = 'none'
    log = new ConversationLog(props.data, props.patientId)
  },
)

/** Starter questions, like the mockup's suggestion chips. Plain, common, safe topics. */
const SUGGESTIONS = [
  'What fruit can I eat?',
  'What should I do if my sugar is low?',
  'Are sugar substitutes safe?',
  'What is a healthy snack?',
]

const msgs = ref<HTMLElement | null>(null)
async function scrollDown(): Promise<void> {
  await nextTick()
  const el = msgs.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

/**
 * Rules-only turn. With answers off (allowance used up), show exactly what the fixed rules found (nothing for a
 * plain question). When the model path *fails* mid-turn, the ADR-0006 floor applies:
 * a failure counts as at least check-in.
 */
function rulesOnly(message: string, failed: boolean): TurnOutcome {
  const r = triageRules(message, props.profile)
  const t = failed ? maxTier(r.tier, 'checkin') : r.tier
  const cards: Card[] = t === 'none' ? [] : [{ kind: 'escalation', tier: t, criteria: r.criteria }]
  const lang = detectLanguage(message) // ADR-0017: the floor holds when the models are off too
  // ADR-0023: a portal task needs no model either; it comes before the dose refusal.
  const lane = lang === 'en' ? adminRules(message) : null
  if (lang !== 'en') cards.push({ kind: 'language', lang })
  else if (lane) cards.push({ kind: 'admin', lane })
  else if (r.doseIntent) cards.push({ kind: 'dose_refusal' })
  return {
    admin: lane ? { lane, via: 'rules' } : null,
    triage: { tier: t, criteria: [...r.criteria, failed ? 'model_unavailable' : 'allowance_used'], doseIntent: r.doseIntent, softened: false, classifierFailed: true },
    tier: t, cards, doseSession, guard: null, monitor: 'none', monitorVerdict: null, background: null, modelCalls: 0, card: null,
  }
}

/** ADR-0022: the button under a dose refusal. The record is read back by code (no model),
 *  logged as its own turn, and kept out of the chat history as text (persist.ts). */
async function showPlanOnFile(): Promise<void> {
  if (busy.value || !props.regimen) return
  const message = 'Show my insulin on file'
  const outcome = planOnRequest(props.regimen, doseSession)
  items.value.push({ who: 'you', text: message }, { who: 'assistant', cards: outcome.cards })
  history = [...history, { role: 'user', content: message }, { role: 'assistant', content: cardsToText(outcome.cards) }]
  await scrollDown()
  log.record(message, outcome, []).catch(() => {
    saveProblem.value = "This conversation couldn't be saved. You can keep chatting."
  })
}

function ask(q: string): void {
  draft.value = q
  void send()
}

async function send(): Promise<void> {
  const message = draft.value.trim()
  if (!message || busy.value) return
  draft.value = ''
  busy.value = true
  items.value.push({ who: 'you', text: message })
  await scrollDown()

  let outcome: TurnOutcome
  let note = ''
  let usedModels = false
  if (allowanceUsedUp.value) {
    outcome = rulesOnly(message, false)
    note = "You've used all of your test allowance, so answers are off. Help is always available with the red button."
  } else {
    meter.notes = [] // this turn's model calls, for the care-team log
    usedModels = true
    try {
      outcome = await runTurn({
        message, history, profile: props.profile, index: index.value, passages: props.passages, cards: cardIndex.value, diabetesType: props.diabetesType, doseSession, regimen: props.regimen,
        models: openRouterModels(getJwt, meter, { baseUrl: LLM_PROXY_URL }),
      })
    } catch (e) {
      outcome = rulesOnly(message, true)
      note =
        e instanceof OpenRouterError && e.status === 402
          ? "You've used all of your test allowance, so answers are off. Help is always available with the red button."
          : e instanceof OpenRouterError && (e.status === 401 || e.status === 403)
            ? 'Your sign-in has expired. Please sign out and in again.'
            : "Answers aren't working right now. Help is still available."
    }
    void refreshAllowance()
  }
  doseSession = outcome.doseSession
  tier = outcome.tier
  let replyIndex = -1
  if (outcome.cards.length) {
    items.value.push({ who: 'assistant', cards: outcome.cards })
    replyIndex = items.value.length - 1
  }
  if (note) items.value.push({ who: 'note', text: note })
  history = [...history, { role: 'user', content: message }, { role: 'assistant', content: cardsToText(outcome.cards) }]
  busy.value = false
  await scrollDown()

  log.record(message, outcome, usedModels ? [...(meter.notes ?? [])] : []).catch(() => {
    saveProblem.value = "This conversation couldn't be saved. You can keep chatting."
  })

  // Background review (ADR-0007): it can only escalate, never take back what was shown.
  outcome.background?.then(async (v) => {
    if (!v) return
    const turn = log.lastTurn
    if (TIER_RANK[v.raise_tier] > TIER_RANK[tier]) {
      tier = v.raise_tier
      // One alert box (ADR-0021): while this reply is still the newest message, the raise
      // replaces its help notice. Once the conversation has moved on, it is added at the
      // bottom instead, so a late warning can't land out of sight above the screen.
      const reply = items.value[replyIndex]
      if (reply?.cards && replyIndex === items.value.length - 1) reply.cards = raiseEscalation(reply.cards, v.raise_tier, 'monitor_raised')
      else items.value.push({ who: 'assistant', cards: [{ kind: 'escalation', tier: v.raise_tier, criteria: ['monitor_raised'] }] })
      await scrollDown()
    }
    if (v.veto) {
      doseSession = true
      items.value.push({ who: 'note', text: "Please don't use the last answer to decide on a dose. Your care team can help with doses." })
      await scrollDown()
    }
    if (v.veto || v.raise_tier !== 'none') log.recordMonitor(turn, v).catch(() => {})
  })
}

// ADR-0013 iteration 6: the sponsor's book is named as itself, so a patient can tell
// one person's experience from ADA guidance.
const SOURCE = { ADA: 'American Diabetes Association', care_team: 'Your care team', book: 'Bright Spots & Landmines (diaTribe)' } as const
const ESCALATION = {
  emergency: { title: 'This may be an emergency', text: 'Call 911 now. If someone is with you, ask them to stay with you.' },
  urgent: { title: 'Please call the nurse line today', text: 'What you described needs a nurse to look at it today. If you feel worse, call 911.' },
  distress: { title: "You don't have to handle this alone", text: 'Please call the nurse line to talk to someone. If you might hurt yourself, call 911.' },
  checkin: { title: 'If this is happening to you now', text: 'Call the nurse line, or 911 if you feel very unwell.' },
} as const
const escalation = (t: Tier) => ESCALATION[t as Exclude<Tier, 'none'>]
// Source chips name the source, not the document (Kay, 2026-11-14): "American Diabetes
// Association" or "Your care team", one chip per source. The document title stays in
// the chip's tooltip for anyone who wants it.
const uniqueSources = (sources: KbPassage[]) => [...new Map(sources.map((s) => [s.source_label, s])).values()]
const docTitles = (sources: KbPassage[], label: KbPassage['source_label']) =>
  [...new Set(sources.filter((s) => s.source_label === label).map((s) => s.doc_title))].join('; ')
</script>

<template>
  <section class="chat" aria-labelledby="chat-title">
    <h4 id="chat-title" class="sr">Chat with the Diabetes Assistant</h4>

    <div ref="msgs" class="msgs">
      <div class="bubble bot">
        <!-- Doses and emergencies are in the yellow bar above; not repeated here. -->
        <p>Hi! Ask me about diabetes.</p>
      </div>
      <div v-if="items.length === 0" class="chips" aria-label="Suggested questions">
        <button v-for="q in SUGGESTIONS" :key="q" type="button" class="chip" :disabled="busy" @click="ask(q)">{{ q }}</button>
      </div>

      <ol class="items" aria-live="polite">
        <li v-for="(item, i) in items" :key="i" :class="item.who">
          <p v-if="item.who === 'you'" class="bubble me"><span class="sr">You said: </span>{{ item.text }}</p>
          <p v-else-if="item.who === 'note'" class="note-text" role="status">{{ item.text }}</p>
          <template v-else>
            <!-- One question, one reply (Kay, 2026-11-14). Emergency, urgent and distress
                 keep their own alert card above the reply; a check-in is one line inside it. -->
            <template v-for="(c, j) in item.cards" :key="j">
              <div v-if="c.kind === 'escalation' && c.tier !== 'checkin'" :class="['bubble', 'esc', c.tier]" role="alert">
                <p class="esc-title">{{ escalation(c.tier).title }}</p>
                <p>{{ escalation(c.tier).text }}</p>
                <div class="esc-buttons">
                  <a v-if="c.tier === 'emergency' || c.tier === 'distress'" class="call c911" href="#demo-911">Call 911</a>
                  <a class="call nurse" href="#demo-nurse">Call the nurse line</a>
                </div>
              </div>
              <!-- ADR-0017 (QST-LANG-FLOOR: A): not English, so help and an "English only" note. -->
              <div v-else-if="c.kind === 'language'" class="bubble esc urgent" role="alert">
                <p class="esc-title">{{ LANGUAGE_NOTE.title }}</p>
                <p>{{ LANGUAGE_NOTE.text }}</p>
                <div class="esc-buttons">
                  <a class="call c911" href="#demo-911">Call 911</a>
                  <a class="call nurse" href="#demo-nurse">Call the nurse line</a>
                </div>
              </div>
            </template>
            <div v-if="item.cards?.some((c) => (c.kind !== 'escalation' && c.kind !== 'language') || (c.kind === 'escalation' && c.tier === 'checkin'))" class="bubble bot">
            <template v-for="(c, j) in item.cards" :key="j">
              <div v-if="c.kind === 'passage'">
                <p v-if="c.why === 'dose'" class="dose-head">Talk to your care team before changing any dose.</p>
                <p class="verbatim">{{ c.passage.body }}</p>
                <span class="cite" :title="c.passage.doc_title">📄 {{ SOURCE[c.passage.source_label] }}</span>
                <p class="meta">Quoted word for word</p>
              </div>
              <div v-else-if="c.kind === 'dose_refusal'">
                <p>I can't give advice about insulin or medicine doses. Your care team can help with that. Call the nurse line if you need an answer today.</p>
                <!-- ADR-0022: an ambiguous dose question may only mean "what's on my plan?". -->
                <template v-if="c.offerPlan && regimen">
                  <p class="offer">Did you want to see the insulin on file?</p>
                  <button type="button" class="chip" :disabled="busy" @click="showPlanOnFile">Show my insulin on file</button>
                </template>
              </div>
              <!-- ADR-0020: the patient's plan, read back by code from the record. -->
              <div v-else-if="c.kind === 'plan'" class="plan-reply">
                <p><strong>{{ c.reply.heading }}</strong></p>
                <ul>
                  <li v-for="line in c.reply.lines" :key="line">{{ line }}</li>
                </ul>
                <p v-if="c.reply.footer" class="meta">{{ c.reply.footer }}</p>
              </div>
              <div v-else-if="c.kind === 'no_info'">
                <p>{{ NO_INFO_REPLY }}</p>
              </div>
              <!-- ADR-0018 iteration 5: one short question when the model needs a detail. -->
              <div v-else-if="c.kind === 'clarify'">
                <p>{{ c.text }}</p>
              </div>
              <!-- ADR-0023: another lane of the portal menu, named in the portal's own words. -->
              <div v-else-if="c.kind === 'admin'">
                <p>{{ ADMIN_CARD[c.lane].says }}</p>
                <p v-if="ADMIN_CARD[c.lane].menuItem">
                  {{ ADMIN_CARD[c.lane].use ?? 'Please use' }} <strong>{{ ADMIN_CARD[c.lane].menuItem }}</strong> in the portal's “{{ PORTAL_MENU }}” menu.
                </p>
              </div>
              <!-- ADR-0016: a fixed, approved reply to small talk. -->
              <div v-else-if="c.kind === 'social'">
                <p>{{ SOCIAL_REPLY[c.intent] }}</p>
              </div>
              <div v-else-if="c.kind === 'answer'">
                <p class="answer-text">{{ c.text }}</p>
                <span v-for="s in uniqueSources(c.sources)" :key="s.source_label" class="cite" :title="docTitles(c.sources, s.source_label)">📄 {{ SOURCE[s.source_label] }}</span>
                <p class="meta">From {{ c.sources.length }} approved passage{{ c.sources.length === 1 ? '' : 's' }}</p>
              </div>
              <!-- ADR-0013 (QST-KB-CARD-USE: A): the approved card, exactly as approved. -->
              <div v-else-if="c.kind === 'topic_card'">
                <p class="verbatim">{{ c.card.body }}</p>
                <span v-for="s in uniqueSources(c.sources)" :key="s.source_label" class="cite" :title="docTitles(c.sources, s.source_label)">📄 {{ SOURCE[s.source_label] }}</span>
                <p class="meta">Approved answer</p>
              </div>
            </template>
            <p v-if="item.cards?.some((c) => c.kind === 'escalation' && c.tier === 'checkin')" class="checkin">
              If this is happening to you now, <a href="#demo-nurse">call the nurse line</a>, or 911 if you feel very unwell.
            </p>
            </div>
          </template>
        </li>
      </ol>
      <p v-if="busy" role="status" class="thinking">Thinking…</p>
    </div>

    <div class="composer">
      <form class="ask" @submit.prevent="send">
        <label for="ask" class="sr">Your question</label>
        <div class="row">
          <textarea
            id="ask"
            v-model="draft"
            rows="1"
            :disabled="busy"
            @keydown.enter.exact.prevent="send"
          />
          <button class="primary" type="submit" :disabled="busy || !draft.trim()">Ask</button>
        </div>
      </form>
      <p v-if="saveProblem" class="note-text" role="status">{{ saveProblem }}</p>
      <!-- ADR-0014: a percentage of the tester's allowance, never dollars. -->
      <p v-if="allowance" class="key" role="status">{{ allowanceText(allowance) }}</p>
    </div>
  </section>
</template>

<style scoped>
/* fills the thread: messages scroll, the composer stays at the bottom */
.chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  background: var(--soft);
}
.items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.you {
  align-self: flex-end;
  max-width: 85%;
}
/* the mockup's bubbles */
.bubble {
  max-width: 42rem;
  margin: 0 0 0.6rem;
  padding: 0.75rem 1rem;
}
.bubble p {
  margin: 0 0 0.4rem;
}
.bubble p:last-child {
  margin-bottom: 0;
}
.me {
  margin: 0;
  border-radius: 14px 14px 4px 14px;
  background: var(--accent);
  color: var(--accent-text);
}
.bot {
  border-radius: 14px 14px 14px 4px;
  border: 1px solid var(--border);
  background: var(--panel);
}
.esc {
  border-radius: 14px 14px 14px 4px;
  border: 2px solid var(--danger);
  background: var(--panel);
}
.esc.emergency {
  background: var(--danger-bg);
}
.esc.checkin {
  border-style: dashed;
  border-color: var(--border);
}
.esc-title {
  font-weight: 700;
  font-size: 1.1rem;
}
.esc-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}
.call {
  display: inline-flex;
  align-items: center;
  min-height: 3rem;
  padding: 0 1.25rem;
  border-radius: 8px;
  font-weight: 700;
  text-decoration: none;
}
.c911 {
  background: var(--danger);
  color: #fff;
}
.nurse {
  border: 2px solid var(--accent);
  color: var(--accent);
  background: var(--panel);
}
.cite {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin: 0.4rem 0.4rem 0 0;
  padding: 0.15rem 0.7rem;
  border-radius: 999px;
  border: 1px solid #cfd8ee;
  background: #eef2fb;
  color: var(--accent);
  font-size: 0.8rem;
}
.meta {
  margin-top: 0.4rem !important;
  color: var(--muted);
  font-size: 0.75rem;
}
/* the check-in notice: one quiet line at the foot of the reply, not its own card */
.checkin {
  margin-top: 0.6rem !important;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.85rem;
}
.checkin:first-child {
  margin-top: 0 !important;
  padding-top: 0;
  border-top: 0;
}
.checkin a {
  color: var(--accent);
  font-weight: 600;
}
.verbatim {
  white-space: pre-line;
}
.dose-head {
  font-weight: 700;
}
.offer {
  margin: 0.75rem 0 0.4rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.25rem 0 0.75rem;
}
.chip {
  min-height: 2.75rem;
  padding: 0.3rem 0.9rem;
  border-radius: 999px;
  border: 1px solid #c9d3ea;
  background: var(--panel);
  color: var(--accent);
  cursor: pointer;
}
.note-text {
  color: var(--muted);
  font-style: italic;
  margin: 0;
}
.thinking {
  color: var(--muted);
}
/* the mockup composer, pinned at the bottom of the docked window */
.composer {
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 0.75rem 1.25rem 0.5rem;
}
.row {
  display: flex;
  gap: 0.6rem;
  align-items: stretch;
  padding-right: 0;
}
textarea,
input {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
}
.row textarea {
  flex: 1;
  resize: none;
}
button {
  min-height: 3rem;
  padding: 0 1.25rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}
.primary {
  min-width: 5.5rem;
  border: 0;
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 700;
}
.key {
  margin-top: 0.3rem;
  font-size: 0.8rem;
  color: var(--muted);
}
@media (max-width: 700px) {
  .msgs {
    padding: 0.75rem;
  }
  .composer {
    padding: 0.5rem 0.75rem;
  }
  .row {
    padding-right: 0;
  }
}
</style>
