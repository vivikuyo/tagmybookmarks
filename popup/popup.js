import { colorFor } from '../lib/palette.js';
import { splitTagInput, normalizeTagOrNull } from '../lib/title.js';
import { quoteTag } from '../lib/query.js';

const $ = (s) => document.querySelector(s);
const tagInput = $('#tagInput');
const btnCollect = $('#btnCollect');
const toastEl = $('#toast');
const destPick = $('#destPick');
const destPickText = $('#destPickText');
const destPanel = $('#destPanel');
const destSearch = $('#destSearch');
const destList = $('#destList');
const previewEl = $('#tagPreview');
const tagMenuEl = $('#tagMenu');

const DEST_KEY = 'ui:dest';

let page = { url: '', title: '', collected: 0, tags: [], ids: [] };
let colors = {};
let foldersFlat = [];
let destId = '';        // 当前收藏位置：'' = TagSpace 收件箱
let destRows = [];      // 目录面板当前渲染出来的行（含收件箱）
let destIdx = -1;       // ↑↓ 高亮的下标
let destFailed = false; // 目录没取到：面板里给一行重试
let allTagList = []; // 全库标签 + 条数（标签候选）
let menuIdx = -1;    // 候选里 ↑↓ 选中的下标

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

const PATH_SEP = String.fromCharCode(31); // 与后台一致：内部目录路径分隔符

/** 目录面板能放多高：上下取更宽敞的一边，铺满剩余空间；内容放得下就不出滚动条 */
function placeDestPanel() {
  if (!destPanel || destPanel.hidden) return;
  const r = destPick.getBoundingClientRect();
  const vh = window.innerHeight || 600;
  const vw = window.innerWidth || 320;
  const w = Math.max(200, Math.floor(vw - 24));
  destPanel.style.width = `${w}px`;
  destPanel.style.left = '12px';
  destPanel.style.maxHeight = 'none';
  const natural = destPanel.getBoundingClientRect().height;
  const below = vh - (r.bottom || 0) - 8;
  const above = (r.top || 0) - 8;
  const up = above > below;
  const room = up ? above : below;
  // 放得下就整块展开，真放不下才让列表内部滚动（120px = 搜索框加两行）
  destPanel.style.maxHeight = `${Math.max(120, Math.floor(natural <= room ? natural : room))}px`;
  if (up) {
    destPanel.style.top = 'auto';
    destPanel.style.bottom = `${Math.round(vh - (r.top || 0) + 4)}px`;
  } else {
    destPanel.style.bottom = 'auto';
    destPanel.style.top = `${Math.round((r.bottom || 0) + 4)}px`;
  }
}

/** 收起态只留末两级面包屑：320px 宽放不下全路径，尾巴才是你要看的那级 */
function paintDestPick() {
  if (destFailed) {
    destPickText.textContent = '目录加载失败，点此重试';
    destPick.title = '目录加载失败，点此重试';
    return;
  }
  const f = destId ? foldersFlat.find((x) => x.id === destId) : null;
  const segs = f && f.path ? f.path.split(PATH_SEP).filter(Boolean) : [];
  destPickText.textContent = segs.length ? segs.slice(-2).join(' › ') : 'TagSpace 收件箱（默认）';
  destPick.title = segs.length ? `收藏到：${segs.join(' › ')}` : '收藏到 TagSpace 收件箱';
}

/** 命中词包成 <mark>，其余原样拼——不拼 innerHTML，目录名里带符号也不会出事 */
function markText(text, words) {
  const frag = document.createDocumentFragment();
  const head = String(text || '');
  if (!words.length || !head) {
    frag.append(head);
    return frag;
  }
  const lower = head.toLowerCase();
  const spans = [];
  for (const w of words) {
    let from = 0;
    while (from <= lower.length) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      spans.push([at, at + w.length]);
      from = at + w.length;
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push(sp.slice());
  }
  let pos = 0;
  for (const [st, ed] of merged) {
    if (st > pos) frag.append(head.slice(pos, st));
    const m = document.createElement('mark');
    m.textContent = head.slice(st, ed);
    frag.append(m);
    pos = ed;
  }
  if (pos < head.length) frag.append(head.slice(pos));
  return frag;
}

function showDestEmpty(text, retry) {
  const e = document.createElement(retry ? 'button' : 'div');
  e.className = 'dest-empty';
  e.textContent = text;
  if (retry) {
    e.type = 'button';
    e.addEventListener('click', () => loadFolders().then(() => {
      destIdx = 0;
      renderDestList();
      placeDestPanel();
    }).catch(() => {}));
  }
  destList.append(e);
}

