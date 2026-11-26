import { colorFor } from '../lib/palette.js';
import { insertTag, quoteTag, hasTag } from '../lib/query.js';
import { splitTagInput, normalizeTagOrNull, tagKey } from '../lib/title.js';

const $ = (sel) => document.querySelector(sel);
const PATH_SEP = String.fromCharCode(31); // 后台的目录路径分隔符（文件夹名里的 / 不会被当层级）
const qEl = $('#q');
const qTextEl = $('#qText');   // 右侧纯文字框：只筛标题和网址，不参与标签语法
const listEl = $('#list');
const cloudEl = $('#cloud');
const countEl = $('#count');
const suggestEl = $('#suggest');
const syntaxEl = $('#syntax');
const bulkEl = $('#bulk');
const floatEl = $('#bulkFloat');
const bulkCountEl = $('#bulkCount');
const tagInput = $('#tagInput');
const tagMenuEl = $('#tagMenu');   // 点输入框弹出的已有标签候选
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
  pageLimit: 1000,      // 一次取多少条（滚到底自动往上加 1000）
  pendingLoad: false,   // 上一页被截断，列表末尾还有没取完的
  loadingMore: false,   // 正在自动加载下一页（防重复触发）
  listRows: 6,          // 列表保底几行（硬底线 6，拖动只能往上加；云区高度按内容自适应）
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
  // 先丢快照再干活：boot 里有一串 await，若拖到后面才清，
  // 同时进行的 bulkAction.run() 会抢先读到旧缓存，表现为"标签有时刷有时不刷"
  app.allRows = null;
  app.foldersTree = null;
  app.subtreeKeys = null;
  app.subtreeFolders = null;
  bindSplitters();
  await loadDensity();
  await loadListRows();
  bindCloudSplit();
  await loadGroup();
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

  const saved = await chrome.storage.local.get(['panel.expr', 'panel.text']);
  if (saved['panel.expr']) qEl.value = saved['panel.expr'];
  if (qTextEl && saved['panel.text']) qTextEl.value = saved['panel.text'];

  bind();
  await run();
}

function bind() {
  // 列表滚到底：上一页被截断就自动再拉一页，并保持当前滚动位置
  listEl.addEventListener('scroll', async () => {
    if (app.loadingMore || !app.pendingLoad) return;
    if (listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 240) return;
    app.loadingMore = true;
    const keep = listEl.scrollTop;
    app.pageLimit += 1000;
    try {
      await run();
    } finally {
      listEl.scrollTop = keep;
      app.loadingMore = false;
    }
  });

  if (app.bound) return; // app:changed 会反复 boot()，监听只能挂一次
  app.bound = true;

  // 图标按钮：载入时注入图标（HTML 里是空按钮，图标以 ACT_ICON 为准）
  for (const act of Object.keys(ACT_ICON)) {
    const b = document.querySelector(`.bulk [data-act="${act}"], .bulk-float [data-act="${act}"]`);
    paintAct(b, act, false);
  }

  $('#foldBtn').addEventListener('click', () => {
    if (!app.foldIds) return;
    const ids = app.foldIds;
    const anyOpen = ids.some((id) => !isGroupCollapsed(id));
    if (app.autoOpen) {
      // 查询期间只改临时展开集合：不然"折叠全部"会把平时的手动记忆一起改掉
      app.autoOpen = anyOpen ? new Set() : new Set(ids);
    } else {
      app.grpCollapsed = anyOpen ? new Set(ids) : new Set();
    }
    applyFoldBtn();
    renderList();
  });

  const segEl = $('#groupSeg');
  if (segEl) segEl.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (!b) return;
    const want = b.dataset.view === 'dir' ? 'dir' : 'flat';
    if (want === app.group) return; // 已经在这个视图，不用重跑
    app.group = want;
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
    refreshCloudSpace();
    chrome.storage.local.set({ 'panel.density': app.density });
  });
  let typing = null;
  qEl.addEventListener('input', () => {
    // 边打字边收窄两朵云：不等后台查询回来，纯前端过滤
    const cur = currentToken();
    app.filterText = cur ? cur.token.replace(/^[@#]/, '') : '';
    app.pageLimit = 1000;
    if (app.data) {
      renderCloud();
      renderDirPane(app.dirEnabled !== false);
      scheduleCloudLayout();
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
    app.pageLimit = 1000;
    app.jumpOnce = true;
    run();
    qEl.focus();
  };
  $('#btnClear').addEventListener('click', clearQuery);

  // 右侧文字框：普通输入，防抖重查；回车立即查；Esc 清空
  if (qTextEl) {
    let typingText = null;
    const syncTextClear = () => {
      const b = $('#btnTextClear');
      if (b) b.style.display = qTextEl.value ? 'block' : 'none';
    };
    syncTextClear();
    qTextEl.addEventListener('input', () => {
      syncTextClear();
      app.pageLimit = 1000;
      app.jumpOnce = true;
      clearTimeout(typingText);
      typingText = setTimeout(run, 160);
    });
    qTextEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(typingText);
        app.jumpOnce = true;
        run();
      } else if (e.key === 'Escape' && qTextEl.value) {
        qTextEl.value = '';
        syncTextClear();
        app.jumpOnce = true;
        run();
      }
    });
    const tb = $('#btnTextClear');
    if (tb) tb.addEventListener('click', () => {
      qTextEl.value = '';
      syncTextClear();
      app.jumpOnce = true;
      run();
      qTextEl.focus();
    });
  }

  // 双击云区空白处也清空输入（点到 chip/按钮/输入框不算）
  for (const id of ['cloud', 'dirCloud']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tag, button, input, a, label, .mini')) return;
      // 两个查询框一起清，单清左边会让人以为右边还留着条件
      if (qTextEl) {
        qTextEl.value = '';
        const tb = $('#btnTextClear');
        if (tb) tb.style.display = 'none';
      }
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
    if (e.target.checked) {
      items.forEach((i) => app.selected.add(rowKey(i)));
      // 目录也是可选对象：全选把当前列表里看得见的目录一并勾上（查询过滤时不越界）
      for (const head of listEl.querySelectorAll('.grp')) {
        if (head.dataset.folder) app.selected.add(folderKey(head.dataset.folder));
      }
    }
    render();
  });

  const onBulkClick = async (e) => {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    const act = btn && btn.dataset.act;
    if (!act) return;
    try {
      await bulkAction(act, btn);
    } catch (err) {
      toast(err.message || '操作失败', true);
    }
  };
  // 浮条（#bulkFloat）是操作带的子节点，点击自带冒泡，只在这里绑一次；
  // 绑两遍会让一次点击触发两遍 bulkAction，上膛的那次立刻被自己确认掉
  bulkEl.addEventListener('click', onBulkClick);

  tagInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tags = tagList(tagInput.value);
    if (!tags.length) return;
    if (!app.selected.size) {
      // 没有勾选时按 Enter 什么都不会发生，但也别把已经打好的字吃掉
      toast('先勾选书签，再加标签', true);
      return;
    }
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
  tagInput.addEventListener('input', () => {
    syncTagClear();
    if (tagMenuEl && !tagMenuEl.hidden) renderTagMenu(app.allTags || []);
  });
  if (tagMenuEl) {
    tagInput.addEventListener('focus', () => openTagMenu());
    // 鼠标一走开就收起；指针挪到候选框上时不收，便于点选
    tagInput.addEventListener('mouseenter', () => {
      holdTagMenu();
      // 收起后鼠标又回到框里，且焦点还在，就重新弹一次（否则得重新点一下）
      if (tagMenuEl.hidden && document.activeElement === tagInput) openTagMenu();
    });
    tagInput.addEventListener('mouseleave', () => {
      tagMenuHover = false;
      scheduleTagMenuClose();
    });
    tagMenuEl.addEventListener('mouseenter', holdTagMenu);
    tagMenuEl.addEventListener('mouseleave', () => {
      tagMenuHover = false;
      scheduleTagMenuClose();
    });
    tagInput.addEventListener('blur', () => scheduleTagMenuClose());
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !tagMenuEl.hidden) {
        e.stopPropagation();
        closeTagMenu();
      }
    });
    document.addEventListener('click', (e) => {
      if (tagMenuEl.hidden) return;
      const t = e.target;
      if (t === tagInput || (t.closest && t.closest('#tagMenu'))) return;
      closeTagMenu();
    });
  }
  $('#tagClear').addEventListener('click', () => {
    tagInput.value = '';
    syncTagClear();
    tagInput.focus();
  });
}

