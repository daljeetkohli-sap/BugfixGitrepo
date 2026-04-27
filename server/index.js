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
    const isWindowsCmd = process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
    const spawnCommand = isWindowsCmd ? "cmd.exe" : executable;
    const spawnArgs = isWindowsCmd ? ["/d", "/s", "/c", `"${executable}" ${args.join(" ")}`] : args;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: options.cwd || rootDir,
        shell: false,
        env: { ...process.env, ...(options.env || {}) },
      });
    } catch (error) {
      resolve({
        command: [spawnCommand, ...spawnArgs].join(" "),
        code: -1,
        stdout,
        stderr: `${error.code || "SPAWN_ERROR"}: ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      resolve({
        command: [spawnCommand, ...spawnArgs].join(" "),
        code: -1,
        stdout: stdout.trim(),
        stderr: `${error.code || "SPAWN_ERROR"}: ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      resolve({
        command: [spawnCommand, ...spawnArgs].join(" "),
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

async function readOptionalText(file, maxBytes = 200000) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) return "";
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function parseGitHubRepo(repoUrl) {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const [owner, repoName] = url.pathname.replace(/^\/|\.git$/g, "").split("/");
    if (!owner || !repoName) return null;
    return { owner, repo: repoName };
  } catch {
    return null;
  }
}

async function fetchGitHubRepoMetadata(repoUrl) {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "adhoc-github-reviewer",
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      defaultBranch: data.default_branch,
      openIssues: data.open_issues_count,
      pushedAt: data.pushed_at,
      license: data.license?.spdx_id || null,
      archived: Boolean(data.archived),
      visibility: data.visibility,
      watchers: data.watchers_count,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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

function inferAppProfile(repoUrl, packageJson, readmeText) {
  const parsed = parseGitHubRepo(repoUrl);
  const raw = [
    parsed?.repo || "",
    packageJson?.name || "",
    packageJson?.description || "",
    readmeText.slice(0, 5000),
  ].join(" ").toLowerCase();
  const compact = raw.replace(/[^a-z0-9]+/g, " ");

  if (/sap|abap|fiori|technical spec|tech spec|specification|confluence|documentation|docx/.test(compact)) {
    return {
      category: "Technical specification and SAP documentation generator",
      searchTerms: [
        "technical specification generator",
        "sap documentation generator",
        "software documentation generator",
        "confluence documentation generator",
      ],
      featureIdeas: [
        {
          id: "feature-template-marketplace",
          title: "Add reusable template packs",
          summary: "Comparable documentation tools usually win through reusable templates. Add SAP/Fiori/API/integration template packs with required sections, examples, and review gates.",
        },
        {
          id: "feature-evidence-traceability",
          title: "Add source evidence traceability",
          summary: "Generated specs should link every major statement back to uploaded screenshots, code snippets, endpoints, or user answers so reviewers can audit accuracy.",
        },
        {
          id: "feature-export-destinations",
          title: "Add export destinations",
          summary: "Add one-click exports to DOCX, Markdown, Confluence-ready HTML, and Git commit files so generated specs fit common enterprise documentation workflows.",
        },
        {
          id: "feature-review-workflow",
          title: "Add reviewer workflow",
          summary: "Add draft, reviewed, approved, and rejected states with comments so technical specs can move through business analyst, developer, and architect review.",
        },
      ],
    };
  }

  if (/bug|review|repo|github|pull request|automation|ci|deploy/.test(compact)) {
    return {
      category: "GitHub repository review and automation tool",
      searchTerms: [
        "github repository review automation",
        "code review automation dashboard",
        "dependency update bot",
        "pull request review automation",
      ],
      featureIdeas: [
        {
          id: "feature-pr-mode",
          title: "Create pull requests instead of direct pushes",
          summary: "Most mature repo automation tools propose changes through pull requests with a diff, checks, and reviewer approval rather than pushing directly to the main branch.",
        },
        {
          id: "feature-risk-scoring",
          title: "Add proposal risk scoring",
          summary: "Rank proposals by blast radius, confidence, evidence source, and rollback complexity so users can approve low-risk changes quickly and scrutinize high-risk ones.",
        },
        {
          id: "feature-scheduled-comparison",
          title: "Add scheduled comparison reports",
          summary: "Generate a daily report showing new comparable-tool features, dependency releases, security advisories, and app-specific recommendations.",
        },
      ],
    };
  }

  return {
    category: "General web application",
    searchTerms: ["web app dashboard best practices", "open source web application dashboard", "product analytics dashboard"],
    featureIdeas: [
      {
        id: "feature-onboarding-checklist",
        title: "Add onboarding checklist",
        summary: "Add a guided first-run checklist that helps users connect data, configure settings, run a sample job, and understand next actions.",
      },
      {
        id: "feature-observability",
        title: "Add built-in observability",
        summary: "Expose job history, errors, timings, and audit events so operators can diagnose failures without reading server logs.",
      },
      {
        id: "feature-role-based-access",
        title: "Add role-based access",
        summary: "Separate viewer, approver, and administrator abilities before deploying the app to other users.",
      },
    ],
  };
}

function getMarketProductCatalog(appProfile) {
  if (appProfile.category.includes("Technical specification") || appProfile.category.includes("documentation")) {
    return [
      {
        name: "ERPScribe",
        url: "https://erpscribe.com/erpscribe/",
        positioning: "SAP system documentation generator",
        features: [
          "SAP object documentation",
          "ABAP and DDIC coverage",
          "transport/configuration documentation",
          "business-ready summaries",
          "team/admin tiers",
        ],
      },
      {
        name: "Mintlify",
        url: "https://www.mintlify.com/docs/guides/developer-documentation",
        positioning: "Developer documentation platform",
        features: [
          "OpenAPI reference generation",
          "Git sync",
          "versioning",
          "AI assistant",
          "code explanations",
          "preview deployments",
        ],
      },
      {
        name: "GitBook API Docs",
        url: "https://www.gitbook.com/solutions/api",
        positioning: "API and knowledge documentation platform",
        features: [
          "OpenAPI import",
          "auto-updating API docs",
          "Git sync",
          "API playground",
          "custom branding",
          "connected knowledge base",
        ],
      },
      {
        name: "Stoplight",
        url: "https://stoplight.io/api-documentation",
        positioning: "Interactive OpenAPI documentation hub",
        features: [
          "interactive docs",
          "code samples",
          "markdown guides",
          "API catalog",
          "private/public hubs",
          "search",
        ],
      },
      {
        name: "ReadMe",
        url: "https://www.mintlify.com/blog/top-7-api-documentation-tools-of-2025",
        positioning: "Developer hub and API documentation platform",
        features: [
          "API references",
          "guides",
          "changelogs",
          "AI docs assistant",
          "usage analytics",
          "audit logs",
        ],
      },
      {
        name: "Document360",
        url: "https://www.mintlify.com/library/best-technical-documentation-software-in-2026",
        positioning: "Knowledge base and documentation platform",
        features: [
          "AI search",
          "chatbot",
          "article summarization",
          "workflow",
          "SEO customization",
          "internal and external docs",
        ],
      },
      {
        name: "Tango",
        url: "https://www.tango.ai/product/create",
        positioning: "Process documentation with screenshots",
        features: [
          "auto screenshots",
          "annotations",
          "step-by-step guides",
          "browser extension capture",
          "desktop capture",
        ],
      },
    ];
  }

  return [
    {
      name: "GitHub Dependabot",
      url: "https://docs.github.com/en/code-security/dependabot",
      positioning: "Dependency and security update automation",
      features: ["dependency updates", "security alerts", "pull requests", "scheduled checks"],
    },
    {
      name: "Renovate",
      url: "https://docs.renovatebot.com/",
      positioning: "Automated dependency update tool",
      features: ["dependency updates", "pull requests", "grouped updates", "scheduling", "automerge policies"],
    },
    {
      name: "CodeQL",
      url: "https://codeql.github.com/",
      positioning: "Semantic code analysis",
      features: ["security scanning", "query packs", "GitHub integration", "alerts"],
    },
  ];
}

async function verifyMarketProducts(products) {
  const verified = [];
  for (const product of products) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(product.url, {
        signal: controller.signal,
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "adhoc-github-reviewer" },
      });
      verified.push({ ...product, reachable: response.ok, status: response.status });
    } catch {
      verified.push({ ...product, reachable: false, status: null });
    } finally {
      clearTimeout(timeout);
    }
  }
  return verified;
}

function detectTargetCapabilities(files, packageJson, readmeText) {
  const allText = `${files.join(" ")} ${packageJson ? JSON.stringify(packageJson) : ""} ${readmeText}`.toLowerCase();
  const has = (patterns) => patterns.some((pattern) => pattern.test(allText));
  return {
    "SAP object documentation": has([/sap/, /abap/, /ddic/, /transport/, /fiori/]),
    "ABAP and DDIC coverage": has([/abap/, /ddic/, /dictionary/]),
    "transport/configuration documentation": has([/transport/, /configuration/, /spro/, /img/]),
    "business-ready summaries": has([/business summary/, /executive summary/, /stakeholder/]),
    "OpenAPI reference generation": has([/openapi/, /swagger/]),
    "Git sync": has([/git sync/, /github/, /\.github/]),
    versioning: has([/version/, /changelog/, /release/]),
    "AI assistant": has([/assistant/, /chat/, /ai/]),
    "code explanations": has([/code snippet/, /code explanation/, /snippet/]),
    "preview deployments": has([/preview/, /pages/, /deploy/]),
    "OpenAPI import": has([/openapi/, /swagger/, /postman/]),
    "auto-updating API docs": has([/auto.*doc/, /sync/, /generated/]),
    "API playground": has([/playground/, /try it/, /endpoint test/]),
    "custom branding": has([/brand/, /theme/, /logo/]),
    "connected knowledge base": has([/knowledge base/, /wiki/, /portal/]),
    "interactive docs": has([/interactive/, /playground/, /try it/]),
    "code samples": has([/code sample/, /snippet/, /curl/, /python/]),
    "markdown guides": has([/markdown/, /\.md/, /mdx/]),
    "API catalog": has([/api catalog/, /catalog/]),
    "private/public hubs": has([/private/, /public/, /role/]),
    search: has([/search/, /filter/]),
    "API references": has([/api reference/, /endpoint/, /openapi/]),
    guides: has([/guide/, /how-to/, /walkthrough/]),
    changelogs: has([/changelog/, /release note/]),
    "AI docs assistant": has([/assistant/, /chatbot/, /ai/]),
    "usage analytics": has([/analytics/, /usage/, /telemetry/]),
    "audit logs": has([/audit/, /log/, /history/]),
    "AI search": has([/ai search/, /semantic search/, /search/]),
    chatbot: has([/chatbot/, /assistant/]),
    "article summarization": has([/summary/, /summarize/]),
    workflow: has([/workflow/, /approval/, /review/]),
    "SEO customization": has([/seo/, /metadata/]),
    "internal and external docs": has([/internal/, /external/, /public/]),
    "auto screenshots": has([/screenshot/, /tesseract/, /ocr/, /image/]),
    annotations: has([/annotation/, /markup/, /highlight/]),
    "step-by-step guides": has([/step/, /walkthrough/, /guide/]),
    "browser extension capture": has([/extension/]),
    "desktop capture": has([/desktop/]),
  };
}

function compareMarketFeatures(products, capabilities) {
  const featureMap = new Map();
  for (const product of products) {
    for (const feature of product.features) {
      const entry = featureMap.get(feature) || { feature, seenIn: [], present: Boolean(capabilities[feature]) };
      entry.seenIn.push(product.name);
      featureMap.set(feature, entry);
    }
  }
  return [...featureMap.values()]
    .map((entry) => ({ ...entry, gap: !entry.present }))
    .sort((a, b) => Number(b.gap) - Number(a.gap) || b.seenIn.length - a.seenIn.length);
}

function marketGapToProposal(gap) {
  const slug = gap.feature.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: `market-gap-${slug}`,
    title: `Add ${gap.feature}`,
    category: "feature",
    risk: gap.seenIn.length > 2 ? "medium" : "low",
    status: "pending",
    summary: `${gap.feature} appears in comparable tools (${gap.seenIn.join(", ")}) but was not detected in this app. Add it if it fits the product direction.`,
    action: {
      type: "append-review-doc",
      heading: `Market feature gap: ${gap.feature}`,
      body: `Comparable tools with this feature: ${gap.seenIn.join(", ")}. Suggested implementation: add a scoped MVP for ${gap.feature}, include acceptance criteria, and expose it in the app workflow after approval.`,
    },
  };
}

