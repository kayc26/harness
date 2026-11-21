<!-- adr template version: "adr 3.12.0" -->
<!--
adr teaching map: the example is not the teaching — these are the up-links from this file to what teaches its form; load them rather than winging it. (Sibling: the template-version marker dates the mold this file was minted from.)
  skill: adr-authoring
  mcp: adrs4ai
  plugin: adr@adrs4ai
-->

# ADR-0023: Admin intents — refills, appointments and billing go back to the portal menu

- **Date**: 2026-11-21
- **Iteration**: 2
- **Status**: Accepted
- **Deciders**: Kay, Claude Opus 5 (Cowork session)

**TL;DR**: DIAlogue owns one lane of the patient portal, "Contact Your Care Team"; a message that belongs to another lane (refill, appointment, billing) should get a fixed card naming that lane, written by code, instead of whatever retrieval happens to return.

---

## Originating Context

**Source**: Kay, 2026-11-21, testing the live site while reviewing `kb/out/eval-clinician.md`; her screenshot of MyPennMedicine's own "What would you like to do?" menu.

Kay's framing, verbatim: *"what about have a separate category for refill/appointment/other admin stuff"*, then, with the portal menu on screen: *"here are the 'admin' intents, the idea is that we only handle the 'contact your care team' questions, and if they put in the above three categories, we should point them to previous layer"*.

The menu she showed has four items: **Schedule an appointment** ("Request or schedule an appointment with a member of your care team from the Scheduling activity"), **Refill a medication** ("Request a refill for a prescription from your Medications list"), **Billing Assistance** ("Get help with billing questions. Please do not add clinically related attachments or photos"), and **Contact Your Care Team** ("Send a non-urgent message to a member of your Penn Medicine care team that doesn't require an immediate response").

What provoked it: one intent, four different answers. The clinician-session regression run (`kb/out/eval-clinician.md`, case 7, 2026-11-21) and Kay's own live testing the same day produced four outcomes for a refill request.

| Patient | Insulins on file | Message | Outcome |
|---|---|---|---|
| Helen, T2 | 1 | "I need a refill of my insulin." | clarifying question only, no referral (eval run) |
| Helen, T2 | 1 | "i need a refill of my insulin" | answer naming a pharmacist, 2 passages (live) |
| George, T1 | 0, pump | "i need an insulin refill" | "I don't have information on that", 1 passage (live) |
| George, T1 | 0, pump | "I need a refill of my insulin" | answer naming a pharmacist, 3 passages (live) |
| Dorothy, T2 | 2 | "I need a refill of my insulin" | the insulin regimen read back (live) |

**Agency Grant**: Structure the decision and lay out the open choices; Kay decides.

---

## Explicitation

**What I understand**:

1. **The assistant is one lane of four, and does not know it.** Nothing in the code represents the portal's other lanes. `src/lib/chat/topics.ts` defines ten *content* topics (`basics`, `low_blood_sugar`, `high_blood_sugar`, `monitoring`, `medicines_devices`, `food`, `sweeteners`, `activity`, `daily_life`, `support`). A refill request routes to `medicines_devices`, a shelf of ADA device and medication prose, and the answer is whatever the model writes from it. The pharmacist sentence patients have been seeing is retrieved ADA text that happens to mention a pharmacist, not a destination anyone chose.

2. **Navigation is the third routing decision, and the only one still left to a model.** Triage (ADR-0006) and the dose refusal (ADR-0005, rule 3) are fixed rules in front of the model, on the principle that safety must not depend on the model behaving. Navigation is decided inside the answer path, which is why it varies by phrasing.

3. **The plan read-back misfires on these messages.** `turn.ts` step 3-plan reads the regimen back whenever the classifier returns `plan_question` and `planBlocker` does not veto. `planBlocker` (`src/lib/chat/plan.ts`) vetoes on a reading, a symptom, a change word or an advice phrasing — all four are forms of *this is a decision for today*. "I need a refill of my insulin" is none of them, so nothing stops it. Dorothy's row above is that path firing.

4. **This gap is already on the record and has no home.** DHF 6.3, observation (f), 2026-11-10: *"'I need to refill my meds' was answered with 'Please contact your care team for help'. That is safe, but it does not name the right channel. The navigation answers need a referral list from the clinic."* Eleven days later the referral list still has nowhere to live.