// ---------------------------------------------------------------- 查询

/** 右侧文字框转成查询里的 ?"..."，整句作为一个词组匹配，空格不会被当成并列词 */
function textQuery() {
  const t = (qTextEl && qTextEl.value ? qTextEl.value : '').trim();
  if (!t) return '';
  return '?"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 实际发给后台的表达式：两边都写就同时满足（隐式 AND） */
function buildExpr() {
  const tags = qEl.value.trim();
  const text = textQuery();
  if (!text) return qEl.value;
  return tags ? `${tags} ${text}` : text;
}

async function run() {
  app.expr = buildExpr();
  chrome.storage.local.set({ 'panel.expr': qEl.value, 'panel.text': qTextEl ? qTextEl.value : '' });
  $('#btnClear').style.display = qEl.value ? 'block' : 'none';

  try {
    const data = await send({
      type: 'query',
      expr: app.expr,
      limit: app.group === 'dir' ? 20000 : app.pageLimit,
      allTags: !$('#relatedOnly').checked,
    });
    app.data = data;
    if (data.allTags) app.allTags = data.allTags;

    // 选中集合跟着结果走：消失的 key 自动丢弃（目录模式按全库清，命中外的不算消失）
    const aliveRows = app.group === 'dir' ? (app.allRows || []) : data.items;
    if (aliveRows.length) {
      const alive = new Set(aliveRows.map((i) => rowKey(i)));
      // 目录也是选中对象：不放进 alive 集合的话，随便跑一次查询就会把勾选的目录清掉
      if (app.group === 'dir' && app.folderById) {
        for (const fid of app.folderById.keys()) alive.add(folderKey(fid));
      }
      for (const k of [...app.selected]) if (!alive.has(k)) app.selected.delete(k);
    }
    if (app.group !== 'dir') {
      for (const k of [...app.selected]) if (k.startsWith('f:')) app.selected.delete(k);
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
  scheduleCloudLayout();
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

  // 「全部书签」紧挨着「未打标签」：和它一样是虚拟标签，点了往查询框写 #全部书签，
  // 再点一次取消（框里清空，回到默认视图）
  const allTotal = (data.counts && data.counts.all) || 0;
  const allBtn = document.createElement('button');
  allBtn.className = 'tag virtual' + (hasTag(qEl.value, '全部书签', '') ? ' active' : '');
  allBtn.style.color = '#8a8f98';
  allBtn.title = '全部书签（含未打标签）；再点一次取消';
  allBtn.textContent = allTotal ? `全部书签 ${allTotal}` : '全部书签';
  allBtn.addEventListener('click', () => {
    app.filterText = '';
    // 已经是"只有 全部书签"时再点一次 = 取消，框回到空
    if (allBtn.classList.contains('active') && qEl.value.trim() === '全部书签') {
      qEl.value = '';
      app.pageLimit = 1000;
      app.jumpOnce = false;
      run();
      return;
    }
    applyTag('全部书签', 'only'); // 写纯文本「全部书签」，不带 #
  });
  cloudEl.append(allBtn);
}

function applyTag(tag, mode, prefix = '') {
  qEl.value = insertTag(qEl.value, tag, mode, prefix);
  app.pageLimit = 1000;
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
    btn.title = `${t.tag} · ${t.count} 条\n点击 = 与（AND，插入 @${t.tag}）  Shift = 或（OR）  Alt = 非（NOT）  双击 = 只看这个目录（@${t.tag}）`;
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
/** 行所属目录链上每一级文件夹的名字（小写），用于判断这行是否真的在某目录里 */
function folderNameKeys(parentId) {
  const out = [];
  let pid = String(parentId ?? '');
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const node = app.folderById && app.folderById.get(pid);
    if (node && node.title) out.push(tagKey(node.title));
    pid = (app.folderParent && app.folderParent.get(pid)) || '';
  }
  return out;
}

/** 这一行的某个上级目录名，正是查询里 @出来的目录 */
function rowInQueryDirs(row, dirs) {
  if (!dirs.size) return false;
  return folderNameKeys(row.parentId).some((k) => dirs.has(k));
}

/** 把某个目录连同它的所有子目录塞进集合（@目录 = 整枝命中） */
function addSubtreeIds(id, out) {
  const key = String(id ?? '');
  if (!key || out.has(key)) return;
  out.add(key);
  const node = app.folderById && app.folderById.get(key);
  for (const c of (node && node.children) || []) addSubtreeIds(String(c.id), out);
}

/** 目录 + 它各级祖先（要让命中的目录真的渲染出来，祖先必须展开） */
function addWithAncestors(id, out) {
  let cur = String(id ?? '');
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = (app.folderParent && app.folderParent.get(cur)) || '';
  }
}

/**
 * 目录是否处于收起状态。
 * 查询非空时有临时展开集合 app.autoOpen：不在里面的目录一律收起（视觉规则），
 * 但不写进 app.grpCollapsed，清空查询即回到用户手动调出来的样子。
 */
function isGroupCollapsed(id) {
  const key = String(id ?? '');
  // 查询期间以临时展开集合为唯一依据：不能再先看 grpCollapsed，
  // 否则"之前手动折叠过 / 点过折叠全部"的目录会一直是收起状态，
  // 既不会被命中展开，手动点也压不过它（点只改 autoOpen）。
  if (app.autoOpen) return !app.autoOpen.has(key);
  return app.grpCollapsed.has(key);
}

/** 这一行是否落在"整枝命中"的目录里（@目录 或命中行的上级） */
function rowInHitBranch(row) {
  if (!app.hitDirs || !app.hitDirs.size) return false;
  let pid = String(row.parentId ?? '');
  let guard = 0;
  while (pid && guard++ < 40) {
    if (app.hitDirs.has(pid)) return true;
    pid = (app.folderParent && app.folderParent.get(pid)) || '';
  }
  return false;
}

function jumpToFirstHit() {
  if (app.group !== 'dir') return;
  // 空查询不算"命中"：空查询返回的是全部已打标签的书签，
  // 以前会把它当成命中、把第一行闪起来，表现为"什么都没点却在闪"
  if (!String(app.expr || '').trim()) return;
  if (!app.allRows || !app.data || !app.data.items.length) return;

  // 命中的 key → 在全书签清单里找 seq 最小的那一行（树序最靠前，而不是标题序）
  const hit = new Set(app.data.items.map((i) => i.key));
  // 同一条 URL 可能同时躺在好几个目录里（key 按 URL 归一，目录标签是并集）。
  // 点了 @某目录 的 chip 时，优先跳"确实落在这个目录里"的那一份，
  // 否则会按树序跳到别处的同名书签，看起来像"跳错目录"。
  const dirs = new Set((app.data.queryDirs || []).filter(Boolean));
  const picks = [];
  for (const r of app.allRows) if (hit.has(r.key)) picks.push(r);
  const near = dirs.size ? picks.filter((r) => rowInQueryDirs(r, dirs)) : [];
  const pool = near.length ? near : picks;
  let target = null;
  for (const r of pool) {
    if (!target || (r.seq ?? Infinity) < (target.seq ?? Infinity)) target = r;
  }
  if (!target) return;

  // 展开交给 renderList 的临时展开集合（app.autoOpen），这里不再改用户手动的折叠状态

  let row = null;
  for (const li of listEl.querySelectorAll('.row')) {
    if (li.dataset.key === target.key) { row = li; break; }
  }
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
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
    countEl.textContent = `${app.allTotal} 条`;
    if (!rows.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = '书签树是空的。';
      listEl.append(div);
      return;
    }
    // 命中集合：只在查询非空时算（空查询一律不着色，否则整屏都是"命中"色）
    app.hitKeys = new Set();      // 命中的书签行
    app.hitFolders = new Set();   // 命中行所在的目录（组头亮）
    app.hitDirs = new Set();      // 查询 @出来的目录 → 整枝都要着色
    app.autoOpen = null;          // 非空查询时的临时展开集合（不写回手动折叠状态）
    if (String(app.expr || '').trim() && data && data.items && data.items.length) {
      const hit = new Set(data.items.map((i) => i.key));
      app.hitKeys = hit;
      for (const r of rows) {
        if (!hit.has(r.key)) continue;
        app.hitFolders.add(String(r.parentId ?? ''));
      }
      // 目录自身被查询命中（@目录 / 裸名命中同名目录）：整枝（含所有子目录）都算命中
      const qd = new Set((data.queryDirs || []).filter(Boolean));
      if (qd.size) {
        for (const [id, node] of app.folderById || []) {
          if (!qd.has(tagKey(node.title || ''))) continue;
          addSubtreeIds(id, app.hitDirs);
        }
      }
      // 临时展开：命中行所在目录 + 命中目录 + 它们各级祖先，其余一律收起
      app.autoOpen = new Set();
      for (const id of app.hitFolders) addWithAncestors(id, app.autoOpen);
      for (const id of app.hitDirs) addWithAncestors(id, app.autoOpen);
    }
    // 每个目录下（含各级子目录）有哪些后代目录：勾父目录要连带勾子目录
    app.subtreeFolders = new Map();
    for (const fid of (app.folderById ? app.folderById.keys() : [])) {
      let cur = String(fid);
      let guard = 0;
      while (cur && guard++ < 60) {
        let arr = app.subtreeFolders.get(cur);
        if (!arr) { arr = []; app.subtreeFolders.set(cur, arr); }
        if (!arr.includes(String(fid))) arr.push(String(fid));
        cur = (app.folderParent && app.folderParent.get(cur)) || '';
      }
    }
    // 每个目录下（含各级子目录）有哪些书签行：给文件夹勾选框用，一趟扫完
    app.subtreeKeys = new Map();
    for (const r of rows) {
      const k = rowKey(r);
      let pid = String(r.parentId ?? '');
      let guard = 0;
      while (pid && guard++ < 60) {
        let arr = app.subtreeKeys.get(pid);
        if (!arr) { arr = []; app.subtreeKeys.set(pid, arr); }
        arr.push(k);
        pid = (app.folderParent && app.folderParent.get(pid)) || '';
      }
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
  // 条数按"有多少书签就多少"：data.nodes 是命中网址展开成书签节点的条数，
  // data.total 是去重后的网址行数，两者不同时，以实物条数为准
  const total = Number.isFinite(data.nodes) ? data.nodes : (data.total || 0);
  countEl.textContent = total
    ? `${total} 条${data.truncated ? `（列表显示前 ${shown} 行）` : ''}`
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

  // 还没取完：末尾放一条"载入中…"提示，滚到它就自动再拉一页（没有按钮）
  if (data.truncated) {
    const tail = document.createElement('div');
    tail.className = 'load-more';
    tail.textContent = `载入中…（已 ${data.items.length} / 共 ${data.total} 条）`;
    listEl.append(tail);
    app.pendingLoad = true;
  } else {
    app.pendingLoad = false;
  }
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
  if (isGroupCollapsed(id)) return;
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
  const collapsed = isGroupCollapsed(id);
  const head = document.createElement('div');
  // 只有「展开且确实有内容」的目录才亮；收起的、空壳目录保持中性灰
  const hasRows = ((app.rowsByParent && app.rowsByParent.get(id)) || []).length > 0;
  const open = !collapsed && ((node.children || []).length > 0 || hasRows);
  // 命中：这一层有命中行，或整个目录被 @查询 点名（整枝命中）
  const isHit = !!((app.hitFolders && app.hitFolders.has(id))
    || (app.hitDirs && app.hitDirs.has(id)));
  head.className = 'grp'
    + (collapsed ? ' collapsed' : '')
    + (open ? ' grp-open' : '')
    + (isHit ? ' grp-hit' : '')
    + (branchKeys(id).some((k) => app.selected.has(k)) ? ' on' : '')
    + (node.depth === 0 ? ' grp-top' : '');
  head.dataset.folder = id;
  head.style.paddingLeft = '6px'; // 不做层级缩进，层级由路径标签体现
  head.title = `${folderLabel(node)} · ${node.total ?? 0} 条（右键可重命名）`;

  // 文件夹勾选框：勾上 = 这一枝（目录自己 + 各级子目录 + 里面所有书签）全选中，取消 = 全取消
  const branch = branchKeys(id);
  const picked = branch.filter((k) => app.selected.has(k)).length;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'grp-cb';
  cb.checked = branch.length > 0 && picked === branch.length;
  cb.indeterminate = picked > 0 && picked < branch.length;
  cb.title = branch.length
    ? `勾选这个目录（含子目录与 ${branch.length - 1} 个下级对象）——删除会把整个目录移到回收站`
    : '勾选这个空目录——删除会把它移到回收站';
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    setBranchSelected(id, cb.checked);
    syncRowHighlights();
    updateBulk();
  });

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'grp-caret';
  // 三角不再用字体字符（字形的墨迹不居中，放多大都会和目录名错开半行），
  // 改成 CSS 画的纯几何三角，由 .collapsed 决定朝向
  caret.textContent = '';
  caret.setAttribute('aria-label', collapsed ? '展开目录' : '折叠目录');
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

  head.append(cb, caret, name, n);
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
  const key = String(id ?? '');
  const collapsedNow = isGroupCollapsed(key);
  if (app.autoOpen) {
    // 查询期间的展开是临时的：手动点只改这份临时集合，不污染平时的手动折叠记忆
    if (collapsedNow) app.autoOpen.add(key);
    else app.autoOpen.delete(key);
  } else if (app.grpCollapsed.has(key)) {
    app.grpCollapsed.delete(key);
  } else {
    app.grpCollapsed.add(key);
  }
  applyFoldBtn();
  renderList();
}

/** 折叠全部 / 展开全部 */
function applyFoldBtn() {
  const btn = $('#foldBtn');
  if (!btn || !app.displayNodes) return;
  const ids = app.foldIds || [];
  const anyOpen = ids.some((id) => !isGroupCollapsed(id));
  const label = anyOpen ? '折叠全部' : '展开全部';
  btn.title = label;
  btn.setAttribute('aria-label', label);
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
  app.selected.clear();
  await reloadRows();
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
  const hit = !!(app.hitKeys && app.hitKeys.has(item.key));
  const inHitBranch = !hit && rowInHitBranch(item);
  li.className = 'row'
    + (app.selected.has(rowKey(item)) ? ' selected' : '')
    + (hit ? ' hit' : inHitBranch ? ' hit-in' : '');
  li.dataset.key = item.key;
  li.dataset.rowKey = rowKey(item);

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
      { label: '编辑网址', run: () => editRowUrl(li, item) },
      { label: '重命名（标签保留）', run: () => renameRow(li, item) },
    ]);
  });
  return li;
}

