# RM Inbox — interface checklist

Distilled from https://vercel.com/design/guidelines (MIT, vercel-labs/web-interface-guidelines) and the Refactoring UI
skill at https://skills.wondel.ai/skills/refactoring-ui/ (MIT). Not installed, not copied. Check a change against this
before you push. It is a phone-first, one-thumb app.

## Touch & input
- [ ] Hit targets are ≥ 44 px on mobile, and the visual target matches the hit area (no dead zones on a card or a row).
- [ ] Inputs, textareas and selects use font-size ≥ 16 px (iOS zooms on anything smaller). Zoom is never disabled.
- [ ] Buttons use `touch-action: manipulation`, and `-webkit-tap-highlight-color` matches the design.
- [ ] Paste is never blocked (token, URL and text fields). Values are trimmed, because share sheets add trailing whitespace.
- [ ] Every input has the right `type` / `inputmode` / `autocomplete` (`url` for links). Spellcheck is off on token and URL fields, and the token field doesn't trigger password managers.
- [ ] Every control has a label. Icon-only buttons have an `aria-label`.
- [ ] Every swipe (carousel slides) also works with a tap control.

## Feedback & state
- [ ] A loading button keeps its label and adds a spinner ("Sending…"). The spinner waits ~150–300 ms before showing and stays ≥ 300 ms, so it doesn't flicker.
- [ ] Optimistic sends: the item shows as sent at once. On failure, show the error and offer Retry/Undo.
- [ ] Destructive actions (Forget token, delete) ask for confirmation or offer Undo.
- [ ] Toasts and validation use polite `aria-live`.
- [ ] Error copy says how to fix it ("Token expired: paste a new one in Settings"), not just what broke.
- [ ] Every screen has a next step. Empty, sparse, long-content and offline states are all designed.
- [ ] Status never relies on colour alone (sent / failed / rendering always carries a word or an icon).
- [ ] The active tab and filter persist in the URL (`?tab=`), so Back and a refresh return to the same place.

## Layout & look
- [ ] Safe areas are respected (`env(safe-area-inset-*)`) at the top and bottom, including the bottom tab bar.
- [ ] Spacing follows one scale (4 / 8 / 12 / 16 / 24 / 32 / 48). The gap between groups is larger than the gap inside a group.
- [ ] Hierarchy passes the squint test: one primary action per screen, labels smaller and lighter than their values, and secondary buttons are outlined or text only.
- [ ] Shadows are layered (a tight one plus a soft one) and used sparingly. Borders are semi-transparent. Nested radii are concentric.
- [ ] Greys are tinted toward the brand blue. Text contrast is ≥ 4.5:1 for body and ≥ 3:1 for large text.
- [ ] `theme-color` and `color-scheme` match the page background (update both if a dark theme is added).
- [ ] Numbers that line up (counts, sizes, timings) use `tabular-nums`. Number and unit are glued with `&nbsp;` (12&nbsp;MB).
- [ ] Use … rather than "...", and curly quotes in copy.
- [ ] Images and video previews have explicit dimensions (no layout shift). Skeletons mirror the final layout exactly.

## Motion
- [ ] Honour `prefers-reduced-motion` (a reduced variant of every transition).
- [ ] Animate only `transform` / `opacity`, and never `transition: all`.
- [ ] Every motion has a reason (it shows cause and effect). No autoplay beyond muted, non-essential loops. Video slides play on tap.