5. **The categories are not ours to invent.** They are the host portal's menu, visible on screen, in Epic's own words. That changes the approval problem: naming a button the patient walked past is not a clinical referral.

6. **The terminal prototype already had this, and the rebuild dropped it.** `diabetes_chatbot/resources.py`, dated `2026-11-12.1-draft`, is a deterministic keyword table with six route groups — refills, supplies, appointments, classes, cost, who to call — each returning fixed text, with placeholders marked pending clinic confirmation. Its docstring names the requirement outright: *"The resource list behind DI-006: say when there is no approved answer and point to the right place… Target: at least 90% correct referral."* Kay's terminal screenshot from that build shows it working: "I need to refill my meds" returns *"I'm not sure about medication refills. Please contact your care team for help"*, and an appointment question returns *"I'm not able to schedule appointments. Please reach out to your care team to set one up."* DIAlogue has no equivalent module. Navigation fell back to retrieval in the rebuild, which is the direct cause of the five-answer spread. **So this ADR is not proposing a new capability. It is restoring one the project had on 12 November, with the host portal's menu supplying the category set the draft table was guessing at.**

**Assumptions**:

- DIAlogue is intended to replace the free-text box behind "Contact Your Care Team", not to sit beside the menu. Taylor Lee, 2026-11-18: *"right now you have the ask a non-urgent question, but that gives you a free text message box. Ideally we'll just swap that with this."*
- Approximately this menu exists in any Epic MyChart deployment, so the category set is configuration rather than HUP workflow compiled into the product.
- A deflection is not a clinical statement, so it does not need the knowledge base, a citation, or the guard.

**Confirm**: Kay, and the clinical sponsor for anything that points outside the portal.

---

## Questions

### QST-ADMIN-SET: What belongs to the admin category, and where does each intent point?
- Status: answered
- Why asking: This decides both the size of the first build and how much of it is blocked on a clinician. The portal menu supplies three destinations that need no clinical sign-off, because they name buttons the patient can see. Other intents the clinicians raised — pump failure, diabetes classes, supplies and test strips — have destinations *outside* the portal, which are clinic facts nobody has given us. Taylor Lee, 2026-11-18, on the pump: *"calling us isn't going to help. We can't make a pump work"*; the patient must call the manufacturer, who run tests and ship a replacement overnight, and the care team only for manual-injection cover meanwhile.
- Need: pick a letter (or override — any shape answers)

Options:
- **A — The menu, and only the menu**: three deflection cards, Schedule an appointment, Refill a medication, Billing Assistance, each naming the portal item in its exact label. Everything else keeps today's behaviour. Nothing needs clinical approval, because every destination is on screen already.
- **B — The menu plus out-of-portal referrals**: A, plus destinations the menu does not carry — pump failure to the manufacturer, classes to diabetes education, supplies to wherever the clinic sends them. Answers more of what the clinicians actually raised, but the extra destinations are unapproved clinic facts and would ship in the same unreviewed state as the knowledge base.
- **C — Refills only**: build the one intent that has been observed failing, in five variants, and widen when another is observed. Smallest change, and the category does not have to be right on the first guess.

**Recommendation**: (by Claude Opus 5, 2026-11-21)

**B — the menu plus out-of-portal referrals, built in two stages.** *Rationale*: A's three destinations are verifiable from the screenshot and need nobody's approval, so they can ship this week; B's extra destinations are the ones Taylor actually asked for twice, and leaving them out means the pump case stays broken after the work is done. Staging keeps the unapproved facts out of the build until the sponsor answers, in the same email that already owes us the intake field list (KANBAN, Waiting). C is too small: the four outcomes in the table above are a property of the architecture, not of the word "refill", so the next navigation intent will fail the same way. *Confidence*: 0.75 — because the menu half is directly evidenced and cheap, while the out-of-portal half depends on a clinician reply whose timing we do not control. *If wrong*: if the sponsor's reply shows the clinic routes refills somewhere other than the portal's own Refill item, A's premise is wrong and this flips to C, with each destination built only as a clinician names it.

