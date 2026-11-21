// Run test questions through the real assistant and put each answer beside a reference
// answer (ADR-0013, iterations 10 and 21). Written for the care-team FAQ while it was
// held out of the knowledge base. Since iteration 21 the FAQ is back in the knowledge
// base (Kay: "we will have other testing questions"), so FAQ questions now mostly find
// their own answers; give other questions with --questions=<file>, in the same format
// ("# Question" lines, each followed by its reference answer, which may be empty).
//
//   npm run kb:eval-faq -- [cards file] [--questions=file] [--cards] [--type=type1|type2] [--hide-dose] [--dose-rules] [--yes]
//   (reads OPENROUTER_API_KEY from git-ignored .env.local, like the other kb: scripts;
//    jiti runs the app's own TypeScript modules unchanged; default cards file:
//    kb/out/cards-blind.json)
//
// Each FAQ question goes through the real turn (src/lib/chat/turn.ts) with the real
// models (src/lib/chat/models.ts): triage, the card step (the blind cards are treated
// as approved for this test only; nothing is loaded anywhere), then the AI-written
// answer from the ADA guides and the book, then the guard. What the patient would see
// is written beside the FAQ answer in kb/out/eval-faq.md, with separate blanks for
// the four checks Kay listed: numbers right, citations right, declined when it should,
// agrees with the FAQ.
//
// Costs real OpenRouter credit (ADR-0012, $15 total): dry run unless --yes, and it
// stops if the run passes MAX_DOLLARS. Prints the key's presence, never the key.

import { readFileSync, writeFileSync } from 'node:fs'
import { buildCardIndex, type TopicCard } from '../src/lib/chat/cards'
import { openRouterModels, type CostMeter } from '../src/lib/chat/models'
import { buildIndex, type DiabetesType, type KbPassage } from '../src/lib/chat/retrieve'
import { CARDS_PAUSED } from '../src/lib/chat/prompts'
import { runTurn, type Card } from '../src/lib/chat/turn'
import { NO_INFO_REPLY, SOCIAL_REPLY } from '../src/lib/chat/social'
import { ADMIN_CARD } from '../src/lib/chat/admin'
import { doseAdviceIn } from '../src/lib/chat/guard'
import type { DraftCard } from './cards-lib'

const MAX_DOLLARS = 0.25
const args = process.argv.slice(2)
// Cards follow the app's switch (CARDS_PAUSED, the RAG-only trial) unless --cards is given.
const useCards = args.includes('--cards') || !CARDS_PAUSED
// --type=type1|type2: answer as a patient with that diabetes type (QST-KB-RAG-FIXES: B).
const diabetesType = args.find((a) => a.startsWith('--type='))?.slice(7) as DiabetesType | undefined
// Kay, 2026-11-16: in test runs the model may read dose-tagged passages (rule 1 off);
// the guard's dose-advice block and the dose refusal card stay. --hide-dose restores it.
const hideDosePassages = args.includes('--hide-dose')
// Kay, 2026-11-16: "pause 2 and 3 for now on test": the dose-advice block (rule 2) and
// the dose refusal card (rule 3) are off in test runs; --dose-rules turns them back on.
// Each answer is still marked when a paused rule would have stopped it.
const enforceDoseRules = args.includes('--dose-rules')
const cardsFile = args.find((a) => !a.startsWith('--')) ?? 'kb/out/cards-blind.json'
const key = process.env.OPENROUTER_API_KEY ?? ''

type Built = { id: string; docTitle: string; sourceLabel: KbPassage['source_label']; section: string | null; body: string; tags: string[]; diabetesType: KbPassage['diabetes_type'] }
// Regression (2026-11-16): diabetes_type was left out here, so --type had no effect in
// the second to fourth runs; the type ranking was never exercised by them.
const passages: KbPassage[] = (JSON.parse(readFileSync('kb/out/passages.json', 'utf8')) as { passages: Built[] }).passages.map((p) => ({
  id: p.id, doc_title: p.docTitle, source_label: p.sourceLabel, section: p.section, body: p.body, tags: p.tags, diabetes_type: p.diabetesType,
}))
const questionsFile = args.find((a) => a.startsWith('--questions='))?.slice(12) ?? 'kb/local-sources/FAQs.md'
if (questionsFile.endsWith('FAQs.md') && passages.some((p) => p.source_label === 'care_team')) {
  console.log('note: these are the FAQ\'s own questions and the FAQ is in the knowledge base, so they mostly find their own answers')
}
const drafts = (JSON.parse(readFileSync(cardsFile, 'utf8')) as { cards: DraftCard[] }).cards
const cards: TopicCard[] = drafts.map((d) => ({ id: d.id, topic: d.topic, asks: d.asks, body: d.answer, source_ids: d.sources, status: 'approved' }))
const faq = readFileSync(questionsFile, 'utf8')
  .split(/^# /m)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [q, ...rest] = s.split('\n')
    return { q: q.trim(), a: rest.join('\n').trim() }
  })

