// 书签视图：给书签打标签、批量整理（标签管理页的第三个视图）
// 一个 URL 一行；多位置时只显示第一个位置，右下角标注 ×N
import { colorFor } from '../lib/palette.js';
import { PATH_SEP } from '../lib/index.js';
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
  sort: 'title', // 'title' 平铺 | 'tree' 按目录（真目录树）
  order: 'dir', // 平铺模式的排序：'dir' 按目录树序（同目录的书签相邻）| 'title' 按标题
  folderId: '',
  counts: { all: 0, untagged: 0, tagged: 0 },
  hiddenRows: 0, // 按目录显示时被折叠隐藏的书签数（只影响显示，不影响筛选/全选）
};
// ---------------------------------------------------------------- 双窗模式
// 两栏各自导航（当前目录/展开集/选中集），共享查询、操作带、剪贴板与标签云。
// 「操作带作用于活动窗格」：selected 全局引用指向活动窗格的选中集，激活时切换绑定。
const PANE_LIST = ['L', 'R'];
let dual = false; // 双窗开关（存本机 bm.dual）
let railFrac = 0.5; // 双窗左右宽度比（0.15–0.85，存本机 bm.railFrac）
// 列宽按视图独立存（flat/L/R 各一份）：双窗两栏宽度不同，共享一份必然互相挤垮——在宽栏拖出的列宽套到窄栏会栅格溢出
// 列宽按视图独立（flat/tree/L/R 各一份）：平铺是 4 列（含目录），按目录是 3 列且标签列永远吃剩余——
// 两种栅格结构不同，共用一份会把平铺的像素宽套进树模式（标签列变定宽、右侧留大空）并互相污染分隔线位置
let colW = { flat: { t: null, g: null }, tree: { t: null, g: null }, L: { t: null, g: null }, R: { t: null, g: null } }; // px，存本机 bm.colW；t=标题/网址列 g=标签列
const splitHeads = new Set(); // 挂了分隔线的表头，窗口缩放时统一重定位

/** 列宽变量落到宿主：双窗=各自窗格（pane 每次渲染重建，需重打），平铺=.bm-table（常驻） */
function applyColW(host, view) {
  if (!host) return;
  const w = colW[view];
  if (!w) return;
  if (w.t) host.style.setProperty('--bm-colW-t', `${w.t}px`);
  else host.style.removeProperty('--bm-colW-t');
  if (w.g) host.style.setProperty('--bm-colW-g', `${w.g}px`);
  else host.style.removeProperty('--bm-colW-g');
}

/** 行区滚动条补偿：表头在滚动容器外，比行少一条滚动条宽度，目录列(吃剩余空间)因此错位——给表头右内边距补同样宽度 */
function compensateScrollbar() {
  const table = document.querySelector('.bm-table');
  if (!table) return;
  const flatRows = $('#bmRows');
  const flatHead = table.querySelector(':scope > .bm-head');
  if (flatRows && flatHead && !flatHead.hidden) {
    const sbw = flatRows.offsetWidth - flatRows.clientWidth;
    flatHead.style.paddingRight = sbw ? `${10 + sbw}px` : '';
  }
  for (const pane of table.querySelectorAll('.bm-pane')) {
    const rows = pane.querySelector('.bm-pane-rows');
    const head = pane.querySelector('.bm-pane-cols');
    if (!rows || !head) continue;
    const sbw = rows.offsetWidth - rows.clientWidth;
    head.style.paddingRight = sbw ? `${10 + sbw}px` : '';
  }
}

/** 表头列数随模式：按目录（树）模式不显示「目录」列——层级已表达位置，平铺模式才需要标目录
 *  mode='flat'|'tree'，同时切换列宽视图（两模式栅格结构不同，列宽不共用） */
function setHeadPath(head, mode) {
  if (!head) return;
  const withPath = mode === 'flat';
  head.classList.toggle('no-path', !withPath);
  const c3 = head.children[3];
  if (c3) c3.hidden = !withPath;
  head.dataset.colview = mode;
  applyColW(head.closest('.bm-table') || document.querySelector('.bm-table'), mode);
  if (head._placeSplits) requestAnimationFrame(head._placeSplits);
}

/** 表头列分隔线：可拖拽调列宽（标题≥180px 标签≥120px），双击恢复默认；view=flat/L/R，各视图独立记忆 */
function attachColSplit(head, view) {
  const kids = [...head.children].filter((el) => el.tagName === 'SPAN');
  if (kids.length < 3) return; // ≥3：按目录模式没有目录列，只有「标题|标签」一条线
  head.dataset.colview = view;
  splitHeads.add(head);
  const places = [];
  const mk = (targetIdx, key, minW) => {
    const h = document.createElement('div');
    h.className = 'bm-colsplit';
    h.dataset.key = key;
    const place = () => {
      // 无目录列时第二条线（标签|目录）不存在，直接藏起来
      if (key === 'g' && head.classList.contains('no-path')) { h.hidden = true; return; }
      h.hidden = false;
      const t = kids[targetIdx];
      if (t) h.style.left = `${t.offsetLeft}px`;
    };
    places.push(place);
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const view = head.dataset.colview || 'flat'; // 运行时读：模式切换后仍写对的那一份
      if (!colW[view]) colW[view] = { t: null, g: null };
      const startX = e.clientX;
      const startW = kids[targetIdx - 1].getBoundingClientRect().width; // 分隔线左侧列的当前宽
      h.classList.add('drag');
      const move = (ev) => {
        // 冻结还没拖过的弹性列成当前像素宽：否则它按 fr 重新分配，拖一条线另一列会跟着缩放（错位/乱跑的根源）
        // 按目录模式不冻：标签列本就固定吃剩余（3 列栅格里没有第二条线），冻成像素反而会留出右侧空隙
        const noPathMode = head.classList.contains('no-path');
        if (!noPathMode) {
          if (key === 'g' && !colW[view].t) colW[view].t = Math.round(kids[1].getBoundingClientRect().width);
          if (key === 't' && !colW[view].g) colW[view].g = Math.round(kids[2].getBoundingClientRect().width);
        }
        // 上限：按本视图（本窗格）实际宽度算——用另一列的真实冻结宽（不是它的最小宽），
        // 否则上限虚高、标签列超出可用空间、行区出现横向滚动条，拖拽靠边时浏览器自动横滚（表现为标签列往左滑）
        const cs = getComputedStyle(head);
        const avail = head.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const noPath = head.classList.contains('no-path');
        const otherIdx = key === 'g' ? 1 : 2;
        // 树模式：另一位是「标签列」（恒吃剩余，留 120px 可读即可）；平铺：另一位是像素列 + 目录列 60px 保底
        const otherNow = noPath ? 0 : ((key === 'g' ? colW[view].t : colW[view].g) || Math.round(kids[otherIdx].getBoundingClientRect().width));
        const maxW = Math.max(minW, avail - 30 - otherNow - (noPath ? 120 : 60) - 24); // 30=复选框列 24=栅格间隙
        colW[view][key] = Math.max(minW, Math.min(maxW, Math.round(startW + ev.clientX - startX)));
        applyColW(head.closest('.bm-pane') || document.querySelector('.bm-table'), view);
        head._placeSplits(); // 两条分隔线都跟着栅格走，不残留旧位置
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        h.classList.remove('drag');
        chrome.storage.local.set({ 'bm.colW': colW });
        head._placeSplits();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', () => {
      const view = head.dataset.colview || 'flat';
      colW[view][key] = null;
      applyColW(head.closest('.bm-pane') || document.querySelector('.bm-table'), view);
      chrome.storage.local.set({ 'bm.colW': colW });
      requestAnimationFrame(() => head._placeSplits());
    });
    head.append(h);
    requestAnimationFrame(place);
  };
  mk(2, 't', 180); // 标题 | 标签
  if (kids.length >= 4) mk(3, 'g', 120); // 标签 | 目录（仅平铺模式有）
  head._placeSplits = () => places.forEach((f) => f());
}
window.addEventListener('resize', () => {
  for (const head of splitHeads) if (head.isConnected) head._placeSplits();
  compensateScrollbar();
});
let activePane = 'L';
const newPane = () => ({
  folderId: '', // 本栏下钻的目录
  dirOpen: new Set(), // 本栏手动展开（存本机 bm.dirOpen.L / .R）
  autoOpen: new Set(), // 查询命中自动展开（不持久化）
  autoCollapsed: new Set(), // 自动展开后被手动收起
  selected: new Set(),
  visible: new Set(), // 本栏当前渲染出的书签（「全选可见」用）
  scroll: 0, // 渲染后恢复滚动位置
});
const paneState = { L: newPane(), R: newPane() };
const curPane = () => paneState[activePane];

