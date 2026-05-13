# MaxisAI USDM Generation Platform
## UI Design Specification

**Document owner:** Rajesh — Head of Product & Technology, MaxisAI
**Version:** 1.0
**Status:** Build-ready specification for Claude Code
**Audience:** Frontend engineering team, Pfizer DDF Challenge demo
**Companion to:** `architecture.md` v1.1

---

## 0. How to use this document

This is a screen-by-screen, role-by-role frontend specification intended to be handed directly to Claude Code (or any senior frontend engineer) to build a working application. Backend is out of scope; every screen runs against typed mock data that is itemized in Section 11. Every component, color, and animation is specified — the engineer should not have to invent.

The document is organized so each section is independently consumable:

- **Section 1** — design philosophy and the "why this looks the way it looks" so design decisions hold up under pressure.
- **Section 2** — design tokens, typography, color system, spacing — the literal CSS variables.
- **Section 3** — global components (sidebar, top bar, toasts, modals).
- **Section 4** — navigation map — every page that exists, organized by role.
- **Section 5** — role-by-role screen variations.
- **Sections 6–9** — detail specs for the four highest-impact surfaces: Reviewer Workbench, Lineage Explorer, Knowledge Graph, Provenance & Errors.
- **Section 10** — auth, settings, notifications.
- **Section 11** — mock data manifest.
- **Section 12** — implementation guidance for Claude Code.

---

## 1. Design Philosophy

### 1.1 — The audience is Pfizer judges

The first thing they see is the UI. Three impressions must land in the first 30 seconds:

1. **This is enterprise pharma software, not a startup demo.** Confident, restrained, information-dense, scientifically literate.
2. **This is the future of clinical-trial automation.** Modern, fast, agentic — but in service of trust and traceability, not novelty.
3. **MaxisAI knows clinical operations.** Real protocol IDs, real CDISC CT codes, real ICH M11 sections, real DIA eTMF zones — the language of the domain on every screen.

### 1.2 — Tone

Imagine **Linear's craftsmanship × Bloomberg Terminal's information density × a quiet, modern pharma research dashboard**. Bold enough to be memorable, restrained enough to be credible to a regulatory audience. No purple gradients, no glassmorphism for its own sake, no AI-cliché aesthetics.

### 1.3 — The "wow" moments

Five moments are designed to land hard during a 15-minute demo:

1. **The Lineage Explorer** — an interactive graph showing protocol-and-USDM evolution side by side, navigable in real time.
2. **The Provenance Overlay** — click any USDM value, instantly see the source span highlighted in the protocol, with model + version + confidence.
3. **The Round-trip Diff** — generated M11 document on the right, source protocol on the left, semantic equivalence per section colored green/amber/red.
4. **The Acceptance Criteria Dashboard** — every Pfizer criterion has its own live tile with drill-down. Press any criterion in the Pfizer eval list, see the evidence.
5. **The Knowledge Graph view** — the sponsor + standards graph rendered as a navigable network, demonstrating the compounding-knowledge moat.

Everything else supports these five.

### 1.4 — Density principle

Clinical reviewers are high-volume professionals. They want everything on one screen. We pack carefully — generous whitespace where it serves comprehension, controlled density where it serves productivity. Empty states are educational, never decorative.

---

## 2. Design System (Foundations)

### 2.1 — Color system

The MaxisAI brand reads as clean enterprise pharma — confident, restrained, trustworthy. The platform palette is rooted in deep professional teal (the brand anchor) with sophisticated neutrals and a small set of functional semantic colors. **No purple gradients. No neon. No accidental "AI startup" aesthetics.**

```css
:root {
  /* ─────── Brand ─────── */
  --brand-primary:        #0B5566;   /* MaxisAI deep teal — primary brand anchor */
  --brand-primary-hover:  #094654;
  --brand-primary-press:  #073846;
  --brand-secondary:      #00A89B;   /* MaxisAI accent teal — used sparingly for highlights */
  --brand-secondary-soft: #E0F4F2;   /* Soft teal tint for subtle backgrounds */
  --brand-ink:            #0A1628;   /* Deep navy — used for headers and emphasis */

  /* ─────── Surfaces (light theme, default) ─────── */
  --surface-canvas:       #FAFBFC;   /* Page background */
  --surface-base:         #FFFFFF;   /* Card background */
  --surface-raised:       #FFFFFF;   /* Modals, popovers — same color, raised by shadow */
  --surface-sunken:       #F4F6F8;   /* Inset panels, sidebars */
  --surface-overlay:      rgba(10, 22, 40, 0.48);  /* Modal scrim */

  /* ─────── Borders & lines ─────── */
  --border-subtle:        #E5E9EE;   /* Default border */
  --border-default:       #CBD3DC;   /* Stronger border */
  --border-strong:        #8C97A6;   /* Inputs, dividers between sections */
  --border-focus:         #00A89B;   /* Focus ring */

  /* ─────── Text ─────── */
  --text-primary:         #0A1628;   /* Headings, primary content */
  --text-secondary:       #3D4A5C;   /* Body text */
  --text-tertiary:        #6B7787;   /* Supporting/meta text */
  --text-disabled:        #A8B2BF;
  --text-on-brand:        #FFFFFF;   /* Text on brand-primary backgrounds */
  --text-link:            #0B5566;
  --text-link-hover:      #094654;

  /* ─────── Semantic — functional ─────── */
  --success:              #137752;   /* Validations passed, conformance green */
  --success-soft:         #E6F4EE;
  --warning:              #B45309;   /* HITL needed, low confidence */
  --warning-soft:         #FEF4E6;
  --danger:               #B42318;   /* Validation failed, hard errors */
  --danger-soft:          #FEE7E5;
  --info:                 #1E5A9C;   /* Informational notices */
  --info-soft:            #E5EEF8;

  /* ─────── Confidence scale (provenance) ─────── */
  --confidence-high:      #137752;   /* ≥ 95% */
  --confidence-medium:    #B45309;   /* 80–94% */
  --confidence-low:       #B42318;   /* < 80% */
  --confidence-pending:   #6B7787;   /* not yet scored */

  /* ─────── Lineage / graph ─────── */
  --node-protocol:        #0B5566;   /* Protocol-side nodes */
  --node-usdm:            #00A89B;   /* USDM-side nodes */
  --node-correction:      #B45309;   /* Reviewer correction nodes */
  --node-amendment:       #1E5A9C;   /* Amendment nodes */
  --edge-derived:         #0B5566;   /* DERIVED_FROM */
  --edge-changed:         #B45309;   /* CHANGED_BY */
  --edge-equivalent:      #8C97A6;   /* EQUIVALENT_TO */
  --edge-conflict:        #B42318;   /* CONFLICTS_WITH */

  /* ─────── Shadows ─────── */
  --shadow-xs:    0 1px 2px rgba(10, 22, 40, 0.04);
  --shadow-sm:    0 1px 3px rgba(10, 22, 40, 0.06), 0 1px 2px rgba(10, 22, 40, 0.04);
  --shadow-md:    0 4px 8px -2px rgba(10, 22, 40, 0.08), 0 2px 4px -2px rgba(10, 22, 40, 0.04);
  --shadow-lg:    0 12px 24px -8px rgba(10, 22, 40, 0.12), 0 4px 8px -4px rgba(10, 22, 40, 0.06);
  --shadow-xl:    0 24px 48px -12px rgba(10, 22, 40, 0.18);

  /* ─────── Radii ─────── */
  --radius-xs:    3px;
  --radius-sm:    6px;
  --radius-md:    8px;
  --radius-lg:    12px;
  --radius-xl:    16px;
  --radius-full:  9999px;

  /* ─────── Spacing (4px base) ─────── */
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  /* ─────── Z-index ─────── */
  --z-base:        0;
  --z-raised:      10;
  --z-sticky:      100;
  --z-overlay:     1000;
  --z-modal:       1100;
  --z-toast:       1200;
  --z-tooltip:     1300;
}

/* Dark theme override — preferred by power users on long sessions */
[data-theme="dark"] {
  --surface-canvas:       #0A1628;
  --surface-base:         #111E33;
  --surface-raised:       #16263F;
  --surface-sunken:       #08111F;
  --border-subtle:        #1E3148;
  --border-default:       #2A4360;
  --border-strong:        #4A6080;
  --text-primary:         #F4F6F8;
  --text-secondary:       #B8C2CF;
  --text-tertiary:        #8C97A6;
  --text-disabled:        #4A5566;

  --success-soft:         rgba(19, 119, 82, 0.15);
  --warning-soft:         rgba(180, 83, 9, 0.15);
  --danger-soft:          rgba(180, 35, 24, 0.15);
  --info-soft:            rgba(30, 90, 156, 0.15);
  --brand-secondary-soft: rgba(0, 168, 155, 0.12);
}
```

