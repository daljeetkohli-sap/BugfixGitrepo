const form = document.querySelector("#review-form");
const repoInput = document.querySelector("#repo-url");
const runButton = document.querySelector("#run-button");
const refreshButton = document.querySelector("#refresh-button");
const approveButton = document.querySelector("#approve-button");
const rejectButton = document.querySelector("#reject-button");
const proposalToolbar = document.querySelector("#proposal-toolbar");
const proposalSearch = document.querySelector("#proposal-search");
const proposalCategory = document.querySelector("#proposal-category");
const proposalRisk = document.querySelector("#proposal-risk");
const proposalStatus = document.querySelector("#proposal-status");
const proposalFilterSummary = document.querySelector("#proposal-filter-summary");
const selectVisibleButton = document.querySelector("#select-visible-button");
const clearSelectionButton = document.querySelector("#clear-selection-button");
const rejectVisibleButton = document.querySelector("#reject-visible-button");
const historyList = document.querySelector("#history-list");
const emptyState = document.querySelector("#empty-state");
const reviewContent = document.querySelector("#review-content");
const reviewTitle = document.querySelector("#review-title");
const toast = document.querySelector("#toast");
const panels = {
  proposals: document.querySelector("#tab-proposals"),
  comparisons: document.querySelector("#tab-comparisons"),
  errors: document.querySelector("#tab-errors"),
  fixes: document.querySelector("#tab-fixes"),
  logs: document.querySelector("#tab-logs"),
};
const metrics = {
  files: document.querySelector("#metric-files"),
  errors: document.querySelector("#metric-errors"),
  proposals: document.querySelector("#metric-proposals"),
  stack: document.querySelector("#metric-stack"),
};

let reviews = [];
let selectedReview = null;
let activeTab = "proposals";
const proposalFilters = {
  search: "",
  category: "all",
  risk: "all",
  status: "all",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 4200);
}

function getReviewerToken() {
  return String(window.sessionStorage.getItem("reviewerAuthToken") || "").trim();
}

async function api(path, options = {}, allowRetry = true) {
  const token = getReviewerToken();
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token && !headers["x-reviewer-token"] && !headers.authorization) {
    headers["x-reviewer-token"] = token;
  }
  const response = await fetch(path, {
    headers,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && allowRetry) {
      const nextToken = window.prompt("Enter reviewer token (required for POST actions)", token);
      if (nextToken === null) throw new Error(data.error || "Request failed");
      const trimmed = nextToken.trim();
      if (trimmed) window.sessionStorage.setItem("reviewerAuthToken", trimmed);
      else window.sessionStorage.removeItem("reviewerAuthToken");
      return api(path, options, false);
    }
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function formatRunName(review) {
  try {
    const url = new URL(review.repoUrl);
    return url.pathname.replace(/^\/|\.git$/g, "") || review.repoUrl;
  } catch {
    return review.repoUrl;
  }
}

function updateMetrics(review) {
  metrics.files.textContent = review?.summary?.filesScanned ?? 0;
  metrics.errors.textContent = review?.summary?.errorsFound ?? 0;
  metrics.proposals.textContent = review?.summary?.proposalsFound ?? 0;
  metrics.stack.textContent = review?.status ?? "Waiting";
}

function renderHistory() {
  historyList.innerHTML = reviews.length
    ? reviews
        .map(
          (review) => `
            <button class="history-item ${selectedReview?.id === review.id ? "active" : ""}" data-run-id="${escapeHtml(review.id)}" type="button">
              <strong>${escapeHtml(formatRunName(review))}</strong>
              <span>${escapeHtml(review.status || "unknown")} / ${escapeHtml(new Date(review.createdAt).toLocaleString())}</span>
            </button>
          `,
        )
        .join("")
    : `<div class="record"><p>No background jobs yet.</p></div>`;
}

function isClosedProposal(proposal) {
  return ["pushed", "rejected", "committed"].includes(proposal.status);
}

function marketGapProposalId(feature) {
  return `market-gap-${String(feature || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function proposalById(review, proposalId) {
  return (review.proposals || []).find((proposal) => proposal.id === proposalId);
}

function optionList(values, selected, allLabel, allValue = "all") {
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    `<option value="${escapeHtml(allValue)}">${escapeHtml(allLabel)}</option>`,
    ...unique.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`),
  ].join("");
}

