# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.** Public issues are
indexed by search engines and can expose users before a fix is available.

Report privately through
[GitHub Security Advisories](https://github.com/myousafmarfani/REWA/security/advisories/new).
That keeps the disclosure, fix, and advisory in one place.

Include, if you can:

- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- The commit or release you are testing against.
- Whether you want credit in the eventual disclosure.

## What to expect

- Acknowledgement within 72 hours.
- Initial assessment (severity, affected versions, workaround) within one
  week.
- A fix and coordinated disclosure on a timeline proportional to
  severity.

## Scope

In scope:

- This repository (`myousafmarfani/REWA`), including webhook and auth
  flows, token encryption, RLS policies, opt-out handling, and background
  jobs.
- Default configurations shipped in `docs/` when they leave an unsafe
  default.

Out of scope:

- Vulnerabilities in Supabase, Next.js, Node.js, Meta APIs, Trigger.dev,
  or other upstream dependencies — report those to their maintainers.
- Issues that require a pre-compromised deployment (for example, a leaked
  service-role key) unless they widen the blast radius beyond the initial
  compromise.
- Social engineering, physical attacks, or third-party services added to
  a deployment.

## Safe harbor

Research conducted under this policy is authorized. We will not pursue
legal action against anyone who:

- Makes a good-faith effort to avoid data destruction, privacy
  violations, or service disruption.
- Gives us reasonable time to respond before public disclosure.
- Does not exploit the issue beyond what is necessary to demonstrate it.

The MIT license and upstream wacrm attribution are preserved in
[`LICENSE`](../LICENSE). This security policy applies to this repository,
not to the upstream wacrm project.