let selected = paneState.L.selected; // 活动窗格的选中集
let colors = {};
let foldersFlat = [];
let folderTree = []; // folders:list 的原始树（下拉浮层用）
let idToPath = new Map(); // 目录 id → 路径
let pathToId = new Map(); // 路径 → 目录 id（分组折叠定位用）
let rootIds = new Set(); // 三个根：永远视为展开
// 树模式（按目录）：整棵树 + 每个展开目录的直属书签懒加载（展开/选中状态按窗格各存一份）
const DIR_FETCH_LIMIT = 500; // 后台单目录取书签的上限（超过会截断并提示）
let treeCache = { query: '', filter: 'all', text: '', rows: new Map() }; // folderId -> {rows, total}
let dirLoading = new Set();
let clip = null; // 剪贴板 {mode:'copy'|'cut', bookmarks:[id], folders:[id]}
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

/** 根永远展开；查询期间筛中书签所在目录自动展开；手动收起优先于自动展开（按窗格） */
function dirIsOpen(pane, id) {
  if (!id || rootIds.has(id)) return true;
  if (pane.autoCollapsed.has(id)) return false;
  return pane.dirOpen.has(id) || pane.autoOpen.has(id);
}

/** 有查询时：筛中书签所在目录（及其祖先链）自动展开；查询变了重算（每个窗格各一份） */
function updateAutoOpen(pane, matchPaths) {
  pane.autoOpen = new Set();
  pane.autoCollapsed = new Set();
  if (!st.query) return;
  const next = new Set();
  for (const path of matchPaths) {
    const segs = path.split(PATH_SEP).filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const id = pathToId.get(segs.slice(0, i + 1).join(PATH_SEP));
      if (id && !rootIds.has(id)) next.add(id);
    }
  }
  pane.autoOpen = next;
}

/** 展开状态变了：按窗格存本机 + 重画 */
function toggleDir(pane, id) {
  if (pane.dirOpen.has(id)) {
    pane.dirOpen.delete(id);
  } else if (pane.autoOpen.has(id) && !pane.autoCollapsed.has(id)) {
    pane.autoCollapsed.add(id); // 自动展开的目录被手动收起：本次查询内保持收起
  } else if (pane.autoCollapsed.has(id)) {
    pane.autoCollapsed.delete(id); // 再点一次 = 恢复自动展开
  } else {
    pane.dirOpen.add(id);
  }
  saveDirOpen(pane);
  if (st.sort === 'tree') render();
}

/** 点击某栏：激活它，操作带/剪贴板目标随之切换 */
function activatePane(paneKey) {
  if (activePane === paneKey) return;
  activePane = paneKey;
  selected = paneState[paneKey].selected;
  st.folderId = paneState[paneKey].folderId; // 粘贴/新建文件夹目标跟随活动窗格
  renderBulk();
  for (const el of document.querySelectorAll('.bm-pane')) el.classList.toggle('active', el.dataset.pane === paneKey);
}

// ---------------------------------------------------------------- 双窗拖拽（只移动，不复制）
let dndTimer = null;

/** 行可拖：在选中集里=拖整批，不在=拖本行 */
function bindRowDrag(el, rowId, sel) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    const ids = sel.has(rowId) ? [...sel] : [rowId];
    e.dataTransfer.setData('text/plain', JSON.stringify({ ids }));
    e.dataTransfer.effectAllowed = 'move';
  });
}

/** 文件夹行：可拖（整枝移动），也是投放目标；悬停自动展开 */
function bindFolderDnD(el, node, open, pane, isRoot) {
  if (!isRoot) bindRowDrag(el, node.id, pane.selected);
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop');
    clearTimeout(dndTimer);
    if (!isRoot && !open) dndTimer = setTimeout(() => toggleDir(pane, node.id), 600);
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drop');
    clearTimeout(dndTimer);
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation(); // 别让栏级投放再处理一遍
    el.classList.remove('drop');
    clearTimeout(dndTimer);
    await dropMove(e, node.id);
  });
}

/** 栏级投放目标：空白处投放 = 移到本栏下钻的目录（没下钻就不接） */
function bindDropTarget(el, getTargetId) {
  el.addEventListener('dragover', (e) => {
    if (e.target.closest('.bm-folder-row')) return; // 文件夹行自己高亮
    if (!getTargetId()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    const target = getTargetId();
    el.classList.remove('drop');
    if (!target) return;
    e.preventDefault();
    await dropMove(e, target);
  });
}

/** 书签行投放：上半=插到它前面，下半=插到它后面（位置取自节点的实时父子位次） */
function bindBookmarkDrop(el, row) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    el.classList.toggle('drop-above', above);
    el.classList.toggle('drop-below', !above);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const above = el.classList.contains('drop-above');
    el.classList.remove('drop-above', 'drop-below');
    await dropMoveAt(e, row.id, above);
  });
}

async function dropMoveAt(e, targetRowId, above) {
  let ids = [];
  try {
    ids = JSON.parse(e.dataTransfer.getData('text/plain') || '{}').ids || [];
  } catch {}
  ids = ids.filter((id) => id !== targetRowId);
  if (!ids.length) return;
  try {
    // 过滤视图里的顺序不代表真实子位次，取节点的实时 parentId/index
    const [n] = await chrome.bookmarks.get(targetRowId);
    if (!n) return;
    const r = await send({ type: 'bookmarks:move', ids, parentId: n.parentId, index: above ? n.index : n.index + 1 });
    for (const k of PANE_LIST) paneState[k].selected.clear();
    selected = curPane().selected;
    await refresh();
    toast(`已移动 ${r.moved} 项（插入到书签${above ? '前' : '后'}）· 可撤销`);
  } catch (err) {
    toast(err.message, true);
  }
}

/** 松手=移动（复用 bookmarks:move，后台记撤销栈） */
async function dropMove(e, targetId) {
  let ids = [];
  try {
    ids = JSON.parse(e.dataTransfer.getData('text/plain') || '{}').ids || [];
  } catch {}
  ids = ids.filter((id) => id !== targetId);
  if (!ids.length) return;
  try {
    const r = await send({ type: 'bookmarks:move', ids, parentId: targetId });
    for (const k of PANE_LIST) paneState[k].selected.clear();
    selected = curPane().selected;
    await refresh();
    toast(`已移动 ${r.moved} 项 → ${r.path} · 可撤销`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- 右键菜单（树模式）
let ctxEl = null;
function closeCtx() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
  }
}
/** 复制网址到剪贴板：管理页里可能没有输入焦点，clipboard API 失败就退回 textarea 选中复制 */
async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('已复制网址');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制网址');
    } catch {
      toast('复制失败，请手动复制', true);
    }
    ta.remove();
  }
}

/** 粘贴到指定目录（右键专用）：目标 = 右键位置的所在目录；剪切粘贴成功后剪贴板自动清空 */
async function pasteInto(targetId, targetName) {
  if (!clip) {
    toast('剪贴板是空的，先复制或剪切', true);
    return;
  }
  const tid = String(targetId);
  const targetPath = idToPath.get(tid) || '';
  const bad = (clip.folders || []).some((id) => {
    const p = idToPath.get(String(id));
    // 剪切的文件夹自己或它的上级：粘进去等于把自己搬进自己的子树，直接拒绝
    return p && targetPath && (targetPath === p || targetPath.startsWith(`${p}${PATH_SEP}`));
  });
  if (bad) {
    toast('不能把文件夹粘贴到它自己或它的子目录里', true);
    return;
  }
  try {
    const r = await send({ type: 'bookmarks:paste', targetId: tid, clip });
    if (clip.mode === 'cut') clip = null; // 剪切是一次性的
    selected.clear();
    // 剪切把条目移走：分页模式回退 offset，避免当前页变空跳页
    if (st.sort !== 'tree' && clip === null && r && r.moved) {
      st.offset = Math.max(0, st.offset - r.moved);
    }
    await refresh();
    toast(`已粘贴到「${targetName}」：复制 ${r.copied} 项、移动 ${r.moved} 项`);
  } catch (e) {
    toast(e.message, true);
  }
}