*Iteration 2 note, not a walk-back*: `resources.py` strengthens B without changing the letter. Its six groups are close to the menu's three plus the out-of-portal cases this question already separates, and its keyword lists are a draft of the membership this question asks for. Re-read it before writing the table rather than starting from nothing. Its placeholders (`[CARE TEAM PHONE]`, a generic "MyChart") are the unapproved-destination problem in concrete form, and they are still unapproved a week later.

**ANS:** (by Kay)
b

---

### QST-ADMIN-ORDER: Where does the admin check sit in the turn?
- Status: answered
- Why asking: The order has safety consequences and cannot be read off the existing design. "I'm out of insulin" is an admin intent and may also be an emergency. "I need a refill of my insulin" names insulin, so it can trip `doseIntent` and collect the dose refusal, which is a wrong answer to a navigation question. And the plan read-back (ADR-0020) currently fires on these messages, which is the Dorothy row.
- Need: pick a letter (or override)

Options:
- **A — After triage, before the dose check**: emergency and urgent still win; admin then beats the dose refusal and the plan read-back. A refill question never gets a dose refusal, and `planBlocker` needs no new pattern because step 3-plan is never reached.
- **B — After triage and after the dose check**: the dose refusal keeps precedence, so "how much insulin should I refill" refuses rather than deflects. Safer against an admin pattern swallowing a dose question, at the cost of refusing some plain refill requests.
- **C — Before triage**: fastest path, no model call at all for a matched intent. Rejected on its face here, but stated so the space is complete: a message can carry an admin intent and a red flag at once, and triage must see it first.

**Recommendation**: (by Claude Opus 5, 2026-11-21)

**A — after triage, before the dose check.** *Rationale*: triage in front is non-negotiable and C breaks it, so the real choice is A against B. The dose refusal exists to stop the assistant saying how much to take; a deflection says nothing about amounts, so it does not need the refusal's protection, and B would answer "where do I get more insulin" with "I can't give advice about doses", which is the brick-wall failure Taylor described on colonoscopy. A also fixes the plan misfire for free, which B does not: under B, step 3-plan still sits downstream and Dorothy's read-back still happens. *Confidence*: 0.8 — because the ordering argument is structural and checkable in `turn.ts`, but it rests on admin patterns being tight enough not to capture dose questions, which is untested. *If wrong*: if a test shows an admin pattern capturing a message a clinician reads as a dose question, this flips to B and the dose check regains precedence.

**ANS:** (by Kay)
a

---

### QST-ADMIN-GATE: What decides that a message is an admin intent?
- Status: answered
- Why asking: The four-outcome table is what a model deciding alone looks like, and `models.classify` never sees the patient, so patient identity cannot explain the spread. But fixed patterns alone will miss phrasings that older testers actually type, which is the risk Katie McGovern named in the 11/18 session: test it against spelling and grammar mistakes.
- Need: pick a letter (or override)

Options:
- **A — Fixed rules only**: a pattern table, intent to destination, no model. Deterministic, testable at 100% on matched patterns, and consistent with triage rule 1 and the dose refusal. Misses anything the table does not anticipate.
- **B — Classifier only**: a new `admin_intent` field on the classifier's JSON. Catches paraphrase and typos. Reintroduces exactly the variance in the table above.
- **C — Rules first, classifier as widener**: patterns decide when they match; the classifier can raise a message into admin when they do not; it can never clear a pattern hit. The same OR-combine shape `combine.ts` already uses for tiers, where the higher tier wins.

**Recommendation**: (by Claude Opus 5, 2026-11-21)

**C — rules first, classifier as widener.** *Rationale*: this project has already run the experiment. `combine.ts` combines fixed triage rules with the model classifier so the classifier cannot clear a rules hit, and that layering is what makes DI-001 testable; the admin category has the same shape, a deterministic core with a fuzzy edge. A alone fails Katie's typo point; B alone is the status quo that produced four answers to one question. *Confidence*: 0.85 — because the pattern is proven in this codebase and the failure mode of each pure option is already observed. *If wrong*: if the classifier's `admin_intent` raises messages the rules deliberately excluded, for instance a clinical question that merely mentions a prescription, this flips to A and the widener is dropped.

