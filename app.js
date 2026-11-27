// Rupee Mechanics (RM Inbox) — feeds the Rupee Mechanics studio through the GitHub REST API.
// The token lives only in this browser's localStorage and is sent only to api.github.com.
'use strict';
const $ = id => document.getElementById(id);
const API = 'https://api.github.com';
const APP_VERSION = '2026-11-27f';   // shown in More's footer: which build the phone is running
const K = { tok: 'rm.token', repo: 'rm.repo', branch: 'rm.branch', tab: 'rm.tab' };
const MAX_VIDEO = 90 * 1024 * 1024, MAX_SIDE = 2000, JPEG_Q = 0.85;

const store = {
  get: k => { try { return localStorage.getItem(k) || '' } catch { return '' } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
  del: k => { try { localStorage.removeItem(k) } catch {} },
};
const cfg = () => ({ tok: store.get(K.tok), repo: store.get(K.repo) || 'Arcbha/Finance_Repo', branch: store.get(K.branch) || 'main' });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const tagList = s => s.split(',').map(t => t.trim()).filter(Boolean);
const b64utf8 = s => btoa(unescape(encodeURIComponent(s)));
const utf8b64 = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));

function msg(id, kind, html) { const m = $(id); m.className = 'msg on ' + kind; m.innerHTML = html }
// tap twice to confirm: native confirm() pop-ups are silently blocked in some phone browsers and in-app web views,
// which made Remove look dead (editor, 2026-11-09). First tap arms the button for 4 s, second tap runs.
function armTap(btn, label) {
  if (btn.dataset.armed === '1') { clearTimeout(btn._t); return true }
  const old = btn.innerHTML; btn.dataset.armed = '1'; btn.innerHTML = label; btn.classList.add('armed');
  btn._t = setTimeout(() => { btn.dataset.armed = ''; btn.innerHTML = old; btn.classList.remove('armed') }, 4000);
  return false;
}
const show = id => { const m = $(id); if (m) m.scrollIntoView({ block: 'center' }) };
function clearMsg(id) { $(id).className = 'msg' }
function bar(id, frac) { const b = $(id); if (frac == null) { b.className = 'bar'; return } b.className = 'bar on'; b.firstChild.style.width = Math.round(frac * 100) + '%' }

// ---------- errors in plain words ----------
class GhError extends Error { constructor(status, text) { super(plain(status, text)); this.status = status } }
function plain(status, text) {
  const t = (text || '').toLowerCase();
  if (status === 0) return 'No connection to GitHub. Check your network and try again.';
  if (status === 401) return 'GitHub rejected the token. It may have expired or been revoked. Tap “Forget token” and paste a new one.';
  if (status === 403 && t.includes('rate limit')) return 'GitHub’s rate limit was hit. Wait a few minutes and try again.';
  if (status === 403) return 'The token is missing a permission. It needs Contents: Read and write and Actions: Read-only on Finance_Repo (github.com → Settings → Developer settings → Fine-grained tokens → this token → Repository access must include Finance_Repo).' + (text ? ` GitHub said: “${text}”` : '');
  if (status === 404) return 'Not found. Check the repository and branch names, and that the token includes Finance_Repo.';
  if (status === 409) return 'The repository is empty or the branch is missing.';
  if (status === 413 || t.includes('too large')) return 'The file is too large for GitHub (limit about 100 MB).';
  if (status === 422 && t.includes('update is not a fast forward')) return 'Someone else saved at the same moment.';
  if (status >= 500) return 'GitHub is having trouble right now (' + status + '). Try again in a minute.';
  return 'GitHub said: ' + (text || status);
}
async function api(path, opts = {}) {
  const { tok } = cfg();
  let r;
  try {
    r = await fetch(API + path, { cache: 'no-store', ...opts, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + tok, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  } catch { throw new GhError(0) }
  if (r.status === 204) return null;
  const txt = await r.text();
  if (!r.ok) { let m = txt; try { m = JSON.parse(txt).message } catch {} throw new GhError(r.status, m) }
  return txt ? JSON.parse(txt) : null;
}
// blob upload via XHR so large files report progress
function postBlob(b64, onProgress) {
  const { tok, repo } = cfg();
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${API}/repos/${repo}/git/blobs`);
    x.setRequestHeader('Authorization', 'Bearer ' + tok);
    x.setRequestHeader('Accept', 'application/vnd.github+json');
    x.setRequestHeader('Content-Type', 'application/json');
    if (onProgress) x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { if (x.status >= 200 && x.status < 300) res(JSON.parse(x.responseText).sha); else { let m = x.responseText; try { m = JSON.parse(m).message } catch {} rej(new GhError(x.status, m)) } };
    x.onerror = () => rej(new GhError(0));
    x.send(JSON.stringify({ content: b64, encoding: 'base64' }));
  });
}

// ---------- one commit for many files (Git Data API: blobs → tree → commit → ref) ----------
// files: [{path, b64}] to add, [{path, del:true}] to remove
async function commitFiles(files, message, onProgress, rebuild) {
  const { repo, branch } = cfg();
  const total = files.reduce((n, f) => n + (f.b64 ? f.b64.length : 0), 0) || 1;
  let done = 0;
  const entries = [];
  for (const f of files) {
    if (f.del) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue }
    if (f.sha) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: f.sha }); continue }
    const sha = await postBlob(f.b64, p => onProgress && onProgress(.9 * (done + p * f.b64.length) / total));
    done += f.b64.length;
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  for (let attempt = 1; ; attempt++) {           // blobs are reused; only tree/commit/ref retry on a race
    try {
      const ref = await api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      const head = await api(`/repos/${repo}/git/commits/${ref.object.sha}`);
      const extra = [];
      if (rebuild) for (const f of await rebuild(ref.object.sha)) extra.push({ path: f.path, mode: '100644', type: 'blob', sha: await postBlob(f.b64) });
      const tree = await api(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: [...entries, ...extra] }) });
      const commit = await api(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
      await api(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
      onProgress && onProgress(1);
      return commit;
    } catch (e) {
      if (attempt < 4 && (e.status === 422 || e.status === 409)) { await new Promise(r => setTimeout(r, 600 * attempt)); continue }
      throw e;
    }
  }
}

// ---------- build requests + live bar (editor 2026-11-26) ----------
// A request is studio/schedule/build/<stem>.json → Finance_Repo's build-now Action (Claude account failover, queue, auto-retry
// after a usage limit). While it runs, engine/live_push.sh keeps live.json on the `live` branch: stage, agent, account.
const istStamp = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
function buildFile(slug, kind, note = '', extra = {}) {
  return { path: `studio/schedule/build/build-${istStamp()}-${slug}`.slice(0, 110) + '.json',
    b64: b64utf8(JSON.stringify({ slug, kind, note, ...extra, added: new Date().toISOString(), status: 'pending', by: 'rm-inbox' }, null, 2) + '\n') };
}
const KIND_WORD = { carousel: 'Carousel', poster: 'Poster', reel: 'Reel', premarket: 'Pre-market post', postmarket: 'Post-market post', revise: 'Fix', rate: 'Rating', resume: 'Answer' };
let artStatusAt = 0;
function drawArtPrompt(st) {                       // editor 2026-11-27: "once artworks are all exhausted it can give a prompt at the header"
  const el = $('artPrompt'), off = (() => { try { return localStorage.getItem('rm.artPromptOff') === new Date().toDateString() } catch { return false } })();
  const show = st && st.exhausted && !off;
  el.classList.toggle('hide', !show);
  if (show) el.innerHTML = `<span>${st.pictures ? 'All your artwork has been used — posts are re-using older pictures.' : 'No artwork saved yet for the pre/post-market posts.'} <b>Save more</b></span><button type="button" aria-label="Hide for today">×</button>`;
}
let liveTimer = null, liveOpen = false, liveReq = {}, liveJobs = {}, liveBusy = false, chatJobs = [], chatScan = 0;
// Questions from chat sessions (editor 2026-11-26: "can a prompt come in the app to go and check the Claude app"): a chat run
// that stops for the editor (jobs.py block) pushes its job file to its own claude/* branch with where: "chat" + session_url.
// One GraphQL call (every 2 min) reads studio/jobs on the 12 most recently updated claude/* branches.
async function scanChatJobs() {
  const [o, n] = cfg().repo.split('/');
  const q = `query($o:String!,$n:String!){repository(owner:$o,name:$n){refs(refPrefix:"refs/heads/claude/",first:12,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name target{... on Commit{committedDate file(path:"studio/jobs"){object{... on Tree{entries{name object{... on Blob{text}}}}}}}}}}}}`;
  const r = await api('/graphql', { method: 'POST', body: JSON.stringify({ query: q, variables: { o, n } }) });
  const out = [];
  for (const b of (((r.data || {}).repository || {}).refs || {}).nodes || []) {
    const t = b.target || {};
    if (!t.committedDate || Date.now() - Date.parse(t.committedDate) > 3 * 864e5) continue;
    for (const e of ((t.file || {}).object || {}).entries || []) {
      if (!e.name.endsWith('.json') || !e.object || !e.object.text) continue;
      try { const j = JSON.parse(e.object.text); if (j.status === 'blocked') out.push({ ...j, branch: b.name }) } catch {}
    }
  }
  return out;
}
const mins = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const dur = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
async function dirList(path) {
  const { repo, branch } = cfg();
  return api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`).catch(e => { if (e.status === 404) return []; throw e });
}
function pollLive(ms) { clearTimeout(liveTimer); liveTimer = setTimeout(loadLive, ms) }
async function loadLive() {
  if (!cfg().tok || liveBusy) return; liveBusy = true;
  let next = 90000;
  try {
    const { repo } = cfg();
    const [lv, reqs, jobs] = await Promise.all([
      api(`/repos/${repo}/contents/live.json?ref=live`).then(r => JSON.parse(utf8b64(r.content))).catch(() => ({ runs: [] })),
      dirList('studio/schedule/build'), dirList('studio/jobs')]);
    for (const f of reqs.filter(f => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 10)) {
      const c = liveReq[f.name];
      if (!c || c.sha !== f.sha) liveReq[f.name] = { sha: f.sha, m: await jsonAt(f.path) };
    }
    for (const k of Object.keys(liveReq)) if (!reqs.some(f => f.name === k)) delete liveReq[k];
    for (const f of jobs.filter(f => f.name.endsWith('.json') && f.name !== 'autoresume.json')) {
      const c = liveJobs[f.name];
      if (!c || c.sha !== f.sha) liveJobs[f.name] = { sha: f.sha, m: await jsonAt(f.path) };
    }
    if (Date.now() - artStatusAt > 600000) { artStatusAt = Date.now(); jsonAt('studio/artwork/status.json').then(drawArtPrompt).catch(() => {}) }
    const live = Object.fromEntries((lv.runs || []).map(r => [r.id + '.json', r]));
    const rows = [];
    for (const [name, { m }] of Object.entries(liveReq).sort((a, b) => b[0].localeCompare(a[0]))) {
      if (!m) continue;
      const L = live[name];
      const st = ['pending', 'limited'].includes(m.status) && L && L.status === 'running' && mins(lv.updated) < 5 ? 'running' : (m.status || 'pending');
      const age = mins(m.finished || m.added);
      if ((st === 'done' && age > 90) || (st === 'failed' && age > 720) || st === 'running' && !L && age > 180) continue;
      rows.push({ st, name, m, L });
    }
    if (Date.now() - chatScan > 120000) { chatScan = Date.now(); chatJobs = await scanChatJobs().catch(() => chatJobs) }
    const mainJobs = Object.fromEntries(Object.values(liveJobs).filter(j => j.m).map(j => [j.m.id, j.m]));
    const blocked = Object.values(liveJobs).filter(j => j.m && j.m.status === 'blocked');
    for (const j of chatJobs) {                          // newest copy wins: skip when main has it as recent or newer
      const m = mainJobs[j.id];
      if (m && (m.updated || '') >= (j.updated || '')) continue;
      if (!blocked.some(x => x.m.id === j.id)) blocked.push({ m: j, chatOnly: true });
    }
    drawLive(rows, blocked, lv);
    if (rows.some(r => ['running', 'pending'].includes(r.st))) next = 20000;
  } catch (e) { /* the bar stays as it was; the next poll retries */ }
  liveBusy = false;
  pollLive(document.visibilityState === 'visible' ? next : 300000);
}
function drawLive(rows, blocked, lv) {
  const by = s => rows.filter(r => r.st === s);
  const run = by('running'), wait = by('pending'), lim = by('limited'), bad = by('failed'), done = by('done');
  const any = rows.length + blocked.length;
  $('live').classList.toggle('hide', !any);
  if (!any) return;
  const lead = run[0], dot = run.length ? 'run' : blocked.length || lim.length || wait.length ? 'wait' : bad.length ? 'err' : 'ok';
  const what = r => `${esc(r.m.slug)}${r.L && r.L.agent ? ` · ${esc(r.L.agent)}` : ''}${r.L && r.L.stage ? ` · ${esc(r.L.stage)}` : ''}${r.L && r.L.progress ? ` ${esc(r.L.progress)}` : ''}`;
  const sum = lead ? `<b>Building</b> <span>${what(lead)} · ${dur(mins((lead.L && lead.L.started) || lead.m.added))}</span>`
    : blocked.length ? `<b>Needs you</b> <span>${blocked[0].chatOnly ? 'check the Claude app · ' : ''}${esc(blocked[0].m.id)}</span>`
    : lim.length ? `<b>Paused</b> <span>usage limit — continues by itself</span>`
    : wait.length ? `<b>Starting</b> <span>${esc(wait[0].m.slug)}</span>`
    : bad.length ? `<b>Failed</b> <span>${esc(bad[0].m.slug)}</span>` : `<b>Ready</b> <span>${esc(done[0].m.slug)} — in Studio</span>`;
  const more = run.length + wait.length + lim.length + blocked.length - 1;
  $('liveSum').innerHTML = `<span class="dot ${dot}"></span><span class="t">${sum}${more > 0 ? ` <span>· +${more} more</span>` : ''}</span><span class="chev">${liveOpen ? '▲' : '▼'}</span>`;
  const title = r => `${esc(KIND_WORD[r.m.kind] || r.m.kind)} · ${esc(r.m.slug)}`;
  const row = (d, h, sub, extra = '') => `<div class="lrow"><span class="dot ${d}"></span><div class="b"><div class="h">${h}</div>${sub ? `<div class="d">${sub}</div>` : ''}${extra}</div></div>`;
  const out = [];
  for (const j of blocked) {
    const open = `<a class="btn ${j.chatOnly ? 'primary' : 'ghost'} small" href="${esc(j.m.session_url || 'https://claude.ai/code')}" target="_blank" rel="noopener">Open the chat ↗</a>`;
    out.push(j.chatOnly
      ? row('wait', `Needs you in the Claude app · ${esc(j.m.id)}`, `${esc(j.m.blocked || 'waiting on you')}<br>This run is in a Claude chat — answer it there.`, `<div class="row2">${open}</div>`)
      : row('wait', `Needs you · ${esc(j.m.id)}`, esc(j.m.blocked || 'waiting on you'),
        `<div class="row2"><input placeholder="Your answer" data-ans-in="${esc(j.m.id)}"><button class="btn primary small" data-ans="${esc(j.m.id)}">Send</button>${j.m.where === 'chat' && j.m.session_url ? open : ''}</div>`));
  }
  for (const r of run) {
    const L = r.L || {};
    out.push(row('run', title(r),
      `${L.agent ? `<b>${esc(L.agent)}</b> · ` : ''}${esc(L.stage || 'starting')}${L.progress ? ' ' + esc(L.progress) : ''} · ${dur(mins(L.started || r.m.added))}${L.account ? ` · account ${esc(L.account)}` : ''}${mins(lv.updated) > 3 ? ` · no update for ${dur(mins(lv.updated))}` : ''}`,
      (L.trail || []).length ? `<div class="trail">${L.trail.slice(-5).map((t, i, a) => i === a.length - 1 ? `<b>${esc(t)}</b>` : esc(t)).join(' → ')}</div>` : ''));
  }
  for (const r of wait) out.push(row('wait', title(r), 'waiting for GitHub to start it'));
  for (const r of lim) out.push(row('wait', title(r), esc(r.m.error || 'paused at a usage limit — continues by itself')));
  for (const r of bad) out.push(row('err', title(r), esc((r.m.error || 'failed').slice(0, 220)),
    `<div class="row2"><button class="btn ghost small" data-retry="${esc(r.name)}">Retry</button></div>`));
  for (const r of done) out.push(row('ok', title(r), `ready${r.m.verdict ? ' · ' + esc(r.m.verdict.slice(0, 80)) : ''} — open Studio`));
  $('liveList').innerHTML = out.join('');
  $('liveList').classList.toggle('hide', !liveOpen);
}
$('artPrompt').addEventListener('click', e => {
  if (e.target.closest('button')) { try { localStorage.setItem('rm.artPromptOff', new Date().toDateString()) } catch {} $('artPrompt').classList.add('hide'); return }
  showTab('saved'); window.scrollTo({ top: 0 });
});
$('liveSum').onclick = () => { liveOpen = !liveOpen; $('liveList').classList.toggle('hide', !liveOpen); const c = $('liveSum').querySelector('.chev'); if (c) c.textContent = liveOpen ? '▲' : '▼' };
$('liveList').addEventListener('click', async e => {
  const ans = e.target.closest('[data-ans]'), rt = e.target.closest('[data-retry]');
  if (ans) {
    const id = ans.dataset.ans, v = $('liveList').querySelector(`[data-ans-in="${CSS.escape(id)}"]`).value.trim(); if (!v) return;
    ans.disabled = true;
    try { await commitFiles([buildFile(id, 'resume', v)], `rm-inbox: answer for ${id}`); ans.textContent = 'Sent'; pollLive(2500) }
    catch (err) { ans.disabled = false; ans.textContent = 'Retry' }
  }
  if (rt) {
    const m = (liveReq[rt.dataset.retry] || {}).m; if (!m) return;
    rt.disabled = true;
    try { await commitFiles([buildFile(m.slug, m.kind, m.note || '', m.item ? { item: m.item } : {})], `rm-inbox: retry ${m.slug}`); rt.textContent = 'Queued'; pollLive(2500) }
    catch (err) { rt.disabled = false; rt.textContent = 'Retry failed — tap again' }
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollLive(300) });

// ---------- Edit sheet: change a carousel slide inside the app (editor 2026-11-26: "can this be prompted inside the app rather
// than leaving the app to Claude … same goes for colour and all other changes") ----------
// Words are the slide's own text fields from carousel.json (applied verbatim); an area is a box drawn on the slide (0–1 coords)
// + an action; colour is a mood for the colorist or an exact colour the editor picks (recorded as the editor's palette, so the
// colour gate holds). Everything goes in ONE revise request: studio/schedule/build/<stem>.json "edits" + the marked-up slide
// PNGs next to it. The caption is saved straight away (no rebuild).
const TEXT_KEYS = ['kicker', 'title', 'headline', 'subtitle', 'body', 'line', 'cta', 'label', 'caption_line', 'note'];
const LIST_KEYS = ['copy', 'lines', 'points', 'bullets'];
const AREA_ACTS = [['move', 'Move it'], ['bigger', 'Bigger'], ['smaller', 'Smaller'], ['crop', 'Crop to this'], ['remove', 'Remove'], ['replace', 'Replace picture'], ['fix', 'Fix this']];
const MOODS = ['Warmer', 'Cooler', 'Darker', 'Lighter', 'More contrast', 'Softer', 'Different accent'];
let ed = null;   // {ci, c, spec, specPath, i, slides: {n: {text: {}, areas: [], mood: Set, hex, pic}}, box}
function slideText(sl) {
  const out = [];
  for (const k of TEXT_KEYS) if (typeof sl[k] === 'string' && sl[k].trim()) out.push({ field: k, old: sl[k] });
  for (const k of LIST_KEYS) if (Array.isArray(sl[k])) sl[k].forEach((v, j) => { if (typeof v === 'string' && v.trim()) out.push({ field: `${k}[${j}]`, old: v }) });
  return out;
}
const edSlide = n => (ed.slides[n] = ed.slides[n] || { text: {}, areas: [], mood: new Set(), hex: '', pic: null, note: '' });
const edCount = () => Object.values(ed.slides).reduce((t, s) => t + Object.keys(s.text).length + s.areas.length + s.mood.size + (s.hex ? 1 : 0) + (s.pic ? 1 : 0) + (s.note ? 1 : 0), 0) + (ed.note ? 1 : 0);
async function openEditor(ci) {
  const c = cars[ci];
  ed = { ci, c, spec: null, specPath: '', i: 0, slides: {}, box: null, note: '' };
  $('edSheet').classList.remove('hide'); document.body.style.overflow = 'hidden';
  $('edTitle').textContent = c.title || c.slug; clearMsg('edMsg');
  for (const p of [`studio/carousels/${c.slug}/carousel.json`, `studio/posters/${c.slug}/poster.json`]) {
    const j = await jsonAt(p); if (j) { ed.spec = j; ed.specPath = p; break }
  }
  $('edCap').value = c.caption || (ed.spec && ed.spec.caption) || '';
  edDraw();
}
function closeEditor() { $('edSheet').classList.add('hide'); document.body.style.overflow = ''; ed = null }
function edDraw() {
  const c = ed.c, n = ed.i, s = edSlide(n), sl = (ed.spec && (ed.spec.slides || [ed.spec])[n]) || {};
  $('edStrip').innerHTML = c.slides.map((x, i) => `<button type="button" class="edth${i === n ? ' on' : ''}${ed.slides[i] && edCountOf(i) ? ' has' : ''}" data-edi="${i}" style="background-image:url(${carImgs[c.slug + '/' + i] || ''})">${i + 1}</button>`).join('');
  $('edImg').src = carImgs[c.slug + '/' + n] || '';
  if (!carImgs[c.slug + '/' + n]) { const x = c.slides[n]; rawFile(x.type === 'video' ? x.poster : x.src, 'image/jpeg').then(b => { carImgs[c.slug + '/' + n] = URL.createObjectURL(b); if (ed && ed.i === n) $('edImg').src = carImgs[c.slug + '/' + n] }).catch(() => {}) }
  edBoxes();
  const words = slideText(sl);
  $('edWords').innerHTML = words.map(w => `<label>${esc(w.field.replace(/\[(\d+)\]/, (_, k) => ' ' + (+k + 1)))}</label><textarea class="edw" data-field="${esc(w.field)}" rows="2">${esc(s.text[w.field] ? s.text[w.field].new : w.old)}</textarea>`).join('')
    || '<p class="hint" style="margin:0">This slide’s words are part of its picture — mark the text on the slide and choose “Fix this”, then say the new words below.</p>';
  $('edWords').querySelectorAll('.edw').forEach(t => t.oninput = () => {
    const w = words.find(x => x.field === t.dataset.field), v = t.value;
    if (v.trim() === w.old.trim()) delete s.text[w.field]; else s.text[w.field] = { field: w.field, old: w.old, new: v };
    edSummary();
  });
  $('edMoods').innerHTML = MOODS.map(m => `<button type="button" class="tag${s.mood.has(m) ? ' on' : ''}" data-mood="${esc(m)}">${esc(m)}</button>`).join('');
  $('edMoods').querySelectorAll('[data-mood]').forEach(b => b.onclick = () => { const m = b.dataset.mood; s.mood.has(m) ? s.mood.delete(m) : s.mood.add(m); edDraw() });
  $('edHexOn').checked = !!s.hex; $('edHex').value = s.hex || '#888888'; $('edHex').disabled = !s.hex;
  $('edSlideNote').value = s.note || '';
  $('edPicName').textContent = s.pic ? s.pic.file.name : '';
  edSummary();
}
const edCountOf = i => { const s = ed.slides[i]; return s ? Object.keys(s.text).length + s.areas.length + s.mood.size + (s.hex ? 1 : 0) + (s.pic ? 1 : 0) + (s.note ? 1 : 0) : 0 };
function edBoxes() {
  const s = edSlide(ed.i);
  $('edMarks').innerHTML = s.areas.map((a, k) => `<div class="edbox" style="left:${a.box[0] * 100}%;top:${a.box[1] * 100}%;width:${a.box[2] * 100}%;height:${a.box[3] * 100}%"><span>${k + 1}</span></div>`).join('')
    + (ed.box ? `<div class="edbox new" style="left:${ed.box[0] * 100}%;top:${ed.box[1] * 100}%;width:${ed.box[2] * 100}%;height:${ed.box[3] * 100}%"></div>` : '');
  $('edActs').classList.toggle('hide', !ed.box);
  $('edAreas').innerHTML = s.areas.map((a, k) => `<div class="edarea"><b>${k + 1}</b> ${esc(AREA_ACTS.find(x => x[0] === a.action)[1])}${a.note ? ' — ' + esc(a.note) : ''}<button type="button" data-adel="${k}">×</button></div>`).join('');
  $('edAreas').querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { s.areas.splice(+b.dataset.adel, 1); edBoxes(); edSummary() });
}
function edSummary() {
  const n = edCount();
  $('edSend').disabled = !n; $('edSend').textContent = n ? `Send ${n} change${n > 1 ? 's' : ''} & rebuild` : 'Send changes & rebuild';
  document.querySelectorAll('#edStrip .edth').forEach(b => b.classList.toggle('has', !!edCountOf(+b.dataset.edi)));
}
// draw a box on the slide (touch or mouse)
(() => {
  const wrap = () => $('edStage');
  let start = null;
  const pt = e => { const r = wrap().getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return [Math.min(1, Math.max(0, (t.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (t.clientY - r.top) / r.height))] };
  const down = e => { if (!ed) return; e.preventDefault(); start = pt(e); ed.box = [start[0], start[1], 0, 0]; edBoxes() };
  const move = e => { if (!start || !ed) return; e.preventDefault(); const p = pt(e); ed.box = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])]; edBoxes() };
  const up = () => { if (!start || !ed) return; start = null; if (ed.box && (ed.box[2] < .03 || ed.box[3] < .03)) { ed.box = [Math.max(0, ed.box[0] - .08), Math.max(0, ed.box[1] - .06), .16, .12] } edBoxes(); $('edActNote').focus() };
  document.addEventListener('DOMContentLoaded', () => {});
  const st = document.getElementById('edStage');
  st.addEventListener('touchstart', down, { passive: false }); st.addEventListener('touchmove', move, { passive: false }); st.addEventListener('touchend', up);
  st.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
})();
$('edActBtns').innerHTML = AREA_ACTS.map(([k, l]) => `<button type="button" class="tag" data-act="${k}">${l}</button>`).join('');
$('edActBtns').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || !ed || !ed.box) return;
  const s = edSlide(ed.i);
  s.areas.push({ box: ed.box.map(v => +v.toFixed(3)), action: b.dataset.act, note: $('edActNote').value.trim() });
  if (b.dataset.act === 'replace') $('edPic').click();
  ed.box = null; $('edActNote').value = ''; edBoxes(); edSummary();
});
$('edStrip').addEventListener('click', e => { const b = e.target.closest('[data-edi]'); if (b && ed) { ed.i = +b.dataset.edi; ed.box = null; edDraw() } });
$('edHexOn').onchange = () => { const s = edSlide(ed.i); s.hex = $('edHexOn').checked ? $('edHex').value : ''; $('edHex').disabled = !s.hex; edSummary() };
$('edHex').oninput = () => { const s = edSlide(ed.i); if ($('edHexOn').checked) s.hex = $('edHex').value; edSummary() };
$('edSlideNote').oninput = () => { edSlide(ed.i).note = $('edSlideNote').value.trim(); edSummary() };
$('edNote').oninput = () => { ed.note = $('edNote').value.trim(); edSummary() };
$('edPicBtn').onclick = () => $('edPic').click();
$('edPic').onchange = () => { const f = $('edPic').files[0]; if (f && ed) { edSlide(ed.i).pic = { file: f }; $('edPicName').textContent = f.name; edSummary() } $('edPic').value = '' };
$('edClose').onclick = () => { if (ed && edCount() && !armTap($('edClose'), 'Discard?')) return; closeEditor() };
$('edCapSave').onclick = async () => {
  if (!ed) return;
  const cap = $('edCap').value, btn = $('edCapSave'), c = ed.c; btn.disabled = true;
  try {
    const { repo } = cfg();
    await commitFiles([], `rm-inbox: caption for ${c.slug}`, null, async head => {
      const out = [];
      const ix = JSON.parse(utf8b64((await api(`/repos/${repo}/contents/studio/previews/index.json?ref=${head}`)).content));
      (ix.carousels || []).forEach(x => { if (x.slug === c.slug) x.caption = cap });
      out.push({ path: 'studio/previews/index.json', b64: b64utf8(JSON.stringify(ix, null, 1) + '\n') });
      if (ed.specPath) {
        const sp = JSON.parse(utf8b64((await api(`/repos/${repo}/contents/${ed.specPath}?ref=${head}`)).content));
        sp.caption = cap; (sp.editorOverrides = sp.editorOverrides || {}).caption = 'edited by the editor in RM Inbox';
        out.push({ path: ed.specPath, b64: b64utf8(JSON.stringify(sp, null, 2) + '\n') });
      }
      return out;
    });
    c.caption = cap; msg('edMsg', 'ok', 'Caption saved.');
  } catch (e) { msg('edMsg', 'err', esc(e.message)) }
  btn.disabled = false;
};
// a copy of the slide with the marked boxes drawn on it, so the studio sees exactly what was pointed at
async function markedPng(n, areas) {
  const src = carImgs[ed.c.slug + '/' + n]; if (!src || !areas.length) return null;
  const img = new Image(); img.src = src; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  g.lineWidth = Math.max(4, cv.width / 160); g.font = `700 ${Math.round(cv.width / 18)}px sans-serif`;
  areas.forEach((a, k) => { const [x, y, w, h] = [a.box[0] * cv.width, a.box[1] * cv.height, a.box[2] * cv.width, a.box[3] * cv.height];
    g.strokeStyle = '#ff3b30'; g.strokeRect(x, y, w, h); g.fillStyle = '#ff3b30'; g.fillText(String(k + 1), x + 8, y + cv.width / 16) });
  return (await new Promise(r => cv.toBlob(r, 'image/png')));
}
$('edSend').onclick = async () => {
  if (!ed || !edCount()) return;
  const btn = $('edSend'), c = ed.c; btn.disabled = true; msg('edMsg', 'info', 'Sending…');
  try {
    const f = buildFile(c.slug, 'revise', ed.note || 'Edits from the RM Inbox edit sheet — see "edits".'), stem = f.path.replace(/\.json$/, '');
    const files = [], edits = { slides: [], note: ed.note };
    for (const [n, s] of Object.entries(ed.slides)) {
      if (!edCountOf(+n)) continue;
      const e = { slide: +n + 1, text: Object.values(s.text), areas: s.areas, colour: { moods: [...s.mood], hex: s.hex || null }, note: s.note };
      const png = await markedPng(+n, s.areas);
      if (png) { e.marked = `${stem}-slide${+n + 1}.png`; files.push({ path: e.marked, b64: await readB64(png) }) }
      if (s.pic) { const ext = (s.pic.file.name.split('.').pop() || 'jpg').toLowerCase(); e.picture = `${stem}-slide${+n + 1}-picture.${ext}`; files.push({ path: e.picture, b64: await readB64(s.pic.file) }) }
      edits.slides.push(e);
    }
    const req = JSON.parse(decodeURIComponent(escape(atob(f.b64)))); req.edits = edits;
    files.push({ path: f.path, b64: b64utf8(JSON.stringify(req, null, 2) + '\n') });
    await commitFiles(files, `rm-inbox: edit ${c.slug} (${edCount()} change${edCount() > 1 ? 's' : ''})`);
    closeEditor(); msg('carMsg' + cars.indexOf(c), 'ok', 'Sent — the studio makes these changes and re-renders (follow it in the bar at the top).'); pollLive(2500);
  } catch (e) { msg('edMsg', 'err', esc(e.message)); btn.disabled = false }
};

