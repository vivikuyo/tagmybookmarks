import { resolveColorValue } from '../lib/palette.js';
import { init as initTags, refresh as refreshTags } from './tags.js';
import { refresh as refreshOverview } from './overview.js';
import { init as initBookmarks, refreshView as refreshBookmarks } from './bookmarks.js';

const $ = (sel) => document.querySelector(sel);
const CATS = ['colors', 'prefs', 'aliases'];

const toastEl = $('#toast');
let toastTimer = null;
function toast(text, isErr = false) {
  toastEl.textContent = text;
  toastEl.className = 'toast' + (isErr ? ' err' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r) throw new Error('后台无响应，试着重载扩展');
    if (r.error) throw new Error(r.error);
    return r;
  });
}

async function loadState() {
  const st = await send({ type: 'state' });
  const counts = st.counts || {};
  $('#counts').textContent = `当前索引：${counts.keys || 0} 条书签 / ${counts.tags || 0} 个标签 / ${counts.nodes || 0} 个位置。`;

  renderDuplicates(st.configDuplicates || []);

  const colors = (st.config && st.config.colors) || {};
  const box = $('#swatches');
  box.textContent = '';
  const entries = Object.entries(colors);
  if (!entries.length) {
    const tip = document.createElement('span');
    tip.className = 'hint';
    tip.textContent = '还没有手动设色的标签，全部按标签名取默认色。';
    box.append(tip);
  } else {
    for (const [tag, value] of entries.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh'))) {
      const hex = resolveColorValue(value) || '#8a8f98';
      const el = document.createElement('span');
      el.className = 'swatch';
      el.title = `${tag} = ${value}`;
      const dot = document.createElement('i');
      dot.style.background = hex;
      const name = document.createElement('span');
      name.textContent = tag;
      el.append(dot, name);
      box.append(el);
    }
  }
  return st;
}

async function loadCategory(key) {
  const r = await send({ type: 'config:read', category: key });
  const ta = $('#raw-' + key);
  ta.value = r.raw || '';
  const status = $('#status-' + key);
  if (r.errors && r.errors.length) {
    status.className = 'status err';
    status.textContent = `有 ${r.errors.length} 处无法解析，保存会原样保留`;
  } else {
    status.className = 'status';
    status.textContent = r.title ? '已同步' : '空白';
  }
}

async function saveCategory(key) {
  const ta = $('#raw-' + key);
  const status = $('#status-' + key);
  try {
    const r = await send({ type: 'config:write', category: key, raw: ta.value });
    if (r.errors && r.errors.length) {
      status.className = 'status err';
      status.textContent = `已保存，但有 ${r.errors.length} 处无法解析`;
    } else {
      status.className = 'status ok';
      status.textContent = '已保存';
    }
    await loadCategory(key);
    await loadState();
    toast('配置已写回书签标题');
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
    toast(e.message, true);
  }
}

function renderDuplicates(list) {
  const banner = $('#dupBanner');
  if (!banner) return;
  if (!list.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const parts = list.map((d) => `${d.label} ${d.count} 条`);
  $('#dupText').textContent = `发现重复的配置文件：${parts.join('、')}。`;
}

function bind() {
  $('#btnDedupe').addEventListener('click', async () => {
    const btn = $('#btnDedupe');
    btn.disabled = true;
    btn.textContent = '合并中…';
    try {
      const r = await send({ type: 'config:dedupe' });
      const bits = [];
      for (const m of r.merged || []) {
        bits.push(`${m.label}：保留 1 条、删除 ${m.merged} 条、并入 ${m.filled} 项`);
      }
      if (r.conflicts && r.conflicts.length) {
        bits.push(`冲突 ${r.conflicts.length} 项（保留较早文件的值）：` + r.conflicts.map((c) => `${c.key} 保留 ${c.kept} / 舍弃 ${c.dropped}`).join('，'));
      }
      toast(bits.length ? '已合并 — ' + bits.join(' | ') : '没有需要合并的重复文件');
      for (const c of CATS) await loadCategory(c);
      await loadState();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '合并重复配置';
    }
  });
  document.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveCategory(btn.dataset.save));
  });

  $('#btnRebuild').addEventListener('click', async () => {
    try {
      const r = await send({ type: 'index:rebuild' });
      toast(`索引已重建：${r.counts.keys} 条书签 / ${r.counts.tags} 个标签`);
      await loadState();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#btnRestore').addEventListener('click', async () => {
    try {
      await send({ type: 'config:restore' });
      for (const c of CATS) await loadCategory(c);
      await loadState();
      toast('缺失的配置文件已重建（已存在的不会被覆盖）');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#btnOrganizer').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://bookmarks/' });
  });

  $('#btnCloseResult').addEventListener('click', () => {
    $('#resultSection').hidden = true;
  });

  // 快捷键提示：C 聚焦颜色，P 偏好，A 别名
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement && /textarea|input/i.test(document.activeElement.tagName)) return;
    const map = { c: 'colors', p: 'prefs', a: 'aliases' };
    const key = map[e.key.toLowerCase()];
    if (key) focusCard(key);
  });
}

