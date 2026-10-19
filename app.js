// RM Inbox — feeds the Rupee Mechanics studio through the GitHub REST API.
// The token lives only in this browser's localStorage and is sent only to api.github.com.
'use strict';
const $ = id => document.getElementById(id);
const API = 'https://api.github.com';
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
function clearMsg(id) { $(id).className = 'msg' }
function bar(id, frac) { const b = $(id); if (frac == null) { b.className = 'bar'; return } b.className = 'bar on'; b.firstChild.style.width = Math.round(frac * 100) + '%' }

// ---------- errors in plain words ----------
class GhError extends Error { constructor(status, text) { super(plain(status, text)); this.status = status } }
function plain(status, text) {
  const t = (text || '').toLowerCase();
  if (status === 0) return 'No connection to GitHub. Check your network and try again.';
  if (status === 401) return 'GitHub rejected the token. It may have expired or been revoked. Tap “Forget token” and paste a new one.';
  if (status === 403 && t.includes('rate limit')) return 'GitHub’s rate limit was hit. Wait a few minutes and try again.';
  if (status === 403) return 'The token is missing a permission. It needs Contents: Read and write and Actions: Read-only on Finance_Repo.';
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
    r = await fetch(API + path, { ...opts, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + tok, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
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
async function commitFiles(files, message, onProgress) {
  const { repo, branch } = cfg();
  const total = files.reduce((n, f) => n + (f.b64 ? f.b64.length : 0), 0) || 1;
  let done = 0;
  const entries = [];
  for (const f of files) {
    if (f.del) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue }
    const sha = await postBlob(f.b64, p => onProgress && onProgress(.9 * (done + p * f.b64.length) / total));
    done += f.b64.length;
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  for (let attempt = 1; ; attempt++) {           // blobs are reused; only tree/commit/ref retry on a race
    try {
      const ref = await api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      const head = await api(`/repos/${repo}/git/commits/${ref.object.sha}`);
      const tree = await api(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }) });
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

// ---------- setup ----------
function boot() {
  const c = cfg();
  $('repo').value = c.repo; $('branch').value = c.branch;
  const on = !!c.tok;
  $('setup').classList.toggle('hide', on); $('app').classList.toggle('hide', !on);
  $('repoLbl').textContent = on ? `${c.repo} · ${c.branch}` : '';
  $('who').textContent = '';
  if (on) { showTab(store.get(K.tab) || 'refs'); api('/user').then(u => $('who').textContent = '@' + u.login).catch(() => {}) }
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
    $('tok').value = ''; clearMsg('setupMsg'); boot();
  } catch (e) { store.del(K.tok); msg('setupMsg', 'err', esc(e.message)) }
};
$('forget').onclick = () => { if (confirm('Forget the token on this device?')) { store.del(K.tok); boot() } };

// ---------- tabs ----------
let statusTimer = null;
function showTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hide', p.dataset.pane !== t));
  store.set(K.tab, t);
  clearInterval(statusTimer);
  if (t === 'status') { loadStatus(); statusTimer = setInterval(loadStatus, 15000) }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- tab 1: references ----------
const SRC = [[/(^|\.)(x|twitter)\.com$/, 'x'], [/(^|\.)instagram\.com$/, 'ig'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'yt']];
const srcOf = u => { try { const h = new URL(u).hostname; return (SRC.find(([re]) => re.test(h)) || [0, 'web'])[1] } catch { return null } };
let links = []; // [{url, note}]
function parseLinks() {
  const urls = [...new Set(($('links').value.match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[),.]+$/, '')))];
  const old = Object.fromEntries(links.map(l => [l.url, l.note]));
  links = urls.filter(srcOf).map(url => ({ url, note: old[url] || '' }));
  $('linkCards').innerHTML = links.map((l, i) => `<div class="link"><div class="u"><span class="src">${srcOf(l.url)}</span>${esc(l.url)}</div>
    <input data-i="${i}" placeholder="what I like: …" value="${esc(l.note)}"></div>`).join('');
  $('linkCards').querySelectorAll('input').forEach(inp => inp.oninput = () => links[inp.dataset.i].note = inp.value);
  $('sendLinks').disabled = !links.length;
  $('sendLinks').textContent = links.length > 1 ? `Send ${links.length} links to studio` : 'Send to studio';
}
$('links').oninput = parseLinks;
$('sendLinks').onclick = async () => {
  const btn = $('sendLinks'); btn.disabled = true; clearMsg('linksMsg');
  const ts = stamp(), tags = tagList($('tags').value), added = new Date().toISOString();
  const files = links.map((l, i) => ({ path: `references/queue/${ts}${links.length > 1 ? '-' + (i + 1) : ''}.json`,
    b64: b64utf8(JSON.stringify({ url: l.url, note: l.note.trim(), tags, added }, null, 2) + '\n') }));
  try {
    await commitFiles(files, `inbox: ${files.length} reference link${files.length > 1 ? 's' : ''}`, p => bar('linksBar', p));
    msg('linksMsg', 'ok', `Sent ${files.length} link${files.length > 1 ? 's' : ''}. The download usually takes 1–3 minutes — watch the Status tab.`);
    $('links').value = ''; $('tags').value = ''; parseLinks();
  } catch (e) { msg('linksMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('linksBar', null);
};
$('vid').onchange = () => {
  const f = $('vid').files[0]; clearMsg('vidMsg');
  if (f && f.size > MAX_VIDEO) { msg('vidMsg', 'err', `That file is ${(f.size / 1048576).toFixed(0)} MB. The limit is 90 MB — trim it or export at 1080p.`); $('sendVid').disabled = true; return }
  $('sendVid').disabled = !f;
};
const readB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1)); r.onerror = () => rej(new Error('Could not read the file on this device.')); r.readAsDataURL(f) });
$('sendVid').onclick = async () => {
  const f = $('vid').files[0]; if (!f) return;
  const btn = $('sendVid'); btn.disabled = true; msg('vidMsg', 'info', 'Reading the video…');
  try {
    const ts = stamp(), ext = (f.name.match(/\.(mp4|mov|m4v|webm)$/i) || [, 'mp4'])[1].toLowerCase();
    const b64 = await readB64(f);
    msg('vidMsg', 'info', `Uploading ${(f.size / 1048576).toFixed(1)} MB…`);
    await commitFiles([
      { path: `references/queue/${ts}.${ext}`, b64 },
      { path: `references/queue/${ts}.json`, b64: b64utf8(JSON.stringify({ file: `${ts}.${ext}`, name: f.name, note: $('vidNote').value.trim(), tags: tagList($('vidTags').value), added: new Date().toISOString() }, null, 2) + '\n') },
    ], `inbox: reference upload ${f.name}`, p => bar('vidBar', p));
    msg('vidMsg', 'ok', 'Uploaded. The studio moves it into references/inbox within a couple of minutes.');
    $('vid').value = ''; $('vidNote').value = ''; $('vidTags').value = '';
  } catch (e) { msg('vidMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('vidBar', null);
};

// ---------- tab 2: news ----------
let shots = []; // [{blob, url}]
let slugTouched = false;
$('story').oninput = () => { if (!slugTouched) $('slug').value = slugify($('story').value); validateNews() };
$('slug').oninput = () => { slugTouched = $('slug').value !== ''; validateNews() };
$('slug').onblur = () => $('slug').value = slugify($('slug').value);
$('aurl').oninput = validateNews;
function validateNews() { $('sendNews').disabled = !(shots.length && slugify($('slug').value)) }

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
  if (store.get(K.tab) !== 'news') return;
  const files = [...(e.clipboardData || {}).items || []].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addImages(files) }
});
const blobB64 = b => readB64(b);
$('sendNews').onclick = async () => {
  const slug = slugify($('slug').value), btn = $('sendNews'); if (!slug || !shots.length) return;
  btn.disabled = true; clearMsg('newsMsg');
  try {
    const { repo, branch } = cfg();
    const existing = await api(`/repos/${repo}/contents/news/inbox/${slug}?ref=${encodeURIComponent(branch)}`).catch(e => { if (e.status === 404) return null; throw e });
    if (existing && !confirm(`news/inbox/${slug} already exists. Add these as a new set inside it (files are replaced)?`)) { btn.disabled = false; return }
    const names = shots.map((_, i) => String(i + 1).padStart(2, '0') + '.jpg');
    const files = [];
    for (let i = 0; i < shots.length; i++) files.push({ path: `news/inbox/${slug}/${names[i]}`, b64: await blobB64(shots[i].blob) });
    const meta = { story: $('story').value.trim(), url: $('aurl').value.trim(), notes: $('notes').value.trim(), images: names, added: new Date().toISOString() };
    files.push({ path: `news/inbox/${slug}/meta.json`, b64: b64utf8(JSON.stringify(meta, null, 2) + '\n') });
    await commitFiles(files, `inbox: news ${slug} (${shots.length} screenshot${shots.length > 1 ? 's' : ''})`, p => bar('newsBar', p));
    msg('newsMsg', 'ok', `Saved to <code>news/inbox/${esc(slug)}/</code> in one commit. Run <code>/reel ${esc(slug)}</code> when ready.`);
    shots.forEach(s => URL.revokeObjectURL(s.url)); shots = []; drawThumbs();
    ['story', 'slug', 'aurl', 'notes'].forEach(id => $(id).value = ''); slugTouched = false;
  } catch (e) { msg('newsMsg', 'err', esc(e.message)); btn.disabled = false }
  bar('newsBar', null);
};