/** 编辑网址：像重命名一样就地替换 .row-url，回车保存、Esc 取消 */
function editRowUrl(li, item) {
  const u = li.querySelector('.row-url');
  if (!u) return;
  const input = document.createElement('input');
  input.className = 'row-rename';
  input.value = item.url || '';
  input.spellcheck = false;
  u.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    input.replaceWith(u);
  };
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(u);
    if (!v || v === item.url) return;
    try {
      await send({ type: 'node:url', id: nodeIdsOf(item)[0], url: v });
      await run();
      toast('已更新网址');
    } catch (e) {
      toast(e.message || '保存失败', true);
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', cancel);
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
  // 摘标签会改写书签标题、没有撤销，所以点一次只上膛，3 秒内再点才真的摘
  let armed = false;
  let armTimer = 0;
  const resetChip = () => {
    armed = false;
    clearTimeout(armTimer);
    chip.classList.remove('armed');
    x.textContent = '×';
    x.title = '摘掉这个标签';
  };
  x.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      chip.classList.add('armed');
      x.textContent = '确认';
      x.title = '再点一次确认摘掉';
      armTimer = setTimeout(resetChip, 3000);
      return;
    }
    resetChip();
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

const folderKey = (id) => `f:${String(id ?? '')}`;

/** 选中的目录（勾的是目录本身，不是它里面的书签） */
function selectedFolderIds() {
  return [...app.selected].filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
}

