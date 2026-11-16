// 书签视图：给书签打标签、批量整理（标签管理页的第三个视图）
// 一个 URL 一行；多位置时只显示第一个位置，右下角标注 ×N
import { colorFor } from '../lib/palette.js';
import { splitTagInput, normalizeTagOrNull } from '../lib/title.js';

const $ = (sel) => document.querySelector(sel);
const PAGE = 200;

let st = {
  items: [],
  total: 0,
  offset: 0,
  filter: 'all',
  text: '',
  query: '', // #标签 @目录 ?关键词 查询（与侧边栏同一套语法）
  sort: 'title', // 'title' 按标题 | 'tree' 按目录（书签树序）
  folderId: '',
  counts: { all: 0, untagged: 0, tagged: 0 },
  hiddenRows: 0, // 按目录显示时被折叠隐藏的书签数（只影响显示，不影响筛选/全选）
};
let selected = new Set();
let colors = {};
let foldersFlat = [];
let folderTree = []; // folders:list 的原始树（下拉浮层用）
let idToPath = new Map(); // 目录 id → 路径
let pathToId = new Map(); // 路径 → 目录 id（分组折叠定位用）
let rootIds = new Set(); // 三个根：永远视为展开
let dirOpen = new Set(); // 已展开的目录 id（存本机，按目录树用）
// 树模式（按目录）：整棵树 + 每个展开目录的直属书签懒加载
const DIR_FETCH_LIMIT = 500; // 后台单目录取书签的上限（超过会截断并提示）
let treeCache = { query: '', filter: 'all', text: '', rows: new Map() }; // folderId -> {rows, total}
let dirLoading = new Set();
let visibleRowIds = new Set(); // 树模式当前实际渲染出来的书签（「全选可见」用）
let clip = null; // 剪贴板 {mode:'copy'|'cut', bookmarks:[id], folders:[id]}
let autoOpen = new Set(); // 查询期间自动展开的目录 id（筛中书签所在目录+祖先），不持久化
let autoCollapsed = new Set(); // 用户在自动展开后手动收起的目录（本次查询内保持收起）
let trashOpen = false;
let cloudTags = []; // [{tag,count}] 全量标签
let cloudDirs = []; // [{tag,count}] 目录标签（文件夹投影）
let pendingDelete = null; // 回收站设置完成后再删这批
let undoExpanded = false;
let editor = null; // { row, id, key, input, box }
let sugTimer = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r) throw new Error('后台无响应，试着重载扩展');
    if (r.error) throw new Error(r.error);
    return r;
  });
}

function toast(text, isErr = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function tagList(input) {
  return splitTagInput(input)
    .map(normalizeTagOrNull)
    .filter(Boolean);
}

// ---------------------------------------------------------------- 目录

async function loadFolders() {
  let tree = [];
  try {
    const r = await send({ type: 'folders:list' });
    tree = r.tree || [];
  } catch {}
  folderTree = tree;
  foldersFlat = [];
  idToPath = new Map();
  pathToId = new Map();
  rootIds = new Set();
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      foldersFlat.push({ id: n.id, path: n.path, title: n.title, depth, total: n.total });
      idToPath.set(n.id, n.path);
      pathToId.set(n.path, n.id);
      if (depth === 0) rootIds.add(n.id);
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
}

// ---------------------------------------------------------------- 目录折叠（下拉树 + 按目录分组共用）

/** 根永远展开；查询期间筛中书签所在目录自动展开；手动收起优先于自动展开 */
function dirIsOpen(id) {
  if (!id || rootIds.has(id)) return true;
  if (autoCollapsed.has(id)) return false;
  return dirOpen.has(id) || autoOpen.has(id);
}

/** 有查询时：筛中书签所在目录（及其祖先链）自动展开；查询变了重算 */
function updateAutoOpen(matchPaths) {
  if (!st.query) {
    autoOpen = new Set();
    autoCollapsed = new Set();
    return;
  }
  const next = new Set();
  for (const path of matchPaths) {
    const segs = path.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const id = pathToId.get(segs.slice(0, i + 1).join('/'));
      if (id && !rootIds.has(id)) next.add(id);
    }
  }
  autoOpen = next;
  autoCollapsed = new Set();
}

/** 展开状态变了：存本机 + 两个出口都重画（浮层由调用方重画，这里管列表） */
function toggleDir(id) {
  if (dirOpen.has(id)) {
    dirOpen.delete(id);
  } else if (autoOpen.has(id) && !autoCollapsed.has(id)) {
    autoCollapsed.add(id); // 自动展开的目录被手动收起：本次查询内保持收起
  } else if (autoCollapsed.has(id)) {
    autoCollapsed.delete(id); // 再点一次 = 恢复自动展开
  } else {
    dirOpen.add(id);
  }
  chrome.storage.local.set({ 'bm.dirOpen': [...dirOpen] });
  if (st.sort === 'tree') render();
}

// ---------------------------------------------------------------- 数据

async function refresh() {
  if (st.sort === 'tree') {
    st.offset = 0; // 树模式无分页
    invalidateTree();
    dirtyTree(); // 书签/文件夹增删改后立即生效（查询词没变时 invalidateTree 不会清行缓存）
    // 目录树可能刚被删/剪/新建过，重拉 folders:list，别用内存里的旧树
    await loadFolders();
    // 正在下钻的目录若已被删掉，退回全部目录
    if (st.folderId && !idToPath.get(st.folderId)) {
      st.folderId = '';
      st.offset = 0;
    }
  }
  const r = await send({
    type: 'bookmarks:page',
    offset: st.offset,
    limit: PAGE,
    filter: st.filter,
    text: st.text,
    query: st.query,
    folderId: st.folderId,
    sort: st.sort,
  });
  st.items = r.items || [];
  st.total = r.total || 0;
  st.counts = r.counts || st.counts;
  st.related = r.related || [];
  st.relatedDirs = r.relatedDirs || [];
  if (st.sort === 'tree') updateAutoOpen(r.matchPaths || []);
  render();
  refreshUndo().catch(() => {});
  loadCloud().catch(() => {});
}

