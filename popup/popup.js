import { colorFor } from '../lib/palette.js';
import { splitTagInput, normalizeTagOrNull } from '../lib/title.js';

const $ = (s) => document.querySelector(s);
const tagInput = $('#tagInput');
const btnCollect = $('#btnCollect');
const toastEl = $('#toast');
const destSelect = $('#destSelect');
const previewEl = $('#tagPreview');

const DEST_KEY = 'ui:dest';

let page = { url: '', title: '', collected: 0, tags: [], ids: [] };
let colors = {};
let foldersFlat = [];
let sugTimer = null;

function toast(text, isErr = false) {
  toastEl.textContent = text;
  toastEl.className = 'toast' + (isErr ? ' err' : '');
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), 1800);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r) throw new Error('后台无响应');
    if (r.error) throw new Error(r.error);
    return r;
  });
}

function tagsFromInput(value) {
  return splitTagInput(value)
    .map(normalizeTagOrNull)
    .filter(Boolean);
}

function renderTags() {
  const box = $('#tags');
  box.textContent = '';
  if (!page.tags.length) {
    const tip = document.createElement('span');
    tip.className = 'empty-tip';
    tip.textContent = page.collected ? '还没有标签' : '这个页面还没被收藏';
    box.append(tip);
    return;
  }
  for (const tag of page.tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.color = colorFor(tag, colors);
    const name = document.createElement('span');
    name.textContent = tag;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = `摘掉 #${tag}`;
    x.addEventListener('click', async () => {
      try {
        await send({ type: 'tags:remove', ids: page.ids, tags: [tag] });
        await refresh();
        toast(`已摘掉 #${tag}`);
      } catch (e) {
        toast(e.message, true);
      }
    });
    chip.append(name, x);
    box.append(chip);
  }
}

// 输入即时预览：写错分隔符能马上发现，而不是提交后才看到结果
function renderPreview() {
  const tags = tagsFromInput(tagInput.value);
  previewEl.textContent = '';
  if (!tags.length) {
    previewEl.hidden = true;
    return;
  }
  previewEl.hidden = false;
  const label = document.createElement('span');
  label.className = 'sug-label';
  label.textContent = `将加入 ${tags.length} 个：`;
  previewEl.append(label);
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'chip preview';
    chip.style.color = colorFor(t, colors);
    chip.textContent = t;
    previewEl.append(chip);
  }
}