/** 右键复制/剪切：勾选框有内容就操作勾选集（与操作带同口径），没勾选就只操作右键的这一个 */
function ctxClip(mode, fallbackId) {
  const ids = selected.size ? [...selected] : [fallbackId];
  const { bmIds, dirIds } = splitSel(new Set(ids));
  clip = { mode, bookmarks: bmIds, folders: dirIds };
  renderBulk();
  const parts = [];
  if (bmIds.length) parts.push(`${bmIds.length} 条书签`);
  if (dirIds.length) parts.push(`${dirIds.length} 个文件夹`);
  toast(`已${mode === 'cut' ? '剪切' : '复制'} ${parts.join('、')}——去目标目录点「粘贴」`);
}

/** 书签行右键菜单：公开项（打开/复制网址/重命名）+ 按目录模式额外的剪切/复制（进剪贴板）+ 删除 */
function bookmarkCtxItems(line, row, withClip) {
  const items = [];
  if (withClip && clip) {
    // 右键书签 → 粘贴进它所在的目录（不是当前下钻的目录），标出目录名免得粘错地方
    const parentId = row.parentId ? String(row.parentId) : curPane().folderId || BOOKMARKS_BAR_ID;
    const parentName = (idToPath.get(parentId) || '').split('/').slice(-1)[0] || '书签栏';
    items.push({ label: `粘贴到「${parentName}」`, run: () => pasteInto(parentId, parentName) }, '-');
  }
  items.push(
    { label: '打开', run: () => chrome.tabs.create({ url: row.url }) },
    { label: '复制网址', run: () => copyUrl(row.url) },
    { label: '重命名（标签保留）', run: () => renameRow(line, row) },
  );
  if (withClip) {
    items.push(
      '-',
      { label: '剪切', run: () => ctxClip('cut', row.id) },
      { label: '复制', run: () => ctxClip('copy', row.id) },
    );
  }
  items.push('-', { label: '删除（进回收站）', danger: true, run: () => deleteNodes([row.id]) });
  return items;
}

function openCtx(x, y, items) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'bm-ctx';
  for (const it of items) {
    if (it === '-') {
      const hr = document.createElement('div');
      hr.className = 'bm-ctx-sep';
      ctxEl.append(hr);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => {
      closeCtx();
      it.run();
    });
    ctxEl.append(b);
  }
  document.body.append(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 8))}px`;
  ctxEl.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 8))}px`;
}
document.addEventListener('click', closeCtx);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtx();
});
window.addEventListener('blur', closeCtx);