**ANS:** (by Kay)
c

---

### QST-ADMIN-MOCK: Does the demo portal need the four-item menu before 12/3?
- Status: answered
- Why asking: The mock has no such menu. `src/app/HomeScreen.vue` has the Message Center, a read-only search stub and the "Coming next" panel, and nothing resembling "What would you like to do?". If a deflection card says "use Refill a medication", there is nothing on screen in the live class demo for anyone to look at, and the scope claim stays an assertion rather than something visible.
- Need: pick a letter (or override)

Options:
- **A — Stub all four items**: three reuse the existing "not part of the demo" treatment, the fourth opens the assistant. Makes the scope claim visible and gives every deflection somewhere to point.
- **B — Stub only the items a deflection names**: smaller, but a partial menu misrepresents the portal and invites the question of what else is missing.
- **C — Leave the mock alone**: deflections name the labels in text and the demo relies on the audience knowing MyPennMedicine. No UI work; the live demo cannot show the deflection landing.

**Recommendation**: (by Claude Opus 5, 2026-11-21)

**A — stub all four.** *Rationale*: the deflection is unobservable without it, and the class demo is the main evidence event before 12/3; the "not part of the demo" treatment already exists in `HomeScreen.vue`, so three of the four items are near-free. It also does double duty on the slides, turning "we own one lane of four" from a claim into a screenshot. *Confidence*: 0.8 — because the cost is small and the benefit is concentrated in the one demo that matters, though it competes for the same days as the intake work. *If wrong*: if the 12/3 demo will be driven entirely from the assistant window without the portal home on screen, the menu buys nothing then and this flips to C, deferred until a moderated session uses the portal.

**ANS:** (by Kay)
a

---

## Supporting Materials

### FIL: where this lives in the code
- `src/lib/chat/turn.ts` — step 3-plan at ~line 322, the dose check at ~line 332; the admin check would sit between triage and the dose check under QST-ADMIN-ORDER option A
- `src/lib/chat/plan.ts` — `planBlocker`, the four vetoes (`reading`, `symptom`, `change`, `advice`), none of which matches a refill request
- `src/lib/chat/topics.ts` — the ten content topics; `medicines_devices` is where refills currently land
- `src/lib/chat/combine.ts` — the rules-plus-classifier OR-combine that QST-ADMIN-GATE option C would copy
- `src/app/HomeScreen.vue` — the portal mock, and the "not part of the demo" treatment a menu stub would reuse
- `kb/out/eval-clinician.md` — case 7, the run that started this

### DOC: the requirement this implements
UN-006 / DI-006 (DHF-002-UNS / DHF-006-DRS Rev 1.2): *"When no approved answer exists, the device must say so and point to the right resource (care team, hotline, MyChart, classes or supplies). Target: at least 90% correct referral."* Validation Story C is already an admin test in all but name: James needs test strips, asks about a diabetes class, and asks an unrelated question about parking.

---

## Decision

### Context

The assistant answers navigation questions out of a knowledge base that contains no destinations. Which answer a patient gets depends on how they phrase the question, and one phrasing returns the patient's insulin regimen instead. Meanwhile the portal the assistant is designed to live inside already sorts these requests into four lanes on its own front screen.

### Options

**Option A**: Patch `planBlocker` with a refill pattern
- Pros: one line, fixes the Dorothy row today
- Cons: treats the symptom; leaves the four-outcome spread untouched, since the answer path is still what handles refills

**Option B**: An admin intent category mirroring the portal's menu
- Pros: removes the model from navigation entirely; gives DI-006 a mechanism; fixes the plan misfire as a side effect; gives the project a one-line scope statement
- Cons: a new step in the turn; a boundary that will misroute at the edges; out-of-portal destinations still need a clinician

### Chosen: Option B, staged

**Rationale**: The variance is architectural, not lexical. Navigation is the third routing decision in the turn and the only one still delegated to a model, and every other routing decision in this project was moved in front of the model precisely because model behaviour is not a safety property. Mirroring the host portal's own menu makes the category set externally given rather than invented, which is what makes it cheap to approve and plausible to generalise beyond HUP.