async function fetchGitHubComparableRepos(searchTerms, currentRepoUrl) {
  const current = parseGitHubRepo(currentRepoUrl);
  const results = [];
  const genericNames = /(^|\/)(awesome|public-apis|free-programming-books|project-based-learning|developer-roadmap)(-|$|\/)/i;
  const meaningfulTokens = (term) => term.split(/\s+/).filter((token) => token.length > 3 && !["generator", "automation", "dashboard"].includes(token));
  for (const term of searchTerms.slice(0, 3)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const query = encodeURIComponent(`${term} in:name,description,readme`);
      const response = await fetch(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`, {
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "adhoc-github-reviewer",
        },
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data.items || []) {
        if (current && item.full_name?.toLowerCase() === `${current.owner}/${current.repo}`.toLowerCase()) continue;
        if (results.some((result) => result.fullName === item.full_name)) continue;
        const haystack = `${item.full_name || ""} ${item.description || ""}`.toLowerCase();
        const tokens = meaningfulTokens(term);
        const relevant = tokens.length === 0 || tokens.some((token) => haystack.includes(token));
        if (genericNames.test(item.full_name || "") || !relevant) continue;
        results.push({
          fullName: item.full_name,
          description: item.description || "",
          stars: item.stargazers_count || 0,
          url: item.html_url,
          term,
        });
      }
    } catch {
      // Keep the review moving when public search is rate-limited or unavailable.
    } finally {
      clearTimeout(timeout);
    }
  }
  return results.slice(0, 8);
}

async function fetchNpmComparablePackages(searchTerms) {
  const results = [];
  const blocked = /^(is-|has-|get-|set-|array-|object-|string-|emojibase)/i;
  const meaningfulTokens = (term) => term.split(/\s+/).filter((token) => token.length > 4 && !["generator", "automation", "dashboard"].includes(token));
  for (const term of searchTerms.slice(0, 2)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(term)}&size=5`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data.objects || []) {
        const pkg = item.package || {};
        if (!pkg.name || results.some((result) => result.name === pkg.name)) continue;
        const haystack = `${pkg.name || ""} ${pkg.description || ""}`.toLowerCase();
        const tokens = meaningfulTokens(term);
        const relevant = tokens.length === 0 || tokens.some((token) => haystack.includes(token));
        if (blocked.test(pkg.name) || !relevant) continue;
        results.push({
          name: pkg.name,
          description: pkg.description || "",
          version: pkg.version || "",
          term,
        });
      }
    } catch {
      // Keep the review moving when npm search is unavailable.
    } finally {
      clearTimeout(timeout);
    }
  }
  return results.slice(0, 6);
}

