# Fleet Dashboard — Design System

This document is the written specification for the Fleet dashboard design vocabulary.
It supplements the token definitions in `src/index.css`.

---

## Colors

### Tonal ramp

| Token | Value | Role |
|---|---|---|
| `--color-bg-black` | `#000000` | Status bar / iframe backdrop |
| `--color-bg` | `#0a0a0a` | Body field |
| `--color-surface` | `#111111` | Panel / card fill |
| `--color-surface-raised` | `#161616` | Base hover / active card fill |
| `--color-surface-header` | `#1a1a1a` | Diff-file / section header band |

### Borders

| Token | Value | Role |
|---|---|---|
| `--color-border` | `#222222` | Content / card hairline |
| `--color-border-strong` | `#333333` | Header band / scrollbar thumb |

### Ink ramp

| Token | Value | Role |
|---|---|---|
| `--color-ink` | `#eeeeee` | Primary body text |
| `--color-muted` | `#b8b8b8` | Secondary text (≥ 4.5:1 on field) |
| `--color-ink-dim` | `#888888` | Tertiary labels |
| `--color-ink-faint` | `#555555` | Decorative-only glyphs (non-essential) |

### Lifecycle palette

The lifecycle palette signals the current state of a **container** — it is read-only
status information.  Do not repurpose lifecycle colours for interactive states.

| Token | Value | Lifecycle state |
|---|---|---|
| `--color-accent` | `#00ff88` | Phosphor green — affirmative / selected |
| `--color-caution` | `#ffb000` | Amber — use-with-care (SYNC button) |
| `--color-warning` | `#ffaa00` | Amber — BUILDING / UNHEALTHY |
| `--color-transient` | `#00aaff` | Blue — STARTING / RESTARTING |
| `--color-danger` | `#ff4444` | Red — FAILED / destructive |

### Interaction states

Interaction-state tokens describe the **control** state axis — what state is this
interactive element in right now?  They are functional aliases of the palette tokens
above; no new hues are introduced.

| Token | Derives from | Purpose |
|---|---|---|
| `--focus-ring` | `--color-accent` | 1 px keyboard-focus outline applied to every focusable element via the global `:focus-visible` rule |
| `--surface-hover` | `--color-surface-raised` | Fill applied to a row, card, or list item when the pointer enters it |
| `--surface-selected` | `--color-surface-raised` | Fill applied to the currently active / selected row or card |
| `--state-disabled-opacity` | `0.5` | Opacity multiplier for any disabled control |

#### Rules

1. **Never suppress `:focus-visible`.**  `outline: none` is only permitted on a plain
   `:focus` selector (mouse focus) or on `tabIndex="-1"` container elements that
   receive programmatic focus only.  Every keyboard-navigable control must show the
   `--focus-ring` outline.

2. **Global rule.**  `index.css` declares a global `:focus-visible { outline: 1px solid
   var(--focus-ring); outline-offset: 1px; }` that catches every element not already
   covered by a component-specific rule.

3. **Button tones.**  Each button tone (primary / caution / destructive) floods with its
   accent colour on `:hover` and `:focus`.  In addition, each tone adds an explicit
   `:focus-visible` rule with `outline-offset: 2px` so the green ring appears outside
   the filled button border on keyboard focus.

4. **Hover vs selected.**  Use `--surface-hover` for transient pointer-enter states and
   `--surface-selected` for persistent selected/active states.  Both currently resolve to
   `--color-surface-raised` (`#161616`), but separating the semantic layers means a
   future design pass can differentiate them (e.g. a tinted selected row) without
   hunting through components.

5. **Disabled.**  Use `opacity: var(--state-disabled-opacity)` on any disabled control.
   Do not hardcode `0.5`.

---

## Components

### Button primitive

Three tones, all sharing the same hover/focus grammar: outline at rest → accent
fill floods on hover/focus → focus-visible ring (2 px offset) on keyboard focus.

```
tone=primary      → --color-accent fill  (#00ff88)
tone=caution      → --color-caution fill (#ffb000)
tone=destructive  → --color-danger fill  (#ff4444)
```

Text colour inverts to `--color-bg-black` when the fill is applied.

### Feature card

Active / selected card: `background: var(--surface-selected)` + 3 px left accent border.

Hover (non-active): `background: var(--surface-hover)` on `mouseenter`, reset on
`mouseleave`.