**Trade-offs accepted**: A fixed destination table encodes one deployment's workflow; it should be configuration, not code, even when the first configuration is HUP's. The boundary will misroute at the edges — "can I join a class" is admin, "what should my fasting target be" is clinical, "my pump is broken" is both admin and urgent — and the pump case is the reason triage stays in front.

### Consequences

- DIAlogue gains a scope sentence it does not currently have: it owns the Contact Your Care Team lane and only that lane. This belongs in DHF 4.1's in-scope and out-of-scope lists.
- Taylor Lee's 11/18 concern gets a mechanism. Her worry was that a patient believes they have messaged their provider; that is what happens when lane one answers a lane-two question in a friendly voice. A deflection card is the assistant saying which lane it is.
- Deflections cost no model call, so matched intents get faster and cheaper under the $1 per-tester cap (ADR-0014).
- DI-006 becomes verifiable as a rules pass plus a measured recall, rather than a judgement about whether a model named the right resource. The ≥90% target was written for the fallback path and may need restating.

---

## Open Follow-ups

### QST-ADMIN-VALIDATE: Is the "validate the concern, then point" card the same mechanism as a deflection?
- Status: answered
- Why deferring: It does not block the admin category, but the two may be one feature. Taylor Lee asked for the same shape twice on 2026-11-18. On colonoscopy: *"is there a way of validating what they're asking and saying, yes, there does need to be changes based on colonoscopy prep, I can't give you that information, but please call."* On the pump: call the manufacturer, then us. Both are a card that affirms the concern is real and names where to take it. If they are one mechanism, the colonoscopy gap and the admin category are one build.

**ANS:** (by Kay)
yes

---

- [x] ~~Latent bug: step 3-plan guards only on `!input.regimen`, not on `hasPlanOnFile`, so George would be shown `NO_INSULIN_LINE`.~~ **Not a bug** (Nibble, iteration 2): `regimenLines` reads George's pump settings back ("Insulin pump background rate: about 0.7 units per hour."), so `hasPlanOnFile` is already true for him, and `fixtures.test.ts` requires every demo regimen to have insulin or a pump. The guard difference matters only for an empty stored regimen, where "No insulin is on file" is a true read-back. No fix, no regression test (Fourth Directive: it would test a case that cannot occur).
- [ ] Concern: the destination table is clinic-specific and cuts against the market section's claim that the same product serves 401,000 sites. Keep it as data, not code.
- [ ] Unverified assumption: that approximately this four-item menu is standard across Epic MyChart deployments. Asserted from one screenshot of one deployment.

---

## Action Items

- [x] Decide QST-ADMIN-SET, ORDER, GATE and MOCK - Owner: Kay
- [ ] Add the out-of-portal destinations to the clinical sponsor email already in KANBAN Waiting: diabetes class routing, supplies (the pump is generic since iteration 2, so it no longer waits) - Owner: Kay
- [x] Add admin cases to `kb/clinician-cases.txt`: both refill phrasings on a type 1 and a type 2 patient, plus appointment and billing (classes and supplies wait for stage two) - Owner: Nibble
- [x] ~~Fix the `hasPlanOnFile` guard in step 3-plan~~: not a bug, see Open Follow-ups
- [ ] Run `npm run kb:eval-clinician -- --yes` (about $0.05, live models) to check the classifier widener and the new cases end to end - Owner: Kay's go-ahead (budget)
- [ ] Tell Taylor Lee the refill answer she approved on 11/18 is now the refill card - Owner: Kay

---

## Validation

- [ ] Kay: the scope statement, that DIAlogue owns the Contact Your Care Team lane only, is what she meant
- [ ] Kay: the four-outcome table matches what she saw on 2026-11-21
- [ ] Clinical sponsor or Taylor Lee: the out-of-portal destinations are correct before any of them ships

**Notes**: Status stays Draft until QST-ADMIN-SET, ORDER and GATE are answered. The menu labels are transcribed from one screenshot of MyPennMedicine taken 2026-11-21 and should be checked against the live portal before any card quotes them, since a patient scanning for a button matches on the exact words.

---

## Iterations

