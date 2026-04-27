const viewerList = document.querySelector("#viewer-list");
const refreshButton = document.querySelector("#viewer-refresh");
const summaryText = document.querySelector("#viewer-summary-text");
const toast = document.querySelector("#toast");
const metrics = {
  runs: document.querySelector("#metric-runs"),
  errors: document.querySelector("#metric-errors"),
  proposals: document.querySelector("#metric-proposals"),
  committed: document.querySelector("#metric-committed"),
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

async function api(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
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

function renderReview(review) {
  const committed = review.proposals.filter((proposal) => proposal.status === "committed");
  const proposalItems = review.proposals.length
    ? review.proposals
        .map(
          (proposal) => `
            <li>
              <strong>${escapeHtml(proposal.title)}</strong>
              <span>${escapeHtml(proposal.summary)}</span>
              <small>${escapeHtml(proposal.category)} / ${escapeHtml(proposal.risk)} risk / ${escapeHtml(proposal.status)}</small>
            </li>
          `,
        )
        .join("")
    : "<li><span>No proposals generated.</span></li>";
  const errorItems = review.errors.length
    ? review.errors
        .map(
          (error) => `
            <li>
              <strong>${escapeHtml(error.message)}</strong>
              <span>${escapeHtml(error.detail || error.area)}</span>
              <small>${escapeHtml(error.severity)} / ${escapeHtml(error.area)}</small>
            </li>
          `,
        )
        .join("")
    : "<li><span>No errors captured.</span></li>";

  return `
    <article class="viewer-card">
      <header class="viewer-card-header">
        <div>
          <p class="eyebrow">${escapeHtml(new Date(review.createdAt).toLocaleString())}</p>
          <h2>${escapeHtml(formatRunName(review))}</h2>
        </div>
        <span class="badge ${committed.length ? "success" : ""}">${committed.length} committed</span>
      </header>
      <div class="viewer-card-grid">
        <section>
          <h3>Proposals</h3>
          <ul>${proposalItems}</ul>
        </section>
        <section>
          <h3>Errors</h3>
          <ul>${errorItems}</ul>
        </section>
      </div>
      <footer class="viewer-footer">
        <span>${escapeHtml(review.summary.filesScanned)} files scanned</span>
        <span>${escapeHtml(review.summary.detectedStack)}</span>
        <span>${escapeHtml(review.repoUrl)}</span>
      </footer>
    </article>
  `;
}

async function loadReviews() {
  const reviews = await api("/api/reviews");
  const errors = reviews.reduce((total, review) => total + review.errors.length, 0);
  const proposals = reviews.reduce((total, review) => total + review.proposals.length, 0);
  const committed = reviews.reduce(
    (total, review) => total + review.proposals.filter((proposal) => proposal.status === "committed").length,
    0,
  );
  metrics.runs.textContent = reviews.length;
  metrics.errors.textContent = errors;
  metrics.proposals.textContent = proposals;
  metrics.committed.textContent = committed;
  summaryText.textContent = reviews.length
    ? "This read-only page lets stakeholders inspect review output and approved changes. Approved target repos receive Markdown audit records with the change progress."
    : "No review runs are available yet. Run one from the operator console, then share this view.";
  viewerList.innerHTML = reviews.length
    ? reviews.map(renderReview).join("")
    : `<article class="viewer-card"><h2>No review runs yet</h2><p>Run a repository review from the operator console first.</p></article>`;
}

refreshButton.addEventListener("click", () => {
  loadReviews().catch((error) => showToast(error.message));
});

loadReviews().catch((error) => showToast(error.message));
