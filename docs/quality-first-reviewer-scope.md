# Quality-First Reviewer Scope

## Goal

Add a true second-pass reviewer for owner mode and quality-first extraction jobs.

This pass is not a QA comment block. It should read the first report, compare it against extraction evidence, identify weak or contradictory sections, and rewrite weak sections before final delivery.

## When It Runs

- Owner mode only by default
- Optional for future Pro / Power upsell
- Only after crawl, harvest, packaging, and first report generation are complete

## Inputs

- `report.md`
- `manifest.json`
- `pages.json`
- `images.json`
- `site-assets.zip` metadata
- crawl counters and completeness metrics
- extraction warnings and blocked / partial signals

## Responsibilities

1. Detect thin sections
2. Detect contradictions across sections
3. Detect unsupported claims not backed by crawl or asset evidence
4. Detect missing evidence that should have been cited
5. Rewrite weak sections instead of only flagging them
6. Preserve strong sections to avoid unnecessary drift

## Suggested Pipeline

1. Generate first-pass report
2. Build reviewer prompt from report + manifests + counters
3. Score each section as `strong`, `thin`, `contradictory`, or `missing_evidence`
4. Produce a rewrite plan
5. Rewrite only targeted sections plus the scorecard
6. Emit:
   - `report-reviewed.md`
   - `review-findings.json`
   - `review-diff.md`

## Fail-Safes

- Do not run if first-pass report is too short to evaluate
- Do not invent facts missing from manifests or crawl evidence
- Preserve original report if reviewer output is malformed
- Record reviewer token/time cost separately from extraction cost

## Product UX

- Label as `Second-pass quality review`
- Show that it runs after extraction completes
- Show that it may take longer in exchange for better completeness
- Keep the current in-report QA audit block even when the rewrite-capable reviewer is enabled

## Launch Recommendation

Ship the current job architecture and extraction packaging first.

Then add this reviewer as the next owner-quality upgrade, using the durable job artifacts as the evidence source rather than trying to re-crawl during review.