function renderDestList() {
  const words = destSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inbox = { id: '', title: 'TagSpace 收件箱（默认）', path: '', depth: 0, total: 0, hay: 'tagspace 收件箱 默认' };
  destRows = [inbox, ...foldersFlat].filter((f) => words.every((w) => (f.hay || '').includes(w)));
  if (destIdx >= destRows.length) destIdx = destRows.length - 1;
  if (!destRows.length) destIdx = -1;

  destList.textContent = '';
  if (destFailed) {
    showDestEmpty('目录没取到', true);
    return;
  }
  if (!destRows.length) {
    showDestEmpty('没有匹配的目录');
    return;
  }
  destRows.forEach((f, i) => {
    const segs = f.path ? f.path.split(PATH_SEP).filter(Boolean) : [];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dest-item' + (f.id === destId ? ' sel' : '') + (i === destIdx ? ' on' : '');
    b.style.paddingLeft = `${6 + Math.min(f.depth || 0, 3) * 10}px`; // 缩进最多三级，全角空格缩进这套不用了
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', f.id === destId ? 'true' : 'false');

    const tick = document.createElement('span');
    tick.className = 'dest-tick';
    tick.textContent = f.id === destId ? '✓' : '';
    b.append(tick);

    if (segs.length > 1) {
      const par = document.createElement('span');
      par.className = 'dest-parent';
      par.append(markText(`${segs.slice(0, -1).slice(-2).join(' › ')} ›`, words));
      b.append(par);
    }
    const name = document.createElement('span');
    name.className = 'dest-name';
    name.append(markText(segs.length ? segs[segs.length - 1] : f.title, words));
    b.append(name);

    if (f.total > 0) {
      const c = document.createElement('span');
      c.className = 'dest-cnt';
      c.textContent = String(f.total);
      b.append(c);
    }
    b.addEventListener('click', () => pickDest(f.id));
    destList.append(b);
  });
  const cur = destList.children[destIdx];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function openDest() {
  if (!destPanel) return;
  destSearch.value = '';
  destIdx = destFailed || !foldersFlat.length ? -1 : 0;
  renderDestList();
  destPanel.hidden = false;
  destPick.setAttribute('aria-expanded', 'true');
  placeDestPanel();
  destSearch.focus();
  destSearch.select();
}

function closeDest() {
  if (!destPanel || destPanel.hidden) return;
  destPanel.hidden = true;
  destPick.setAttribute('aria-expanded', 'false');
}

function pickDest(id) {
  destId = id || '';
  chrome.storage.local.set({ [DEST_KEY]: destId }).catch(() => {});
  paintDestPick();
  closeDest();
  destPick.focus();
}

function moveDest(delta) {
  if (!destRows.length) return;
  destIdx = destIdx < 0 ? 0 : Math.min(destRows.length - 1, Math.max(0, destIdx + delta));
  renderDestList();
  placeDestPanel();
}

async function loadFolders() {
  let tree = [];
  // 后台 service worker 冷启动时首次消息可能失败：重试一次，避免目录面板空白
  for (let i = 0; i < 2; i++) {
    try {
      const r = await send({ type: 'folders:list' });
      tree = r.tree || [];
      destFailed = false;
      break;
    } catch (e) {
      if (i === 1) {
        destFailed = true;
        foldersFlat = [];
      }
    }
  }

  if (!destFailed) {
    foldersFlat = [];
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        const segs = n.path ? n.path.split(PATH_SEP).filter(Boolean) : [];
        foldersFlat.push({
          id: n.id,
          title: n.title || '',
          path: n.path || '',
          depth,
          total: n.total,
          hay: `${segs.join(' / ')} ${n.title || ''}`.toLowerCase(), // 名字、整条路径都能搜到
        });
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    try {
      const o = await chrome.storage.local.get(DEST_KEY);
      const saved = String((o && o[DEST_KEY]) || '');
      destId = saved && foldersFlat.some((f) => f.id === saved) ? saved : '';
    } catch {}
  }
  paintDestPick();
}

// ---------------------------------------------------------------- 标签候选
// 与侧边栏批量打标签同款：全库标签按输入框里最后一个词过滤；本页已有的、已经填进去的不重复出现

function menuNeedle() {
  const m = /([^\s,]+)$/.exec(tagInput.value || '');
  return m ? m[1].replace(/"/g, '').toLowerCase() : '';
}

function renderTagMenu() {
  try {
    paintTagMenu();
  } finally {
    fitTagMenu(); // 内容变了高度就变：每次重画后重新按剩余空间定高
  }
}

/**
 * 候选框能放多高：Chrome 工具栏弹窗最高 600px，减去候选框上方的页面信息、
 * 下方的预览/「收藏到」/底栏，剩下的都给候选框。放得下就整列展开，不出滚动条。
 */
function fitTagMenu() {
  if (!tagMenuEl || tagMenuEl.hidden) return;
  const POPUP_MAX = 600;
  let belowH = 0;
  for (let el = tagMenuEl.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.id === 'toast' || el.hidden) continue; // toast 是浮层，不占高度
    belowH += el.getBoundingClientRect().height;
  }
  const top = tagMenuEl.getBoundingClientRect().top;
  const avail = POPUP_MAX - 6 - top - belowH - 8; // 8 = 候选框的下外边距
  tagMenuEl.style.maxHeight = `${Math.max(60, Math.floor(avail))}px`;
}

function paintTagMenu() {
  if (!tagMenuEl || tagMenuEl.hidden) return;
  const needle = menuNeedle();
  const skip = new Set([...page.tags, ...tagsFromInput(tagInput.value)].map((t) => t.toLowerCase()));
  const shown = allTagList.filter((t) => {
    const k = String(t.tag).toLowerCase();
    return !skip.has(k) && (!needle || k.includes(needle));
  });
  tagMenuEl.textContent = '';
  menuIdx = -1;
  if (!shown.length) {
    const p = document.createElement('div');
    p.className = 'tm-empty';
    p.textContent = needle ? '没有匹配的标签' : '还没有标签';
    tagMenuEl.append(p);
    return;
  }
  for (const t of shown) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tm-tag';
    b.style.color = colorFor(t.tag, colors);
    b.title = `${t.tag} · ${t.count} 条`;
    const name = document.createElement('span');
    name.textContent = t.tag;
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = t.count;
    b.append(name, c);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 别让输入框先失焦，否则候选跟着关
    b.addEventListener('click', () => insertMenuTag(t.tag));
    tagMenuEl.append(b);
  }
}

