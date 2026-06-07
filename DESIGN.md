---
name: Fleet Dashboard
description: An operator's cockpit for reviewing Docker feature branches — a TUI rendered in the browser.
colors:
  bg: "#0a0a0a"
  bg-black: "#000000"
  surface: "#111111"
  surface-raised: "#161616"
  surface-header: "#1a1a1a"
  border: "#222222"
  border-strong: "#333333"
  ink: "#eeeeee"
  ink-muted: "#b8b8b8"
  ink-dim: "#888888"
  ink-faint: "#555555"
  accent: "#00ff88"
  caution: "#ffb000"
  building: "#ffaa00"
  transient: "#00aaff"
  danger: "#ff4444"
  source-nginx: "#66d9ef"
  source-postgresql: "#e6a700"
typography:
  display:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "0.9rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "0.68rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "normal"
  micro:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "0.65rem"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
rounded:
  all: "0"
spacing:
  "05": "0.2rem"
  "1": "0.25rem"
  "15": "0.4rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "6": "1.5rem"
  "8": "2rem"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.all}"
    padding: "2px 7px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg-black}"
  button-caution:
    backgroundColor: "transparent"
    textColor: "{colors.caution}"
    rounded: "{rounded.all}"
    padding: "2px 7px"
  button-caution-hover:
    backgroundColor: "{colors.caution}"
    textColor: "{colors.bg-black}"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.all}"
    padding: "2px 7px"
  button-destructive-hover:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg-black}"
  card-feature:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.all}"
    padding: "{spacing.3}"
  card-feature-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.accent}"
  input-inline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.all}"
---

# Design System: Fleet Dashboard

## 1. Overview

**Creative North Star: "The Status Line"**

Fleet is a well-built TUI that happens to render in a browser. Every surface is
a status line first and a control surface second: it answers "what state is this
container in?" before it offers a button to change that state. The whole system
is built from one monospace face, a near-black field, and a small set of colors
that mean exactly one thing each. There is no chrome that does not report
something true. Color, label, and motion are instruments, never decoration.

Density is the posture, not a compromise. These are power users reading dense
state across several live branches at once; the layout packs lifecycle dots,
branch names, source labels, and action rows legibly rather than spreading them
across airy cards. Every empty pixel has to earn its place. Where a generic
dashboard would reach for a rounded card with a soft shadow, Fleet uses a flat
panel, a 1px hairline, and a single accent stroke to mark what is selected.

This system explicitly rejects the friendly-corporate SaaS dashboard (rounded
cards, pastel gradients, hero metrics, Inter-on-white). It rejects the
hosted-platform deploy-console look (Vercel / Netlify marketing surfaces); Fleet
is local-first and operator-facing, not a product being sold. And it rejects
costume-terminal skeuomorphism: no CRT curvature, no heavy phosphor glow as
ornament, no decorative ASCII. The terminal aesthetic here carries information,
not nostalgia. The one scanline overlay is a 3%-opacity texture, deliberately
faint enough to read as surface, not as a CRT cosplay.

**Key Characteristics:**
- Single monospace face (JetBrains Mono) across headings, labels, data, and controls.
- Near-black field (`#0a0a0a`) with tonal layering, not shadows, for depth.
- Zero border radius everywhere, enforced globally with `!important`.
- One color = one meaning: a strict lifecycle palette where every hue is a state.
- State always travels as color **and** text (`● UP`, `● BUILDING`); never color alone.
- Motion reserved for transient states (blink) and structural change (drawer slide).

## 2. Colors

A near-black operator field carrying a strict lifecycle palette, where each hue
names exactly one container state and the single phosphor-green accent marks
"affirmative" and "selected."

### Primary
- **Phosphor Green** (`#00ff88`): The one true accent. Marks the live/healthy
  `● UP` state, the active feature's title and 3px selection stroke, primary
  action buttons, and the gateway-up indicator. Its rarity is the point; it is
  the eye's anchor in a near-black field.

