import { colorFor } from '../lib/palette.js';
import { insertTag, quoteTag } from '../lib/query.js';
import { splitTagInput, normalizeTagOrNull } from '../lib/title.js';

const $ = (sel) => document.querySelector(sel);
const PATH_SEP = String.fromCharCode(31); // 后台的目录路径分隔符（文件夹名里的 / 不会被当层级）
const qEl = $('#q');
const listEl = $('#list');
const cloudEl = $('#cloud');
const countEl = $('#count');
const suggestEl = $('#suggest');
const syntaxEl = $('#syntax');
const bulkEl = $('#bulk');
const bulkCountEl = $('#bulkCount');
const tagInput = $('#tagInput');
const toastEl = $('#toast');

const app = {
  expr: '',
  data: null,
  selected: new Set(),
  colors: {},
  prefs: {},
  allTags: [],
  dirTags: [],
  filterText: '',
  suggestIdx: -1,
  group: 'flat',        // 显示方式：'flat' 清单 / 'dir' 目录模式（全量分组 + 点标签跳转）
  allRows: null,        // 目录模式下的一份全库清单（不做任何筛选）
  allTotal: 0,
  foldersTree: null,    // 目录模式的文件夹树（folders:list）
  folderById: null,     // id → 节点
  folderParent: null,   // id → 上级 id
  rowsByParent: null,   // parentId → 该书签（按 seq 序）
  dragKey: null,        // 正在拖的书签 key
  jumpOnce: true,       // 下一次 run() 是否要"跳到第一处命中"（只有用户改查询时才置 true）
  grpCollapsed: new Set(), // 折叠的组（会话内有效，不落盘）
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r) throw new Error('后台无响应，试试重新加载扩展');
    if (r.error) throw new Error(r.error);
    return r;
  });
}

let toastTimer = null;
function toast(text, isErr = false) {
  toastEl.textContent = text;
  toastEl.className = 'toast' + (isErr ? ' err' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
}

// ---------------------------------------------------------------- 启动

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'app:changed') boot();
});

async function boot() {
  bindSplitters();
  await loadDensity();
  await loadGroup();
  app.allRows = null; // app:changed 会重新 boot，全量清单跟着重建
  app.foldersTree = null;
  try {
    const st = await send({ type: 'state' });
    app.colors = st.config.colors || {};
    app.prefs = st.prefs || {};
    app.allTags = st.tags || [];
    app.dirTags = st.dirTags || [];
    app.dirStats = st.dirStats || { folders: 0, deepFolders: 0, tags: 0 };
    $('#relatedOnly').checked = String(app.prefs.relatedOnly ?? '1') !== '0';
    app.dirEnabled = String(app.prefs.folderTags ?? '1') !== '0';
    renderDirPane(app.dirEnabled);
  } catch (e) {
    toast(e.message, true);
  }

  const saved = (await chrome.storage.local.get('panel.expr'))['panel.expr'];
  if (saved) qEl.value = saved;

  bind();
  await run();
}

function bind() {
  if (app.bound) return; // app:changed 会反复 boot()，监听只能挂一次
  app.bound = true;

  $('#foldBtn').addEventListener('click', () => {
    if (!app.foldIds) return;
    const ids = app.foldIds;
    const anyOpen = ids.some((id) => !app.grpCollapsed.has(id));
    app.grpCollapsed = anyOpen ? new Set(ids) : new Set();
    applyFoldBtn();
    renderList();
  });

  $('#groupBtn').addEventListener('click', () => {
    app.group = app.group === 'dir' ? 'flat' : 'dir';
    app.selected.clear(); // 换视图清空选择（与管理页同一条规则）
    applyGroupBtn();
    chrome.storage.local.set({ 'panel.group': app.group });
    if (app.group === 'dir') {
      app.jumpOnce = true; // 切进目录模式时按当前查询跳一次
      renderList();        // 先占位
      run();               // 取全量清单 + 按当前查询跳转
    } else {
      renderList();
    }
  });

  $('#densityBtn').addEventListener('click', () => {
    const i = DENSITY.indexOf(app.density);
    app.density = DENSITY[(i + 1) % DENSITY.length];
    applyDensity();
    chrome.storage.local.set({ 'panel.density': app.density });
  });
  let typing = null;
  qEl.addEventListener('input', () => {
    // 边打字边收窄两朵云：不等后台查询回来，纯前端过滤
    const cur = currentToken();
    app.filterText = cur ? cur.token.replace(/^[@#]/, '') : '';
    if (app.data) {
      renderCloud();
      renderDirPane(app.dirEnabled !== false);
    }
    updateSuggest();
    app.jumpOnce = true;
    clearTimeout(typing);
    typing = setTimeout(run, 160);
  });

  qEl.addEventListener('keydown', (e) => {
    if (!suggestEl.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSuggest(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSuggest(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSuggest();
        return;
      }
      if (e.key === 'Escape') {
        suggestEl.hidden = true;
        return;
      }
    }
    if (e.key === 'Escape') {
      // Esc = 逐词回退：砍掉最后一个 token
      const v = qEl.value.trim();
      if (!v) return;
      const cut = v.replace(/\s*(?:[,+&|]|-(?=\s|$))?\s*[^\s,+\-|&()!~?]+$/, '').trim();
      qEl.value = cut.replace(/[,+&|]$/, '').trim();
      app.jumpOnce = true;
      run();
    }
  });

  qEl.addEventListener('blur', () => setTimeout(() => (suggestEl.hidden = true), 120));

  const clearQuery = () => {
    qEl.value = '';
    // 编程式赋值不触发 input 事件，必须手动清掉云区收窄用的过滤词，
    // 否则清空输入后两朵云还按残留关键字过滤（表现为"没重置"）
    app.filterText = '';
    app.jumpOnce = true;
    run();
    qEl.focus();
  };
  $('#btnClear').addEventListener('click', clearQuery);

  // 双击云区空白处也清空输入（点到 chip/按钮/输入框不算）
  for (const id of ['cloud', 'dirCloud']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tag, button, input, a, label, .mini')) return;
      clearQuery();
    });
  }

  $('#btnSpace').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('space/space.html') });
  });

  $('#btnRebuild').addEventListener('click', async () => {
    try {
      const r = await send({ type: 'index:rebuild' });
      toast(`索引已重建：${r.counts.keys} 条书签 / ${r.counts.tags} 个标签`);
      await run();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#relatedOnly').addEventListener('change', run);
  // 全选 = 操作带勾选框：勾上选满当前列表，取消清空；半选状态由 updateBulk 维护
  $('#bulkAll').addEventListener('change', (e) => {
    const items = viewRows();
    app.selected.clear();
    if (e.target.checked) items.forEach((i) => app.selected.add(rowKey(i)));
    render();
  });

  bulkEl.addEventListener('click', async (e) => {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    const act = btn && btn.dataset.act;
    if (!act) return;
    try {
      await bulkAction(act, btn);
    } catch (err) {
      toast(err.message || '操作失败', true);
    }
  });

  tagInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tags = tagList(tagInput.value);
    if (!tags.length) return;
    await send({ type: 'tags:add', ids: selectedIds(), tags });
    tagInput.value = '';
    syncTagClear();
    await run();
    toast(`已为 ${app.selected.size} 条书签加标签`);
  });

  // 输入框 × 清除（与查询框同款交互）
  const syncTagClear = () => {
    $('#tagClear').style.display = tagInput.value ? 'block' : 'none';
  };
  tagInput.addEventListener('input', syncTagClear);
  $('#tagClear').addEventListener('click', () => {
    tagInput.value = '';
    syncTagClear();
    tagInput.focus();
  });
}