> **Logo placement:** the actual MaxisAI logo files (white and color variants) live at `/public/brand/maxisai-logo-white.svg` and `/public/brand/maxisai-logo-color.svg`. Use the white variant on the brand-primary sidebar, the color variant on the login screen.

### 2.2 — Typography

Two font families, both free, both distinctive enough to avoid the AI-default look while remaining seriously legible at clinical-data densities.

```css
/* Headings, display, and brand surfaces */
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&display=swap');

/* Body, UI text, dense data — a humanist sans with character */
@import url('https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&display=swap');

/* Monospace for IDs, codes, JSON — clean and clinical */
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --font-display: 'Fraunces', Georgia, 'Times New Roman', serif;
  --font-body:    'Inter Tight', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
```

**Why these choices.** Fraunces (a contemporary serif with optical sizing) gives our display surfaces a editorial, scientific quality — important for a pharma audience that is allergic to "AI consumer app" vibes. Inter Tight reads tighter and more characterful than plain Inter, and avoids the "every AI startup uses Inter" trap. JetBrains Mono is for IDs, NCT numbers, CT codes, JSON snippets — anything where character precision matters.

**Type scale:**

| Token | Size / Line / Weight | Usage |
|---|---|---|
| `text-display-xl` | 56 / 64 / 600 (Fraunces) | Login hero |
| `text-display-lg` | 40 / 48 / 600 (Fraunces) | Dashboard top numbers |
| `text-display-md` | 32 / 40 / 600 (Fraunces) | Section headers |
| `text-h1` | 24 / 32 / 600 (Inter Tight) | Page titles |
| `text-h2` | 20 / 28 / 600 (Inter Tight) | Card headers |
| `text-h3` | 16 / 24 / 600 (Inter Tight) | Sub-section |
| `text-body-lg` | 16 / 24 / 400 (Inter Tight) | Long-form |
| `text-body` | 14 / 20 / 400 (Inter Tight) | Default body |
| `text-body-sm` | 13 / 18 / 400 (Inter Tight) | Dense tables |
| `text-meta` | 12 / 16 / 500 (Inter Tight) | Labels, captions |
| `text-mono` | 13 / 18 / 500 (JetBrains Mono) | IDs, codes |
| `text-mono-sm` | 12 / 16 / 500 (JetBrains Mono) | Inline codes in tables |

### 2.3 — Iconography

Use **Lucide React** (`lucide-react`) — clean, consistent, free, comprehensive. Icon size defaults to 16×16 inside text and 20×20 in standalone buttons. Stroke width 1.75 throughout for a slightly softer, less harsh feel than the default.

For domain-specific iconography (USDM, M11, CDASH, eTMF, SDTM), use small typographic monograms (e.g., a 24×24 rounded square with `M11` in JetBrains Mono, colored by category) rather than custom illustrations — keeps the visual system disciplined.

### 2.4 — Motion

Restrained, purposeful, fast. No bouncy springs, no excessive fade-ins.

```css
:root {
  --motion-fast:   120ms;
  --motion-base:   200ms;
  --motion-slow:   320ms;
  --motion-slower: 480ms;

  --easing-standard:    cubic-bezier(0.2, 0, 0, 1);   /* Most UI motion */
  --easing-decelerate:  cubic-bezier(0, 0, 0.2, 1);   /* Entering elements */
  --easing-accelerate:  cubic-bezier(0.4, 0, 1, 1);   /* Exiting elements */
  --easing-emphasized:  cubic-bezier(0.2, 0, 0, 1);   /* Page transitions */
}
```

Specific motion patterns:

- **Page transitions:** 200ms fade + 4px slide-up on enter
- **Modal:** 240ms scale (0.96 → 1.0) + fade
- **Toast:** 200ms slide-in from top-right + fade
- **Tooltips:** 80ms fade with 320ms delay before appearing
- **Hover state:** 120ms color transition only — never scale/move
- **Loading skeletons:** subtle 1.4s shimmer
- **Graph zoom/pan:** 60fps, no transition (direct manipulation)

### 2.5 — Accessibility baseline

WCAG 2.2 AA compliant throughout:

- All text meets 4.5:1 contrast (verified for both themes)
- Focus rings are 2px, 2px offset, `--border-focus`
- Every interactive element has a hover state, focus state, active state, and disabled state
- Keyboard navigation: every action reachable, logical tab order, visible focus
- Screen reader: all icons paired with `aria-label`, all dynamic content announced via `aria-live`
- Reduced-motion: honor `prefers-reduced-motion` — disable transitions, keep instant state changes
- Forms: labels above inputs, error text below, ARIA `aria-describedby` linking errors to inputs

---

## 3. Global Components

### 3.1 — App shell