function render() {
  const rows = $('#bmRows');
  if (!rows) return;
  rows.textContent = '';

  renderCrumb();
  renderSummary();

  const tree = st.sort === 'tree';
  const pos = $('#bmPos');
  if (pos) {
    pos.hidden = tree;
    pos.textContent = tree ? '' : (st.total ? `${st.offset + 1}–${Math.min(st.offset + PAGE, st.total)} / ${st.total}` : '没有匹配的书签');
  }
  $('#bmPrev').hidden = tree;
  $('#bmNext').hidden = tree;
  $('#bmPrev').disabled = st.offset <= 0;
  $('#bmNext').disabled = st.offset + PAGE >= st.total;

  if (!st.items.length && st.sort !== 'tree') {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = st.query || st.text || st.folderId || st.filter !== 'all'
      ? '当前条件下没有书签。'
      : '索引里还没有书签。';
    rows.append(p);
    renderBulk();
    return;
  }

  if (st.sort === 'tree') {
    // 真目录树（方案 B）：整棵树渲染，文件夹行可展开；
    // 展开的目录懒加载直属书签（受查询/快筛约束）；无分页，每目录「显示更多」。
    st.hiddenRows = 0;
    renderTreeMode(rows);
  } else {
    st.hiddenRows = 0;
    for (const row of st.items) rows.append(renderRow(row));
  }
  renderBulk();
}

/** 树模式：根常展开，其余按 dirOpen；下钻时只渲染那棵子树 */
function renderTreeMode(container) {
  visibleRowIds = new Set();
  const drillNode = st.folderId ? findFolderNode(folderTree, st.folderId) : null;
  if (st.folderId && !drillNode) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '目录不存在或已被排除，点面包屑「所有目录」返回。';
    container.append(p);
    return;
  }
  const walk = (nodes, parentOpen, depth) => {
    for (const n of nodes || []) {
      if (!parentOpen) continue; // 上级收起：整枝不渲染（书签管理器语义）
      const open = dirIsOpen(n.id);
      container.append(renderFolderRow(n, open, depth === 0));
      if (open) {
        walk(n.children, true, depth + 1); // 文件夹靠前
        appendDirRows(container, n, depth); // 直属书签在后
      }
    }
  };
  if (drillNode) {
    // 下钻 = 只看这棵子树；自身视为展开
    if (!dirOpen.has(drillNode.id)) {
      dirOpen.add(drillNode.id);
      chrome.storage.local.set({ 'bm.dirOpen': [...dirOpen] });
    }
    container.append(renderFolderRow(drillNode, true, 0));
    walk(drillNode.children, true, 1);
    appendDirRows(container, drillNode, 0);
  } else {
    walk(folderTree, true, 0);
  }
}

function findFolderNode(nodes, id) {
  for (const n of nodes || []) {
    if (String(n.id) === String(id)) return n;
    const hit = findFolderNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 文件夹行：箭头=展开/收起，名字=下钻只看这棵子树 */
function renderFolderRow(node, open, isRoot) {
  const div = document.createElement('div');
  // 展开状态（▾）整行橙色标出：手动展开和查询自动展开都算
  const isCur = dirIsOpen(node.id);
  div.className = 'bm-group bm-folder-row' + (isCur ? ' cur' : '') + (selected.has(node.id) ? ' on' : '');
  // 文件夹也有复选框：复制/剪切/粘贴的对象可以是文件夹
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'bm-cb';
  cb.checked = selected.has(node.id);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => setSelected(node.id, cb.checked, div, cb));
  div.append(cb);
  if (!isRoot) {
    const arrow = document.createElement('button');
    arrow.className = 'bm-group-arrow';
    const expandable = (node.children || []).length > 0 || node.count > 0;
    if (expandable) {
      // 叶子文件夹（没有子文件夹但有直属书签）也能展开/收起——不能只看 children
      arrow.textContent = open ? '▾' : '▸';
      arrow.title = open ? '收起' : '展开';
      arrow.addEventListener('click', () => toggleDir(node.id));
    }
    div.append(arrow);
  }
  const name = document.createElement('button');
  name.className = 'bm-group-name';
  name.style.paddingLeft = `${Math.min(node.depth, 6) * 14}px`;
  name.textContent = node.title || '(无标题)';
  name.title = `${node.path} · 直属 ${node.count} · 全部 ${node.total} · 点击只看这个目录`;
  name.addEventListener('click', () => {
    st.folderId = node.id;
    st.offset = 0;
    clearSelectionOnFilterChange();
    refresh().catch((x) => toast(x.message, true));
  });
  div.append(name);
  const cnt = document.createElement('span');
  cnt.className = 'bm-group-count';
  cnt.textContent = open ? `${node.count} 直属 · ${node.total} 全部` : `${node.total} 条（已折叠）`;
  div.append(cnt);
  return div;
}

/** 展开目录的直属书签：懒加载 + 每目录分批显示 */
function appendDirRows(container, node, depth) {
  const hit = treeCache.rows.get(String(node.id));
  if (!hit) {
    loadDirRows(node.id);
    const p = document.createElement('p');
    p.className = 'hint bm-dirrows';
    p.style.paddingLeft = `${(depth + 1) * 12}px`;
    p.textContent = '载入中…';
    container.append(p);
    return;
  }
  const box = document.createElement('div');
  box.className = 'bm-dirrows';
  box.style.paddingLeft = `${(depth + 1) * 12}px`;
  for (const row of hit.rows) {
    box.append(renderRow(row));
    visibleRowIds.add(row.id);
  }
  if (!hit.rows.length) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = node.count ? '（直属书签都不匹配当前查询/搜索）' : '（没有直属书签）';
    box.append(p);
  } else if (hit.total > hit.rows.length) {
    // 后台单次最多取 500 条：极少数直属书签过多的目录会截断，明说而不是悄悄少
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = `直属书签共 ${hit.total} 条，超过 ${DIR_FETCH_LIMIT}，仅显示前 ${hit.rows.length} 条。`;
    box.append(p);
  }
  container.append(box);
}