### Secondary
- **Caution Amber** (`#ffb000`): Use-with-care actions (the SYNC rebuild
  button). The button-tone amber. Distinct in role from the lifecycle ambers below.
- **Build Amber** (`#ffaa00`): The `● BUILDING` / `● UNHEALTHY` lifecycle state.
  Paired with blink while a build is in flight.
- **Transient Blue** (`#00aaff`): In-flight lifecycle states that are neither
  terminal nor settled: `● STARTING`, `● RESTARTING`. Always blinks.

### Tertiary
- **Danger Red** (`#ff4444`): The `● FAILED` / `● DOWN` lifecycle state, the
  destructive KILL button, the confirm-fill on guarded actions, and all inline
  `role="alert"` error text. Reserved for irreversible or broken.
- **Source Cyan** (`#66d9ef`) and **Source Ochre** (`#e6a700`): Per-source log
  tints in the ALL log view (nginx, postgresql). Used only to disambiguate
  interleaved log streams; never as UI accents elsewhere.

### Neutral
- **Field Black** (`#0a0a0a`): The body background. The default surface.
- **True Black** (`#000000`): The status bar and the iframe backdrop; one step
  below the field to seat the top chrome.
- **Surface** (`#111111`) / **Surface Raised** (`#161616`): Panel and
  active/hover card fills. Tonal layering substitutes for elevation.
- **Header Surface** (`#1a1a1a`): Diff-file and section header bands.
- **Border** (`#222`) / **Border Strong** (`#333`): 1px hairlines. `#222` for
  card and panel dividers, `#333` for header bands and the scrollbar thumb.
- **Ink** (`#eee`): Primary body text and active control labels.
- **Ink Muted** (`#b8b8b8`): Secondary text (branch names, feature counts) that
  must still clear 4.5:1 on the field.
- **Ink Dim** (`#888`) / **Ink Faint** (`#555`): Tertiary labels, the
  not-started instruction text, collapse chevrons. The known contrast-risk band.

### Named Rules
**The One Meaning Rule.** Every color names exactly one thing. Green is
affirmative-and-selected; amber is in-progress-or-caution; blue is transient;
red is broken-or-destructive. Never reuse a lifecycle hue for decoration, and
never introduce a new accent hue for flavor. If a new state needs a color,
extend the lifecycle map in `featurePresentation.js`, do not paint outside it.

**The Color-Plus-Label Rule.** State is never conveyed by color alone. Every
lifecycle indicator ships its hue **and** a text label (`● UP`, `● BUILDING`,
`● FAILED`). This is an accessibility invariant, not a style choice; preserve it
on every new status surface.

**The Dim-Floor Rule.** `#555` and `#444` on near-black are the known
sub-4.5:1 risk. Body and label text use `#eee` or `#b8b8b8`. Reserve `#888`/`#555`
for genuinely tertiary, non-essential text (instructions, decorative chevrons),
and verify contrast rather than assuming it.

## 3. Typography

**Display / Body / Label Font:** JetBrains Mono (with Fira Code, Cascadia Code,
monospace fallbacks)

**Character:** One monospace family does all the work. There is no display/body
pairing; hierarchy comes from size and weight, not from a second face. The fixed
character grid is the point: columns line up, dots and labels align, and the
interface reads like a terminal because it is built on the same constraint a
terminal is.

### Hierarchy
- **Display** (700, 0.9rem, 1.2): The active feature title and the strongest
  in-card label. Bold mono, not a large heading; product UI does not shout.
- **Title** (700, 0.75rem): Status bar identity (`[QA FLEET v1.0]`), gateway
  pill, section headers. Bold at body size.
- **Body** (400, 0.75rem, 1.4): Default text, gateway/feature-count readouts,
  log lines. Keep prose under 65–75ch; log and diff content runs denser.
- **Label** (400, 0.68rem): Branch names, status labels, action-button text,
  source chips. The dominant size in the dense card body.