// ---------- Rulebook: two divisions, Carousels and Reels, each expands on tap; no search (editor 2026-11-27) · studio/WHITEPAPER.md (generated by Finance_Repo engine/whitepaper.py, hourly) — editor 2026-11-27 ----------
let rulesMd = '';
function mdInline(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<i>$2</i>');
}
function mdRender(md, q) {
  const lines = md.split('\n'), out = []; let i = 0, inList = false, openSec = false;
  const hl = h => q ? h.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>') : h;
  const close = () => { if (inList) { out.push('</ul>'); inList = false } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      close(); const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++ }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s|:-]+\|$/.test(r));
      const keep = q ? body.filter((r, k) => k === 0 || r.toLowerCase().includes(q.toLowerCase())) : body;
      if (keep.length > 1) out.push('<div class="tw"><table>' + keep.map((r, k) => '<tr>' + cells(r).map(c => k ? `<td>${hl(mdInline(c))}</td>` : `<th>${mdInline(c)}</th>`).join('') + '</tr>').join('') + '</table></div>');
      continue;
    }
    if (/^# /.test(l)) { close(); out.push(`<h1>${mdInline(l.slice(2))}</h1>`) }
    else if (/^## /.test(l)) { close(); if (openSec) out.push('</details>'); out.push(`<details${q ? ' open' : ''}><summary>${mdInline(l.slice(3))}</summary>`); openSec = true }
    else if (/^#### /.test(l)) { close(); out.push(`<h4>${mdInline(l.slice(5))}</h4>`) }
    else if (/^### /.test(l)) { close(); out.push(`<h3>${mdInline(l.slice(4))}</h3>`) }
    else if (/^- /.test(l)) { if (!q || l.toLowerCase().includes(q.toLowerCase())) { if (!inList) { out.push('<ul>'); inList = true } out.push(`<li>${hl(mdInline(l.slice(2)))}</li>`) } }
    else if (l.trim()) { close(); if (!q) out.push(`<p>${mdInline(l)}</p>`) }
    i++;
  }
  close(); if (openSec) out.push('</details>');
  return out.join('');
}
async function loadRules(force) {
  if (rulesMd && !force) return drawRules();
  try { rulesMd = await fileText('studio/WHITEPAPER.md'); clearMsg('rulesMsg'); drawRules() }
  catch (e) { msg('rulesMsg', 'err', e.status === 404 ? 'The rulebook is generated on the next hourly run of the studio.' : esc(e.message)) }
}
function drawRules() {
  const m = rulesMd.match(/_Generated from the repo by engine\/whitepaper\.py · ([^·]+) ·/);
  $('rulesStamp').textContent = m ? `From the repo · ${m[1].trim()}` : 'From the repo';
  $('rulesBody').innerHTML = mdRender(rulesMd.replace(/^# .*\n|^_Generated.*_\n/gm, ''), '') || '<div class="empty">Nothing matches.</div>';
}

// ---------- setup ----------
function boot() {
  const c = cfg();
  $('repo').value = c.repo; $('branch').value = c.branch;
  const on = !!c.tok;
  $('setup').classList.toggle('hide', on); $('app').classList.toggle('hide', !on);
  $('repoLbl').textContent = on ? `${c.repo} · ${c.branch} · app ${APP_VERSION}` : '';
  $('who').textContent = '';
  if (on) { pollLive(800); showTab(store.get(K.tab) || 'today'); api('/user').then(u => $('who').textContent = '@' + u.login).catch(() => {}) }
}
$('connect').onclick = async () => {
  const tok = $('tok').value.trim(), repo = $('repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''), branch = $('branch').value.trim() || 'main';
  if (!/^(github_pat_|ghp_)/.test(tok)) return msg('setupMsg', 'err', 'That doesn’t look like a GitHub token (it should start with <code>github_pat_</code>).');
  store.set(K.tok, tok); store.set(K.repo, repo); store.set(K.branch, branch);
  msg('setupMsg', 'info', 'Checking…');
  try {
    const r = await api(`/repos/${repo}`);
    if (!r.permissions || !r.permissions.push) throw new GhError(403);
    await api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    $('tok').value = ''; clearMsg('setupMsg'); boot(); applyShared();
  } catch (e) { store.del(K.tok); msg('setupMsg', 'err', esc(e.message)) }
};
$('forget').onclick = () => { if (armTap($('forget'), 'Tap again to forget')) { store.del(K.tok); boot() } };

// ---------- tabs ----------
// five tabs (editor 2026-11-26): Pre & Post · Newsroom · Saved Artwork · Studio · More (ids stay today/add/saved so saved tabs survive)
let statusTimer = null;
const TITLE = { today: 'Pre & Post Market', add: 'Newsroom', saved: 'Artwork', studio: 'Studio', learn: 'References', more: 'More' };
const OLDTAB = { refs: 'learn', news: 'add', plan: 'today', library: 'more', status: 'more' };
const SUBS = { add: ['news', 'schedule'], more: ['library', 'mine', 'status', 'rules'] };
const subOf = g => { const v = store.get('rm.sub.' + g); return SUBS[g].includes(v) ? v : SUBS[g][0] };
// ---------- Claude usage left (editor 2026-11-27: "I want to know usage left only … and when it refreshes back") ----------
// Finance_Repo's usage Action (every 3 h, after every build, and on Refresh) writes usage.json on the `usage` branch:
// per account the 5-hour window and the weekly limit as % left + reset time. Plans have no token count, only these.
const ACCT = { A: 'Account A', B: 'Account B', main: 'Main token' };
const ist = iso => { const d = new Date(iso), t = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const day = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }), today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  return day === today ? t : `${day}, ${t}` };
const inT = iso => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); return m <= 0 ? 'now' : m < 60 ? `in ${m} min` : m < 2880 ? `in ${Math.floor(m / 60)} h ${m % 60} min` : `in ${Math.round(m / 1440)} days` };
let usageAt = 0, lastUsage = null;
async function loadUsage(force) {
  if (!cfg().tok || (!force && Date.now() - usageAt < 60000)) return; usageAt = Date.now();
  let u;
  try { u = JSON.parse(utf8b64((await api(`/repos/${cfg().repo}/contents/usage.json?ref=usage`)).content)) }
  catch (e) { $('usageList').innerHTML = `<div class="empty">${e.status === 404 ? 'No reading yet — tap Refresh (takes about a minute).' : esc(e.message || 'Could not read usage.')}</div>`; return }
  lastUsage = u.updated;
  $('usageHint').textContent = `checked ${ist(u.updated)} IST · ${dur(mins(u.updated))} ago`;
  const bar = (name, w) => { if (!w || w.left == null) return '';
    const c = w.left <= 15 ? 'low' : w.left <= 40 ? 'mid' : '';
    return `<div class="ub"><span>${name}</span><span class="bar"><i class="${c}" style="width:${w.left}%"></i></span><b>${w.left}% left</b>${w.resets_at ? `<span></span><span class="r">refills ${inT(w.resets_at)} · ${ist(w.resets_at)}</span>` : ''}</div>` };
  $('usageList').innerHTML = (u.accounts || []).map(a => `<div class="ua"><div class="h"><span>${esc(ACCT[a.label] || a.label)}</span>${a.ok ? '' : '<span style="color:var(--loss)">couldn\'t read</span>'}</div>${a.ok
    ? bar('5-hour', a.session) + bar('Weekly', a.weekly)
    : `<div class="ub"><span></span><span class="r" style="grid-column:1/4">${a.limited_until ? `At its limit — free again ${inT(a.limited_until)} · ${ist(a.limited_until)}` : 'Check the token in GitHub Secrets.'}</span></div>`}</div>`).join('') || '<div class="empty">No Claude token secrets found.</div>';
}
$('usageGo').onclick = async () => {
  const b = $('usageGo'); b.disabled = true; $('usageMsg').textContent = 'Checking… (about a minute)';
  try {
    await api(`/repos/${cfg().repo}/dispatches`, { method: 'POST', body: JSON.stringify({ event_type: 'usage-refresh' }) });
    const t0 = Date.now(), tick = async () => {               // the check takes ~30–60 s; poll until a newer reading lands
      await loadUsage(true);
      if (Date.parse(lastUsage || 0) > t0 - 5000 || Date.now() - t0 > 180000) { $('usageMsg').textContent = Date.now() - t0 > 180000 ? 'Still waiting — it will show here when the check finishes.' : ''; b.disabled = false; return }
      setTimeout(tick, 15000);
    };
    setTimeout(tick, 30000);
  } catch (e) { b.disabled = false; $('usageMsg').textContent = e.status === 403 || e.status === 404 ? 'Your GitHub token needs "Contents: Read and write" on Finance_Repo to refresh — it also updates by itself every 3 hours.' : (e.message || 'Could not start the check.') }
};
function showTab(t) {
  t = OLDTAB[t] || t; if (!TITLE[t]) t = 'today';
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hide', p.dataset.pane !== t));
  store.set(K.tab, t);
  $('pageTitle').textContent = TITLE[t]; $('pageTitle').classList.remove('hide');
  clearInterval(statusTimer);
  if (t === 'today') { loadPlan(); loadUsage() }
  if (t === 'saved') loadBookmarks();
  if (t === 'studio') loadReels();
  if (SUBS[t]) showSub(t, subOf(t));
}
function showSub(g, s) {
  store.set('rm.sub.' + g, s);
  const pane = document.querySelector(`[data-pane="${g}"]`);
  pane.querySelectorAll('[data-sub]').forEach(d => d.classList.toggle('hide', d.dataset.sub !== s));
  pane.querySelectorAll(`[data-seg="${g}"] button`).forEach(b => b.classList.toggle('on', b.dataset.s === s));
  clearInterval(statusTimer);
  if (['schedule', 'news'].includes(s)) loadPlan();
  if (s === 'library') loadLibrary();
  if (s === 'mine') loadMyRefs();
  if (s === 'rules') loadRules();
  if (s === 'status') { loadStatus(); statusTimer = setInterval(loadStatus, 15000) }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { showTab(b.dataset.tab); window.scrollTo({ top: 0 }) });
document.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => showSub(b.parentElement.dataset.seg, b.dataset.s));