async function loadDirRows(folderId) {
  const key = String(folderId);
  if (dirLoading.has(key)) return;
  dirLoading.add(key);
  try {
    const r = await send({
      type: 'bookmarks:page',
      folderId: key,
      query: st.query,
      filter: st.filter,
      text: st.text,
      sort: 'tree',
      limit: 500,
      offset: 0,
    });
    treeCache.rows.set(key, { rows: r.items || [], total: r.total || 0 });
  } catch (e) {
    toast(e.message, true);
  } finally {
    dirLoading.delete(key);
    render();
  }
}

/** 数据变了（增删改书签/文件夹）就整份作废树缓存；查询词变化走 invalidateTree */
function dirtyTree() {
  treeCache.rows.clear();
  dirLoading.clear();
}

/** 条件变了就作废缓存（refresh 在每次改动/查询后都会跑） */
function invalidateTree() {
  if (treeCache.query === st.query && treeCache.filter === st.filter && treeCache.text === st.text) return;
  treeCache = { query: st.query, filter: st.filter, text: st.text, rows: new Map() };
  dirLoading.clear();
}

/** 下钻后的面包屑：所有目录 / 书签栏 / AI ✕，点任何一级跳回 */
function renderCrumb() {
  const el = $('#bmCrumb');
  if (!el) return;
  if (!st.folderId) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = '';
  const path = idToPath.get(st.folderId) || '';
  const segs = path.split('/').filter(Boolean);

  const jump = (targetPath) => {
    st.folderId = targetPath ? pathToId.get(targetPath) || '' : '';
    st.offset = 0;
    clearSelectionOnFilterChange();
    refresh().catch((x) => toast(x.message, true));
  };
  const seg = (label, targetPath, on) => {
    const b = document.createElement('button');
    b.className = 'bm-crumb-seg' + (on ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => jump(targetPath));
    return b;
  };
  const sep = () => {
    const sp = document.createElement('span');
    sp.className = 'bm-crumb-sep';
    sp.textContent = '/';
    return sp;
  };
  el.append(seg('所有目录', '', false), sep());
  segs.forEach((sg, i) => {
    el.append(seg(sg, segs.slice(0, i + 1).join('/'), i === segs.length - 1));
    if (i < segs.length - 1) el.append(sep());
  });
  const x = document.createElement('button');
  x.className = 'bm-crumb-x';
  x.textContent = '✕';
  x.title = '回到所有目录';
  x.addEventListener('click', () => jump(''));
  el.append(x);
}

function setSelected(id, on, line, cb) {
  if (on) selected.add(id);
  else selected.delete(id);
  if (cb) cb.checked = on;
  if (line) line.classList.toggle('on', on);
  renderBulk();
}

function renderRow(row) {
  const line = document.createElement('div');
  line.className = 'bm-row' + (selected.has(row.id) ? ' on' : '');
  line.dataset.id = row.id;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'bm-cb';
  cb.checked = selected.has(row.id);
  cb.addEventListener('change', () => setSelected(row.id, cb.checked, line, cb));

  // 整行可点：只挡真正的交互件（复选框、标题链接、chip、推荐、徽标），
  // 标题右侧、标签行缝隙等空白区都能勾选（与侧边栏一致）
  line.addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, .chip, .x, .bm-badge, .bm-sug')) return;
    if (String(window.getSelection())) return; // 选文字时不误触
    setSelected(row.id, !selected.has(row.id), line, cb);
  });

  // 标题 + 网址
  const main = document.createElement('div');
  main.className = 'bm-main';
  const t = document.createElement('a');
  t.className = 'bm-title';
  t.href = '#';
  t.textContent = row.title || row.url;
  t.title = row.title || row.url;
  t.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: row.url });
  });
  const u = document.createElement('div');
  u.className = 'bm-url';
  u.textContent = row.url;
  main.append(t, u);
  if (row.locations > 1) {
    const badge = document.createElement('span');
    badge.className = 'bm-badge';
    badge.textContent = `×${row.locations}`;
    badge.title = `这个网址有 ${row.locations} 个位置，标签按网址共享`;
    main.append(badge);
  }

  // 标签
  const tags = document.createElement('div');
  tags.className = 'bm-tags';
  renderTagChips(tags, row);

  // 目录
  const path = document.createElement('div');
  path.className = 'bm-path';
  path.textContent = (row.path || '').split('/').slice(-1)[0] || '';
  path.title = row.path || '';

  line.append(cb, main, tags, path);
  return line;
}

function renderTagChips(box, row) {
  box.textContent = '';
  for (const tag of row.tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.color = colorFor(tag, colors);
    const name = document.createElement('span');
    name.textContent = tag;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = `摘掉 #${tag}（同一网址的所有位置一起）`;
    x.addEventListener('click', async () => {
      try {
        await send({ type: 'tags:remove', ids: [row.id], tags: [tag] });
        await refresh();
        toast(`已摘掉 #${tag}`);
      } catch (e) {
        toast(e.message, true);
      }
    });
    chip.append(name, x);
    box.append(chip);
  }

  const add = document.createElement('button');
  add.className = 'chip-add';
  add.textContent = row.tags.length ? '＋' : '＋ 加标签';
  add.title = '给这条书签加标签';
  add.addEventListener('click', () => openEditor(box, row));
  box.append(add);
}

// ---------------------------------------------------------------- 行内加标签

function closeEditor() {
  if (!editor) return;
  editor.input.remove();
  editor.box.remove();
  editor = null;
}

function openEditor(box, row) {
  closeEditor();
  const input = document.createElement('input');
  input.className = 'bm-tag-input';
  input.placeholder = '标签，空格分开；带空格用引号';
  const tip = document.createElement('div');
  tip.className = 'bm-tip';
  tip.textContent = '空格/逗号分隔多个；"Chrome 扩展" 用引号包住算一个';
  const sug = document.createElement('div');
  sug.className = 'bm-sug';

  box.append(input);
  box.append(tip);
  box.append(sug);
  input.focus();

  editor = { row, input, box, sug };

  input.addEventListener('input', () => {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(() => fillSuggest(row, input.value), 180);
  });
  fillSuggest(row, '');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    // 点到推荐 chip 时不要立刻关掉
    if (editor && !document.activeElement?.closest('.bm-sug-item')) closeEditor();
  }, 120));

  function commitEditor() {
    const tags = tagList(input.value);
    if (!tags.length) { closeEditor(); return; }
    send({ type: 'tags:add', ids: [row.id], tags })
      .then(async () => {
        closeEditor();
        await refresh();
        toast(`已加 ${tags.length} 个标签`);
      })
      .catch((e) => toast(e.message, true));
  }
}