- **Micro** (400, 0.65rem): Inline error text, not-started instructions, the
  smallest readable tier. Use sparingly; it is the floor.

### Named Rules
**The Fixed-Scale Rule.** Sizes are fixed rem, never `clamp()`. This is product
UI viewed at consistent DPI in a pinned tab; a fluid heading that shrinks inside
the sidebar looks worse, not better. The scale ratio is tight (~1.15) because
there are many type elements and exaggerated contrast would read as noise.

**The Bracket-Label Rule.** Action buttons wear their command in brackets:
`[ACTIVATE]`, `[STOP]`, `[SYNC]`, `[KILL]`. This is the system's one signature
flourish and it is deliberately literal, evoking a TUI keymap. Confirm and
loading states reuse the bracket grammar (`[CONFIRM?]`, `[...]`). Do not spread
the `// `-comment-prefix decoration onto every header; the critique flagged it
as reading friction. One signature, used consistently, not everywhere.

## 4. Elevation

Flat by default. There are no drop shadows anywhere in the system; depth is
conveyed entirely by **tonal layering** on a near-black field. The stack runs
True Black (`#000`, status bar) → Field Black (`#0a0a0a`, body) → Surface
(`#111`, panels) → Surface Raised (`#161616`, hover and active cards), each step
a few points lighter than the last. Separation between siblings is a 1px `#222`
hairline, not a shadow. The one global texture is a 3%-opacity 2px scanline
overlay fixed above everything; it reads as surface grain, not as elevation.

### Named Rules
**The No-Shadow Rule.** `box-shadow` is forbidden as decoration. A surface that
needs to read as "above" gets a lighter tonal fill (`#161616`) and/or a hairline
border, never a blur. If a thing looks like it is floating on a soft shadow, it
belongs to the SaaS-dashboard anti-reference and is wrong here.

**The Hairline Rule.** Dividers and panel edges are exactly 1px, `#222` for
content dividers and `#333` for header bands. Never a thick rule, never a colored
stripe wider than the one intentional 3px active-selection border.

## 5. Components

### Buttons
- **Shape:** Hard rectangle (0 radius, enforced by `border-radius: 0 !important`).
  1px border in `currentColor`; transparent fill at rest.
- **Tones (strict contract):** `primary` = phosphor green (affirmative,
  including reversible STOP/START — stop is not destructive); `caution` = amber
  (rebuild/restart, SYNC); `destructive` = red (irreversible KILL). One tone per
  meaning; never two tones for the same intent.
- **Default → Hover/Focus:** Outline-only at rest; on hover or focus the fill
  floods with the tone color and the text goes black (`#000`). Focus and hover
  share the treatment so keyboard and mouse read identically.
- **Disabled:** `opacity: 0.5`, `cursor: not-allowed`. Loading shows `[...]`.
- **Card sizing:** Action buttons in cards run small (`0.68rem`, `2px 7px`
  padding) so a full lifecycle row fits without wrapping on desktop.
- **Guarded actions:** Destructive and rebuild actions escalate in place: a
  first click arms the button (`[CONFIRM?]` / `[CONFIRM SYNC?]`) with a red
  fill; a second click commits. SYNC's arm auto-disarms after 3s.

### Cards (Feature Card)
- **Corner Style:** Hard rectangle (0 radius).
- **Background:** Transparent at rest; `#161616` on hover and when active or
  previewed. Tonal fill, no shadow.
- **Selection affordance:** A 3px `#00ff88` left border marks the active feature
  (transparent 3px reserved on every card so text never shifts). This is the one
  intentional thick colored edge in the system — a genuine selection state, not
  a decorative side-stripe.
- **Border:** 1px `#222` bottom hairline between cards.
- **Internal Padding:** `var(--space-3)` (0.75rem). Internal clusters use the
  tight steps (`--space-1`, `--space-15`, `--space-2`) to group branch → status → controls.
- **Dimmed state:** Not-started features render at `opacity: 0.7`.