function proposalMatchesFilters(proposal) {
  const haystack = [proposal.title, proposal.summary, proposal.category, proposal.risk, proposal.status, proposal.action?.body]
    .join(" ")
    .toLowerCase();
  const matchesSearch = !proposalFilters.search || haystack.includes(proposalFilters.search.toLowerCase());
  const matchesCategory = proposalFilters.category === "all" || proposal.category === proposalFilters.category;
  const matchesRisk = proposalFilters.risk === "all" || proposal.risk === proposalFilters.risk;
  const matchesStatus =
    proposalFilters.status === "all" ||
    (proposalFilters.status === "open" ? !isClosedProposal(proposal) : proposal.status === proposalFilters.status);
  return matchesSearch && matchesCategory && matchesRisk && matchesStatus;
}

function visibleProposalIds() {
  return [...panels.proposals.querySelectorAll("input[type='checkbox']:not(:disabled)")].map((input) => input.value);
}

function renderProposalToolbar(review, visibleProposals) {
  const proposals = review.proposals || [];
  proposalToolbar.classList.toggle("hidden", activeTab !== "proposals" || !proposals.length);
  proposalCategory.innerHTML = optionList(proposals.map((proposal) => proposal.category), proposalFilters.category, "All categories");
  proposalRisk.innerHTML = optionList(proposals.map((proposal) => proposal.risk), proposalFilters.risk, "All risks");
  proposalStatus.innerHTML = optionList(proposals.map((proposal) => proposal.status), proposalFilters.status, "All statuses");
  proposalStatus.insertAdjacentHTML("afterbegin", `<option value="open" ${proposalFilters.status === "open" ? "selected" : ""}>Open proposals</option>`);
  proposalSearch.value = proposalFilters.search;

  const actionable = visibleProposals.filter((proposal) => !isClosedProposal(proposal));
  const selected = selectedProposalIds().length;
  proposalFilterSummary.textContent = `${visibleProposals.length} visible / ${selected} selected`;
  selectVisibleButton.disabled = !actionable.length;
  rejectVisibleButton.disabled = selectedReview?.status !== "completed" || !actionable.length;
  clearSelectionButton.disabled = !selected;
}

function renderProposals(review) {
  const visibleProposals = (review.proposals || []).filter(proposalMatchesFilters);
  renderProposalToolbar(review, visibleProposals);
  panels.proposals.innerHTML = review.proposals.length
    ? visibleProposals.length
      ? visibleProposals
        .map(
          (proposal) => `
            <article class="proposal ${proposal.risk === "medium" ? "is-medium-risk" : ""}">
              <input type="checkbox" value="${escapeHtml(proposal.id)}" ${isClosedProposal(proposal) ? "disabled" : ""} aria-label="Select ${escapeHtml(proposal.title)}" />
              <div>
                <h3>${escapeHtml(proposal.title)}</h3>
                <p>${escapeHtml(proposal.summary)}</p>
                ${proposal.rejectionReason ? `<p class="decision-note">${escapeHtml(proposal.rejectionReason)}</p>` : ""}
                <div class="meta-row">
                  <span class="badge">${escapeHtml(proposal.category)}</span>
                  <span class="badge ${proposal.risk === "medium" ? "warn" : ""}">${escapeHtml(proposal.risk)} risk</span>
                </div>
              </div>
              <span class="badge ${
                ["pushed", "committed"].includes(proposal.status)
                  ? "success"
                  : ["rejected", "push_failed"].includes(proposal.status)
                    ? "danger"
                    : ""
              }">${escapeHtml(proposal.status)}</span>
            </article>
          `,
        )
        .join("")
      : `<div class="record"><p>No proposals match the current filters.</p></div>`
    : `<div class="record"><p>${escapeHtml(["queued", "running"].includes(review.status) ? "Background review is still running." : "No proposals were generated for this run.")}</p></div>`;
}

function renderRecords(container, records, emptyText, mapper) {
  container.innerHTML = records.length
    ? records.map((record) => `<article class="record">${mapper(record)}</article>`).join("")
    : `<div class="record"><p>${escapeHtml(emptyText)}</p></div>`;
}

