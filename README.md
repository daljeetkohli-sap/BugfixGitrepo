# Ad Hoc GitHub Reviewer

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

The operator console can run a review, show logs, and approve proposals into a local commit. The viewer page is read-only and is intended for someone else to inspect the latest runs, errors, proposals, and approved changes.

## Public GitHub Pages View

This repo also includes a static GitHub Pages preview in the `docs` folder. It is safe to share publicly because it does not run repository commands or expose approval controls.

After GitHub Pages is enabled for the repository, the public preview URL will be:

```text
https://daljeetkohli-sap.github.io/BugfixGitrepo/
```

Use the Node app for the live operator workflow and the GitHub Pages view for external reviewers who only need to inspect the app concept.