console.log(`questions: ${faq.length} from ${questionsFile} · passages: ${passages.length} · cards: ${useCards ? `${cards.length} from ${cardsFile}` : "off (CARDS_PAUSED; --cards to include)"} · patient type: ${diabetesType ?? "none"} · rule 1 (dose passages hidden): ${hideDosePassages ? "on" : "paused"} · rules 2–3 (dose advice block, dose refusal): ${enforceDoseRules ? "on" : "paused"}`)
console.log(`OpenRouter key: ${key ? 'set' : 'NOT SET (OPENROUTER_API_KEY)'} · stop above $${MAX_DOLLARS}`)
if (!args.includes('--yes') || !key) {
  console.log('\nDry run: no model calls. Estimated cost about $0.05 (about 3 calls per question). Re-run with --yes.')
  process.exit(0)
}

const index = buildIndex(passages)
const cardIndex = buildCardIndex(cards, passages)
const meter: CostMeter = { dollars: 0, calls: 0 }
const shown = (c: Card): string => {
  switch (c.kind) {
    case 'topic_card': return `**[approved card \`${c.card.id}\`, shown as written]** ${c.card.body}`
    case 'answer': return `**[AI-written answer; sources: ${c.sources.map((s) => `\`${s.id}\` (${s.source_label})`).join(', ')}]** ${c.text}`
    case 'passage': return `**[passage \`${c.passage.id}\` shown word for word (${c.why})]** ${c.passage.body}`
    case 'escalation': return `**[help shown: ${c.tier}]**`
    case 'dose_refusal': return "**[dose refusal]** I can't give advice about insulin or medicine doses. Your care team can help with that."
    case 'no_info': return `**[no information]** ${NO_INFO_REPLY}`
    case 'clarify': return `**[clarifying question]** ${c.text}`
    case 'language': return `**[not English (${c.lang}): help shown]**`
    case 'admin': return `**[portal task: fixed ${c.lane} card]** ${ADMIN_CARD[c.lane].says}`
    case 'social': return `**[small talk: fixed ${c.intent} reply]** ${SOCIAL_REPLY[c.intent]}`
    case 'plan': return `**[plan read back by code (${c.reply.mode})]** ${c.reply.heading} ${c.reply.lines.join(' ')}`
  }
}

const md: string[] = [
  `# Can the assistant answer the FAQ without the FAQ? (${new Date().toISOString().slice(0, 10)})`,
  '',
  `Cards: \`${cardsFile}\` (treated as approved for this test only). Passages: the ADA guides and the book; the FAQ held out. Models: as in \`src/lib/chat/prompts.ts\`.`,
  '',
]
const summary: string[] = []
for (const [i, f] of faq.entries()) {
  if (meter.dollars > MAX_DOLLARS) {
    console.log(`stopping: $${meter.dollars.toFixed(4)} spent, over $${MAX_DOLLARS}`)
    break
  }
  meter.notes = []
  const o = await runTurn({
    message: f.q, history: [], profile: { history_of_dka: false, pregnant: false, uses_pump: false },
    index, passages, cards: cardIndex, cardsEnabled: useCards, diabetesType, hideDosePassages, enforceDoseRules, doseSession: false, models: openRouterModels(key, meter),
  })
  const kinds = o.cards.map((c) => c.kind).join('+')
  // What the paused dose rules would have done (always shown, so pausing them never hides it).
  const wouldStop = [
    ...(o.triage.doseIntent ? ['rule 3 would have refused (dose question)'] : []),
    ...o.cards.flatMap((c) => (c.kind === 'answer' && doseAdviceIn(c.text) ? [`rule 2 would have blocked (${doseAdviceIn(c.text)})`] : [])),
  ]
  const line = `${String(i + 1).padStart(2)}. ${kinds.padEnd(24)} card:${o.card?.how ?? '-'}${o.card?.id ? `(${o.card.id})` : ''}${o.guard ? ` guard:${o.guard}` : ''}${wouldStop.length ? ` ⚠ ${wouldStop.join('; ')}` : ''}  ${f.q.slice(0, 55)}`
  console.log(line)
  summary.push(line)
  md.push(
    `## ${i + 1}. ${f.q}`,
    '',
    `**Reference answer**: ${f.a || "(none given)"}`,
    '',
    `**Assistant** (tier ${o.tier}; material: ${o.retrieval ?? '-'}${o.topics?.length ? ` (${o.topics.join(', ')})` : ''}; card step: ${o.card ? `${o.card.how}${o.card.id ? ` \`${o.card.id}\`` : ''}, shortlist ${o.card.shortlist.join(', ') || 'none'}` : 'not run'}${o.guard ? `; guard blocked: ${o.guard}` : ''}):`,
    '',
    ...o.cards.map(shown),
    '',
    ...(wouldStop.length ? [`⚠ **Paused dose rule would have stopped this**: ${wouldStop.join('; ')}`, ''] : []),
    ...(o.blockedDraft
      ? [o.guard?.startsWith('trimmed_book_number') ? `*Original draft (a sentence with a book-only number was trimmed)*: ${o.blockedDraft}` : `*Blocked draft (never shown)*: ${o.blockedDraft}`, '']
      : []),
    '**Score**: numbers right ☐ · citations right ☐ · declined when it should ☐ · agrees with the FAQ ☐ · notes:',
    '',
  )
}
md.push('## Run summary', '', '```', ...summary, '```', '', `Model calls: ${meter.calls} · cost: $${meter.dollars.toFixed(4)}`)
writeFileSync('kb/out/eval-faq.md', md.join('\n'))
console.log(`\nmodel calls ${meter.calls} · cost $${meter.dollars.toFixed(4)} · wrote kb/out/eval-faq.md`)