/**
 * 一个目录"整枝"的选择键：目录自己 + 各级子目录 + 里面所有书签行。
 * 勾一个目录 = 把这一串全部纳入选择，让"是目录还是书签"在选中集里同时成立。
 */
function branchKeys(id) {
  const fid = String(id ?? '');
  const out = [folderKey(fid)];
  for (const c of (app.subtreeFolders && app.subtreeFolders.get(fid)) || []) {
    const ck = folderKey(c);
    if (!out.includes(ck)) out.push(ck);
  }
  for (const k of (app.subtreeKeys && app.subtreeKeys.get(fid)) || []) out.push(k);
  return out;
}

/** 整枝一起加/取消（勾父目录时子目录跟着勾，取消跟着取消） */
function setBranchSelected(id, on) {
  for (const k of branchKeys(id)) {
    if (on) app.selected.add(k);
    else app.selected.delete(k);
  }
}

/**
 * 最上层被勾选的目录：子目录已经随父目录一起搬，不再单独发。
 * 删除时若把父子目录都发过去，后台会重复搬同一棵子树。
 */
function selectedTopFolders() {
  const sel = selectedFolderIds();
  const set = new Set(sel);
  return sel.filter((fid) => {
    let p = app.folderParent && app.folderParent.get(fid);
    let guard = 0;
    while (p && guard++ < 60) {
      if (set.has(String(p))) return false;
      p = app.folderParent.get(p);
    }
    return true;
  });
}