async function fillSuggest(row, text) {
  if (!editor) return;
  let list = [];
  try {
    const r = await send({ type: 'suggest:tags', url: row.url, title: row.title, text });
    list = (r.items || []).filter((s) => !row.tags.some((t) => t.toLowerCase() === s.tag.toLowerCase()));
  } catch {}
  const sug = editor.sug;
  sug.textContent = '';
  if (!list.length) return;
  const label = document.createElement('span');
  label.className = 'bm-sug-label';
  label.textContent = '推荐';
  sug.append(label);
  for (const s of list.slice(0, 8)) {
    const b = document.createElement('button');
    b.className = 'bm-sug-item';
    b.textContent = s.tag;
    b.title = s.reason || '';
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cur = editor.input.value.trim();
      editor.input.value = cur ? `${cur} ${s.tag}` : s.tag;
      editor.input.focus();
      fillSuggest(row, editor.input.value);
    });
    sug.append(b);
  }
}

// ---------------------------------------------------------------- 批量

// 条件变了就清空：两个页面统一的策略
function clearSelectionOnFilterChange() {
  if (!selected.size) return;
  selected.clear();
  toast('筛选条件已变，已清空选择');
}

const BOOKMARKS_BAR_ID = '1';

/** 选中集合拆成书签/文件夹两类（foldersFlat 里有的是文件夹） */
function splitSelection() {
  const dirSet = new Set(foldersFlat.map((f) => f.id));
  const bmIds = [];
  const dirIds = [];
  for (const id of selected) (dirSet.has(id) ? dirIds : bmIds).push(id);
  return { bmIds, dirIds };
}

// 统计放在右端（右对齐，只向左生长），不会把左侧按钮横向推走
function renderSummary() {
  const sum = $('#bmSummary');
  if (!sum) return;
  const c = st.counts;
  const from = st.total ? st.offset + 1 : 0;
  const to = Math.min(st.offset + PAGE, st.total);
  let text;
  if (st.sort === 'tree') {
    text = `全部 ${c.all} · 未打标签 ${c.untagged} · 已打标签 ${c.tagged} ｜ 已显示 ${visibleRowIds.size} 条`;
  } else {
    text = `${st.total} 条 · 显示 ${from}–${to} ｜ 全部 ${c.all} · 未打标签 ${c.untagged} · 已打标签 ${c.tagged}`;
  }
  if (selected.size) text += ` ｜ 已选 ${selected.size} 条`;
  sum.textContent = text;
}

function renderBulk() {
  const bar = $('#bmBulk');
  if (!bar) return;
  bar.hidden = false; // 常驻：不再因为出现/消失把表格顶下去
  renderSummary();

  const allBtn = $('#bmAllMatch');
  if (allBtn) {
    allBtn.textContent = `全选全部（${st.total} 条）`;
    allBtn.title = '选中当前筛选下的全部书签（跨页）';
    allBtn.disabled = st.total === 0;
  }
  const pageBtn = $('#bmAllPage');
  if (pageBtn) {
    const tree = st.sort === 'tree';
    pageBtn.textContent = tree ? '全选可见' : '全选本页';
    pageBtn.disabled = tree ? visibleRowIds.size === 0 : st.items.length === 0;
    pageBtn.title = tree ? `选中当前显示的 ${visibleRowIds.size} 条（展开着的目录里的）` : `选中本页 ${st.items.length} 条`;
  }

  // 未选中时按钮变灰而不是消失：位置固定，鼠标不用追着按钮跑
  const needSel = selected.size > 0;
  for (const id of ['#bmAdd', '#bmRemove', '#bmDelete', '#bmClearSel', '#bmCopy', '#bmCut']) {
    const el = $(id);
    if (el) el.disabled = !needSel;
  }
  const tree = st.sort === 'tree';
  const nf = $('#bmNewFolder');
  if (nf) nf.disabled = !tree;
  const paste = $('#bmPaste');
  if (paste) paste.disabled = !(tree && clip);
}