// swipe left / right anywhere on a tab to move to the next / previous tab (phone). The page follows the finger once the
// drag is clearly sideways, so it's easy to start anywhere on the body — over cards, text fields (unless you're typing
// in one) and thumbnails. Ignored only inside the carousel strips (they scroll sideways), videos (scrubbing) and selects.
const TABS = [...document.querySelectorAll('.tabs button')].map(b => b.dataset.tab);
let sw = null;
const curPane = () => document.querySelector(`[data-pane="${store.get(K.tab) || 'today'}"]`);
document.addEventListener('touchstart', e => {
  const t = e.target;
  if (e.touches.length !== 1 || !cfg().tok || t.closest('select,video,.strip,.sheet,.lightbox,[data-noswipe]') ||
    (t.closest('input,textarea') && t.closest('input,textarea') === document.activeElement)) { sw = null; return }
  sw = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now(), axis: '', dx: 0, pane: curPane() };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!sw) return;
  if (e.touches.length !== 1) { springBack(); sw = null; return }
  const dx = e.touches[0].clientX - sw.x, dy = e.touches[0].clientY - sw.y;
  if (!sw.axis) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    sw.axis = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
    if (sw.axis === 'y') { sw = null; return }
  }
  if (e.cancelable) e.preventDefault();                       // sideways drag is ours: no page drift
  const i = TABS.indexOf(store.get(K.tab) || 'today'), edge = (dx > 0 && i === 0) || (dx < 0 && i === TABS.length - 1);
  sw.dx = dx;
  if (sw.pane) { sw.pane.style.transition = ''; sw.pane.style.transform = `translateX(${dx * (edge ? 0.15 : 0.45)}px)`; sw.pane.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / 900)) }
}, { passive: false });
function springBack() {
  const p = sw && sw.pane; if (!p) return;
  p.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s'; p.style.transform = ''; p.style.opacity = '';
  setTimeout(() => p.style.transition = '', 220);
}
document.addEventListener('touchcancel', () => { springBack(); sw = null }, { passive: true });
document.addEventListener('touchend', e => {
  if (!sw) return;
  const s = sw; sw = null;
  if (s.axis !== 'x') return;
  const dx = e.changedTouches[0].clientX - s.x, dt = Math.max(1, Date.now() - s.at), fast = Math.abs(dx) / dt > 0.35;
  const i = TABS.indexOf(store.get(K.tab) || 'today'), j = i + (dx < 0 ? 1 : -1);
  if ((Math.abs(dx) < 45 && !(fast && Math.abs(dx) > 20)) || j < 0 || j >= TABS.length) { sw = s; springBack(); sw = null; return }
  if (s.pane) { s.pane.style.transform = ''; s.pane.style.opacity = '' }
  showTab(TABS[j]); window.scrollTo({ top: 0 });
  const pane = document.querySelector(`[data-pane="${TABS[j]}"]`);
  if (pane) { pane.style.transition = ''; pane.style.transform = `translateX(${dx < 0 ? 40 : -40}px)`; pane.style.opacity = '.5'; requestAnimationFrame(() => requestAnimationFrame(() => { pane.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1), opacity .22s'; pane.style.transform = ''; pane.style.opacity = ''; setTimeout(() => pane.style.transition = '', 260) })) }
}, { passive: true });
// feels like an app: no pinch zoom (iOS ignores user-scalable=no in Safari); double-tap zoom is off via touch-action in the CSS
['gesturestart', 'gesturechange'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && e.cancelable) e.preventDefault() }, { passive: false });

// "Your references" on the References tab: everything you sent — waiting, downloaded, studied — newest first; tap = the post
const myRefAdded = {};
async function loadMyRefs() {
  const box = $('myRefs'); if (!box || !cfg().tok) return;
  try {
    const { repo, branch } = cfg();
    const [j, tree, audit] = await Promise.all([fileText('references/index.json').then(JSON.parse).catch(() => ({ cards: [] })),
      api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`), fileText('references/audit.txt').catch(() => '')]);
    // library health (engine/reference_audit.py): learned by its agents, or exactly what's missing
    const health = {}; audit.split('\n').forEach(l => { const m = l.match(/^([✓✗]) (\S+)\s+\S+\s+(.*)$/); if (m) health[m[2]] = [m[1] === '✓', m[3]] });
    const head = audit.split('\n')[0] || '';
    const paths = tree.tree.filter(t => t.type === 'blob').map(t => t.path);
    const queued = paths.filter(p => /^references\/queue\/[^/]+\.json$/.test(p));
    const qs = await Promise.all(queued.map(async p => { try { return { p, m: JSON.parse(await fileText(p)), err: paths.includes(p.replace(/\.json$/, '.error.txt')) } } catch { return null } }));
    const rows = [];
    for (const q of qs.filter(Boolean)) rows.push({ when: q.m.added || '', href: q.m.url || '', title: q.m.url || (q.m.names || [q.m.name])[0] || 'upload', state: q.err ? ['err', 'Failed — see Status'] : ['wait', 'Waiting for the download'], learn: q.m.learn_for });
    const cards = (j.cards || []).filter(c => c.id !== 'golden-reel-v3');
    const added = Object.fromEntries(await Promise.all(cards.map(async c => {          // the sent date lives in references/inbox/<id>.json
      if (c.added) return [c.id, c.added];
      if (!myRefAdded[c.id]) myRefAdded[c.id] = fileText(`references/inbox/${c.id}.json`).then(t => JSON.parse(t).added || '').catch(() => '');
      return [c.id, await myRefAdded[c.id]];
    })));
    for (const c of cards) { const h = health[c.id];
      rows.push({ when: added[c.id] || '', id: c.id, href: /^https?:/.test(c.src || '') ? c.src : '', title: c.note || c.id,
        state: h ? (h[0] ? ['ok', 'Learned · ' + h[1].replace(/^learned · /, '')] : ['wait', 'Not learned yet: ' + h[1] + ' (next /study fixes it)']) : (c.studied ? ['ok', 'Studied'] : ['wait', 'Downloaded · waiting for /study']),
        learn: c.learn_for, kind: c.kind }) }
    rows.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    $('myRefsCount').textContent = rows.length;
    if (head) msg('myRefsMsg', /^PASS/.test(head) ? 'ok' : 'err', /^PASS/.test(head) ? `Library: every reference learned (${esc(head.split('·')[2] || '').trim()})` : `Library: ${esc(head.replace(/^FAIL · reference audit · /, ''))} — run /study in Claude Code to finish learning them.`);
    box.innerHTML = rows.map(r => `<div class="item myref"${r.href ? ` data-href="${esc(r.href)}"` : ''}><span class="dot ${r.state[0]}"></span><div style="min-width:0;flex:1">
        <div class="t" style="font-size:14px">${esc(r.id || r.title)}${r.kind && r.kind !== 'reel' ? ` <span class="tag">${esc(r.kind)}</span>` : ''}${r.learn && r.learn !== 'auto' ? ` <span class="tag" style="background:var(--blue);color:#fff;box-shadow:none">${esc(LEARN_NAME[r.learn] || r.learn)}</span>` : ''}</div>
        <div class="s">${esc(r.state[1])}${r.id && r.title !== r.id ? ' · “' + esc(r.title.slice(0, 60)) + '”' : ''}</div>
        ${r.id ? `<div class="reroute" style="margin-top:6px"><span class="s">Who learns:</span> ${learnSelect(r.learn, `data-rid="${esc(r.id)}" style="width:auto;max-width:100%;padding:4px 8px;font-size:13px;margin-top:4px"`)}</div>` : ''}</div>${r.href ? '<span class="go2">Open ↗</span>' : ''}</div>`).join('') || '<div class="empty">Nothing sent yet.</div>';
    box.querySelectorAll('.myref[data-href]').forEach(el => el.onclick = e => { if (e.target.closest('.reroute')) return; window.open(el.dataset.href, '_blank', 'noopener') });
    box.querySelectorAll('select[data-rid]').forEach(sel => { sel.onclick = e => e.stopPropagation(); sel.onchange = () => reroute(sel.dataset.rid, sel.value, sel) });
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>` }
}

// change who learns from a reference already in the library → a route item in the queue; the inbox Action applies it
// and /study runs that agent's learn pass on it
async function reroute(id, learn, sel) {
  sel.disabled = true;
  try {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    await commitFiles([{ path: `references/queue/route-${ts}-${id}.json`, b64: b64utf8(JSON.stringify({ route: id, learn_for: learn, added: new Date().toISOString() }, null, 2) + '\n') }],
      `rm-inbox: ${id} → learns: ${learn}`);
    msg('myRefsMsg', 'ok', `${esc(id)} → <b>${esc(LEARN_NAME[learn] || learn)}</b>. Saved; the studio picks it up at the next /study.`);
  } catch (e) { msg('myRefsMsg', 'err', 'Could not save: ' + esc(e.message)) } finally { sel.disabled = false }
}

// ---------- tab 1: references ----------
const SRC = [[/(^|\.)(x|twitter)\.com$/, 'x'], [/(^|\.)instagram\.com$/, 'ig'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'yt']];
const srcOf = u => { try { const h = new URL(u).hostname; return (SRC.find(([re]) => re.test(h)) || [0, 'web'])[1] } catch { return null } };
// who learns from a reference (the studio routes on it at /study); last option = let the studio decide
const LEARN = [['hook', 'Visual hook — opening seconds'], ['second', 'Second frames — what follows the hook'], ['motion', 'Motion design — kinetic type, 3D, effects'],
  ['pacing', 'Pacing — rhythm & timing (pacer)'], ['transitions', 'Transitions & easing (transitioner)'],
  ['color', 'Colour & grading (colorist)'], ['script', 'Script & story (storyteller)'], ['carousel', 'Carousel format'], ['auto', 'Let the studio decide (general)']];
const learnSelect = (val, attrs = '') => `<select class="learn" ${attrs}>${LEARN.map(([v, l]) => `<option value="${v}"${v === (val || 'auto') ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const LEARN_NAME = Object.fromEntries(LEARN.map(([v, l]) => [v, l.split(' —')[0].split(' (')[0]]));
let links = []; // [{url, note, learn}]
function parseLinks() {
  const urls = [...new Set(($('links').value.match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[),.]+$/, '')))];
  const old = Object.fromEntries(links.map(l => [l.url, l]));
  links = urls.filter(srcOf).map(url => ({ url, note: (old[url] || {}).note || '', learn: (old[url] || {}).learn || 'auto' }));
  $('linkCards').innerHTML = links.map((l, i) => `<div class="link"><div class="u"><span class="src">${srcOf(l.url)}</span>${esc(l.url)}</div>
    <input data-i="${i}" placeholder="what I like: …" value="${esc(l.note)}">
    <label style="margin:10px 0 4px">Who learns from this?</label>${learnSelect(l.learn, `data-li="${i}"`)}</div>`).join('');
  $('linkCards').querySelectorAll('input').forEach(inp => inp.oninput = () => links[inp.dataset.i].note = inp.value);
  $('linkCards').querySelectorAll('select[data-li]').forEach(sel => sel.onchange = () => links[sel.dataset.li].learn = sel.value);
  $('sendLinks').disabled = !links.length;
  $('sendLinks').textContent = links.length > 1 ? `Send ${links.length} links to studio` : 'Send to studio';
}
$('links').oninput = parseLinks;
$('sendLinks').onclick = async () => {
  const btn = $('sendLinks'); btn.disabled = true; clearMsg('linksMsg');
  const ts = stamp(), tags = tagList($('tags').value), added = new Date().toISOString();
  const files = links.map((l, i) => ({ path: `references/queue/${ts}${links.length > 1 ? '-' + (i + 1) : ''}.json`,
    b64: b64utf8(JSON.stringify({ url: l.url, note: l.note.trim(), tags, learn_for: l.learn || 'auto', added }, null, 2) + '\n') }));
  try {
    await commitFiles(files, `inbox: ${files.length} reference link${files.length > 1 ? 's' : ''}`, p => bar('linksBar', p));
    clearMsg('shareMsg'); msg('linksMsg', 'ok', `Sent ${files.length} link${files.length > 1 ? 's' : ''}. The download usually takes 1–3 minutes — watch the Status tab.`);
    $('links').value = ''; $('tags').value = ''; parseLinks();
  } catch (e) { msg('linksMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('linksBar', null);
};
// one upload card for a reel, an image or a carousel (pictures + videos in swipe order)
const MAX_FILES = 20, MAX_TOTAL = 150 * 1024 * 1024;
const readB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1)); r.onerror = () => rej(new Error('Could not read the file on this device.')); r.readAsDataURL(f) });
let ups = []; // [{kind:'image'|'video', blob, name, url, ext}]
const upKind = () => !ups.length ? '' : ups.length === 1 ? (ups[0].kind === 'video' ? 'reel' : 'image') : 'carousel';
const isVideo = f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name || '');
const isImage = f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name || '');
async function addUploads(list) {
  clearMsg('vidMsg');
  for (const f of [...list]) {
    if (ups.length >= MAX_FILES) { msg('vidMsg', 'err', `The limit is ${MAX_FILES} files per reference.`); break }
    if (isVideo(f) || f.type === 'image/gif') {
      if (f.size > MAX_VIDEO) { msg('vidMsg', 'err', `${esc(f.name)} is ${(f.size / 1048576).toFixed(0)} MB. The limit is 90 MB per video — trim it or export at 1080p.`); continue }
      const ext = f.type === 'image/gif' ? 'gif' : ((f.name || '').match(/\.(mp4|mov|m4v|webm)$/i) || [, 'mp4'])[1].toLowerCase();
      ups.push({ kind: 'video', blob: f, name: f.name || `video.${ext}`, url: URL.createObjectURL(f), ext });
    } else if (isImage(f)) {
      try { const blob = await compress(f); ups.push({ kind: 'image', blob, name: f.name || 'image.jpg', url: URL.createObjectURL(blob), ext: 'jpg' }) }
      catch { msg('vidMsg', 'err', `Couldn’t read ${esc(f.name || 'an image')} — try a PNG or JPEG.`) }
    } else msg('vidMsg', 'err', `${esc(f.name || 'That file')} isn’t a video or picture.`);
  }
  drawUploads();
}
function drawUploads() {
  const total = ups.reduce((n, u) => n + u.blob.size, 0), k = upKind();
  const nv = ups.filter(u => u.kind === 'video').length, ni = ups.length - nv;
  $('upKind').innerHTML = k ? `Studio reads this as <b>${k}</b>${k === 'carousel' ? ` · ${ni} picture${ni === 1 ? '' : 's'}, ${nv} video${nv === 1 ? '' : 's'}` : ''} · ${(total / 1048576).toFixed(1)} MB` : '';
  $('upThumbs').innerHTML = ups.map((u, i) => `<div class="th">${u.kind === 'video' ? `<video src="${u.url}#t=0.1" muted playsinline preload="metadata"></video><span class="ty">VIDEO</span>` : `<img src="${u.url}" alt="">`}<span class="n">${String(i + 1).padStart(2, '0')}</span>
    <div class="ctl"><button data-a="up" data-i="${i}" aria-label="Move earlier">‹</button><button class="x" data-a="x" data-i="${i}" aria-label="Remove">×</button><button data-a="dn" data-i="${i}" aria-label="Move later">›</button></div></div>`).join('');
  $('upThumbs').querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, a = b.dataset.a;
    if (a === 'x') { URL.revokeObjectURL(ups[i].url); ups.splice(i, 1) }
    else { const j = a === 'up' ? i - 1 : i + 1; if (j >= 0 && j < ups.length) [ups[i], ups[j]] = [ups[j], ups[i]] }
    drawUploads();
  });
  const tooBig = total > MAX_TOTAL;
  if (tooBig) msg('vidMsg', 'err', `${(total / 1048576).toFixed(0)} MB in total. The limit is 150 MB per upload — remove or trim a video.`);
  $('sendVid').disabled = !ups.length || tooBig;
  $('sendVid').textContent = !ups.length ? 'Upload' : k === 'carousel' ? `Upload carousel (${ups.length})` : k === 'reel' ? 'Upload reel' : 'Upload image';
}
$('upDrop').onclick = e => { if (e.target.tagName !== 'INPUT') $('vid').click() };
$('vid').onchange = () => { addUploads($('vid').files); $('vid').value = '' };
['dragenter', 'dragover'].forEach(ev => $('upDrop').addEventListener(ev, e => { e.preventDefault(); $('upDrop').classList.add('over') }));
['dragleave', 'drop'].forEach(ev => $('upDrop').addEventListener(ev, e => { e.preventDefault(); $('upDrop').classList.remove('over') }));
$('upDrop').addEventListener('drop', e => addUploads(e.dataTransfer.files));
$('sendVid').onclick = async () => {
  if (!ups.length) return;
  const btn = $('sendVid'); btn.disabled = true; msg('vidMsg', 'info', 'Reading the files…');
  try {
    const ts = stamp(), k = upKind(), files = [];
    const names = ups.map((u, i) => `${ts}-${String(i + 1).padStart(2, '0')}.${u.ext}`);
    for (let i = 0; i < ups.length; i++) files.push({ path: `references/queue/${names[i]}`, b64: await readB64(ups[i].blob) });
    files.push({ path: `references/queue/${ts}.json`, b64: b64utf8(JSON.stringify({ kind: k, files: names, names: ups.map(u => u.name), note: $('vidNote').value.trim(), tags: tagList($('vidTags').value), learn_for: $('upLearn').value || 'auto', added: new Date().toISOString() }, null, 2) + '\n') });
    const mb = (ups.reduce((n, u) => n + u.blob.size, 0) / 1048576).toFixed(1);
    msg('vidMsg', 'info', `Uploading ${mb} MB…`);
    await commitFiles(files, `inbox: reference ${k} upload (${ups.length} file${ups.length > 1 ? 's' : ''})`, p => bar('vidBar', p));
    msg('vidMsg', 'ok', `Uploaded the ${k}. The studio moves it into references/inbox within a couple of minutes — watch the Status tab.`);
    ups.forEach(u => URL.revokeObjectURL(u.url)); ups = []; drawUploads();
    $('vidNote').value = ''; $('vidTags').value = ''; $('upLearn').value = 'auto';
  } catch (e) { msg('vidMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('vidBar', null);
};

// ---------- tab 2: news ----------
let shots = []; // [{blob, url}]
// the folder name comes from the article link (its last meaningful path part), else the date and time
function newsSlug() {
  let base = '';
  try {
    const u = new URL($('aurl').value.trim());
    const parts = u.pathname.split('/').map(p => { try { return decodeURIComponent(p) } catch { return p } }).map(p => p.replace(/\.(s?html?|php|aspx?|cms)$/i, ''))
      .filter(p => /[a-z]{3,}/i.test(p) && !/^(amp|news|article|articles|articleshow|story|stories|index)$/i.test(p));
    const best = (parts.sort((x, y) => y.split(/[-_]/).length - x.split(/[-_]/).length)[0] || '').replace(/[-_]?\d{5,}[-_\w]*$/, '').replace(/[-_]\d+$/, '');
    const words = slugify(best.replace(/_/g, '-').slice(0, 200)).split('-').filter(Boolean);
    while (words.length > 1 && words.join('-').length > 48) words.pop();        // whole words only
    base = words.join('-').slice(0, 48);
    if (!base) base = slugify(u.hostname.replace(/^www\./, '').split('.')[0]);
  } catch {}
  if (base) return base;
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  return `news-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}
const newsTitle = slug => /^news-\d/.test(slug) ? '' : slug.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
$('aurl').oninput = validateNews;
const newsUrlOk = () => /^https?:\/\/\S+\.\S+/.test($('aurl').value.trim());
function validateNews() { const off = !shots.length && !newsUrlOk(); $('sendNews').disabled = off; $('sendBuild').disabled = off }

async function compress(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return new Promise(res => c.toBlob(res, 'image/jpeg', JPEG_Q));
}
async function addImages(list) {
  const imgs = [...list].filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return;
  for (const f of imgs) {
    try { const blob = await compress(f); shots.push({ blob, url: URL.createObjectURL(blob) }) }
    catch { msg('newsMsg', 'err', `Couldn’t read ${esc(f.name || 'an image')} — try a PNG or JPEG.`) }
  }
  drawThumbs();
}
function drawThumbs() {
  $('thumbs').innerHTML = shots.map((s, i) => `<div class="th"><img src="${s.url}" alt=""><span class="n">${String(i + 1).padStart(2, '0')}</span>
    <div class="ctl"><button data-a="up" data-i="${i}" aria-label="Move earlier">‹</button><button class="x" data-a="x" data-i="${i}" aria-label="Remove">×</button><button data-a="dn" data-i="${i}" aria-label="Move later">›</button></div></div>`).join('');
  $('thumbs').querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, a = b.dataset.a;
    if (a === 'x') { URL.revokeObjectURL(shots[i].url); shots.splice(i, 1) }
    else { const j = a === 'up' ? i - 1 : i + 1; if (j >= 0 && j < shots.length) [shots[i], shots[j]] = [shots[j], shots[i]] }
    drawThumbs();
  });
  validateNews();
}
$('drop').onclick = e => { if (e.target.tagName !== 'INPUT') $('imgs').click() };
$('imgs').onchange = () => { addImages($('imgs').files); $('imgs').value = '' };
['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.add('over') }));
['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.remove('over') }));
$('drop').addEventListener('drop', e => addImages(e.dataTransfer.files));
document.addEventListener('paste', e => {
  const tab = store.get(K.tab), sub = subOf('add');
  const files = [...(e.clipboardData || {}).items || []].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (tab === 'saved') { e.preventDefault(); return addBm(files) }
  if (tab === 'learn') { e.preventDefault(); return addUploads(files) }
  if (tab !== 'add' || sub !== 'news') return;
  e.preventDefault(); addImages(files)
});
const blobB64 = b => readB64(b);
// optional cover-art reference for this story → Finance_Repo studio/editor-assets/<slug>/cover-inspiration.<ext>
let nArt = null, nArtId = '';                          // cover art reference: an upload, or a Saved Artwork id
function setNArt(f) {
  if (!f || !f.type.startsWith('image/')) return;
  if (nArt) URL.revokeObjectURL(nArt.url);
  nArt = { file: f, url: URL.createObjectURL(f) }; nArtId = ''; drawPicks();
  $('nArtPrev').classList.remove('hide');
  $('nArtPrev').innerHTML = `<img src="${nArt.url}" alt=""><button class="btn ghost small danger" id="nArtX" style="width:100%;border-radius:0">Remove</button>`;
  $('nArtX').onclick = () => { URL.revokeObjectURL(nArt.url); nArt = null; $('nArtPrev').classList.add('hide'); $('nArtPrev').innerHTML = '' };
}
$('nArtDrop').onclick = e => { if (e.target.tagName !== 'INPUT') $('nArt').click() };
$('nArt').onchange = () => { setNArt($('nArt').files[0]); $('nArt').value = '' };
['dragenter', 'dragover'].forEach(ev => $('nArtDrop').addEventListener(ev, e => { e.preventDefault(); $('nArtDrop').classList.add('over') }));
['dragleave', 'drop'].forEach(ev => $('nArtDrop').addEventListener(ev, e => { e.preventDefault(); $('nArtDrop').classList.remove('over') }));
$('nArtDrop').addEventListener('drop', e => setNArt(e.dataTransfer.files[0]));
async function sendStory(build) {
  const btn = build ? $('sendBuild') : $('sendNews'); if (!shots.length && !newsUrlOk()) return;
  $('sendNews').disabled = $('sendBuild').disabled = true; clearMsg('newsMsg');
  try {
    const { repo, branch } = cfg(), base = newsSlug();
    let slug = base;                                    // never overwrite an earlier story: base, base-2, base-3, …
    for (let n = 2; n < 50; n++) {
      const existing = await api(`/repos/${repo}/contents/news/inbox/${slug}?ref=${encodeURIComponent(branch)}`).catch(e => { if (e.status === 404) return null; throw e });
      if (!existing) break; slug = `${base}-${n}`;
    }
    const kind = $('nkind').value || (build ? 'carousel' : ''), note = $('nNote').value.trim();
    const names = shots.map((_, i) => String(i + 1).padStart(2, '0') + '.jpg');
    const files = [];
    for (let i = 0; i < shots.length; i++) files.push({ path: `news/inbox/${slug}/${names[i]}`, b64: await blobB64(shots[i].blob) });
    const meta = { story: newsTitle(slug), url: $('aurl').value.trim(), ...(kind ? { kind } : {}), notes: note, images: names, added: new Date().toISOString() };
    if (nArt) {
      const ext = ((nArt.file.name || '').match(/\.(png|jpe?g|webp|gif|avif|heic)$/i) || [, 'png'])[1].toLowerCase().replace('jpeg', 'jpg');
      meta.cover_ref = `studio/editor-assets/${slug}/cover-inspiration.${ext}`;
      files.push({ path: meta.cover_ref, b64: await readB64(nArt.file) });
      files.push({ path: `studio/editor-assets/${slug}/note.md`, b64: b64utf8(`# Editor art for ${slug}\n\n- \`cover-inspiration.${ext}\` — sent from RM Inbox with the story: the cover's visual language (inspiration for the treatment, never the subject — COVER-PLAYBOOK §8).${note ? ` Editor's note: ${note}` : ''}\n`) });
    }
    const sb = !nArt && nArtId && bmArt.find(b => b.id === nArtId);
    if (sb && planSha[bmImg(sb)]) {                    // same contract as an upload; the bookmark picture's blob is reused, not re-uploaded
      const ext = (sb.images[0].split('.').pop() || 'jpg').toLowerCase();
      meta.cover_ref = `studio/editor-assets/${slug}/cover-inspiration.${ext}`; meta.cover_bookmark = sb.id;
      files.push({ path: meta.cover_ref, sha: planSha[bmImg(sb)] });
      files.push({ path: `studio/editor-assets/${slug}/note.md`, b64: b64utf8(`# Editor art for ${slug}\n\n- \`cover-inspiration.${ext}\` — bookmark ${sb.id}, picked in RM Inbox with the story: the cover's visual language (inspiration for the treatment, never the subject — COVER-PLAYBOOK §8).${sb.note ? ` Bookmark note: ${sb.note}` : ''}${note ? ` Editor's note: ${note}` : ''}\n`) });
    }
    files.push({ path: `news/inbox/${slug}/meta.json`, b64: b64utf8(JSON.stringify(meta, null, 2) + '\n') });
    if (build) {
      files.push(buildFile(slug, kind, note));
    }
    const what = shots.length ? `${shots.length} screenshot${shots.length > 1 ? 's' : ''}` : 'link';
    await commitFiles(files, `inbox: news ${slug} (${what}${meta.url && shots.length ? ' + link' : ''}${meta.cover_ref ? ' + cover art' : ''})${build ? ' · build now' : ''}`, p => bar('newsBar', p));
    msg('newsMsg', 'ok', build
      ? `Sent, and the ${esc(kind)} is building on GitHub now (about 30–60 minutes). Follow it in the bar at the top; it lands in <b>Studio</b>.`
      : `Saved to <code>news/inbox/${esc(slug)}/</code>.${meta.url ? ' The studio reads the article from the link within a minute.' : ''} Run <code>/${esc(kind || 'carousel')} ${esc(slug)}</code> in Claude, or tap Send &amp; build now next time.`);
    shots.forEach(s => URL.revokeObjectURL(s.url)); shots = []; drawThumbs();
    $('aurl').value = ''; $('nkind').value = ''; $('nNote').value = '';
    if (nArt) { URL.revokeObjectURL(nArt.url); nArt = null; $('nArtPrev').classList.add('hide'); $('nArtPrev').innerHTML = '' }
    nArtId = ''; drawPicks(); validateNews(); if (build) pollLive(2500);
  } catch (e) { msg('newsMsg', 'err', esc(e.message)); validateNews() }
  bar('newsBar', null);
}
$('sendNews').onclick = () => sendStory(false);
$('sendBuild').onclick = () => sendStory(true);

// ---------- tab 3: status ----------
const ago = iso => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago' };
const tsFromStem = stem => { const m = stem.match(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/); return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null };
function item(dot, title, sub, extra = '') { return `<div class="item"><span class="dot ${dot}"></span><div style="min-width:0;flex:1"><div class="t">${title}</div><div class="s">${sub}</div>${extra}</div></div>` }
function section(title, items, emptyText) { return `<div class="card sec"><h3><span>${title}</span><span>${items.length || ''}</span></h3>${items.join('') || `<div class="empty">${emptyText}</div>`}</div>` }
async function fileText(path) { const { repo, branch } = cfg(); const r = await api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`); return utf8b64(r.content) }
let loading = false, holdStatus = 0;
const qNote = {};                                       // stem → [kind, html]: a result shown under its own item
async function loadStatus(force) {
  if (loading || (!force && Date.now() < holdStatus)) return; loading = true;
  const { repo, branch } = cfg();
  try {
    const [tree, runs] = await Promise.all([
      api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
      api(`/repos/${repo}/actions/workflows/inbox.yml/runs?branch=${encodeURIComponent(branch)}&per_page=1`).catch(e => ({ error: e })),
    ]);
    const paths = tree.tree.filter(t => t.type === 'blob').map(t => t.path);
    const under = p => paths.filter(x => x.startsWith(p)).map(x => x.slice(p.length));
    const run = runs.error ? null : runs.workflow_runs[0];
    const running = run && run.status !== 'completed';

    // queue
    const q = under('references/queue/').filter(x => !x.includes('/'));
    const stems = [...new Set(q.filter(x => x.endsWith('.json')).map(x => x.slice(0, -5)))].sort().reverse();
    const errs = Object.fromEntries(await Promise.all(stems.filter(s => q.includes(s + '.error.txt')).map(async s => [s, await fileText(`references/queue/${s}.error.txt`).catch(() => 'Failed (details unavailable).')])));
    const qMeta = {};
    const qItems = await Promise.all(stems.map(async s => {
      let meta = {}; try { meta = JSON.parse(await fileText(`references/queue/${s}.json`)) } catch {}
      qMeta[s] = meta;
      const n = (meta.files || []).length;
      const title = esc(meta.url || (n > 1 ? `${meta.kind || 'carousel'} · ${n} files` : (meta.names || [])[0] || meta.name || s)), when = tsFromStem(s) ? ago(tsFromStem(s)) : '';
      const note = meta.note ? ' · “' + esc(meta.note) + '”' : '';
      const qn = qNote[s] ? `<div class="msg on ${qNote[s][0]}" style="margin-top:8px">${qNote[s][1]}</div>` : '';
      if (errs[s]) return item('err', title, `Failed · ${when}${note}`, `<div class="e">${esc(errs[s].trim())}</div><div class="acts"><button class="btn ghost small" data-retry="${esc(s)}">Retry</button><button class="btn ghost small danger" data-dismiss="${esc(s)}">Remove</button></div>${qn}`);
      return item(running ? 'run' : 'wait', title, `${running ? 'Downloading now' : 'Waiting for the Action'} · ${when}${note}`, qn);
    }));

    // inbox + cards
    const inboxAll = under('references/inbox/');
    const folders = {};
    inboxAll.filter(x => x.includes('/')).forEach(x => { const [id, f] = x.split('/'); (folders[id] = folders[id] || []).push(f) });
    const kindLbl = id => folders[id] ? (folders[id].length > 1 ? `carousel · ${folders[id].length} slides` : 'image') : 'reel';
    const inbox = [...inboxAll.filter(x => !x.includes('/') && /\.(mp4|mov|webm)$/.test(x)).map(x => x.replace(/\.\w+$/, '')), ...Object.keys(folders)];
    const cards = new Set(under('references/cards/').filter(x => x.includes('/')).map(x => x.split('/')[0]));
    const cardMd = new Set(under('references/cards/').filter(x => x.endsWith('/card.md')).map(x => x.split('/')[0]));
    let index = [];
    if (paths.includes('references/index.json')) { try { const j = JSON.parse(await fileText('references/index.json')); index = (Array.isArray(j) ? j : j.cards || []).filter(e => e.studied).map(e => e.id) } catch {} }
    const studied = new Set(index);
    const iItems = inbox.sort().reverse().map(id => studied.has(id) ? item('ok', esc(id), `${kindLbl(id)} · Studied — card in references/cards`)
      : cards.has(id) ? item('wait', esc(id), `${kindLbl(id)} · Measured · waiting for /study`)
      : item('wait', esc(id), `${kindLbl(id)} · Downloaded · waiting for /study`));
    const cItems = [...cards].sort().map(id => item(studied.has(id) ? 'ok' : 'wait', esc(id), studied.has(id) ? 'Studied' : cardMd.has(id) ? 'Measured · techniques wait for /study' : 'Measuring…'));

    // news + reels
    const reels = new Set(under('studio/reels/').filter(x => x.includes('/')).map(x => x.split('/')[0]));
    const news = [...new Set(under('news/inbox/').filter(x => x.includes('/')).map(x => x.split('/')[0]))].sort();
    const nItems = news.map(s => { const n = under(`news/inbox/${s}/`).filter(x => /\.(jpe?g|png|webp)$/i.test(x)).length;
      const read = under(`news/inbox/${s}/`).some(x => /^article(-link)?\.md$/.test(x));
      return item(reels.has(s) ? 'ok' : 'wait', esc(s), `${n ? `${n} screenshot${n === 1 ? '' : 's'}` : 'link'}${read ? ' · article read' : ''} · ${reels.has(s) ? 'in production' : 'waiting for /reel'}`) });
    const rItems = [...reels].sort().map(s => { const f = under(`studio/reels/${s}/`);
      const st = f.some(x => x.startsWith('audit/')) ? ['ok', 'Preview rendered and audited'] : f.some(x => /^renders\/.*\.mp4$/.test(x)) ? ['ok', 'Preview rendered']
        : f.includes('shotlist.json') ? ['run', 'Shot list written'] : f.includes('script.md') ? ['wait', 'Script drafted'] : ['wait', 'Started'];
      return item(st[0], esc(s), st[1]) });

    // action
    let aHtml;
    if (runs.error) aHtml = runs.error.status === 403
      ? item('wait', 'Inbox Action', 'Downloads still work, but this token can’t see Action runs. To show them: GitHub → Settings → Developer settings → Fine-grained tokens → rm-inbox → Edit → Repository permissions → Actions: Read-only → Update. The token text stays the same.')
      : item('err', 'Inbox Action', runs.error.status === 404 ? 'The inbox workflow isn’t on this branch yet.' : esc(runs.error.message));
    else if (!run) aHtml = item('wait', 'Inbox Action', 'No runs yet on this branch.');
    else {
      const word = run.status !== 'completed' ? ['run', run.status === 'queued' ? 'Queued' : 'Running'] : run.conclusion === 'success' ? ['ok', 'Succeeded'] : run.conclusion === 'cancelled' ? ['wait', 'Cancelled'] : ['err', 'Failed — open the run for details'];
      aHtml = item(word[0], 'Inbox Action', `${word[1]} · ${ago(run.updated_at || run.created_at)} · <a href="${esc(run.html_url)}" target="_blank" rel="noopener">open run</a>`);
    }

    $('statusBody').innerHTML = `<div class="card sec"><h3><span>Latest run</span></h3>${aHtml}</div>`
      + section('Queue · references/queue', qItems, 'Nothing waiting.')
      + section('Downloaded · references/inbox', iItems, 'No references yet.')
      + section('Cards · references/cards', cItems, 'No cards yet.')
      + section('News · news/inbox', nItems, 'No stories yet.')
      + section('Reels · studio/reels', rItems, 'No reels yet.');
    $('statusBody').querySelectorAll('[data-retry]').forEach(b => b.onclick = () => queueAct(b, 'retry', b.dataset.retry, q, qMeta));
    $('statusBody').querySelectorAll('[data-dismiss]').forEach(b => b.onclick = () => queueAct(b, 'dismiss', b.dataset.dismiss, q, qMeta));
    $('stamp').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · refreshes every 15 s';
    clearMsg('statusMsg');
  } catch (e) { msg('statusMsg', 'err', esc(e.message)) }
  loading = false;
}
async function queueAct(btn, kind, stem, q, qMeta = {}) {
  holdStatus = Date.now() + 5000;
  if (kind === 'dismiss' && !armTap(btn, 'Tap again to remove')) return;
  holdStatus = Date.now() + 60000;                       // no refresh while GitHub works
  btn.disabled = true; btn.textContent = kind === 'retry' ? 'Retrying…' : 'Removing…';
  const own = new Set([...((qMeta[stem] || {}).files || []), (qMeta[stem] || {}).file].filter(Boolean));   // carousel uploads: <stem>-01.jpg …
  const files = kind === 'retry' ? [{ path: `references/queue/${stem}.error.txt`, del: true }]
    : q.filter(x => x.startsWith(stem + '.') || own.has(x)).map(x => ({ path: `references/queue/${x}`, del: true }));
  let top;
  try {
    await commitFiles(files, `inbox: ${kind} ${stem}`);
    qNote[stem] = ['ok', kind === 'retry' ? 'Retrying — the Action starts in a few seconds.' : 'Removed.'];
    top = ['ok', kind === 'retry' ? 'Retrying — the Action starts in a few seconds.' : 'Removed from the queue.'];
  } catch (e) {
    qNote[stem] = ['err', esc(e.message)];
    top = ['err', esc(e.message)];
  }
  holdStatus = 0; await loadStatus(true);               // a refresh clears the top message, so set it after
  msg('statusMsg', ...top); show('statusMsg');
}

// ---------- tab 4: studio reels (studio/previews/index.json, written by engine/preview.py after every render) ----------
let reels = [], posters = {}, noPoster = {}, playing = {}, loadingReel = {};
const THEME = { launch: 'blue', ember: 'ember', noir: 'noir', paper: 'paper' };
const picOf = slug => document.querySelector(`[data-reel="${CSS.escape(slug)}"]`);
async function loadReels() {
  $('reelCount').textContent = 'Loading…';
  try {
    const pj = JSON.parse(await fileText('studio/previews/index.json'));
    reels = pj.reels || []; cars = pj.carousels || [];
    drawCarousels();
    drawReels();
    for (const r of reels) if (!posters[r.slug] && !noPoster[r.slug]) (r.poster ? rawBlobUrl(r.poster, 'image/jpeg') : Promise.resolve(null)).then(u => {
      const el = picOf(r.slug);
      if (u) posters[r.slug] = u; else noPoster[r.slug] = true;
      if (!el || el.querySelector('video')) return;            // update in place: a tap may already be loading this card
      if (u) { el.classList.add('has-poster'); el.style.backgroundImage = `url(${u})` }
      else if (!el.querySelector('.nopic')) el.insertAdjacentHTML('beforeend', '<span class="nopic">NO POSTER</span>');
    });
  } catch (e) { $('reelCount').textContent = ''; msg('reelMsg', 'err', e.status === 404 ? 'No reels rendered yet.' : esc(e.message)) }
}
// the 9:16 poster: ▶ always on top (with or without a poster image), a tap anywhere on it plays
function picHtml(r) {
  const p = posters[r.slug];
  return `<div class="pic${p ? ' has-poster' : ''}" data-reel="${esc(r.slug)}" style="${p ? `background-image:url(${p})` : ''}">
        ${r.timing === 'estimate' ? '<span class="stamp">PREVIEW</span>' : ''}<button class="play" type="button" aria-label="Play ${esc(r.slug)}">▶</button>
        ${noPoster[r.slug] ? '<span class="nopic">NO POSTER</span>' : ''}</div>`;
}
function wirePic(r) { const el = picOf(r.slug); if (el) el.onclick = () => playReel(el, r) }
function drawReels() {
  $('reelCount').textContent = `${reels.length} reel${reels.length === 1 ? '' : 's'}`;
  const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` };
  const st = v => v === 'PASS' ? `<b class="ok">PASS</b>` : v === '—' ? '—' : `<b class="bad">${esc(v)}</b>`;
  $('reelGrid').innerHTML = reels.map(r => `<div class="ref reel">
      ${picHtml(r)}
      <div class="body"><div class="note" style="font-size:14px">${esc(r.slug)}</div>
        <div class="tagrow" style="margin-top:2px"><span class="tag">${esc(THEME[r.theme] || r.theme)}</span><span class="tag">${r.captions === 'play' ? 'subtitle play' : 'captions'}</span>${r.section ? `<span class="tag" style="background:var(--blue);color:#fff;box-shadow:none">${esc(r.section)}</span>` : ''}${r.moves ? `<span class="tag">${r.moves} camera</span>` : ''}</div>
        ${r.angle ? `<div class="id" style="margin-top:8px;word-break:normal">${esc(r.angle)}</div>` : ''}
        <div class="meta"><span>${r.duration}s · audit ${st(r.audit)} · critic ${st(r.critic)}</span></div>
        <div class="meta" style="margin-top:4px"><span>${ago(r.rendered)} · ${r.mb} MB</span><a href="#" data-dl="${esc(r.slug)}">Save ↓</a></div>
        <div class="acts" style="display:flex;margin-top:8px"><button class="btn ghost small danger" data-pdel="${esc(r.slug)}" style="flex:1">Delete</button></div></div></div>`).join('') || '<div class="card empty">Nothing rendered yet.</div>';
  reels.forEach(wirePic);
  $('reelGrid').querySelectorAll('[data-dl]').forEach(a => a.onclick = async ev => {
    ev.preventDefault(); const r = reels.find(x => x.slug === a.dataset.dl); a.textContent = '…';
    const u = await videoUrl(r).catch(() => null); if (!u) { a.textContent = 'failed'; return }
    const l = document.createElement('a'); l.href = u; l.download = r.slug + '.mp4'; l.click(); a.textContent = 'Save ↓';
  });
}
// mp4 as a blob typed video/mp4 (the raw API answers application/octet-stream, which iOS Safari refuses to play), with progress
async function videoUrl(r, onProgress) {
  if (playing[r.slug]) return playing[r.slug];
  const { tok, repo, branch } = cfg();
  let res;
  try { res = await fetch(`${API}/repos/${repo}/contents/${r.mp4}?ref=${encodeURIComponent(branch)}`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github.raw' } }) }
  catch { throw new GhError(0) }
  if (!res.ok) { let m = ''; try { m = JSON.parse(await res.text()).message } catch {} throw new GhError(res.status, m) }
  const total = +res.headers.get('content-length') || (r.mb ? r.mb * 1048576 : 0);
  let buf;
  if (res.body && res.body.getReader) {
    const rd = res.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (onProgress) onProgress(got, Math.max(total, got)) }
    buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length }
  } else buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length) throw new Error('GitHub sent an empty file.');
  return (playing[r.slug] = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })));
}
function reelState(el, html, kind) {
  let s = el.querySelector('.state');
  if (!s) { s = document.createElement('div'); el.appendChild(s) }
  s.className = 'state' + (kind ? ' ' + kind : ''); s.innerHTML = html; return s;
}
function reelFail(el, r, text) {
  if (el.querySelector('video')) { el.outerHTML = picHtml(r); wirePic(r); el = picOf(r.slug) }
  el.classList.add('failed');
  const s = reelState(el, `Couldn’t play ${esc(r.slug)}. ${esc(text)}<button class="retry" type="button">Retry</button>`, 'err');
  s.querySelector('.retry').onclick = ev => { ev.stopPropagation(); playReel(el, r) };
}
// runs from the tap itself, so the play() below still counts as a user gesture where the browser allows it
async function playReel(el, r) {
  if (!r || el.querySelector('video') || loadingReel[r.slug]) return;
  loadingReel[r.slug] = true;
  el.classList.remove('failed');
  const btn = el.querySelector('.play'); btn.disabled = true; btn.textContent = '…';
  const mb = n => (n / 1048576).toFixed(1);
  reelState(el, `Loading${r.mb ? ' ' + esc(r.mb) + ' MB' : ''}…`);
  let u;
  try { u = await videoUrl(r, (got, total) => reelState(el, `Loading ${mb(got)} of ${mb(total)} MB…`)) }
  catch (e) { btn.disabled = false; btn.textContent = '▶'; reelFail(el, r, e.message); return }
  finally { loadingReel[r.slug] = false }
  const v = document.createElement('video');
  v.controls = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
  v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('preload', 'metadata');
  if (posters[r.slug]) v.poster = posters[r.slug];
  v.onerror = () => { URL.revokeObjectURL(u); delete playing[r.slug]; reelFail(el, r, 'This browser couldn’t decode the video.') };
  v.src = u;
  el.innerHTML = ''; el.classList.add('on'); el.appendChild(v);
  const p = v.play();
  if (p && p.catch) p.catch(err => {           // the gesture expired while the file downloaded (iOS): one more tap starts it
    if (!err || err.name !== 'NotAllowedError' || el.querySelector('.play')) return;
    const b = document.createElement('button'); b.className = 'play'; b.type = 'button'; b.textContent = '▶'; b.setAttribute('aria-label', 'Play');
    b.onclick = ev => { ev.stopPropagation(); b.remove(); v.play().catch(() => {}) };
    el.appendChild(b);
  });
}
// Fix / rate a carousel or poster from Studio (editor 2026-11-26): a build-now request of kind revise | rate
document.addEventListener('click', async e => {
  const f = e.target.closest('[data-fix]'), fs = e.target.closest('[data-fixsend]'), rt = e.target.closest('[data-rate]');
  const ed0 = e.target.closest('[data-edit]'); if (ed0) return openEditor(+ed0.dataset.edit);
  if (f) { $('fixP' + f.dataset.fix).classList.toggle('hide'); $('fixT' + f.dataset.fix).focus(); return }
  if (!fs && !rt) return;
  const ci = +(fs ? fs.dataset.fixsend : rt.dataset.ci), c = cars[ci], ta = $('fixT' + ci), note = ta ? ta.value.trim() : '', btn = fs || rt;
  if (fs && !note) return msg('carMsg' + ci, 'err', 'Write what to change first.');
  btn.disabled = true;
  try {
    const kind = fs ? 'revise' : 'rate', n = fs ? note : `${rt.dataset.rate}${note ? ' — ' + note : ''}`;
    await commitFiles([buildFile(c.slug, kind, n)], `rm-inbox: ${kind} ${c.slug}`);
    msg('carMsg' + ci, 'ok', fs ? 'Sent — the studio applies the fix and re-renders it (follow it in the bar at the top).' : `Marked ${esc(rt.dataset.rate.replace('-', ' '))} — the studio learns from it.`);
    if (fs) { ta.value = ''; $('fixP' + ci).classList.add('hide') }
    pollLive(2500);
  } catch (err) { msg('carMsg' + ci, 'err', esc(err.message)) }
  btn.disabled = false;
});
// Delete a post from Studio (editor 2026-11-26): its studio/previews/index.json entry + its preview files, in one commit.
// The source reel / carousel / poster folder stays (re-running its preview brings it back). Older versions of a post are
// pruned by the studio itself (engine/previews.py) after every render.
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-pdel]'); if (!btn) return;
  if (!armTap(btn, 'Tap again to delete')) return;
  const slug = btn.dataset.pdel; btn.disabled = true;
  try {
    const { repo, branch } = cfg();
    const tree = await api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const mine = p => p === `studio/previews/${slug}.mp4` || p === `studio/previews/${slug}.jpg` || p === `studio/previews/posters/${slug}.jpg` || p.startsWith(`studio/previews/carousels/${slug}/`);
    const files = tree.tree.filter(t => t.type === 'blob' && mine(t.path)).map(t => ({ path: t.path, del: true }));
    await commitFiles(files, `rm-inbox: delete ${slug} from Studio`, null, async head => {
      const r = await api(`/repos/${repo}/contents/studio/previews/index.json?ref=${head}`), j = JSON.parse(utf8b64(r.content));
      j.reels = (j.reels || []).filter(x => x.slug !== slug); j.carousels = (j.carousels || []).filter(x => x.slug !== slug);
      return [{ path: 'studio/previews/index.json', b64: b64utf8(JSON.stringify(j, null, 1) + '\n') }];
    });
    reels = reels.filter(x => x.slug !== slug); cars = cars.filter(x => x.slug !== slug);
    drawCarousels(); drawReels(); msg('reelMsg', 'ok', `Deleted ${esc(slug)}.`);
  } catch (err) { msg('reelMsg', 'err', esc(err.message)); btn.disabled = false }
});

