<!--
Heads up: rewa is developed spec-first. Read MEMORY.md, AGENTS.md, and
the relevant spec before changing behaviour. CONTRIBUTING.md lists the
scope rules and the checks expected before review.

Keep this short and specific. The commit message is where the "why"
lives; this is where the reviewer gets the "what" and "how to try it".
-->

## Summary

<!-- One or two sentences. What does this PR do? -->

## What changed

<!-- Bullet list of the actual changes. Link file paths when useful. -->

## Test plan

<!--
How did you verify this works? How should the reviewer verify it?
Tick the boxes as you go.
-->

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` — no new errors beyond the pre-existing backlog.
- [ ] `npm run build` succeeds.
- [ ] Feature / fix manually exercised in the browser (or the reason it can't be).

## Related

<!-- Link the issue this closes, or "Part of #N" for multi-PR work. -->

<!--
Heads up:
- Security issues: do not disclose here; see .github/SECURITY.md.
- New deps: please justify briefly in the commit message or PR body.
- Migration changes: state whether the rewa chain or retired baseline is affected.
- Runtime behaviour changes: update docs/*.
-->
