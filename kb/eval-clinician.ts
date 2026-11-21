// Clinician-session regression test. Every case in kb/clinician-cases.txt was typed, or
// directly described, by Dr. Jorge Jo Kamimoto (2026-11-12) or Taylor Lee (2026-11-18)
// in a feedback session. This re-runs them against the current build.
//
// Why it exists: Taylor's session ran on the 2026-11-18 build, before ADR-0020, ADR-0021
// and ADR-0022. ADR-0021 changed what every urgent turn shows, so the cases she approved
// are now answered by code she has not seen. A clinician-witnessed baseline is worth more
// than a synthetic bank, but only if we check it still holds.
//
//   npm run kb:eval-clinician -- [--yes]   (dry run without --yes)
//
// Unlike eval-faq, the three dose rules are left ON, so this is the production answer
// path. Each case runs through the real turn (src/lib/chat/turn.ts) with the real models,
// as the patient named on its line: patients/fixtures/ supplies the diabetes type, the
// profile flags and the regimen, so the plan read-back (ADR-0020) and the insulin-on-file
// offer (ADR-0022) can fire. Cards follow CARDS_PAUSED and are off.
//
// Costs real OpenRouter credit (ADR-0012): dry run unless --yes, stops above MAX_DOLLARS.
// Writes kb/out/eval-clinician.md. Pass or fail is a reader's call, not a string match:
// "does the reply validate the concern" is not something this script can score. The
// automatic checks below are only the objective ones.
import { readFileSync, writeFileSync } from 'node:fs'
import { openRouterModels, type CostMeter } from '../src/lib/chat/models'
import { buildIndex, type DiabetesType, type KbPassage } from '../src/lib/chat/retrieve'
import { NO_INFO_REPLY, SOCIAL_REPLY } from '../src/lib/chat/social'
import { ADMIN_CARD } from '../src/lib/chat/admin'
import type { Profile } from '../src/lib/chat/triage'
import { runTurn, type Card } from '../src/lib/chat/turn'
import type { Regimen } from '../src/lib/patients/readback'

const MAX_DOLLARS = 0.15
const args = process.argv.slice(2)
const key = process.env.OPENROUTER_API_KEY ?? ''

type Group = 'fixed' | 'held' | 'open'
interface Case { group: Group; patientId: string; question: string; note: string }

const cases: Case[] = readFileSync('kb/clinician-cases.txt', 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [group, patientId, question, ...note] = l.split('|')
    return { group: group.trim() as Group, patientId: patientId.trim(), question: question.trim(), note: note.join('|').trim() }
  })

interface Fixture { id: string; display_name: string; diabetes_type: DiabetesType; flags: Profile; regimen: Regimen }
const fixture = (id: string): Fixture => JSON.parse(readFileSync(`patients/fixtures/${id}.json`, 'utf8')) as Fixture

type Built = { id: string; docTitle: string; sourceLabel: KbPassage['source_label']; section: string | null; body: string; tags: string[]; diabetesType: KbPassage['diabetes_type'] }
const passages: KbPassage[] = (JSON.parse(readFileSync('kb/out/passages.json', 'utf8')) as { passages: Built[] }).passages.map((p) => ({
  id: p.id, doc_title: p.docTitle, source_label: p.sourceLabel, section: p.section, body: p.body, tags: p.tags, diabetes_type: p.diabetesType,
}))

const byGroup = (g: Group) => cases.filter((c) => c.group === g).length
console.log(`${cases.length} cases (fixed ${byGroup('fixed')}, held ${byGroup('held')}, open ${byGroup('open')}) · passages ${passages.length} · dose rules 1-3 ON`)
console.log(`OpenRouter key: ${key ? 'set' : 'NOT SET (OPENROUTER_API_KEY)'} · stop above $${MAX_DOLLARS}`)
if (!args.includes('--yes') || !key) {
  console.log('\nDry run: no model calls. Estimated cost about $0.03 (about 3 calls per case). Re-run with --yes.')
  process.exit(0)
}