// ---------- carousels (studio/previews/index.json → carousels, written by engine/carousel.py) ----------
let cars = [], carImgs = {};
async function rawFile(path, type) {               // a repo file as a typed Blob (private repo → token)
  const { tok, repo, branch } = cfg();
  let r;
  try { r = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github.raw' } }) }
  catch { throw new GhError(0) }
  if (!r.ok) { let m = ''; try { m = JSON.parse(await r.text()).message } catch {} throw new GhError(r.status, m) }
  return new Blob([await r.arrayBuffer()], { type });
}
function drawCarousels() {
  $('carWrap').classList.toggle('hide', !cars.length);
  $('carCount').textContent = cars.length || '';
  const st = v => v === 'PASS' ? '<b class="ok">PASS</b>' : `<b class="bad">${esc(v || '—')}</b>`;
  $('carGrid').innerHTML = cars.map((c, ci) => `<div class="ref car">
      <div class="strip" data-car="${ci}">${c.slides.map((s, i) => `<div class="sl" data-ci="${ci}" data-si="${i}">${s.type === 'video' ? '<span class="vtag">VIDEO</span><button class="play" type="button" aria-label="Play">▶</button>' : ''}</div>`).join('')}</div>
      <div class="dots" data-dots="${ci}">${c.slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>
      <div class="body"><div class="note" style="font-size:15px">${esc(c.title || c.slug)}</div>
        <div class="tagrow" style="margin-top:2px"><span class="tag">${c.slides.length} slides</span><span class="tag">${esc(c.theme || '')}</span></div>
        <div class="meta"><span>${esc(c.slug)} · audit ${st(c.audit)}</span></div>
        <div class="acts"><button class="btn ghost small danger" data-pdel="${esc(c.slug)}" style="flex:none">Delete</button><button class="btn primary small" data-share="${ci}">${c.slides.length > 3 ? 'Save for Instagram' : ready[cars[ci].slug + cars[ci].rendered] ? `Open share sheet · ${cars[ci].slides.length} ready` : 'Post to Instagram'}</button>${c.caption ? `<button class="btn ghost small" data-cap="${ci}">Copy caption</button>` : ''}</div>
        <div class="acts${c.slides.length > 3 ? ' hide' : ''}"><button class="btn ghost small" data-save="${ci}" style="flex:1">Save to phone (1080×1350)</button></div>
        <div class="acts"><button class="btn ghost small" data-edit="${ci}">Edit…</button><button class="btn ghost small" data-rate="published" data-ci="${ci}">Published</button><button class="btn ghost small" data-rate="not-published" data-ci="${ci}">Not posted</button></div>
        <div class="msg" id="carMsg${ci}"></div></div></div>`).join('');
  cars.forEach((c, ci) => c.slides.forEach((s, i) => {
    const key = c.slug + '/' + i, el = document.querySelector(`.sl[data-ci="${ci}"][data-si="${i}"]`);
    const show = u => { if (el) el.style.backgroundImage = `url(${u})` };
    if (carImgs[key]) show(carImgs[key]);
    else rawFile(s.type === 'video' ? s.poster : s.src, 'image/jpeg').then(b => show(carImgs[key] = URL.createObjectURL(b))).catch(() => {});
    if (s.type === 'video' && el) el.querySelector('.play').onclick = async ev => {
      ev.stopPropagation(); const btn = ev.currentTarget; btn.textContent = '…'; btn.disabled = true;
      try {
        const u = URL.createObjectURL(await rawFile(s.src, 'video/mp4'));
        const v = document.createElement('video'); v.src = u; v.controls = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
        btn.remove(); el.appendChild(v); v.play().catch(() => {});
      } catch (e) { btn.textContent = '▶'; btn.disabled = false; msg('carMsg' + ci, 'err', esc(e.message)) }
    };
  }));
  document.querySelectorAll('.car .strip').forEach(sp => sp.onscroll = () => {
    const i = Math.round(sp.scrollLeft / sp.clientWidth);
    document.querySelectorAll(`[data-dots="${sp.dataset.car}"] i`).forEach((d, k) => d.classList.toggle('on', k === i));
  });
  document.querySelectorAll('[data-cap]').forEach(b => b.onclick = async () => {
    const c = cars[+b.dataset.cap];
    try { await navigator.clipboard.writeText(c.caption); msg('carMsg' + b.dataset.cap, 'ok', 'Caption copied.') }
    catch { msg('carMsg' + b.dataset.cap, 'err', 'This browser blocked the clipboard — long-press to copy:<br>' + esc(c.caption).replace(/\n/g, '<br>')) }
  });
  document.querySelectorAll('[data-share]').forEach(b => b.onclick = () => shareCarousel(+b.dataset.share, b));
}
// full-size slides → the phone's share sheet (Instagram → Feed, or Save to Photos/Files); downloads where sharing files isn't supported.
// Two taps, by design: Chrome only allows navigator.share() inside the tap that asked for it, and fetching 6 slides from GitHub
// takes longer than that window ("Must be handling a user gesture"). Tap 1 fetches the slides; tap 2 opens the sheet instantly
// and copies the caption at the same moment, so in Instagram you only paste it.
const ready = {};                                   // slug + rendered → [File, …] (full-size slides, in order)
async function prepareCarousel(c, id) {
  const files = [];
  for (let i = 0; i < c.slides.length; i++) {
    const s = c.slides[i], path = s.full || s.src, ext = path.split('.').pop(), type = ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : 'image/jpeg';
    msg(id, 'info', `Getting slide ${i + 1} of ${c.slides.length}…`);
    const blob = await rawFile(path, type), name = `${c.slug}-${String(i + 1).padStart(2, '0')}`;
    if (type === 'video/mp4') { files.push(new File([blob], name + '.mp4', { type })); continue }
    files.push(new File([await to45jpeg(blob)], name + '.jpg', { type: 'image/jpeg' }));
  }
  return files;
}
// Instagram's share flow can square-crop the later images of a carousel even with portrait chosen (editor 2026-11-27: "Instagram
// is cutting the last slides to square"). Every still goes out identical: exactly 1080×1350 (4:5), a flat sRGB JPEG, ~0.3–0.5 MB.
async function to45jpeg(blob) {
  const bmp = await createImageBitmap(blob), W = 1080, H = 1350;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const k = Math.max(W / bmp.width, H / bmp.height), w = bmp.width * k, h = bmp.height * k;   // cover: a 4:5 slide maps 1:1
  g.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
}
// Instagram's Android share import square-crops slides after the first few, whatever ratio is picked later (editor 2026-11-27,
// screenshot: slide 3 portrait, slide 4 boxed). Reliable route: save the slides to the phone and post from Instagram's own gallery.
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-save]'); if (!b) return;
  const ci = +b.dataset.save, c = cars[ci], id = 'carMsg' + ci, key = c.slug + c.rendered;
  b.disabled = true;
  try {
    const files = ready[key] || (ready[key] = await prepareCarousel(c, id));
    for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await new Promise(r => setTimeout(r, 450)) }
    msg(id, 'ok', `Saved ${files.length} slides to your phone (${esc(c.slug)}-01 … -${String(files.length).padStart(2, '0')}, each 1080×1350).<br>In Instagram: <b>+ → Post</b> → tap <b>Select multiple</b> → tap the <b>⤢ crop icon</b> on the first photo so it shows portrait → pick 01, 02, … in order → Next.${c.caption ? ' The caption is copied — paste it.' : ''}`);
    if (c.caption && navigator.clipboard) navigator.clipboard.writeText(c.caption).catch(() => {});
  } catch (err) { msg(id, 'err', esc(err.message || String(err))) }
  b.disabled = false;
});
function shareCarousel(ci, btn) {
  const c = cars[ci], id = 'carMsg' + ci, key = c.slug + c.rendered, files = ready[key];
  if (c.slides.length > 3) {                          // Instagram's share import squares slides 4+ (editor 2026-11-27): save, then post from the gallery
    const sv = document.querySelector(`[data-save="${ci}"]`); if (sv) sv.click(); return;
  }
  if (files) {                                      // tap 2 — no await before share(): we're still inside the tap
    if (navigator.canShare && navigator.canShare({ files })) {
      const p = navigator.share({ files, title: c.title || c.slug });
      if (c.caption && navigator.clipboard) navigator.clipboard.writeText(c.caption).catch(() => {});
      msg(id, 'info', (c.caption ? 'Caption copied. Pick Instagram → Feed; the slides arrive in order (01 first). Paste the caption.' : 'Pick Instagram → Feed; the slides arrive in order (01 first).') + ' If Instagram boxes the later slides into squares, cancel and use “Save to phone” below instead — posting from Instagram’s gallery keeps every slide portrait.');
      p.then(() => msg(id, 'ok', 'Shared. In Instagram: Next → paste the caption → Share.')).catch(e => { if (e && e.name === 'AbortError') clearMsg(id); else msg(id, 'err', esc(e.message || String(e))) });
    } else {
      (async () => { for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); await new Promise(r => setTimeout(r, 400)) }
        msg(id, 'ok', `Downloaded ${files.length} files (01 first).`) })();
    }
    return;
  }
  btn.disabled = true;                              // tap 1 — fetch the slides, then ask for the second tap
  prepareCarousel(c, id).then(f => {
    ready[key] = f; btn.disabled = false; btn.textContent = `Open share sheet · ${f.length} ready`;
    msg(id, 'ok', `${f.length} slides ready. Tap “Open share sheet”.`);
  }).catch(e => { btn.disabled = false; msg(id, 'err', esc(e.message || String(e))) });
}

