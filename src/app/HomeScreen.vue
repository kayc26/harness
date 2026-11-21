<script setup lang="ts">
// Signed-in home, laid out like the real patient portal's Message Center (ADR-0004,
// from Kay's screenshots): a white top bar; a centered white page on a blue gradient;
// Message Center navigation on the left and the conversation list on the right; and
// the docked "New message" window. The Diabetes Assistant is the "Non-urgent medical
// question" path inside that window. Static parts say they aren't in the demo.
// Unbranded (QST-PORTAL-BRANDING: B, Penn colors allowed): no portal vendor or
// health-system names or logos.
import { computed, ref } from 'vue'
import type { User } from '../lib/neon/auth'
import { viewsFor, type DataClient, type Membership } from '../lib/neon/data'
import NewMessageWindow from './NewMessageWindow.vue'
import { ADMIN_CARD, PORTAL_MENU } from '../lib/chat/admin'
import { currentTheme, toggleTheme } from './theme'

const props = defineProps<{ user: User; membership: Membership; data: Required<DataClient> }>()
const emit = defineEmits<{ signOut: [] }>()

const ROLE_LABEL = {
  patient_tester: 'Patient tester',
  careteam_tester: 'Care team tester',
  admin: 'Admin',
} as const

const views = computed(() => viewsFor(props.membership.role))
const view = ref<'patient' | 'careteam'>(views.value[0])
const initial = computed(() => props.membership.display_name.trim().charAt(0).toUpperCase() || '?')

// The assistant opens straight from one button (QST-PORTAL-SHORTCUT: C, Kay): the
// portal's Send a message → care team → disclaimer → question-type steps aren't built.
// The window's yellow banner keeps the "not for emergencies" message.
const windowOpen = ref(false)
let windowKey = 0
function openWindow(): void {
  windowKey++
  windowOpen.value = true
}

const notice = ref('')
function staticPart(name: string): void {
  notice.value = `“${name}” is part of the portal's look, but it isn't included in this demo.`
}

// High-contrast theme: a working accessibility switch (low-vision users, ADR-0005),
// remembered in this browser.
const HC = 'dea.highContrast'
const highContrast = ref(readHc())
function readHc(): boolean {
  try {
    return localStorage.getItem(HC) === '1'
  } catch {
    return false
  }
}
function applyHc(on: boolean): void {
  document.documentElement.classList.toggle('high-contrast', on)
}
applyHc(highContrast.value)
function toggleHc(): void {
  highContrast.value = !highContrast.value
  applyHc(highContrast.value)
  try {
    localStorage.setItem(HC, highContrast.value ? '1' : '0')
  } catch {
    /* lasts for this page */
  }
}

// Light / dark switch: the button names the theme it switches TO.
const theme = ref(currentTheme())
function switchTheme(): void {
  theme.value = toggleTheme()
}
</script>

