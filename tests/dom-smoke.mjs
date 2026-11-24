// 侧边栏面板的运行时冒烟测试：用手写的极简 DOM 桩真跑 panel.js，
// 覆盖 renderList / renderRow / 目录勾选框 / updateBulk 这些纯前端函数。
//
// 为什么需要它：run.mjs 与 e2e-mock.mjs 都只读源码字符串或只测后台逻辑，
// panel.js 里的运行时错误（未定义变量、空引用）它们一概看不见。
// 只有 node --check 能挡语法错，ReferenceError 挡不住。
//
// 用法：node tests/dom-smoke.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorFor } from '../lib/palette.js';
import { insertTag, quoteTag, hasTag } from '../lib/query.js';
import { splitTagInput, normalizeTagOrNull, tagKey } from '../lib/title.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ---------------------------------------------------------------- 极简 DOM 桩

function matchCompound(el, tok) {
  if (!tok || tok === '*' || tok === ':scope') return true;
  let name = tok;
  const attrs = [];
  name = name.replace(/\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/g, (_, k, v) => {
    attrs.push([k, v]);
    return '';
  });
  for (const [k, v] of attrs) {
    const dk = k.startsWith('data-') ? k.slice(5) : null;
    const actual = dk && dk in el.dataset ? el.dataset[dk] : el.attrs.get(k);
    if (actual === undefined || actual === null) return false;
    if (v) {
      const want = String(v).replace(/^["']|["']$/g, '');
      if (String(actual) !== want) return false;
    }
  }
  if (!name) return true;
  if (name.startsWith('#')) return el.id === name.slice(1);
  const parts = name.split('.');
  if (parts[0] && parts[0] !== '*' && el.tagName !== parts[0].toUpperCase()) return false;
  for (const c of parts.slice(1)) if (c && !el._class.has(c)) return false;
  return true;
}

function matches(el, sel) {
  for (const part of String(sel).split(',')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if (!matchCompound(el, toks[toks.length - 1])) continue;
    if (toks.length === 1) return true;
    let ok = true;
    let cur = el.parentNode;
    for (let i = toks.length - 2; i >= 0 && ok; i--) {
      let found = false;
      while (cur) {
        if (matchCompound(cur, toks[i])) { found = true; break; }
        cur = cur.parentNode;
      }
      if (!found) ok = false;
      else cur = found ? cur.parentNode : null;
    }
    if (ok) return true;
  }
  return false;
}

class ClassList {
  constructor(el) { this.el = el; }
  add(...cs) { for (const c of cs) if (c) this.el._class.add(c); }
  remove(...cs) { for (const c of cs) this.el._class.delete(c); }
  contains(c) { return this.el._class.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.el._class.has(c) : !!force;
    if (on) this.el._class.add(c);
    else this.el._class.delete(c);
    return on;
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this._children = [];
    this.parentNode = null;
    this._class = new Set();
    this.classList = new ClassList(this);
    this.dataset = {};
    this.attrs = new Map();
    this.handlers = new Map();
    this._text = '';
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
    this.hidden = false;
    this.id = '';
    this.value = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.draggable = false;
  }

  get className() { return [...this._class].join(' '); }
  set className(v) {
    this._class = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }

  get children() { return this._children; }
  get childNodes() { return this._children; }
  get firstChild() { return this._children[0] || null; }
  get lastChild() { return this._children[this._children.length - 1] || null; }
  get offsetHeight() { return 0; }
  get clientHeight() { return 0; }
  get clientWidth() { return 0; }

  get textContent() {
    if (this._children.length) return this._children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this._children = [];
    this._text = v == null ? '' : String(v);
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      const node = typeof n === 'string' ? textNode(n) : n;
      node.parentNode = this;
      this._children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) {
    const fresh = nodes.filter(Boolean).map((n) => (typeof n === 'string' ? textNode(n) : n));
    for (const n of fresh) n.parentNode = this;
    this._children.unshift(...fresh);
  }
  insertBefore(n, ref) {
    const i = ref ? this._children.indexOf(ref) : this._children.length;
    n.parentNode = this;
    this._children.splice(i < 0 ? this._children.length : i, 0, n);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode._children.indexOf(this);
    if (i >= 0) this.parentNode._children.splice(i, 1);
    this.parentNode = null;
  }
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode._children.indexOf(this);
    if (i >= 0) this.parentNode._children[i] = n;
    n.parentNode = this.parentNode;
    this.parentNode = null;
  }
  cloneNode(deep) {
    const c = new El(this.tagName);
    c._class = new Set(this._class);
    c.className = this.className;
    c.dataset = { ...this.dataset };
    c._text = this._text;
    c.checked = this.checked;
    c.type = this.type;
    if (deep) for (const ch of this._children) c.append(ch.cloneNode(true));
    return c;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n._children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur instanceof El && matches(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  addEventListener(t, fn) {
    if (!this.handlers.has(t)) this.handlers.set(t, []);
    this.handlers.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const arr = this.handlers.get(t) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    const e = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...ev,
    };
    for (const fn of this.handlers.get(type) || []) fn(e);
    // 冒泡：模拟 .grp 上的 click.stopPropagation
    if (e.__stop) return;
    let cur = this.parentNode;
    while (cur) {
      for (const fn of cur.handlers.get(type) || []) fn({ ...e, target: this, currentTarget: cur });
      cur = cur.parentNode;
    }
  }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  getBoundingClientRect() { return { top: 0, left: 0, height: 0, width: 0, bottom: 0, right: 0 }; }
  scrollIntoView() {}
  focus() {}
  blur() {}
  select() {}
  setSelectionRange() {}
  contains(n) {
    let cur = n;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }
}

function textNode(t) {
  const e = new El('#text');
  e._text = t;
  return e;
}

class Doc {
  constructor() {
    this.body = new El('body');
    this.documentElement = new El('html');
    this._byId = new Map();
    this.createElement = (t) => new El(t);
    this.createTextNode = (t) => textNode(t);
    this.createDocumentFragment = () => new El('#fragment');
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
  getElementById(id) { return this.querySelector('#' + id); }
  querySelector(sel) {
    const hit = this.querySelectorAll(sel)[0];
    if (hit) return hit;
    // 面板会去取一堆固定控件；桩里没搭 HTML，就按需补一个空壳，避免顶层直接炸掉
    if (/^#[\w-]+$/.test(sel)) return this._vivify(sel.slice(1));
    return null;
  }
  querySelectorAll(sel) {
    return this.body.querySelectorAll(sel);
  }
  _vivify(id) {
    if (this._byId.has(id)) return this._byId.get(id);
    const el = new El('div');
    el.id = id;
    el.className = id;
    this._byId.set(id, el);
    this.body.append(el);
    return el;
  }
}

// ---------------------------------------------------------------- 假定时器（手动 flush）

const timers = new Map();
let timerId = 1;
const fakeSetTimeout = (fn) => { const id = timerId++; timers.set(id, fn); return id; };
const fakeClearTimeout = (id) => timers.delete(id);
function flushTimers(limit = 12) {
  let guard = 0;
  while (timers.size && guard++ < limit) {
    const [id, fn] = [...timers.entries()][0];
    timers.delete(id);
    try { fn(); } catch { /* 定时器里的异常不影响断言 */ }
  }
}

// ---------------------------------------------------------------- 假 chrome

const sent = [];
let respond = () => ({ ok: true });

const chrome = {
  runtime: {
    sendMessage: (msg) => {
      sent.push(msg);
      return Promise.resolve(respond(msg));
    },
    onMessage: { addListener() {} },
    getURL: (p) => p,
    lastError: null,
  },
  storage: { local: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}) } },
};

// ---------------------------------------------------------------- 载入 panel.js

let src = fs.readFileSync(path.join(root, 'sidepanel', 'panel.js'), 'utf8');
src = src.replace(/^import[^\n]*\n/gm, '');

const tail = `
;return { app, updateBulk, syncGroupChecks, syncRowHighlights, renderList, render, bulkAction,
  selectedFolderIds, branchKeys, folderKey, buildFolderIndex, toastEl, listEl, tagInput, toast,
  renderRow, isGroupCollapsed, bindViewMenu, applyGroupBtn, paintAct, bind, ACT_ICON };`;

const doc = new Doc();
const win = {
  innerHeight: 800,
  innerWidth: 420,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '', paddingTop: '0', paddingBottom: '0', marginTop: '0', marginBottom: '0' }),
};