// ---------- tab 3: library ----------
let lib = [], libSel = new Set(), libKind = '', libSort = 'new', libUnstudied = false, libTagsOpen = false, thumbs = {};   // library filters (editor 2026-11-18: newest first, filter by tag)
const SRCNAME = { x: 'X', ig: 'IG', yt: 'YT', upload: 'FILE' };
async function rawBlobUrl(path, type) {         // private repo: fetch the image with the token, show it as a blob URL
  const { tok, repo, branch } = cfg();
  try {
    const r = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github.raw' } });
    if (!r.ok) return null;
    return URL.createObjectURL(type ? new Blob([await r.arrayBuffer()], { type }) : await r.blob());
  } catch { return null }
}
const indexText = cards => '{"version":1,\n"cards":[\n' + cards.map(c => '  ' + JSON.stringify(c)).join(',\n') + '\n]}\n';
async function loadLibrary() {
  const { repo, branch } = cfg();
  $('libCount').textContent = 'Loading…';
  try {
    const j = JSON.parse(await fileText('references/index.json'));
    lib = (Array.isArray(j) ? j : j.cards || []).slice();
    drawLibrary();
    for (const c of lib) if (!thumbs[c.id]) rawBlobUrl(`references/cards/${c.id}/thumb.jpg`).then(u => { if (u) { thumbs[c.id] = u; const el = document.querySelector(`[data-pic="${CSS.escape(c.id)}"]`); if (el) el.style.backgroundImage = `url(${u})` } });
  } catch (e) { $('libCount').textContent = ''; msg('libMsg', 'err', e.status === 404 ? 'No library yet — add a reference first.' : esc(e.message)) }
}
const addedAt = c => Date.parse(c.added || c.downloaded || '') || 0;
const fmtDay = c => { const t = addedAt(c); return t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '' };
function drawLibrary() {
  const q = $('libQ').value.trim().toLowerCase();
  const tagsOf = c => [...new Set([...(c.tags || []), ...(c.tags_studier || [])])];
  const kindOf = c => c.kind || 'reel';
  // filter row: type · not studied · newest/oldest
  const kinds = [['', 'All'], ['reel', 'Reels'], ['carousel', 'Carousels'], ['image', 'Images']].filter(([k]) => !k || lib.some(c => kindOf(c) === k));
  $('libFilters').innerHTML = kinds.map(([k, n]) => `<button class="tag${libKind === k ? ' on' : ''}" data-k="${k}">${n}</button>`).join('') +
    `<button class="tag${libUnstudied ? ' on' : ''}" data-u="1">Not studied</button><button class="tag" data-s="1">${libSort === 'new' ? 'Newest first ↓' : 'Oldest first ↑'}</button>`;
  $('libFilters').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { libKind = b.dataset.k; drawLibrary() });
  $('libFilters').querySelector('[data-u]').onclick = () => { libUnstudied = !libUnstudied; drawLibrary() };
  $('libFilters').querySelector('[data-s]').onclick = () => { libSort = libSort === 'new' ? 'old' : 'new'; drawLibrary() };
  // tag chips: every tag with its count, most used first; tap several to narrow (a reference must carry all of them)
  // hidden until "Tags" is tapped (editor 2026-11-25: too many chips on open); chosen tags always stay visible
  const count = {}; lib.forEach(c => tagsOf(c).forEach(t => count[t] = (count[t] || 0) + 1));
  const all = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b)).filter(t => libTagsOpen || libSel.has(t));
  if (Object.keys(count).length) {
    $('libFilters').insertAdjacentHTML('beforeend', `<button class="tag tagbtn${libTagsOpen ? ' on' : ''}" data-tt="1">Tags${libSel.size ? ' · ' + libSel.size : ''} ${libTagsOpen ? '▴' : '▾'}</button>`);
    $('libFilters').querySelector('[data-tt]').onclick = () => { libTagsOpen = !libTagsOpen; drawLibrary() };
  }
  $('libTags').classList.toggle('hide', !all.length && !libSel.size);
  $('libTags').innerHTML = (libSel.size ? '<button class="tag" data-clear="1">✕ Clear tags</button>' : '') +
    all.map(t => `<button class="tag${libSel.has(t) ? ' on' : ''}" data-t="${esc(t)}">${esc(t)} <span style="opacity:.6">${count[t]}</span></button>`).join('');
  $('libTags').querySelectorAll('[data-t]').forEach(b => b.onclick = () => { libSel.has(b.dataset.t) ? libSel.delete(b.dataset.t) : libSel.add(b.dataset.t); drawLibrary() });
  const clr = $('libTags').querySelector('[data-clear]'); if (clr) clr.onclick = () => { libSel.clear(); drawLibrary() };
  const shown = lib.filter(c => [...libSel].every(t => tagsOf(c).includes(t)) && (!libKind || kindOf(c) === libKind) && (!libUnstudied || !c.studied) &&
    (!q || [c.id, c.note, ...(c.tags || []), ...(c.tags_studier || []), ...(c.techniques || [])].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (libSort === 'new' ? 1 : -1) * (addedAt(b) - addedAt(a)) || b.id.localeCompare(a.id));   // newest first (by the date it was added)
  $('libCount').textContent = `${lib.length} reference${lib.length === 1 ? '' : 's'}${shown.length !== lib.length ? ` · ${shown.length} shown` : ''}`;
  $('libGrid').innerHTML = shown.map(c => {
    const gold = c.id === 'golden-reel-v3', src = gold ? 'gold' : (c.id.split('-')[0] || 'web');
    const link = c.src && /^https?:/.test(c.src) ? `<a href="${esc(c.src)}" target="_blank" rel="noopener">Open original ↗</a>` : '<span>uploaded file</span>';
    const kind = c.kind || 'reel', post = kind !== 'reel';
    const kindTag = kind === 'carousel' ? `<span class="src" style="left:auto;right:58px;background:var(--blue)">CAROUSEL · ${c.slides}</span>` : kind === 'image' ? '<span class="src" style="left:auto;right:58px;background:var(--blue)">IMAGE</span>' : '';
    const stats = post && c.motion == null ? `${c.slides} slide${c.slides === 1 ? '' : 's'} · ${c.images || 0} img · ${c.videos || 0} vid`
      : `${post ? `${c.slides} slides · ` : ''}pan ${c.pan ?? '–'}% · motion ${c.motion ?? '–'} · cuts ${c.cuts ?? '–'}`;
    const href = c.src && /^https?:/.test(c.src) ? c.src : '';
    return `<div class="ref"><div class="pic${href ? ' open' : ''}" data-pic="${esc(c.id)}" ${href ? `data-href="${esc(href)}"` : ''} style="${thumbs[c.id] ? `background-image:url(${thumbs[c.id]})` : ''}">${href ? '<span class="go">Open ↗</span>' : ''}
        ${gold ? '<span class="gold">HOUSE REFERENCE</span>' : `<span class="src">${esc(SRCNAME[src] || src.toUpperCase())}</span>${kindTag}<button class="del" data-del="${esc(c.id)}" aria-label="Delete">🗑</button>`}</div>
      <div class="body"><div class="id">${fmtDay(c) ? `<b>${fmtDay(c)}</b> · ` : ''}${esc(c.id)} · ${post ? kind + ' · ' : ''}${c.dur ? c.dur + 's' : ''} ${esc(c.aspect || '')}</div>
        <div class="note">${esc(c.note || (gold ? 'The golden reel' : 'No note'))}</div>
        <div class="tagrow" style="margin-top:4px">${c.learn_for && c.learn_for !== 'auto' ? `<span class="tag" style="background:var(--blue);color:#fff;box-shadow:none">learns: ${esc(LEARN_NAME[c.learn_for] || c.learn_for)}</span>` : ''}${tagsOf(c).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        ${(c.techniques || []).length ? `<ul class="tech">${c.techniques.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : `<div class="id" style="margin-top:6px">${c.studied ? '' : 'Techniques pending — run /study'}</div>`}
        <div class="meta"><span>${stats}</span>${link}</div></div></div>`;
  }).join('') || '<div class="card empty">Nothing matches.</div>';
  $('libGrid').querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); deleteRef(b, b.dataset.del) });
  $('libGrid').querySelectorAll('.pic[data-href]').forEach(p => p.onclick = () => window.open(p.dataset.href, '_blank', 'noopener'));
}
async function deleteRef(btn, id) {
  if (!armTap(btn, 'Delete?')) { msg('libMsg', 'info', `Tap <b>Delete?</b> again to delete ${esc(id)} (its video or slides, card and index entry).`); return }
  btn.disabled = true; msg('libMsg', 'info', `Deleting ${esc(id)}…`); show('libMsg');
  const { repo, branch } = cfg();
  try {
    const tree = await api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const paths = tree.tree.filter(t => t.type === 'blob' && (t.path.startsWith(`references/cards/${id}/`) || t.path.startsWith(`references/inbox/${id}/`) || t.path === `references/inbox/${id}.mp4` || t.path === `references/inbox/${id}.json`)).map(t => ({ path: t.path, del: true }));
    await commitFiles(paths, `inbox: delete reference ${id}`, null, async head => {
      const r = await api(`/repos/${repo}/contents/references/index.json?ref=${head}`);   // fresh index on every attempt (the Action may have added one)
      const j = JSON.parse(utf8b64(r.content)), cards = (Array.isArray(j) ? j : j.cards || []).filter(c => c.id !== id);
      return [{ path: 'references/index.json', b64: b64utf8(indexText(cards)) }];
    });
    lib = lib.filter(c => c.id !== id); drawLibrary();
    msg('libMsg', 'ok', `Deleted ${esc(id)}.`); show('libMsg');
  } catch (e) { msg('libMsg', 'err', esc(e.message)); btn.disabled = false; show('libMsg') }
}
$('libQ').oninput = drawLibrary;
$('libAdd').onclick = () => showTab('learn');

$('upLearnWrap').innerHTML = learnSelect('auto', 'id="upLearn"');

// ---------- tab: plan — artwork for later posts, scheduled posts, the pre-market post ----------
// Writes queue files that Finance_Repo's news Action turns into studio/artwork/<id>/ and studio/schedule/items/<id>.json
// (engine/schedule.py ingest); the RM scheduler task runs them. Contract: Finance_Repo studio/schedule/README.md.
const istDay = (plus = 0) => new Date(Date.now() + 5.5 * 3600e3 + plus * 864e5).toISOString().slice(0, 10);
const jsonAt = p => fileText(p).then(JSON.parse).catch(() => null);
const fmtDate = d => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) } catch { return d } };
const USE_AS = { cover: 'cover', wild: 'WILD slide', slide: 'a slide', any: 'Claude decides' };
const KIND_NAME = { carousel: 'Carousel', poster: 'Poster', reel: 'Reel', premarket: 'Pre-market post', postmarket: 'Post-market post', custom: 'Custom' };
const SLOT_NAME = { premarket: 'pre-market post', postmarket: 'post-market post', any: 'any post' };
const useLine = a => (a.use_on === 'next' ? `next ${SLOT_NAME[a.slot] || 'post'}` : a.use_on ? `${fmtDate(a.use_on)} · ${SLOT_NAME[a.slot] || 'any post'}` : 'on the shelf') + ` · ${USE_AS[a.for] || a.for || ''}`;
let shelf = [], bmArt = [], artPick = new Set(), planPaths = [], planSha = {}, planLoading = false, planAgain = false, runBusy = {}, pickBusy = false;   // pickers list bookmarks with pictures (editor 2026-11-26)
const RUNS = { premarket: { hint: 'pmHint', btn: 'pmToggle', msg: 'pmMsg', art: 'pmArt', go: 'pmBuild', name: 'Pre-market' }, postmarket: { hint: 'poHint', btn: 'poToggle', msg: 'poMsg', art: 'poArt', go: 'poBuild', name: 'Post-market' } };

async function loadPlan() {
  if (!cfg().tok) return;
  if (planLoading) { planAgain = true; return }
  planLoading = true; const t0 = Date.now();                 // a read that began before a tap never overwrites it
  try {
    const { repo, branch } = cfg();
    const tree = await api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = tree.tree.filter(t => t.type === 'blob'), paths = planPaths = blobs.map(t => t.path);
    planSha = Object.fromEntries(blobs.map(t => [t.path, t.sha]));
    loadNow(paths).catch(e => msg('nowMsg', 'err', esc(e.message)));
    const errOf = p => paths.includes(p.replace(/\.json$/, '.error.txt'));
    // pre- and post-market switches (recurring.json)
    const rec = paths.includes('studio/schedule/recurring.json') ? await jsonAt('studio/schedule/recurring.json') : null;
    for (const [id, R] of Object.entries(RUNS)) {
      const run = rec && (rec.runs || []).find(r => r.id === id);
      const lastRun = paths.filter(p => new RegExp(`^studio/schedule/runs/[^/]+-${id}\\.json$`).test(p)).sort().pop();
      const lr = lastRun ? await jsonAt(lastRun) : null;
      if (!run) { $(R.hint).textContent = 'Not set up on this branch yet.'; $(R.btn).disabled = true; $(R.btn).textContent = '—'; continue }
      if (!runBusy[id] && (tapAt[id] || 0) < t0) setRunUI(id, run.enabled !== false, run);
      if (lr) $(R.hint).innerHTML += ` · last run ${esc(fmtDate(lr.date))}: ${esc(lr.status)}`;
    }
    // artwork: shelf (newest 40) + uploads the Action hasn't filed yet
    const artJson = paths.filter(p => /^studio\/artwork\/[^/]+\/art\.json$/.test(p) && !p.startsWith('studio/artwork/queue/')).sort().reverse().slice(0, 40);
    const fresh = (await Promise.all(artJson.map(jsonAt))).filter(Boolean).sort((a, b) => (b.added || '').localeCompare(a.added || ''));
    if (!pickBusy && (tapAt.art || 0) < t0) shelf = fresh;
    const bmJson = paths.filter(p => /^bookmarks\/[^/]+\/bookmark\.json$/.test(p)).sort().reverse().slice(0, 60);
    const have = Object.fromEntries(bmArt.map(b => [b.id, b]));
    bmArt = (await Promise.all(bmJson.map(p => have[p.split('/')[1]] || jsonAt(p)))).filter(b => b && (b.images || []).length);
    drawPicks();
    // scheduled posts: this week's items + queue
    const since = istDay(-7).replace(/-/g, '');
    const itemP = paths.filter(p => { const m = p.match(/^studio\/schedule\/items\/(\d{8})-[^/]+\.json$/); return m && m[1] >= since });
    const items = (await Promise.all(itemP.map(async p => ({ p, m: await jsonAt(p) })))).filter(x => x.m);
    const schQ = (await Promise.all(paths.filter(p => /^studio\/schedule\/queue\/[^/]+\.json$/.test(p)).map(async p => ({ p, m: await jsonAt(p), err: errOf(p) })))).filter(x => x.m);
    const buildP = paths.filter(p => /^studio\/schedule\/build\/[^/]+\.json$/.test(p)).sort().reverse().slice(0, 5);
    const builds = (await Promise.all(buildP.map(async p => ({ p, m: await jsonAt(p) })))).filter(x => x.m);
    drawUpcoming(items, schQ, builds);
  } catch (e) { msg('upMsg', 'err', esc(e.message)) }
  planLoading = false;
  if (planAgain) { planAgain = false; loadPlan() }
}

let runOn = {}, tapAt = {};                                      // id → enabled, as last read or set
function setRunUI(id, on, run) {
  const R = RUNS[id]; runOn[id] = on;
  $(R.hint).innerHTML = `<span class="pill ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span> Mon–Fri ${esc((run && run.at) || (id === 'premarket' ? '07:45' : '17:45'))} IST`;
  $(R.btn).textContent = on ? 'Turn off' : 'Turn on'; $(R.btn).disabled = !!runBusy[id];
}
async function toggleRun(id) {
  if (runBusy[id] || !(id in runOn)) return;
  const R = RUNS[id], turnOn = !runOn[id], was = runOn[id];
  runBusy[id] = true; tapAt[id] = Date.now(); setRunUI(id, turnOn); $(R.btn).disabled = true; clearMsg(R.msg);
  try {
    const { repo } = cfg();
    await commitFiles([], `rm-inbox: ${id} post ${turnOn ? 'on' : 'off'}`, null, async head => {
      const r = await api(`/repos/${repo}/contents/studio/schedule/recurring.json?ref=${head}`);
      const j = JSON.parse(utf8b64(r.content)); (j.runs || []).forEach(x => { if (x.id === id) x.enabled = turnOn });
      return [{ path: 'studio/schedule/recurring.json', b64: b64utf8(JSON.stringify(j, null, 2) + '\n') }];
    });
    msg(R.msg, 'ok', turnOn ? `On — every market day at ${id === 'premarket' ? '7:45 am' : '5:45 pm'} IST.` : `Off — no ${R.name.toLowerCase()} post until you turn it on again.`);
  } catch (e) { setRunUI(id, was); msg(R.msg, 'err', esc(e.message)) }
  runBusy[id] = false; $(R.btn).disabled = false;
}
$('pmToggle').onclick = () => toggleRun('premarket');
$('poToggle').onclick = () => toggleRun('postmarket');
// the artwork a pre/post run will take: art.json use_on "next" + slot (or dated today) — one per post
const slotArt = (slot, a) => a.status === 'saved' && a.slot === slot && (a.use_on === 'next' || a.use_on === istDay());
const bmImg = b => `bookmarks/${b.id}/${b.images[0]}`;
function bmArtFiles(b, aid, extra) {                 // a bookmark as a shelf artwork: same art.json the studio reads
  const sha = planSha[bmImg(b)]; if (!sha) throw new Error('That bookmark’s picture isn’t on GitHub yet — refresh and try again.');
  const file = b.images[0], meta = { id: aid, file, title: (b.note || b.id).slice(0, 60), note: b.note || '', status: 'saved', use_on: null, slot: 'any', for: 'cover',
    by: 'rm-inbox', bookmark: b.id, added: new Date().toISOString(), ...extra };
  return [{ path: `studio/artwork/${aid}/${file}`, sha }, { path: `studio/artwork/${aid}/art.json`, b64: b64utf8(JSON.stringify(meta, null, 2) + '\n') }];
}
async function pickRunArt(slot, bmid) {            // bmid '' = no cover art
  if (pickBusy) return;
  const R = RUNS[slot], cur = shelf.filter(a => slotArt(slot, a)), b = bmArt.find(x => x.id === bmid);
  if (cur.length === (b ? 1 : 0) && (!b || cur[0].bookmark === bmid)) return closeArtSheet();      // no change
  pickBusy = true; tapAt.art = Date.now(); const before = shelf;
  const files = [];
  for (const a of cur) {
    if (a.bookmark) planPaths.filter(p => p.startsWith(`studio/artwork/${a.id}/`)).forEach(path => files.push({ path, del: true }));
    else files.push({ path: `studio/artwork/${a.id}/art.json`, b64: b64utf8(JSON.stringify({ ...a, use_on: null, slot: 'any' }, null, 2) + '\n') });
  }
  let added = [];
  try { if (b) { added = bmArtFiles(b, `bm-${bmid}-${slot}`.slice(0, 80), { use_on: 'next', slot }); files.push(...added) } }
  catch (e) { pickBusy = false; return msg(R.msg, 'err', esc(e.message)) }
  // show the choice at once; the commit follows
  shelf = shelf.filter(a => !cur.includes(a)).concat(b ? [{ id: `bm-${bmid}-${slot}`.slice(0, 80), bookmark: bmid, slot, use_on: 'next', status: 'saved', for: 'cover' }] : []);
  closeArtSheet(); drawPicks(); msg(R.msg, 'info', 'Saving…');
  try {
    await commitFiles(files, `rm-inbox: ${b ? 'set' : 'clear'} ${slot} cover art${b ? ` (bookmark ${bmid})` : ''}`);
    planPaths = planPaths.filter(p => !files.some(f => f.del && f.path === p)).concat(added.map(f => f.path));
    msg(R.msg, 'ok', b ? `Set — the next ${R.name.toLowerCase()} post uses it.` : 'Cleared — the studio makes its own cover.');
  } catch (e) { shelf = before; drawPicks(); msg(R.msg, 'err', esc(e.message)) }
  pickBusy = false;
}
let artSheetSlot = '';
function openArtSheet(slot) {
  artSheetSlot = slot;
  const cur = new Set(shelf.filter(a => slotArt(slot, a)).map(a => a.bookmark));
  $('artSheetTitle').textContent = `${RUNS[slot].name} cover art`;
  $('artGrid').innerHTML = `<button type="button" class="artpick none${cur.size ? '' : ' on'}" data-apick=""><span>No cover art<br><small>the studio makes its own</small></span></button>`
    + bmArt.map(b => `<button type="button" class="artpick${cur.has(b.id) ? ' on' : ''}" data-apick="${esc(b.id)}"><img data-pick-img="${esc(b.id)}" alt="" src="${bmThumb[b.id] || ''}"><span>${esc((b.note || b.id).slice(0, 40))}</span></button>`).join('')
    + (bmArt.length ? '' : '<p class="hint" style="grid-column:1/-1">No artwork with pictures yet — save one in Artwork.</p>');
  $('artSheet').classList.remove('hide'); document.body.style.overflow = 'hidden';
}
function closeArtSheet() { $('artSheet').classList.add('hide'); document.body.style.overflow = '' }
$('artGrid').addEventListener('click', e => { const x = e.target.closest('[data-apick]'); if (x && artSheetSlot) pickRunArt(artSheetSlot, x.dataset.apick) });
$('artSheetClose').onclick = closeArtSheet;
document.addEventListener('click', e => { const x = e.target.closest('[data-choose]'); if (x) openArtSheet(x.dataset.choose) });
async function buildRun(slot) {
  const R = RUNS[slot], btn = $(R.go); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const slug = `${slot}-${istDay()}`;
    await commitFiles([buildFile(slug, slot)], `rm-inbox: build ${slug} now`);
    msg(R.msg, 'ok', 'Building on GitHub now (about 30–60 minutes) — follow it in the bar at the top; it lands in <b>Studio</b>.'); pollLive(2500);
  } catch (e) { msg(R.msg, 'err', esc(e.message)) }
  btn.disabled = false; btn.textContent = 'Build now';
}
$('pmBuild').onclick = () => buildRun('premarket');
$('poBuild').onclick = () => buildRun('postmarket');

// "Top 5 now": a request file → Finance_Repo's market-now Action runs Claude Code → news/morning/<date>/brief-<HHMM>.json
let nowTimer = null, nowBrief = null;
async function loadNow(paths) {
  clearTimeout(nowTimer);
  const reqs = paths.filter(p => /^studio\/schedule\/now\/[^/]+\.json$/.test(p)).sort().reverse();
  const last = reqs.length ? await jsonAt(reqs[0]) : null;
  const busy = last && (last.status === 'pending' || last.status === 'running' || !last.status);
  $('nowGo').disabled = !!busy; $('nowGo').textContent = busy ? 'Working…' : 'Top 5 now';
  if (busy) {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(last.added)) / 60000));
    msg('nowMsg', 'info', last.status === 'running' ? `Claude is reading the news… (${mins} min so far, about 3 in all)` : `Waiting for GitHub to start the run… (${mins} min)${mins > 4 ? ' — taking long: check the market-now run in GitHub → Actions' : ''}`);
    if (store.get(K.tab) === 'today') nowTimer = setTimeout(loadPlan, 15000);
  } else if (last && last.status === 'failed') msg('nowMsg', 'err', esc(last.error || 'The run failed.'));
  else clearMsg('nowMsg');
  // newest finished brief (from any request)
  for (const r of reqs.slice(0, 6)) {
    const m = r === reqs[0] ? last : await jsonAt(r);
    if (m && m.status === 'done' && m.result) { const b = await jsonAt(m.result); if (b) { drawBrief(b, m.result); drawHistory(paths); return } }
  }
  $('nowBrief').innerHTML = ''; drawHistory(paths);
}
// earlier briefs (editor 2026-11-27: "an expand bar which when clicked shows the older information")
let histOpen = false, histCache = {};
function drawHistory(paths) {
  const list = paths.filter(p => /^news\/morning\/\d{4}-\d\d-\d\d\/brief-\d{4}\.json$/.test(p) && (!nowBrief || p !== nowBrief.path)).sort().reverse();
  if (!list.length) { $('nowHist').innerHTML = ''; return }
  $('nowHist').innerHTML = `<button type="button" class="histbar" id="histBar"><span>Earlier briefs</span><span>${list.length} ${histOpen ? '▲' : '▼'}</span></button><div id="histList" class="${histOpen ? '' : 'hide'}"></div>`;
  $('histBar').onclick = () => { histOpen = !histOpen; drawHistory(paths) };
  if (histOpen) fillHistory(list.slice(0, 15));
}
async function fillHistory(list) {
  const el = $('histList'); if (!el) return;
  el.innerHTML = '<div class="empty">Loading…</div>';
  const items = await Promise.all(list.map(async p => histCache[p] || (histCache[p] = await jsonAt(p))));
  el.innerHTML = items.map((b, i) => !b ? '' : `<details class="hist"><summary><span class="when">${esc(fmtDate(b.date || list[i].split('/')[2]))} · ${esc(b.time_ist || '')} IST${b.market_phase ? ' · ' + esc(b.market_phase) : ''}</span><b>${esc(b.headline || '')}</b></summary>
    <ol>${(b.points || []).map(pt => `<li><b>${esc(pt.title)}</b><div class="w">${esc(pt.what || '')}</div>${pt.why ? `<div class="y">${esc(pt.why)}</div>` : ''}</li>`).join('')}</ol></details>`).join('');
}
function drawBrief(b, path) {
  nowBrief = { b, path };
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } };
  $('nowBrief').innerHTML = `<details class="hist latest"><summary><span class="when">${esc(b.date)} · ${esc(b.time_ist)} IST · ${esc(b.market_phase)}</span><b>${esc(b.headline || '')}</b><span class="more">Show the ${(b.points || []).length} points ▼</span></summary>
    <ol>${(b.points || []).map(p => `<li><b>${esc(p.title)}</b><div class="w">${esc(p.what)}</div><div class="y">${esc(p.why)}</div>
      ${(p.watch || []).length ? `<div class="tagrow" style="margin-top:4px">${p.watch.map(w => `<span class="tag">${esc(w)}</span>`).join('')}</div>` : ''}
      <div class="srcs">${(p.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.outlet || host(s.url))} ↗</a>`).join('')}</div></li>`).join('')}</ol>
    <div class="row"><button class="btn ghost small" id="nowPost">Make it a carousel</button><button class="btn ghost small" id="nowCopy">Copy</button></div></details>`;
  $('nowPost').onclick = () => briefToPost($('nowPost'));
  $('nowCopy').onclick = async () => {
    const t = `${b.headline}\n\n` + (b.points || []).map((p, i) => `${i + 1}. ${p.title} — ${p.what} ${p.why}`).join('\n');
    try { await navigator.clipboard.writeText(t); $('nowCopy').textContent = 'Copied' } catch { $('nowCopy').textContent = 'Copy failed' }
  };
}
async function briefToPost(btn) {                    // builds now on GitHub (build-now), not at the next scheduler slot
  if (!nowBrief) return;
  btn.disabled = true;
  const b = nowBrief.b, stamp13 = new Date(Date.now() + 5.5 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const slug = `top5-${stamp13}`, leads = (b.points || []).flatMap(p => (p.sources || []).map(s => s.url)).filter(Boolean);
  try {
    const meta = { story: b.headline || 'Top 5', url: '', kind: 'carousel', notes: `Carousel from the Top 5 brief ${nowBrief.path}: the five points, one slide each, in that order.`,
      images: [], leads, added: new Date().toISOString() };
    await commitFiles([{ path: `news/inbox/${slug}/meta.json`, b64: b64utf8(JSON.stringify(meta, null, 2) + '\n') }, buildFile(slug, 'carousel', meta.notes)],
      'rm-inbox: carousel from the Top 5 brief, build now');
    msg('nowMsg', 'ok', 'Building the carousel on GitHub now — follow it in the bar at the top; it lands in Studio.');
    pollLive(2500);
  } catch (e) { msg('nowMsg', 'err', esc(e.message)); btn.disabled = false }
}
$('nowGo').onclick = async () => {
  const btn = $('nowGo'); btn.disabled = true; btn.textContent = 'Sending…'; clearMsg('nowMsg');
  try {
    const d = new Date(Date.now() + 5.5 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    await commitFiles([{ path: `studio/schedule/now/now-${d}.json`, b64: b64utf8(JSON.stringify({ mode: 'brief', note: $('nowNote').value.trim(), added: new Date().toISOString(), status: 'pending', by: 'rm-inbox' }, null, 2) + '\n') }],
      'rm-inbox: top 5 now');
    $('nowNote').value = '';
    msg('nowMsg', 'info', 'Sent. GitHub starts the run in a few seconds; the 5 points appear here in about 3 minutes.');
    setTimeout(loadPlan, 4000);
  } catch (e) { msg('nowMsg', 'err', esc(e.message)); btn.disabled = false; btn.textContent = 'Top 5 now' }
};

async function removeFiles(btn, match, what, msgId) {
  if (!armTap(btn, 'Tap again to remove')) return;
  btn.disabled = true;
  try {
    const files = planPaths.filter(match).map(path => ({ path, del: true }));
    if (files.length) await commitFiles(files, `rm-inbox: remove ${what}`);
    msg(msgId, 'ok', `Removed ${esc(what)}.`);
  } catch (e) { msg(msgId, 'err', esc(e.message)); btn.disabled = false }
  await loadPlan();
}

// schedule a post
function bmThumbFor(b) {
  if (bmThumb[b.id]) return;
  bmThumb[b.id] = '';
  rawBlobUrl(bmImg(b)).then(u => { if (u) { bmThumb[b.id] = u; document.querySelectorAll(`[data-pick-img="${CSS.escape(b.id)}"]`).forEach(i => i.src = u) } });
}
const pickBtn = (b, on, attr) => `<button type="button" class="tag${on ? ' on' : ''}" ${attr}="${esc(b.id)}"><img data-pick-img="${esc(b.id)}" alt="" src="${bmThumb[b.id] || ''}">${esc((b.note || b.id).slice(0, 24))}</button>`;
function drawPicks() {
  const none = '<div class="empty">No artwork with pictures yet — save one in Artwork.</div>';
  bmArt.forEach(bmThumbFor);
  for (const [slot, R] of Object.entries(RUNS)) {          // the card shows only the chosen picture; Choose opens the picker
    const a = shelf.find(x => slotArt(slot, x)), b = a && bmArt.find(x => x.id === a.bookmark);
    $(R.art).innerHTML = '';
    const cb = document.querySelector(`[data-choose="${slot}"]`); if (cb) cb.textContent = a ? 'Choose cover art · 1 set' : 'Choose cover art';
  }
  if (nArtId && !bmArt.some(b => b.id === nArtId)) nArtId = '';
  $('nArtPicks').innerHTML = bmArt.map(b => pickBtn(b, b.id === nArtId, 'data-npick')).join('') || none;
  $('nArtPicks').querySelectorAll('[data-npick]').forEach(x => x.onclick = () => {
    nArtId = nArtId === x.dataset.npick ? '' : x.dataset.npick;
    if (nArtId && nArt) { URL.revokeObjectURL(nArt.url); nArt = null; $('nArtPrev').classList.add('hide'); $('nArtPrev').innerHTML = '' }
    drawPicks();
  });
  artPick = new Set([...artPick].filter(id => bmArt.some(b => b.id === id)));
  $('schArt').innerHTML = bmArt.map(b => pickBtn(b, artPick.has(b.id), 'data-pick')).join('') || none;
  $('schArt').querySelectorAll('[data-pick]').forEach(x => x.onclick = () => { const id = x.dataset.pick; artPick.has(id) ? artPick.delete(id) : artPick.add(id); drawPicks() });
}
const schLinks = () => [...new Set(($('schLinks').value.match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[),.]+$/, '')))];
function validateSch() { $('schSend').disabled = !$('schDate').value || !$('schTime').value || (!schLinks().length && !$('schBrief').value.trim()) }
['schDate', 'schTime', 'schLinks', 'schBrief'].forEach(id => $(id).addEventListener('input', validateSch));
$('schDate').value = istDay(1); validateSch();
$('schSend').onclick = async () => {
  const btn = $('schSend'); btn.disabled = true; clearMsg('schMsg');
  const at = `${$('schDate').value} ${$('schTime').value}`;
  const late = new Date(`${$('schDate').value}T${$('schTime').value}:00+05:30`) < new Date();
  try {
    const picked = bmArt.filter(b => artPick.has(b.id)), artFiles = picked.flatMap(b => bmArtFiles(b, `bm-${b.id}`.slice(0, 80), { for: 'any' }));
    const item = { kind: $('schKind').value, run_at: at, tz: 'Asia/Kolkata', links: schLinks(), brief: $('schBrief').value.trim(), artwork: picked.map(b => `bm-${b.id}`.slice(0, 80)), added: new Date().toISOString() };
    await commitFiles([...artFiles, { path: `studio/schedule/queue/sched-${Date.now()}.json`, b64: b64utf8(JSON.stringify(item, null, 2) + '\n') }],
      `rm-inbox: schedule ${item.kind} at ${at} IST`);
    msg('schMsg', 'ok', `Scheduled: ${esc(KIND_NAME[item.kind])} · ${esc(fmtDate($('schDate').value))} ${esc($('schTime').value)} IST${late ? ' — that time has passed, so it starts at the next check' : ''}. You’ll get a notification when the preview is in Studio.`);
    $('schLinks').value = ''; $('schBrief').value = ''; artPick.clear(); drawPicks(); validateSch();
    setTimeout(loadPlan, 2500);
  } catch (e) { msg('schMsg', 'err', esc(e.message)); btn.disabled = false }
};

function drawUpcoming(items, queued, builds = []) {
  const DOT = { pending: 'wait', started: 'run', done: 'ok', failed: 'err', cancelled: '' };
  const WORD = { pending: 'Scheduled', started: 'Building now', done: 'Done — see Studio', failed: 'Failed', cancelled: 'Cancelled' };
  const rows = [];
  const BW = { pending: 'Waiting for GitHub to start', running: 'Building now on GitHub', done: 'Ready — open Studio', failed: 'Failed' };
  for (const x of builds) { const m = x.m;
    rows.push({ at: m.added, html: item(DOT[m.status] ?? 'wait', `Build now · ${esc(KIND_NAME[m.kind] || m.kind)} · ${esc(m.slug)}`,
      `${BW[m.status] || esc(m.status)}${m.verdict ? ' · ' + esc(m.verdict.slice(0, 60)) : ''}`, m.error ? `<div class="e">${esc(m.error)}</div>` : '') }) }
  if (builds.some(x => ['pending', 'running'].includes(x.m.status)) && store.get(K.tab) === 'add') { clearTimeout(nowTimer); nowTimer = setTimeout(loadPlan, 30000) }
  for (const x of queued) rows.push({ at: x.m.run_at, html: item(x.err ? 'err' : 'wait', `${esc(KIND_NAME[x.m.kind] || x.m.kind)} · ${esc(x.m.run_at)} IST`,
      x.err ? 'Couldn’t schedule it — remove and try again (needs a date and time).' : 'Saved · the studio files it within a minute',
      `${x.m.brief ? `<div class="s">“${esc(x.m.brief.slice(0, 90))}”</div>` : ''}<div class="acts"><button class="btn ghost small danger" data-sq="${esc(x.p)}">Remove</button></div>`) });
  for (const x of items.sort((a, b) => (a.m.run_at || '').localeCompare(b.m.run_at || ''))) {
    const m = x.m, when = (m.run_at || '').replace('T', ' ').slice(0, 16);
    rows.push({ at: m.run_at, html: item(DOT[m.status] ?? 'wait', `${esc(KIND_NAME[m.kind] || m.kind)} · ${esc(when)} IST${m.slug ? ' · ' + esc(m.slug) : ''}`,
      `${WORD[m.status] || esc(m.status)}${m.links && m.links.length ? ` · ${m.links.length} link${m.links.length > 1 ? 's' : ''}` : ''}${(m.artwork || []).length ? ` · ${m.artwork.length} artwork` : ''}${m.error ? ' · ' + esc(m.error) : ''}`,
      `${m.brief ? `<div class="s">“${esc(m.brief.slice(0, 90))}”</div>` : ''}${m.status === 'pending' ? `<div class="acts"><button class="btn ghost small danger" data-cancel="${esc(x.p)}">Cancel</button></div>` : ''}`) });
  }
  $('upCount').textContent = rows.length || '';
  $('upList').innerHTML = rows.map(r => r.html).join('') || '<div class="empty">Nothing scheduled. The pre-market post runs by itself on market days.</div>';
  $('upList').querySelectorAll('[data-sq]').forEach(b => b.onclick = () => { const stem = b.dataset.sq.replace(/\.json$/, ''); removeFiles(b, p => p.startsWith(stem + '.'), 'scheduled post', 'upMsg') });
  $('upList').querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!armTap(b, 'Tap again to cancel')) return;
    b.disabled = true;
    try {
      const { repo } = cfg(), path = b.dataset.cancel;
      await commitFiles([], 'rm-inbox: cancel scheduled post', null, async head => {
        const r = await api(`/repos/${repo}/contents/${path}?ref=${head}`);
        const j = JSON.parse(utf8b64(r.content)); if (j.status === 'pending') j.status = 'cancelled';
        return [{ path, b64: b64utf8(JSON.stringify(j, null, 2) + '\n') }];
      });
      msg('upMsg', 'ok', 'Cancelled.');
    } catch (e) { msg('upMsg', 'err', esc(e.message)); b.disabled = false }
    await loadPlan();
  });
}

// ---------- bookmarks: the one place to save (editor 2026-11-26). The studio never reads them, except a bookmark the editor picks as artwork ----------
// Finance_Repo bookmarks/<id>/bookmark.json {id, url, note, source, images, added} + bookmarks/<id>/01.jpg …
// No Action processes them and no agent reads them (Finance_Repo bookmarks/README.md).
let bmShots = [], bms = [], bmPaths = [], bmShown = 60, bmSrc = '', bmThumb = {}, bmLoading = false;
const BM_SRC = [['', 'All'], ['unused', 'Not used yet'], ['used', 'Used in a post'], ['ig', 'Instagram'], ['yt', 'YouTube'], ['x', 'X'], ['web', 'Web'], ['shot', 'Screenshots']];
let bmUsed = {};   // bookmark id → the post that used it (studio/artwork/bm-*/art.json status used — editor 2026-11-27)
const bmSource = u => u ? srcOf(u) || 'web' : 'shot';
const ytId = u => { const m = (u || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : '' };
const validateBm = () => { $('bmSave').disabled = !bmShots.length && !/^https?:\/\/\S+\.\S+/.test($('bmUrl').value.trim()) };
$('bmUrl').oninput = validateBm;
async function addBm(list) {
  for (const f of [...list].filter(f => f.type.startsWith('image/'))) {
    try { const blob = await compress(f); bmShots.push({ blob, url: URL.createObjectURL(blob) }) } catch { msg('bmMsg', 'err', `Couldn’t read ${esc(f.name || 'an image')}.`) }
  }
  drawBmShots();
}
function drawBmShots() {
  $('bmThumbs').innerHTML = bmShots.map((s, i) => `<div class="th"><img src="${s.url}" alt=""><div class="ctl"><span></span><button class="x" data-i="${i}" aria-label="Remove">×</button><span></span></div></div>`).join('');
  $('bmThumbs').querySelectorAll('button').forEach(b => b.onclick = () => { URL.revokeObjectURL(bmShots[+b.dataset.i].url); bmShots.splice(+b.dataset.i, 1); drawBmShots() });
  validateBm();
}
$('bmDrop').onclick = e => { if (e.target.tagName !== 'INPUT') $('bmFiles').click() };
$('bmFiles').onchange = () => { addBm($('bmFiles').files); $('bmFiles').value = '' };
['dragenter', 'dragover'].forEach(ev => $('bmDrop').addEventListener(ev, e => { e.preventDefault(); $('bmDrop').classList.add('over') }));
['dragleave', 'drop'].forEach(ev => $('bmDrop').addEventListener(ev, e => { e.preventDefault(); $('bmDrop').classList.remove('over') }));
$('bmDrop').addEventListener('drop', e => addBm(e.dataTransfer.files));
$('bmSave').onclick = async () => {
  const btn = $('bmSave'); btn.disabled = true; clearMsg('bmMsg');
  try {
    const url = ($('bmUrl').value.trim().match(/https?:\/\/[^\s<>"']+/) || [''])[0];
    const d = new Date(Date.now() + 5.5 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let tail = ''; try { tail = url ? slugify(new URL(url).hostname.replace(/^www\./, '').split('.')[0]) : 'shots' } catch {}
    const id = `${d}-${tail || 'bm'}`, names = bmShots.map((_, i) => String(i + 1).padStart(2, '0') + '.jpg');
    const meta = { id, url, note: $('bmNote').value.trim(), source: bmSource(url), images: names, added: new Date().toISOString() };
    const files = [];
    for (let i = 0; i < bmShots.length; i++) files.push({ path: `bookmarks/${id}/${names[i]}`, b64: await readB64(bmShots[i].blob) });
    files.push({ path: `bookmarks/${id}/bookmark.json`, b64: b64utf8(JSON.stringify(meta, null, 2) + '\n') });
    await commitFiles(files, `rm-inbox: bookmark ${id}`, p => bar('bmBar', p));
    msg('bmMsg', 'ok', 'Saved — it’s in the list below.'); setTimeout(() => loadBookmarks(), 1500);
    bmShots.forEach(s => URL.revokeObjectURL(s.url)); bmShots = []; drawBmShots();
    $('bmUrl').value = ''; $('bmNote').value = ''; validateBm();
    bms.unshift(meta);
  } catch (e) { msg('bmMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('bmBar', null);
};
async function loadBookmarks(more) {
  if (bmLoading || !cfg().tok) return; bmLoading = true;
  try {
    if (!more) {
      const { repo, branch } = cfg();
      const tree = await api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      bmPaths = tree.tree.filter(t => t.type === 'blob' && /^bookmarks\/[^/]+\/bookmark\.json$/.test(t.path)).map(t => t.path).sort().reverse();
      const artP = tree.tree.filter(t => t.type === 'blob' && /^studio\/artwork\/bm-[^/]+\/art\.json$/.test(t.path)).map(t => t.path);
      const arts = (await Promise.all(artP.map(jsonAt))).filter(Boolean);
      bmUsed = {}; arts.forEach(a => { if (a.bookmark && a.status === 'used') bmUsed[a.bookmark] = a.used_by || 'a post' });
    }
    const have = new Set(bms.map(b => b.id));
    const want = bmPaths.slice(0, bmShown).filter(p => !have.has(p.split('/')[1]));
    const got = (await Promise.all(want.map(jsonAt))).filter(Boolean);
    const keep = new Set(bmPaths.map(p => p.split('/')[1]));
    bms = [...bms, ...got].filter((b, i, a) => a.findIndex(x => x.id === b.id) === i && keep.has(b.id)).sort((a, b) => (b.id || '').localeCompare(a.id || ''));
    clearMsg('bmListMsg'); drawBookmarks();
  } catch (e) { msg('bmListMsg', 'err', esc(e.message)) }
  bmLoading = false;
}
function drawBookmarks() {
  const isPic = b => (b.images || []).length > 0, isUsed = b => !!bmUsed[b.id];
  const FILT = { unused: b => isPic(b) && !isUsed(b), used: isUsed };
  $('bmFilter').innerHTML = BM_SRC.filter(([k]) => !k || (FILT[k] ? bms.some(FILT[k]) : bms.some(b => b.source === k))).map(([k, n]) => `<button class="${bmSrc === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('');
  $('bmFilter').querySelectorAll('button').forEach(b => b.onclick = () => { bmSrc = b.dataset.f; drawBookmarks() });
  const q = $('bmQ').value.trim().toLowerCase();
  const shown = bms.filter(b => (!bmSrc || (FILT[bmSrc] ? FILT[bmSrc](b) : b.source === bmSrc)) && (!q || `${b.note} ${b.url}`.toLowerCase().includes(q)));
  const NAME = { ig: 'Instagram', yt: 'YouTube', x: 'X', web: 'Web', shot: 'Screenshot' };
  $('bmGrid').innerHTML = shown.map(b => {
    const host = (() => { try { return new URL(b.url).hostname.replace(/^www\./, '') } catch { return '' } })();
    const day = new Date(b.added).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return `<div class="bm"><div class="bp" data-open="${esc(b.id)}"><span class="big">${esc(NAME[b.source] || 'Link')}</span><span class="src">${esc((b.source || '').toUpperCase())}</span>${isUsed(b) ? `<span class="used">USED · ${esc(String(bmUsed[b.id]).slice(0, 22))}</span>` : ''}${(b.images || []).length > 1 ? `<span class="cnt">${b.images.length}</span>` : ''}</div>
      <div class="bb">${b.note ? `<div class="nt">${esc(b.note)}</div>` : ''}<div class="dt">${esc(day)}${host ? ' · ' + esc(host) : ''}</div>
      <div class="ba">${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">Open ↗</a>` : '<span></span>'}<button data-del="${esc(b.id)}">Delete</button></div></div></div>`;
  }).join('') || `<div class="empty" style="grid-column:1/-1">${bms.length ? 'Nothing matches.' : 'Nothing saved yet — save one above.'}</div>`;
  for (const b of shown) {
    const el = $('bmGrid').querySelector(`[data-open="${CSS.escape(b.id)}"]`); if (!el) continue;
    const set = u => { el.style.backgroundImage = `url(${u})`; el.querySelector('.big').classList.add('hide') };
    if (bmThumb[b.id]) set(bmThumb[b.id]);
    else if ((b.images || []).length) rawBlobUrl(`bookmarks/${b.id}/${b.images[0]}`).then(u => { if (u) { bmThumb[b.id] = u; set(u) } });
    else if (ytId(b.url)) { bmThumb[b.id] = `https://i.ytimg.com/vi/${ytId(b.url)}/hqdefault.jpg`; set(bmThumb[b.id]) }
    el.onclick = () => (b.images || []).length ? openLightbox(b) : b.url && window.open(b.url, '_blank', 'noopener');
  }
  $('bmGrid').querySelectorAll('[data-del]').forEach(btn => btn.onclick = () => deleteBm(btn, btn.dataset.del));
  $('bmMore').classList.toggle('hide', bmPaths.length <= bmShown);
}
async function openLightbox(b) {
  $('lbStrip').innerHTML = b.images.map((_, i) => `<img data-i="${i}" alt="">`).join(''); $('lightbox').classList.remove('hide');
  b.images.forEach(async (n, i) => { const u = i === 0 && bmThumb[b.id] ? bmThumb[b.id] : await rawBlobUrl(`bookmarks/${b.id}/${n}`); const im = $('lbStrip').querySelector(`[data-i="${i}"]`); if (u && im) im.src = u });
}
$('lbClose').onclick = () => $('lightbox').classList.add('hide');
async function deleteBm(btn, id) {
  if (!armTap(btn, 'Sure?')) return;
  btn.disabled = true;
  try {
    const { repo, branch } = cfg();
    const tree = await api(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const files = tree.tree.filter(t => t.type === 'blob' && t.path.startsWith(`bookmarks/${id}/`)).map(t => ({ path: t.path, del: true }));
    if (files.length) await commitFiles(files, `rm-inbox: delete bookmark ${id}`);
    bms = bms.filter(b => b.id !== id); bmPaths = bmPaths.filter(p => !p.startsWith(`bookmarks/${id}/`)); drawBookmarks();
  } catch (e) { msg('bmListMsg', 'err', esc(e.message)); btn.disabled = false }
}
$('bmQ').oninput = drawBookmarks;
$('bmMore').onclick = () => { bmShown += 60; loadBookmarks(true) };

// ---------- quick tags: one tap adds a tag the studio routes on (pacing → pacer agent, transitions → transitioner agent) ----------
const QUICK = ['pacing', 'transitions', 'hook', 'color', 'typography', 'kinetic'];
function drawQuick() {
  document.querySelectorAll('.quick').forEach(row => {
    const inp = $(row.dataset.for), cur = tagList(inp.value).map(t => t.toLowerCase());
    row.innerHTML = QUICK.map(t => `<button type="button" class="tag${cur.includes(t) ? ' on' : ''}" data-q="${t}">${t}</button>`).join('');
    row.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      const list = tagList(inp.value), i = list.map(x => x.toLowerCase()).indexOf(b.dataset.q);
      if (i >= 0) list.splice(i, 1); else list.push(b.dataset.q);
      inp.value = list.join(', '); drawQuick();
    });
    inp.oninput = drawQuick;
  });
}
drawQuick();
['sendLinks', 'sendVid'].forEach(id => $(id).addEventListener('click', () => setTimeout(drawQuick, 1500)));