async function bulkTag(kind) {
  const tags = tagList($('#bmTags').value);
  if (!tags.length) { toast('先填标签', true); return; }
  if (!selected.size) return;
  try {
    const r = await send({ type: kind === 'add' ? 'tags:add' : 'tags:remove', ids: [...selected], tags });
    $('#bmTags').value = '';
    selected.clear();
    await refresh();
    toast(`${kind === 'add' ? '已加' : '已摘'} ${tags.length} 个标签 · 影响 ${r.keys || 0} 个网址`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- 绑定

function bind() {
  // 书签搜索框：只搜标题/网址（与标签查询正交，两框叠加生效）
  let textTyping = null;
  $('#bmTextSearch').addEventListener('input', (e) => {
    clearTimeout(textTyping);
    textTyping = setTimeout(() => {
      st.text = e.target.value.trim();
      st.offset = 0;
      clearSelectionOnFilterChange();
      refresh().catch((x) => toast(x.message, true));
    }, 160);
  });

  // 纯查询框（与侧边栏同一套语义）：裸名=标签∪同名目录，#只标签，@只目录，?全文。
  // 不再搜书签标题/网址——全文搜请用 ?词。
  let typing = null;
  $('#bmSearch').addEventListener('input', (e) => {
    updateSug();
    clearTimeout(typing);
    typing = setTimeout(() => {
      st.query = e.target.value.trim();
      st.offset = 0;
      clearSelectionOnFilterChange();
      refresh().catch((x) => toast(x.message, true));
      renderCloud(); // 打字即时收窄云（needle 过滤），不等后台
    }, 160);
  });
  // 查询框自动补全（与侧边栏同款）：候选=标签∪目录，↑↓选、Enter/Tab 采纳、Esc 先关补全
  const sugEl = $('#bmSuggest');
  let sugIdx = -1;

  const sugPool = () => {
    const map = new Map();
    const add = (t, kind) => {
      const k = t.tag.toLowerCase();
      const row = map.get(k) || { tag: t.tag, count: 0, kinds: [] };
      row.count = Math.max(row.count, t.count);
      if (!row.kinds.includes(kind)) row.kinds.push(kind);
      map.set(k, row);
    };
    for (const t of cloudTags) add(t, 'tag');
    for (const d of cloudDirs || fullDirs) {
      if (/\s/.test(d.tag)) continue; // 目录名含空格写不进 @查询，不进补全
      add(d, 'dir');
    }
    return [...map.values()];
  };

  const sugToken = () => {
    const m = /([^\s,+\-|&()!~?]+)$/.exec($('#bmSearch').value);
    return m ? { token: m[1], start: m.index } : null;
  };

  const updateSug = () => {
    const cur = sugToken();
    if (!cur) { sugEl.hidden = true; return; }
    const dirIntent = cur.token.startsWith('@');
    const tagIntent = cur.token.startsWith('#');
    const needle = (dirIntent || tagIntent ? cur.token.slice(1) : cur.token).toLowerCase();
    if (!needle) { sugEl.hidden = true; return; }
    const hits = sugPool()
      .filter((p) => p.tag.toLowerCase().includes(needle) && p.tag.toLowerCase() !== needle)
      .filter((p) => (dirIntent ? p.kinds.includes('dir') : true))
      .filter((p) => (tagIntent ? p.kinds.includes('tag') : true))
      .sort((a, b) => {
        const ap = a.tag.toLowerCase().startsWith(needle);
        const bp = b.tag.toLowerCase().startsWith(needle);
        if (ap !== bp) return ap ? -1 : 1;
        return b.count - a.count;
      })
      .slice(0, 8);
    if (!hits.length) { sugEl.hidden = true; return; }
    sugIdx = -1;
    sugEl.textContent = '';
    for (const t of hits) {
      const row = document.createElement('div');
      row.className = 'suggest-item';
      row.dataset.tag = t.tag;
      row.dataset.kind = dirIntent ? 'dir' : tagIntent ? 'tagOnly' : (t.kinds.length > 1 ? 'both' : t.kinds[0]);
      row.title = t.kinds.length > 1 ? '同名标签与目录，一并命中' : (t.kinds[0] === 'dir' ? '目录' : '标签');
      const name = document.createElement('span');
      name.textContent = t.tag;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = t.count;
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = row.dataset.kind === 'dir' ? '目录' : '标签';
      row.append(name, n, k);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertSug(t.tag, cur.start, row.dataset.kind);
      });
      sugEl.append(row);
    }
    sugEl.hidden = false;
  };

  const moveSug = (delta) => {
    const rows = [...sugEl.querySelectorAll('.suggest-item')];
    if (!rows.length) return;
    sugIdx = (sugIdx + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('active', i === sugIdx));
  };

  const acceptSug = () => {
    const rows = [...sugEl.querySelectorAll('.suggest-item')];
    if (!rows.length) return;
    const idx = sugIdx < 0 ? 0 : sugIdx;
    const cur = sugToken();
    insertSug(rows[idx].dataset.tag, cur ? cur.start : $('#bmSearch').value.length, rows[idx].dataset.kind);
  };

  function insertSug(tag, start, kind = 'both') {
    // 目录 @名；普通标签裸名（带空格用引号包住），与云区 chip 插入同一条路
    const val = kind === 'dir' ? `@${tag}` : cloudToken(tag, false);
    const input = $('#bmSearch');
    input.value = input.value.slice(0, start) + val + ' ';
    sugEl.hidden = true;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  $('#bmSearch').addEventListener('blur', () => setTimeout(() => (sugEl.hidden = true), 120));
  $('#bmSearch').addEventListener('keydown', (e) => {
    if (!sugEl.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSug(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSug(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSug(); return; }
      if (e.key === 'Escape') { sugEl.hidden = true; return; }
    }
    if (e.key !== 'Escape') return;
    const v = $('#bmSearch').value.trim();
    if (!v) return;
    // Esc = 逐词回退（与侧边栏同一套正则）
    const cut = v.replace(/\s*(?:[,+&|]|-(?=\s|$))?\s*[^\s,+\-|&()!~?]+$/, '').trim();
    const nv = cut.replace(/[,+&|]$/, '').trim();
    const input = $('#bmSearch');
    input.value = nv;
    input.closest('.search').classList.toggle('has', !!nv);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  $('#bmFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-f]');
    if (!btn) return;
    st.filter = btn.dataset.f;
    st.offset = 0;
    clearSelectionOnFilterChange();
    $('#bmFilters').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    refresh().catch((x) => toast(x.message, true));
  });

  $('#bmPrev').addEventListener('click', () => {
    st.offset = Math.max(0, st.offset - PAGE);
    refresh().catch((x) => toast(x.message, true));
  });
  $('#bmNext').addEventListener('click', () => {
    st.offset += PAGE;
    refresh().catch((x) => toast(x.message, true));
  });

  $('#bmAllPage').addEventListener('click', () => {
    const ids = st.sort === 'tree' ? [...visibleRowIds] : st.items.map((x) => x.id);
    for (const id of ids) selected.add(id);
    render();
  });

  $('#bmAllMatch').addEventListener('click', async () => {
    try {
      const r = await send({
        type: 'bookmarks:ids',
        filter: st.filter,
        text: st.text,
        query: st.query,
        folderId: st.folderId,
        subtree: st.sort === 'tree', // 树模式下钻 = 整棵子树
      });
      for (const id of r.ids || []) selected.add(id);
      render();
      toast(`已选中全部 ${r.total} 条`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#bmAdd').addEventListener('click', () => bulkTag('add'));
  $('#bmRemove').addEventListener('click', () => bulkTag('remove'));
  $('#bmClearSel').addEventListener('click', () => {
    selected.clear();
    render();
  });

  // ---------------------------------------------------------------- 剪贴板

  $('#bmCopy').addEventListener('click', () => {
    if (!selected.size) return;
    const { bmIds, dirIds } = splitSelection();
    clip = { mode: 'copy', bookmarks: bmIds, folders: dirIds };
    renderBulk();
    toast(`已复制 ${bmIds.length} 条书签、${dirIds.length} 个文件夹——去目标目录点「粘贴」`);
  });

  $('#bmCut').addEventListener('click', () => {
    if (!selected.size) return;
    const { bmIds, dirIds } = splitSelection();
    clip = { mode: 'cut', bookmarks: bmIds, folders: dirIds };
    renderBulk();
    toast(`已剪切 ${bmIds.length} 条书签、${dirIds.length} 个文件夹——去目标目录点「粘贴」`);
  });

  $('#bmPaste').addEventListener('click', async () => {
    if (!clip) { toast('剪贴板是空的，先复制或剪切', true); return; }
    if (st.sort !== 'tree') { toast('粘贴要到「按目录」模式下用——先切过去，进到目标目录', true); return; }
    const target = st.folderId || BOOKMARKS_BAR_ID;
    try {
      const r = await send({ type: 'bookmarks:paste', targetId: target, clip });
      if (clip.mode === 'cut') clip = null; // 剪切是一次性的
      selected.clear();
      await refresh();
      toast(`已粘贴：复制 ${r.copied} 项、移动 ${r.moved} 项`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#bmNewFolder').addEventListener('click', async () => {
    if (st.sort !== 'tree') { toast('新建文件夹要到「按目录」模式下用', true); return; }
    const name = window.prompt('文件夹名称：');
    if (!name || !name.trim()) return;
    const parent = st.folderId || BOOKMARKS_BAR_ID;
    try {
      const r = await send({ type: 'folder:create', parentId: parent, title: name.trim() });
      // 自动展开目标目录，立刻看到新文件夹
      dirOpen.add(parent);
      chrome.storage.local.set({ 'bm.dirOpen': [...dirOpen] });
      await refresh();
      toast(`已创建文件夹「${r.title}」`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#bmDelete').addEventListener('click', async () => {
    if (!selected.size) return;
    const { bmIds, dirIds } = splitSelection();
    const parts = [];
    if (bmIds.length) parts.push(`${bmIds.length} 条书签`);
    if (dirIds.length) parts.push(`${dirIds.length} 个文件夹`);
    const ok = window.confirm(`删除 ${parts.join('、')}？将移入回收站，可随时还原（标签随标题保留）。`);
    if (!ok) return;
    try {
      let r = await send({ type: 'delete', ids: [...selected] });
      if (r.needTrash) {
        // 首次删除：先设回收站再删
        pendingDelete = [...selected];
        trashOpen = true;
        $('#trashPanel').hidden = false;
        await loadTrash();
        toast('先设置回收站，设置后自动完成这次删除');
        return;
      }
      finishDelete(r);
    } catch (e) {
      toast(e.message, true);
    }
  });

  // 排序：按标题 / 按目录（书签树序，分组头显示）
  $('#bmSort').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-s]');
    if (!btn || btn.dataset.s === st.sort) return;
    st.sort = btn.dataset.s;
    st.offset = 0;
    autoCollapsed = new Set();
    $('#bmSort').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    refresh().catch((x) => toast(x.message, true));
  });

  // 标签云：默认展开，记住选择（存本机）
  $('#bmCloudBtn').addEventListener('click', async () => {
    const wrap = $('#bmCloud');
    wrap.hidden = !wrap.hidden;
    $('#bmCloudBtn').classList.toggle('on', !wrap.hidden);
    chrome.storage.local.set({ 'bm.cloud': !wrap.hidden });
    if (!wrap.hidden) await loadCloud();
  });

  // 回收站
  $('#bmTrash').addEventListener('click', async () => {
    trashOpen = !trashOpen;
    $('#trashPanel').hidden = !trashOpen;
    if (trashOpen) {
      if (!foldersFlat.length) await loadFolders();
      await loadTrash();
    } else {
      refresh().catch((x) => toast(x.message, true));
    }
  });

  $('#trashUseDefault').addEventListener('click', () => setupTrash());
  $('#trashCustom').addEventListener('change', (e) => {
    $('#trashSetCustom').disabled = !e.target.value;
  });
  $('#trashSetCustom').addEventListener('click', () => {
    const v = $('#trashCustom').value;
    if (v) setupTrash(v);
  });

  $('#trashRelocate').addEventListener('click', () => loadTrash(true));

  $('#trashClose').addEventListener('click', () => {
    trashOpen = false;
    $('#trashPanel').hidden = true;
    refresh().catch((x) => toast(x.message, true));
  });

  $('#trashEmpty').addEventListener('click', async () => {
    if (!window.confirm('清空回收站？里面的书签将被真正删除，无法还原。')) return;
    try {
      const r = await send({ type: 'trash:purge', empty: true });
      toast(`已清空（${r.purged} 项）`);
      await loadTrash();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // 最近操作：更多 / 收起
  $('#bmUndoMore').addEventListener('click', () => {
    undoExpanded = !undoExpanded;
    refreshUndo().catch(() => {});
  });

  bindSearchClear();
}

// ---------------------------------------------------------------- 标签云

const CLOUD_LIMIT = 100; // 最多显示的标签数（按书签数排），标签页有全量表
let fullDirs = []; // 全量目录缓存：供补全候选与「目录名含查询词」补齐用

async function loadCloud() {
  const wrap = $('#bmCloud');
  if (!wrap || wrap.hidden) return;
  if (st.query) {
    // 有查询：只显示相关标签/目录（按全部命中集算，翻页不变）；命中标签保留可点掉
    cloudTags = st.related || [];
    cloudDirs = st.relatedDirs || [];
    // 目录补齐：目录名**包含**查询词的也列出来（查 blog 时把 blogbus 也亮出来），
    // 次数用全量值；已在结果集里的不重复
    const terms = queryTerms(st.query);
    if (terms.length && fullDirs.length) {
      const have = new Set(cloudDirs.map((d) => d.tag.toLowerCase()));
      for (const d of fullDirs) {
        const n = d.tag.toLowerCase();
        if (!have.has(n) && terms.some((t) => n.includes(t))) cloudDirs.push(d);
      }
    }
    renderCloud();
    return;
  }
  // 空查询：立刻回全量
  const s = await send({ type: 'state' });
  cloudTags = s.tags || [];
  cloudDirs = s.dirTags || [];
  fullDirs = s.dirTags || [];
  renderCloud();
}

/** 查询词形态：普通标签 #名；带空格的标签引号裸名（# 后不认引号）；目录 @名 */
function cloudToken(name, isDir) {
  if (isDir) return `@${name}`;
  return /\s/.test(name) ? `"${name}"` : `#${name}`;
}

/** 查询里的纯词：去 @/#/? 前缀和引号，操作符词不算 */
function queryTerms(q) {
  const out = [];
  for (const p of String(q || '').split(/\s+/).filter(Boolean)) {
    if (p.startsWith('?')) continue; // ?全文关键词不算标签/目录名
    const n = p.replace(/^[@#!~]+/, '').replace(/^[,+-]/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase();
    if (n && !/^[,+\-|&]$/.test(n)) out.push(n);
  }
  return out;
}

/** 当前正在打的词：最后一个空白段，去掉前缀（与侧边栏 filterText 同款），云按它即时过滤 */
function currentNeedle() {
  const v = ($('#bmSearch') && $('#bmSearch').value) || '';
  const parts = v.split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts[parts.length - 1].replace(/^[@#?]/, '').toLowerCase();
}

/** 查询里已出现的名字（归一化）：裸名 / #名 / @名 都算命中同一个 chip */
function activeQueryNames() {
  const set = new Set();
  for (const p of (st.query || '').split(/\s+/).filter(Boolean)) {
    if (p.startsWith('?')) continue; // ?全文关键词不算标签名
    const n = p.replace(/^[@#]/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase();
    if (n) set.add(n);
  }
  return set;
}

function renderCloud() {
  const tagsBox = $('#bmCloudTags');
  const dirsBox = $('#bmCloudDirs');
  if (!tagsBox || !dirsBox) return;
  const active = activeQueryNames();
  const needle = currentNeedle();
  tagsBox.textContent = '';
  dirsBox.textContent = '';

  const mkChip = (name, count, isDir) => {
    const b = document.createElement('button');
    b.className = 'bm-cloud-chip' + (isDir ? ' dir' : '');
    const tok = cloudToken(name, isDir);
    if (active.has(name.toLowerCase())) b.classList.add('on');
    // 与侧边栏同一套着色：标签色做文字色，选中时 background: currentColor 反白
    b.style.color = colorFor(name, colors);
    b.title = isDir ? `@${name}：该目录（含子级）里的书签` : `${tok}：带这个标签的书签`;
    b.addEventListener('click', () => toggleCloudToken(tok));
    const t = document.createElement('span');
    t.textContent = name;
    const c = document.createElement('span');
    c.className = 'bm-cloud-count';
    c.textContent = count;
    b.append(t, c);
    return b;
  };

  const tags = (needle ? cloudTags.filter((t) => t.tag.toLowerCase().includes(needle)) : cloudTags).slice(0, CLOUD_LIMIT);
  if (!tags.length && !cloudDirs.length) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = st.query ? '这个条件下没有可继续收窄的标签' : '还没有标签';
    tagsBox.append(p);
  }
  for (const t of tags) tagsBox.append(mkChip(t.tag, t.count, false));
  const dirs = needle ? cloudDirs.filter((d) => d.tag.toLowerCase().includes(needle)) : cloudDirs;
  for (const d of dirs.slice(0, CLOUD_LIMIT)) dirsBox.append(mkChip(d.tag, d.count, true));
}

/** 点 chip = 在查询里加上/去掉这个词（再点一下取消），与手打查询完全同一条路 */
function toggleCloudToken(tok) {
  const parts = (st.query || '').split(/\s+/).filter(Boolean);
  const norm = tok.replace(/^[@#]/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase();
  const i = parts.findIndex((p) => p.replace(/^[@#]/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase() === norm);
  if (i >= 0) parts.splice(i, 1);
  else parts.push(tok);
  st.query = parts.join(' ');
  st.offset = 0;
  const input = $('#bmSearch');
  input.value = st.query;
  const wrap = input.closest('.search');
  if (wrap) wrap.classList.toggle('has', !!st.query);
  clearSelectionOnFilterChange();
  refresh().catch((x) => toast(x.message, true));
  renderCloud(); // 立刻更新高亮，不等数据回来
}

// ---------------------------------------------------------------- 回收站

/**
 * forceSetup=true：即使已配置也显示设置界面（「更换位置」入口）。
 * 设置界面基于 trash:status：列出探测到的现成目录，一个都没有就明说（浏览器回收站可能是虚拟视图）。
 */
async function loadTrash(forceSetup = false) {
  let tstat;
  try {
    tstat = await send({ type: 'trash:status' });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const setup = $('#trashSetup');
  const body = $('#trashBody');
  const needSetup = forceSetup || !tstat.configured || !tstat.resolved;
  if (needSetup) {
    setup.hidden = false;
    body.hidden = true;
    renderTrashSetup(tstat);
    fillTrashCustomSelect();
    return;
  }
  setup.hidden = true;
  body.hidden = false;
  let r;
  try {
    r = await send({ type: 'trash:list' });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  renderTrash(r);
}

function renderTrashSetup(tstat) {
  const cur = $('#trashCurrent');
  if (tstat.configured) {
    cur.hidden = false;
    cur.textContent = `当前回收站：${tstat.configuredPath}${tstat.resolved ? '' : '（目录已不存在，可能被删或改名）'}`;
  } else {
    cur.hidden = true;
  }
  $('#trashStale').hidden = !(tstat.configured && !tstat.resolved);
  $('#trashSetupTitle').textContent = tstat.configured ? '更换回收站位置' : '设置回收站：删除的书签统一移进去，可随时还原';

  const box = $('#trashCandidates');
  box.textContent = '';
  const cands = tstat.candidates || [];
  $('#trashNoDetect').hidden = cands.length > 0;
  if (!cands.length) return;
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = '探测到现成目录，可直接套用：';
  box.append(label);
  for (const c of cands) {
    const b = document.createElement('button');
    b.className = 'btn ghost small';
    b.textContent = `使用 ${c.path}`;
    b.title = `${c.title} · ${c.path}`;
    b.addEventListener('click', () => setupTrash(c.id));
    box.append(b);
  }
}

function fillTrashCustomSelect() {
  const sel = $('#trashCustom');
  if (!sel) return;
  const first = sel.firstElementChild;
  sel.textContent = '';
  if (first) sel.append(first);
  for (const f of foldersFlat) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.path || f.title;
    sel.append(opt);
  }
}

function renderTrash(r) {
  const box = $('#trashRows');
  box.textContent = '';
  const items = r.items || [];
  const bmCount = items.filter((x) => !x.isFolder).length;
  $('#trashSummary').textContent = `${r.path} · ${items.length} 项（书签 ${bmCount}）`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'trash-empty';
    empty.textContent = '回收站是空的。';
    box.append(empty);
    return;
  }
  for (const it of items) {
    const line = document.createElement('div');
    line.className = 'trash-row';
    const main = document.createElement('div');
    main.className = 'bm-main';
    const t = document.createElement('div');
    t.className = 'bm-title';
    t.textContent = (it.isFolder ? `${it.title || '(无标题)'}（文件夹）` : it.title || it.url);
    t.title = it.url || it.title || '';
    main.append(t);
    if (it.url) {
      const u = document.createElement('div');
      u.className = 'bm-url';
      u.textContent = it.url;
      main.append(u);
    }
    const origin = document.createElement('div');
    origin.className = 'trash-origin';
    origin.textContent = it.originPath || '—';
    origin.title = it.originPath || '原目录已不存在或未记录';
    const at = document.createElement('div');
    at.className = 'trash-at';
    at.textContent = it.at ? new Date(it.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const ops = document.createElement('div');
    ops.className = 'trash-ops';
    const restore = document.createElement('button');
    restore.className = 'btn ghost small';
    restore.textContent = '还原';
    restore.addEventListener('click', async () => {
      try {
        const res = await send({ type: 'trash:restore', ids: [it.id] });
        toast(`已还原 ${res.restored} 条${res.failed ? `，失败 ${res.failed} 条` : ''}`);
        await loadTrash();
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    });
    const purge = document.createElement('button');
    purge.className = 'btn danger small';
    purge.textContent = '彻底删除';
    purge.addEventListener('click', async () => {
      if (!window.confirm(`彻底删除「${it.title || it.url}」？这次是真的删掉，无法还原。`)) return;
      try {
        await send({ type: 'trash:purge', ids: [it.id] });
        toast('已彻底删除');
        await loadTrash();
      } catch (e) {
        toast(e.message, true);
      }
    });
    ops.append(restore, purge);
    line.append(main, origin, at, ops);
    box.append(line);
  }
}

async function setupTrash(parentId) {
  try {
    const r = await send({ type: 'trash:setup', ...(parentId ? { parentId } : {}) });
    toast(`回收站：${r.path}`);
    await loadFolders(); // 目录下拉的排除对象变了
    await loadTrash();
    // 有挂起的删除请求：设置完补删
    if (pendingDelete) {
      const ids = pendingDelete;
      pendingDelete = null;
      try {
        const res = await send({ type: 'delete', ids });
        finishDelete(res);
      } catch (e) {
        toast(e.message, true);
      }
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function finishDelete(r) {
  selected.clear();
  refresh().catch((x) => toast(x.message, true));
  if (r && r.purged) toast(`已彻底删除 ${r.purged} 条`);
  else if (r) toast(`已移入回收站 ${r.trashed || 0} 条（${r.path}）`);
}

// ---------------------------------------------------------------- 最近操作

const UNDO_SHOW = 5;
const UNDO_MAX = 10;

async function refreshUndo() {
  const box = $('#bmUndoBox');
  const ul = $('#bmUndoList');
  const more = $('#bmUndoMore');
  if (!box || !ul) return;
  const r = await send({ type: 'undo:list' });
  const items = r.items || [];
  ul.textContent = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const show = undoExpanded ? UNDO_MAX : UNDO_SHOW;
  for (const it of items.slice().reverse().slice(0, show)) {
    const li = document.createElement('li');
    const time = new Date(it.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const txt = document.createElement('span');
    txt.textContent = `${time} ${it.label}`;
    const btn = document.createElement('button');
    btn.className = 'btn ghost small';
    btn.textContent = '撤销';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await send({ type: 'undo:apply', index: it.index });
        const bits = [`回滚 ${res.restored} 条`];
        if (res.skipped) bits.push(`跳过 ${res.skipped} 条`);
        if (res.missing) bits.push(`已不存在 ${res.missing} 条`);
        toast(bits.join('，'));
        await refresh();
        if (trashOpen) await loadTrash();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    });
    li.append(txt, btn);
    ul.append(li);
  }
  if (more) {
    more.hidden = items.length <= UNDO_SHOW;
    more.textContent = undoExpanded ? '收起' : `更多（${Math.min(items.length, UNDO_MAX)}）`;
  }
}

function bindSearchClear() {
  document.querySelectorAll('#view-bookmarks .search').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const x = wrap.querySelector('.search-x');
    if (!input || !x) return;
    const sync = () => wrap.classList.toggle('has', !!input.value);
    sync();
    input.addEventListener('input', sync);
    x.addEventListener('click', () => {
      input.value = '';
      sync();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  });
}

// ---------------------------------------------------------------- 入口

export async function init() {
  bind();
  try {
    const s = await send({ type: 'state' });
    colors = (s.config && s.config.colors) || {};
  } catch {}
  // 目录折叠状态（下拉树 + 按目录分组共用，存本机）
  try {
    const o = await chrome.storage.local.get('bm.dirOpen');
    dirOpen = new Set((o && o['bm.dirOpen']) || []);
  } catch {}

  // 标签云默认展开；用户关过就记住（存本机）
  try {
    const o = await chrome.storage.local.get('bm.cloud');
    if (o && o['bm.cloud'] === false) $('#bmCloud').hidden = true;
    else {
      $('#bmCloud').hidden = false; // 默认开启：按钮高亮 + 容器真正展开
      $('#bmCloudBtn').classList.add('on');
    }
  } catch {
    $('#bmCloudBtn').classList.add('on');
  }
  await loadFolders();
  await refresh();
}

export async function refreshView() {
  await refresh();
}
