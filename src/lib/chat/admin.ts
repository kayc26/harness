// Admin intents go back to the portal menu (ADR-0023).
//
// DIAlogue is one lane of the portal's "What would you like to do?" menu: Contact Your
// Care Team. A message that belongs to another lane (book an appointment, refill a
// prescription, a bill) gets a fixed card naming that lane in the portal's own words,
// written here and never by a model. Before this, those messages went to retrieval,
// and one refill request got four different answers depending on phrasing (ADR-0023's
// table), one of them the patient's insulin regimen read back.
//
// The pump card (iteration 2, Kay 2026-11-21) points outside the portal, but names no
// company, number or step: "please contact your pump manufacturer". A broken pump is
// also a red flag, so triage (triage.ts, PUMP_FAILURE) shows the nurse line above it.
//
// QST-ADMIN-GATE: C. These rules decide when they match; the classifier's `admin` field
// can raise a message they missed into a lane, and can never clear a rules hit
// (adminLane below). QST-ADMIN-ORDER: A. The turn checks this after triage and before
// the plan read-back and the dose refusal (turn.ts).
//
// Classes and supplies are not here yet: their destinations are clinic facts that wait
// on the clinical sponsor (ADR-0023, QST-ADMIN-SET: B, stage two).

export type AdminLane = 'appointment' | 'refill' | 'billing' | 'pump'
export const ADMIN_LANES: AdminLane[] = ['appointment', 'refill', 'billing', 'pump']

/** What the patient sees. `menuItem` is the portal's label, copied exactly from the
 *  MyPennMedicine menu (screenshot, 2026-11-21) because a patient scanning for a button
 *  matches on the words. Pump wording: Kay, 2026-11-21. The three menu cards are
 *  Claude's draft for Kay's review. */
// The menu item is a link to its placeholder page (Kay, QST-ADMIN-CARD-TEXT: "just make it a
// pseudolink"): a static "this is a demo" panel in index.html, opened by CSS :target like
// the nurse-line link. A real deployment would put the portal's own URL here.
export const ADMIN_CARD: Record<AdminLane, { says: string; menuItem: string | null; href?: string; use?: string }> = {
  appointment: { says: "I can't book or change appointments from this chat.", menuItem: 'Schedule an appointment', href: '#demo-schedule' },
  // The portal's Medications page (screenshot, 2026-11-21): a request there asks the
  // provider to RENEW a prescription; refills already left come from the pharmacy.
  refill: {
    says: "I can't send refill requests from this chat. If your prescription still has refills left, contact your pharmacy.",
    use: 'To ask your provider to renew it, use',
    menuItem: 'Refill a medication',
    href: '#demo-refill',
  },
  billing: { says: "I can't help with bills or insurance claims from this chat.", menuItem: 'Billing Assistance', href: '#demo-billing' },
  pump: { says: "If your insulin pump isn't working, please contact your pump manufacturer.", menuItem: null },
}

/** The sentence pointing to the menu item, for the eval reports (the chat shows a link). */
export function menuSentence(lane: AdminLane): string | null {
  const c = ADMIN_CARD[lane]
  return c.menuItem ? `${c.use ?? 'Please use'} ${c.menuItem}.` : null
}

/** The portal menu's own heading, which the cards point to. */
export const PORTAL_MENU = 'What would you like to do?'

// Patterns lean narrow, unlike triage's: a miss here falls back to today's answer path,
// while a false hit replaces a real answer with a deflection. Each must name the TASK,
// not just the subject: "How do I prepare for my doctor's appointment?" is education
// (kb/routing-questions.txt), and "How do insulin pumps work?" is a device question.
const PATTERNS: Record<AdminLane, RegExp[]> = {
  appointment: [
    // A scheduling verb right next to an appointment word ("appt", and the "apointment"
    // typo). Not "need"/"want" with a gap: "I need to eat before my appointment?" is a
    // food question.
    /\b(?:book|make|schedul\w*|set ?up|cancel\w*|reschedul\w*|chang\w*|mov\w*)\b[^.?!]{0,20}\b(?:app?oint?ments?|appts?)\b/,
    /\b(?:need|want|get)\b (?:an? |another |to (?:make|book|get|schedule) (?:an? )?)(?:app?oint?ment|appt)\b/,
    // "visit" and "check-up" only with a booking verb: "I visit the bathroom a lot" is a symptom.
    /\b(?:book|schedul\w*|cancel\w*|reschedul\w*)\b[^.?!]{0,20}\b(?:visits?|check-?ups?|follow-?ups?)\b/,
    /\breschedul\w*/,
    // Not "when is my next appointment?": the portal files questions ABOUT an appointment
    // under Contact Your Care Team ("Appointment Question"), our lane (screenshot, 11/21).
  ],
  refill: [
    // "refill" and its typos, but not refilling a pump's reservoir or cartridge
    /\bre-?fill?\w*\b(?![^.?!]{0,25}\b(?:reservoirs?|cartridges?|pods?|pumps?)\b)/,
    /\bfill\w*\b[^.?!]{0,15}\bprescriptions?\b/,
    /\b(?:renew\w*|new)\b[^.?!]{0,15}\b(?:prescriptions?|scripts?|rx)\b/,
    /\b(?:ran|run|running|am|i'?m|be|almost|nearly) out of (?:my )?(?:insulin|meds?|medicines?|medications?|pills?|prescriptions?|metformin|pens?)\b/,
  ],
  billing: [
    /\b(?:my|the|a|this|that|medical|hospital|doctor'?s?|clinic) bills?\b/,
    /\bbill(?:ing|ed)\b/,
    /\b(?:co-?pays?|invoices?)\b/,
    /\binsurance\b[^.?!]{0,30}\b(?:claim|denied|bill|charge|paid|pay)\w*/,
    /\b(?:pay|payment)\b[^.?!]{0,15}\b(?:bill|balance|account)\b/,
  ],
  pump: [
    // The device has failed. Not a site, tubing or reservoir problem, which the patient
    // fixes themselves, and not an alarm about insulin running low.
    // "new pump" is left out: "I'm getting a new pump, how do I count carbs?" is education.
    /\bpump\b[^.?!]{0,40}\b(?:won'?t (?:turn on|start|work|power on)|not (?:turning on|working|starting)|isn'?t working|stopped working|broke\w*|cracked|dead|died|failed|failure|error|blank)\b/,
    /\b(?:broken|faulty|replace\w*|replacement)\b (?:insulin )?pump\b/,
  ],
}

/** The lane the fixed rules find, or null. Pump first: "my pump is broken, I need a new
 *  one" is the device, not a refill. */
export function adminRules(message: string): AdminLane | null {
  const t = message.toLowerCase().replace(/[’`]/g, "'")
  for (const lane of ['pump', 'refill', 'appointment', 'billing'] as const) {
    if (PATTERNS[lane].some((re) => re.test(t))) return lane
  }
  return null
}

/** Rules first; the classifier only widens (QST-ADMIN-GATE: C). */
export function adminLane(message: string, classified: AdminLane | null | undefined): { lane: AdminLane; via: 'rules' | 'classifier' } | null {
  const ruled = adminRules(message)
  if (ruled) return { lane: ruled, via: 'rules' }
  return classified ? { lane: classified, via: 'classifier' } : null
}
