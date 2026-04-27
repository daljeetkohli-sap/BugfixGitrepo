import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const runsDir = path.join(rootDir, ".adhoc-runs");
const stateFile = path.join(runsDir, "runs.json");
const port = Number(process.env.PORT || 4173);
const progressFileName = "APP_REVIEW_PROGRESS.md";
const proposalsFileName = "REVIEW_PROPOSALS.md";
const reviewLogFileName = "DAILY_REVIEW_LOG.md";
let stateWriteQueue = Promise.resolve();
const windowsCommandPaths = {
  git: "C:\\Program Files\\Git\\cmd\\git.exe",
  npm: "C:\\Program Files\\nodejs\\npm.cmd",
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function ensureState() {
  await fs.mkdir(runsDir, { recursive: true });
  if (!existsSync(stateFile)) {
    await fs.writeFile(stateFile, "{}", "utf8");
  }
}

async function readState() {
  await ensureState();
  return JSON.parse(await fs.readFile(stateFile, "utf8"));
}

async function writeState(state) {
  await ensureState();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function updateRun(runId, updater) {
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(async () => {
      const state = await readState();
      const nextRun = await updater(state[runId]);
      state[runId] = nextRun;
      await writeState(state);
      return nextRun;
    });
  return stateWriteQueue;
}

function sendJson(res, status, body) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const executable = process.platform === "win32" ? windowsCommandPaths[command] || command : command;
    const child = spawn(executable, args, {
      cwd: options.cwd || rootDir,
      shell: false,
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      resolve({
        command: [executable, ...args].join(" "),
        code: -1,
        stdout: stdout.trim(),
        stderr: `${error.code || "SPAWN_ERROR"}: ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      resolve({
        command: [executable, ...args].join(" "),
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function isSafePublicGitUrl(repoUrl) {
  try {
    const url = new URL(repoUrl);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function repoSlug(repoUrl) {
  const parsed = new URL(repoUrl);
  return parsed.pathname
    .replace(/^\/|\.git$/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 80) || "repo";
}

async function listFiles(dir, limit = 1200) {
  const out = [];
  async function walk(current) {
    if (out.length >= limit) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) return;
      if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(full);
      else out.push(rel);
    }
  }
  await walk(dir);
  return out;
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function fetchNpmLatest(name) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildReview(runId, repoUrl, repoDir) {
  const logs = [];
  const errors = [];
  const fixes = [];
  const proposals = [];
  const addLog = (level, message, detail = "") => logs.push({ at: new Date().toISOString(), level, message, detail });

  addLog("info", "Repository cloned", repoUrl);
  const files = await listFiles(repoDir);
  addLog("info", "Repository inventory complete", `${files.length} files scanned`);

  const packageJsonPath = path.join(repoDir, "package.json");
  const packageJson = await readOptionalJson(packageJsonPath);
  const hasGitHubActions = files.some((file) => file.startsWith(".github/workflows/"));
  const hasReadme = files.some((file) => /^readme\.md$/i.test(file));
  const hasEnvExample = files.some((file) => [".env.example", ".env.sample"].includes(file.toLowerCase()));
  const hasTests = files.some((file) => /\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/"));

  if (!hasReadme) {
    errors.push({ severity: "medium", area: "documentation", message: "No README.md was found at the repo root." });
    proposals.push({
      id: "add-readme-review-note",
      title: "Add a README action note",
      category: "documentation",
      risk: "low",
      status: "pending",
      summary: "Create a review note that calls out the missing README and what it should include.",
      action: { type: "append-review-doc", heading: "README gap", body: "Add a root README.md with setup, runtime configuration, test commands, deployment commands, and ownership details." },
    });
  }

  if (!hasGitHubActions) {
    proposals.push({
      id: "recommend-ci-workflow",
      title: "Add continuous integration",
      category: "deployment",
      risk: "medium",
      status: "pending",
      summary: "No GitHub Actions workflow was detected. Add CI before automated deploy changes are trusted.",
      action: { type: "append-review-doc", heading: "CI workflow recommendation", body: "Add a GitHub Actions workflow that installs dependencies, runs tests, builds the app, and blocks deployment on failure." },
    });
  }

  if (!hasEnvExample) {
    proposals.push({
      id: "document-env-vars",
      title: "Document environment variables",
      category: "configuration",
      risk: "low",
      status: "pending",
      summary: "No .env.example or .env.sample file was detected.",
      action: { type: "append-review-doc", heading: "Environment documentation", body: "Add .env.example with required keys, safe placeholders, and notes for local, staging, and production values." },
    });
  }

  if (packageJson) {
    addLog("info", "Detected Node app", packageJson.name || "package.json found");
    const scripts = packageJson.scripts || {};
    for (const scriptName of ["test", "build", "lint"]) {
      if (scripts[scriptName]) {
        const result = await runCommand("npm", ["run", scriptName, "--if-present"], { cwd: repoDir });
        addLog(result.code === 0 ? "success" : "error", `npm run ${scriptName}`, result.stderr || result.stdout);
        if (result.code !== 0) {
          errors.push({ severity: "high", area: scriptName, message: `${scriptName} script failed`, detail: result.stderr || result.stdout });
        }
      }
    }

    if (!scripts.test && !hasTests) {
      proposals.push({
        id: "add-test-coverage",
        title: "Add a first test path",
        category: "quality",
        risk: "medium",
        status: "pending",
        summary: "No test script or test files were detected.",
        action: { type: "append-review-doc", heading: "Testing gap", body: "Add a minimal test harness around the highest-risk user flow, then wire it to npm run test and CI." },
      });
    }

    const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
    const dependencyNames = Object.keys(dependencies).slice(0, 12);
    for (const dep of dependencyNames) {
      const latest = await fetchNpmLatest(dep);
      if (!latest) continue;
      const current = dependencies[dep].replace(/^[~^]/, "");
      if (current && current !== latest) {
        proposals.push({
          id: `review-${dep.replace(/[^a-z0-9-]/gi, "-")}-upgrade`,
          title: `Review ${dep} upgrade`,
          category: "dependency",
          risk: "medium",
          status: "pending",
          summary: `${dep} is declared as ${dependencies[dep]}; npm latest is ${latest}. Review changelog and test before deployment.`,
          action: { type: "append-review-doc", heading: `Dependency review: ${dep}`, body: `${dep} is declared as ${dependencies[dep]}; latest observed version is ${latest}. Review release notes, update in a branch, run tests/build, and deploy after approval.` },
        });
      }
    }
  } else {
    addLog("info", "No package.json detected", "Generic repository review only");
  }

  fixes.push({
    status: "available-after-approval",
    message: `Approved proposals are committed with ${progressFileName}, ${proposalsFileName}, and ${reviewLogFileName} updates in the cloned repo.`,
  });

  return {
    id: runId,
    repoUrl,
    repoDir,
    createdAt: new Date().toISOString(),
    status: "completed",
    statusMessage: "Review completed. Proposals are ready for approval or rejection.",
    completedAt: new Date().toISOString(),
    summary: {
      filesScanned: files.length,
      errorsFound: errors.length,
      proposalsFound: proposals.length,
      detectedStack: packageJson ? "Node.js" : "Generic",
    },
    logs,
    errors,
    fixes,
    proposals,
  };
}

async function startReview(repoUrl) {
  if (!isSafePublicGitUrl(repoUrl)) {
    throw new Error("Enter a public http(s) git repository URL.");
  }
  await ensureState();
  const runId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const repoDir = path.join(runsDir, `${repoSlug(repoUrl)}-${runId}`);
  const review = {
    id: runId,
    repoUrl,
    repoDir,
    createdAt: new Date().toISOString(),
    status: "queued",
    statusMessage: "Waiting for the background worker.",
    summary: {
      filesScanned: 0,
      errorsFound: 0,
      proposalsFound: 0,
      detectedStack: "Queued",
    },
    logs: [{ at: new Date().toISOString(), level: "info", message: "Background review queued", detail: repoUrl }],
    errors: [],
    fixes: [],
    proposals: [],
  };
  const state = await readState();
  state[runId] = review;
  await writeState(state);
  runReviewJob(runId, repoUrl, repoDir);
  return review;
}

async function runReviewJob(runId, repoUrl, repoDir) {
  await updateRun(runId, (review) => ({
    ...review,
    status: "running",
    statusMessage: "Cloning repository and running checks.",
    startedAt: new Date().toISOString(),
    logs: [...(review?.logs || []), { at: new Date().toISOString(), level: "info", message: "Background review started", detail: repoUrl }],
  }));

  const clone = await runCommand("git", ["clone", "--depth", "1", repoUrl, repoDir], { cwd: rootDir });
  if (clone.code !== 0) {
    await updateRun(runId, (review) => ({
      ...review,
      status: "failed",
      statusMessage: "Repository clone failed.",
      completedAt: new Date().toISOString(),
      errors: [
        ...(review?.errors || []),
        { severity: "high", area: "clone", message: "git clone failed", detail: clone.stderr || clone.stdout },
      ],
      logs: [
        ...(review?.logs || []),
        { at: new Date().toISOString(), level: "error", message: "git clone failed", detail: clone.stderr || clone.stdout },
      ],
    }));
    return;
  }

  try {
    const review = await buildReview(runId, repoUrl, repoDir);
    await updateRun(runId, () => review);
  } catch (error) {
    await updateRun(runId, (review) => ({
      ...review,
      status: "failed",
      statusMessage: "Review failed during analysis.",
      completedAt: new Date().toISOString(),
      errors: [
        ...(review?.errors || []),
        { severity: "high", area: "analysis", message: error.message || "Review failed" },
      ],
      logs: [
        ...(review?.logs || []),
        { at: new Date().toISOString(), level: "error", message: "Review failed", detail: error.message || "" },
      ],
    }));
  }
}

async function appendReviewFile(repoDir, title, lines) {
  const file = path.join(repoDir, title);
  const previous = existsSync(file) ? await fs.readFile(file, "utf8") : "";
  const content = `${previous}${previous ? "\n\n" : ""}${lines.join("\n")}\n`;
  await fs.writeFile(file, content, "utf8");
}

function buildProgressEntry(review, selected, timestamp) {
  const lines = [
    `# App Review Progress`,
    ``,
    `## Run ${review.id}`,
    ``,
    `Status: approved and queued for commit`,
    `Reviewed at: ${review.createdAt}`,
    `Approved at: ${timestamp}`,
    `Source repo: ${review.repoUrl}`,
    `Detected stack: ${review.summary.detectedStack}`,
    `Files scanned: ${review.summary.filesScanned}`,
    ``,
    `### Errors found`,
    ``,
    ...(review.errors.length
      ? review.errors.map((error) => `- [${error.severity}] ${error.area}: ${error.message}`)
      : ["- No command errors captured."]),
    ``,
    `### Approved proposals`,
    ``,
    ...selected.map((proposal) => `- ${proposal.title} (${proposal.category}, ${proposal.risk} risk): ${proposal.summary}`),
    ``,
    `### Change record`,
    ``,
    `- ${progressFileName} records the end-to-end app review progress inside this changed repository.`,
    `- ${proposalsFileName} records the approved proposal details.`,
    `- ${reviewLogFileName} records command findings and approved fixes.`,
    `- Commit is created by the ad hoc reviewer after these Markdown records are written.`,
  ];
  return lines;
}

async function approveProposals(runId, proposalIds) {
  const state = await readState();
  const review = state[runId];
  if (!review) throw new Error("Review run not found.");
  if (review.status !== "completed") throw new Error("Review must complete before proposals can be approved.");
  const selected = review.proposals.filter((proposal) => proposalIds.includes(proposal.id));
  if (!selected.length) throw new Error("Select at least one proposal to approve.");

  const timestamp = new Date().toISOString();
  await appendReviewFile(review.repoDir, progressFileName, buildProgressEntry(review, selected, timestamp));
  await appendReviewFile(review.repoDir, proposalsFileName, [
    `# Approved Review Proposals`,
    ``,
    `Approved at: ${timestamp}`,
    `Source repo: ${review.repoUrl}`,
    ``,
    ...selected.flatMap((proposal) => [
      `## ${proposal.title}`,
      ``,
      `Category: ${proposal.category}`,
      `Risk: ${proposal.risk}`,
      ``,
      proposal.summary,
      ``,
      proposal.action?.body || "",
      ``,
    ]),
  ]);
  await appendReviewFile(review.repoDir, reviewLogFileName, [
    `# Ad Hoc Review Log`,
    ``,
    `Run: ${runId}`,
    `Approved at: ${timestamp}`,
    ``,
    `## Errors`,
    ``,
    ...(review.errors.length ? review.errors.map((error) => `- [${error.severity}] ${error.area}: ${error.message}`) : ["- No command errors captured."]),
    ``,
    `## Approved Fixes`,
    ``,
    ...selected.map((proposal) => `- ${proposal.title}: ${proposal.summary}`),
  ]);

  const add = await runCommand("git", ["add", progressFileName, proposalsFileName, reviewLogFileName], { cwd: review.repoDir });
  if (add.code !== 0) throw new Error(add.stderr || "git add failed");
  await runCommand("git", ["config", "user.name", "Ad Hoc GitHub Reviewer"], { cwd: review.repoDir });
  await runCommand("git", ["config", "user.email", "reviewer-bot@users.noreply.github.com"], { cwd: review.repoDir });
  const commit = await runCommand("git", ["commit", "-m", "Apply approved app review proposals"], { cwd: review.repoDir });
  if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout || "git commit failed");
  const branch = await runCommand("git", ["branch", "--show-current"], { cwd: review.repoDir });
  const branchName = branch.stdout || "main";
  const push = await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: review.repoDir });
  const pushed = push.code === 0;

  review.proposals = review.proposals.map((proposal) =>
    proposalIds.includes(proposal.id) ? { ...proposal, status: pushed ? "pushed" : "push_failed" } : proposal,
  );
  review.lastApproval = {
    at: timestamp,
    proposalIds,
    commit: commit.stdout || commit.stderr,
    pushed,
    push: push.stdout || push.stderr,
  };
  review.fixes = [
    ...review.fixes,
    {
      status: pushed ? "pushed" : "push-failed",
      message: pushed
        ? `Approved proposal records were committed and pushed to ${branchName}.`
        : `Approved proposal records were committed locally, but push failed: ${push.stderr || push.stdout}`,
    },
  ];
  state[runId] = review;
  await writeState(state);
  return review;
}

async function rejectProposals(runId, proposalIds, reason = "") {
  const state = await readState();
  const review = state[runId];
  if (!review) throw new Error("Review run not found.");
  if (review.status !== "completed") throw new Error("Review must complete before proposals can be rejected.");
  if (!proposalIds.length) throw new Error("Select at least one proposal to reject.");
  const timestamp = new Date().toISOString();
  review.proposals = review.proposals.map((proposal) =>
    proposalIds.includes(proposal.id)
      ? { ...proposal, status: "rejected", rejectedAt: timestamp, rejectionReason: reason || "Rejected by user." }
      : proposal,
  );
  review.logs = [
    ...review.logs,
    { at: timestamp, level: "info", message: "Proposals rejected", detail: proposalIds.join(", ") },
  ];
  state[runId] = review;
  await writeState(state);
  return review;
}

async function serveStatic(req, res) {
  const requestedPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/reviews") {
      const body = await readJson(req);
      const review = await startReview(String(body.repoUrl || "").trim());
      sendJson(res, 200, review);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/reviews/") && url.pathname.endsWith("/approve")) {
      const runId = url.pathname.split("/")[3];
      const body = await readJson(req);
      const review = await approveProposals(runId, Array.isArray(body.proposalIds) ? body.proposalIds : []);
      sendJson(res, 200, review);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/reviews/") && url.pathname.endsWith("/reject")) {
      const runId = url.pathname.split("/")[3];
      const body = await readJson(req);
      const review = await rejectProposals(
        runId,
        Array.isArray(body.proposalIds) ? body.proposalIds : [],
        String(body.reason || ""),
      );
      sendJson(res, 200, review);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/reviews") {
      const state = await readState();
      sendJson(res, 200, Object.values(state).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Request failed" });
  }
});

server.listen(port, () => {
  console.log(`Ad hoc review UI running at http://localhost:${port}`);
});