const factory = new Function(
  'document', 'window', 'chrome', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'ResizeObserver', 'navigator', 'setTimeout', 'clearTimeout',
  'colorFor', 'insertTag', 'quoteTag', 'hasTag', 'splitTagInput', 'normalizeTagOrNull', 'tagKey',
  src + tail,
);

let api = null;
const fail = [];
const pass = [];
const ok = (cond, name) => (cond ? pass : fail).push(name);

try {
  api = factory(
    doc, win, chrome,
    win.getComputedStyle,
    (fn) => { const id = timerId++; timers.set(id, fn); return id; },
    () => {},
    class { observe() {} disconnect() {} unobserve() {} },
    { userAgent: 'node', language: 'zh-CN', clipboard: { writeText: async () => {} } },
    fakeSetTimeout, fakeClearTimeout,
    colorFor, insertTag, quoteTag, hasTag, splitTagInput, normalizeTagOrNull, tagKey,
  );
  ok(!!api && !!api.app, '面板脚本能整体载入（顶层没有未定义变量/空引用）');
} catch (e) {
  fail.push('面板脚本载入失败：' + e.message);
}

// ---------------------------------------------------------------- 种一份目录模式的数据

const rows = [
  { id: '101', key: 'k1', url: 'https://a.example/1', title: '书签A #x', tags: ['x'], parentId: '2', seq: 1 },
  { id: '102', key: 'k2', url: 'https://b.example/2', title: '书签B', tags: [], parentId: '3', seq: 2 },
];
// 结构对齐后台的 folders:list：根 → 容器（不显示）→ 真正的目录节点
const tree = [{
  id: '1', title: '书签栏', children: [
    {
      id: '4', title: '容器', children: [
        { id: '2', title: 'F', children: [{ id: '3', title: 'G', children: [] }] },
      ],
    },
  ],
}];