// ---------------------------------------------------------------- 查询

async function run() {
  app.expr = qEl.value;
  chrome.storage.local.set({ 'panel.expr': app.expr });
  $('#btnClear').style.display = app.expr ? 'block' : 'none';

  try {
    const data = await send({
      type: 'query',
      expr: app.expr,
      allTags: !$('#relatedOnly').checked,
    });
    app.data = data;
    if (data.allTags) app.allTags = data.allTags;

    // 选中集合跟着结果走：消失的 key 自动丢弃（目录模式按全库清，命中外的不算消失）
    const aliveRows = app.group === 'dir' ? (app.allRows || []) : data.items;
    if (aliveRows.length) {
      const alive = new Set(aliveRows.map((i) => rowKey(i)));
      for (const k of [...app.selected]) if (!alive.has(k)) app.selected.delete(k);
    }

    if (app.group === 'dir') await loadAllRows();
    render();
    // 只在"用户改了查询"那一次跳转。删除/移动/打标签后的重查若也跳，
    // 列表会突然展开并滚到别处（表现为"删一条就自动展开某个目录"）
    const doJump = app.jumpOnce;
    app.jumpOnce = false;
    if (doJump) jumpToFirstHit();
  } catch (e) {
    toast(e.message, true);
  }
}

function render() {
  renderSyntax();
  applyCloudMode();
  renderCloud();
  renderDirPane(app.dirEnabled !== false);
  renderList();
  updateBulk();
}

function renderSyntax() {
  const errs = (app.data && app.data.errors) || [];
  if (!errs.length) {
    syntaxEl.hidden = true;
    return;
  }
  syntaxEl.hidden = false;
  syntaxEl.textContent = errs
    .slice(0, 3)
    .map((e) => {
      if (e.reason === 'missing-paren') return '括号没有闭合，已按就近原则处理';
      if (e.reason === 'missing-operand') return `运算符 "${e.token}" 后面没有内容，已忽略`;
      if (e.reason === 'dangling-escape') return '末尾有一个多余的 \\';
      return `无法识别 "${e.token}"`;
    })
    .join(' · ');
}

