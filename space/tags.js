// 标签管理视图：全量标签表 + 批量重命名/合并/删除 + 颜色 + 撤销
import { PALETTE, colorFor, isExplicitColor } from '../lib/palette.js';
import { escapeTag } from '../lib/query.js';

const $ = (sel) => document.querySelector(sel);

let state = { tags: [], colors: {}, aliases: {}, dirTags: [], blockedDirs: [], excludedDirs: [] };
let dirKeyword = '';
let dirFilter = 'all';
let selected = new Set();
let filter = 'all';
let keyword = '';
let pollTimer = null;
let busy = false;

const toastEl = () => $('#toast');

function toast(text, isErr = false) {
  const el = toastEl();
  el.textContent = text;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r) throw new Error('后台无响应，试着重载扩展');
    if (r.error) throw new Error(r.error);
    return r;
  });
}

// ------------------------------------------------------------ 弹窗

let modalResolve = null;

export function modal({ title, desc = '', input = null, okText = '确定', cancelText = '取消' }) {
  const box = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalDesc').textContent = desc;
  const inp = $('#modalInput');
  if (input === null) {
    inp.hidden = true;
    inp.value = '';
  } else {
    inp.hidden = false;
    inp.value = input;
  }
  $('#modalOk').textContent = okText;
  $('#modalCancel').textContent = cancelText;
  box.hidden = false;
  if (input !== null) setTimeout(() => inp.focus(), 50);

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(value) {
  $('#modal').hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}

// ------------------------------------------------------------ 渲染

function matches(tag, count) {
  if (keyword && !tag.toLowerCase().includes(keyword.toLowerCase())) return false;
  if (filter === 'nocolor') return !isExplicitColor(tag, state.colors);
  if (filter === 'rare') return count === 1;
  return true;
}

// 图标：标签墙每个 chip 内就地带「重命名 / 删除」，不用把鼠标挪到右侧操作列
function chipActions(t) {
  const acts = document.createElement('span');
  acts.className = 'chip-acts';
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.textContent = '重命名';
  renameBtn.title = '把这个标签改名（所有书签标题里一起改）';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    doReplace([t.tag]);
  });
  const purgeBtn = document.createElement('button');
  purgeBtn.type = 'button';
  purgeBtn.className = 'danger-text';
  purgeBtn.textContent = '删除';
  purgeBtn.title = '把这个标签从所有书签标题里摘掉';
  purgeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    doPurge([t.tag]);
  });
  acts.append(renameBtn, purgeBtn);
  return acts;
}

/** 标签墙：所有 chip 统一尺寸，chip 内就地放勾选框/颜色点/名字/计数/重命名/删除 */
export function render() {
  const wall = $('#tagWall');
  if (!wall) return;
  wall.textContent = '';

  const list = state.tags.filter((t) => matches(t.tag, t.count));
  $('#tagSummary').textContent = `${state.tags.length} 个标签 · 显示 ${list.length} 个 · 已选 ${selected.size} 个`;

  for (const t of list) {
    const chip = document.createElement('div');
    chip.className = 'tagchip';
    if (selected.has(t.tag)) chip.classList.add('on');
    chip.title = `${t.tag}：${t.count} 条书签`;

    const ck = document.createElement('input');
    ck.type = 'checkbox';
    ck.className = 'bm-cb chip-ck';
    ck.checked = selected.has(t.tag);
    ck.title = '勾选后可用上方批量操作（重命名 / 合并到 / 删除标签）';
    ck.addEventListener('change', () => {
      if (ck.checked) selected.add(t.tag);
      else selected.delete(t.tag);
      chip.classList.toggle('on', ck.checked);
      refreshSelectionMeta();
    });

    // 颜色点：点开调色板（原表格里的「颜色」列）
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.style.background = colorFor(t.tag, state.colors);
    dot.title = isExplicitColor(t.tag, state.colors) ? '已手动设色（点开改色）' : '按标签名取色（点开可改色）';
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      openPalette(t.tag, dot);
    });

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'chip-name';
    name.textContent = t.tag;
    name.title = '查看这个标签下的书签';
    name.addEventListener('click', () => openDrawer(t.tag));

    const n = document.createElement('span');
    n.className = 'chip-n';
    n.textContent = String(t.count);

    chip.append(ck, dot, name, n, chipActions(t));
    wall.append(chip);
  }

  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty chipwall-empty';
    p.textContent = state.tags.length ? '没有符合筛选条件的标签' : '还没有任何标签。去侧边栏给书签打几个标签吧。';
    wall.append(p);
  }

  updateBulkBar();
}

