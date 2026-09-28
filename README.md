# Archived local performance tools — 2026-09-28

This archival branch preserves authored measurement and fixture-preparation code before removing disposable local QA workspaces. It is not a feature branch or a newly validated benchmark. Product history remains on main.

Files retain their paths relative to `.local/`. To inspect or restore them, use `git show` or extract only the `research/` subtree into `.local/` from this branch. The scripts assume their historical working directory and generated build/source freezes; regenerate those from the original commits before a new run. Do not execute server-control or cleanup scripts without reviewing their historical paths and process ownership checks.

The accepted metric-v2 results and limitations are preserved on main in `docs/benchmarks/catalog-2026-09-27.json` and `docs/improvements.md`. Metric-v1 DOM/selection timestamps were found invalid and are not accepted results.

Actual posting bodies and expected landmark records are not tracked here. The original actual catalog is in the ignored historical-input archive, and `measurement-context.json` in the same retained directory preserves the original `actual-landmarks.json`. See main's `docs/local-data-retention.md` for the archive and restore instructions. Raw browser runs, generated fixtures, dependencies and builds are reproducible and were removed.