function renderCloud() {
  const data = app.data;
  cloudEl.textContent = '';
  if (!data) return;

  const relatedOnly = $('#relatedOnly').checked;
  // 输入清空时立刻回到全量：上一轮结果的 related 是"旧查询"的，不能拿去窄化
  const list = (inputEmpty() && data.allTags && data.allTags.length
    ? data.allTags
    : (!relatedOnly && data.allTags && data.allTags.length ? data.allTags : data.related)) || [];
  const untaggedTotal = data.untaggedTotal || 0;
  if (!list.length && !untaggedTotal) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '这个条件下没有可继续收窄的标签';
    cloudEl.append(p);
    return;
  }

  const activeTags = new Set(data.queryTags || []);
  const LIMIT = 60;
  const needle = (app.filterText || '').toLowerCase();
  const filtered = needle ? list.filter((t) => t.tag.toLowerCase().includes(needle)) : list;

  filtered.slice(0, LIMIT).forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'tag' + (activeTags.has(t.tag.toLowerCase()) ? ' active' : '');
    btn.style.color = colorFor(t.tag, app.colors);
    btn.title = `${t.tag} · ${t.count} 条\n点击 = 与（AND）  Shift = 或（OR）  Alt = 非（NOT）  双击 = 只看这个`;

    const name = document.createElement('span');
    name.textContent = t.tag;
    const cnt = document.createElement('span');
    cnt.className = 'c';
    cnt.textContent = t.count;
    btn.append(name, cnt);

    btn.addEventListener('click', (e) => {
      const mode = e.altKey ? 'not' : e.shiftKey ? 'or' : 'and';
      applyTag(t.tag, mode, '#');
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      applyTag(t.tag, 'only', '#');
    });
    cloudEl.append(btn);
  });

  if (list.length > LIMIT) {
    const more = document.createElement('span');
    more.className = 'tag virtual';
    more.style.color = 'var(--text-dim)';
    more.textContent = `还有 ${list.length - LIMIT} 个…`;
    cloudEl.append(more);
  }

  if (untaggedTotal) {
    const btn = document.createElement('button');
    btn.className = 'tag virtual';
    btn.style.color = '#8a8f98';
    btn.title = '没有任何标签的书签';
    btn.textContent = `未打标签 ${untaggedTotal}`;
    btn.addEventListener('click', () => applyTag('未打标签', 'only'));
    cloudEl.append(btn);
  }

  // 「全部书签」紧挨着「未打标签」：清空查询 = 全部（打标签的 + 没打标签的一起列出来）
  const allTotal = (data.counts && data.counts.all) || 0;
  const allBtn = document.createElement('button');
  allBtn.className = 'tag virtual' + (inputEmpty() ? ' active' : '');
  allBtn.style.color = '#8a8f98';
  allBtn.title = '清空查询，列出全部书签（含未打标签）';
  allBtn.textContent = allTotal ? `全部书签 ${allTotal}` : '全部书签';
  allBtn.addEventListener('click', () => {
    qEl.value = '';
    app.filterText = '';
    app.jumpOnce = false; // 回到全量，不用跳转
    run();
  });
  cloudEl.append(allBtn);
}

function applyTag(tag, mode, prefix = '') {
  qEl.value = insertTag(qEl.value, tag, mode, prefix);
  app.jumpOnce = true;
  run();
}

// 目录标签一栏：prefs.folderTags 关掉就整栏隐藏，@查询也不再命中
function renderDirPane(enabled) {
  const pane = $('#dirPane');
  if (!pane) return;
  // 整栏永不隐藏：开关必须在任何时候都看得见，否则用户既看不到开关也看不到解释
  pane.hidden = false;
  pane.classList.toggle('off', !enabled);

  const box = $('#folderTags');
  if (box) {
    box.checked = enabled;
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.addEventListener('change', async () => {
        try {
          await send({ type: 'prefs:set', patch: { folderTags: box.checked ? '1' : '0' } });
          app.prefs.folderTags = box.checked ? '1' : '0';
          renderDirPane(box.checked);
          run();
        } catch (e) {
          toast(e.message, true);
        }
      });
    }
  }

  const el = $('#dirCloud');
  el.textContent = '';
  const cnt = $('#dirCount');
  const stats = app.dirStats || { folders: 0, deepFolders: 0, tags: 0 };
  const list = app.dirTags || [];
  // 选中任一目录后只留同一枝（祖先/后代/自身）的目录：不相关的实时隐藏，
  // 效果等同普通标签的「仅相关」，避免跨枝组合必然空结果
  const rel = inputEmpty() ? null : (app.data && app.data.dirRelated) || null;
  const activeDirs = inputEmpty() ? new Set() : new Set((app.data && app.data.queryDirs) || []);
  const relatedOnly = $('#relatedOnly').checked;
  // 没有目录参与查询时，「仅相关」用结果集里的目录；否则一律按同枝闭包收窄
  const baseList = rel
    ? list
    : (relatedOnly && !inputEmpty() && app.data && app.data.relatedDirs ? app.data.relatedDirs : list);
  const needle = (app.filterText || '').toLowerCase();
  let shown = rel ? list.filter((t) => rel.includes(t.key)) : baseList;
  if (needle) shown = shown.filter((t) => t.tag.toLowerCase().includes(needle));

  if (cnt) {
    if (!enabled) cnt.textContent = '· 已关闭';
    else if (!list.length) cnt.textContent = '';
    else {
      let text = shown.length !== list.length
        ? '· ' + shown.length + '/' + list.length + ' 相关'
        : '· ' + list.length;
      // 手写 @目录 绕过了 chip 隐藏：不拦、不弹窗，只在计数行点明"必然空"
      const qd = (app.data && app.data.queryDirs) || [];
      if (qd.length > 1 && app.data && !app.data.total) text += ' · 所选不同枝，交集为空';
      cnt.textContent = text;
    }
  }

  const say = (text) => {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = text;
    el.append(p);
  };

  if (!enabled) {
    // 关掉就整栏收起（标题行保留开关），不占任何额外空间
    return;
  }

  if (!shown.length) {
    if (!stats.deepFolders) {
      say('书签树里没有子文件夹（只有 书签栏 / 其他书签）。目录标签是从子文件夹名投影出来的——先在书签栏下建一个文件夹、放几条书签进去，这栏就会出现。');
    } else {
      say(`有 ${stats.deepFolders} 个子文件夹，但里面都没有书签（书签都直接挂在根上？）。目录标签只投影「含书签的文件夹」。`);
    }
    return;
  }

  // 目录 chip：点击注入 @文件夹，与普通标签同一套操作符语义
  shown.forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'tag dir' + (activeDirs.has(t.key) ? ' active' : '');
    btn.style.color = colorFor(t.tag, app.colors);
    btn.title = `${t.tag} · ${t.count} 条\n点击 = 与（AND，同名标签一并命中）  Shift = 或（OR）  Alt = 非（NOT）  双击 = 只看这个目录（@${t.tag}）`;
    const name = document.createElement('span');
    name.textContent = t.tag;
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = t.count;
    btn.append(name, c);
    btn.addEventListener('click', (e) => {
      const mode = e.altKey ? 'not' : e.shiftKey ? 'or' : 'and';
      applyTag(t.tag, mode, '@');
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      applyTag(t.tag, 'only', '@');
    });
    el.append(btn);
  });
}