async function scanBugRisks(repoDir, files) {
  const sourceFiles = files
    .filter((file) => /\.(js|jsx|ts|tsx|mjs|cjs|json|env|md|yml|yaml)$/i.test(file))
    .slice(0, 180);
  const findings = [];
  const checks = [
    { pattern: /\b(TODO|FIXME|HACK)\b/i, severity: "medium", area: "code-quality", message: "TODO/FIXME/HACK marker found" },
    { pattern: /console\.(log|debug|trace)\(/, severity: "low", area: "diagnostics", message: "Console diagnostic statement found" },
    { pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i, severity: "high", area: "security", message: "Possible hard-coded credential found" },
    { pattern: /innerHTML\s*=/, severity: "medium", area: "security", message: "Direct innerHTML assignment found" },
    { pattern: /eval\s*\(/, severity: "high", area: "security", message: "eval usage found" },
  ];

  for (const file of sourceFiles) {
    const text = await readOptionalText(path.join(repoDir, file));
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const check of checks) {
        if (check.pattern.test(lines[index])) {
          findings.push({ ...check, file, line: index + 1 });
        }
      }
    }
  }
  return findings.slice(0, 40);
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
  const readmeFile = files.find((file) => /^readme\.md$/i.test(file));
  const readmeText = readmeFile ? await readOptionalText(path.join(repoDir, readmeFile)) : "";
  const appProfile = inferAppProfile(repoUrl, packageJson, readmeText);
  const marketProducts = await verifyMarketProducts(getMarketProductCatalog(appProfile));
  const targetCapabilities = detectTargetCapabilities(files, packageJson, readmeText);
  const marketFeatureGaps = compareMarketFeatures(marketProducts, targetCapabilities);
  const githubMetadata = await fetchGitHubRepoMetadata(repoUrl);
  if (githubMetadata) {
    addLog(
      "success",
      "Internet check: GitHub repository metadata",
      `default=${githubMetadata.defaultBranch}; openIssues=${githubMetadata.openIssues}; pushedAt=${githubMetadata.pushedAt}; license=${githubMetadata.license || "none"}`,
    );
  } else {
    addLog("error", "Internet check: GitHub repository metadata unavailable", "Could not read GitHub repository metadata for this URL.");
  }

  const comparableRepos = await fetchGitHubComparableRepos(appProfile.searchTerms, repoUrl);
  const comparablePackages = await fetchNpmComparablePackages(appProfile.searchTerms);
  addLog(
    "success",
    `Market/web scan: ${appProfile.category}`,
    marketProducts
      .map((product) => `${product.name}${product.reachable ? "" : " (not reachable)"}`)
      .join("; "),
  );
  if (comparableRepos.length) {
    addLog(
      "success",
      `Market comparison: ${appProfile.category}`,
      comparableRepos
        .slice(0, 5)
        .map((repo) => `${repo.fullName} (${repo.stars} stars)`)
        .join("; "),
    );
  } else {
    addLog("error", `Market comparison: ${appProfile.category}`, "No comparable GitHub repositories were returned; using generated feature proposals.");
  }
  if (comparablePackages.length) {
    addLog(
      "success",
      "Market comparison: npm packages",
      comparablePackages
        .slice(0, 4)
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join("; "),
    );
  }

  const hasGitHubActions = files.some((file) => file.startsWith(".github/workflows/"));
  const hasReadme = Boolean(readmeFile);
  const hasEnvExample = files.some((file) => [".env.example", ".env.sample"].includes(file.toLowerCase()));
  const hasTests = files.some((file) => /\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/"));
  const hasLockfile = files.some((file) => ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(file));
  const hasDockerfile = files.some((file) => /^dockerfile$/i.test(path.basename(file)));
  const bugFindings = await scanBugRisks(repoDir, files);

  if (githubMetadata?.archived) {
    errors.push({ severity: "high", area: "repository", message: "Repository is archived on GitHub." });
  }

  if (githubMetadata && !githubMetadata.license) {
    proposals.push({
      id: "add-license",
      title: "Add an explicit license",
      category: "governance",
      risk: "low",
      status: "pending",
      summary: "GitHub metadata does not report a repository license. Add a LICENSE file so reuse and ownership expectations are clear.",
      action: { type: "append-review-doc", heading: "License recommendation", body: "Add a LICENSE file and document any internal usage restrictions in README.md." },
    });
  }

  proposals.push({
    id: "market-comparison-summary",
    title: "Record comparable-app market scan",
    category: "market",
    risk: "low",
    status: "pending",
    summary: comparableRepos.length
      ? `Compared this app against public GitHub projects for ${appProfile.searchTerms.join(", ")}. Top comparable signals include ${comparableRepos.slice(0, 3).map((repo) => repo.fullName).join(", ")}.`
      : `No strong public GitHub comparable results were returned for ${appProfile.searchTerms.join(", ")}; use the generated feature proposals as a baseline product roadmap.`,
    action: {
      type: "append-review-doc",
      heading: "Comparable-app market scan",
      body: [
        `App category inferred: ${appProfile.category}.`,
        comparableRepos.length
          ? `Comparable GitHub repositories: ${comparableRepos.map((repo) => `${repo.fullName} (${repo.stars} stars, ${repo.url})`).join("; ")}.`
          : "No comparable GitHub repositories were returned by public search.",
        comparablePackages.length
          ? `Comparable npm packages: ${comparablePackages.map((pkg) => `${pkg.name}@${pkg.version}`).join("; ")}.`
          : "No comparable npm packages were returned by public search.",
      ].join(" "),
    },
  });

  for (const gap of marketFeatureGaps.filter((gap) => gap.gap).slice(0, 8)) {
    proposals.push(marketGapToProposal(gap));
  }

  for (const idea of appProfile.featureIdeas) {
    proposals.push({
      id: idea.id,
      title: idea.title,
      category: "feature",
      risk: "medium",
      status: "pending",
      summary: idea.summary,
      action: {
        type: "append-review-doc",
        heading: idea.title,
        body: `${idea.summary} Basis: inferred category '${appProfile.category}' and comparable-app market scan terms '${appProfile.searchTerms.join(", ")}'.`,
      },
    });
  }

  for (const finding of bugFindings) {
    errors.push({
      severity: finding.severity,
      area: finding.area,
      message: `${finding.message} in ${finding.file}:${finding.line}`,
    });
  }

  if (bugFindings.length) {
    proposals.push({
      id: "fix-static-bug-risks",
      title: "Review static bug-risk findings",
      category: "bugfix",
      risk: "medium",
      status: "pending",
      summary: `${bugFindings.length} static bug-risk signal(s) were found, including diagnostics, TODO/FIXME markers, or risky JavaScript patterns.`,
      action: { type: "append-review-doc", heading: "Static bug-risk review", body: "Inspect the listed files and remove stale diagnostics, resolve TODO/FIXME markers, and replace unsafe patterns before deployment." },
    });
  } else {
    fixes.push({ status: "checked", message: "Static bug-risk scan completed with no TODO/FIXME, hard-coded secret, eval, or innerHTML assignment findings in scanned files." });
  }

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

  if (!hasLockfile && packageJson) {
    proposals.push({
      id: "add-package-lockfile",
      title: "Commit a dependency lockfile",
      category: "dependency",
      risk: "medium",
      status: "pending",
      summary: "package.json exists but no npm/pnpm/yarn lockfile was detected, which can make installs drift between local, CI, and deployment environments.",
      action: { type: "append-review-doc", heading: "Dependency lockfile", body: "Generate and commit the package manager lockfile, then make CI use the locked install command." },
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
    if (!dependencyNames.length) {
      addLog("info", "Internet check: npm package freshness", "No npm dependencies were declared.");
    }
    for (const dep of dependencyNames) {
      const latest = await fetchNpmLatest(dep);
      if (!latest) {
        addLog("error", `Internet check: npm latest unavailable for ${dep}`, "Could not read npm registry metadata.");
        continue;
      }
      const current = dependencies[dep].replace(/^[~^]/, "");
      if (current && current !== latest) {
        addLog("success", `Internet check: ${dep} has newer npm release`, `${dependencies[dep]} -> ${latest}`);
        proposals.push({
          id: `review-${dep.replace(/[^a-z0-9-]/gi, "-")}-upgrade`,
          title: `Review ${dep} upgrade`,
          category: "dependency",
          risk: "medium",
          status: "pending",
          summary: `${dep} is declared as ${dependencies[dep]}; npm latest is ${latest}. Review changelog and test before deployment.`,
          action: { type: "append-review-doc", heading: `Dependency review: ${dep}`, body: `${dep} is declared as ${dependencies[dep]}; latest observed version is ${latest}. Review release notes, update in a branch, run tests/build, and deploy after approval.` },
        });
      } else {
        addLog("success", `Internet check: ${dep} is current`, `${dependencies[dep]} matches npm latest ${latest}`);
      }
    }
  } else {
    addLog("info", "No package.json detected", "Generic repository review only");
  }

  proposals.push({
    id: "add-human-approval-audit",
    title: "Add approval audit visibility",
    category: "feature",
    risk: "low",
    status: "pending",
    summary: "Expose a small review history page or Markdown changelog in the target app so stakeholders can see which proposals were approved, rejected, pushed, and why.",
    action: { type: "append-review-doc", heading: "Approval audit visibility", body: "Add a lightweight audit view or link to APP_REVIEW_PROGRESS.md so app owners can trace review decisions after deployment." },
  });

  if (!hasDockerfile) {
    proposals.push({
      id: "add-deployment-contract",
      title: "Document deployment contract",
      category: "deployment",
      risk: "medium",
      status: "pending",
      summary: "No Dockerfile was detected. Even if Docker is not used, document the runtime version, build command, start command, health check, and rollback path.",
      action: { type: "append-review-doc", heading: "Deployment contract", body: "Document the app runtime, required environment variables, build/start commands, health check URL, and rollback process." },
    });
  }

  fixes.push({ status: "checked", message: "Internet checks completed against GitHub repository metadata and npm registry metadata where applicable." });

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
    comparisons: {
      category: appProfile.category,
      searchTerms: appProfile.searchTerms,
      marketProducts,
      featureGaps: marketFeatureGaps,
      githubRepositories: comparableRepos,
      npmPackages: comparablePackages,
      fallbackFeatureIdeas: appProfile.featureIdeas,
    },
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
    comparisons: {
      category: "Queued",
      searchTerms: [],
      marketProducts: [],
      featureGaps: [],
      githubRepositories: [],
      npmPackages: [],
      fallbackFeatureIdeas: [],
    },
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

async function pushApprovedCommit(repoDir, branchName, runId) {
  const firstPush = await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: repoDir });
  if (firstPush.code === 0) {
    return { pushed: true, mode: "direct", branchName, output: firstPush.stdout || firstPush.stderr };
  }

  const shouldSync = /fetch first|non-fast-forward|failed to push some refs/i.test(firstPush.stderr || firstPush.stdout);
  if (shouldSync) {
    const fetch = await runCommand("git", ["fetch", "origin", branchName], { cwd: repoDir });
    const rebase = fetch.code === 0
      ? await runCommand("git", ["rebase", `origin/${branchName}`], { cwd: repoDir })
      : fetch;
    if (fetch.code === 0 && rebase.code === 0) {
      const retryPush = await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: repoDir });
      if (retryPush.code === 0) {
        return {
          pushed: true,
          mode: "rebased",
          branchName,
          output: retryPush.stdout || retryPush.stderr,
        };
      }
    }
  }

  const reviewBranch = `app-review/${runId}`;
  const branchPush = await runCommand("git", ["push", "origin", `HEAD:${reviewBranch}`], { cwd: repoDir });
  if (branchPush.code === 0) {
    return {
      pushed: true,
      mode: "review-branch",
      branchName: reviewBranch,
      output: branchPush.stdout || branchPush.stderr,
      firstPushError: firstPush.stderr || firstPush.stdout,
    };
  }

  return {
    pushed: false,
    mode: "failed",
    branchName,
    output: branchPush.stderr || branchPush.stdout || firstPush.stderr || firstPush.stdout,
    firstPushError: firstPush.stderr || firstPush.stdout,
  };
}