function renderComparisons(review) {
  const comparisons = review.comparisons || {};
  const marketProducts = comparisons.marketProducts || [];
  const featureGaps = comparisons.featureGaps || [];
  const repos = comparisons.githubRepositories || [];
  const packages = comparisons.npmPackages || [];
  const ideas = comparisons.fallbackFeatureIdeas || [];
  const missingGaps = featureGaps.filter((gap) => gap.gap);
  panels.comparisons.innerHTML = `
    <article class="record comparison-summary">
      <h3>${escapeHtml(comparisons.category || "No category inferred")}</h3>
      <p>${escapeHtml((comparisons.searchTerms || []).join(", ") || "No search terms recorded.")}</p>
      <div class="meta-row">
        <span class="badge">${escapeHtml(marketProducts.length)} tools compared</span>
        <span class="badge ${missingGaps.length ? "warn" : "success"}">${escapeHtml(missingGaps.length)} missing feature gaps</span>
      </div>
      <p class="comparison-note">Missing market features are converted into approval proposals. Select a gap here, then approve and push to update the target repository.</p>
    </article>
    <article class="record">
      <h3>Market/web apps compared</h3>
      ${
        marketProducts.length
          ? `<div class="comparison-list">${marketProducts
              .map(
                (product) => `
                  <a class="comparison-item" href="${escapeHtml(product.url)}" target="_blank" rel="noreferrer">
                    <strong>${escapeHtml(product.name)}</strong>
                    <span>${escapeHtml(product.positioning)}</span>
                    <small>${escapeHtml(product.features.join(", "))}</small>
                    <small>${product.reachable ? "source reachable" : "source not reachable during scan"}</small>
                  </a>
                `,
              )
              .join("")}</div>`
          : `<p>No market/web products were recorded for this run.</p>`
      }
    </article>
    <article class="record">
      <h3>Feature gap matrix</h3>
      ${
        featureGaps.length
          ? `<div class="comparison-list">${featureGaps
              .slice(0, 18)
              .map(
                (gap) => `
                  <div class="comparison-item">
                    <div class="comparison-item-header">
                      <strong>${escapeHtml(gap.feature)}</strong>
                      <span class="badge ${gap.present ? "success" : "warn"}">${gap.present ? "implemented" : "missing"}</span>
                    </div>
                    <span>${gap.present ? "Detected in this app" : "Not detected in this app"}</span>
                    <small>Seen in ${escapeHtml(gap.seenIn.join(", "))}</small>
                    ${
                      gap.gap
                        ? (() => {
                            const proposalId = marketGapProposalId(gap.feature);
                            const proposal = proposalById(review, proposalId);
                            const disabled = !proposal || isClosedProposal(proposal);
                            return `<button class="secondary-button comparison-select" data-select-proposal="${escapeHtml(proposalId)}" type="button" ${disabled ? "disabled" : ""}>
                              ${proposal ? `Select proposal (${escapeHtml(proposal.status)})` : "Proposal not available"}
                            </button>`;
                          })()
                        : ""
                    }
                  </div>
                `,
              )
              .join("")}</div>`
          : `<p>No feature matrix was recorded.</p>`
      }
    </article>
    <article class="record">
      <h3>GitHub repos compared</h3>
      ${
        repos.length
          ? `<div class="comparison-list">${repos
              .map(
                (repo) => `
                  <a class="comparison-item" href="${escapeHtml(repo.url)}" target="_blank" rel="noreferrer">
                    <strong>${escapeHtml(repo.fullName)}</strong>
                    <span>${escapeHtml(repo.description || "No description available.")}</span>
                    <small>${escapeHtml(repo.stars)} stars / matched "${escapeHtml(repo.term)}"</small>
                  </a>
                `,
              )
              .join("")}</div>`
          : `<p>No relevant public GitHub comparable tools were found. The app used generated feature proposals instead.</p>`
      }
    </article>
    <article class="record">
      <h3>npm packages compared</h3>
      ${
        packages.length
          ? `<div class="comparison-list">${packages
              .map(
                (pkg) => `
                  <div class="comparison-item">
                    <strong>${escapeHtml(pkg.name)}@${escapeHtml(pkg.version)}</strong>
                    <span>${escapeHtml(pkg.description || "No description available.")}</span>
                    <small>matched "${escapeHtml(pkg.term)}"</small>
                  </div>
                `,
              )
              .join("")}</div>`
          : `<p>No relevant npm packages were found for this app category.</p>`
      }
    </article>
    <article class="record">
      <h3>Generated feature ideas</h3>
      <div class="comparison-list">
        ${ideas
          .map(
            (idea) => `
              <div class="comparison-item">
                <strong>${escapeHtml(idea.title)}</strong>
                <span>${escapeHtml(idea.summary)}</span>
              </div>
            `,
          )
          .join("") || "<p>No fallback feature ideas recorded.</p>"}
      </div>
    </article>
  `;
}