async function loadAllRows() {
  if (app.allRows && app.foldersTree) return;
  const [r, f] = await Promise.all([
    send({ type: 'bookmarks:all' }),
    send({ type: 'folders:list' }),
  ]);
  app.allRows = r.items || [];
  app.allTotal = r.total || app.allRows.length;
  app.foldersTree = f.tree || [];
  buildFolderIndex();
}

function buildFolderIndex() {
  app.folderById = new Map();
  app.folderParent = new Map();
  const walk = (nodes, parentId) => {
    for (const n of nodes || []) {
      const id = String(n.id);
      app.folderById.set(id, n);
      app.folderParent.set(id, parentId ? String(parentId) : '');
      walk(n.children || [], id);
    }
  };
  walk(app.foldersTree, '');
  buildRowIndex();
  buildDisplayTree();
  const btn = $('#foldBtn');
  if (btn) btn.hidden = app.group !== 'dir';
  applyFoldBtn();
}

/**
 * 显示层：Chrome 的书签树是 (未命名根) → [书签栏, 其他书签] → 真正的文件夹。
 * 这里把根节点和这两个容器层"透明化"，直接从它们的孩子开始铺，路径也从这里起算。
 * 容器自己的直属书签收集到 looseRows，放在所有顶层文件夹之后渲染。
 */
function buildDisplayTree() {
  const cloneNode = (n, depth, parentPath) => {
    const path = n.title ? (parentPath ? `${parentPath}${PATH_SEP}${n.title}` : n.title) : parentPath;
    return {
      id: String(n.id),
      title: n.title || '',
      depth,
      path,
      count: n.count,
      total: n.total,
      children: (n.children || []).map((c) => cloneNode(c, depth + 1, path)),
    };
  };
  app.transparentIds = new Set();
  app.displayNodes = [];
  app.foldIds = [];
  for (const root of app.foldersTree || []) {
    for (const cont of root.children || []) {
      const cid = String(cont.id);
      app.transparentIds.add(cid);
      for (const child of cont.children || []) {
        const node = cloneNode(child, 0, '');
        app.displayNodes.push(node);
        collectIds(node);
      }
    }
  }
  function collectIds(node) {
    app.foldIds.push(String(node.id));
    for (const c of node.children || []) collectIds(c);
  }

  const seen = new Set();
  const collect = (node) => {
    seen.add(String(node.id));
    for (const c of node.children || []) collect(c);
  };
  for (const n of app.displayNodes) collect(n);

  // 没有被任何显示节点容纳的书签（容器直属 / 边角位置）也要露出来，不能凭空消失
  const loose = [];
  for (const row of app.allRows || []) {
    const pid = String(row.parentId ?? '');
    if (app.transparentIds.has(pid) || !app.folderById.has(pid) || !seen.has(pid)) loose.push(row);
  }
  loose.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  app.looseRows = loose;
}

/** 书签按父目录归堆，组内按书签树序（seq） */
function buildRowIndex() {
  const m = new Map();
  for (const r of app.allRows || []) {
    const pid = String(r.parentId ?? '');
    if (!m.has(pid)) m.set(pid, []);
    m.get(pid).push(r);
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  app.rowsByParent = m;
}

/** 目录模式：查询只用来"定位"，不去过滤列表 —— 滚到第一处命中（书签树里最靠前的那个）并闪一下 */
function jumpToFirstHit() {
  if (app.group !== 'dir') return;
  if (!app.allRows || !app.data || !app.data.items.length) return;

  // 命中的 key → 在全书签清单里找 seq 最小的那一行（树序最靠前，而不是标题序）
  const hit = new Set(app.data.items.map((i) => i.key));
  let target = null;
  for (const r of app.allRows) {
    if (!hit.has(r.key)) continue;
    if (!target || (r.seq ?? Infinity) < (target.seq ?? Infinity)) target = r;
  }
  if (!target) return;

  // 目标所在的目录链（含各级上级）全部展开，否则这一行根本没渲染
  let pid = String(target.parentId ?? '');
  let opened = false;
  while (pid) {
    if (app.grpCollapsed.has(pid)) { app.grpCollapsed.delete(pid); opened = true; }
    pid = (app.folderParent && app.folderParent.get(pid)) || '';
  }
  if (opened) {
    applyFoldBtn();
    renderList();
  }

  let row = null;
  for (const li of listEl.querySelectorAll('.row')) {
    if (li.dataset.key === target.key) { row = li; break; }
  }
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 900);
}