/** 行内重命名（文件夹）：Enter 提交，Esc 取消 */
function renameFolder(rowEl, node) {
  const nameBtn = rowEl.querySelector('.bm-group-name');
  if (!nameBtn) return;
  const input = document.createElement('input');
  input.className = 'bm-rename';
  input.value = node.title || '';
  nameBtn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const cancel = () => {
    done = true;
    input.replaceWith(nameBtn);
  };
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(nameBtn);
    if (!v || v === node.title) return;
    try {
      await send({ type: 'node:rename', id: node.id, title: v });
      await refresh();
      toast('已重命名');
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      cancel();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renameRow(lineEl, row) {
  const t = lineEl.querySelector('.bm-title');
  if (!t) return;
  const input = document.createElement('input');
  input.className = 'bm-rename';
  input.value = row.title || '';
  t.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const cancel = () => {
    done = true;
    input.replaceWith(t);
  };
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(t);
    if (!v || v === row.title) return;
    try {
      await send({ type: 'node:rename', id: row.id, title: v });
      await refresh();
      toast('已重命名（标签保留）');
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      cancel();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * 删除按钮的就地二次确认（与侧边栏同一套手感）：第一次点击只"上膛"，
 * 按钮字样改成「确认 N？」并红底标出，3 秒不点第二次就自动复位。
 * 内嵌视图里 window.confirm 又丑又会打断操作，且不可撤销的错觉更强。
 */
let delArmTimer = null;
function disarmDelete() {
  clearTimeout(delArmTimer);
  delArmTimer = null;
  const b = $('#bmDelete');
  if (!b) return;
  b.classList.remove('armed');
  b.textContent = '删除';
}
function armDelete() {
  const b = $('#bmDelete');
  if (!b) return false;
  if (b.classList.contains('armed')) {
    disarmDelete();
    return true; // 第二次点击：放行
  }
  disarmDelete();
  b.textContent = `确认 ${selected.size}？`;
  b.classList.add('armed');
  delArmTimer = setTimeout(disarmDelete, 3000);
  const { bmIds, dirIds } = splitSel(selected);
  const parts = [];
  if (bmIds.length) parts.push(`${bmIds.length} 条书签`);
  if (dirIds.length) parts.push(`${dirIds.length} 个文件夹`);
  toast(`再点一次确认：删除${parts.join(' + ')}（进回收站，可还原）`);
  return false;
}

async function deleteNodes(ids) {
  try {
    const r = await send({ type: 'delete', ids });
    if (r.needTrash) {
      pendingDelete = ids;
      trashOpen = true;
      $('#trashPanel').hidden = false;
      if (!foldersFlat.length) await loadFolders();
      await loadTrash();
      toast('先设置回收站，设置后自动完成这次删除');
      return;
    }
    finishDelete(r);
  } catch (e) {
    toast(e.message, true);
  }
}

async function createSubFolder(node, pane) {
  const name = window.prompt('子文件夹名称：');
  if (!name || !name.trim()) return;
  try {
    const r = await send({ type: 'folder:create', parentId: node.id, title: name.trim() });
    pane.dirOpen.add(node.id);
    saveDirOpen(pane);
    await refresh();
    toast(`已在「${node.title || '目录'}」下创建「${r.title}」`);
  } catch (e) {
    toast(e.message, true);
  }
}

/** 每栏下钻位置存本机 */
function savePaneFolder() {
  chrome.storage.local.set({ 'bm.paneFolder': { L: paneState.L.folderId, R: paneState.R.folderId } });
}

// ---------------------------------------------------------------- 数据

async function refresh() {
  if (st.sort === 'tree') {
    st.offset = 0; // 树模式无分页
    invalidateTree();
    capturePaneAnchors(); // 只在改动前的稳定 DOM 抓一次；多目录懒加载多轮重绘共用同一锚点
    dirtyTree(); // 书签/文件夹增删改后立即生效（查询词没变时 invalidateTree 不会清行缓存）
    // 目录树可能刚被删/剪/新建过，重拉 folders:list，别用内存里的旧树
    await loadFolders();
    // 各栏下钻的目录若已被删掉，退回全部目录
    for (const k of PANE_LIST) {
      const p = paneState[k];
      if (p.folderId && !idToPath.get(p.folderId)) p.folderId = '';
    }
    st.folderId = curPane().folderId;
  }
  const r = await send({
    type: 'bookmarks:page',
    offset: st.offset,
    limit: PAGE,
    filter: st.filter,
    text: st.text,
    query: st.query,
    // 主查询永远不按下钻收窄：树模式的行是按目录懒加载的，
    // 而平铺是"全部书签"的清单——下钻只是按目录视图里的浏览位置，
    // 不该变成一个看不见的全局筛选条件（切到平铺仍然只剩这个目录曾是 bug）
    folderId: '',
    // 平铺模式按 st.order 决定行序：目录（书签树序，同目录相邻）或标题
    sort: st.sort === 'tree' ? 'tree' : st.order,
  });
  st.items = r.items || [];
  st.total = r.total || 0;
  st.counts = r.counts || st.counts;
  st.related = r.related || [];
  st.relatedDirs = r.relatedDirs || [];
  if (st.sort === 'tree') for (const k of PANE_LIST) updateAutoOpen(paneState[k], r.matchPaths || []);
  render();
  refreshUndo().catch(() => {});
  loadCloud().catch(() => {});
}

function render() {
  const rows = $('#bmRows');
  if (!rows) return;
  // 重画前记忆滚动与焦点：删除/移动后列表整块重建，不记忆就会跳顶、焦点丢到 body
  const prevScroll = rows.scrollTop;
  const prevFocusId = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.bm-row')?.dataset.id || ''
    : '';
  const prevHadFocus = document.activeElement && rows.contains(document.activeElement);
  rows.textContent = '';

  renderCrumb();
  renderSummary();
  syncFilterNote().catch(() => {});

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
    // 展开的目录懒加载直属书签（受查询/快筛约束）；无分页。
    // 双窗：两栏各自导航；单窗：一栏占满（面包屑仍内嵌表头）
    st.hiddenRows = 0;
    // 双窗：外层表头退役，各栏用自己的面包屑；
    // 单窗：可见性交给 renderCrumb() 判断（没下钻就隐藏）——
    // 这里若写成 hidden = dual，会把刚被 renderCrumb 藏起来的面包屑又亮出来，
    // 结果"退出下钻"后列表回到了所有目录、面包屑却还挂在表头（看着像退不出去）
    if (dual) $('#bmCrumb').hidden = true;
    rows.classList.toggle('bm-tree-host', true);
    const outerHead = document.querySelector('.bm-table .bm-head');
    if (outerHead) outerHead.hidden = dual; // 双窗：外层表头退役，每栏有自己的列头+面包屑
    setHeadPath(outerHead, 'tree'); // 树模式：不要目录列，列宽走 tree 视图
    const wrap = document.createElement('div');
    wrap.className = 'bm-dual-wrap' + (dual ? ' dual' : ' single');
    if (dual) {
      wrap.style.gridTemplateColumns = `${railFrac}fr auto ${1 - railFrac}fr`;
      wrap.append(buildPane('L'), buildRail(), buildPane('R'));
    } else {
      wrap.append(buildPane('L'));
    }
    rows.append(wrap);
    restoreAllPaneAnchors(); // 面板已挂载，锚点行可查、rect 有效
  } else {
    rows.classList.toggle('bm-tree-host', false);
    const outerHead = document.querySelector('.bm-table .bm-head');
    if (outerHead) {
      outerHead.hidden = false;
      setHeadPath(outerHead, 'flat'); // 平铺模式：目录列回来，列宽走 flat 视图
    }
    st.hiddenRows = 0;
    for (const row of st.items) rows.append(renderRow(row));
  }
  renderBulk();
  // 恢复滚动与焦点（重画后行高一致，scrollTop 直接可用；行被删则尽量贴近原位置）
  if (!tree) {
    rows.scrollTop = Math.min(prevScroll, Math.max(0, rows.scrollHeight - rows.clientHeight));
    if (prevHadFocus) {
      const target = prevFocusId ? rows.querySelector(`.bm-row[data-id="${CSS.escape(prevFocusId)}"]`)
        : rows.querySelector('.bm-row');
      if (target) target.focus?.();
    }
  }
  requestAnimationFrame(compensateScrollbar); // 表头补滚动条宽度，逐列对齐
}

/** 按目录模式：记录每栏视口顶部的第一行（书签或文件夹），重画后靠它恢复视觉位置 */
function capturePaneAnchors() {
  if (st.sort !== 'tree') return;
  // 单窗：滚动容器是 #bmRows（.bm-rows 62vh overflow-y:auto），.bm-pane-rows 不可滚；
  // 双窗：#bmRows 不可滚，各栏 .bm-pane-rows 才滚。锚点必须挂在真容器上。
  for (const k of dual ? PANE_LIST : ['L']) {
    const el = dual
      ? document.querySelector(`.bm-pane[data-pane="${k}"] .bm-pane-rows`)
      : document.querySelector('#bmRows');
    const pane = paneState[k];
    if (!el || !pane) continue;
    const rowsTop = el.getBoundingClientRect().top;
    pane.anchor = null;
    for (const row of el.querySelectorAll('.bm-row[data-id], .bm-folder-row[data-id]')) {
      const top = row.getBoundingClientRect().top;
      if (top >= rowsTop - 1) {
        pane.anchor = { id: row.dataset.id, off: top - rowsTop };
        break;
      }
    }
  }
}

/** 重画后把锚点行放回原来的视口偏移；锚点行没了（如懒加载未完）就退回 pane.scroll */
function restorePaneAnchor(scroller, pane) {
  const a = pane.anchor;
  if (a) {
    const el = scroller.querySelector(`[data-id="${CSS.escape(a.id)}"]`);
    if (el) {
      // 锚点行上方可能还有目录在懒加载：它们从占位膨胀成真行会把锚点行推下去，
      // 所以锚点必须活到全部懒加载结束——每轮 render 都重新对位，最后消费
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - a.off;
      if (!dirLoading.size) pane.anchor = null;
      return;
    }
    if (dirLoading.size) return; // 锚点行还没渲染出来（其目录仍在加载），等下一轮
    pane.anchor = null; // 全部载入完仍没有该行（被删/被过滤）→ 放弃锚点
  }
  scroller.scrollTop = pane.scroll;
}

/** 树模式重绘挂载完成后恢复滚动：单窗容器是 #bmRows，双窗是各栏 .bm-pane-rows */
function restoreAllPaneAnchors() {
  for (const k of dual ? PANE_LIST : ['L']) {
    const sc = dual
      ? document.querySelector(`.bm-pane[data-pane="${k}"] .bm-pane-rows`)
      : document.querySelector('#bmRows');
    if (sc) restorePaneAnchor(sc, paneState[k]);
  }
}

/** 双窗里的一栏：头部（来源/目标 + 面包屑）+ 可滚动行区 */
function buildPane(paneKey) {
  const pane = paneState[paneKey];
  const el = document.createElement('div');
  el.className = 'bm-pane' + (paneKey === activePane ? ' active' : '');
  el.dataset.pane = paneKey;
  // 点进哪栏，操作带/剪贴板目标就切到哪栏（mousedown 比 click 早，拖拽前也能激活）
  el.addEventListener('mousedown', () => activatePane(paneKey));
  const rowsEl = document.createElement('div');
  rowsEl.className = 'bm-pane-rows';
  renderTreeMode(rowsEl, pane);
  // 滚动位置恢复见 restoreAllPaneAnchors()——必须等面板挂进 DOM 后做，
  // 游离元素上 getBoundingClientRect 全是 0、锚点行也查不到。
  // 单窗的真滚动容器是 #bmRows（pane-rows overflow:visible），双窗才是 rowsEl；
  // #bmRows 跨 render 常驻，滚动监听只挂一次防叠加。
  const scroller = dual ? rowsEl : document.querySelector('#bmRows');
  if (scroller && !scroller.dataset.scrollBound) {
    scroller.dataset.scrollBound = '1';
    scroller.addEventListener('scroll', () => (pane.scroll = scroller.scrollTop));
  }
  // 栏内空白投放 = 移到本栏下钻的目录（没下钻则提示拖到具体文件夹）
  bindDropTarget(rowsEl, () => pane.folderId);
  if (dual) {
    const head = document.createElement('div');
    head.className = 'bm-pane-head';
    const tag = document.createElement('span');
    tag.className = 'bm-pane-tag';
    tag.textContent = paneKey === 'L' ? '左栏' : '右栏';
    const crumbEl = document.createElement('div');
    crumbEl.className = 'bm-crumb';
    renderCrumbInto(crumbEl, pane);
    head.append(tag, crumbEl);
    el.append(head);
    // 栏内列头：与栏内行同一套栅格，对得齐
    const cols = document.createElement('div');
    cols.className = 'bm-head bm-pane-cols';
    const c0 = document.createElement('span'); // 复选框占位，与行对齐
    const c1 = document.createElement('span');
    c1.textContent = '标题 / 网址';
    const c2 = document.createElement('span');
    c2.textContent = '标签';
    cols.append(c0, c1, c2); // 按目录模式没有目录列（层级已表达位置），标签列吃剩余空间
    cols.classList.add('no-path');
    el.append(cols);
    applyColW(el, paneKey); // pane 每次渲染重建，列宽变量重打
    attachColSplit(cols, paneKey);
  }
  el.append(rowsEl);
  return el;
}

// ---------------------------------------------------------------- 中缝操作条（固定方向：跨栏复制/移动）
function buildRail() {
  const rail = document.createElement('div');
  rail.className = 'bm-rail';
  rail.id = 'bmRail';
  const mk = (label, act, side, title) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.rail = act;
    b.dataset.side = side;
    b.title = title;
    return b;
  };
  const g1 = document.createElement('div');
  g1.className = 'bm-rail-group';
  g1.append(mk('复制 ⇨', 'copy', 'toR', '左栏选中 → 复制到右栏当前目录'));
  g1.append(mk('移动 ⇨', 'move', 'toR', '左栏选中 → 移动到右栏当前目录（可撤销）'));
  const g2 = document.createElement('div');
  g2.className = 'bm-rail-group';
  g2.append(mk('⇦ 复制', 'copy', 'toL', '右栏选中 → 复制到左栏当前目录'));
  g2.append(mk('⇦ 移动', 'move', 'toL', '右栏选中 → 移动到左栏当前目录（可撤销）'));
  rail.append(g1, g2);
  rail.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rail]');
    if (!btn || btn.disabled) return;
    railRun(btn.dataset.rail, btn.dataset.side);
  });
  // 中缝兼做拖拽把手：按空白处左右拖，调两栏宽度（0.15–0.85，存本机）
  rail.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-rail]')) return;
    e.preventDefault();
    const wrap = rail.closest('.bm-dual-wrap');
    if (!wrap) return;
    const move = (ev) => {
      const r = wrap.getBoundingClientRect();
      const frac = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
      wrap.style.gridTemplateColumns = `${frac}fr auto ${1 - frac}fr`;
      railFrac = frac;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      chrome.storage.local.set({ 'bm.railFrac': railFrac });
      for (const head of splitHeads) if (head.isConnected) head._placeSplits();
      compensateScrollbar();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return rail;
}

