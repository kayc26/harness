# SEED: Clickable answers

- **Date**: 2026-11-20
- **From**: Kay

---

## Brain Dump

Highlight/clickable terms in bot messages
reason: to hide complexity during user interaction, and allow them to check for definition if needed

---

**Model Response Request:**

- [ ] Chunk this into ADRs (I'm ready to formalize)
- [ ] Iterate with me (keep exploring)
- [x] Structure in place (organize but don't split)

---

## Thread

### Nibble (Claude Opus 5.5) - 2026-11-19

Organized as asked ("Structure in place"), not split into ADRs.

**The idea.** Medical terms in the bot's replies (for example *hyperglycemia*, *ketones*, *DKA*, *A1c*, *fast-acting carbohydrate*, *CGM*, *glucagon*, *mg/dL*) are marked, and tapping one shows a short definition. Kay's reason: hide complexity during the conversation, and let people check a definition when they want it.

**Why it fits now.** ADR-0021 (2026-11-19) removed the quoted definition from urgent replies because it was "too much information". Clickable terms bring definitions back on demand, without lengthening the reply. The two decisions point the same way: the reply carries the action, the definition waits for a tap.

**The constraint that shapes it.** In DIAlogue, every medical statement a patient sees comes from approved material: written answers are cited and guarded (ADR-0005), passages are quoted word for word, and the book is never the authority on numbers (ADR-0013). A definition is a medical statement too. So the main design question is where definitions come from:
1. **A short glossary written from approved passages and approved by the clinical sponsor**, like the topic cards (draft → approved, ADR-0013). Plain wording, but a new approval step.
2. **The approved ADA sentence that defines the term, quoted word for word**, for example ADA's own "Low blood glucose is when your blood glucose is too low—usually below 70 mg/dL". No new approval needed, but ADA wording is sometimes long, and some terms have no single defining sentence.
3. **A model writes the definition when tapped.** This would bypass the guard; I wouldn't do it.

**How it could work, from what exists today.**
- **Finding terms**: code matches a fixed term list against the written answer (no model), marking only the first occurrence, so a reply isn't full of highlights.
- **Where terms are marked**: written answers only at first. Alert boxes stay plain, so nothing slows down a safety message.
- **The popover**: a real button (keyboard and screen-reader friendly, with large tap targets for older adults). The reply must make sense without tapping anything.
- **Personal targets**: a definition with a number ("usually below 70") should say the patient's care team may set different targets. Mei, the pregnant demo patient, is the case where generic numbers would mislead.

**What it could teach us**: logging which terms get tapped (a field in `triage_events.detail`, like `topics`) would show which words testers actually need explained, and would feed back into how answers are worded.

**Open questions for when this is chunked**:
- Where do definitions come from (glossary option 1, or quoted ADA option 2)? This is the decision that matters most.
- Which terms go in the first version? A short list (about 10) taken from words that appear in real replies.
- Are terms marked only in written answers, or also in quoted passages?
- Should taps be logged for the study?

**Related**: ADR-0021 (definitions removed from urgent replies), ADR-0005 (answers cite approved sources), ADR-0013 (approval pipeline, the book's role), ADR-0004 (portal styling and safety banner).

---

**Model Response Request:**

- [ ] Chunk this into ADRs
- [ ] Iterate with me
- [ ] Structure in place

### Kay - [Date]

[Your response if continuing]

---

**Instructions for Model:** Copy everything from "Model Response Request" through the final `---` to the end of your response.

---

## Derived Into

*(This seed has not yet been chunked into ADRs)*

<!-- When this seed is processed, the AI should update this section with:
- ADR-NNNN: Brief title
- ADR-NNNN: Brief title

If anything in the seed remains unprocessed, make a note of what has not been processed yet at the end of this section.
-->