// 全选本页 = 当前可见的标签（跟随搜索与筛选）；取消只清这些，不碰被筛掉的已选项
function visibleTags() {
  return state.tags.filter((t) => matches(t.tag, t.count));
}

function toggleVisible(on) {
  const list = visibleTags();
  for (const t of list) {
    if (on) selected.add(t.tag);
    else selected.delete(t.tag);
  }
  render();
}



// 勾一行之后，表头三态、计数、批量条都要跟上（不重绘整表，避免闪）
function refreshSelectionMeta() {
  const list = visibleTags();
  $('#tagSummary').textContent = `${state.tags.length} 个标签 · 显示 ${list.length} 个 · 已选 ${selected.size} 个`;
  updateBulkBar();
}

function clearSelectionOnFilterChange() {
  if (!selected.size) return;
  selected.clear();
  toast('筛选条件已变，已清空选择');
}

function updateBulkBar() {
  const bar = $('#bulkBar');
  bar.hidden = false; // 常驻：出现/消失不再推挤表格

  const list = visibleTags();

  const pageBtn = $('#tagAllPage');
  if (pageBtn) {
    pageBtn.disabled = list.length === 0;
    pageBtn.title = `选中本页 ${list.length} 个标签`;
  }

  // 没有选择时按钮置灰（不隐藏），布局不动
  const needSel = selected.size > 0;
  for (const btn of bar.querySelectorAll('[data-bulk]')) btn.disabled = !needSel;
}

// ------------------------------------------------------------ 颜色弹层

function openPalette(tag, anchor) {
  const pop = $('#pop');
  pop.textContent = '';
  pop.hidden = false;

  const grid = document.createElement('div');
  grid.className = 'pop-grid';
  PALETTE.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pop-swatch';
    b.style.background = p.hex;
    b.title = p.name || p.hex;
    b.addEventListener('click', async () => {
      pop.hidden = true;
      await setColor(tag, String(i));
    });
    grid.append(b);
  });

  const foot = document.createElement('div');
  foot.className = 'pop-foot';

  // 自定义 hex：#RRGGBB
  const hex = document.createElement('input');
  hex.className = 'input hex';
  hex.placeholder = '#1a7f37';
  hex.maxLength = 7;
  const hexGo = document.createElement('button');
  hexGo.className = 'btn small';
  hexGo.textContent = '自定义';
  hexGo.addEventListener('click', async () => {
    const v = hex.value.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
      toast('颜色要写成 #RRGGBB，比如 #1a7f37', true);
      hex.focus();
      return;
    }
    pop.hidden = true;
    await setColor(tag, v.toLowerCase());
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hexGo.click();
  });

  const clear = document.createElement('button');
  clear.className = 'btn ghost small';
  clear.textContent = '恢复默认色';
  clear.addEventListener('click', async () => {
    pop.hidden = true;
    await setColor(tag, '');
  });
  foot.append(hex, hexGo, clear);

  pop.append(grid, foot);

  const rect = anchor.getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
  pop.style.top = rect.bottom + 6 + 'px';
}