async function loadFolders() {
  let tree = [];
  // 后台 service worker 冷启动时首次消息可能失败：重试一次，避免收藏位置下拉空白
  for (let i = 0; i < 2; i++) {
    try {
      const r = await send({ type: 'folders:list' });
      tree = r.tree || [];
      break;
    } catch (e) {
      if (i === 1) {
        const destRow = $('#destRow');
        if (destRow) {
          destRow.hidden = false;
          destSelect.textContent = '';
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '目录加载失败，点此重试';
          destSelect.append(opt);
          destSelect.addEventListener('change', () => loadFolders().then(refresh).catch(() => {}), { once: true });
        }
      }
    }
  }
  foldersFlat = [];
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      foldersFlat.push({ id: n.id, title: n.title, depth, total: n.total });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  destSelect.textContent = '';
  const inbox = document.createElement('option');
  inbox.value = '';
  inbox.textContent = 'TagSpace 收件箱（默认）';
  destSelect.append(inbox);
  for (const f of foldersFlat) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${'　'.repeat(f.depth)}${f.title || '(无标题)'} · ${f.total}`;
    destSelect.append(opt);
  }

  try {
    const o = await chrome.storage.local.get(DEST_KEY);
    const saved = o && o[DEST_KEY];
    if (saved && foldersFlat.some((f) => f.id === saved)) destSelect.value = saved;
  } catch {}

  destSelect.addEventListener('change', () => {
    chrome.storage.local.set({ [DEST_KEY]: destSelect.value }).catch(() => {});
  });
}

async function renderSuggest(text) {
  const box = $('#sugBox');
  const chips = $('#sugChips');
  if (!box || !chips) return;
  let items = [];
  try {
    const r = await send({ type: 'suggest:tags', url: page.url, title: page.title, text: text || '' });
    items = r.items || [];
  } catch {}
  chips.textContent = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const s of items.slice(0, 8)) {
    const b = document.createElement('button');
    b.className = 'sug-chip';
    b.textContent = s.tag;
    b.title = s.reason || '';
    b.addEventListener('click', () => {
      const cur = tagInput.value.trim();
      tagInput.value = cur ? `${cur} ${s.tag}` : s.tag;
      renderPreview();
      tagInput.focus();
    });
    chips.append(b);
  }
}

async function refresh() {
  const info = await send({ type: 'page:info', url: page.url, title: page.title });
  page.collected = info.collected;
  page.tags = info.tags;
  page.ids = info.ids || [];
  $('#pcoll').textContent = page.collected
    ? `已收藏（${page.collected} 个位置）`
    : '未收藏';
  btnCollect.hidden = page.collected > 0;
  const destRow = $('#destRow');
  if (destRow) destRow.hidden = page.collected > 0;
  $('#hint').textContent = page.collected ? '' : '先收藏，才能挂标签';
  renderTags();
}

async function addTags() {
  const tags = tagsFromInput(tagInput.value);
  if (!tags.length) {
    tagInput.focus();
    return;
  }
  try {
    if (!page.collected) {
      // 未收藏：按所选目录创建 + 打标签
      const parentId = destSelect.value || undefined;
      const r = await send({
        type: 'bookmark:create',
        url: page.url,
        title: page.title,
        parentId,
        tags,
      });
      tagInput.value = '';
      renderPreview();
      await refresh();
      toast(`已收藏到 ${r.place || '目录'}，加 ${tags.length} 个标签`);
      return;
    }
    const r = await send({ type: 'tags:add', ids: page.ids, tags });
    tagInput.value = '';
    renderPreview();
    await refresh();
    toast(`已加 ${tags.length} 个标签`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function collectOnly() {
  try {
    const r = await send({
      type: 'bookmark:create',
      url: page.url,
      title: page.title,
      parentId: destSelect.value || undefined,
      tags: tagsFromInput(tagInput.value),
    });
    tagInput.value = '';
    renderPreview();
    await refresh();
    toast(`已收藏到 ${r.place || '目录'}`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function boot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  page.url = (tab && tab.url) || '';
  page.title = (tab && tab.title) || '';

  $('#ptitle').textContent = page.title || page.url;
  $('#purl').textContent = page.url;

  try {
    const st = await send({ type: 'state' });
    colors = (st.config && st.config.colors) || {};
  } catch {}

  await loadFolders();
  await refresh();
  renderPreview();
  renderSuggest('').catch(() => {});
}

btnCollect.addEventListener('click', collectOnly);

tagInput.addEventListener('input', () => {
  renderPreview();
  clearTimeout(sugTimer);
  sugTimer = setTimeout(() => renderSuggest(tagInput.value).catch(() => {}), 180);
});

tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTags();
  }
});

$('#btnSpace').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('space/space.html') });
  window.close();
});

$('#btnPanel').addEventListener('click', async () => {
  // 原生侧边栏必须在当前这个用户手势里直接调 open()。转给后台 SW 会丢手势，
  // Chrome 会抛 "may only be called in response to a user gesture" 而退化成小窗。
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    } catch (e) {
      console.warn('[TagMyBookmarks] 本页直接开侧栏失败，交给后台兜底', e);
    }
  }
  try {
    // Vivaldi 等没有 sidePanel 宿主的浏览器走这里，后台改开独立小窗
    await send({ type: 'panel:open' });
  } catch (e) {
    toast(e.message || '打开面板失败', true);
    return;
  }
  window.close();
});

boot().catch((e) => toast(e.message, true));