const shown = (c: Card): string => {
  switch (c.kind) {
    case 'escalation': return `**[help shown: ${c.tier}; ${c.criteria.join(', ') || 'no named criterion'}]**`
    case 'passage': return `**[passage \`${c.passage.id}\` word for word (${c.why}), from ${c.passage.doc_title}]** ${c.passage.body}`
    case 'dose_refusal': return `**[dose refusal${c.offerPlan ? ', offering the insulin on file' : ''}]** I can't give advice about insulin or medicine doses. Your care team can help with that.`
    case 'plan': return `**[plan read back by code (${c.reply.mode})]** ${c.reply.heading} ${c.reply.lines.join(' ')}`
    case 'no_info': return `**[no information]** ${NO_INFO_REPLY}`
    case 'social': return `**[small talk: fixed ${c.intent} reply]** ${SOCIAL_REPLY[c.intent]}`
    case 'clarify': return `**[clarifying question]** ${c.text}`
    case 'language': return `**[not English (${c.lang}): help shown]**`
    case 'admin': return `**[portal task: fixed ${c.lane} card]** ${ADMIN_CARD[c.lane].says}${ADMIN_CARD[c.lane].menuItem ? ` Please use ${ADMIN_CARD[c.lane].menuItem} in the portal menu.` : ''}`
    case 'answer': return `**[AI-written answer; sources: ${c.sources.map((s) => `\`${s.id}\` (${s.source_label})`).join(', ') || 'none'}]** ${c.text}`
    case 'topic_card': return `**[approved card \`${c.card.id}\`, word for word]** ${c.card.body}`
  }
}

const index = buildIndex(passages)
const meter: CostMeter = { dollars: 0, calls: 0 }
const md: string[] = [
  `# Clinician-session regression test (${new Date().toISOString().slice(0, 10)})`,
  '',
  'Every case was typed, or directly described, by a clinician in the sessions of 2026-11-12 (Dr. Jorge Jo Kamimoto) and 2026-11-18 (Taylor Lee). Production answer path: dose rules 1 to 3 on, cards off.',
  '',
]
const summary: string[] = []
for (const [i, c] of cases.entries()) {
  if (meter.dollars > MAX_DOLLARS) {
    console.log(`stopping: $${meter.dollars.toFixed(4)} spent, over $${MAX_DOLLARS}`)
    break
  }
  const f = fixture(c.patientId)
  const o = await runTurn({
    message: c.question, history: [], profile: f.flags, index, passages,
    cardsEnabled: false, diabetesType: f.diabetes_type, regimen: f.regimen,
    doseSession: false, models: openRouterModels(key, meter),
  })
  const kinds = o.cards.map((k) => k.kind)
  const text = o.cards.map(shown).join('\n\n')
  // Only the objective checks. Whether a refusal validates the patient's concern, or
  // whether an answer leads with the action, is a reader's judgement.
  const checks = [
    kinds.includes('escalation') ? 'escalated' : 'not escalated',
    kinds.includes('dose_refusal') ? (o.cards.some((k) => k.kind === 'dose_refusal' && k.offerPlan) ? 'dose refusal + plan offer' : 'dose refusal') : null,
    kinds.includes('plan') ? 'plan read back' : null,
    kinds.includes('no_info') ? 'no information' : null,
    /low blood (sugar|glucose)/i.test(text) ? '⚠ mentions low blood sugar' : null,
    /manufactur/i.test(text) ? 'names the manufacturer' : null,
    o.guard ? `guard blocked: ${o.guard}` : null,
  ].filter(Boolean)
  const line = `${String(i + 1).padStart(2)}. ${c.group.padEnd(5)} ${o.tier.padEnd(9)} ${kinds.join('+').padEnd(22)} ${c.question.slice(0, 48)}`
  console.log(line)
  summary.push(line)
  md.push(
    `## ${i + 1}. [${c.group}] ${c.question}`,
    '',
    `**Patient**: ${f.display_name} (${f.diabetes_type}${f.flags.pregnant ? ', pregnant' : ''}${f.flags.uses_pump ? ', pump' : ''}${f.flags.history_of_dka ? ', DKA history' : ''})`,
    '',
    `**What the clinician said**: ${c.note}`,
    '',
    `**Tier** ${o.tier} · material: ${o.retrieval ?? '-'}${o.topics?.length ? ` (${o.topics.join(', ')})` : ''} · checks: ${checks.join(' · ')}`,
    '',
    text,
    '',
    ...(o.blockedDraft ? [`*Blocked draft (never shown)*: ${o.blockedDraft}`, ''] : []),
    '**Verdict**: holds ☐ · regressed ☐ · still open ☐ · notes:',
    '',
  )
}
md.push('## Run summary', '', '```', ...summary, '```', '', `Model calls: ${meter.calls} · cost: $${meter.dollars.toFixed(4)}`)
writeFileSync('kb/out/eval-clinician.md', md.join('\n'))
console.log(`\nmodel calls ${meter.calls} · cost $${meter.dollars.toFixed(4)} · wrote kb/out/eval-clinician.md`)
