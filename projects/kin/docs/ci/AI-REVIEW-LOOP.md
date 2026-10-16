# AI implement → review loop (Kin v1.0 epic)

Cursor cloud agents implement issues. Claude reviews each pull request. The owner merges.

| File | Used by | Purpose |
|---|---|---|
| `projects/kin/AGENTS.md` (amended) | Cursor, any agent | Adds these files to the authorized root exceptions, plus a "Cursor Cloud specific instructions" section |
| `.cursor/rules/kin-v1-epic.mdc` | Cursor | Short epic rules: scope, hard rules, verification, how to answer reviews |
| `.cursor/environment.json` + `.cursor/Dockerfile` | Cursor cloud | Node 22.13.0 and Rust 1.93.0 with wasm32 (matches CI); builds the WASM engine on install |
| `REVIEW.md` | Claude | Severity, reviewer lenses (Sentinel / Bedrock / Interface), Kin checks, verdict line |
| `.github/workflows/kin-claude-review.yml` | GitHub Actions | Runs the Claude review on PR open, reopen and ready, and on a `/kin-review` comment |
| `projects/kin/docs/ci/kin-claude-review.workflow.yml` | — | Source of truth for the workflow, same pattern as `kin-verification` |

## One-time setup

1. **Commit these files** to `kin-development`, the default branch. Cursor builds its environment from the default branch.
2. **Install the Claude GitHub App** on the repo: <https://github.com/apps/claude>.
3. **Add the secret.** Run `claude setup-token` locally and save the result as the repository secret `CLAUDE_CODE_OAUTH_TOKEN`. Reviews then use your Claude subscription. To use an API key instead, change the workflow input to `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`.
4. **Connect Cursor to GitHub.** In the Cursor dashboard, connect the GitHub integration and enable cloud agents for `mnichols08/ZTM-Build-Fest`. Usage-based billing must be on.
5. **Protect `kin-development`.** Require a PR, require the `Kin verification` checks (both the Windows and Linux jobs), and require one approving review. You give that approval, so nothing merges without you.
6. **Test once.** Open a trivial PR touching `projects/kin/` and confirm the "Kin Claude review" job posts a summary that starts with `Verdict:`.

## The loop for each issue

1. **Kick off.** Comment on a sub-issue whose "Blocked by" issues are merged:
   > @cursor Implement this issue exactly as written. Follow projects/kin/AGENTS.md and .cursor/rules/kin-v1-epic.mdc. Branch from and target kin-development. Open a PR with "Closes #<this issue>".
2. **Cursor opens a PR.** Windows/Linux CI and the Claude review both run on it.
3. **Fix the findings.** If the verdict is CHANGES NEEDED, comment on the PR:
   > @cursor Address the Claude review findings per .cursor/rules/kin-v1-epic.mdc, push, then comment /kin-review.
4. **Re-review.** Claude re-reviews when `/kin-review` is posted. It checks each earlier Important finding and doesn't add new nits.
5. **Merge.** When the verdict is READY and CI is green, you review and merge. Then start the next issue.

### Batch order and parallelism
- **Batch 1 (S1 → S2 → S3): one at a time.** These touch replay and key handling, and later work depends on them. Answer the S1 product decision on the issue first. Also get a deep human-led review of each, for example by pasting the PR into a Claude chat.
- **Batch 2 (A1, A2, A3, A4, A5, A7): up to three at once.** A4 depends on A2's client key, so do A2 before A4.
- **Batch 3 (C1, C2, C3):** can run alongside Batch 2.
- **RC, MATRIX, GATE are human tasks.** Never tag `@cursor` on them. FLAKE, FREEZE and LIMITS can go to Cursor; FREEZE needs your v0.47 upgrade-path decision first.

## Limits to know
- Cursor's cloud machines are Linux, so the Edge browser suites run only in the Windows CI job. Treat CI as the source of truth, not the agent's report.
- The review never runs PR code and never approves. It reads the diff with git and gh and posts comments only.
- Cost: each review uses your subscription's usage, or API tokens if you switch auth. Reviews run on open and on `/kin-review`, not on every push.
- If the Claude job fails with "non-human actor", the Cursor app's actor name differs from `cursor`. Copy it from the job log into `allowed_bots` in both workflow copies.