<template>
  <div class="portal">
    <header class="top">
      <div class="logo">Patient Portal<small>placeholder brand · demo</small></div>
      <button class="sq" type="button" aria-label="Home" @click="staticPart('Home')">⌂</button>
      <button class="sq navy" type="button" aria-label="Menu" @click="staticPart('Menu')">☰</button>
      <span class="spacer" />
      <!-- in the top bar so the open assistant window never hides it -->
      <button class="signout" type="button" @click="switchTheme">{{ theme === 'dark' ? '☀ Light mode' : '☾ Dark mode' }}</button>
      <div class="me">
        <span class="avatar" aria-hidden="true"><span>{{ initial }}</span>▾</span>
        <span class="me-text">
          <strong>{{ membership.display_name }}</strong>
          <small>{{ ROLE_LABEL[membership.role] }}</small>
        </span>
        <button class="signout" type="button" @click="emit('signOut')">Sign out</button>
      </div>
    </header>

    <div class="stage">
      <div class="page">
        <aside class="nav" aria-label="Message Center">
          <h1>Message Center</h1>
          <!-- ADR-0023 (QST-ADMIN-MOCK: A): the portal's own menu, so the assistant's lane is
               visible and its deflection cards point at something on screen. Labels copied
               from the real portal; only the last item is in the demo. -->
          <section v-if="views.includes('patient')" class="tasks" aria-labelledby="tasks-head">
            <h2 id="tasks-head">{{ PORTAL_MENU }}</h2>
            <!-- the same placeholder pages the assistant's cards link to (index.html) -->
            <a class="task" :href="ADMIN_CARD.appointment.href"><span class="ico" aria-hidden="true">📅</span>Schedule an appointment</a>
            <a class="task" :href="ADMIN_CARD.refill.href"><span class="ico" aria-hidden="true">💊</span>Refill a medication</a>
            <a class="task" :href="ADMIN_CARD.billing.href"><span class="ico" aria-hidden="true">🧾</span>Billing Assistance</a>
            <button class="send" type="button" @click="openWindow">
              ✦ Contact Your Care Team<small>Ask the diabetes assistant a non-urgent question</small>
            </button>
          </section>
          <ul>
            <li>
              <button type="button" :class="{ on: view === 'patient' }" @click="views.includes('patient') ? (view = 'patient') : staticPart('Conversations')">
                <span class="ico" aria-hidden="true">💬</span>Conversations
              </button>
            </li>
            <li v-if="views.includes('careteam')">
              <button type="button" :class="{ on: view === 'careteam' }" @click="view = 'careteam'">
                <span class="ico" aria-hidden="true">🩺</span>Care team inbox
              </button>
            </li>
            <li><button type="button" @click="staticPart('Bookmarked')"><span class="ico" aria-hidden="true">🔖</span>Bookmarked</button></li>
            <li>
              <button type="button" @click="staticPart('Automated messages')">
                <span class="ico" aria-hidden="true">🗂</span>Automated messages <span class="count">1</span>
              </button>
            </li>
            <li><button type="button" @click="staticPart('Archive')"><span class="ico" aria-hidden="true">🗄</span>Archive</button></li>
          </ul>
        </aside>

        <main class="main">
          <p v-if="notice" class="notice" role="status">
            {{ notice }} <button type="button" class="link" @click="notice = ''">OK</button>
          </p>

          <template v-if="view === 'patient'">
            <div class="main-head">
              <h2>Conversations</h2>
              <div class="search">
                <input placeholder="Search conversations" aria-label="Search conversations (not part of the demo)" readonly @focus="staticPart('Search conversations')" />
                <button type="button" aria-label="Search" @click="staticPart('Search conversations')">⌕</button>
              </div>
            </div>
            <div class="list-meta">
              <button type="button" class="link" @click="staticPart('Manage conversations')">✎ Manage conversations</button>
              <span>Showing 1 of 1</span>
            </div>
            <button type="button" class="conv" @click="staticPart('Welcome to your patient portal')">
              <span class="ic" aria-hidden="true">👥</span>
              <span class="conv-body">
                <span class="t">Welcome to your patient portal <time>example</time></span>
                <span class="who">Care Team</span>
                <span class="pv">Questions about diabetes? Use Contact Your Care Team.</span>
              </span>
            </button>
            <p class="end">There are no more conversations to show.</p>
          </template>

          <template v-else>
            <div class="main-head"><h2>Care team inbox</h2></div>
            <p>Coming next: the summaries patients shared with the care team, with replies.</p>
          </template>
        </main>
      </div>

      <footer>
        <button type="button" class="link" @click="staticPart('Frequently Asked Questions')">Frequently Asked Questions</button>
        <button type="button" class="link" @click="staticPart('Terms & Conditions')">Terms &amp; Conditions</button>
        <button type="button" class="link" @click="staticPart('Contact Us')">Contact Us</button>
        <button type="button" class="hc" :aria-pressed="highContrast" @click="toggleHc">High Contrast Theme</button>
      </footer>
    </div>

    <NewMessageWindow v-if="windowOpen" :key="windowKey" :data="data" @close="windowOpen = false" />
  </div>
</template>