function focusCard(key) {
  const card = document.querySelector(`.card[data-cat="${key}"]`);
  if (!card) return;
  document.querySelectorAll('.card').forEach((c) => c.classList.remove('target'));
  card.classList.add('target');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const ta = $('#raw-' + key);
  if (ta) setTimeout(() => ta.focus(), 260);
}

async function showView(name) {
  const overviewView = document.querySelector('#view-overview');
  const tagsView = document.querySelector('#view-tags');
  const configView = document.querySelector('#view-config');
  const bmView = document.querySelector('#view-bookmarks');
  if (overviewView) overviewView.hidden = name !== 'overview';
  if (tagsView) tagsView.hidden = name !== 'tags';
  if (configView) configView.hidden = name !== 'config';
  if (bmView) bmView.hidden = name !== 'bookmarks';
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('on', a.dataset.view === name);
  });
  if (name === 'overview') {
    try {
      await refreshOverview();
    } catch (e) {
      toast(e.message, true);
    }
  }
  if (name === 'tags') {
    try {
      await refreshTags();
    } catch (e) {
      toast(e.message, true);
    }
  }
  if (name === 'bookmarks') {
    try {
      await refreshBookmarks();
    } catch (e) {
      toast(e.message, true);
    }
  }
}

async function handleHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));

  if (hash.startsWith('cfg=')) {
    await showView('config');
    focusCard(hash.slice(4));
    return;
  }

  if (hash.startsWith('/config')) {
    await showView('config');
    return;
  }

  if (hash.startsWith('q=')) {
    await showView('config');
    const expr = hash.slice(2);
    try {
      const r = await send({ type: 'query', expr });
      $('#resultSection').hidden = false;
      $('#resultCount').textContent = expr ? `“${expr}” · ${r.total} 条` : `全部已标签 · ${r.total} 条`;
      const ul = $('#resultList');
      ul.textContent = '';
      for (const item of r.items.slice(0, 200)) {
        const li = document.createElement('li');
        const t = document.createElement('div');
        t.className = 't';
        t.textContent = item.title || item.url;
        const u = document.createElement('div');
        u.className = 'u';
        u.textContent = `${item.tags.map((x) => '#' + x).join(' ')}${item.tags.length ? ' · ' : ''}${item.url}`;
        li.append(t, u);
        li.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
        ul.append(li);
      }
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }

  if (hash.startsWith('/overview')) {
    await showView('overview');
    return;
  }

  if (hash.startsWith('/tags')) {
    await showView('tags');
    return;
  }

  if (hash.startsWith('/bookmarks')) {
    await showView('bookmarks');
    return;
  }

  // 默认落在概览
  await showView('overview');
}

async function boot() {
  bind();
  if (document.querySelector('#tagRows')) initTags();
  if (document.querySelector('#bmRows')) await initBookmarks();
  try {
    await loadState();
    for (const c of CATS) await loadCategory(c);
    await handleHash();
  } catch (e) {
    toast(e.message, true);
  }
  window.addEventListener('hashchange', handleHash);
}

boot();