let railLock = false;
async function railRun(act, side) {
  if (railLock) return;
  const toR = side === 'toR';
  const src = toR ? 'L' : 'R';
  const dst = toR ? 'R' : 'L';
  const sel = paneState[src].selected;
  if (!sel.size) return;
  const targetId = paneState[dst].folderId || BOOKMARKS_BAR_ID;
  const targetPath = (paneState[dst].folderId && idToPath.get(paneState[dst].folderId)) || '书签栏';
  railLock = true;
  try {
    if (act === 'move') {
      const ids = [...sel];
      const r = await send({ type: 'bookmarks:move', ids, parentId: targetId });
      sel.clear();
      await refresh();
      toast(`已移动 ${r.moved} 项 → ${targetPath} · 可撤销`);
    } else {
      const { bmIds, dirIds } = splitSel(sel);
      if (!bmIds.length && !dirIds.length) return;
      const r = await send({ type: 'bookmarks:paste', targetId, clip: { mode: 'copy', bookmarks: bmIds, folders: dirIds } });
      await refresh();
      toast(`已复制到 ${targetPath}：新增 ${r.copied} 项`);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    railLock = false;
  }
}

/** 树模式：根常展开，其余按 pane.dirOpen；下钻时只渲染那棵子树 */
function renderTreeMode(container, pane) {
  pane.visible = new Set();
  const drillNode = pane.folderId ? findFolderNode(folderTree, pane.folderId) : null;
  if (pane.folderId && !drillNode) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '目录不存在或已被排除，点面包屑「所有目录」返回。';
    container.append(p);
    return;
  }
  const walk = (nodes, parentOpen, depth) => {
    for (const n of nodes || []) {
      if (!parentOpen) continue; // 上级收起：整枝不渲染（书签管理器语义）
      const open = dirIsOpen(pane, n.id);
      container.append(renderFolderRow(n, open, depth === 0, pane));
      if (open) {
        walk(n.children, true, depth + 1); // 文件夹靠前
        appendDirRows(container, n, depth, pane); // 直属书签在后
      }
    }
  };
  if (drillNode) {
    // 下钻 = 只看这棵子树；自身视为展开
    if (!pane.dirOpen.has(drillNode.id)) {
      pane.dirOpen.add(drillNode.id);
      saveDirOpen(pane);
    }
    container.append(renderFolderRow(drillNode, true, 0, pane));
    walk(drillNode.children, true, 1);
    appendDirRows(container, drillNode, 0, pane);
  } else {
    walk(folderTree, true, 0);
  }
}

/** 展开集按窗格持久化 */
function saveDirOpen(pane) {
  const key = PANE_LIST.find((k) => paneState[k] === pane) || 'L';
  chrome.storage.local.set({ [`bm.dirOpen.${key}`]: [...pane.dirOpen] });
}

function findFolderNode(nodes, id) {
  for (const n of nodes || []) {
    if (String(n.id) === String(id)) return n;
    const hit = findFolderNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 文件夹行：箭头=展开/收起，名字=下钻只看这棵子树；可拖拽移动整枝（只移动不复制） */
function renderFolderRow(node, open, isRoot, pane) {
  const div = document.createElement('div');
  // 展开状态（▾）整行橙色标出：手动展开和查询自动展开都算
  const isCur = dirIsOpen(pane, node.id);
  const sel = pane.selected;
  div.className = 'bm-group bm-folder-row' + (isCur ? ' cur' : '') + (sel.has(node.id) ? ' on' : '');
  div.dataset.id = node.id; // 锚点恢复用：删除/移动重画后回到原来的视觉位置
  // 文件夹也有复选框：复制/剪切/粘贴的对象可以是文件夹
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'bm-cb';
  cb.checked = sel.has(node.id);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => setSelected(node.id, cb.checked, div, cb, sel));
  div.append(cb);
  if (!isRoot) {
    const arrow = document.createElement('button');
    arrow.className = 'bm-group-arrow';
    const expandable = (node.children || []).length > 0 || node.count > 0;
    if (expandable) {
      // 叶子文件夹（没有子文件夹但有直属书签）也能展开/收起——不能只看 children
      arrow.textContent = open ? '▾' : '▸';
      arrow.title = open ? '收起' : '展开';
      arrow.addEventListener('click', () => toggleDir(pane, node.id));
    }
    div.append(arrow);
  }
  const name = document.createElement('button');
  name.className = 'bm-group-name';
  name.style.paddingLeft = `${Math.min(node.depth, 6) * 12}px`; // 与书签行同 12px/级
  name.textContent = node.title || '(无标题)';
  name.title = `${node.path} · 直属 ${node.count} · 全部 ${node.total} · 点击只看这个目录`;
  name.addEventListener('click', () => {
    pane.folderId = node.id;
    st.folderId = node.id; // mousedown 已激活本栏，这里同步给粘贴/新建文件夹用
    savePaneFolder();
    st.offset = 0;
    clearSelectionOnFilterChange();
    refresh().catch((x) => toast(x.message, true));
  });
  div.append(name);
  const cnt = document.createElement('span');
  cnt.className = 'bm-group-count';
  cnt.textContent = open ? `${node.count} 直属 · ${node.total} 全部` : `${node.total} 条（已折叠）`;
  div.append(cnt);
  // 拖拽：根目录不可拖（也拖不动），任何文件夹行都是投放目标
  bindFolderDnD(div, node, open, pane, isRoot);
  // 右键菜单：重命名 / 新建子文件夹 / 剪切 / 复制 / 删除
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [];
    if (clip) {
      // 右键文件夹 → 粘贴进这个文件夹本身
      const name = node.title || '目录';
      items.push({ label: `粘贴到「${name}」`, run: () => pasteInto(node.id, name) }, '-');
    }
    items.push(
      { label: '重命名', run: () => renameFolder(div, node) },
      { label: '新建子文件夹', run: () => createSubFolder(node, pane) },
      '-',
      { label: '剪切', run: () => ctxClip('cut', node.id) },
      { label: '复制', run: () => ctxClip('copy', node.id) },
      '-',
      { label: '删除（进回收站）', danger: true, run: () => deleteNodes([node.id]) },
    );
    openCtx(e.clientX, e.clientY, items);
  });
  return div;
}