### Inputs / Fields
- **Inline rename:** Transparent background, no box border, a single 1px accent
  underline (`border-bottom: 1px solid #00ff88`), no outline. Auto-focuses and
  selects-all on open; Enter commits via blur, Escape cancels. The field inherits
  the title's bold mono so editing feels in-place, not modal.
- **Search / filter:** Same mono, same flat treatment, consistent with the rest
  of the surface.

### Navigation
- **Status bar:** Full-width True-Black band, 40px min-height, three segments
  (`[QA FLEET v1.0]` identity · gateway state · feature count) spaced apart.
  Bottom 1px `#222` hairline. Wraps rather than clips below 768px.
- **Feature sidebar / drawer:** A fixed-width list of feature cards. Below 768px
  it becomes an off-canvas drawer (`position: fixed`, `transform: translateX`)
  so the preview fills full width; the scanline overlay stays above it.

### Status Indicator (signature component)
The lifecycle dot. A `●` glyph colored by state plus a text label, resolved by
`featurePresentation.js` from registry status (authoritative for terminal
states) refined by a live health probe (for the running case). Transient states
(`BUILDING`, `STARTING`, `RESTARTING`, `checking`) blink via the `blink`
keyframe (1s step-start). This component is the system's reason for existing;
every other surface defers to it for "what state is this in?".

### Dialog (Log Panel)
A real `<dialog>`-semantics modal: focus moves in on open, Escape and backdrop
close, focus is trapped (Tab wraps), and focus returns to the trigger on close.
Modals are the exception, not the reflex; reach for inline/progressive
disclosure first and reserve the modal for genuinely separate surfaces (logs,
config).

## 6. Do's and Don'ts

### Do:
- **Do** keep one monospace family (JetBrains Mono) for everything; build
  hierarchy from size + weight (~1.15 ratio), never a second face.
- **Do** ship every lifecycle state as color **and** a text label (`● UP`,
  `● FAILED`). The Color-Plus-Label Rule is an accessibility invariant.
- **Do** keep `border-radius: 0` everywhere; the hard rectangle is the identity.
- **Do** convey depth with tonal layering (`#000` → `#0a0a0a` → `#111` → `#161616`)
  and 1px hairlines, never shadows.
- **Do** hold the strict button-tone contract: green affirmative, amber caution,
  red destructive — one tone per meaning, screen to screen.
- **Do** reserve motion for transient states (blink) and structural change
  (drawer slide). Honor `prefers-reduced-motion` with a static alternative.
- **Do** verify muted-gray text against 4.5:1 on near-black before shipping it as
  body or label copy; prefer `#eee` / `#b8b8b8`.

### Don't:
- **Don't** build the friendly-corporate SaaS dashboard: no rounded cards, no
  pastel gradients, no hero-metric blocks, no Inter-on-white. Fleet is its opposite.
- **Don't** imitate hosted-platform deploy consoles (Vercel / Netlify marketing
  surfaces). This is a local-first operator tool, not a product being sold.
- **Don't** add costume-terminal skeuomorphism: no CRT curvature, no heavy
  phosphor glow as ornament, no decorative ASCII. The terminal carries
  information, not nostalgia.
- **Don't** hide current state behind animation or chrome: no spinners as
  decoration, no orchestrated page-load sequences. State must be legible at rest.
- **Don't** introduce a new accent hue or reuse a lifecycle color for decoration.
  One color, one meaning. Extend the lifecycle map instead of painting outside it.
- **Don't** add a colored side-stripe to cards or callouts. The single 3px
  green left border is a real selection affordance; do not multiply it into
  decorative accent stripes elsewhere.
- **Don't** use `box-shadow`, `clamp()` headings, or `#555`/`#444` for essential
  text. Flat, fixed-scale, and contrast-verified.
- **Don't** spread the `// `-comment-prefix label decoration onto every header;
  one signature flourish (the `[BRACKET]` labels), used consistently.
</content>
</invoke>