async function approveProposals(runId, proposalIds) {
  const state = await readState();
  const review = state[runId];
  if (!review) throw new Error("Review run not found.");
  if (review.status !== "completed") throw new Error("Review must complete before proposals can be approved.");
  const selected = review.proposals.filter((proposal) => proposalIds.includes(proposal.id));
  if (!selected.length) throw new Error("Select at least one proposal to approve.");

  const timestamp = new Date().toISOString();
  const retryingPush = selected.every((proposal) => proposal.status === "push_failed") && review.lastApproval?.pushed === false;
  let commitOutput = review.lastApproval?.commit || "";
  if (!retryingPush) {
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
    commitOutput = commit.stdout || commit.stderr;
  }
  const branch = await runCommand("git", ["branch", "--show-current"], { cwd: review.repoDir });
  const branchName = branch.stdout || "main";
  const pushResult = await pushApprovedCommit(review.repoDir, branchName, runId);

  review.proposals = review.proposals.map((proposal) =>
    proposalIds.includes(proposal.id) ? { ...proposal, status: pushResult.pushed ? "pushed" : "push_failed" } : proposal,
  );
  review.lastApproval = {
    at: timestamp,
    proposalIds,
    commit: commitOutput,
    retryingPush,
    pushed: pushResult.pushed,
    pushMode: pushResult.mode,
    pushBranch: pushResult.branchName,
    push: pushResult.output,
    firstPushError: pushResult.firstPushError,
  };
  review.fixes = [
    ...review.fixes,
    {
      status: pushResult.pushed ? "pushed" : "push-failed",
      message: pushResult.pushed
        ? `Approved proposal records were committed and pushed to ${pushResult.branchName} (${pushResult.mode}).`
        : `Approved proposal records were committed locally, but push failed: ${pushResult.output}`,
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