// ---------- share button: Android (installed page in the Share menu) and iPhone (a Shortcut opening ?url=…) ----------
// The phone opens Rupee Mechanics with ?url= / ?text= / ?title=. We keep the link until a token exists, put it in Links and
// leave one tap ("Send to studio"), so a stray reload never sends twice.
const SHARE_KEY = 'rm.shared';
function takeShared() {
  const q = new URLSearchParams(location.search);
  const found = ['url', 'text', 'title'].map(k => q.get(k) || '').join(' ').match(/https?:\/\/[^\s<>"']+/);
  if (found) { try { sessionStorage.setItem(SHARE_KEY, found[0]) } catch {} }
  if (q.has('url') || q.has('text') || q.has('title')) history.replaceState(null, '', location.pathname);
}
function applyShared() {
  let u = ''; try { u = sessionStorage.getItem(SHARE_KEY) || '' } catch {}
  if (!u || !cfg().tok) return;
  try { sessionStorage.removeItem(SHARE_KEY) } catch {}
  showTab('add');
  $('shareUrl').textContent = u; $('shareCard').classList.remove('hide');
  $('shareCard').querySelectorAll('[data-share]').forEach(b => b.onclick = () => {
    const to = b.dataset.share; $('shareCard').classList.add('hide');
    if (to === 'bookmark') { showTab('saved'); $('bmUrl').value = u; validateBm(); $('bmNote').focus(); return }
    if (to === 'reference') showTab('learn'); else showSub('add', to);
    if (to === 'news') { $('aurl').value = u; validateNews() }
    else {
      const cur = $('links').value.trim();
      if (!cur.includes(u)) $('links').value = (cur ? cur + '\n' : '') + u;
      parseLinks();
      msg('shareMsg', 'info', 'Add a note on what you like, then tap <b>Send to studio</b>.');
      const note = $('linkCards').querySelector('input'); if (note) note.focus();
    }
  });
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
takeShared();
boot();
applyShared();