<style scoped>
.portal {
  --navy: var(--portal-navy, #011f5b); /* high-contrast theme sets --portal-navy (app.css) */
  /* navy as TEXT follows --accent, which turns light in dark mode; navy text on the
     dark-mode background was nearly invisible (logo, selected nav item, links) */
  --navy-text: var(--accent);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
button {
  font: inherit;
  cursor: pointer;
}

/* top bar (white, full width) */
.top {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 1rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.logo {
  font-size: 1.3rem;
  font-weight: 600;
  color: var(--navy-text);
  line-height: 1.1;
}
.logo small {
  display: block;
  font-size: 0.55rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.sq {
  width: 2.6rem;
  height: 2.6rem;
  border: 0;
  border-radius: 8px;
  background: #6b6f78;
  color: #fff;
  font-size: 1.1rem;
}
.sq.navy {
  background: var(--navy);
}
.spacer {
  flex: 1;
}
.me {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.avatar {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.45rem 0.2rem 0.2rem;
  border-radius: 8px;
  background: #6b6f78;
  color: #fff;
}
.avatar span {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: var(--navy);
  display: grid;
  place-items: center;
  font-weight: 700;
}
.me-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.me-text small {
  color: var(--muted);
  font-size: 0.75rem;
}
.signout {
  min-height: 2.6rem;
  padding: 0 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
}

/* the blue gradient stage with the centered white page */
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--stage-bg, linear-gradient(180deg, #3d78ad 0%, #24527e 45%, #0f2742 100%));
}
.page {
  flex: 1;
  width: min(92rem, 100% - 3rem);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 17rem 1fr;
  background: var(--panel);
}
.nav {
  border-right: 1px solid var(--border);
  padding: 1rem 1.1rem;
}
.nav h1 {
  font-size: 1.45rem;
  font-weight: 400;
  margin: 0 0 1rem;
}
.tasks h2 {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
}
.task {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: 2.75rem;
  margin-bottom: 0.4rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
  text-align: left;
  text-decoration: none;
  box-sizing: border-box;
}
.send {
  display: block;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.45rem 0.7rem;
  border: 0;
  border-radius: 4px;
  background: var(--navy);
  color: #fff;
  font-weight: 600;
  text-align: left;
}
.send small {
  display: block;
  font-weight: 400;
  font-size: 0.8rem;
}
.nav ul {
  list-style: none;
  padding: 0;
  margin: 1rem -1.1rem 0;
}
.nav li button {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  min-height: 2.9rem;
  padding: 0.4rem 1.1rem;
  border: 0;
  border-left: 4px solid transparent;
  background: none;
  color: var(--text);
  text-align: left;
}
.nav li button.on {
  border-left-color: var(--navy);
  background: var(--soft);
  color: var(--navy-text);
}
.count {
  margin-left: auto;
  min-width: 1.5rem;
  border-radius: 999px;
  background: var(--navy);
  color: #fff;
  font-size: 0.75rem;
  text-align: center;
}
.main {
  min-width: 0;
  padding: 1rem 1.5rem 2rem;
}
.main-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.main-head h2 {
  font-size: 1.45rem;
  font-weight: 400;
  margin: 0.25rem 0;
}
.search {
  display: flex;
  width: min(20rem, 100%);
  border: 1px solid var(--border);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0.45rem 0.6rem;
  font: inherit;
  font-size: 0.85rem;
  background: var(--panel);
  color: var(--text);
}
.search button {
  width: 2.6rem;
  border: 0;
  background: var(--navy);
  color: #fff;
}
.list-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0.5rem 0;
  color: var(--muted);
  font-size: 0.85rem;
}
.conv {
  width: 100%;
  display: grid;
  grid-template-columns: 2.6rem 1fr;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
}
.ic {
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  background: var(--navy);
  display: grid;
  place-items: center;
}
.conv-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.t {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 1.15rem;
}
.t time {
  color: var(--muted);
  font-size: 0.8rem;
}
.who {
  color: var(--muted);
}
.pv {
  color: var(--muted);
  font-size: 0.85rem;
}
.end {
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
.notice {
  margin: 0 0 0.75rem;
  padding: 0.6rem 0.9rem;
  background: var(--soft);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.link {
  border: 0;
  background: none;
  color: var(--navy-text);
  text-decoration: underline;
  padding: 0.25rem;
  min-height: 2.5rem;
}
footer {
  width: min(92rem, 100% - 3rem);
  margin: 0 auto;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.3rem 1rem;
  background: var(--panel);
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
}
.hc {
  min-height: 2.25rem;
  padding: 0 0.9rem;
  border: 0;
  border-radius: 999px;
  background: var(--navy);
  color: #fff;
  text-decoration: underline;
}

@media (max-width: 900px) {
  .page {
    grid-template-columns: 1fr;
    width: 100%;
  }
  .nav {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  footer {
    width: 100%;
    padding: 0.3rem 1rem;
  }
  .me-text small {
    display: none;
  }
}
@media (max-width: 600px) {
  .logo small,
  .me-text {
    display: none;
  }
  .logo {
    font-size: 1.05rem;
  }
}
</style>