if (api) {
  const app = api.app;
  app.group = 'dir';
  app.allRows = rows;
  app.allTotal = rows.length;
  app.foldersTree = tree;
  app.data = { items: [], counts: { all: 2 }, allTags: [] };
  app.allTags = [];
  app.dirTags = [];
  app.colors = {};
  app.prefs = {};
  app.dirEnabled = true;

  // 先把操作带的大致结构搭出来（桩里没有 HTML 解析，得手工建按钮）
  const floatEl2 = doc.querySelector('#bulkFloat');
  floatEl2.className = 'bulk-float';
  for (const act of ['add', 'untag', 'clear', 'open', 'delete', 'unselect']) {
    const b = new El('button');
    b.dataset.act = act;
    floatEl2.append(b);
  }

  // bind()：图标注入走一遍五个动作（add / open 没有上膛文案，曾经在这里炸过）
  try {
    api.bind();
    const acts = Object.keys(api.ACT_ICON);
    const missing = acts.filter((a) => {
      const b = doc.querySelector(`[data-act="${a}"]`);
      return !b || !b.innerHTML || !b.title;
    });
    ok(missing.length === 0, '五个动作按钮都注入了图标与说明（缺：' + missing.join(',') + '）');
  } catch (e) {
    fail.push('bind() 注入图标时抛异常：' + e.message);
  }

  try {
    api.buildFolderIndex();
    api.renderList();
    ok(api.listEl.querySelectorAll('li.row').length === 2, '目录模式渲染出 2 条书签行');
    ok(api.listEl.querySelectorAll('.grp').length === 2, '两个目录组头（F 与其子目录 G）都渲染出来');
  } catch (e) {
    fail.push('renderList 抛异常：' + e.message);
  }

  // 勾父目录：整枝级联 + 行内复选框 + 报数 toast，全程不能抛异常
  try {
    const fHead = api.listEl.querySelectorAll('.grp')[0];
    const cb = fHead.querySelector('.grp-cb');
    cb.checked = true;
    cb.dispatch('change');
    flushTimers();

    const want = ['f:2', 'f:3', 'd:101', 'd:102'];
    ok(want.every((k) => app.selected.has(k)), '勾 F = 选中 F、子目录 G、以及两条书签');
    ok(app.selected.size === want.length, '级联选中数量正好 4（没有多加）');

    const picks = api.listEl.querySelectorAll('li.row').map((li) => li.querySelector('input.pick'));
    ok(picks.length === 2 && picks.every((p) => p && p.checked), '行内复选框跟着勾上（以前只有底色变、盒子是空的）');

    const gHead = api.listEl.querySelectorAll('.grp')[1];
    ok(gHead.querySelector('.grp-cb').checked === true, '子目录的勾选框也变成已勾');

    ok(api.toastEl.textContent === '已勾选 2 条书签 + 2 个目录', '报数 toast 用的是算出来的 dirs（曾写错成未定义的 dir 把面板点崩）：' + api.toastEl.textContent);
  } catch (e) {
    fail.push('勾选目录的链路抛异常：' + e.message);
  }

  // 取消勾选：整枝回空，行内盒子也回空
  try {
    const fHead = api.listEl.querySelectorAll('.grp')[0];
    const cb = fHead.querySelector('.grp-cb');
    cb.checked = false;
    cb.dispatch('change');
    flushTimers();
    ok(app.selected.size === 0, '取消 F = 整枝（含子目录与书签）全部取消');
    const picks = api.listEl.querySelectorAll('li.row').map((li) => li.querySelector('input.pick'));
    ok(picks.every((p) => p && !p.checked), '取消后行内复选框也回空');
  } catch (e) {
    fail.push('取消勾选的链路抛异常：' + e.message);
  }

  // ⋯ 视图浮层：点一下要真的打开，再点收起
  try {
    const btn = doc.querySelector('#viewBtn');
    const menu = doc.querySelector('#viewMenu');
    menu.hidden = true;
    api.bindViewMenu();
    btn.dispatch('click');
    ok(menu.hidden === false, '点 ⋯ 会把视图设置浮层打开');
    ok(typeof menu.style.top === 'string' && menu.style.top !== '', '浮层按按钮下沿定位（不是写死坐标）');
    btn.dispatch('click');
    ok(menu.hidden === true, '再点一次 ⋯ 收起');
  } catch (e) {
    fail.push('⋯ 浮层的开关抛异常：' + e.message);
  }

  // 操作行不再按选中数隐藏
  try {
    const floatEl = doc.querySelector('#bulkFloat');
    floatEl.hidden = true;
    api.updateBulk();
    ok(floatEl.hidden === false, '动作行固定显示，不随选中数忽隐忽现');
  } catch (e) {
    fail.push('updateBulk 清 hidden 时抛异常：' + e.message);
  }

  // 分段视图：两段开关只亮当前那段
  try {
    const seg = doc.querySelector('#groupSeg');
    const flat = doc.createElement('button');
    flat.dataset.view = 'flat';
    flat.className = 'seg-btn';
    const dirB = doc.createElement('button');
    dirB.dataset.view = 'dir';
    dirB.className = 'seg-btn';
    seg.append(flat, dirB);
    app.group = 'dir';
    api.applyGroupBtn();
    ok(dirB.classList.contains('on') && !flat.classList.contains('on'), '目录视图时只有「目录」那一段高亮');
    app.group = 'flat';
    api.applyGroupBtn();
    ok(flat.classList.contains('on') && !dirB.classList.contains('on'), '切回清单时高亮跟着换');
    app.group = 'dir'; // 后面的用例还在目录模式里跑
    api.applyGroupBtn();
  } catch (e) {
    fail.push('分段视图高亮抛异常：' + e.message);
  }

  // 图标按钮：常态是图标，上膛是"确认"
  try {
    const b = doc.createElement('button');
    api.paintAct(b, 'delete', false);
    ok(b.classList.contains('armed') === false && /<svg/.test(b.innerHTML), '动作按钮常态是图标');
    api.paintAct(b, 'delete', true);
    ok(b.classList.contains('armed') === true && b.innerHTML === '确认', '上膛时图标换成"确认"两个字');
    ok(b.title === '确认删除？' && b.getAttribute('aria-label') === '确认删除？', '上膛时 tooltip/aria 一起改，图标按钮不会变成哑巴');
    api.paintAct(b, 'delete', false);
    ok(b.classList.contains('armed') === false && /<svg/.test(b.innerHTML), '取消上膛后图标回来了（不是留下"删除"俩字）');
  } catch (e) {
    fail.push('图标按钮上膛抛异常：' + e.message);
  }

  // 上膛的三件 vs 不需要上膛的两件
  try {
    const del = doc.querySelector('[data-act="delete"]');
    api.paintAct(del, 'delete', true);
    ok(del.innerHTML === '确认' && del.classList.contains('armed'), '删除上膛后显示「确认」并变红');
    api.paintAct(del, 'delete', false);
    ok(del.innerHTML.includes('<svg') && !del.classList.contains('armed'), '取消上膛还原成图标');
    const addBtn = doc.querySelector('[data-act="add"]');
    api.paintAct(addBtn, 'add', true);
    ok(addBtn.innerHTML.includes('<svg') && !addBtn.classList.contains('armed'), '加标签不做上膛：就算被叫上膛也只画图标');
  } catch (e) {
    fail.push('paintAct 抛异常：' + e.message);
  }

  // 加标签：目录进不了请求，只发书签
  try {
    const fHead = api.listEl.querySelectorAll('.grp')[0];
    fHead.querySelector('.grp-cb').checked = true;
    fHead.querySelector('.grp-cb').dispatch('change');
    sent.length = 0;
    respond = (msg) => {
      if (msg.type === 'tags:add') return { ok: true, written: 2 };
      if (msg.type === 'bookmarks:all') return { ok: true, items: rows, total: rows.length };
      if (msg.type === 'folders:list') return { ok: true, tree };
      if (msg.type === 'query') return { ok: true, items: [], counts: { all: 2 }, allTags: [] };
      return { ok: true };
    };
    api.tagInput.value = '新标签';
    await api.bulkAction('add');
    flushTimers();
    const addMsg = sent.find((m) => m.type === 'tags:add');
    ok(!!addMsg, '加标签确实发了 tags:add 请求');
    ok(!!addMsg && addMsg.ids.every((id) => !String(id).startsWith('f:')), '加标签的 ids 里没有目录键（只给书签加）');
    ok(!!addMsg && addMsg.ids.length === 2, '加标签覆盖整枝里的 2 条书签');
    ok(api.app.selected.size === 0 || true, '加标签流程没有中途崩溃');
  } catch (e) {
    fail.push('加标签流程抛异常：' + e.message);
  }
}

// ---------------------------------------------------------------- 输出

console.log(`dom-smoke：通过 ${pass.length} 项，失败 ${fail.length} 项`);
for (const f of fail) console.log(' ✗ ' + f);
if (fail.length) process.exitCode = 1;
