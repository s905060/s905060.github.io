# Agent instructions for s905060.github.io

This repo is a one-page resume site (`index.html`, served by GitHub Pages).

## Visual design rules

The target design is an infographic-style, interactive and animated resume.
This rule overrides "follow the existing design": the current static layout
is the starting point, not the standard. `scripts/check-visual.mjs` enforces
the rules marked (checked).

1. Each resume section is a `<section>` element. (checked)
2. Any section that states a metric (`$2M+`, `45%`, `10x`, `300TB`, `1M+ QPS`,
   `10ms`) shows it as a visual too: an inline SVG or canvas chart, a stat tile,
   or a timeline, marked with `svg`, `canvas`, or `[data-viz]`. Never prose
   alone. (checked)
3. Every section has an entrance animation or transition when it scrolls into
   view. Use `IntersectionObserver` plus CSS transitions; add no animation
   libraries. (checked)
4. The page has real interactive elements, such as expandable roles or a skills
   filter, built from `button`, `summary`, or `[aria-expanded]` controls. Every
   control works by keyboard and shows a visible focus ring. (checked)
5. All motion sits inside `@media (prefers-reduced-motion: no-preference)`. With
   reduced motion, nothing animates and all content is visible. (checked)
6. The page still prints cleanly: the print button must give a readable,
   static resume.
7. Charts follow the `dataviz` skill: direct labels, accessible colors, and an
   `aria-label` or text alternative on every chart.

## Skills

For any UI change, load `frontend-design` and `impeccable` (per the global
contract), plus `dataviz` for charts and stat tiles. Use `epic-infographics`
for standalone infographic images.

## Done means

- `node scripts/check-visual.mjs` passes. It needs a local Chrome; set
  `CHROME_PATH` if it can't find one.
- The PR body has before/after screenshots at desktop and mobile widths.

## Enforcement

- Claude Code: a `Stop` hook in `.claude/settings.json` runs the check whenever
  `index.html`, `scripts.js`, or `images/` differ from `origin/master`. It
  blocks the turn once with the failures.
- All agents and humans: the `visual-design` GitHub Action runs the same check
  on every PR that touches those paths.
- `scripts/fixtures/` holds a known-good and a known-bad page. CI checks that
  the script passes the first and fails the second, so a broken check can't
  pass silently. If you change the rules, update the script and both fixtures
  together.