function renderList() {
  const data = app.data;
  listEl.textContent = '';

  // 目录模式：永远展示全部书签，查询只负责"跳到哪一行"
  if (app.group === 'dir') {
    const rows = app.allRows;
    if (!rows) {
      countEl.textContent = '加载全部书签…';
      return;
    }
    countEl.textContent = `${app.allTotal} 条（全部）${app.expr ? ' · 查询只跳转' : ''}`;
    if (!rows.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = '书签树是空的。';
      listEl.append(div);
      return;
    }
    const foldBtn = $('#foldBtn');
    if (foldBtn) foldBtn.hidden = false;
    if (app.foldersTree) renderTreeRows();
    return;
  }

  const foldBtn0 = $('#foldBtn');
  if (foldBtn0) foldBtn0.hidden = true;

  if (!data) {
    countEl.textContent = '加载中…';
    return;
  }

  const shown = data.items.length;
  countEl.textContent = data.total
    ? `${data.total} 条${data.truncated ? `（显示前 ${shown} 条）` : ''}`
    : '0 条';

  if (!data.items.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.innerHTML =
      '没有匹配的书签。<br>试试 <code>a, b</code> 交集、<code>a + b</code> 并集、<code>a - b</code> 排除、<code>?关键词</code> 搜标题。';
    listEl.append(div);
    return;
  }

  for (const item of data.items) listEl.append(renderRow(item));
}

/**
 * 目录模式：全库按文件夹树铺开。每个文件夹先出自己的下级文件夹，再出自己的书签；
 * 组头可折叠、可右键重命名，书签行可拖放到文件夹或另一条书签上。
 * 查询不参与过滤，只用来"跳到第一处命中"（见 jumpToFirstHit）。
 */
function renderTreeRows() {
  for (const node of app.displayNodes || []) renderFolderNode(node);
  for (const row of app.looseRows || []) listEl.append(renderRow(row));
}

function renderFolderNode(node) {
  listEl.append(renderFolderHead(node));
  const id = String(node.id);
  if (app.grpCollapsed.has(id)) return;
  for (const child of node.children || []) renderFolderNode(child); // 文件夹在前
  const rows = (app.rowsByParent && app.rowsByParent.get(id)) || [];
  for (const row of rows) listEl.append(renderRow(row));            // 书签在后
}

/** 组头文字：下级文件夹带上级路径，用反斜杠分隔（xx\xx\xx） */
function folderLabel(node) {
  const p = node.path ? String(node.path).split(PATH_SEP).join('\\') : node.title || '';
  return p || node.title || '（未命名）';
}

function renderFolderHead(node) {
  const id = String(node.id);
  const collapsed = app.grpCollapsed.has(id);
  const head = document.createElement('div');
  // 只有「展开且确实有内容」的目录才亮；收起的、空壳目录保持中性灰
  const hasRows = ((app.rowsByParent && app.rowsByParent.get(id)) || []).length > 0;
  const open = !collapsed && ((node.children || []).length > 0 || hasRows);
  head.className = 'grp'
    + (collapsed ? ' collapsed' : '')
    + (open ? ' grp-open' : '')
    + (node.depth === 0 ? ' grp-top' : '');
  head.dataset.folder = id;
  head.style.paddingLeft = '6px'; // 不做层级缩进，层级由路径标签体现
  head.title = `${folderLabel(node)} · ${node.total ?? 0} 条（右键可重命名）`;

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'grp-caret';
  caret.textContent = collapsed ? '▸' : '▾';
  caret.title = collapsed ? '展开' : '折叠';
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFolder(id);
  });

  const name = document.createElement('span');
  name.className = 'grp-name';
  name.textContent = folderLabel(node);

  const n = document.createElement('span');
  n.className = 'grp-n';
  n.textContent = `${node.total ?? 0} 条`;

  head.append(caret, name, n);
  head.addEventListener('click', () => toggleFolder(id));

  // 右键：重命名文件夹（就地改，Enter 提交、Esc 取消）
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtx(e.clientX, e.clientY, [{ label: '重命名文件夹', run: () => renameFolder(head, name, node) }]);
  });

  // 拖放：书签拖到这个文件夹上 = 移进去（追加到末尾）
  head.addEventListener('dragover', (e) => {
    if (!app.dragKey) return;
    e.preventDefault();
    head.classList.add('drop');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop'));
  head.addEventListener('drop', async (e) => {
    e.preventDefault();
    head.classList.remove('drop');
    await moveDragged({ parentId: id });
  });
  return head;
}

function toggleFolder(id) {
  if (app.grpCollapsed.has(id)) app.grpCollapsed.delete(id);
  else app.grpCollapsed.add(id);
  applyFoldBtn();
  renderList();
}

/** 折叠全部 / 展开全部 */
function applyFoldBtn() {
  const btn = $('#foldBtn');
  if (!btn || !app.displayNodes) return;
  const ids = app.foldIds || [];
  const anyOpen = ids.some((id) => !app.grpCollapsed.has(id));
  btn.textContent = anyOpen ? '折叠全部' : '展开全部';
  btn.hidden = app.group !== 'dir';
}

function renameFolder(head, nameEl, node) {
  const input = document.createElement('input');
  input.className = 'grp-rename';
  input.value = node.title || '';
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
  };
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(nameEl);
    if (!v || v === node.title) return;
    try {
      await send({ type: 'node:rename', id: String(node.id), title: v });
      await refreshAll();
      toast('已重命名文件夹');
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });
  input.addEventListener('blur', restore);
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** 某个目录下已有几个子文件夹（Chrome 的 index 把文件夹排在书签前面） */
function childFolderCount(parentId) {
  const node = app.folderById && app.folderById.get(String(parentId));
  return node && node.children ? node.children.length : 0;
}