async function setColor(tag, value) {
  try {
    await send({ type: 'color:set', tag, value });
    await refresh();
    toast(value ? `已设色 ${tag}` : `${tag} 恢复默认色`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ------------------------------------------------------------ 详情抽屉

async function openDrawer(tag) {
  const drawer = $('#drawer');
  $('#drawerTitle').textContent = `#${tag}`;
  const body = $('#drawerBody');
  body.textContent = '加载中…';
  drawer.hidden = false;

  try {
    const r = await send({ type: 'query', expr: escapeTag(tag) });
    body.textContent = '';
    const head = document.createElement('p');
    head.className = 'hint';
    head.textContent = `${r.total} 条书签`;
    body.append(head);

    const ul = document.createElement('ul');
    ul.className = 'drawer-list';
    for (const item of (r.items || []).slice(0, 30)) {
      const li = document.createElement('li');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = item.title || item.url;
      const meta = document.createElement('div');
      meta.className = 'u';
      meta.textContent = `${item.tags.map((x) => '#' + x).join(' ')}${item.tags.length ? ' · ' : ''}${item.tags.length ? '' : ''}${item.url}`;
      li.append(t, meta);
      li.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
      ul.append(li);
    }
    body.append(ul);
    if (r.total > 30) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `只列前 30 条，共 ${r.total} 条`;
      body.append(more);
    }
  } catch (e) {
    body.textContent = e.message;
  }
}

// ------------------------------------------------------------ 批量动作

async function doReplace(tags) {
  const label = tags.length > 1 ? `把 ${tags.length} 个标签合并到` : `把「${tags[0]}」重命名为`;
  const to = await modal({
    title: label,
    desc: '输入新的标签名。若该标签已存在，则相当于合并（不会出现两个同名标签）。',
    input: tags.length === 1 ? tags[0] : '',
    okText: '预演',
  });
  if (to === null) return;
  const target = String(to || '').trim();
  if (!target) return;

  let est;
  try {
    est = await send({ type: 'tags:merge', froms: tags, to: target, dryRun: true });
  } catch (e) {
    toast(e.message, true);
    return;
  }

  if (!est.nodes) {
    toast(`没有书签用到这些标签，无需改写（${est.unchangedKeys} 个标签集合不变）`);
    return;
  }

  const ok = await modal({
    title: '确认改写',
    desc:
      `将改写 ${est.nodes} 条书签（涉及 ${est.keys} 个标签集合），预计 ${(est.ms / 1000).toFixed(1)} 秒。\n` +
      (est.mergedIntoExisting ? `其中 ${est.mergedIntoExisting} 个集合里目标标签已存在，会去重合并。\n` : '') +
      `示例：\n${(est.samples || []).map((s) => '· ' + s.before + '  →  ' + s.after).join('\n')}`,
    input: null,
    okText: '执行',
  });
  if (ok === null) return;

  await runOp({ type: 'tags:merge', froms: tags, to: target }, `改写 ${est.nodes} 条`);
}

async function doPurge(tags) {
  const ok = await modal({
    title: `删除标签 ${tags.join(' / ')}`,
    desc: '只摘掉标签，书签本身保留。此操作会改写用到这些标签的书签标题。',
    input: null,
    okText: '删除',
  });
  if (ok === null) return;
  await runOp({ type: 'tags:purge', tags }, `删除标签 ${tags.join('/')}`);
}

/** 跑一个批量：Fire 出去 + 并行轮询进度，最后取回报告 */
async function runOp(msg, hint) {
  if (busy) return;
  busy = true;
  setBusyUI(true);

  const box = $('#batchProgress');
  box.hidden = false;
  $('#batchLabel').textContent = hint;
  $('#batchNums').textContent = '准备中…';
  $('#progressFill').style.width = '0%';

  const runner = send(msg);
  startPolling();

  try {
    const r = await runner;
    stopPolling();
    const bits = [];
    if (r.written) bits.push(`已写 ${r.written} 条`);
    if (r.failed) bits.push(`失败 ${r.failed} 条`);
    if (r.aborted) bits.push(`已取消（完成 ${r.done}/${r.total}）`);
    if (r.skipped || r.unchangedKeys) bits.push(`跳过 ${r.unchangedKeys || 0} 组`);
    toast(bits.length ? bits.join('，') + '，可撤销' : '没有需要改写的内容');
  } catch (e) {
    stopPolling();
    toast(e.message, true);
  } finally {
    busy = false;
    setBusyUI(false);
    setTimeout(() => (box.hidden = true), 600);
    await refresh();
  }
}

function setBusyUI(on) {
  document.querySelectorAll('[data-bulk]').forEach((b) => (b.disabled = on));
  const wall = $('#tagWall');
  if (wall) wall.classList.toggle('busy', on);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const p = await send({ type: 'bulk:progress' });
      if (!p.batch) return;
      const pct = Math.round((p.batch.done / Math.max(1, p.batch.total)) * 100);
      $('#progressFill').style.width = pct + '%';
      $('#batchNums').textContent = `${p.batch.done} / ${p.batch.total}${p.batch.failed ? ` · 失败 ${p.batch.failed}` : ''}`;
      $('#batchLabel').textContent = p.batch.label;
    } catch {}
  }, 250);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------ 撤销 / 日志

// 与书签页同口径：默认折叠显示最近 5 条，点「更多」展开到 10 条，再点「收起」
const UNDO_SHOW = 5;
const UNDO_MAX = 10;
let undoExpanded = false;