function renderReview(review) {
  selectedReview = review;
  emptyState.classList.add("hidden");
  reviewContent.classList.remove("hidden");
  reviewTitle.textContent = `${formatRunName(review)} / ${review.status || "unknown"}`;
  updateMetrics(review);
  renderHistory();
  renderProposals(review);
  renderComparisons(review);
  renderRecords(panels.errors, review.errors, "No errors found.", (error) => `
    <h3>${escapeHtml(error.message)}</h3>
    <p>${escapeHtml(error.detail || error.area)}</p>
    <div class="meta-row">
      <span class="badge danger">${escapeHtml(error.severity)}</span>
      <span class="badge">${escapeHtml(error.area)}</span>
    </div>
  `);
  renderRecords(panels.fixes, review.fixes, "No fixes were applied.", (fix) => `
    <h3>${escapeHtml(fix.status)}</h3>
    <p>${escapeHtml(fix.message)}</p>
  `);
  renderRecords(panels.logs, review.logs, "No logs captured.", (log) => `
    <h3>${escapeHtml(log.message)}</h3>
    <p>${escapeHtml(log.detail)}</p>
    <div class="meta-row">
      <span class="badge ${log.level === "error" ? "danger" : log.level === "success" ? "success" : ""}">${escapeHtml(log.level)}</span>
      <span class="badge">${escapeHtml(new Date(log.at).toLocaleTimeString())}</span>
    </div>
  `);
  syncDecisionButtons();
}

function selectedProposalIds() {
  return [...panels.proposals.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
}

function syncDecisionButtons() {
  const selected = selectedProposalIds().length;
  const canDecide = selectedReview?.status === "completed";
  approveButton.disabled = !selected || !selectedReview || !canDecide;
  rejectButton.disabled = !selected || !selectedReview || !canDecide;
  if (selectedReview?.proposals?.length) {
    const visibleCount = panels.proposals.querySelectorAll(".proposal").length;
    proposalFilterSummary.textContent = `${visibleCount} visible / ${selected} selected`;
    clearSelectionButton.disabled = !selected;
  }
}

async function loadReviews() {
  reviews = await api("/api/reviews");
  if (reviews.length && !selectedReview) {
    renderReview(reviews[0]);
  } else if (selectedReview) {
    const updated = reviews.find((review) => review.id === selectedReview.id);
    if (updated) renderReview(updated);
  }
  renderHistory();
  window.clearTimeout(loadReviews.pollTimer);
  if (reviews.some((review) => ["queued", "running"].includes(review.status))) {
    loadReviews.pollTimer = window.setTimeout(() => {
      loadReviews().catch((error) => showToast(error.message));
    }, 2500);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  runButton.disabled = true;
  runButton.innerHTML = `<span class="button-icon">Run</span> Queueing`;
  try {
    const review = await api("/api/reviews", {
      method: "POST",
      body: JSON.stringify({ repoUrl: repoInput.value }),
    });
    reviews = [review, ...reviews.filter((item) => item.id !== review.id)];
    renderReview(review);
    loadReviews().catch((error) => showToast(error.message));
    showToast("Background review started. You can queue another repo now.");
  } catch (error) {
    showToast(error.message);
  } finally {
    runButton.disabled = false;
    runButton.innerHTML = `<span class="button-icon">Run</span> Queue`;
  }
});

historyList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-run-id]");
  if (!item) return;
  const review = reviews.find((candidate) => candidate.id === item.dataset.runId);
  if (review) renderReview(review);
});