async function moveDragged(target) {
  const key = app.dragKey;
  app.dragKey = null;
  if (!key) return;
  const row = (app.allRows || []).find((r) => r.key === key);
  if (!row) return;
  try {
    await send({
      type: 'bookmarks:move',
      ids: nodeIdsOf(row),
      parentId: target.parentId,
      ...(target.index == null ? {} : { index: target.index }),
    });
    await refreshAll();
  } catch (e) {
    toast(e.message, true);
  }
}

/** 拖放后重取整份数据（书签树变了，索引/文件夹计数都要重算） */
async function refreshAll() {
  app.allRows = null;
  app.foldersTree = null;
  app.selected.clear();
  await run();
}

// ---------------------------------------------------------------- 右键菜单（复制网址 / 重命名）
let ctxEl = null;
function closeCtx() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
  }
}
function openCtx(x, y, items) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx-menu';
  for (const it of items) {
    if (it === '-') {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
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

/** 复制网址：侧边栏可能没有输入焦点，clipboard API 失败就退回 textarea 选中复制 */
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

/** 行内重命名：只改干净标题，标签/指令串由后台 node:rename 原样保留 */
function renameRow(li, item) {
  const t = li.querySelector('.row-title');
  if (!t) return;
  const input = document.createElement('input');
  input.className = 'row-rename';
  input.value = item.title || '';
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
    if (!v || v === item.title) return;
    try {
      await send({ type: 'node:rename', id: nodeIdsOf(item)[0], title: v });
      await run(); // 重查一遍：标题/标签按新标题重建
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
 * 行在选择集里的身份。
 * 目录模式一行 = 一个书签节点，必须用节点 id：同一个网址存在多个文件夹时，
 * key（规范化 URL）相同，按 key 选会把"别的文件夹里的同一条"一起选上、
 * 一起删掉 —— 这就是"勾一条删掉好几条"的原因。
 * 清单模式一行 = 一个网址（一条 URL 只出现一次），沿用 key。
 */
function rowKey(item) {
  return app.group === 'dir' ? `d:${item.id}` : `k:${item.key}`;
}

/** 取这一行的书签节点 id：命中清单给的是 nodeIds，全库清单只有单个 id */
function nodeIdsOf(item) {
  if (item && item.nodeIds && item.nodeIds.length) return item.nodeIds;
  return item && item.id ? [item.id] : [];
}

function renderRow(item) {
  const li = document.createElement('li');
  li.className = 'row' + (app.selected.has(rowKey(item)) ? ' selected' : '');
  li.dataset.key = item.key;

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'pick';
  pick.checked = app.selected.has(rowKey(item));

  // 勾选统一走这里：点复选框、或点这一条的空白区，效果一致
  const setSelected = (on) => {
    pick.checked = on;
    if (on) app.selected.add(rowKey(item));
    else app.selected.delete(rowKey(item));
    li.classList.toggle('selected', on);
    updateBulk();
  };

  pick.addEventListener('change', () => setSelected(pick.checked));

  // 整行可点：只挡真正的交互件（复选框、标题按钮、单个 chip、徽标）；
  // 容器的空白区（标题右侧、chip 之间的缝隙）都落到行上，可用来勾选
  li.addEventListener('click', (e) => {
    if (e.target.closest('input, button, .chip, .badge')) return;
    if (String(window.getSelection())) return; // 正在选文字时不误触
    setSelected(!app.selected.has(rowKey(item)));
  });

  const main = document.createElement('div');
  main.className = 'row-main';

  const title = document.createElement('button');
  title.className = 'row-title';
  title.textContent = item.title || item.url;
  title.title = item.url;
  title.addEventListener('click', () => {
    const id = nodeIdsOf(item)[0];
    if (id) send({ type: 'open', ids: [id] });
    else if (item.url) chrome.tabs.create({ url: item.url }); // 兜底：直接按网址开
  });

  const url = document.createElement('div');
  url.className = 'row-url';
  url.textContent = prettyUrl(item.url);
  url.title = item.path || '';

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const tag of item.tags) chips.append(renderChip(item, tag));
  if (item.locations > 1) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = `${item.locations} 个位置`;
    chips.append(b);
  }

  main.append(title, url, chips);
  li.append(pick, main);
  // 拖放：自身可拖；拖到另一条书签上 = 插到它前面（同目录内排序 / 跨目录移动）
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    app.dragKey = item.key;
    li.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.key);
    }
  });
  li.addEventListener('dragend', () => {
    app.dragKey = null;
    li.classList.remove('dragging');
    for (const el of listEl.querySelectorAll('.drop')) el.classList.remove('drop');
  });
  li.addEventListener('dragover', (e) => {
    if (!app.dragKey || app.dragKey === item.key) return;
    e.preventDefault();
    li.classList.add('drop');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop'));
  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation(); // 别让文件夹组头也收到
    li.classList.remove('drop');
    if (!app.dragKey || app.dragKey === item.key) return;
    const pid = String(item.parentId ?? '');
    const arr = (app.rowsByParent && app.rowsByParent.get(pid)) || [];
    const pos = arr.findIndex((r) => r.key === item.key);
    // Chrome 的 index 把子文件夹排在书签前，所以要加上本目录的子文件夹数
    await moveDragged({ parentId: pid, index: childFolderCount(pid) + Math.max(pos, 0) });
  });

  // 右键：复制网址 / 重命名（标签保留）
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtx(e.clientX, e.clientY, [
      { label: '复制网址', run: () => copyUrl(item.url) },
      { label: '重命名（标签保留）', run: () => renameRow(li, item) },
    ]);
  });
  return li;
}