Persistent left sidebar (240px wide, collapsible to 56px), top bar (56px tall), main content area. The app shell never re-mounts during navigation — only the main content area changes.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [Logo]    Search ⌘K                            🔔 ⚙   ☾   [Avatar ▾]  │  ← Top bar (56px)
├──────┬──────────────────────────────────────────────────────────────────┤
│      │                                                                   │
│ Side │                                                                   │
│ bar  │                  Main content area                                │
│ 240  │                                                                   │
│      │                                                                   │
│      │                                                                   │
└──────┴──────────────────────────────────────────────────────────────────┘
```

### 3.2 — Sidebar

- Background: `--brand-primary` (deep teal); text in `--text-on-brand`
- MaxisAI logo at top (white variant), 32px tall, with 16px left/top padding
- Subtle horizontal rule (rgba white 10%) below logo
- Section headers in `--text-meta` style, white at 60% opacity, uppercase, letter-spacing 0.05em
- Nav items: 36px tall, 12px horizontal padding, 8px vertical padding, `--radius-sm` corners
- Active nav item: white at 12% alpha background, white text, 2px left accent bar in `--brand-secondary`
- Hover: white at 6% alpha background
- Icon left, label right, optional badge count on the right (e.g., "Review Queue [12]")
- Bottom of sidebar: collapsed-state toggle, environment badge ("PROD / SANDBOX / DEMO"), build version

The sidebar has a consistent **structure** across roles but the **items** differ — see Section 4 for the role-by-role nav map.

### 3.3 — Top bar

- Background: `--surface-base` (white), 1px bottom border `--border-subtle`
- Left: breadcrumb in `--text-secondary`, current page bold in `--text-primary`
- Center: global command palette trigger ("⌘K Search") — opens command palette modal
- Right (in order):
  - Notification bell with red dot if unread (popover panel, see 3.6)
  - Quick settings icon (theme toggle, density toggle)
  - Theme toggle (sun/moon)
  - User avatar with role badge → dropdown (Profile, Settings, Help, Sign Out)

### 3.4 — Command palette (⌘K)

A keyboard-first universal navigator, modeled on Linear / Raycast. Modal overlay with sharp focus, max-width 640px, centered.

Categories:
- **Go to** — every page Currently accessible to the role
- **Studies** — fuzzy search across known studies (mock data manifest section 11)
- **Conversions** — recent and in-flight
- **Actions** — "Start new conversion", "Approve current item", "Export provenance bundle"
- **Help** — keyboard shortcuts, support, what's new

Item structure: icon · primary label · secondary meta · keyboard hint.

### 3.5 — Toasts

- Top-right of viewport, 16px from edges
- Stack vertically with 8px gap, max 5 visible (older auto-dismiss)
- Width: 380px, padding 12px 16px, `--radius-md`, `--shadow-lg`
- Icon left, content middle, optional action right, dismiss × at far right
- Auto-dismiss timing: success 4s, info 5s, warning 7s, danger sticky (must dismiss)
- Variants:
  - **Success** — green left border (4px), green icon, white background
  - **Info** — blue left border, blue icon, white background
  - **Warning** — amber left border, amber icon, white background
  - **Danger** — red left border, red icon, white background
  - **Progress** — blue left border, animated spinner, sticky until done

Example messages:
- ✅ "Conversion `CONV-2026-04-127` completed in 18m 42s · 47 fields auto-accepted, 8 sent for review"
- ⚠ "Amendment 03 on `NCT05847219` introduced 12 conflicts — review required"
- ❌ "Conformance failed on `extract_estimands` after 5 iterations — handover to SME"
- ⏱ "Generating M11 protocol document… (3 of 47 sections complete)"

### 3.6 — Notifications panel

Triggered from bell icon. Right-side drawer, 400px wide, full height. Tabs: All / Unread / Mentions / System.

Each notification: icon · title · body · timestamp · optional action button.

Notification types and examples:
- **Conversion completed** — "Pfizer Onc-2026-04 PROT-3 ready for your review"
- **Amendment requires attention** — "Amendment 03 on PROT-2 introduced conflicts in eligibility"
- **Reviewer mention** — "Anita tagged you on inclusion criterion 7 (CONV-2026-04-127)"
- **Validation failure** — "Conformance failed on CONV-2026-04-128"
- **Adjudication requested** — "Disagreement on endpoint classification — your decision needed"
- **System** — "New CDISC CT version 2026-Q2 available — auto-applied to studies dated 2026-Q2+"
- **Model upgrade** — "Sonnet 4.6 promoted to production after passing eval set with +3.2% accuracy"

### 3.7 — Modals

- Centered, max-width varies by content (480 / 640 / 880 / 1120)
- `--radius-lg` corners, `--shadow-xl` elevation, `--surface-overlay` scrim behind
- Header (24px padding, 1px bottom border): title + close × + optional secondary action
- Body (24px padding)
- Footer (16px padding, 1px top border, justify-end): primary action right, secondary action left, "Cancel" leftmost

### 3.8 — Buttons

Five variants × three sizes.

Variants:
- **Primary** — solid `--brand-primary`, white text. For the primary action on a screen.
- **Secondary** — 1px `--border-default`, `--text-primary`, transparent background. For secondary actions.
- **Tertiary** — no border, `--text-secondary`, transparent background, hover bg `--surface-sunken`. For low-emphasis.
- **Danger** — solid `--danger`, white text. For destructive.
- **Ghost icon** — icon only, 1px transparent border, hover ring.

Sizes:
- **sm** — 28px tall, padding 0 12px, text-body-sm
- **md** — 36px tall, padding 0 16px, text-body  ← default
- **lg** — 44px tall, padding 0 20px, text-body

Loading state: replace icon with spinner, disable but keep tooltip.

### 3.9 — Form controls

All input controls: 36px tall (md size), `--radius-sm`, 1px `--border-default`, focus 2px `--border-focus`, padding 0 12px. Error state: `--danger` border, `--danger` helper text below.

- Text input
- Textarea (auto-grow up to 6 lines, then scroll)
- Select (custom-styled dropdown, no native select)
- Multi-select with chips
- Combobox with autocomplete
- Date picker
- File upload (drag-and-drop with mock progress)
- Toggle (28×16, `--brand-primary` when on)
- Radio group, checkbox group
- Slider

### 3.10 — Status badges

Small inline pills for status indication. 20px tall, `--radius-full`, padding 2px 8px, `text-meta`.

Status types:
- **Auto-accepted** (success) — green tint bg, dark green text, optional ✓ icon
- **Awaiting review** (warning) — amber tint bg, dark amber text
- **In progress** (info) — blue tint bg, dark blue text, animated dot
- **Failed** (danger) — red tint bg, dark red text
- **Approved** (success solid) — solid green bg, white text
- **Conflict** (danger) — red tint bg, dark red text, ⚠ icon
- **Amendment** (info) — purple-blue tint bg, dark blue text, "Δ" icon

### 3.11 — Tables (data grid)

Used heavily — this is a data-dense product. Specs:

- Header row: 40px tall, `--surface-sunken` bg, `text-meta` font, sortable columns with arrow indicators
- Body rows: 44px tall, alternating subtle stripe (`--surface-sunken` at 30%), 1px `--border-subtle` bottom
- Hover row: `--brand-secondary-soft` bg (very subtle), cursor pointer
- Selected row: `--brand-secondary-soft` bg solid + 2px left accent
- Cell padding: 0 12px
- Inline actions on hover (right side of row): View · Edit · More menu
- Sticky first column for wide tables
- Sticky header on scroll
- Empty state: centered illustration + helpful text
- Pagination at bottom: "1–20 of 124" left, page controls right

### 3.12 — Cards

Container component, used for grouping content. `--surface-base` bg, 1px `--border-subtle`, `--radius-lg`, `--shadow-xs`. Padding 24px standard, 16px compact.

Header pattern: title (text-h3) + optional meta + actions row (right side). 1px bottom border between header and body when card has a header.

---

## 4. Navigation Map

### 4.1 — Top-level navigation (all roles)

The sidebar always has these sections, items vary by role:

```
┌──────────────────────────┐
│ [MaxisAI Logo]           │
├──────────────────────────┤
│ ── OPERATE ──            │
│  Dashboard               │  ← always visible
│  Conversions             │  ← always visible
│  Review Queue        [n] │  ← reviewers/SMEs only
│  Adjudications       [n] │  ← SMEs only
├──────────────────────────┤
│ ── EVIDENCE ──           │
│  Lineage                 │  ← always visible
│  Provenance              │  ← always visible
│  Knowledge Graph         │  ← always visible
│  Audit Trail             │  ← admin/superadmin/exec
├──────────────────────────┤
│ ── DELIVER ──            │
│  Doc Studio              │  ← always visible
│  Integrations            │  ← admin/superadmin
├──────────────────────────┤
│ ── INTELLIGENCE ──       │
│  Quality Dashboard       │  ← always visible
│  Eval Sets               │  ← admin/superadmin
│  Models & Skills         │  ← admin/superadmin
├──────────────────────────┤
│ ── ADMIN ──              │
│  Users & Roles           │  ← admin/superadmin
│  Tenants                 │  ← superadmin only
│  System Health           │  ← superadmin only
│  Settings                │  ← always visible
└──────────────────────────┘
│ [Env: SANDBOX] v1.0.0    │
└──────────────────────────┘
```

### 4.2 — Pages list (canonical)

| # | Path | Page | Description |
|---|---|---|---|
| 1 | `/login` | Login | Auth entry point |
| 2 | `/forgot-password` | Forgot Password | Reset flow |
| 3 | `/` | Dashboard | Role-aware home |
| 4 | `/conversions` | Conversions list | All studies & conversions |
| 5 | `/conversions/new` | New Conversion | Upload & start |
| 6 | `/conversions/:id` | Conversion Detail | Single conversion overview |
| 7 | `/conversions/:id/review` | Reviewer Workbench | The core review surface |
| 8 | `/conversions/:id/lineage` | Lineage Explorer | Per-study lineage |
| 9 | `/conversions/:id/provenance` | Provenance | Per-study provenance browser |
| 10 | `/conversions/:id/doc-studio` | Doc Studio | Downstream artifacts |
| 11 | `/conversions/:id/conformance` | Conformance Report | Validation outcome |
| 12 | `/review-queue` | Review Queue | All flagged items across studies |
| 13 | `/adjudications` | Adjudications | Disagreements requiring SME |
| 14 | `/lineage` | Lineage (cross-study) | Org-wide lineage explorer |
| 15 | `/provenance` | Provenance (cross-study) | Org-wide provenance |
| 16 | `/knowledge-graph` | Knowledge Graph | Standards + Sponsor KG |
| 17 | `/audit-trail` | Audit Trail | Immutable ledger browser |
| 18 | `/doc-studio` | Doc Studio (cross-study) | All generated artifacts |
| 19 | `/integrations` | Integrations | API health, connectors, events |
| 20 | `/quality-dashboard` | Quality Dashboard | All 8 acceptance criteria |
| 21 | `/eval-sets` | Eval Sets | Golden eval set management |
| 22 | `/models-and-skills` | Models & Skills | Model registry, skill registry |
| 23 | `/users-and-roles` | Users & Roles | User management |
| 24 | `/tenants` | Tenants | Multi-tenant view (superadmin) |
| 25 | `/system-health` | System Health | Platform health (superadmin) |
| 26 | `/settings/profile` | Profile Settings | User profile |
| 27 | `/settings/preferences` | Preferences | Theme, density, notifications |
| 28 | `/settings/security` | Security | MFA, sessions, API keys |
| 29 | `/settings/tenant` | Tenant Settings | Sponsor-level (admin) |
| 30 | `/notifications` | Notifications | Full notification history |
| 31 | `/help` | Help | Documentation, shortcuts |

---

## 5. Roles and Role-Specific Views

### 5.1 — Six roles

| Role | Description | Primary surfaces |
|---|---|---|
| **Clinical Reviewer** | Reviews eligibility, interventions, design, populations | Workbench, Review Queue |
| **Standards / Data Manager** | Reviews BCs, CT codes, SDTM/CDASH mappings | Workbench (standards mode), Doc Studio |
| **Biostatistician / SME** | Reviews objectives, endpoints, estimands; adjudicates | Workbench (SME mode), Adjudications |
| **Tenant Admin** | Sponsor-level admin: users, integrations, settings | Users, Integrations, Settings |
| **Executive / Read-Only** | Pfizer judges, executives — view-only across the platform | Quality Dashboard, Lineage |
| **Super Admin (MaxisAI)** | Cross-tenant operations, model governance, system health | Tenants, Models, System Health |

### 5.2 — Role × page access matrix

| Page | Reviewer | Standards | SME | Admin | Exec | SuperAdmin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Conversions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| New Conversion | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Conversion Detail | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Workbench | ✓ | ✓ | ✓ | view | view | ✓ |
| Review Queue | ✓ | ✓ | ✓ | view | — | ✓ |
| Adjudications | — | — | ✓ | view | — | ✓ |
| Lineage | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Provenance | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Knowledge Graph | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit Trail | view-own | view-own | view-own | ✓ | ✓ | ✓ |
| Doc Studio | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Integrations | — | — | — | ✓ | view | ✓ |
| Quality Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Eval Sets | — | view | view | ✓ | view | ✓ |
| Models & Skills | — | — | — | ✓ | view | ✓ |
| Users & Roles | — | — | — | ✓ | — | ✓ |
| Tenants | — | — | — | — | — | ✓ |
| System Health | — | — | — | — | — | ✓ |

`✓` = full access, `view` = read-only, `view-own` = can see only own actions, `—` = hidden from sidebar and 404 if URL accessed directly.

### 5.3 — Role-specific dashboard layouts

The Dashboard (`/`) is the most role-dependent page. Each role gets a tailored landing experience.

**Clinical Reviewer dashboard** — focus on what to review next.
- "My queue" hero card showing flagged-item count, average age, oldest item
- "In progress" — conversions where you have unfinished work
- "Recent decisions" — your last 5 reviews with click-back
- "Tips & shortcuts" footer

**Standards / Data Manager dashboard** — focus on standards quality.
- "BC reuse rate" hero metric (target ≥80%)
- "CT code coverage" — % of fields using CDISC CT vs free text
- "Most-corrected codes" — leaderboard of recurring corrections
- "Pending standards reviews" queue

**Biostatistician / SME dashboard** — focus on adjudications and complex decisions.
- "Adjudications open" hero card
- "Estimand quality" — % of conversions with full ICH E9(R1) attribution
- "Endpoint–objective coverage" map
- "Recent SME decisions" list

**Tenant Admin dashboard** — focus on tenant operations and integrations.
- 4 KPI tiles: Conversions this month · Active users · API uptime · Integration health
- "Pipeline" — conversions in flight by stage
- "Cost vs target" chart
- "User activity" sparkline

**Executive / Read-Only dashboard** — the **Pfizer judge** view, designed to demonstrate the platform.
- 8 acceptance-criteria tiles in a 4×2 grid (Section 9.1) — this is THE high-impact landing screen
- Each tile is large, beautifully designed, shows live evidence
- Below tiles: "Recent activity" stream + "Lineage highlights" mini-graph
- Demo-ready by default

**Super Admin dashboard** — focus on platform health across tenants.
- Cross-tenant scorecard (rows = tenants, columns = the 8 criteria, color-coded)
- Model registry status (current production models, version, eval scores)
- System health: EKS, Bedrock, Neptune, OpenSearch, EventBridge — all green/amber/red
- Recent platform events stream

### 5.4 — Role-aware micro-affordances throughout

Beyond the dashboard, role context tunes the UI subtly across screens:

- **Reviewer Workbench** filters its visible flag types to the reviewer's domain by default (Clinical sees eligibility/interventions/design; Standards sees BCs/CT codes; SME sees objectives/endpoints/estimands)
- **Lineage Explorer** highlights edges relevant to the reviewer's role
- **Quality Dashboard** tile order is role-relevant (Reviewer sees Provenance + UX first; Admin sees Reliability + Cost first)
- **Avatar badge** shows role abbreviation (CR, DM, SME, ADM, EXEC, SA) so the user always sees what role they're operating as

When a user has multiple roles (common for MaxisAI internal staff during the Challenge), an in-app **role switcher** in the top-right (next to avatar) lets them swap context without re-login.

---

## 6. Detail Spec — The Reviewer Workbench

The Reviewer Workbench (`/conversions/:id/review`) is the most-used screen and the most demo-impressive — it's where Pfizer judges will see provenance, confidence, and the agentic self-correction loop in action.

### 6.1 — Layout

Three-pane layout, full viewport height (sidebar + top bar already taken):

```
┌──────────────────┬─────────────────────────────┬──────────────────┐
│  PROTOCOL        │  USDM EXTRACTION            │  PROVENANCE      │
│  (left, 38%)     │  (center, 38%)              │  (right, 24%)    │
│                  │                             │                  │
│  Section nav ▼   │  ▸ Item navigator           │  Source span     │
│  [search]        │                             │  highlighted     │
│                  │                             │                  │
│  Source doc      │  Editable extracted value   │  Model: Sonnet   │
│  rendered with   │  Confidence: 87%   ⚠       │  Version: ...    │
│  highlights      │  Validation: 2 flags        │  Skill: extract_ │
│                  │                             │   eligibility    │
│                  │  [Why this value? expand ▾] │  Iter: 2 of 3    │
│                  │                             │                  │
│                  │  [Source span ▾]            │  Similar past    │
│                  │  ┌──────────────────────┐   │  cases (3)       │
│                  │  │ "Subjects must be... │   │                  │
│                  │  └──────────────────────┘   │  Suggest from    │
│                  │                             │  corpus          │
│                  │  [Validation ▾]             │                  │
│                  │  • Schema: ✓                │                  │
│                  │  • Faithfulness: ✓          │                  │
│                  │  • Completeness: ⚠          │                  │
│                  │                             │                  │
├──────────────────┴─────────────────────────────┴──────────────────┤
│ ▸ 1 of 47 flagged · ⌘← prev · ⌘→ next                              │
│                                                                    │
│ [Reject] [Edit] [Accept] [Send to SME] [Mark for Adjudication]    │
└────────────────────────────────────────────────────────────────────┘
```

### 6.2 — Left pane — Source protocol

Renders the source document with:
- Section navigator at top (sticky), expandable tree of M11 sections, current section highlighted
- Search bar with keyboard shortcut `⌘F`
- Text rendered with original formatting preserved (headings, paragraphs, lists, tables)
- Tables rendered natively (especially the SoA — this is critical)
- The current source span highlighted in `--brand-secondary-soft` with a 2px `--brand-secondary` left border on the paragraph
- Hovering any structured-content paragraph shows a "Linked to N USDM fields" tooltip
- Click on highlighted text → instantly jumps the center pane to the linked field

Mock content for demo: a realistic ICH M11 protocol section. See Section 11.

### 6.3 — Center pane — USDM extraction

The active field being reviewed. Top of pane shows:

**Item header:**
```
INCLUSION CRITERION 7  ·  EligibilityCriterion[id=ELIG-007]
Skill: extract_eligibility   Iteration: 2/3   Confidence: 87% ⚠
```

**The extracted value** in an editable area:
```
{
  "id": "ELIG-007",
  "category": "INCLUSION",
  "criterionText": "Subjects must have ECOG performance status of 0 or 1",
  "structuredCondition": {
    "concept": "ECOG_PERFORMANCE_STATUS",
    "operator": "IN",
    "values": ["0", "1"]
  },
  "ctCode": "C102680",
  "linkedPopulation": "POP-01"
}
```

Below the editable value, three collapsible cards:

**1. Why this value? (provenance card)** — see Section 9 for the full provenance UX.
- Source document, page, section, paragraph
- Source span quoted verbatim
- Model: `anthropic.claude-sonnet-4-5-20250929-v1:0` (US regional)
- Skill version: `extract_eligibility v3.2.1`
- Prompt hash: `sha256:a4f...`
- Confidence: 87% (medium)
- Reasoning summary (2-3 lines, generated)

**2. Source span**
- Verbatim text in `--surface-sunken` with mono font
- "Open in protocol pane" button

**3. Validation results**
| Validator | Result | Detail |
|---|---|---|
| Schema | ✓ Pass | Valid `EligibilityCriterion` |
| Faithfulness | ✓ Pass | Source span resolves |
| Completeness | ⚠ Warning | `linkedPopulation` not yet linked (orphan) |
| Conformance (CRS) | ✓ Pass | All applicable rules |
| Round-trip (M11) | — Pending | Generated after acceptance |

**4. Self-correction history**
A timeline showing the 3 iterations:
- Iter 1 — initial extraction, confidence 62%, flagged
- Iter 2 — re-extracted with validation context, confidence 87% (current)
- Iter 3 — terminated (improvement plateau)

### 6.4 — Right pane — Provenance & similar cases

- Source span highlighted with the surrounding 80–120 chars of context
- Pull from past corrections — "3 similar items in this corpus", with click-through
- "Suggest from corpus" button: when clicked, shows a side-by-side of the current value and the corpus suggestion
- Compact metadata card — model, prompt cache key, conversion run ID, timestamp

### 6.5 — Action bar (bottom)

Sticky 64px high. Left side: progress indicator ("Item 1 of 47 flagged · 3 SME · 12 standards · 32 clinical"). Right side: actions (in order of typical usage):

- **Accept** (primary, green) — accepts the current value, advances to next
- **Edit & accept** (secondary) — modal with the value editable, save = accept
- **Reject** (secondary, red) — opens reason picker (controlled vocabulary)
- **Send to SME** (tertiary) — passes to a queue with a note
- **Mark for adjudication** (tertiary) — when two reviewers disagree

Keyboard shortcuts: `A` accept, `E` edit, `R` reject, `S` SME, `J` adjudicate, `←/→` navigate, `⌘←/→` skip to next flagged.

### 6.6 — Standards mode (for Data Manager role)

When a Standards / Data Manager opens the Workbench, the center pane shows additional structured fields specific to their domain:

- For BC fields: BC source (CDISC Library? sponsor MDR? custom?), BC version, mapped CDASH item, mapped SDTM target
- "Code resolution" card showing the candidate codelist, current selection, alternative candidates with similarity scores

### 6.7 — SME mode (for Biostatistician)

When an SME opens the Workbench on objective/endpoint/estimand items, the center pane shows the **estimand attribute decomposition** (treatment, population, endpoint, intercurrent events, summary measure) as a structured form, with each attribute traceable to its source span.

A dedicated "Estimand integrity check" card shows whether the five attributes are all populated and internally consistent.

### 6.8 — Empty / completed state

When the queue is empty for the current user, the center pane shows a clean illustration (a stylized check mark in MaxisAI brand teal) with text: "All caught up. 47 items reviewed today. ⌘K to navigate elsewhere."

---

## 7. Detail Spec — The Lineage Explorer

This is the highest-impact "wow" surface in the demo. It's also where the data-lineage acceptance criterion is proven most viscerally.

### 7.1 — Three view modes

A segmented control at the top toggles between three views of the same underlying graph:

1. **Timeline view** — protocol versions and USDM versions on parallel horizontal time axes
2. **Field history view** — pick one USDM field, see its full history
3. **Graph view** — interactive network graph (the show-stopper)

### 7.2 — Timeline view (default)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Study: NCT05847219 · Pfizer Onc-2026 · Phase 2                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PROTOCOL                                                                │
│  ●─────────●──────────────●──────────────────●────────────●           │
│  v1.0      v1.1           v2.0               v2.1         v3.0          │
│  Original  Minor amend    Major amend        Country amend Major amend  │
│  Mar 2024  Aug 2024       Feb 2025           Jun 2025     Jan 2026      │
│                                                                          │
│  USDM                                                                   │
│  ●─────────●──●───────────●─●─────────────●──●────────────●           │
│  v1.0      v1.1 v1.2      v2.0 v2.1       v2.2 v2.3       v3.0          │
│  Initial   1.1  Reviewer  Amend Reviewer   Amend Reviewer  Amend       │
│  conv      auto  correct   apply correct   apply correct  apply        │
│  Mar 2024  Aug   Aug       Feb   Feb        Jun   Jul      Jan 2026    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

- Two parallel horizontal time axes
- Protocol nodes: `--node-protocol` filled circles, 12px diameter
- USDM nodes: `--node-usdm` filled circles, 10px diameter
- Vertical dashed connector lines show "this USDM version was triggered by this protocol version"
- Click any node → side drawer opens with details
- Hover any node → tooltip with metadata
- Time axis: zoomable with mouse wheel or pinch
- Today line marked with vertical dashed line in `--brand-secondary`

### 7.3 — Field history view

Pick a single USDM field via the search/picker at the top. Shows:

- Big breadcrumb: `Study › StudyVersion › Population › InclusionCriteria › ELIG-007`
- Vertical timeline (top to bottom, oldest at top)
- Each row: timestamp · event type icon · who/what · the value at that point
- Diff view between adjacent versions, in side-by-side mode
- Visual of the source-span shifts across protocol versions (when applicable)

Example field history for `ELIG-007`:

| When | Event | Who | Value summary | Reason |
|---|---|---|---|---|
| Mar 2024 | INTRODUCED | Auto-extraction | "ECOG 0 or 1" | Initial conversion v1.0 |
| Aug 2024 | EQUIVALENT | Auto-extraction | "ECOG 0 or 1" | Amendment v1.1 — no change to this field |
| Aug 2024 | CHANGED_BY (correction) | Anita Rao (Standards) | Added CT code C102680 | Standards review |
| Feb 2025 | MODIFIED | Amendment v2.0 | "ECOG 0, 1, or 2" | Protocol amendment broadened criterion |
| Feb 2025 | CHANGED_BY (correction) | Dr. Patel (SME) | Adjusted population link | SME review |
| Jun 2025 | EQUIVALENT | Amendment v2.1 | "ECOG 0, 1, or 2" | Country amendment did not affect |
| Jan 2026 | CHANGED_BY (model upgrade) | System (auto) | Re-extracted; same value, new confidence 0.94 | Sonnet 4.5 → 4.6 model upgrade |

### 7.4 — Graph view (the demo show-stopper)

A force-directed network graph rendered with **D3** or **react-force-graph** (specify `react-force-graph-2d`).

```
                 ┌────────────────────────────────────────────────────┐
                 │   Lineage Graph · NCT05847219 · 247 nodes · 412 edges  │
                 ├────────────────────────────────────────────────────┤
                 │                                                     │
                 │           ╔═══════════╗                             │
                 │           ║  Protocol  ║                            │
                 │           ║   v1.0    ║◄─────── DERIVED_FROM        │
                 │           ╚═════╤═════╝                             │
                 │                 │ AMENDS                            │
                 │           ╔═════▼═════╗      ╔═════════════╗       │
                 │           ║  Protocol  ║      ║  USDM v1.0   ║       │
                 │           ║   v1.1    ║      ║   (initial) ║        │
                 │           ╚═════╤═════╝      ╚══════╤══════╝        │
                 │                 │                   │ CHANGED_BY    │
                 │             ... etc ...        ╔════▼════════╗     │
                 │                                ║ Correction  ║     │
                 │                                ║ A. Rao · CT ║     │
                 │                                ╚═════════════╝     │
                 └────────────────────────────────────────────────────┘