function activateTab(tabName) {
  activeTab = tabName;
  const tab = document.querySelector(`[data-tab="${tabName}"]`);
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button === tab));
  Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("hidden", name !== tabName));
  proposalToolbar.classList.toggle("hidden", tabName !== "proposals" || !selectedReview?.proposals?.length);
}

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  activateTab(tab.dataset.tab);
});

panels.comparisons.addEventListener("click", (event) => {
  const button = event.target.closest("[data-select-proposal]");
  if (!button || !selectedReview) return;
  const checkbox = panels.proposals.querySelector(`input[value="${CSS.escape(button.dataset.selectProposal)}"]`);
  if (!checkbox || checkbox.disabled) return;
  checkbox.checked = true;
  activateTab("proposals");
  checkbox.closest(".proposal")?.scrollIntoView({ behavior: "smooth", block: "center" });
  syncDecisionButtons();
  showToast("Comparison gap selected. Approve and push when ready.");
});

panels.proposals.addEventListener("change", syncDecisionButtons);

proposalSearch.addEventListener("input", () => {
  proposalFilters.search = proposalSearch.value.trim();
  if (selectedReview) renderProposals(selectedReview);
});

proposalCategory.addEventListener("change", () => {
  proposalFilters.category = proposalCategory.value;
  if (selectedReview) renderProposals(selectedReview);
});

proposalRisk.addEventListener("change", () => {
  proposalFilters.risk = proposalRisk.value;
  if (selectedReview) renderProposals(selectedReview);
});

proposalStatus.addEventListener("change", () => {
  proposalFilters.status = proposalStatus.value;
  if (selectedReview) renderProposals(selectedReview);
});

selectVisibleButton.addEventListener("click", () => {
  panels.proposals.querySelectorAll("input[type='checkbox']:not(:disabled)").forEach((input) => {
    input.checked = true;
  });
  syncDecisionButtons();
});

clearSelectionButton.addEventListener("click", () => {
  panels.proposals.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.checked = false;
  });
  syncDecisionButtons();
});

rejectVisibleButton.addEventListener("click", async () => {
  const proposalIds = visibleProposalIds();
  if (!proposalIds.length || !selectedReview) return;
  rejectVisibleButton.disabled = true;
  try {
    const review = await api(`/api/reviews/${selectedReview.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ proposalIds, reason: "Bulk rejected from proposal filters." }),
    });
    reviews = reviews.map((item) => (item.id === review.id ? review : item));
    renderReview(review);
    showToast("Visible proposals rejected.");
  } catch (error) {
    showToast(error.message);
  } finally {
    syncDecisionButtons();
  }
});

approveButton.addEventListener("click", async () => {
  const proposalIds = selectedProposalIds();
  approveButton.disabled = true;
  approveButton.innerHTML = `<span class="button-icon">OK</span> Pushing`;
  try {
    const review = await api(`/api/reviews/${selectedReview.id}/approve`, {
      method: "POST",
      body: JSON.stringify({ proposalIds }),
    });
    reviews = reviews.map((item) => (item.id === review.id ? review : item));
    renderReview(review);
    showToast(
      review.lastApproval?.pushed
        ? `Approved proposals pushed to ${review.lastApproval.pushBranch || "the target repo"}.`
        : "Commit created, but push failed. Check fixes/logs.",
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    approveButton.innerHTML = `<span class="button-icon">OK</span> Approve and push`;
    syncDecisionButtons();
  }
});

rejectButton.addEventListener("click", async () => {
  const proposalIds = selectedProposalIds();
  rejectButton.disabled = true;
  try {
    const review = await api(`/api/reviews/${selectedReview.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ proposalIds, reason: "Rejected from operator UI." }),
    });
    reviews = reviews.map((item) => (item.id === review.id ? review : item));
    renderReview(review);
    showToast("Selected proposals rejected.");
  } catch (error) {
    showToast(error.message);
  } finally {
    syncDecisionButtons();
  }
});

refreshButton.addEventListener("click", () => {
  loadReviews().catch((error) => showToast(error.message));
});

loadReviews().catch((error) => showToast(error.message));