function renderChip(item, tag) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.style.color = colorFor(tag, app.colors);

  const name = document.createElement('span');
  name.textContent = tag;

  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  x.title = '摘掉这个标签';
  x.addEventListener('click', async (e) => {
    e.stopPropagation();
    await send({ type: 'tags:remove', ids: nodeIdsOf(item), tags: [tag] });
    await run();
    toast(`已摘掉 #${tag}`);
  });

  chip.append(name, x);
  return chip;
}

function prettyUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    return host + path + (u.search || '');
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------- 批量

/** 当前视图里的行：目录模式是全库清单，清单模式是命中清单 */
function viewRows() {
  if (app.group === 'dir') return app.allRows || [];
  return app.data ? app.data.items : [];
}

function selectedItems() {
  return viewRows().filter((i) => app.selected.has(rowKey(i)));
}

function selectedIds() {
  // 全库通道的行只带 id（没有 nodeIds），两种都要能取到
  return selectedItems().flatMap((i) => nodeIdsOf(i));
}

function updateBulk() {
  const n = app.selected.size;
  const total = viewRows().length;
  bulkCountEl.textContent = `已选 ${n}`;
  // 操作带常驻：无选中时动作按钮置灰，全选框反映当前选择状态
  for (const b of bulkEl.querySelectorAll('[data-act]')) b.disabled = !n;
  const all = $('#bulkAll');
  if (all) {
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
  }
  if (!n) disarm();
}

// 与书签管理页同一套切分/校验：空格/逗号分开、引号包住保留内部空格、非法名丢弃
const tagList = (input) =>
  splitTagInput(input)
    .map(normalizeTagOrNull)
    .filter(Boolean);

const ARM_TEXT = { clear: ['清空', '确认清空？'], delete: ['删除', '确认删除？'] };

// 侧边栏是内嵌视图，window.confirm 不弹窗、直接返回 false，用就地二次确认
function disarm() {
  clearTimeout(app.armTimer);
  app.armed = null;
  for (const [act, [idle]] of Object.entries(ARM_TEXT)) {
    const b = bulkEl.querySelector(`[data-act="${act}"]`);
    if (b) {
      b.textContent = idle;
      b.classList.remove('armed');
    }
  }
}

function armOrConfirm(act, btn) {
  if (app.armed === act) {
    disarm();
    return true;
  }
  disarm();
  app.armed = act;
  if (btn) {
    btn.textContent = ARM_TEXT[act][1];
    btn.classList.add('armed');
  }
  app.armTimer = setTimeout(disarm, 3000);
  toast('再点一次确认');
  return false;
}

async function bulkAction(act, btn) {
  const ids = selectedIds();
  if (!ids.length) return;

  if (act === 'clear' || act === 'delete') {
    if (!armOrConfirm(act, btn)) return;
  }

  if (act === 'add' || act === 'untag') {
    const tags = tagList(tagInput.value);
    if (!tags.length) {
      tagInput.focus();
      return toast('先在上面输入标签名');
    }
    const r = await send({ type: act === 'add' ? 'tags:add' : 'tags:remove', ids, tags });
    tagInput.value = '';
    await run();
    toast(`${act === 'add' ? '加标签' : '摘标签'}完成：改写 ${r.written} 条标题`);
    return;
  }

  if (act === 'clear') {
    const r = await send({ type: 'tags:clear', ids });
    await run();
    toast(`已清空：改写 ${r.written} 条标题`);
    return;
  }

  if (act === 'open') {
    await send({ type: 'open', ids });
    return;
  }

  if (act === 'delete') {
    let r = await send({ type: 'delete', ids });
    if (r.needTrash) {
      // 首次删除：先问回收站位置，同意默认位置后补删这批
      const ok = await askTrashSetup();
      if (!ok) return toast('已取消：先在管理页设置回收站');
      r = await send({ type: 'delete', ids });
    }
    app.selected.clear();
    await run();
    if (r.purged) toast(`已彻底删除 ${r.purged} 个书签`);
    else toast(`已移入回收站 ${r.trashed || 0} 个书签`);
  }
}

/** 首次删除的回收站设置询问：Promise<true|false>。默认位置一键创建，取消走管理页自定义 */
function askTrashSetup() {
  return new Promise((resolve) => {
    const box = $('#trashAsk');
    if (!box) return resolve(false);
    box.hidden = false;
    const yes = $('#trashYes');
    const no = $('#trashNo');
    const done = (v) => {
      box.hidden = true;
      yes.replaceWith(yes.cloneNode(true));
      no.replaceWith(no.cloneNode(true));
      resolve(v);
    };
    const onYes = async () => {
      yes.disabled = true;
      try {
        const r = await send({ type: 'trash:setup' });
        toast(`回收站：${r.path}`);
        done(true);
      } catch (e) {
        toast(e.message, true);
        done(false);
      }
    };
    yes.addEventListener('click', onYes, { once: true });
    no.addEventListener('click', () => done(false), { once: true });
  });
}

// ---------------------------------------------------------------- 补全

// ---------------------------------------------------------------- 行密度