/** 删除的最小集：最上层目录 + 不落在这些目录里的书签（避免同一条被搬两次） */
function deletableTargets() {
  const folders = selectedTopFolders();
  const covered = new Set();
  for (const fid of folders) {
    for (const k of (app.subtreeKeys && app.subtreeKeys.get(fid)) || []) covered.add(k);
  }
  const bookmarks = selectedItems()
    .filter((i) => !covered.has(rowKey(i)))
    .flatMap((i) => nodeIdsOf(i));
  return { folders, bookmarks };
}

/** 数据已被后台改写（标签/删除/移动）：丢掉全库快照整份重取，否则列表拿旧标题渲染 */
async function reloadRows() {
  app.allRows = null;
  app.foldersTree = null;
  app.subtreeKeys = null;
  app.subtreeFolders = null;
  await run();
}

// 勾选变化后只改行的高亮，不重建列表（重建会把滚动位置弹回去）
function syncRowHighlights() {
  for (const li of listEl.querySelectorAll('li.row')) {
    const k = li.dataset.rowKey;
    if (!k) continue;
    const on = app.selected.has(k);
    li.classList.toggle('selected', on);
    // 行内复选框也要跟着变：勾目录级联选中的书签，不能只染色不勾盒子
    const pick = li.querySelector('input.pick');
    if (pick) {
      pick.checked = on;
      pick.indeterminate = false;
    }
  }
}

// 文件夹勾选框的三态：跟着当前选择重算（不重建 DOM）
// 判定单位是整枝：子目录或书签只选了一部分时显示半选
function syncGroupChecks() {
  if (!app.subtreeKeys) return;
  for (const head of listEl.querySelectorAll('.grp')) {
    const cb = head.querySelector('.grp-cb');
    if (!cb) continue;
    const branch = branchKeys(head.dataset.folder ?? '');
    const picked = branch.filter((k) => app.selected.has(k)).length;
    cb.checked = branch.length > 0 && picked === branch.length;
    cb.indeterminate = picked > 0 && picked < branch.length;
    head.classList.toggle('on', picked > 0);
  }
}

let toastSelTimer = 0;
/** 选中变化的报数：去抖 260ms，连点几下只报最后一次 */
function toastSel(text) {
  clearTimeout(toastSelTimer);
  toastSelTimer = setTimeout(() => toast(text), 260);
}

function updateBulk() {
  // 书签和目录分开数：混在一起会让人把目录当成书签条数
  let marks = 0, dirs = 0;
  for (const k of app.selected) {
    if (k.startsWith('f:')) dirs++;
    else marks++;
  }
  const n = marks + dirs;
  const total = viewRows().length;
  // 计数改成 toast：常驻一条「已选 N 条 + M 个目录」会挤掉右边的按钮
  bulkCountEl.hidden = true;
  bulkCountEl.textContent = dirs ? `已选 ${marks} 条 + ${dirs} 个目录` : `已选 ${marks}`;
  if (n) toastSel(dirs ? `已勾选 ${marks} 条书签 + ${dirs} 个目录` : `已勾选 ${marks} 条书签`);
  // 动作行固定在一行里：不再按选中数显示/隐藏，免得整块高度来回跳
  const float = $('#bulkFloat');
  if (float && float.hidden) float.hidden = false;
  // 无选中时动作按钮置灰，全选框反映当前选择状态
  for (const b of document.querySelectorAll('.bulk [data-act], .bulk-float [data-act]')) b.disabled = !n;
  const all = $('#bulkAll');
  if (all) {
    all.checked = total > 0 && marks === total;
    all.indeterminate = n > 0 && !all.checked;
  }
  if (!n) disarm();
  syncGroupChecks();
}

// 与书签管理页同一套切分/校验：空格/逗号分开、引号包住保留内部空格、非法名丢弃
const tagList = (input) =>
  splitTagInput(input)
    .map(normalizeTagOrNull)
    .filter(Boolean);

// 批量动作的图标（HTML 里只放空按钮，图标在这里统一注入：
 // 上膛时要把图标换成"确认"两字，收起时再换回来，图标必须有唯一来源）
const ARM_TEXT = {
  clear: ['清空', '确认清空？'],
  delete: ['删除', '确认删除？'],
  untag: ['摘', '确认摘掉？'],
};

const ACT_ICON = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  untag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h7l7 7-6 6-7-7V5z"/><path d="M15 13l3 3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>',
};

/** 五个动作的常驻名字：加、打开这两件不需要二次确认，没有 ARM_TEXT */
const ACT_LABEL = {
  add: '加标签',
  untag: '摘标签',
  clear: '清空标签',
  open: '打开书签',
  delete: '删除到回收站',
};

/** 动作按钮的状态画一次：常态是图标，上膛是"确认"两字 + 红底 */
function paintAct(btn, act, armed) {
  if (!btn || !ACT_ICON[act]) return;
  const arm = ARM_TEXT[act];
  const label = armed && arm ? arm[1] : (ACT_LABEL[act] || act);
  btn.classList.toggle('armed', !!(armed && arm));
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = armed && arm ? '确认' : ACT_ICON[act];
}

// 侧边栏是内嵌视图，window.confirm 不弹窗、直接返回 false，用就地二次确认
function disarm() {
  clearTimeout(app.armTimer);
  app.armed = null;
  for (const act of Object.keys(ARM_TEXT)) {
    const b = document.querySelector(`.bulk [data-act="${act}"], .bulk-float [data-act="${act}"]`);
    paintAct(b, act, false);
  }
}

function armOrConfirm(act, btn) {
  if (app.armed === act) {
    // 同一次点击的重复派发不能既上膛又确认，否则等于没有确认
    if (Date.now() - (app.armedAt || 0) < 300) {
      toast('再点一次确认');
      return false;
    }
    disarm();
    return true;
  }
  disarm();
  app.armed = act;
  app.armedAt = Date.now();
  if (btn) paintAct(btn, act, true);
  app.armTimer = setTimeout(disarm, 3000);
  toast('再点一次确认');
  return false;
}

