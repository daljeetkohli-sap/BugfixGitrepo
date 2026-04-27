# BugfixGitrepo

Ad Hoc GitHub Reviewer for running repository checks, recording proposals, and approving documented fixes.

Run the app locally:

```powershell
npm start
```

Open the operator console:

```text
http://localhost:4173
```

Open the read-only stakeholder view:

```text
http://localhost:4173/viewer.html
```

The operator console can queue multiple background reviews, show logs, and let a user approve or reject each proposal. Approved proposals are committed into the cloned target repo and pushed back to that app's current branch when credentials allow it. The viewer page is read-only and is intended for someone else to inspect the latest runs, errors, proposals, and approved changes.

Each review checks local repository signals plus internet-sourced metadata where available:

- GitHub repository metadata such as default branch, open issue count, latest push time, archive status, and license.
- npm registry freshness for declared dependencies.
- Comparable-app/product scan using public GitHub repository search and npm package search, with fallback feature generation when public comparison data is weak.
- Market/web scan against named comparable documentation products, including ERPScribe, Mintlify, GitBook, Stoplight, ReadMe, Document360, and Tango for technical-spec/documentation apps.
- Feature gap matrix comparing detected app capabilities with features seen in those comparable products.
- Static bug-risk patterns such as TODO/FIXME markers, hard-coded credential-looking values, `eval`, direct `innerHTML`, and console diagnostics.
- Project hygiene signals such as README, CI workflow, environment example, lockfile, tests, and deployment contract.
- Feature proposals for audit visibility and safer deployment operations.
- Domain-specific feature proposals, for example SAP/technical-spec template packs, evidence traceability, export destinations, and reviewer workflow when the app appears to be a technical specification generator.

When proposals are approved, the changed target repository receives Markdown audit files:

- `APP_REVIEW_PROGRESS.md` records the review run, approval time, errors found, approved proposals, and progress status.
- `REVIEW_PROPOSALS.md` records the approved proposal details.
- `DAILY_REVIEW_LOG.md` records command findings and approved fixes.

For React/Vite target apps, approved market or feature proposals also create a visible `AppReviewEnhancements` component and inject it into the app so the public UI can show the approved market-driven changes after the target app deploys.

## Public GitHub Pages View

This repo also includes a static GitHub Pages preview in the `docs` folder. It is safe to share publicly because it does not run repository commands or expose approval controls.

After GitHub Pages is enabled for the repository, the public preview URL will be:

```text
https://daljeetkohli-sap.github.io/BugfixGitrepo/
```

Use the Node app for the live operator workflow and the GitHub Pages view for external reviewers who only need to inspect the app concept.