// ---------- tab 3: status ----------
const ago = iso => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago' };
const tsFromStem = stem => { const m = stem.match(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/); return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null };
function item(dot, title, sub, extra = '') { return `<div class="item"><span class="dot ${dot}"></span><div style="min-width:0;flex:1"><div class="t">${title}</div><div class="s">${sub}</div>${extra}</div></div>` }
function section(title, items, emptyText) { return `<div class="card sec"><h3><span>${title}</span><span>${items.length || ''}</span></h3>${items.join('') || `<div class="empty">${emptyText}</div>`}</div>` }
async function fileText(path) { const { repo, branch } = cfg(); const r = await api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`); return utf8b64(r.content) }
let loading = false;
async function loadStatus() {
  if (loading) return; loading = true;
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
    const qItems = await Promise.all(stems.map(async s => {
      let meta = {}; try { meta = JSON.parse(await fileText(`references/queue/${s}.json`)) } catch {}
      const title = esc(meta.url || meta.name || s), when = tsFromStem(s) ? ago(tsFromStem(s)) : '';
      const note = meta.note ? ' · “' + esc(meta.note) + '”' : '';
      if (errs[s]) return item('err', title, `Failed · ${when}${note}`, `<div class="e">${esc(errs[s].trim())}</div><div class="acts"><button class="btn ghost small" data-retry="${esc(s)}">Retry</button><button class="btn ghost small danger" data-dismiss="${esc(s)}">Remove</button></div>`);
      return item(running ? 'run' : 'wait', title, `${running ? 'Downloading now' : 'Waiting for the Action'} · ${when}${note}`);
    }));

    // inbox + cards
    const inbox = under('references/inbox/').filter(x => /\.(mp4|mov|webm)$/.test(x)).map(x => x.replace(/\.\w+$/, ''));
    const cards = new Set(under('references/cards/').filter(x => x.includes('/')).map(x => x.split('/')[0]));
    const cardMd = new Set(under('references/cards/').filter(x => x.endsWith('/card.md')).map(x => x.split('/')[0]));
    let index = [];
    if (paths.includes('references/index.json')) { try { const j = JSON.parse(await fileText('references/index.json')); index = (Array.isArray(j) ? j : j.cards || []).filter(e => e.studied).map(e => e.id) } catch {} }
    const studied = new Set(index);
    const iItems = inbox.sort().reverse().map(id => studied.has(id) ? item('ok', esc(id), 'Studied — card in references/cards')
      : cards.has(id) ? item('wait', esc(id), 'Measured (sheet, clip, metrics) · waiting for /study')
      : item('wait', esc(id), 'Downloaded · waiting for /study'));
    const cItems = [...cards].sort().map(id => item(studied.has(id) ? 'ok' : 'wait', esc(id), studied.has(id) ? 'Studied' : cardMd.has(id) ? 'Measured · techniques wait for /study' : 'Measuring…'));

    // news + reels
    const reels = new Set(under('studio/reels/').filter(x => x.includes('/')).map(x => x.split('/')[0]));
    const news = [...new Set(under('news/inbox/').filter(x => x.includes('/')).map(x => x.split('/')[0]))].sort();
    const nItems = news.map(s => { const n = under(`news/inbox/${s}/`).filter(x => /\.(jpe?g|png|webp)$/i.test(x)).length;
      return item(reels.has(s) ? 'ok' : 'wait', esc(s), `${n} screenshot${n === 1 ? '' : 's'} · ${reels.has(s) ? 'in production' : 'waiting for /reel'}`) });
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
      + section('Downloaded · references/inbox', iItems, 'No videos yet.')
      + section('Cards · references/cards', cItems, 'No cards yet.')
      + section('News · news/inbox', nItems, 'No stories yet.')
      + section('Reels · studio/reels', rItems, 'No reels yet.');
    $('statusBody').querySelectorAll('[data-retry]').forEach(b => b.onclick = () => queueAct(b, 'retry', b.dataset.retry, q));
    $('statusBody').querySelectorAll('[data-dismiss]').forEach(b => b.onclick = () => queueAct(b, 'dismiss', b.dataset.dismiss, q));
    $('stamp').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · refreshes every 15 s';
    clearMsg('statusMsg');
  } catch (e) { msg('statusMsg', 'err', esc(e.message)) }
  loading = false;
}
async function queueAct(btn, kind, stem, q) {
  if (kind === 'dismiss' && !confirm('Remove this item from the queue?')) return;
  btn.disabled = true;
  const files = kind === 'retry' ? [{ path: `references/queue/${stem}.error.txt`, del: true }]
    : q.filter(x => x.startsWith(stem + '.')).map(x => ({ path: `references/queue/${x}`, del: true }));
  try { await commitFiles(files, `inbox: ${kind} ${stem}`); msg('statusMsg', 'ok', kind === 'retry' ? 'Retrying — the Action starts in a few seconds.' : 'Removed.'); loadStatus() }
  catch (e) { msg('statusMsg', 'err', esc(e.message)); btn.disabled = false }
}
$('refresh').onclick = loadStatus;

boot();
