# README Studio

A local-first workspace for creating GitHub profile and repository READMEs. Build visually, edit Markdown directly, and export an ordinary `README.md` with no Studio runtime dependency.

**Version 1.9.28.** Multilingual documentation maps separate language editions to explicit workspace documents and target paths, reviews exact source-revision drift conservatively, and marks English-specific guidance Unknown for non-English editions. No translation, source edit, or remote write is automatic. [Multilingual documentation](docs/multilingual.md) · [Privacy](docs/privacy.md)

![README Studio workspace](docs/screenshots/studio-desktop.png)

## Start locally

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Guided start asks whether you want to write a profile README, write a repository README or audit your repository READMEs, and says where your work is kept; templates, Markdown import, Studio projects and blank drafts remain one click away. After you start, [Next steps](docs/next-steps.md) suggests what usually comes next without changing anything. Use the Create, Design, Review, GitHub and Save groups; `Ctrl/Cmd+K` searches tools and content. [Getting started](docs/getting-started.md) · [Task tutorials](docs/tutorials.md) · [Usability scripts](docs/usability-scripts.md) · [All documentation](docs/index.md)

## What you can do

- Compose sections, badges and collections, project showcases, components and reusable snippets.
- Coordinate themes, generate local light/dark SVG banners, and configure attributed external widget embeds.
- Import public GitHub data, review refreshes, analyze compatibility and apply explicit, undoable refactors.
- Review a README for end users, recruiters, contributors or maintainers, distinguish unknown evidence from topics not detected, and optionally apply a reviewed section order without rewriting section text.
- Practice README writing through optional Profile, CLI, Library, API, or Game lessons, annotated synthetic examples, and portable advisory checklists without automatic source edits.
- Manage localized README editions with explicit paths, manually review source-section drift, and keep language-dependent analysis uncertainty visible.
- Audit selected public repositories with advisory expectations for 14 project types, review an evidence-backed [Improvement plan](docs/repository-auditing.md#improvement-plans) for each, optionally compare explicit [Audit snapshots](docs/repository-auditing.md#audit-snapshot-history-1910), then choose the next README from the attention queue.
- Analyze declared dependencies in repository manifests with explicit consent, including bounded monorepo discovery that maps Workspace members and Nested projects ([Stack Intelligence](docs/stack-intelligence.md)). Every declaration shows where and when it was observed and a named confidence basis, with uncertain and Stale results labelled ([Provenance, confidence and staleness](docs/stack-intelligence.md#provenance-confidence-and-staleness)).
- Record read-only evidence snapshots of a repository's branch head, README, manifests and linked files, then check what changed since a pinned Baseline.
- Check for stale scripts, missing files, broken links and anchors, and outdated config keys without running repository code or changing your Markdown.
- Save portable `.readme-studio.json` projects or export Markdown, packs and full workspace backups.
- Optionally publish reviewed README, asset and workflow changes through a separately configured GitHub App service. Publishing starts read-only and unlocks only after a [Preflight](docs/github-publishing.md#preflight) of app, permission and branch access passes. A [change set review](docs/github-publishing.md#change-set-review) lists every file write with its Base and Result SHA, and publishing needs an explicit approval of that exact set.

Manual Markdown remains available. Raw edits change only the sections they touch: untouched builder sections keep their visual ownership, and any section that is detached is named in a status message and in the Sections list. Themes guide generated content; they cannot style GitHub itself. The app light/dark switch updates preview too, with a separate preview override.

## Your data

Drafts autosave to this browser. **Download a backup before clearing browser storage**; **Restore a backup** in Guided start brings it back and opens your restored draft. Export README, Copy Markdown, Save Studio project and the backup downloads ask before leaving out section edits you have not saved. Storage failures remain visible, and damaged data opens a temporary workspace with recovery downloads rather than silently replacing originals. Portable projects retain source and supported editing metadata; Markdown exports retain source only. [Editing and recovery](docs/editing.md) · [Project files](docs/studio-projects.md)

Core editing, analysis and export work offline after the production app has successfully cached. Public GitHub fetches, publishing and remote images need a connection. Remote previews contact their providers directly. [Offline behavior](docs/offline.md) · [Privacy](docs/privacy.md) · [Security](docs/security.md)

## Build and verify

```sh
npm test
npx playwright install chromium firefox webkit
npm run test:browser:all
npm run build
npm run test:static
npm run report:bundle
```

Serve `dist/` with a static HTTP server, GitHub Pages subpath or Netlify; no router fallback or frontend environment variables are required. Opening `index.html` through `file://` is not supported. Optional publishing needs the [HTTPS server setup](docs/github-publishing.md); a static deployment alone does not enable writes.

[Contributor guide](CONTRIBUTING.md) · [Architecture](docs/architecture.md) · [Synthetic examples](examples/README.md) · [Known limitations](docs/known-limitations.md) · [Changelog](CHANGELOG.md)

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Preview approximates GitHub; automated browser tests are not accessibility certification or proof of a live publishing deployment.