async function renderUndo() {
  const box = $('#undoBox');
  const ul = $('#undoList');
  try {
    const r = await send({ type: 'undo:list' });
    const more = $('#undoMore');
    ul.textContent = '';
    if (!r.items || !r.items.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const show = undoExpanded ? UNDO_MAX : UNDO_SHOW;
    for (const it of r.items.slice().reverse().slice(0, show)) {
      const li = document.createElement('li');
      const time = new Date(it.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const txt = document.createElement('span');
      txt.textContent = `${time} ${it.label} · ${it.count} 条`;
      const btn = document.createElement('button');
      btn.className = 'btn ghost small';
      btn.textContent = '撤销';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await send({ type: 'undo:apply', index: it.index });
          const bits = [`回滚 ${res.restored} 条`];
          if (res.skipped) bits.push(`跳过 ${res.skipped} 条（已被改动）`);
          if (res.missing) bits.push(`已不存在 ${res.missing} 条`);
          toast(bits.join('，'));
          await refresh();
        } catch (e) {
          toast(e.message, true);
          btn.disabled = false;
        }
      });
      li.append(txt, btn);
      ul.append(li);
    }
    if (more) {
      more.hidden = r.items.length <= UNDO_SHOW;
      more.textContent = undoExpanded ? '收起' : `更多（${Math.min(r.items.length, UNDO_MAX)}）`;
    }
  } catch {
    box.hidden = true;
  }
}

async function renderJournal() {
  try {
    const r = await send({ type: 'journal:read' });
    const bar = $('#journalBar');
    if (!r.journal) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $('#journalText').textContent = `上次批量「${r.journal.label}」中断在 ${r.journal.done}/${r.journal.total}。重跑一遍是安全的（已改过的会跳过）。`;
    const btn = $('#btnResume');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await runOp(r.journal.spec, r.journal.label);
      } finally {
        btn.disabled = false;
      }
    };
  } catch {}
}

// ------------------------------------------------------------ 别名

// 目录标签：名字只读（改文件夹名去原生管理器），颜色可设
function matchesDir(tag, count) {
  if (dirKeyword && !tag.toLowerCase().includes(dirKeyword.toLowerCase())) return false;
  if (dirFilter === 'nocolor') return !isExplicitColor(tag, state.colors);
  if (dirFilter === 'rare') return count === 1;
  return true;
}

function renderDirTags() {
  const box = $('#dirTagRows');
  if (!box) return;
  box.textContent = '';
  const all = state.dirTags || [];
  const list = all.filter((t) => matchesDir(t.tag, t.count));
  const sum = $('#dirSummary');
  if (sum) {
    const deep = (state.dirStats && state.dirStats.deepFolders) || 0;
    const emptyish = Math.max(0, deep - all.length);
    const parts = [];
    if (all.length) parts.push(`${all.length} 个目录 · 显示 ${list.length} 个`);
    if (emptyish) parts.push(`${emptyish} 个文件夹没有书签未被投影`);
    sum.textContent = parts.join(' · ');
  }
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = all.length
      ? '当前搜索/筛选下没有目录标签。'
      : '书签栏里还没有带书签的子文件夹。建了文件夹并放书签进去，这里就会出现对应的 @标签。';
    box.append(p);
    return;
  }
  for (const t of list) {
    const row = document.createElement('span');
    row.className = 'dir-chip';
    const dot = document.createElement('button');
    dot.className = 'dir-dot';
    dot.style.background = colorFor(t.tag, state.colors);
    dot.title = '设置颜色';
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      openPalette(t.tag, dot);
    });
    const name = document.createElement('code');
    name.textContent = '@' + t.tag;
    const cnt = document.createElement('span');
    cnt.className = 'c';
    cnt.textContent = t.count;
    const blk = document.createElement('button');
    blk.className = 'btn ghost small';
    blk.textContent = '隐藏';
    blk.title = '只隐藏这个目录名；@查询仍然有效';
    blk.addEventListener('click', async (e) => {
      e.stopPropagation();
      await blockDir(t.tag, false);
    });

    const blkAll = document.createElement('button');
    blkAll.className = 'btn ghost small';
    blkAll.textContent = '隐藏整枝';
    blkAll.title = '连同这个文件夹下面的所有下级目录一起隐藏';
    blkAll.addEventListener('click', async (e) => {
      e.stopPropagation();
      await blockDir(t.tag, true);
    });

    const ex = document.createElement('button');
    ex.className = 'btn ghost small';
    ex.textContent = '排除';
    ex.title = '整棵子树都不进索引（搜不到、不统计），适合回收站这类不想被检索的目录';
    ex.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await send({ type: 'dirs:exclude', tag: t.tag, excluded: true });
        const added = (r && r.added) || [t.tag];
        toast(r && r.ambiguous ? `同名 ${added.length} 处，均已按路径排除` : `已排除：${added[0]}`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });

    row.append(dot, name, cnt, blk, blkAll, ex);
    box.append(row);
  }
}