function openTagMenu() {
  if (!tagMenuEl) return;
  tagMenuEl.hidden = false;
  renderTagMenu();
}

function closeTagMenu() {
  if (!tagMenuEl) return;
  tagMenuEl.hidden = true;
  menuIdx = -1;
}

function menuRows() {
  return [...tagMenuEl.querySelectorAll('.tm-tag')];
}

function moveMenu(delta) {
  const rows = menuRows();
  if (!rows.length) return;
  menuIdx = (menuIdx + delta + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('active', i === menuIdx));
  rows[menuIdx].scrollIntoView({ block: 'nearest' });
}

/** 选中一个候选：替换正在输入的那个词，接在后面；框不关，可以连着选 */
function insertMenuTag(tag) {
  const cur = tagInput.value || '';
  const m = /([^\s,]*)$/.exec(cur);
  const head = m ? cur.slice(0, m.index) : cur;
  const sep = head && !/[\s,]$/.test(head) ? ' ' : '';
  tagInput.value = head + sep + quoteTag(tag) + ' ';
  renderPreview();
  tagInput.focus();
  renderTagMenu();
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
  renderTagMenu(); // 本页标签变了，候选里的"已有标签"要跟着更新
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
      const parentId = destId || undefined;
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
      parentId: destId || undefined,
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
    allTagList = st.tags || [];
  } catch {}

  await loadFolders();
  await refresh();
  renderPreview();
}

btnCollect.addEventListener('click', collectOnly);

if (destPick) {
  destPick.addEventListener('click', () => {
    if (destPanel.hidden) openDest();
    else closeDest();
  });
  destPick.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openDest();
    }
  });
  // 面板内按下不抢焦点：否则搜索框一失焦、列表跟着塌，这一下就点空了
  destPanel.addEventListener('mousedown', (e) => e.preventDefault());
  destSearch.addEventListener('input', () => {
    destIdx = 0;
    renderDestList();
    placeDestPanel();
  });
  destSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveDest(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const f = destRows[destIdx] || destRows[0];
      if (f) pickDest(f.id);
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation(); // 只收目录面板，不连弹窗一起关
      closeDest();
      destPick.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (destPanel.hidden) return;
    const t = e.target;
    if (destPanel.contains(t) || destPick.contains(t)) return;
    closeDest();
  });
  window.addEventListener('resize', () => placeDestPanel());
}


tagInput.addEventListener('input', () => {
  renderPreview();
  renderTagMenu();
});

if (tagMenuEl) {
  tagInput.addEventListener('focus', openTagMenu);
  tagMenuEl.addEventListener('mousedown', (e) => e.preventDefault());
  tagInput.addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    // 焦点落到按钮/下拉框时不在这里收：等 click 再收。候选是随内容排布的，
    // 按下和松开之间就收起会让下方控件上移，这一下就点空了
    if (a && (a.tagName === 'BUTTON' || a.tagName === 'SELECT' || a.tagName === 'INPUT')) return;
    closeTagMenu();
  }, 120));
  document.addEventListener('click', (e) => {
    if (tagMenuEl.hidden) return;
    const t = e.target;
    if (t === tagInput || (t.closest && t.closest('#tagMenu'))) return;
    closeTagMenu();
  });
}

tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (tagMenuEl && !tagMenuEl.hidden) {
      e.preventDefault();
      moveMenu(e.key === 'ArrowDown' ? 1 : -1);
    }
    return;
  }
  if (e.key === 'Escape' && tagMenuEl && !tagMenuEl.hidden) {
    e.stopPropagation(); // 先收候选，不关弹窗
    closeTagMenu();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const rows = menuRows();
    if (rows.length && menuIdx >= 0) {
      insertMenuTag(rows[menuIdx].querySelector('span').textContent);
      return;
    }
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
