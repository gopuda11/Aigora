# Building Aigora with AI

Aigora is a portfolio project by **gopuda11**. Its development demonstrates how one human owner can direct AI agents, integrate their changes, investigate regressions and decide what is ready to ship. AI assistance does not remove the owner's responsibility for design, security, attribution or release decisions.

## Origin and contributions

The code began with [Clay by chadbyte](https://github.com/chadbyte/clay), then [Clagentic Console](https://github.com/clagentic/clagentic-console). Aigora builds on that inherited console with collaborative rooms, owner-scoped private channels, member mentions and notifications, multi-agent routing, local model endpoints, contained execution, credential brokering, shared files and Office editing, and audio/video transcription workflows. These are additions to a fork, not a claim that the entire codebase was written from scratch. [CREDITS](../CREDITS.md) and [FORK_NOTICE](../FORK_NOTICE.md) preserve upstream attribution and describe the public export.

## Development workflow

Tool purposes, upstream links and verified license status are listed in [CREDITS](../CREDITS.md#3-development-tools-and-practices-not-shipped).

One human owner sets priorities, defines task boundaries and makes the final integration and release decisions. The owner's development setup assigns distinct roles:

- **Planning and integration:** Claude (Claude Code) plans changes, integrates work and verifies results.
- **Implementation:** OpenAI Codex implements bounded tasks in isolated Git worktrees, making parallel changes reviewable before integration.
- **Static review:** Google Antigravity (Gemini Flash) and GitHub Copilot provide independent static reviews.
- **Task suggestions:** A local decision gateway combines a Clef classifier, JEV and an Intel NPU model to suggest which agent should receive a task. The owner remains responsible for the assignment and outcome.
- **Quota management:** Routing considers available quotas; heavy browser QA can pause until a quota resets instead of being reported as complete.

These describe tools used to develop Aigora. The public product executes agents with explicit API keys and compatible model endpoints; the development workflow does not add provider subscription logins to the public product. The private development setup and its delegation ledger are not bundled with this source export.

## Quality controls

The owner's release workflow uses test-first changes, an “iron laws” static rule set, and full-suite gating for every release: the test command must exit 0. Browser QA uses a Chrome extension and screen recordings to inspect interaction and layout. Staged releases retain a rollback path. A pre-publication gate checks secrets, licenses, privacy, provider terms and branding before a tree is released publicly.

These are controls, not a guarantee that defects cannot ship. Static checks, mocked tests, real containment tests and recorded browser QA answer different questions. A check blocked by the host or an exhausted quota remains unverified. The historical c63 result below is not a claim that this public branch has passed the same suite on every host.

## Three changes that illustrate the process

1. **Mentions without login-username disclosure.** After member mentions were added, review found that room rosters exposed login usernames. The fix limited roster entries to `id`, `name` and `role`, resolved mentions using public display names, and prevented a missing display name from falling back to a login username. Regression tests check the exact roster keys and reject username aliases. Evidence: historical commit `c6d8bde2`; tests `aigora-member-mentions` and `private-social-unread-surfaces`.
2. **A settings layout regression.** A touch-target CSS rule overrode the settings close button's absolute positioning with relative positioning. The button became a grid item, narrowing the desktop content and clipping phone section titles. The hotfix restored absolute positioning and bumped the stylesheet version. Evidence: historical commit `42acdb3f`. The owner's QA log confirms that the hotfix was visually verified in Chrome at desktop and phone widths before deployment.
3. **Security tests that still run without containment.** Broad host-sandbox skips could suppress mocked authorization and credential checks along with real sandbox cases. The c63 integration fix narrowed skips to containment-dependent cases, keeping authorization, forged-scope rejection, sanitization, credential and cleanup assertions runnable without host containment. Filesystem, network and environment assertions stayed in the real sandbox cases. Evidence: historical commit `8f5d672d`; tests `private-claude-wiring` and `private-codex-wiring`.

Commit identifiers refer to the development history. The fresh public export retains attribution but does not include that history. Test names identify the regression coverage in the development checkout; the portable public test bundle is smaller.

## Owner-measured development record

The following figures were measured by the owner's tooling and supplied for this account. They describe the author's work on top of upstream history, not upstream contributions or measurements independently repeated by the public export:

| Measure | Recorded result |
| --- | --- |
| Author's own work, 2026-09-29 → 2026-10-06 | 558 commits on top of the upstream history |
| Staged releases | 63 (c1–c63) |
| Full suite at the c63 candidate | 5,356 test cases, 0 failing |
| Recorded delegated agent jobs | 56 Codex, 19 Antigravity, 5 Copilot |

Delegated jobs were tracked only after the delegation tool existed, so those counts are a lower bound. A commit, staged release or test count is evidence of activity and checks, not by itself a measure of software quality.

## Publication limits

The public split follows a review of provider terms and keeps execution on explicit API credentials or compatible model endpoints. Provider service terms and model-weight licenses remain separate from the repository's MIT license. The historical release gate and the checks recorded for this branch do not establish blanket permission to redistribute every asset.

Per-asset provenance is still unknown for some logos, provider avatars, decorative SVGs, icons and named-theme palette values. [CREDITS](../CREDITS.md#browser-libraries-icons-and-fonts) identifies those gaps rather than guessing licenses. Containment and mock-API checks need a host that permits their prerequisites; release review must retain any checks that could not run.