/** 展开目录的直属书签：懒加载 + 每目录分批显示 */
function appendDirRows(container, node, depth, pane) {
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
  box.className = 'bm-dirrows'; // 不再整盒缩进——缩进放进行内标题格，行栅格与表头逐列对齐
  for (const row of hit.rows) {
    box.append(renderRow(row, pane, depth + 1));
    pane.visible.add(row.id);
  }
  if (!hit.rows.length) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.style.paddingLeft = `${(depth + 1) * 12}px`;
    const filtering = !!(st.query || st.text || (st.filter && st.filter !== 'all'));
    p.textContent = node.count
      ? (filtering ? '（直属书签都被当前查询/搜索/筛选筛掉了，看上方「当前生效」条）' : '（直属书签都不匹配当前查询/搜索）')
      : '（没有直属书签）';
    box.append(p);
  } else if (hit.total > hit.rows.length) {
    // 后台单次最多取 500 条：极少数直属书签过多的目录会截断，明说而不是悄悄少
    const p = document.createElement('span');
    p.className = 'hint';
    p.style.paddingLeft = `${(depth + 1) * 12}px`;
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
    treeCache.rows.set(key, { rows: r.items || [], total: r.total || 0, folderExcluded: !!r.folderExcluded });
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
  fullDirs = []; // 目录名可能变了（改名/合并/排除），下次条件条重新取一遍全量目录
  dirLoading.clear();
  for (const k of PANE_LIST) paneState[k].anchor = null; // 条件变了，旧位置没有意义
}

/** 下钻后的面包屑：所有目录 / 书签栏 / AI ✕，点任何一级跳回（单窗：内嵌表头） */
function renderCrumb() {
  const el = $('#bmCrumb');
  if (!el) return;
  if (!st.folderId || st.sort !== 'tree') {
    el.hidden = true;
    el.textContent = ''; // 藏起来的同时清空：免得残留的分段在别的时机又露出来
    return;
  }
  el.hidden = false;
  el.textContent = '';
  renderCrumbInto(el, curPane());
}

/** 查询框 + 条件一起清空（不动"搜书签名/网址"和批量打标签输入） */
function resetQueryBox() {
  if (!st.query) return;
  st.query = '';
  const input = $('#bmSearch');
  if (!input) return;
  input.value = '';
  const wrap = input.closest('.search');
  if (wrap) wrap.classList.remove('has');
}

/** 双窗：每栏自己的面包屑（跳转只影响本栏） */
function renderCrumbInto(el, pane) {
  if (!pane.folderId) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = '';
  const path = idToPath.get(pane.folderId) || '';
  const segs = path.split(PATH_SEP).filter(Boolean);

  const jump = (targetPath) => {
    // 退出面包屑（点「所有目录」或 ✕）：查询框一起复位。
    // 否则下钻期间点目录标签留下的 @目录 词会让整页看起来只剩空列表
    if (!targetPath) resetQueryBox();
    pane.folderId = targetPath ? pathToId.get(targetPath) || '' : '';
    if (paneState[activePane] === pane) st.folderId = pane.folderId;
    savePaneFolder();
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
    el.append(seg(sg, segs.slice(0, i + 1).join(PATH_SEP), i === segs.length - 1));
    if (i < segs.length - 1) el.append(sep());
  });
  const x = document.createElement('button');
  x.className = 'bm-crumb-x';
  x.textContent = '✕';
  x.title = '回到所有目录';
  x.addEventListener('click', () => jump(''));
  el.append(x);
}

function setSelected(id, on, line, cb, sel = selected) {
  if (on) {
    sel.add(id);
    // 勾文件夹 = 整枝都要进回收站：把同一枝里已经勾上的后代/祖先 ids 去掉，
    // 否则删除对象数会虚高，同一个条目还会被删两次
    const drop = folderBranchIds(id, sel);
    for (const x of drop) {
      sel.delete(x);
      // 同枝里被剪掉的条目，界面上的勾也要跟着取消（否则看着还选着）
      for (const el of document.querySelectorAll(`[data-id="${CSS.escape(String(x))}"]`)) {
        el.classList.remove('on');
        const box = el.querySelector('input.bm-cb');
        if (box) box.checked = false;
      }
    }
  } else sel.delete(id);
  if (cb) cb.checked = on;
  if (line) line.classList.toggle('on', on);
  renderBulk();
}

function renderRow(row, pane, depth = 0) {
  const sel = pane ? pane.selected : selected; // 平铺模式没有窗格概念，用活动窗格的选中集
  const line = document.createElement('div');
  line.className = 'bm-row' + (sel.has(row.id) ? ' on' : '');
  line.dataset.id = row.id;
  line.tabIndex = -1; // 可编程聚焦：删除/移动重画后把焦点还给原行，不丢到 body

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'bm-cb';
  cb.checked = sel.has(row.id);
  cb.addEventListener('change', () => setSelected(row.id, cb.checked, line, cb, sel));

  // 整行可点：只挡真正的交互件（复选框、标题链接、chip、推荐、徽标），
  // 标题右侧、标签行缝隙等空白区都能勾选（与侧边栏一致）
  line.addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, .chip, .x, .bm-badge, .bm-sug')) return;
    if (String(window.getSelection())) return; // 选文字时不误触
    setSelected(row.id, !sel.has(row.id), line, cb, sel);
  });

  // 树模式下行可拖拽（拖的是选中集或本行），也可作为投放目标插到书签前/后；平铺模式不启用
  if (pane) {
    bindRowDrag(line, row.id, sel);
    bindBookmarkDrop(line, row);
  }
  // 右键菜单：按目录模式带「剪切/复制」（进剪贴板后去目标目录粘贴）；平铺模式只有网址/重命名/删除
  line.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtx(e.clientX, e.clientY, bookmarkCtxItems(line, row, !!pane));
  });

  // 标题 + 网址
  const main = document.createElement('div');
  main.className = 'bm-main';
  const t = document.createElement('a');
  t.className = 'bm-title';
  main.style.paddingLeft = `${10 + depth * 12}px`; // 10=格子基础左内距（与表头列名一致），缩进按层级叠加：两行左缘对齐
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
  path.textContent = (row.path || '').split(PATH_SEP).slice(-1)[0] || '';
  path.title = row.path || '';

  if (pane) {
    // 树模式（含双窗两栏）：不渲染目录格——所在目录由层级/面包屑表达
    line.classList.add('no-path');
    line.append(cb, main, tags);
  } else {
    line.append(cb, main, tags, path);
  }
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
  const dirty = PANE_LIST.some((k) => paneState[k].selected.size);
  if (!dirty) return;
  for (const k of PANE_LIST) paneState[k].selected.clear();
  selected = curPane().selected;
  toast('筛选条件已变，已清空选择');
}

const BOOKMARKS_BAR_ID = '1';

/**
 * 勾中某个文件夹时，同一枝里"和它重复"的 ids：它的后代，以及它已经被覆盖的祖先。
 * 只在真正是文件夹 id 时才动手；书签 id 直接返回空。
 */
function folderBranchIds(id, sel) {
  const node = findFolderNode(folderTree, id);
  if (!node) return [];
  const out = [];
  (function walk(ns) {
    for (const n of ns || []) {
      if (sel.has(n.id)) out.push(n.id);
      if (!n.url) walk(n.children);
    }
  })(node.children);
  // 祖先也被选了：祖先那条同样覆盖本枝，留祖先即可
  let p = node.parentId ? findFolderNode(folderTree, node.parentId) : null;
  while (p) {
    if (sel.has(p.id)) out.push(p.id);
    p = p.parentId ? findFolderNode(folderTree, p.parentId) : null;
  }
  return out;
}

/** 选中集合拆成书签/文件夹两类（foldersFlat 里有的是文件夹） */
function splitSel(set) {
  const dirSet = new Set(foldersFlat.map((f) => f.id));
  const bmIds = [];
  const dirIds = [];
  for (const id of set) (dirSet.has(id) ? dirIds : bmIds).push(id);
  return { bmIds, dirIds };
}