const DENSITY = ['normal', 'compact', 'ultra'];
const DENSITY_LABEL = { normal: '标准', compact: '紧凑', ultra: '极简' };

function applyDensity() {
  document.body.dataset.density = app.density;
  const btn = $('#densityBtn');
  if (btn) btn.textContent = DENSITY_LABEL[app.density];
}

async function loadDensity() {
  let saved = 'normal';
  try {
    const o = await chrome.storage.local.get('panel.density');
    saved = o && o['panel.density'];
  } catch {}
  app.density = DENSITY.includes(saved) ? saved : 'normal';
  applyDensity();
}

// ---------------------------------------------------------------- 显示方式（清单 / 分组）

function applyGroupBtn() {
  const btn = $('#groupBtn');
  if (!btn) return;
  btn.textContent = app.group === 'dir' ? '目录' : '清单';
  btn.title = app.group === 'dir'
    ? '当前：目录模式（全部书签按目录分段；点标签只是跳到位置，不过滤）'
    : '当前：平铺清单（只显示命中；点此改为目录模式）';
}

async function loadGroup() {
  let saved = 'flat';
  try {
    const o = await chrome.storage.local.get('panel.group');
    saved = o && o['panel.group'];
  } catch {}
  app.group = saved === 'dir' ? 'dir' : 'flat';
  applyGroupBtn();
}

function inputEmpty() {
  return qEl.value.trim() === '';
}

function currentToken() {
  const m = /([^\s,+\-|&()!~?]+)$/.exec(qEl.value);
  if (!m) return null;
  return { token: m[1], start: m.index };
}

// 补全候选：标签与目录按名字合并成一条（同名不重复显示）
function suggestPool() {
  const map = new Map();
  const add = (item, kind) => {
    const k = item.tag.toLowerCase();
    let row = map.get(k);
    if (!row) {
      row = { tag: item.tag, count: 0, kinds: [] };
      map.set(k, row);
    }
    // 头数取两者较大值（并集去重后的真实数只有后台知道，不在此处相加虚高）
    row.count = Math.max(row.count, item.count);
    if (!row.kinds.includes(kind)) row.kinds.push(kind);
  };
  for (const t of app.allTags) add(t, 'tag');
  if (app.dirEnabled !== false) {
    for (const t of app.dirTags || []) {
      // 目录名含空格目前写不进 @查询（词法不认引号），先不进补全，避免插入坏表达式
      if (/\s/.test(t.tag)) continue;
      add(t, 'dir');
    }
  }
  return [...map.values()];
}

function updateSuggest() {
  const cur = currentToken();
  if (!cur) {
    suggestEl.hidden = true;
    return;
  }
  const dirIntent = cur.token.startsWith('@');
  const tagIntent = cur.token.startsWith('#');
  const needle = (dirIntent || tagIntent ? cur.token.slice(1) : cur.token).toLowerCase();
  if (!needle) {
    suggestEl.hidden = true;
    return;
  }

  const hits = suggestPool()
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

  if (!hits.length) {
    suggestEl.hidden = true;
    return;
  }
  app.suggestIdx = -1;
  suggestEl.textContent = '';
  hits.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'suggest-item';
    row.dataset.tag = t.tag;
    row.dataset.kind = cur.token.startsWith('@')
      ? 'dir'
      : cur.token.startsWith('#')
        ? 'tagOnly'
        : (t.kinds.length > 1 ? 'both' : t.kinds[0]);
    row.title = t.kinds.length > 1 ? '同名标签与目录，一并命中' : (t.kinds[0] === 'dir' ? '目录' : '标签');
    const name = document.createElement('span');
    name.textContent = t.tag;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = t.count;
    row.append(name, n);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertSuggestion(t.tag, cur.start, row.dataset.kind);
    });
    suggestEl.append(row);
  });
  suggestEl.hidden = false;
}

function moveSuggest(delta) {
  const rows = [...suggestEl.querySelectorAll('.suggest-item')];
  if (!rows.length) return;
  app.suggestIdx = (app.suggestIdx + delta + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('active', i === app.suggestIdx));
}

function acceptSuggest() {
  const rows = [...suggestEl.querySelectorAll('.suggest-item')];
  if (!rows.length) return;
  const idx = app.suggestIdx < 0 ? 0 : app.suggestIdx;
  const tag = rows[idx].dataset.tag;
  const kind = rows[idx].dataset.kind || 'tag';
  const cur = currentToken();
  insertSuggestion(tag, cur ? cur.start : qEl.value.length, kind);
}

function insertSuggestion(tag, start, kind = 'both') {
  const prefix = kind === 'dir' ? '@' : kind === 'tagOnly' ? '#' : '';
  qEl.value = qEl.value.slice(0, start) + prefix + quoteTag(tag) + ' ';
  suggestEl.hidden = true;
  qEl.focus();
  run();
}

// ---------------------------------------------------------------- 云区高度可调
/** 云高自适应：容器高度永远等于内容高度——刚好展示到最底下一行，差半行都不裁。
 *  动态收窄让有查询时云自然变小，结果列表始终可见；空查询时全展开（上限 60vh 防极端霸屏）。 */
function applyCloudMode() {
  for (const id of ['cloud', 'dirCloud']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.height = 'auto';
    el.style.maxHeight = '60vh';
    el.style.flex = '0 1 auto';
  }
}

function bindSplitters() {
  // 云高已完全自适应（等于内容高度），拖动分隔线退役
  applyCloudMode();
}

boot();
