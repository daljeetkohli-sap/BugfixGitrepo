const form = document.querySelector("#review-form");
const repoInput = document.querySelector("#repo-url");
const runButton = document.querySelector("#run-button");
const refreshButton = document.querySelector("#refresh-button");
const approveButton = document.querySelector("#approve-button");
const rejectButton = document.querySelector("#reject-button");
const historyList = document.querySelector("#history-list");
const emptyState = document.querySelector("#empty-state");
const reviewContent = document.querySelector("#review-content");
const reviewTitle = document.querySelector("#review-title");
const toast = document.querySelector("#toast");
const panels = {
  proposals: document.querySelector("#tab-proposals"),
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
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
  return ["pushed", "push_failed", "rejected", "committed"].includes(proposal.status);
}

function renderProposals(review) {
  panels.proposals.innerHTML = review.proposals.length
    ? review.proposals
        .map(
          (proposal) => `
            <article class="proposal">
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
    : `<div class="record"><p>${escapeHtml(["queued", "running"].includes(review.status) ? "Background review is still running." : "No proposals were generated for this run.")}</p></div>`;
}

function renderRecords(container, records, emptyText, mapper) {
  container.innerHTML = records.length
    ? records.map((record) => `<article class="record">${mapper(record)}</article>`).join("")
    : `<div class="record"><p>${escapeHtml(emptyText)}</p></div>`;
}

function renderReview(review) {
  selectedReview = review;
  emptyState.classList.add("hidden");
  reviewContent.classList.remove("hidden");
  reviewTitle.textContent = `${formatRunName(review)} / ${review.status || "unknown"}`;
  updateMetrics(review);
  renderHistory();
  renderProposals(review);
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

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button === tab));
  Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("hidden", name !== tab.dataset.tab));
});

panels.proposals.addEventListener("change", syncDecisionButtons);

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
    showToast(review.lastApproval?.pushed ? "Approved proposals pushed to the target repo." : "Commit created, but push failed. Check fixes/logs.");
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