async function bulkAction(act, btn) {
  if (act === 'unselect') {
    app.selected.clear();
    return render();
  }
  const fids = selectedFolderIds();
  const ids = selectedIds();
  if (!ids.length && !fids.length) return;

  if (act === 'add' || act === 'untag') {
    const tags = tagList(tagInput.value);
    if (!tags.length) {
      tagInput.focus();
      return toast('先在左侧输入标签名');
    }
    // 目录只是选中容器：加/摘标签一律忽略目录，只写书签
    if (!ids.length) return toast(act === 'add'
      ? '选中的都是空目录：没有可加标签的书签'
      : '选中的都是空目录：没有可摘标签的书签');
    // 批量摘会一次改写很多条书签标题，同样要再点一次确认（输入框里的标签保留着）
    if (act === 'untag' && !armOrConfirm(act, btn)) return;
    const r = await send({ type: act === 'add' ? 'tags:add' : 'tags:remove', ids, tags });
    tagInput.value = '';
    await reloadRows();
    toast(`${act === 'add' ? '加标签' : '摘标签'}完成：改写 ${r.written} 条标题`);
    return;
  }

  if (act === 'clear') {
    if (!ids.length) return toast('选中的都是空目录：没有可清空标签的书签');
    if (!armOrConfirm(act, btn)) return;
    const r = await send({ type: 'tags:clear', ids });
    await reloadRows();
    toast(`已清空：改写 ${r.written} 条标题`);
    return;
  }

  if (act === 'open') {
    if (!ids.length) return toast('选中的都是空目录：没有可打开的书签');
    await send({ type: 'open', ids });
    return;
  }

  if (act === 'delete') {
    if (!armOrConfirm(act, btn)) return;
    // 只发最小集：最上层目录（整枝搬走）+ 不落在这些目录里的书签
    const { folders, bookmarks } = deletableTargets();
    if (!folders.length && !bookmarks.length) return toast('没有可删除的对象');
    let r = await send({ type: 'delete', ids: folders.concat(bookmarks) });
    if (r.needTrash) {
      // 首次删除：先问回收站位置，同意默认位置后补删这批
      const ok = await askTrashSetup();
      if (!ok) return toast('已取消：先在管理页设置回收站');
      r = await send({ type: 'delete', ids: folders.concat(bookmarks) });
    }
    app.selected.clear();
    await reloadRows();
    const what = folders.length ? `（含 ${folders.length} 个目录）` : '';
    if (r.purged) toast(`已彻底删除 ${r.purged} 项${what}`);
    else toast(`已移入回收站 ${r.trashed || 0} 项${what}`);
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

// ---------------------------------------------------------------- 批量打标签的候选框

/** 输入框里最后一个词：只按它过滤候选，前面已经定下来的标签不参与 */
function tagMenuNeedle() {
  const m = /([^\s,]+)$/.exec(tagInput.value || '');
  return m ? m[1].replace(/"/g, '').toLowerCase() : '';
}

let tagMenuTimer = 0;
let tagMenuHover = false;

function closeTagMenu() {
  clearTimeout(tagMenuTimer);
  tagMenuHover = false;
  if (tagMenuEl) tagMenuEl.hidden = true;
}

/** 鼠标离开输入框和候选框后延时收起：留 280ms 跨过两者之间那道缝，
 *  指针在延时内进到候选框就把这一趟取消掉 */
function scheduleTagMenuClose() {
  clearTimeout(tagMenuTimer);
  tagMenuTimer = setTimeout(() => {
    if (!tagMenuHover) closeTagMenu();
  }, 280);
}

function holdTagMenu() {
  tagMenuHover = true;
  clearTimeout(tagMenuTimer);
}

function renderTagMenu(list) {
  if (!tagMenuEl) return;
  const needle = tagMenuNeedle();
  const src = list || [];
  const shown = (needle ? src.filter((t) => String(t.tag).toLowerCase().includes(needle)) : src).slice(0, 80);
  tagMenuEl.textContent = '';
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
    b.className = 'tag tm-tag';
    b.style.color = colorFor(t.tag, app.colors);
    b.title = `${t.tag} · ${t.count} 条`;
    const name = document.createElement('span');
    name.textContent = t.tag;
    const cnt = document.createElement('span');
    cnt.className = 'c';
    cnt.textContent = t.count;
    b.append(name, cnt);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 别让输入框先失焦，否则框跟着关
    b.addEventListener('click', () => insertMenuTag(t.tag));
    tagMenuEl.append(b);
  }
}

/** 选中一个候选：替换正在输入的那个词，接在后面 */
function insertMenuTag(tag) {
  const cur = tagInput.value || '';
  const m = /([^\s,]*)$/.exec(cur);
  const head = m ? cur.slice(0, m.index) : cur;
  const sep = head && !/[\s,]$/.test(head) ? ' ' : '';
  tagInput.value = head + sep + quoteTag(tag) + ' ';
  const tc = $('#tagClear');
  if (tc) tc.style.display = 'block';
  tagInput.focus();
  // 连续打多个标签时框不关：重画一遍，过滤词跟着清空
  renderTagMenu(app.allTags || []);
}

async function ensureTagList() {
  if (app.allTags && app.allTags.length) return app.allTags;
  try {
    const d = await send({ type: 'query', expr: '', limit: 40, allTags: true });
    if (d && d.allTags) app.allTags = d.allTags;
  } catch { /* 取不到就显示空列表，不影响手动输入 */ }
  return app.allTags || [];
}

async function openTagMenu() {
  if (!tagMenuEl) return;
  renderTagMenu(await ensureTagList());
  tagMenuEl.hidden = false;
  // 贴在输入框下沿；宽度跟着面板走，别超出右边界
  const r = tagInput.getBoundingClientRect();
  const vw = window.innerWidth || 420;
  const w = Math.min(268, Math.max(180, vw - 16));
  tagMenuEl.style.width = `${w}px`;
  tagMenuEl.style.left = `${Math.round(Math.max(8, Math.min(r.left || 0, vw - w - 8)))}px`;
  tagMenuEl.style.top = `${Math.round((r.bottom || 0) + 4)}px`;
}

// ---------------------------------------------------------------- 补全

// ---------------------------------------------------------------- 行密度

const LIST_ROWS_KEY = 'panel.listRows';
const LIST_ROWS_DEFAULT = 6;
const LIST_ROWS_MIN = 2; // 默认保底 6 行；想临时多给云，拖分隔条可以压到 2 行
const LIST_ROWS_MAX = 14;

/** 列表行的大致高度：量不到真实行时按密度估 */
function estimateRowHeight() {
  if (app.density === 'compact') return 38;
  if (app.density === 'ultra') return 32;
  return 46;
}

/** 云区 + 列表之外那些固定件到底占多高（标题栏、查询框、语法提示、操作带、分隔条） */
function fixedChrome() {
  let h = 0;
  for (const sel of ['.bar', '.query', '#syntax', '#bulk', '#cloudSplit']) {
    const el = $(sel);
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    h += r.height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  const body = getComputedStyle(document.body);
  h += (parseFloat(body.paddingTop) || 0) + (parseFloat(body.paddingBottom) || 0);
  return Math.max(0, Math.round(h));
}

/** 当前视图里到底有多少行书签（目录模式数全库，清单模式数查询结果） */
function listRowCount() {
  if (app.group === 'dir') return (app.allRows || []).length;
  return (app.data && app.data.items) ? app.data.items.length : 0;
}

/**
 * 量一次布局"标尺"：
 * - chrome：云区 + 列表之外的所有固定件（标题栏、查询框、操作带、分隔条……），
 *   用 H - 云区 - 列表反推，是跟云区高度无关的不变量；
 * - rowH：真实行高（带标签 chips 的行更高）；
 * - reserve：列表保底要占的高度——先按真实行逐条累加实测高度，
 *   量不到的（还没渲染完 / 目录模式列表头几条是文件夹组头不是书签行）用 rowH 补。
 *   兜底也要按"数据里确实有多少行"来定，绝不能算成 1 行——那会让云区把列表吃干净。
 */
function listMetrics() {
  const list = $('#list');
  const H = window.innerHeight;
  // 固定件高度直接加总，别用「H − 云区 − 列表」反推：列表一旦被挤成 0 高，
  // 反推出来的 chrome 会偏小，然后永远算错、越挤越死——这就是"拖动被锁死"的成因
  const chrome = fixedChrome();

  const want = Math.max(LIST_ROWS_MIN, Math.min(LIST_ROWS_MAX, app.listRows || LIST_ROWS_DEFAULT));
  const count = listRowCount();
  // 结果比保底行数还少时，别为不存在的行留空
  const rows = Math.max(1, count ? Math.min(want, count) : want);

  const lis = list ? [...list.children].filter((el) => el.tagName === 'LI') : [];
  const measured = [];
  for (const el of lis) {
    if (measured.length >= rows) break;
    const h = el.getBoundingClientRect().height;
    if (h > 20) measured.push(h);
  }
  const rowH = measured.length ? measured[0] : estimateRowHeight();
  let reserve = 0;
  for (let i = 0; i < rows; i++) reserve += measured[i] || rowH;
  if (list) {
    const cs = getComputedStyle(list);
    reserve += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }
  return { H, chrome, rowH, reserve, rows, need: rows };
}

/** 窗口尺寸或行密度变了：只夹一下行数，重排交给 layoutClouds */
function refreshCloudSpace() {
  app.listRows = Math.max(LIST_ROWS_MIN, Math.min(LIST_ROWS_MAX, app.listRows || LIST_ROWS_DEFAULT));
  scheduleCloudLayout();
}

let cloudLayoutTick = null;
function scheduleCloudLayout() {
  if (cloudLayoutTick) cancelAnimationFrame(cloudLayoutTick);
  cloudLayoutTick = requestAnimationFrame(() => {
    cloudLayoutTick = null;
    layoutClouds();
  });
}

/**
 * 按"瀑布"分配两朵云的高度：先把预算按剩余云的均分额度给最省的那朵，
 * 省下来的余量全部留给下一朵——短的那朵不会被长的那朵连累着一起缩。
 * 每朵还有一个 60px 保底（标题行 + 两行 chip），免得被削成光秃秃一条标题。
 */
function allocateCloudHeights(needs, budget) {
  // 按需分配：内容短的那朵拿"刚好放下"的高度，不给自己留白；
  // 省下的余量全部给内容长的那朵，它才是真正需要更多高度的
  const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
  const out = new Array(needs.length).fill(0);
  let left = budget;
  let rem = needs.length;
  for (const i of order) {
    const fair = Math.floor(Math.max(0, left) / Math.max(1, rem));
    out[i] = Math.max(Math.min(needs[i], fair), Math.min(needs[i], 60));
    left -= out[i];
    rem -= 1;
  }
  // 保底把预算吃穿了：从最高的那朵身上往回夺（最低只夺到 44px）
  let over = out.reduce((a, b) => a + b, 0) - budget;
  while (over > 0) {
    let t = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[t]) t = i;
    const floor = Math.min(needs[t], 44);
    const take = Math.min(over, Math.max(0, out[t] - floor));
    if (take <= 0) break;
    out[t] -= take;
    over -= take;
  }
  return out;
}

/** 一朵云"内容到底要多高"：标题行 + 内容底边（不受当前容器高度影响） */
function paneContentHeight(pane) {
  const head = pane.querySelector('.pane-head');
  const cloud = pane.querySelector('.cloud');
  const headH = head ? head.offsetHeight : 0;
  if (!cloud) return Math.max(44, headH);
  const cs = getComputedStyle(cloud);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  let contentH = 0;
  const kids = [...cloud.children];
  if (kids.length) {
    // 取所有 chip 里最低的那条底边（最后一排里可能有个子矮的，不能只看最后一条）
    const cTop = cloud.getBoundingClientRect().top;
    for (const el of kids) {
      const b = el.getBoundingClientRect().bottom - cTop + padB;
      if (b > contentH) contentH = b;
    }
  } else {
    contentH = cloud.scrollHeight;
  }
  // +2 是给亚像素留的余量，免得刚好卡在整像素时冒出一条 1px 滚动条
  return Math.max(44, Math.round(headH + Math.max(contentH, padT + padB)) + 2);
}

function layoutClouds() {
  const area = $('#cloudArea');
  if (!area) return;
  const panes = [...area.querySelectorAll(':scope > .pane')];
  if (!panes.length) return;

  // 关掉的栏（只剩标题行）不参与高度竞争，也不许被拉高
  const live = panes.filter((p) => !p.classList.contains('off'));
  panes.forEach((p) => {
    if (p.classList.contains('off')) {
      p.style.flex = '0 0 auto';
      p.style.height = '';
    }
  });
  if (!live.length) return;

  // 量内容真实高度：不看容器多高，直接量最后一排 chip 的底边。
  // 这样无论云区现在是偏高还是偏矮，量出来的都是"内容本身要多高"——
  // 既不会因为被压扁而量不出来，也不会因为之前拉高过而虚高留白。
  live.forEach((p) => {
    p.style.flex = '0 0 auto';
    p.style.height = 'auto';
  });
  void area.offsetHeight; // 先让 auto 高度落地，再量（下面量法本身也不依赖它）
  const needs = live.map((p) => paneContentHeight(p));
  const needSum = needs.reduce((a, b) => a + b, 0);

  // 硬底线：列表保底 N 行（默认 6，可拖分隔条改），云区只能吃剩下的
  const m = listMetrics();
  const capByList = Math.max(96, m.H - m.chrome - m.reserve - 2);

  // 关掉的栏（比如「启用目录标签」取消勾选）只剩标题行，但它也得占地方：
  // 云区高度以前只按"开着的栏"算，关掉的那栏就被 overflow:hidden 整条裁掉，
  // 连恢复用的勾选框一起看不见了——所以这里把它的高度单算，加在总高上
  const offH = panes
    .filter((p) => p.classList.contains('off'))
    .reduce((a, p) => {
      const head = p.querySelector('.pane-head');
      return a + (head ? head.offsetHeight : 22);
    }, 0);
  const capLive = Math.max(60, capByList - offH);

  // 云区总高 = 内容需要多少就多少（自适应），不吃满预算也不留空白
  let total = Math.max(88, Math.min(needSum, capLive));
  const shares = allocateCloudHeights(needs, Math.round(total));

  const apply = () => {
    area.style.setProperty('--cloud-space', `${Math.round(total + offH)}px`);
    live.forEach((p, i) => {
      p.style.flex = '0 0 auto';
      p.style.height = `${shares[i]}px`;
    });
  };
  apply();
  void area.offsetHeight;

  // 第二遍：测量难免差个半行一行。谁真的在滚（scrollHeight > clientHeight）
  // 就把还没用掉的预算补给谁，直到不滚为止——不靠"量准"，靠"实测谁缺"。
  let surplus = Math.round(capByList - total);
  for (let round = 0; round < 3 && surplus > 2; round++) {
    let grew = false;
    for (let i = 0; i < live.length && surplus > 2; i++) {
      const cloud = live[i].querySelector('.cloud');
      if (!cloud) continue;
      const over = cloud.scrollHeight - cloud.clientHeight;
      if (over <= 2) continue;
      const give = Math.min(over + 1, surplus);
      shares[i] += give;
      total += give;
      surplus -= give;
      grew = true;
      apply();
      void area.offsetHeight;
    }
    if (!grew) break;
  }
}

async function loadListRows() {
  let saved = null;
  try {
    const o = await chrome.storage.local.get(LIST_ROWS_KEY);
    const v = o && o[LIST_ROWS_KEY];
    if (typeof v === 'number' && v > 0) saved = v;
  } catch {}
  if (saved) app.listRows = Math.max(LIST_ROWS_MIN, Math.min(LIST_ROWS_MAX, saved));
}

/** 云区与列表之间的分隔条：拖动改比例、双击恢复自动 */
function bindCloudSplit() {
  const split = $('#cloudSplit');
  const area = $('#cloudArea');
  if (!split || !area) return;
  let drag = null;

  split.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, rows: app.listRows };
    split.classList.add('dragging');
    try {
      split.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });
  split.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // 往下拖 = 云区变高 = 列表少留一行，整行整行地变，不出现半行
    const m = listMetrics();
    const rows = Math.round(drag.rows - (e.clientY - drag.y) / Math.max(24, m.rowH));
    const next = Math.max(LIST_ROWS_MIN, Math.min(LIST_ROWS_MAX, rows));
    if (next !== app.listRows) {
      app.listRows = next;
      scheduleCloudLayout();
    }
  });
  const end = async () => {
    if (!drag) return;
    drag = null;
    split.classList.remove('dragging');
    try {
      await chrome.storage.local.set({ [LIST_ROWS_KEY]: app.listRows });
    } catch {}
  };
  split.addEventListener('pointerup', end);
  split.addEventListener('pointercancel', end);
  split.addEventListener('dblclick', async () => {
    app.listRows = LIST_ROWS_DEFAULT;
    try {
      await chrome.storage.local.remove(LIST_ROWS_KEY);
    } catch {}
    scheduleCloudLayout();
    toast(`已恢复：列表保底 ${LIST_ROWS_DEFAULT} 行`);
  });
  window.addEventListener('resize', () => {
    refreshCloudSpace();
    scheduleCloudLayout();
  });
  refreshCloudSpace();
}

