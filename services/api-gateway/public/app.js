(() => {
  const $ = (selector) => document.querySelector(selector);
  const state = { repos: [], reviews: [], details: new Map(), status: 'all', section: 'overview', loading: false, cluster: null };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      let detail = payload.details;
      if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch {} }
      if (detail && typeof detail === 'object') detail = detail.details || detail.error;
      const message = payload.error || payload.message || `Request failed (${response.status})`;
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
    return payload;
  };
  const timeAgo = (value) => {
    if (!value) return 'just now';
    const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const initials = (value) => String(value || 'R').split(/[-_.\s/]/).filter(Boolean).slice(-2).map((part) => part[0]).join('').toUpperCase() || 'R';
  const shortName = (repo) => repo.full_name || `${repo.owner}/${repo.name}`;
  const toast = (message, error = false) => {
    const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message;
    $('#toast-region').append(node); setTimeout(() => node.remove(), 4200);
  };
  const setHealth = (healthy) => {
    const node = $('#health-status'); node.textContent = healthy ? 'connected' : 'unavailable'; node.classList.toggle('down', !healthy);
  };

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const [repos, reviews] = await Promise.all([api('/api/repos'), api('/api/reviews?limit=50')]);
      state.repos = Array.isArray(repos) ? repos : [];
      state.reviews = Array.isArray(reviews) ? reviews : [];
      setHealth(true); render();
      const missing = state.reviews.filter((run) => !state.details.has(String(run.id)));
      await Promise.all(missing.map(async (run) => {
        try { state.details.set(String(run.id), await api(`/api/reviews/${encodeURIComponent(run.id)}`)); }
        catch { state.details.set(String(run.id), null); }
      }));
      render();
      await refreshCluster();
    } catch (error) {
      setHealth(false);
      if (!state.repos.length && !state.reviews.length) render();
      toast(error.message || 'Could not connect to the API gateway.', true);
    } finally { state.loading = false; }
  }

  async function refreshCluster() {
    const content = $('#scaling-content');
    try {
      const cluster = await api('/api/cluster/scaling');
      state.cluster = cluster;
      const services = cluster.services || [];
      $('#cluster-caption').textContent = `Namespace ${cluster.namespace} · updated ${timeAgo(cluster.sampled_at)}`;
      content.innerHTML = services.length ? services.map((service) => {
        const current = Number(service.ready || 0), desired = Number(service.desired || 0);
        const ratio = desired ? Math.min(100, Math.round((current / desired) * 100)) : 0;
        const hpa = service.hpa;
        const pods = (service.pods || []).map((pod) => `<span class="pod-pill ${pod.ready ? 'pod-ready' : 'pod-pending'}"><i></i>${escapeHtml(pod.name || 'pod')} <small>${escapeHtml(pod.phase)}</small></span>`).join('');
        return `<article class="scaling-service"><div class="scaling-service-top"><div><strong>${escapeHtml(service.name)}</strong><span>${hpa ? `HPA · ${hpa.min}–${hpa.max} replicas` : 'Fixed replica count'}</span></div><b class="replica-count ${current < desired ? 'replica-warning' : ''}">${current}<small> / ${desired} ready</small></b></div><div class="replica-track"><i style="width:${ratio}%"></i></div><div class="scaling-service-meta"><span>${service.replicas} pods · ${current === desired ? 'all requested pods ready' : `${Math.max(0, desired - current)} starting or unavailable`}</span>${hpa ? `<span>CPU ${hpa.currentCpu == null ? '—' : `${hpa.currentCpu}%`} / ${hpa.cpuTarget ?? '—'}% target · desired ${hpa.desired}</span>` : '<span>Autoscaling not configured</span>'}</div>${pods ? `<div class="pod-list">${pods}</div>` : '<div class="scaling-no-pods">No pods currently reported.</div>'}</article>`;
      }).join('') : '<div class="scaling-empty">No deployments found in this namespace.</div>';
    } catch (error) {
      state.cluster = null;
      $('#cluster-caption').textContent = 'Live replica data requires the dashboard Kubernetes role and a cluster deployment.';
      content.innerHTML = `<div class="scaling-unavailable"><span class="cluster-offline-mark">↗</span><div><strong>Kubernetes status isn’t available here</strong><p>${escapeHtml(error.message || 'Connect to a cluster to view pod counts and HPA activity.')}</p><code>kubectl get deployments,hpa,pods -n codereviewx -w</code></div></div>`;
    }
  }

  function render() {
    const finished = state.reviews.filter((run) => run.status === 'completed');
    const active = state.reviews.filter((run) => ['queued', 'running'].includes(run.status));
    let findingTotal = 0;
    state.reviews.forEach((run) => { const detail = state.details.get(String(run.id)); if (detail?.findings) findingTotal += detail.findings.length; });
    $('#stat-total').textContent = String(state.reviews.length);
    $('#stat-findings').textContent = String(findingTotal);
    $('#stat-repos').textContent = String(state.repos.length);
    $('#stat-queued').textContent = String(active.length);
    $('#nav-review-count').textContent = String(state.reviews.length);
    $('#nav-repo-count').textContent = String(state.repos.length);
    $('#review-total-chip').textContent = String(state.reviews.length);
    $('#repo-total-chip').textContent = String(state.repos.length);
    renderRepos(); renderReviews(); updateReviewRepoSelect();
  }

  function renderRepos() {
    const rail = $('#repository-list'), side = $('#sidebar-repos');
    rail.innerHTML = state.repos.slice(0, 5).map((repo) => `<div class="repository-item"><div class="repo-avatar">${escapeHtml(initials(repo.name))}</div><div class="repo-item-copy"><strong>${escapeHtml(repo.name)}</strong><span>${escapeHtml(repo.owner)} · connected ${timeAgo(repo.created_at)}</span></div><span class="repo-open">↗</span></div>`).join('');
    side.innerHTML = state.repos.slice(0, 8).map((repo) => `<a href="#repositories" class="repo-nav-item" data-repository="${escapeHtml(shortName(repo))}"><span class="repo-glyph">${escapeHtml(initials(repo.name).slice(0, 1))}</span><span>${escapeHtml(shortName(repo))}</span></a>`).join('');
    const empty = state.repos.length === 0;
    $('#repos-empty').classList.toggle('hidden', !empty);
    rail.classList.toggle('hidden', empty);
    $('#add-repo-link').classList.toggle('hidden', empty);
  }

  function renderReviews() {
    const query = $('#review-search').value.trim().toLowerCase();
    const rows = state.reviews.filter((run) => {
      const haystack = `${run.repository_owner}/${run.repository_name} ${run.pull_number || ''} ${run.status} ${run.summary || ''}`.toLowerCase();
      return haystack.includes(query) && (state.status === 'all' || run.status === state.status);
    });
    const body = $('#review-list');
    body.innerHTML = rows.slice(0, 12).map((run) => {
      const repo = `${run.repository_owner}/${run.repository_name}`;
      const detail = state.details.get(String(run.id));
      const findingCount = detail?.findings?.length;
      const status = String(run.status || 'queued').toLowerCase();
      const statusClass = ['queued', 'running', 'completed', 'failed'].includes(status) ? status : 'queued';
      const label = status === 'running' ? 'Reviewing' : status;
      return `<tr class="review-row" data-review-id="${escapeHtml(run.id)}" tabindex="0"><td><div class="review-primary"><span class="review-repo-glyph">${escapeHtml(initials(run.repository_name).slice(0, 1))}</span><div class="review-primary-copy"><strong>${escapeHtml(repo)}</strong><span class="pr-number">${run.pull_number ? `PR #${escapeHtml(run.pull_number)}` : 'Commit review'} <span style="color:#687889">· ${escapeHtml(run.event_type || 'manual')}</span></span></div></div></td><td><span class="status-badge status-${statusClass}">${escapeHtml(label)}</span></td><td><span class="finding-count${findingCount === 0 ? ' zero' : ''}">${findingCount === undefined ? '—' : findingCount === 0 ? '0' : `<span class="finding-high">${findingCount}</span>`}</span></td><td><span class="when-text">${timeAgo(run.created_at)}</span></td><td><span class="row-arrow">›</span></td></tr>`;
    }).join('');
    const empty = rows.length === 0;
    $('#reviews-empty').classList.toggle('hidden', !empty);
    body.classList.toggle('hidden', empty);
    $('#review-footer-text').textContent = state.reviews.length ? `Showing ${Math.min(rows.length, 12)} of ${state.reviews.length} recent reviews` : 'Waiting for your first review';
  }

  function updateReviewRepoSelect() {
    const select = $('#review-repo'), oldValue = select.value;
    select.innerHTML = '<option value="">Choose a connected repository</option>' + state.repos.map((repo) => `<option value="${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}">${escapeHtml(shortName(repo))}</option>`).join('');
    if ([...select.options].some((option) => option.value === oldValue)) select.value = oldValue;
  }

  function openModal(mode) {
    const reviewMode = mode === 'review';
    $('#repo-form').classList.toggle('hidden', reviewMode);
    $('#review-form').classList.toggle('hidden', !reviewMode);
    $('#modal-kicker').textContent = reviewMode ? 'START A FRESH REVIEW' : "LET'S GET CONNECTED";
    $('#modal-title').textContent = reviewMode ? 'Review a pull request' : 'Add a repository';
    $('#modal-description').textContent = reviewMode ? 'Pick a connected repository and PR. We’ll fetch its latest diff and queue the review.' : 'Link a GitHub repository to bring its pull requests into your review flow.';
    $('#repo-error').classList.add('hidden'); $('#review-error').classList.add('hidden');
    updateReviewRepoSelect();
    if (reviewMode && !state.repos.length) { closeModal(); toast('Add a repository before queueing a review.', true); openModal('repo'); return; }
    $('#modal-backdrop').classList.remove('hidden');
    setTimeout(() => (reviewMode ? $('#review-repo') : $('#repo-owner')).focus(), 50);
  }
  function closeModal() { $('#modal-backdrop').classList.add('hidden'); }

  function renderDiffFile(file) {
    if (!file?.patch) return '<div class="diff-unavailable">GitHub did not return a patch for this file. It may be binary or exceed GitHub?s diff limit.</div>';
    let oldLine = 0, newLine = 0;
    const lines = String(file.patch).split('\n').map((line) => {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return `<div class="diff-hunk">${escapeHtml(line)}</div>`; }
      if (line.startsWith('+')) return `<div class="diff-line diff-add"><span>${newLine++}</span><span></span><code>${escapeHtml(line.slice(1))}</code></div>`;
      if (line.startsWith('-')) return `<div class="diff-line diff-remove"><span></span><span>${oldLine++}</span><code>${escapeHtml(line.slice(1))}</code></div>`;
      if (line.startsWith('\\')) return `<div class="diff-meta">${escapeHtml(line)}</div>`;
      if (line.startsWith(' ')) return `<div class="diff-line"><span>${newLine++}</span><span>${oldLine++}</span><code>${escapeHtml(line.slice(1))}</code></div>`;
      return `<div class="diff-meta">${escapeHtml(line)}</div>`;
    }).join('');
    return `<div class="diff-code">${lines}</div>`;
  }

  async function showReview(id) {
    let detail = state.details.get(String(id));
    if (!detail) {
      try { detail = await api(`/api/reviews/${encodeURIComponent(id)}`); state.details.set(String(id), detail); }
      catch (error) { toast(error.message || 'Could not load review details.', true); return; }
    }
    const findings = Array.isArray(detail.findings) ? detail.findings : [];
    let files = Array.isArray(detail.files) ? detail.files : null;
    let diffLoaded = Boolean(files);
    const status = String(detail.status || 'queued');
    const summary = detail.summary || (status === 'queued' || status === 'running' ? 'The worker is looking through this pull request. Check back in a moment for the review summary.' : 'No summary was returned for this review.');
    const confidenceValue = (value) => Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
    const findingMarkup = findings.length ? findings.map((item) => {
      const confidence = confidenceValue(item.confidence);
      return `<article class="finding-card"><div class="finding-top"><span class="severity severity-${escapeHtml(item.severity || 'info')}">${escapeHtml(item.severity || 'info')}</span><strong>${escapeHtml(item.title || 'Review finding')}</strong><span class="confidence-chip">${confidence}% confidence</span></div><p>${escapeHtml(item.body || '')}</p>${item.file_path ? `<button class="finding-file" data-open-file="${escapeHtml(item.file_path)}">${escapeHtml(item.file_path)}${item.line_number ? ` :${escapeHtml(item.line_number)}` : ''} <span>View diff &gt;</span></button>` : ''}${item.suggestion ? `<div class="finding-suggestion"><span>Suggested fix</span>${escapeHtml(item.suggestion)}</div>` : ''}<div class="confidence-track"><i style="width:${confidence}%"></i></div></article>`;
    }).join('') : `<div class="finding-none">${status === 'completed' ? 'No actionable findings. Looking good.' : status === 'failed' ? escapeHtml(detail.error || 'The review failed.') : 'Findings will appear here when the review completes.'}</div>`;
    const buildDiffMarkup = () => {
      const list = files || [];
      const fileMarkup = list.length ? list.map((file, index) => `<button class="diff-file-button ${index === 0 ? 'active' : ''}" data-diff-index="${index}"><span class="diff-file-status">${escapeHtml(file.status || 'modified')}</span><strong>${escapeHtml(file.filename || 'Changed file')}</strong><small><i>+${Number(file.additions || 0)}</i> <b>-${Number(file.deletions || 0)}</b></small></button>`).join('') : '<div class="finding-none">No diff files were returned. Check GitHub access and try again.</div>';
      const additions = list.reduce((total, file) => total + Number(file.additions || 0), 0);
      const deletions = list.reduce((total, file) => total + Number(file.deletions || 0), 0);
      const initialDiff = list.length ? `<div class="diff-file-heading"><strong>${escapeHtml(list[0].filename || 'Changed file')}</strong><span>${escapeHtml(list[0].status || 'modified')} | +${Number(list[0].additions || 0)} -${Number(list[0].deletions || 0)}</span></div><div class="diff-selected">${renderDiffFile(list[0])}</div>` : '';
      return `<div class="diff-overview"><strong>${list.length} changed ${list.length === 1 ? 'file' : 'files'}</strong><span><i>+${additions}</i> / <b>-${deletions}</b></span></div><div class="diff-layout"><nav class="diff-file-list" aria-label="Changed files">${fileMarkup}</nav><div class="diff-content">${initialDiff}</div></div>`;
    };
    const overlay = document.createElement('div'); overlay.className = 'detail-overlay';
    overlay.innerHTML = `<section class="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="detail-topline"><span class="modal-kicker">REVIEW RUN #${escapeHtml(detail.id)}</span><button class="icon-button detail-close" aria-label="Close review">X</button></div><div class="detail-repo">${escapeHtml(detail.repository_owner)}/${escapeHtml(detail.repository_name)} | PR #${escapeHtml(detail.pull_number || '-')}</div><div class="review-title-row"><div><h2 id="detail-title">Pull request review</h2><div class="detail-meta">Started ${timeAgo(detail.created_at)}${detail.completed_at ? ` | Completed ${timeAgo(detail.completed_at)}` : ''}</div></div><span class="status-badge status-${['queued','running','completed','failed'].includes(status) ? status : 'queued'}">${escapeHtml(status === 'running' ? 'Reviewing' : status)}</span></div><div class="review-tabs" role="tablist"><button class="review-tab active" data-review-tab="findings">Review <span>${findings.length}</span></button><button class="review-tab" data-review-tab="diff">Changes <span>${files ? files.length : '?'}</span></button></div><div class="review-tab-panel" data-panel="findings"><div class="detail-summary"><div class="detail-section-label">REVIEW SUMMARY</div><p>${escapeHtml(summary)}</p></div><div class="detail-section-heading"><span>Findings</span><span class="soft-chip">${findings.length}</span></div><div class="finding-list">${findingMarkup}</div></div><div class="review-tab-panel hidden" data-panel="diff"><div class="diff-overview"><span class="scaling-loading">Open Changes to load the pull request diff.</span></div></div></section></div>`;
    document.body.append(overlay);
    const close = () => overlay.remove();
    let diffPromise = null;
    const loadDiff = async () => {
      const panel = overlay.querySelector('[data-panel="diff"]');
      if (!diffLoaded) {
        if (!diffPromise) diffPromise = (async () => {
          panel.innerHTML = '<div class="scaling-loading">Loading changed files...</div>';
          try { const payload = await api(`/api/reviews/${encodeURIComponent(id)}/diff`); files = Array.isArray(payload.files) ? payload.files : []; diffLoaded = true; return true; }
          catch (error) { panel.innerHTML = `<div class="finding-none">${escapeHtml(error.message || 'Could not load the pull request diff.')}</div>`; return false; }
        })();
        const loaded = await diffPromise;
        if (!loaded) { diffPromise = null; return; }
      }
      panel.innerHTML = buildDiffMarkup();
      overlay.querySelector('[data-review-tab="diff"] span').textContent = String(files.length);
      panel.querySelectorAll('[data-diff-index]').forEach((button) => button.addEventListener('click', () => {
        const file = files[Number(button.dataset.diffIndex)]; if (!file) return;
        panel.querySelectorAll('[data-diff-index]').forEach((item) => item.classList.toggle('active', item === button));
        panel.querySelector('.diff-content').innerHTML = `<div class="diff-file-heading"><strong>${escapeHtml(file.filename || 'Changed file')}</strong><span>${escapeHtml(file.status || 'modified')} | +${Number(file.additions || 0)} -${Number(file.deletions || 0)}</span></div><div class="diff-selected">${renderDiffFile(file)}</div>`;
      }));
    };
    overlay.querySelector('.detail-close').addEventListener('click', close);
    overlay.querySelectorAll('[data-review-tab]').forEach((tab) => tab.addEventListener('click', () => {
      overlay.querySelectorAll('[data-review-tab]').forEach((item) => item.classList.toggle('active', item === tab));
      overlay.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.reviewTab));
      if (tab.dataset.reviewTab === 'diff') loadDiff();
    }));
    overlay.querySelectorAll('[data-open-file]').forEach((button) => button.addEventListener('click', async () => {
      overlay.querySelector('[data-review-tab="diff"]').click();
      if (!diffLoaded) await loadDiff();
      const fileIndex = (files || []).findIndex((file) => file.filename === button.dataset.openFile);
      if (fileIndex >= 0) overlay.querySelector(`[data-diff-index="${fileIndex}"]`)?.click();
    }));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(event) { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  }

  function setSection(section) {
    state.section = section;
    const map = { overview: 'Overview', reviews: 'Review runs', repositories: 'Repositories' };
    $('#current-section').textContent = map[section] || 'Overview';
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === section));
    if (section === 'reviews') $('#reviews-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (section === 'repositories') $('#repos-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  document.querySelectorAll('[data-view]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); setSection(link.dataset.view); }));
  ['#add-repo-top', '#add-repo-icon', '#add-repo-link', '#sidebar-add', '#empty-add-repo'].forEach((selector) => $(selector).addEventListener('click', () => openModal('repo')));
  ['#run-review-top', '#empty-run-review'].forEach((selector) => $(selector).addEventListener('click', () => openModal('review')));
  $('#modal-close').addEventListener('click', closeModal);
  document.querySelectorAll('[data-dismiss]').forEach((button) => button.addEventListener('click', closeModal));
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target === $('#modal-backdrop')) closeModal(); });
  $('#refresh-button').addEventListener('click', refresh);
  $('#refresh-cluster').addEventListener('click', refreshCluster);
  $('#review-search').addEventListener('input', renderReviews);
  $('#status-filter').addEventListener('click', () => {
    const filters = ['all', 'queued', 'running', 'completed', 'failed'];
    state.status = filters[(filters.indexOf(state.status) + 1) % filters.length];
    $('#status-filter').innerHTML = `${state.status === 'all' ? 'All statuses' : state.status[0].toUpperCase() + state.status.slice(1)} <span>⌄</span>`;
    renderReviews();
  });
  $('#review-list').addEventListener('click', (event) => { const row = event.target.closest('[data-review-id]'); if (row) showReview(row.dataset.reviewId); });
  $('#review-list').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { const row = event.target.closest('[data-review-id]'); if (row) { event.preventDefault(); showReview(row.dataset.reviewId); } } });
  $('#view-all-reviews').addEventListener('click', () => { state.status = 'all'; $('#status-filter').innerHTML = 'All statuses <span>⌄</span>'; setSection('reviews'); });
  $('#help-button').addEventListener('click', () => toast('Add a repository, then queue a review using its pull request number.'));

  $('#repo-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#repo-submit'), errorNode = $('#repo-error');
    button.disabled = true; button.textContent = 'Connecting…'; errorNode.classList.add('hidden');
    try {
      const owner = $('#repo-owner').value.trim(), name = $('#repo-name').value.trim();
      await api('/api/repos', { method: 'POST', body: JSON.stringify({ owner, name }) });
      closeModal(); $('#repo-form').reset(); toast(`Connected ${owner}/${name}.`); await refresh();
    } catch (error) { errorNode.textContent = error.message; errorNode.classList.remove('hidden'); }
    finally { button.disabled = false; button.innerHTML = 'Connect repository <span>→</span>'; }
  });
  $('#review-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#review-submit'), errorNode = $('#review-error');
    button.disabled = true; button.textContent = 'Queueing…'; errorNode.classList.add('hidden');
    try {
      const [owner, repo] = $('#review-repo').value.split('/');
      const result = await api('/api/reviews/run', { method: 'POST', body: JSON.stringify({ owner, repo, pull_number: Number($('#pull-number').value) }) });
      closeModal(); $('#review-form').reset(); toast(`Review #${result.review_run_id} added to the queue.`); await refresh();
      if (result.review_run_id) showReview(result.review_run_id);
    } catch (error) { errorNode.textContent = error.message; errorNode.classList.remove('hidden'); }
    finally { button.disabled = false; button.innerHTML = '<svg viewBox="0 0 20 20"><path d="M11.5 2 4 11h5l-.5 7L16 9h-5z"/></svg> Queue review'; }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === '1') { event.preventDefault(); setSection('overview'); }
    if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'r' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) openModal('review');
    if (event.key === 'Escape') closeModal();
  });

  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
  refresh(); setInterval(refresh, 15000);
})();