```

**Visual specification:**

- Nodes:
  - **Protocol**: circle, `--node-protocol`, 16px diameter
  - **Protocol Version**: circle, `--node-protocol`, 12px, lighter shade
  - **Section/Span**: small dot, `--node-protocol` at 50% opacity, 6px
  - **USDM Version**: square, `--node-usdm`, 14×14px
  - **USDM Object**: square, `--node-usdm`, 10×10px
  - **USDM Field**: small square, `--node-usdm` at 50%, 6×6px
  - **Correction**: diamond, `--node-correction`, 12px
  - **Amendment**: hexagon, `--node-amendment`, 14px

- Edges:
  - `DERIVED_FROM`: solid line, `--edge-derived`
  - `CHANGED_BY`: solid line with arrow, `--edge-changed`
  - `EQUIVALENT_TO`: dashed line, `--edge-equivalent`
  - `CONFLICTS_WITH`: solid line, `--edge-conflict`, with ⚠ glyph
  - `AMENDS`: thick solid arrow, `--node-amendment`

- Controls (top-right floating panel):
  - Layout: Force / Hierarchical / Timeline (radio)
  - Filter by edge type (multiselect)
  - Filter by node type (multiselect)
  - "Highlight changes since [date picker]"
  - "Focus on field" — type a field path, focuses graph on that field's local subgraph
  - Zoom in/out, fit-to-view, reset

- Interactions:
  - Hover node → tooltip with details, edges fade except connected
  - Click node → side drawer opens with full details
  - Double-click node → focus the graph on this node's local neighborhood (2-hop)
  - Cmd+click → multi-select, show subgraph
  - Right-click → context menu (focus, hide, export)

- Legend at bottom-right (collapsible)

### 7.5 — Side drawer for node details

400px wide, slides from right. For a USDM Field node, shows:

```
┌────────────────────────────────────────┐
│ × USDM Field · ELIG-007                │
├────────────────────────────────────────┤
│ Path: Study › Population › Criteria    │
│ Created: Mar 12, 2024 at 14:23 UTC     │
│ Last modified: Jan 18, 2026 at 09:45   │
│ Current value: "ECOG 0, 1, or 2"       │
│ Confidence: 94%                         │
├────────────────────────────────────────┤
│ INCOMING EDGES                          │
│ ▸ DERIVED_FROM Protocol v3.0 § 4.2.1   │
│ ▸ CHANGED_BY 4 corrections              │
│ ▸ AMENDS prior version                  │
├────────────────────────────────────────┤
│ OUTGOING EDGES                          │
│ ▸ EQUIVALENT_TO ELIG-007 (in v2.3)     │
├────────────────────────────────────────┤
│ [View in Workbench]                     │
│ [View source span]                      │
│ [Export PROV-O bundle]                  │
└────────────────────────────────────────┘
```

### 7.6 — Impact analysis (for amendments)

A dedicated mode within the Lineage Explorer, accessible via a button "What did Amendment 03 change?". Shows:

- Top bar: "Amendment 03 · Applied Jun 12, 2025"
- Left: list of changed USDM fields, grouped by section, count badges
- Center: graph view focused on the changed subgraph
- Right: cumulative summary statistics (X fields changed, Y added, Z removed; M reviewer interventions; N% applied automatically)

### 7.7 — Export

- "Export PROV-O bundle" — generates W3C PROV-O JSON-LD download
- "Export graph as SVG / PNG" — for inclusion in audit reports
- "Generate audit report (PDF)" — full audit-ready document

---

## 8. Detail Spec — The Knowledge Graph Surface

Demonstrates the compounding moat: standards knowledge + sponsor knowledge accumulating across conversions.

### 8.1 — Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Knowledge Graph                                                         │
├──────────────┬──────────────────────────────────────────────────────────┤
│              │                                                           │
│ FILTERS      │              MAIN GRAPH CANVAS                            │
│              │                                                           │
│ ▢ Standards  │   (large interactive force-directed graph,                │
│   ▢ USDM     │    same library as Lineage Explorer)                      │
│   ▢ M11      │                                                           │
│   ▢ CDASH    │                                                           │
│   ▢ SDTM     │                                                           │
│   ▢ ICH E9   │                                                           │
│              │                                                           │
│ ▢ Sponsor    │                                                           │
│   ▢ Studies  │                                                           │
│   ▢ Endpoints│                                                           │
│   ▢ BCs used │                                                           │
│   ▢ TA conv- │                                                           │
│     entions  │                                                           │
│              │                                                           │
│ ▢ Bridges    │                                                           │
│   (cross-    │                                                           │
│   walks)     │                                                           │
│              │                                                           │
├──────────────┤                                                           │
│ STATS        │                                                           │
│ Nodes: 14,832│                                                           │
│ Edges: 38,471│                                                           │
│ Studies:  47 │                                                           │
│ BCs reused:  │                                                           │
│   2,341      │                                                           │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### 8.2 — Three sub-graphs visible in one canvas

- **Standards sub-graph** (USDM classes, M11 sections, CDISC BCs, CDASH variables, SDTM targets, E9 estimands) — left half by default
- **Sponsor sub-graph** (sponsor's converted studies, reused endpoints, sponsor BC variants, TA templates) — right half
- **Cross-walks** between the two — drawn as bridge edges in `--brand-secondary`

Visualizing the cross-walks is the point: it shows that the sponsor's studies are *grounded in* the standards. Pfizer judges see "this sponsor's body of work is anchored to CDISC standards" — that's a strong narrative.

### 8.3 — Search and traversal

- Top search bar: type any concept (USDM class name, BC name, study ID, endpoint), graph focuses
- Path-finder: select two nodes, "Find paths between them" — highlights shortest paths
- Saved views: "Show me all studies using endpoint OS (overall survival)" — saved query, instantly reproducible

### 8.4 — Insights panel (right drawer)

When zoomed in on a node, the panel shows analytics:

- **For a BC**: "Used in 14 studies · last modified: 2 weeks ago · 3 sponsor variants"
- **For a USDM class**: "Population class — used in 47 studies, 312 instances"
- **For a study**: "47 endpoints, 14 BCs, 8 amendments — view in Lineage"
- **For a TA pattern (e.g., Phase 2 Oncology)**: "Common arms structure, common endpoints, sample SoA"

### 8.5 — "Compounding asset" demo moment

A scripted button at the top: **"Show growth over time"** — animates the graph from "first month" (sparse) to "today" (dense, with rich cross-study patterns). 6-second animation. This is a deliberate demo moment for the Pfizer judges — visualizing the moat.

---

## 9. Detail Spec — Provenance, Errors, and the Quality Dashboard

### 9.1 — Quality Dashboard layout (`/quality-dashboard`)

The Pfizer-acceptance-criteria dashboard. 4×2 grid of large tiles. Each tile is a **whole product** — large hero metric, sparkline, breakdown, drill-down link.

```
┌────────────────────────────────┬────────────────────────────────┐
│  PROVENANCE OF ACCURACY         │  RELIABILITY                    │
│  98.7%                          │  99.97% uptime                 │
│  field-level accuracy           │  3.2 min MTTR                  │
│  ▁▂▂▃▄▅▆▇█ trending up         │  ▁▁▁▁▁▁▁▁▁ stable              │
│  ► Drill into provenance        │  ► View incident history        │
├────────────────────────────────┼────────────────────────────────┤
│  SCALABILITY                    │  REGULATORY COMPLIANCE          │
│  47 / 200 capacity              │  100% audit completeness        │
│  P95: 18m end-to-end            │  CSV/GAMP 5: in compliance      │
│  ▁▂▃▂▁▂▃▄▃ growing demand      │  ► View compliance report       │
├────────────────────────────────┼────────────────────────────────┤
│  COST EFFECTIVENESS             │  PERFORMANCE                    │
│  $147 per protocol              │  P95 18m / target 30m           │
│  -34% vs baseline               │  P99 24m                        │
│  ▇▆▅▄▃▂▁▁▁ trending down       │  All skills under target        │
├────────────────────────────────┼────────────────────────────────┤
│  USER EXPERIENCE                │  INTEGRATEABILITY               │
│  4.2h reviewer time / study     │  10/10 integrations green       │
│  -47% vs first month            │  98.4% event delivery           │
│  ► Reviewer satisfaction        │  ► Integration health detail    │
└────────────────────────────────┴────────────────────────────────┘
```

Each tile:
- Card style with `--shadow-sm`, `--radius-lg`, padding 24px
- Top: criterion name (text-meta uppercase), small icon
- Middle: hero metric in `text-display-lg` (Fraunces serif!), supporting metric below
- Bottom: sparkline showing trend, drill-down link

The sparkline is generated with **Recharts**; small (~80×24px), no axes, just the line in the metric's color.

Click any tile → opens the criterion's detail drill-down page.

### 9.2 — Provenance — drill-down view

`/provenance` for cross-study and `/conversions/:id/provenance` for single study.

Layout:

- **Top bar**: filter by study, by skill, by date range, by confidence threshold
- **Coverage chart**: % of fields with full provenance, broken down by skill — should be ~100%
- **Confidence distribution**: histogram showing distribution of confidence scores across all fields
- **Recent corrections**: table of corrections with reason codes
- **Provenance audit explorer**: searchable table of every (USDM field, source span, model version, confidence) record

When the user clicks a row → opens the **Provenance Drawer** (right side, 480px wide):

```
┌────────────────────────────────────────────┐
│ × Provenance · ELIG-007 · v2.3              │
├────────────────────────────────────────────┤
│ USDM PATH                                   │
│ Study › Population › InclusionCriteria      │
│       › ELIG-007                            │
│                                             │
│ VALUE                                       │
│ "Subjects must have ECOG performance        │
│  status of 0 or 1"                          │
│                                             │
│ EXTRACTION DETAILS                          │
│ Model: anthropic.claude-sonnet-4-5-...      │
│ Skill: extract_eligibility v3.2.1           │
│ Iteration: 2 of 3                           │
│ Confidence: 0.87                            │
│ Generated: Mar 12, 2024 14:23 UTC           │
│ Run ID: CONV-2026-04-127                    │
│                                             │
│ SOURCE                                      │
│ Document: NCT05847219_Protocol_v1.0.pdf    │
│ Page: 23                                    │
│ Section: 4.2.1 Inclusion Criteria          │
│ Span: chars 1402–1460                       │
│ ┌─────────────────────────────────────┐    │
│ │ "...Subjects must have ECOG perfor- │    │
│ │  mance status of 0 or 1, with no   │    │
│ │  evidence of progressive..."        │    │
│ └─────────────────────────────────────┘    │
│ [Open in protocol pane]                     │
│                                             │
│ VALIDATION                                  │
│ ✓ Schema  ✓ Faithfulness  ⚠ Completeness    │
│                                             │
│ AUDIT TRAIL                                 │
│ Mar 12 — Created (auto)                     │
│ Mar 14 — Reviewed by Anita Rao (DM)         │
│ Mar 14 — CT code added (correction)         │
│ Jan 18 — Re-extracted (model upgrade)       │
│                                             │
│ [Export PROV-O] [View in Lineage]           │
└────────────────────────────────────────────┘
```

This is the screen that proves "Provenance of Accuracy" criterion in seconds.

### 9.3 — Errors and validation failures

A separate view at `/conversions/:id/conformance` (Conformance Report) shows validation outcomes:

**Layout:**
- Summary header: Pass / Fail stats, % conformance, runs taken
- Tabs: Schema · Conformance (CRS) · Faithfulness · Completeness · Round-trip · Downstream Readiness
- Each tab shows a structured list of pass/fail items with drill-downs

**Error item card:**
```
┌────────────────────────────────────────────────────────────┐
│ ❌ FAIL · CRS-USDM-127                                       │
│ Population POP-01 has no associated InclusionCriterion      │
│                                                             │
│ Severity: Error                                             │
│ Source: USDM CRS v4.0 rule CRS-USDM-127                    │
│ Affected USDM path: Study › Population › POP-01            │
│                                                             │
│ Suggested fix: Link at least one EligibilityCriterion to    │
│ POP-01 via includesCriterionRef                             │
│                                                             │
│ [Open in Workbench]  [Apply auto-fix]  [Acknowledge]       │
└────────────────────────────────────────────────────────────┘
```

**Error states are part of the design language — when something fails, the UI is honest, specific, and actionable.** This is itself a credibility signal to Pfizer.

### 9.4 — Self-correction loop visualization

When a conversion completes, a small inline visualization shows the self-correction journey:

```
Iteration 1 ────► 23 errors ────► refine
Iteration 2 ────► 8 errors  ────► refine
Iteration 3 ────► 2 errors  ────► to HITL
                          ▲
                  (terminated, handed to reviewer)