const DENSITY = ['normal', 'compact', 'ultra'];
const DENSITY_LABEL = { normal: '标准', compact: '紧凑', ultra: '极简' };

// 行密度三档各一张图标：线越多越挤，图标本身就是当前档位的样子
const DENSITY_ICON = {
  normal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>',
  compact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16"/><path d="M4 9.5h16"/><path d="M4 14h16"/><path d="M4 18.5h16"/></svg>',
  ultra: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4h16"/><path d="M4 7.8h16"/><path d="M4 11.6h16"/><path d="M4 15.4h16"/><path d="M4 19.2h16"/></svg>',
};

function applyDensity() {
  document.body.dataset.density = app.density;
  const btn = $('#densityBtn');
  if (!btn) return;
  const i = DENSITY.indexOf(app.density);
  const next = DENSITY[(i + 1) % DENSITY.length];
  btn.innerHTML = DENSITY_ICON[app.density] || DENSITY_ICON.normal;
  const label = `行密度：${DENSITY_LABEL[app.density]}（点一下切到${DENSITY_LABEL[next]}）`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
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
  for (const b of document.querySelectorAll('#groupSeg .seg-btn')) {
    b.classList.toggle('on', b.dataset.view === app.group);
  }
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
  return qEl.value.trim() === '' && (!qTextEl || qTextEl.value.trim() === '');
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