function splitSelection() {
  return splitSel(selected);
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
    const shown = PANE_LIST.reduce((n, k) => n + paneState[k].visible.size, 0);
    text = `全部 ${c.all} · 未打标签 ${c.untagged} · 已打标签 ${c.tagged} ｜ 已显示 ${shown} 条${dual ? '（双窗两栏合计）' : ''}`;
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
    allBtn.title = '选中当前筛选下的全部书签（跨页）';
    allBtn.disabled = st.total === 0;
  }
  const pageBtn = $('#bmAllPage');
  if (pageBtn) {
    const tree = st.sort === 'tree';
    pageBtn.textContent = tree ? '全选可见' : '全选本页';
    pageBtn.disabled = tree ? curPane().visible.size === 0 : st.items.length === 0;
    pageBtn.title = tree ? `选中当前显示的 ${curPane().visible.size} 条（活动窗格里展开着的目录）` : `选中本页 ${st.items.length} 条`;
  }

  // 未选中时按钮变灰而不是消失：位置固定，鼠标不用追着按钮跑
  const needSel = selected.size > 0;
  for (const id of ['#bmAdd', '#bmRemove', '#bmDelete', '#bmClearSel', '#bmCopy', '#bmCut']) {
    const el = $(id);
    if (el) el.disabled = !needSel;
  }
  disarmDelete(); // 选中项变了、或删除已完成：武装态一律作废
  const tree = st.sort === 'tree';
  const orderEl = $('#bmOrder');
  if (orderEl) orderEl.hidden = tree; // 按目录模式固定树序，这组按钮没意义
  const orderHint = $('#bmOrderHint');
  if (orderHint) orderHint.hidden = tree;
  // 只在「按目录」里有意义的控件：平铺时整块隐藏，不留一排灰按钮让人以为坏了
  // （收起目录 / 双窗 / 新建文件夹 / 剪贴板三件 + 剪贴板分隔线）
  for (const id of ['#bmCollapse', '#bmDual', '#bmNewFolder', '#bmCopy', '#bmCut', '#bmPaste', '#bmClipSep']) {
    const el = $(id);
    if (el) el.hidden = !tree;
  }
  const nf = $('#bmNewFolder');
  if (nf) nf.disabled = !tree;
  const dualBtn = $('#bmDual');
  if (dualBtn) dualBtn.disabled = !tree;
  const collapseBtn = $('#bmCollapse');
  if (collapseBtn) collapseBtn.disabled = !tree;
  const paste = $('#bmPaste');
  if (paste) paste.disabled = !(tree && clip);
  // 中缝按钮：来源栏没选中就置灰
  const rail = $('#bmRail');
  if (rail) {
    for (const b of rail.querySelectorAll('[data-rail]')) {
      const src = b.dataset.side === 'toR' ? 'L' : 'R';
      b.disabled = paneState[src].selected.size === 0;
    }
  }
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
  // 双击标签云 chips 区的空白 = 清空查询框（复用 × 按钮同一条 input 事件链路，
  // 输入框文字、has 态、云高亮、列表一起复位）；点 chip 的双击不算
  $('#bmCloud').addEventListener('dblclick', (e) => {
    if (e.target.closest('.bm-cloud-chip')) return;
    if (!e.target.closest('.bm-cloud-row')) return;
    const input = $('#bmSearch');
    if (!input.value) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
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
    const ids = st.sort === 'tree' ? [...curPane().visible] : st.items.map((x) => x.id);
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
        // 平铺是全库范围：全选全部不该被"上次下钻的目录"偷偷限制
        folderId: st.sort === 'tree' ? st.folderId : '',
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
      // 自动展开目标目录，立刻看到新文件夹（活动窗格）
      curPane().dirOpen.add(parent);
      saveDirOpen(curPane());
      await refresh();
      toast(`已创建文件夹「${r.title}」`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#bmDelete').addEventListener('click', async () => {
    if (!selected.size) return;
    if (!armDelete()) return; // 第一次点击只上膛，第二次才真删
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
    // 换视图 = 换一批"看得见的对象"，旧的勾选留着只会让删除数字对不上号
    clearSelectionOnFilterChange();
    for (const k of PANE_LIST) paneState[k].autoCollapsed = new Set();
    $('#bmSort').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    refresh().catch((x) => toast(x.message, true));
  });

  // 平铺模式的行序：按目录（书签树序）或按标题；两种排序的选择集不变，不用清空
  $('#bmOrder').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-o]');
    if (!btn || btn.dataset.o === st.order) return;
    st.order = btn.dataset.o;
    st.offset = 0;
    $('#bmOrder').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    refresh().catch((x) => toast(x.message, true));
  });

  // 双窗开关（存本机）：只在按目录模式下生效
  // 收起目录：清空活动窗格的展开集（自动展开的也一起收），存本机后重渲染
  $('#bmCollapse').addEventListener('click', () => {
    if (st.sort !== 'tree') return;
    const pane = curPane();
    pane.dirOpen.clear();
    saveDirOpen(pane);
    render();
    toast(dual ? '活动窗格目录已全部收起' : '目录已全部收起');
  });

  $('#bmDual').addEventListener('click', () => {
    dual = !dual;
    $('#bmDual').classList.toggle('on', dual);
    chrome.storage.local.set({ 'bm.dual': dual });
    if (st.sort === 'tree') render();
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

/**
 * 「当前生效」条件条：把查询/搜索/筛选亮出来，并把失效的目录词标红给一键移除。
 * 起因：目录被改名或从两级合成一级后，查询框里残留的 @旧名 会让整页看起来"空了"，
 * 而树上的计数来自原始书签树，仍显示 58 条——用户完全看不出是查询在筛。
 */
async function syncFilterNote() {
  const el = $('#bmFilterNote');
  if (!el) return;
  // 当前下钻的目录是否被"排除"了：排除只影响标签云/查询，管理页照常显示，
  // 但必须说清楚，否则用户会以为目录坏了（一起在下方条件条里提示）
  const pane = paneState[activePane] || paneState.L;
  const fid = pane && pane.folderId ? String(pane.folderId) : '';
  const hit = fid ? treeCache.rows.get(fid) : null;
  const exclNode = hit && hit.folderExcluded ? findFolderNode(folderTree, fid) : null;
  const qTerms = (st.query || '').split(/\s+/).filter(Boolean);
  const dirTerms = qTerms.filter((p) => /^!?@/.test(p));
  let stale = [];
  if (dirTerms.length) {
    if (!fullDirs.length) {
      try {
        const s = await send({ type: 'state' });
        fullDirs = s.dirTags || [];
      } catch {}
    }
    const names = new Set(fullDirs.map((d) => String(d.tag).toLowerCase()));
    stale = dirTerms.filter((p) => {
      const n = p.replace(/^!?@/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase();
      return n && !names.has(n);
    });
  }
  el.textContent = '';
  const anyCond = !!(st.query || st.text || (st.filter && st.filter !== 'all'));
  if (!anyCond && !exclNode) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (exclNode) {
    const w = document.createElement('span');
    w.className = 'stale';
    w.textContent = `此目录已在标签管理页被排除：这里照常显示，但它不进标签云、也搜不到`;
    el.append(w);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost small';
    b.textContent = '恢复收录';
    b.title = '把这个目录重新放进标签体系（云、查询、统计都会回来）';
    b.addEventListener('click', async () => {
      try {
        await send({ type: 'dirs:exclude', tag: exclNode.title || '', excluded: false });
        invalidateTree();
        await refresh();
        await loadCloud();
        toast('已恢复收录');
      } catch (x) {
        toast(x.message, true);
      }
    });
    el.append(b);
  }
  const lab = document.createElement('span');
  lab.className = 'lab';
  lab.textContent = '当前生效：';
  el.append(lab);
  const cond = (code, title, onClear) => {
    const box = document.createElement('span');
    box.className = 'cond';
    const c = document.createElement('code');
    c.textContent = code;
    c.title = title;
    box.append(c);
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.textContent = '×';
    x.title = '移除这个条件';
    x.addEventListener('click', onClear);
    box.append(x);
    el.append(box);
  };
  if (st.query) cond(st.query, '查询表达式', () => setQueryValue(''));
  if (st.text) cond(`"${st.text}"`, '书签名/网址搜索', () => setTextValue(''));
  if (st.filter && st.filter !== 'all') {
    cond(st.filter === 'untagged' ? '未打标签' : '已打标签', '筛选', () => setFilterValue('all'));
  }
  if (stale.length) {
    const w = document.createElement('span');
    w.className = 'stale';
    w.textContent = `${stale.join('、')} 已不存在（目录被改名或移动了）`;
    el.append(w);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost small';
    b.textContent = '移除失效词';
    b.addEventListener('click', () => {
      const keep = qTerms.filter((p) => !stale.includes(p));
      setQueryValue(keep.join(' '));
    });
    el.append(b);
  }
}

/** 写回查询框并触发同一条链路（输入框文字、has 态、列表一起复位） */
function setQueryValue(v) {
  const input = $('#bmSearch');
  if (!input) return;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function setTextValue(v) {
  const input = $('#bmTextSearch');
  if (!input) return;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function setFilterValue(f) {
  const btn = $('#bmFilters') && $('#bmFilters').querySelector(`button[data-f="${f}"]`);
  if (btn) btn.click();
  else {
    st.filter = f;
    st.offset = 0;
    refresh().catch((x) => toast(x.message, true));
  }
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
    // 与侧边栏同一套着色：标签色做文字色，选中时 background: currentColor 反白
    b.style.color = colorFor(name, colors);
    if (isDir && st.sort === 'tree') {
      // 按目录模式里，目录标签 = 导航入口：
      //   已下钻 → 跳到这个目录（等价点面包屑，面包屑随之缩短）
      //   没下钻 → 在树里展开到它、把无关目录收起来，并滚到它那一行
      const pane = curPane();
      const chipId = dirIdForName(name, pane);
      const curPath = pane.folderId ? idToPath.get(pane.folderId) || '' : '';
      const chipPath = chipId ? idToPath.get(chipId) || '' : '';
      if (chipPath && curPath && (curPath === chipPath || curPath.startsWith(chipPath + PATH_SEP))) {
        b.classList.add('on'); // 当前目录，或当前目录的某一级祖先
      }
      b.title = `@${name}：${pane.folderId ? '跳到这个目录（不改变查询条件）' : '在树里展开定位到这个目录'}`;
      b.addEventListener('click', () => gotoDirChip(name));
    } else {
      if (active.has(name.toLowerCase())) b.classList.add('on');
      b.title = isDir ? `@${name}：该目录（含子级）里的书签` : `${tok}：带这个标签的书签`;
      b.addEventListener('click', () => toggleCloudToken(tok));
    }
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

/**
 * 目录标签是"文件夹名"级投影（一级一个名字），同名文件夹可能落在不同枝。
 * 解析顺序：当前下钻枝里的 → 当前枝的祖先 → 树里最早出现的那个。
 */
function dirIdForName(name, pane) {
  const key = String(name || '').toLowerCase();
  if (!key) return '';
  const cands = foldersFlat.filter((f) => String(f.title || '').toLowerCase() === key);
  if (!cands.length) return '';
  const base = pane && pane.folderId ? idToPath.get(pane.folderId) || '' : '';
  if (base) {
    const inside = cands.find((f) => f.path === base || f.path.startsWith(base + PATH_SEP));
    if (inside) return inside.id;
    const anc = cands.find((f) => base.startsWith(f.path + PATH_SEP));
    if (anc) return anc.id;
  }
  return cands[0].id;
}

/** 导航前把查询框里同名的 @目录 词摘掉：否则跳过去以后还被这条词二次收窄 */
function stripQueryDirToken(name) {
  const target = String(name || '').replace(/^[@#/?]/, '').toLowerCase();
  if (!target || !st.query) return;
  const parts = st.query.split(/\s+/).filter(Boolean);
  const keep = parts.filter((p) => {
    if (!p.startsWith('@')) return true;
    return p.replace(/^@/, '').replace(/^"/, '').replace(/"$/, '').toLowerCase() !== target;
  });
  const next = keep.join(' ');
  if (next === st.query) return;
  st.query = next;
  const input = $('#bmSearch');
  if (!input) return;
  input.value = next;
  const wrap = input.closest('.search');
  if (wrap) wrap.classList.toggle('has', !!next);
}

/** 树里展开到指定目录：打开它的祖先链，其它目录一律收起，滚到它那一行并闪一下 */
function focusDirInTree(pane, id) {
  const chain = [];
  let node = findFolderNode(folderTree, id);
  while (node) {
    chain.push(node.id);
    node = node.parentId ? findFolderNode(folderTree, node.parentId) : null;
  }
  pane.dirOpen = new Set(chain.filter((x) => !rootIds.has(x)));
  pane.autoOpen = new Set();
  pane.autoCollapsed = new Set();
  saveDirOpen(pane);
  st.offset = 0;
  refresh().then(() => {
    const key = PANE_LIST.find((k) => paneState[k] === pane) || 'L';
    const scroller = dual
      ? document.querySelector(`.bm-pane[data-pane="${key}"] .bm-pane-rows`)
      : document.querySelector('#bmRows');
    const row = (scroller || document).querySelector(`.bm-folder-row[data-id="${CSS.escape(String(id))}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
  }).catch((x) => toast(x.message, true));
}

/** 点目录标签：已下钻就跳过去，没下钻就在树里展开定位 */
async function gotoDirChip(name) {
  const pane = curPane();
  const id = dirIdForName(name, pane);
  if (!id) {
    toast(`找不到目录「${name}」：可能已改名或被排除`, true);
    return;
  }
  stripQueryDirToken(name);
  if (pane.folderId) {
    pane.folderId = id;
    if (paneState[activePane] === pane) st.folderId = pane.folderId;
    savePaneFolder();
    st.offset = 0;
    clearSelectionOnFilterChange();
    try {
      await refresh();
    } catch (x) {
      toast(x.message, true);
    }
    return;
  }
  focusDirInTree(pane, id);
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
  // 分页模式下按消失条数回退 offset，避免页尾删完跳到空页
  if (st.sort !== 'tree' && r && (r.trashed || r.purged)) {
    st.offset = Math.max(0, st.offset - (r.trashed || 0) - (r.purged || 0));
  }
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
    const o = await chrome.storage.local.get(['bm.dirOpen', 'bm.dirOpen.L', 'bm.dirOpen.R', 'bm.dual', 'bm.paneFolder', 'bm.railFrac']);
    if (o && o['bm.railFrac']) railFrac = Math.min(0.85, Math.max(0.15, Number(o['bm.railFrac']) || 0.5));
    const saved = (o && o['bm.colW']) || {};
    if (saved && (saved.t != null || saved.g != null) && !saved.flat) {
      // 旧版全局列宽：归给平铺视图，双窗两栏从默认开始
      colW = { flat: { t: Number(saved.t) || null, g: Number(saved.g) || null }, tree: { t: null, g: null }, L: { t: null, g: null }, R: { t: null, g: null } };
    } else {
      colW = {
        flat: { t: Number(saved.flat && saved.flat.t) || null, g: Number(saved.flat && saved.flat.g) || null },
        tree: { t: Number(saved.tree && saved.tree.t) || null, g: Number(saved.tree && saved.tree.g) || null },
        L: { t: Number(saved.L && saved.L.t) || null, g: Number(saved.L && saved.L.g) || null },
        R: { t: Number(saved.R && saved.R.t) || null, g: Number(saved.R && saved.R.g) || null },
      };
    }
    applyColW(document.querySelector('.bm-table'), 'flat');
    const outerHead = document.querySelector('.bm-table > .bm-head');
    if (outerHead && !outerHead._placeSplits) attachColSplit(outerHead, 'flat');
    dual = !!(o && o['bm.dual']);
    const btn = $('#bmDual');
    if (btn) btn.classList.toggle('on', dual);
    // 旧版单窗的展开集迁移给左栏
    const legacy = (o && o['bm.dirOpen']) || [];
    paneState.L.dirOpen = new Set(o && o['bm.dirOpen.L'] ? o['bm.dirOpen.L'] : legacy);
    paneState.R.dirOpen = new Set((o && o['bm.dirOpen.R']) || []);
    const pf = (o && o['bm.paneFolder']) || {};
    paneState.L.folderId = pf.L || '';
    paneState.R.folderId = pf.R || '';
    st.folderId = paneState.L.folderId;
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