function renderExcludedDirs() {
  const wrap = $('#dirExcluded');
  const rows = $('#dirExcludedRows');
  if (!wrap || !rows) return;
  const list = state.excludedDirs || [];
  wrap.hidden = !list.length;
  rows.textContent = '';
  if (!list.length) return;

  const all = document.createElement('button');
  all.className = 'btn ghost small';
  all.textContent = '全部恢复';
  all.addEventListener('click', async () => {
    try {
      for (const n of list.slice()) await send({ type: 'dirs:exclude', tag: n, excluded: false });
      toast('已全部恢复索引');
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  for (const name of list) {
    const chip = document.createElement('span');
    chip.className = 'dir-chip';
    const code = document.createElement('code');
    const slash = String(name).lastIndexOf('/');
    code.textContent = slash >= 0 ? String(name).slice(slash + 1) : name;
    code.title = name;
    if (slash >= 0) {
      const where = document.createElement('span');
      where.className = 'hint';
      where.textContent = ` ${String(name).slice(0, slash)} › `;
      chip.append(where);
    }
    const restore = document.createElement('button');
    restore.className = 'btn ghost small';
    restore.textContent = '恢复';
    restore.addEventListener('click', async () => {
      try {
        await send({ type: 'dirs:exclude', tag: name, excluded: false });
        toast(`已恢复 ${name}`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    chip.append(code, restore);
    rows.append(chip);
  }
  rows.append(all);
}

// 搜索框的 × ：有内容才显示，点掉清空并立刻重绘
function bindSearchClear() {
  document.querySelectorAll('.search').forEach((wrap) => {
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

async function blockDir(tag, cascade) {
  try {
    const r = await send({ type: 'dirs:block', tag, blocked: true, cascade: !!cascade });
    const added = (r && r.added) || [tag];
    toast(cascade ? `已隐藏整枝：${added.length} 个目录` : `已隐藏 ${tag}`);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBlockedDirs() {
  const wrap = $('#dirBlocked');
  const rows = $('#dirBlockedRows');
  if (!wrap || !rows) return;
  const list = state.blockedDirs || [];
  wrap.hidden = !list.length;
  rows.textContent = '';
  if (list.length > 1) {
    const all = document.createElement('button');
    all.className = 'btn ghost small';
    all.textContent = '全部恢复';
    all.addEventListener('click', async () => {
      try {
        for (const n of list.slice()) await send({ type: 'dirs:block', tag: n, blocked: false });
        toast('已全部恢复显示');
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    rows.append(all);
  }
  for (const name of list) {
    const chip = document.createElement('span');
    chip.className = 'dir-chip';
    const code = document.createElement('code');
    code.textContent = '@' + name;
    const restore = document.createElement('button');
    restore.className = 'btn ghost small';
    restore.textContent = '恢复';
    restore.addEventListener('click', async () => {
      try {
        await send({ type: 'dirs:block', tag: name, blocked: false });
        toast(`已恢复 ${name}`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    chip.append(code, restore);
    rows.append(chip);
  }
}

function renderAliases() {
  const rows = $('#aliasRows');
  if (!rows) return;
  rows.textContent = '';
  const entries = Object.entries(state.aliases || {}).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  );

  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'alias-empty';
    li.textContent = '还没有别名。常用场景：给长标签起个短的查询名。';
    rows.append(li);
  }

  for (const [alias, target] of entries) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'alias-a';
    a.textContent = alias;
    const arr = document.createElement('span');
    arr.className = 'arr';
    arr.textContent = '→';
    const t = document.createElement('span');
    t.className = 'alias-t';
    t.textContent = target;
    const del = document.createElement('button');
    del.className = 'btn ghost small danger-text';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      try {
        await send({ type: 'alias:set', alias, target: '' });
        toast(`已删除别名 ${alias}`);
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    });
    li.append(a, arr, t, del);
    rows.append(li);
  }

  // 规范标签候选 = 现有全部标签
  const dl = $('#tagDatalist');
  if (dl) {
    dl.textContent = '';
    for (const t of state.tags) {
      const opt = document.createElement('option');
      opt.value = t.tag;
      dl.append(opt);
    }
  }
}

function bindAlias() {
  const add = $('#btnAliasAdd');
  if (!add) return;
  add.addEventListener('click', async () => {
    const alias = $('#aliasName').value.trim();
    const target = $('#aliasTarget').value.trim();
    if (!alias || !target) {
      toast('别名和规范标签都要填', true);
      return;
    }
    try {
      await send({ type: 'alias:set', alias, target });
      $('#aliasName').value = '';
      $('#aliasTarget').value = '';
      toast(`已添加：${alias} → ${target}`);
      await refresh();
    } catch (e) {
      toast(e.message, true);
    }
  });
  for (const id of ['#aliasName', '#aliasTarget']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add.click();
    });
  }
}

// ------------------------------------------------------------ 生命周期

export async function refresh() {
  const st = await send({ type: 'state' });
  state.tags = st.tags || [];
  state.colors = (st.config && st.config.colors) || {};
  state.aliases = (st.config && st.config.aliases) || {};

  // 清掉已经不存在的选中项
  const alive = new Set(state.tags.map((t) => t.tag));
  for (const t of [...selected]) if (!alive.has(t)) selected.delete(t);

  render();
  state.dirTags = st.dirTags || [];
  state.blockedDirs = st.blockedDirs || [];
  state.excludedDirs = st.excludedDirs || [];
  state.dirStats = st.dirStats || { folders: 0, deepFolders: 0, tags: 0 };
  renderDirTags();
  renderBlockedDirs();
  renderExcludedDirs();
  renderAliases();
  await renderUndo();
  await renderJournal();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'app:changed') refresh();
});

export function init() {
  bindAlias();
  const undoMore = $('#undoMore');
  if (undoMore) {
    undoMore.addEventListener('click', () => {
      undoExpanded = !undoExpanded;
      renderUndo().catch(() => {});
    });
  }
  const allPage = $('#tagAllPage');
  if (allPage) allPage.addEventListener('click', () => toggleVisible(true));
  $('#tagSearch').addEventListener('input', (e) => {
    keyword = e.target.value.trim();
    clearSelectionOnFilterChange();
    render();
  });
  bindSearchClear();

  const dirSearch = $('#dirSearch');
  if (dirSearch) {
    dirSearch.addEventListener('input', (e) => {
      dirKeyword = e.target.value.trim();
      renderDirTags();
    });
  }
  const dirFilters = $('#dirFilters');
  if (dirFilters) {
    dirFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-f]');
      if (!btn) return;
      dirFilter = btn.dataset.f;
      dirFilters.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      renderDirTags();
    });
  }

  $('#tagFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-f]');
    if (!btn) return;
    filter = btn.dataset.f;
    $('#tagFilters').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    clearSelectionOnFilterChange();
    render();
  });

  $('#bulkBar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const tags = [...selected];
    if (btn.dataset.bulk === 'clear') {
      selected.clear();
      render();
      return;
    }
    if (!tags.length) return;
    if (btn.dataset.bulk === 'rename' || btn.dataset.bulk === 'merge') await doReplace(tags);
    if (btn.dataset.bulk === 'purge') await doPurge(tags);
  });

  $('#btnCancelBatch').addEventListener('click', async () => {
    try {
      await send({ type: 'bulk:cancel' });
      toast('已请求取消，当前这 20 条写完就停');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#drawerClose').addEventListener('click', () => ($('#drawer').hidden = true));

  $('#modalCancel').addEventListener('click', () => closeModal(null));
  $('#modalOk').addEventListener('click', () => {
    const inp = $('#modalInput');
    closeModal(inp.hidden ? true : inp.value);
  });
  $('#modalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#modalOk').click();
    if (e.key === 'Escape') closeModal(null);
  });

  document.addEventListener('click', (e) => {
    const pop = $('#pop');
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.dot')) pop.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#pop').hidden = true;
      $('#drawer').hidden = true;
      if (!$('#modal').hidden) closeModal(null);
    }
  });
}