### Iteration 1 (2026-11-21)
- Trigger: `kb/out/eval-clinician.md` case 7 and Kay's live testing the same day produced four outcomes for one refill intent; Kay proposed an admin category and then sharpened it with the portal's own menu.
- Contributors: Kay, Claude Opus 5 (Cowork session)
- Changes: initial draft; four open questions; decision recorded as Option B, staged.
- Outcome: Draft

### Iteration 2 (2026-11-21)
- Trigger: Kay, asked whether to wait for Taylor Lee's reply before building: *"Then for the pump just say please contact pump manufactorer without specific numbers or anything"*.
- Contributors: Kay, Nibble (Claude Opus 5.5)
- Changes:
  - **Build now, not after Taylor replies.** The three menu lanes need nobody's approval (QST-ADMIN-SET, B, stage one).
  - **The pump joins stage one** with a generic card: "please contact your pump manufacturer", no company names, phone numbers or steps. It names no clinic fact, so it does not wait on the sponsor either.
  - **Classes and supplies still wait** on Taylor or the clinical sponsor; they keep today's behaviour until then.
  - The "then us" half of Taylor's pump advice (call the care team for injection cover) is already carried by triage: `PUMP_FAILURE` in `triage.ts` raises the turn to urgent, which shows the nurse line above the reply. The pump card sits under that alert, it does not replace it.
  - Status Draft → Accepted: SET, ORDER and GATE are answered, per the Validation note.
- Built (same day): `src/lib/chat/admin.ts` (lanes, card text, rules), the classifier's `admin` field (`combine.ts`, `prompts.ts`), step 2c in `turn.ts`, the card in `ChatPanel.vue` (also on the rules-only path), the four-item menu in `HomeScreen.vue`, `admin` in the turn log (`persist.ts`). `PUMP_FAILURE` in `triage.ts` learned "won't turn on", "dead", "died", "cracked": Taylor's own message returned tier none from the fixed rules, so the nurse line hung on the classifier (regression test in `triage.test.ts`).
- Doubts raised while building, not yet decided:
  - "I ran out of insulin" gets the refill card and nothing else. Triage has no rule for running out, and for a type 1 patient that is close to the pump case (no insulin going in). Whether it is a red flag is a clinical call.
  - The fourth menu item now reads "Contact Your Care Team" with "Ask the diabetes assistant a non-urgent question" under it. Taylor's 11/18 worry was a patient believing they had messaged their provider; the portal's own label invites that belief, hence the sub-line.
  - Consequences says deflections cost no model call. They skip the answer model and the monitor, but the classifier still runs, because triage needs it first.
  - The three menu cards' wording is Claude's draft; only the pump wording is Kay's.
- Outcome: Accepted; stage one built, gate green (391 tests).

---

## Glossary

- **Admin intent**: a message whose correct destination is a lane of the host patient portal other than the one the assistant occupies, or a service outside the portal entirely. Distinguished from a clinical question, which the assistant answers, and from a dose question, which it refuses.
- **Deflection card**: fixed text, written by code and never by a model, naming the portal item the patient should use, in the portal's own label.
- **Lane**: one item on the portal's "What would you like to do?" menu. DIAlogue occupies Contact Your Care Team.

---

## Links

- Related ADRs: [ADR-0005](0005-diabetes-education-bot-architecture-and-answer-path.md) (the answer path and the three dose rules), [ADR-0006](0006-diabetes-education-bot-urgent-situation-triage-and-escalation.md) (triage in front of the model), [ADR-0018](0018-retrieval-whole-curated-topic-sections-chosen-by-the-classifier.md) (the topic map), [ADR-0020](0020-the-bot-reads-the-patients-plan-back-in-chat.md) (the plan read-back this misfires into), [ADR-0022](0022-ambiguous-dose-questions-offer-the-insulin-on-file-after-the-refusal.md) (the refusal's plan offer), [ADR-0010](0010-diabetes-education-bot-how-test-users-reach-it.md) (how testers reach the portal)
- Related code: `src/lib/chat/turn.ts`, `src/lib/chat/plan.ts`, `src/lib/chat/topics.ts`, `src/lib/chat/combine.ts`, `src/app/HomeScreen.vue`
- Related data: `kb/clinician-cases.txt`, `kb/out/eval-clinician.md`