```

This proves point 10 of the brief — visible self-evaluation and auto-correction.

### 9.5 — Audit Trail (`/audit-trail`)

Append-only ledger browser. Designed to look like a serious audit tool, not a UI.

- Search bar with structured filters: actor, action type, target, date range, severity
- Table of events, default sorted descending by timestamp
- Each row: timestamp · actor · action · target · result · hash
- Click row → modal with full event JSON, prior-event hash, next-event hash
- Export: "Export filtered events as CSV / JSON / PROV-O"
- Visual cue: a subtle vertical "chain" line connects events showing the Merkle chain

---

## 10. Auth, Settings, and Notifications

### 10.1 — Login (`/login`)

The first impression. Critical screen.

**Layout** — split-screen, 50/50 on desktop:

**Left half** (`--brand-primary` background):
- MaxisAI color logo, top-left, 40px tall
- Centered: large display text in Fraunces, white:
  - "Digitize protocols. Prove every value."
  - Sub-headline in `--brand-secondary-soft`: "USDM Generation Platform · Pfizer DDF Challenge"
- Bottom-left: small caption "Powered by AWS Bedrock · CDISC USDM v4.0 · ICH M11"
- Subtle visual: animated noise-textured gradient overlay, very low opacity, slow drift

**Right half** (`--surface-base` background):
- Centered card, 400px wide
- "Sign in to continue" header (text-h1)
- Email field
- Password field (with eye toggle)
- "Remember me" checkbox + "Forgot password?" link
- Primary "Sign in" button (full width)
- Below button: small "or" divider
- "Continue with SSO" secondary button (greyed out with "Available after Challenge" tooltip)
- Footer: "© MaxisAI · Privacy · Terms · v1.0.0"

For the Challenge, mock auth: any email matching `*@maxisai.com` or `*@pfizer.com` plus password `demo` logs in. Demo banner at top of every page when in demo mode.

### 10.2 — Forgot password (`/forgot-password`)

Same split-screen layout. Right side: "Enter your email" field + "Send reset link" button. Success state: "Check your email — link expires in 30 minutes."

### 10.3 — Settings (`/settings/*`)

Settings is a sub-app with left rail navigation:

```
┌──────────────┬──────────────────────────────────────────┐
│ Profile      │  [Active settings panel]                  │
│ Preferences  │                                           │
│ Security     │                                           │
│ API Keys     │                                           │
│ ─────        │                                           │
│ Tenant       │  ← admin only                             │
│ Integrations │  ← admin only                             │
│ Billing      │  ← admin only                             │
└──────────────┴──────────────────────────────────────────┘
```

**Profile** — name, email, role(s), avatar upload, time zone.

**Preferences** — theme (Light/Dark/System), density (Compact/Comfortable/Spacious), notification preferences (toggle per type), keyboard shortcuts customization, default landing page.

**Security** — Change password, enable MFA (TOTP setup with QR code mock), active sessions list with "Sign out other sessions" button, login history table.

**API Keys** — list of API keys (masked, with last-used date), "Generate new key" button, scope selection.

**Tenant** (admin) — tenant name, logo upload, brand color override, retention policy, data residency confirmation (US locked for Challenge), MDR connection status.

**Integrations** (admin) — see Section 9.6 below.

### 10.4 — Notifications page (`/notifications`)

Full-page version of the notifications drawer. Same content, more space.
- Tabs: All / Unread / Mentions / System
- Filters: by type, by date, by actor, by study
- Mark all as read
- Notification preferences shortcut

### 10.5 — Help (`/help`)

- Quick start guide (illustrated)
- Keyboard shortcuts reference
- Glossary (USDM, M11, CDASH, etc. — same as architecture appendix)
- Video walkthroughs (placeholder for demo)
- Contact support

### 10.6 — Integrations page (`/integrations`)

For tenant admins. The "Integrateability" criterion is proven here.

**Layout:**
- Top: 4 large status tiles — REST API · Event Bus · Webhooks · File Drop — each green/amber/red
- Below: tabs for each integration pattern, with detail
- Each integration: status, recent activity, configuration, test button

For demo: include a "Run integration test" button that simulates pinging each integration and showing real-time green checkmarks appearing — visual proof for Pfizer judges.

**Connectors table** below: Veeva Vault eTMF, Veeva EDC, Medidata Rave, Oracle InForm, ClinicalTrials.gov PRS, EU CTIS — each row shows status, last-tested, configure button.

---

## 11. Mock Data Manifest

Realistic mock data is the difference between "demo" and "credible". All mock data should use this manifest. **Do not invent generic placeholders during build.**

### 11.1 — Studies (mock corpus, 8 studies for demo)

| Study ID | Sponsor | Title | Phase | TA | Status |
|---|---|---|---|---|---|
| `NCT05847219` | Pfizer | Onc-2026: Pembrolizumab + chemotherapy in advanced NSCLC | 2 | Oncology | Active conversion |
| `NCT05912047` | Pfizer | CV-2025-04: Atorvastatin in primary prevention, elderly cohort | 3 | Cardiovascular | Completed |
| `NCT06024518` | Pfizer | Vacc-2026: Bivalent mRNA vaccine, immunogenicity | 2/3 | Vaccines | In review |
| `NCT05768423` | Pfizer | CNS-2026-02: Ponesimod in relapsing MS, extension | 3 | CNS | Amendment 03 in flight |
| `NCT05634891` | Pfizer | Onc-2025-11: Palbociclib first-line metastatic breast cancer | 3 | Oncology | Completed |
| `NCT06158732` | Pfizer | Pain-2026: Tanezumab in osteoarthritis (knee), dose-finding | 2 | Pain | New conversion |
| `NCT05891234` | Pfizer | Endo-2026: GLP-1 agonist in T2DM with CKD | 3 | Endocrine | In review |
| `NCT06281547` | Pfizer | Inflam-2026: JAK1 inhibitor in moderate UC | 2 | Inflammation | Conversion failed CRS |

### 11.2 — Realistic eligibility criteria examples

For inclusion criterion mock display:

```
INCLUSION:
  IC-01: Adults ≥ 18 years of age at signing of informed consent
  IC-02: Histologically or cytologically confirmed metastatic NSCLC
  IC-03: Measurable disease per RECIST v1.1
  IC-04: ECOG performance status of 0 or 1
  IC-05: Adequate organ function defined as:
    - ANC ≥ 1.5 × 10⁹/L
    - Hemoglobin ≥ 9.0 g/dL
    - Platelet count ≥ 100 × 10⁹/L
    - Total bilirubin ≤ 1.5 × ULN
    - AST/ALT ≤ 2.5 × ULN (≤ 5 × ULN if liver metastases)
    - Creatinine clearance ≥ 50 mL/min
  IC-06: Estimated life expectancy ≥ 12 weeks
  IC-07: Female subjects of reproductive potential must agree to use highly effective contraception

EXCLUSION:
  EX-01: Prior systemic therapy for metastatic NSCLC
  EX-02: Active CNS metastases
  EX-03: Active autoimmune disease requiring systemic immunosuppression in past 2 years
  ...
```

### 11.3 — Realistic CDISC CT codes used in demo

| Concept | C-code | Codelist |
|---|---|---|
| ECOG Performance Status | C102680 | ECOGPER |
| Phase 2 Trial | C15601 | TPHASE |
| Inclusion | C25532 | NY |
| Female | C16576 | SEX |
| Overall Survival | C25717 | ENDPOINT |
| Progression-Free Survival | C49331 | ENDPOINT |
| Randomized | C25196 | DESIGN |
| Double Blind | C15228 | BLINDSCHEMA |
| Placebo Controlled | C49648 | TCNTRL |

### 11.4 — Realistic biomedical concepts

- Body Temperature (`C174127`)
- Systolic Blood Pressure (`C25298`)
- Diastolic Blood Pressure (`C25299`)
- Heart Rate (`C49677`)
- Hemoglobin (`C64848`)
- Absolute Neutrophil Count (`C82228`)
- ECOG Performance Status (`C102680`)
- Tumor Response per RECIST 1.1 (`C181048`)

### 11.5 — User personas for mock data

| Name | Role | Avatar initial | Notes |
|---|---|---|---|
| Anita Rao | Standards / Data Manager | AR | Most active reviewer in mock data |
| Dr. Vikram Patel | Biostatistician / SME | VP | Adjudicates estimands |
| Sarah Chen | Clinical Reviewer | SC | Owns eligibility reviews |
| Marcus Thompson | Clinical Reviewer | MT | Owns interventions |
| Elena Volkov | Tenant Admin | EV | Pfizer admin user |
| James Mitchell | Executive (Pfizer judge persona) | JM | The view Pfizer judges will use |
| Rajesh Kumar | Super Admin (MaxisAI) | RK | Cross-tenant view |

### 11.6 — Mock conversion runs

For the Workbench / Lineage demos:

- `CONV-2026-04-127` — NCT05847219, currently in review, 47 flagged items
- `CONV-2026-04-128` — NCT06158732, completed, 100% auto-accepted
- `CONV-2026-04-129` — NCT06281547, failed CRS at iter 5, awaiting SME
- `CONV-2026-03-098` — NCT05768423, amendment 03 application in flight

Each has a realistic timestamp, duration, model version, and outcome.

### 11.7 — Mock notifications

A pre-loaded set of 20 notifications spanning the last 7 days, mixing types, with realistic actor names from 11.5 and study IDs from 11.1.

### 11.8 — Mock M11 protocol content

For the Reviewer Workbench left pane and Doc Studio round-trip diff, include three to five realistic protocol sections in M11 format:
- 1 — Title page and protocol summary
- 4.1 — Trial design overview
- 4.2.1 — Inclusion criteria (with the 7 ICs above)
- 4.2.2 — Exclusion criteria
- 6.1 — Schedule of activities (rendered as a table)

Use realistic clinical narrative voice. The text should read like a real Pfizer protocol, not Lorem ipsum.

---

## 12. Implementation Guidance for Claude Code

### 12.1 — Tech stack

- **Framework**: Next.js 14+ (App Router) + React 18
- **Styling**: Tailwind CSS with custom design tokens from Section 2.1; CSS-in-JS only where needed
- **State**: Zustand for client state, TanStack Query for mock data fetching layer (so backend swap is trivial)
- **Forms**: React Hook Form + Zod
- **Tables**: TanStack Table v8
- **Charts**: Recharts (sparklines, simple charts) + react-force-graph-2d (lineage + KG)
- **Document rendering**: `react-pdf` for PDF preview, `mammoth` for DOCX, custom prose renderer for protocol body
- **Icons**: lucide-react
- **Animations**: Framer Motion (for page transitions and subtle UI motion)
- **Code highlighting** (for JSON viewers): Prism React or Shiki
- **Diff view**: `react-diff-viewer-continued`

### 12.2 — File structure

```
/app
  /(auth)
    /login/page.tsx
    /forgot-password/page.tsx
  /(app)/
    /layout.tsx                      # Sidebar + topbar shell
    /page.tsx                        # Dashboard (role-aware)
    /conversions/...
    /review-queue/...
    /lineage/...
    /provenance/...
    /knowledge-graph/...
    /audit-trail/...
    /quality-dashboard/...
    /integrations/...
    /settings/...
/components
  /shell        # Sidebar, TopBar, CommandPalette
  /ui           # Buttons, Inputs, Modals, Toasts
  /domain       # Workbench, LineageGraph, ProvenanceDrawer, etc.
  /charts       # Sparkline, ForceGraph, Heatmap
/lib
  /mock-data    # All mock fixtures (Section 11)
  /design-tokens.css
  /role-guard.ts
/styles
  globals.css
/public
  /brand
    maxisai-logo-white.svg           # ← Drop the actual logo file here
    maxisai-logo-color.svg
```

### 12.3 — Build order recommendation

If building incrementally, build in this order to maximize early demo value:

1. **Design system + shell** (tokens, sidebar, topbar, theme switching)
2. **Login + Dashboard (Executive role)** — the first impression
3. **Quality Dashboard** — proves all 8 acceptance criteria visually
4. **Reviewer Workbench** — the daily-use power surface
5. **Lineage Explorer (timeline + graph view)** — the demo wow moment
6. **Provenance drawer** — the "why this value" moment
7. **Conversions list + Conversion Detail** — the operational backbone
8. **Knowledge Graph** — the moat narrative
9. **Doc Studio** — round-trip and downstream artifacts
10. **Integrations + Audit Trail** — the enterprise credibility
11. **Settings, Notifications, Adjudications, Models & Skills, Tenants, System Health** — completing coverage

### 12.4 — Demo mode

Include a "DEMO" badge in the topbar (next to env). When in demo mode:
- All data is mock from Section 11
- Auth is open (any `*@pfizer.com` or `*@maxisai.com` email)
- A "Reset demo data" action is available in Settings → System
- A "Demo script" link in the top-bar that opens a guided tour overlay highlighting key features one by one

### 12.5 — Performance targets

- Initial load (LCP): < 2.0s on broadband
- Route transitions: < 200ms perceived
- Force-graph render: < 500ms for graphs up to 1,000 nodes
- Workbench item navigation: < 100ms
- Search: < 80ms with mock data

### 12.6 — Things NOT to do

- ❌ Do not generate purple gradients anywhere
- ❌ Do not use emoji as functional UI (only in toasts and dashboards as illustrative)
- ❌ Do not use Inter (use Inter Tight) or Roboto
- ❌ Do not use rounded-3xl or pill-shaped buttons everywhere — restraint is the point
- ❌ Do not invent CDISC codes, NCT numbers, or sponsor terminology — use the manifest
- ❌ Do not use bouncing/spring animations
- ❌ Do not show "powered by AI" badges or AI cliché copy
- ❌ Do not use generic stock illustrations — use the lucide icons or commission small branded illustrations later

### 12.7 — Things that MUST be done

- ✓ Every USDM value display includes a "Why this value?" affordance
- ✓ Every page has a meaningful empty state
- ✓ Every async action has a loading state and an error state
- ✓ Every destructive action has a confirmation
- ✓ Every keyboard-actionable element has a shortcut hint visible on hover
- ✓ Every dashboard tile maps to one of Pfizer's 8 acceptance criteria
- ✓ Mock data is from Section 11 (use exact study IDs, names, criteria)
- ✓ Theme toggle works on every screen
- ✓ Role switching works without reload
- ✓ Demo mode banner is always visible until logged in as a real user

---

## Appendix A — Page-by-page screen catalog (quick reference)

| # | Page | Hero element | Critical components |
|---|---|---|---|
| 1 | Login | Split-screen brand statement | Auth form, brand panel |
| 2 | Dashboard (Reviewer) | "My queue" hero card | Queue card, in-progress list |
| 3 | Dashboard (Executive) | 4×2 acceptance criteria tiles | 8 tiles with sparklines |
| 4 | Conversions list | Filterable conversions table | Data grid, filter rail |
| 5 | New Conversion | Drag-drop upload area | File picker, study metadata form |
| 6 | Conversion Detail | Status header + tabs | Tabs: Overview, Workbench, Lineage, etc. |
| 7 | Reviewer Workbench | 3-pane review surface | Protocol pane, USDM pane, provenance pane |
| 8 | Lineage Explorer | Timeline / Field / Graph views | Three view modes, side drawer |
| 9 | Knowledge Graph | Force-directed network | Filter rail, graph canvas, insights panel |
| 10 | Provenance | Coverage chart + audit table | Drill-down drawer |
| 11 | Conformance Report | Pass/fail summary + tabs | Validation result cards |
| 12 | Doc Studio | M11 round-trip diff | Per-artifact tabs |
| 13 | Quality Dashboard | 4×2 criteria tiles | 8 tiles, drill-downs |
| 14 | Integrations | Status tiles + connectors | Health tiles, connectors table |
| 15 | Audit Trail | Searchable event ledger | Filter bar, table, event modal |
| 16 | Models & Skills | Model registry table | Model cards, skill registry |
| 17 | Eval Sets | Frozen eval performance | Eval set table, model comparison |
| 18 | Users & Roles | User table + role assignments | User table, role matrix |
| 19 | Tenants (SuperAdmin) | Cross-tenant scorecard | Multi-tenant table |
| 20 | System Health (SuperAdmin) | Service status grid | Service tiles, recent events |
| 21 | Settings | Sectioned sub-app | Profile, prefs, security, etc. |

---

## Appendix B — Document History

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-05-01 | Rajesh / MaxisAI Architecture | Initial UI Design Specification for Pfizer DDF Challenge build |
