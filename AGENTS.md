# Token Diary maintenance

## Owner's standing instruction

When the owner requests an update to **this project**, implement it, run the relevant checks, then automatically **git commit and git push** the project changes to its configured upstream. This is explicit ongoing authorization; do not ask for the same permission again. Include only the requested work and preserve unrelated changes. Never force-push or publish credentials, user logs, runtime configuration or generated private data. Report the commit and verification result.

## Scope

Token Diary (formerly AI Log) is a local-first AI token usage and work journal. The repository is independent of any personal website, Diary data, private authentication, specific machines or deployment paths. Keep private integrations outside this public repository.

- Node.js 24+, CommonJS; no runtime npm dependencies.
- `bin/ai-log.cjs`: CLI and environment setup before requiring core modules.
- `src/scanner.cjs`, `scan-wsl.py`: source-side read-only scanners; Python WSL fallback is Codex-only.
- `src/collector.cjs`: local/SSH/WSL/file sources and private snapshots.
- `src/core.cjs`, `periods.cjs`: inclusive token normalization, aliases and calendar aggregates.
- `src/reviews.cjs`: explicit model opt-in, child-summary reuse, fingerprints and input/call budgets.
- `src/server.cjs`, `view.cjs`, `heatmap.cjs`: read-only loopback dashboard; heatmap is Home-only.

## Naming and README

- Public repository: `ch-z-hc/Token-Diary`. The owner chose **Token Diary** on 2026-11-05. Keep existing `ai-log` CLI commands, filenames, environment variables and data paths compatible.
- README should explain the product, supported workflows and screenshots. Do not put a technology-stack overview or implementation/storage details there; installation and configuration belong in `docs/guide.md`, technical details in the other docs.

## Invariants

- Default `captureText=false` and `review.enabled=false`. Stats-only scanners and their caches must never retain task excerpts. Do not implement this only by hiding UI.
- Total tokens = inclusive input + inclusive output. Cache input and reasoning output are subsets, not additional totals.
- Preserve dedup across migrated logs, aliases, cumulative/per-call records and streaming blocks. Never replace unknown usage with a fabricated estimate.
- Offline sources retain last successful snapshots. Invalid token records stay visible; known harmless truncated startup metadata may be skipped.
- Configurable IANA natural-midnight boundary; Monday-first weeks. No hidden 05:00 boundary.
- Daily and ended week/month/year reviews only; Total manual. Long-period generation must use valid child summaries, preserve complete coverage and reject oversize inputs before model invocation. Respect daily call budget and source fingerprint after generation.
- Browsing and collecting never invoke models. Credentials belong to existing providers, not this repo. Sanitization is best-effort, never a privacy guarantee.
- No unrequested Diary writes or website deployment changes. No genuine conversation fixtures, real-device screenshots or account configurations in Git.
- 中文与英文、数字之间留空格。固定浅色界面，不增加深色模式或语言切换器。

## Verification and publishing

`npm test` uses synthetic fixtures and temp directories; never run real model calls as tests. `npm pack --dry-run` must include only approved source/docs/examples and exclude all runtime data. Test install the tarball into an isolated directory, run the installed CLI and synthetic demo, and review staged files before pushing.

CI exercises Node.js 24 on Linux, Windows and macOS. Do not claim a platform passed until the actual result is known. Use portable filenames and avoid POSIX-only process cancellation. Keep config / data outside the source tree.

If updating a private downstream installation, check its separate instructions and explicitly verify compatibility; public release does not by itself update downstream copies.
