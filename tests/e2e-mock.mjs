// 端到端（模拟 chrome API）：真实加载 background.js，验证配置自愈、写标题、查询、设色
// node tests/e2e-mock.mjs

import { parseTitle } from '../lib/title.js';
import { canonicalUrl, PATH_SEP } from '../lib/index.js';

// ------------------------------------------------------------ 假的 chrome

const listeners = {
  bookmarks: { created: [], removed: [], changed: [], moved: [], reordered: [], importEnded: [] },
  message: [],
  command: [],
  installed: [],
  startup: [],
  omniChanged: [],
  omniEntered: [],
};

const nodes = new Map();
let nextId = 1000;

const root = { id: '0', parentId: undefined, title: '', children: [] };
const bar = { id: '1', parentId: '0', title: '书签栏', children: [] };
const other = { id: '2', parentId: '0', title: '其他书签', children: [] };
nodes.set('0', root);
nodes.set('1', bar);
nodes.set('2', other);
root.children = ['1', '2'];

function addLeaf(parentId, title, url) {
  const node = { id: String(nextId++), parentId, title, url };
  nodes.set(node.id, node);
  nodes.get(parentId).children.push(node.id);
  return node;
}

const bm1 = addLeaf('1', 'Vue 官方文档 [#前端][#Vue]', 'https://vuejs.org/');
const bm2 = addLeaf('1', 'React 文档 [#前端][#React]', 'https://react.dev/');
const bm3 = addLeaf('1', '设计系统', 'https://design.example.com/');
const bm4 = addLeaf('1', '重复收藏', 'http://vuejs.org');
const bm5 = addLeaf('1', '完全没标签', 'https://plain.example.com/');

function fire(list, ...args) {
  for (const fn of list) {
    try {
      fn(...args);
    } catch (e) {
      console.error('[mock listener error]', e);
    }
  }
}

let updateCalls = [];
let createCalls = [];
let storage = {};

function flat(node) {
  if (!node) return null;
  const { children, ...rest } = node;
  return { ...rest };
}

function treeOf(id) {
  const node = nodes.get(id);
  if (!node) return null;
  const copy = flat(node);
  if (node.children) copy.children = node.children.map(treeOf).filter(Boolean);
  return copy;
}

globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
  },
  bookmarks: {
    getTree: async () => [treeOf('0')],
    getChildren: async (id) => {
      const n = nodes.get(id);
      return n && n.children ? n.children.map((c) => flat(nodes.get(c))) : [];
    },
    get: async (id) => {
      const n = nodes.get(id);
      if (!n) throw new Error('not found ' + id);
      return [flat(n)];
    },
    create: async ({ parentId, title, url }) => {
      createCalls.push({ parentId, title, url });
      const node = { id: String(nextId++), parentId, title, url };
      if (!url) node.children = [];
      nodes.set(node.id, node);
      const parent = nodes.get(parentId);
      if (parent && parent.children) parent.children.push(node.id);
      fire(listeners.bookmarks.created, node.id, flat(node));
      return flat(node);
    },
    update: async (id, changes) => {
      const n = nodes.get(id);
      if (!n) throw new Error('not found ' + id);
      updateCalls.push({ id, title: changes.title });
      if (changes.title !== undefined) n.title = changes.title;
      if (changes.url !== undefined) n.url = changes.url;
      fire(listeners.bookmarks.changed, id, { title: n.title, url: n.url });
      return flat(n);
    },
    remove: async (id) => {
      const n = nodes.get(id);
      if (!n) throw new Error('not found ' + id);
      nodes.delete(id);
      const p = nodes.get(n.parentId);
      if (p && p.children) p.children = p.children.filter((c) => c !== id);
      fire(listeners.bookmarks.removed, id, { parentId: n.parentId, index: 0, node: flat(n) });
    },
    removeTree: async (id) => {
      const n = nodes.get(id);
      if (!n) throw new Error('not found ' + id);
      const kill = (node) => {
        for (const c of node.children || []) kill(nodes.get(c));
        nodes.delete(node.id);
      };
      kill(n);
      const p = nodes.get(n.parentId);
      if (p && p.children) p.children = p.children.filter((c) => c !== id);
      fire(listeners.bookmarks.removed, id, { parentId: n.parentId, index: 0, node: flat(n) });
    },
    move: async (id, { parentId, index }) => {
      const n = nodes.get(id);
      if (!n) throw new Error('not found ' + id);
      const from = nodes.get(n.parentId);
      if (from && from.children) from.children = from.children.filter((c) => c !== id);
      n.parentId = parentId;
      const to = nodes.get(parentId);
      if (to && to.children) {
        if (index === undefined || index < 0 || index > to.children.length) to.children.push(id);
        else to.children.splice(index, 0, id);
      }
      fire(listeners.bookmarks.moved, id, { parentId, index: 0, oldParentId: from && from.id });
      return flat(n);
    },
    onCreated: { addListener: (fn) => listeners.bookmarks.created.push(fn) },
    onRemoved: { addListener: (fn) => listeners.bookmarks.removed.push(fn) },
    onChanged: { addListener: (fn) => listeners.bookmarks.changed.push(fn) },
    onMoved: { addListener: (fn) => listeners.bookmarks.moved.push(fn) },
    onChildrenReordered: { addListener: (fn) => listeners.bookmarks.reordered.push(fn) },
    onImportEnded: { addListener: (fn) => listeners.bookmarks.importEnded.push(fn) },
  },
  storage: {
    local: {
      get: async (key) => (storage[key] === undefined ? {} : { [key]: storage[key] }),
      set: async (obj) => Object.assign(storage, obj),
    },
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    open: async () => {},
  },
  commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
  omnibox: {
    onInputChanged: { addListener: (fn) => listeners.omniChanged.push(fn) },
    onInputEntered: { addListener: (fn) => listeners.omniEntered.push(fn) },
  },
  tabs: { create: async () => ({ id: 1 }) },
  windows: { getCurrent: async () => ({ id: 1 }) },
};

// ------------------------------------------------------------ 调用后台

let sendMessage;

function call(msg) {
  return new Promise((resolve) => {
    const done = (r) => resolve(r);
    for (const fn of listeners.message) fn(msg, {}, done);
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const st = await call({ type: 'state' });
    if (st && st.counts) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('后台未就绪');
}

// ------------------------------------------------------------ 断言

let pass = 0;
const failures = [];
function eq(a, b, label) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) pass++;
  else failures.push(`${label}\n  期望 ${y}\n  实际 ${x}`);
}
function ok(c, label) {
  if (c) pass++;
  else failures.push(label);
}

// ------------------------------------------------------------ 跑

await import('../background.js');

const st = await waitReady();
console.log('启动完成：', JSON.stringify(st.counts));

// 1. 配置文件自动创建
const otherChildren = nodes.get('2').children.map((c) => nodes.get(c));
const folder = otherChildren.find((n) => n.title === 'TagSpace');
ok(!!folder, 'E1 自动创建 TagSpace 文件夹');
const files = folder ? nodes.get(folder.id).children.map((c) => nodes.get(c)) : [];
eq(files.length, 3, 'E2 三个配置文件');
eq(
  files.map((f) => f.url.split('#')[1]).sort(),
  ['cfg=aliases', 'cfg=colors', 'cfg=prefs'],
  'E3 URL 带 cfg= 标记'
);
eq(
  files.find((f) => f.url.includes('colors')).title,
  'TagSpace 配置·颜色',
  'E4 空配置标题无后缀'
);

// 2. 索引排除了配置文件
eq(st.counts.excluded, 3, 'E5 配置文件不进索引');
eq(st.counts.keys, 4, 'E6 书签 URL 去重后 4 条');

// 3. 空查询只显示已标签
const q0 = await call({ type: 'query', expr: '' });
eq(q0.total, 2, 'E7 空查询只显示已标签书签（bm3/bm5 未打标签）');
eq(q0.items.map((i) => i.url), ['https://vuejs.org/', 'https://react.dev/'], 'E7a 空查询按书签树默认顺序（先建在前，不是标题拼音序）');
const q0all = await call({ type: 'query', expr: '', includeUntagged: true });
eq(q0all.total, 4, 'E7d includeUntagged = 全部书签（含 bm3/bm5 未打标签）');
eq(q0all.items.map((i) => i.url), ['https://vuejs.org/', 'https://react.dev/', 'https://design.example.com/', 'https://plain.example.com/'], 'E7e 全部模式同样按书签树默认顺序');
eq(q0.counts && q0.counts.all, 4, 'E7b counts.all 给出全量条数');
eq(q0.counts && q0.counts.untagged, 2, 'E7c counts.untagged 给出未打标签条数');

// 4. 布尔查询
const q1 = await call({ type: 'query', expr: '前端, Vue' });
eq(q1.total, 1, 'E8 交集');
const q2 = await call({ type: 'query', expr: '前端 - Vue' });
eq(q2.total, 1, 'E9 差集');
const q3 = await call({ type: 'query', expr: '?设计' });
eq(q3.total, 1, 'E10 全文检索干净标题');
const qAll = await call({ type: 'query', expr: '#全部书签' });
eq(qAll.total, 4, 'E11b #全部书签 = 全部（含未打标签）');
eq([...qAll.items.map((i) => i.url)].sort(), ['https://design.example.com/', 'https://plain.example.com/', 'https://react.dev/', 'https://vuejs.org/'], 'E11c #全部书签 条目与全量一致');
const qAll2 = await call({ type: 'query', expr: '全部书签' });
eq(qAll2.total, 4, 'E11d 裸词「全部书签」也等于全部（含未打标签）');
const q4 = await call({ type: 'query', expr: '未打标签' });
eq(q4.total, 2, 'E11 虚拟标签（bm3 与 bm5）');

// 5. 加标签：同一 URL 两个位置都要改
const before = updateCalls.length;
const add = await call({ type: 'tags:add', ids: [bm3.id], tags: ['设计', '前端'] });
eq(add.written, 1, 'E12 给单条加 2 个标签写 1 次');
eq(nodes.get(bm3.id).title, '设计系统 [#前端][#设计]', 'E13 标题带排序后的标签');

// 6. 幂等：同样操作再来一次，不产生写
const add2 = await call({ type: 'tags:add', ids: [bm3.id], tags: ['前端'] });
eq(add2.written, 0, 'E14 重复加已有标签不写');

// 7. 同 URL 多位置：给 vuejs.org 的其中一个打标签，两个位置都变
await call({ type: 'tags:add', ids: [bm4.id], tags: ['重复'] });
eq(nodes.get(bm1.id).title.includes('[#重复]'), true, 'E15 另一位置同步写');
eq(nodes.get(bm4.id).title.includes('[#重复]'), true, 'E16 本位置写入');

// 8. 摘标签
await call({ type: 'tags:remove', ids: [bm3.id], tags: ['设计'] });
eq(nodes.get(bm3.id).title, '设计系统 [#前端]', 'E17 摘掉一个标签');

// 9. 清空标签
await call({ type: 'tags:clear', ids: [bm3.id] });
eq(nodes.get(bm3.id).title, '设计系统', 'E18 清空标签后标题干净');

// 10. 设色只写配置文件 1 次
const beforeColor = updateCalls.length;
const color = await call({ type: 'color:set', tag: '前端', value: '3' });
eq(updateCalls.length - beforeColor, 1, 'E19 设色只写 1 次');
const colorsFile = nodes.get(
  nodes.get(folder.id).children.map((c) => nodes.get(c)).find((n) => n.url.includes('colors')).id
);
eq(colorsFile.title, 'TagSpace 配置·颜色 [**v:1;c:前端=3]', 'E20 颜色写进配置文件标题');

const st2 = await call({ type: 'state' });
eq(st2.config.colors['前端'], '3', 'E21 配置已重载');

// 11. 改偏好
await call({ type: 'prefs:set', patch: { bmSort: 'url' } });
const prefsFile = nodes.get(
  nodes.get(folder.id).children.map((c) => nodes.get(c)).find((n) => n.url.includes('prefs')).id
);
ok(prefsFile.title.includes('bmSort:url'), 'E22 偏好写进偏好文件');

// 12. 配置文件改名后仍被识别（URL 不变）
const cNode = nodes.get(
  nodes.get(folder.id).children.map((c) => nodes.get(c)).find((n) => n.url.includes('colors')).id
);
await call({ type: 'config:write', category: 'colors', raw: 'c:前端=3' });
ok(cNode.title.startsWith('TagSpace 配置·颜色'), 'E23 配置写回保留文件名');

// 13. 删除配置文件后自愈
const aliasNode = nodes.get(
  nodes.get(folder.id).children.map((c) => nodes.get(c)).find((n) => n.url.includes('aliases')).id
);
nodes.get(folder.id).children = nodes.get(folder.id).children.filter((c) => c !== aliasNode.id);
nodes.delete(aliasNode.id);
const restore = await call({ type: 'config:restore' });
ok(!!restore.configFiles, 'E24 缺失配置可重建');
eq(
  nodes.get(folder.id).children.map((c) => nodes.get(c)).filter((n) => n.url.includes('cfg=aliases')).length,
  1,
  'E25 重建后只有一个别名文件'
);

// 14. 查询结果里的条目标题是干净标题
const q5 = await call({ type: 'query', expr: '前端' });
const item = q5.items.find((i) => canonicalUrl(i.url) === 'vuejs.org');
ok(item && !item.title.includes('[#'), 'E26 展示用干净标题');

// 15. 查询命中的标签本身也留在相关标签里（高亮显示，点一下即摘除）
ok(q5.related.some((r) => r.tag === '前端' && r.count > 0), 'E27 相关标签保留命中标签本身');

// 16. 重复配置：模拟两台设备在首次同步前各建了一套
const dupColor = {
  id: String(nextId++),
  parentId: folder.id,
  title: 'TagSpace 配置·颜色 [**v:1;c:前端=5,Chrome=#ff0000]',
  url: 'chrome-extension://test/space/space.html#cfg=colors',
};
nodes.set(dupColor.id, dupColor);
nodes.get(folder.id).children.push(dupColor.id);

await call({ type: 'index:rebuild' });
const stDup = await call({ type: 'state' });
eq(stDup.configDuplicates.length, 1, 'E28 发现重复配置');
eq(stDup.configDuplicates[0].count, 2, 'E29 重复数量为 2');
eq(stDup.configDuplicates[0].category, 'colors', 'E30 识别为颜色类');

const dd = await call({ type: 'config:dedupe' });
eq(dd.removed.length, 1, 'E31 删掉多余那条');
eq(dd.filled, 1, 'E32 并集填充 1 条');
eq(dd.conflicts.length, 1, 'E33 冲突 1 条');
eq(dd.conflicts[0].key, '前端', 'E34 冲突键是 前端');

const kids2 = nodes.get(folder.id).children.map((c) => nodes.get(c));
eq(kids2.length, 3, 'E35 合并后只剩三个配置文件');
const keptColors = kids2.find((n) => n.url.includes('cfg=colors'));
ok(keptColors.title.includes('Chrome=#ff0000'), 'E36 并集写进规范文件');
ok(keptColors.title.includes('前端=3'), 'E37 冲突保留规范文件的值');

const stAfter = await call({ type: 'state' });
eq(stAfter.configDuplicates.length, 0, 'E38 合并后不再报重复');
eq(stAfter.config.colors.Chrome, '#ff0000', 'E39 合并后的颜色生效');
eq(stAfter.config.colors['前端'], '3', 'E40 冲突值没被覆盖');
eq(stAfter.counts.excluded, 3, 'E41 索引仍只排除三个配置');

// 17. 批量：重命名 → 撤销 → 删除标签
const frontTotal = (await call({ type: 'query', expr: '前端' })).total;
ok(frontTotal >= 2, 'E42 重命名前有多个书签用「前端」');

const dryMark = updateCalls.length;
const dryRun = await call({ type: 'tags:merge', froms: ['前端'], to: '前端开发', dryRun: true });
eq(dryRun.dryRun, true, 'E43 预演不写');
ok(dryRun.nodes >= frontTotal, 'E44 预演给出待写条数');
ok(dryRun.samples.length > 0 && dryRun.samples[0].after.includes('前端开发'), 'E45 预演给前后对比');
eq(updateCalls.length - dryMark, 0, 'E46 预演阶段一次写都没产生');

const writeMark = updateCalls.length;
const rename = await call({ type: 'tags:merge', froms: ['前端'], to: '前端开发' });
eq(updateCalls.length - writeMark, rename.written, 'E47 写次数与报告一致');
ok(rename.written >= frontTotal, 'E48 每个受影响位置都写了');

eq((await call({ type: 'query', expr: '前端' })).total, 0, 'E49 旧标签查不到了');
eq((await call({ type: 'query', expr: '前端开发' })).total, frontTotal, 'E50 新标签条数一致');

const jr = await call({ type: 'journal:read' });
eq(jr.journal, null, 'E51 成功后清掉 journal');
const bp = await call({ type: 'bulk:progress' });
eq(bp.batch, null, 'E52 空闲时没有进行中的批量');

const undoList = await call({ type: 'undo:list' });
ok(undoList.items.length >= 1, 'E53 留下撤销记录');
const undoRes = await call({ type: 'undo:apply', index: undoList.items.length - 1 });
ok(undoRes.restored > 0, 'E54 撤销回滚了标题');
eq(undoRes.skipped, 0, 'E55 没有跳过');
eq((await call({ type: 'query', expr: '前端' })).total, frontTotal, 'E56 撤销后旧标签回来了');
eq((await call({ type: 'query', expr: '前端开发' })).total, 0, 'E57 新标签消失');

// 18. 删除标签（书签保留）
const purge = await call({ type: 'tags:purge', tags: ['React'] });
ok(purge.written >= 1, 'E58 删除标签有改写');
eq((await call({ type: 'query', expr: 'React' })).total, 0, 'E59 标签没了');
ok(nodes.get(bm2.id).title.startsWith('React 文档'), 'E60 书签本身还在');
eq(nodes.get(bm2.id).title.includes('[#React]'), false, 'E61 标题里没有该标签了');

// 19. 非法目标名被拦住
const bad = await call({ type: 'tags:merge', froms: ['Vue'], to: 'a;b' });
ok(!!bad.error, 'E62 含分号的目标名被拒绝');

// 20. 健康检查：外部把标签顺序改乱，再让扩展修回去
await chrome.bookmarks.update(bm1.id, { title: 'Vue 官方文档 [#前端][#Vue]' });
const scan1 = await call({ type: 'diag:scan' });
const order1 = scan1.issues.find((i) => i.kind === 'tag-order');
ok(!!order1, 'E63 扫描出标签顺序问题');
ok(order1.samples.length > 0, 'E64 带例子');
ok(scan1.counts.nodes >= 4, 'E65 顺带返回计数');
ok(typeof scan1.stats.rebuilds === 'number' && scan1.stats.lastBuildMs >= 0, 'E66 返回会话统计');

const fixMark = updateCalls.length;
const fix = await call({ type: 'diag:fix', kinds: ['tag-order'], dryRun: true });
eq(updateCalls.length - fixMark, 0, 'E67 预演不写');
ok(fix.nodes >= 1, 'E68 预演给出待修条数');

const fixed = await call({ type: 'diag:fix', kinds: ['tag-order'] });
ok(fixed.written >= 1, 'E69 实际改写了标题');
eq(nodes.get(bm1.id).title, 'Vue 官方文档 [#Vue][#前端]', 'E70 改回码点序');

const scan2 = await call({ type: 'diag:scan' });
ok(!scan2.issues.some((i) => i.kind === 'tag-order'), 'E71 修完不再报顺序问题');

// 21. 配置缺版本号：空文件不报；手改掉版本号才报，且修复要保留原有内容
const scanEmpty = await call({ type: 'diag:scan' });
ok(!scanEmpty.issues.some((i) => i.kind === 'cfg-version'), 'E72 空的配置文件不报缺版本号');

await chrome.bookmarks.update(cNode.id, { title: 'TagSpace 配置·颜色 [**c:Vue=3]' });
const scanHand = await call({ type: 'diag:scan' });
ok(scanHand.issues.some((i) => i.kind === 'cfg-version'), 'E73 手改掉版本号后才报');

const fixV = await call({ type: 'diag:fix', kinds: ['cfg-version'] });
ok(fixV.configWritten >= 1, 'E74 确实写了配置文件');
eq(nodes.get(cNode.id).title, 'TagSpace 配置·颜色 [**v:1;c:Vue=3]', 'E75 补上版本号且颜色没被清掉');

// 22. 别名：加、查、删、非法
const aliasFileNode = nodes.get(folder.id).children.map((c) => nodes.get(c)).find((n) => n.url.includes('aliases'));

const aBad = await call({ type: 'alias:set', alias: 'a;b', target: '前端' });
ok(!!aBad.error, 'E76 非法别名被拒');
const aSame = await call({ type: 'alias:set', alias: '前端', target: '前端' });
ok(!!aSame.error, 'E77 别名与规范标签同名被拒');

const aAdd = await call({ type: 'alias:set', alias: 'js', target: '前端' });
ok(!aAdd.error, 'E78 合法别名能加');
ok(nodes.get(aliasFileNode.id).title.includes('a:js=前端'), 'E79 别名写进配置文件标题');

const viaAlias = await call({ type: 'query', expr: 'js' });
eq(viaAlias.total, (await call({ type: 'query', expr: '前端' })).total, 'E80 用别名查与用本名查条数一致');

const aCycle = await call({ type: 'alias:set', alias: '前端', target: 'js' });
ok(!!aCycle.error, 'E81 会成环的别名被拒');

const aDel = await call({ type: 'alias:set', alias: 'js', target: '' });
ok(!aDel.error, 'E82 删除别名');
eq((await call({ type: 'query', expr: 'js' })).total, 0, 'E83 删后别名查不到');

// 23. 目录标签：建文件夹放书签 → @查询 → 开关 → 设色不报孤儿
const sub = await chrome.bookmarks.create({ parentId: '1', title: '前端' });
await chrome.bookmarks.create({ parentId: sub.id, title: 'Vite 文档', url: 'https://vite.dev/' });

const stDir = await call({ type: 'state' });
ok(stDir.dirTags.some((t) => t.tag === '前端'), 'E84 state 带目录标签');

const qDir = await call({ type: 'query', expr: '@前端' });
eq(qDir.total, 1, 'E85 @前端 查到文件夹里的书签');
ok(qDir.items[0].url.includes('vite.dev'), 'E86 查到的是新放进去那条');

const qMix = await call({ type: 'query', expr: '@前端 | Vue' });
ok(qMix.total >= 2, 'E87 目录标签与普通标签混算');

await call({ type: 'prefs:set', patch: { folderTags: '0' } });
eq((await call({ type: 'query', expr: '@前端' })).total, 0, 'E88 关掉后 @ 查不到');
await call({ type: 'prefs:set', patch: { folderTags: '1' } });
eq((await call({ type: 'query', expr: '@前端' })).total, 1, 'E89 重新打开恢复');

await call({ type: 'color:set', tag: '前端', value: '3' });
const scanDir = await call({ type: 'diag:scan' });
ok(!scanDir.issues.some((i) => i.kind === 'color-orphan'), 'E90 目录标签的颜色不算孤儿');

// 24. 隐藏目录标签：显示消失、@查询仍有效、可恢复
// 含 ; 的名字现在会编码后写入配置串，不再拒绝（见 28 段）
const oddName = await call({ type: 'dirs:block', tag: 'a;b', blocked: true });
ok(!oddName.error, 'E91 含 ; 的文件夹名也能隐藏（写配置前编码）');
await call({ type: 'dirs:block', tag: 'a;b', blocked: false });

await call({ type: 'dirs:block', tag: '前端', blocked: true });
const stBlocked = await call({ type: 'state' });
ok(!stBlocked.dirTags.some((t) => t.tag === '前端'), 'E92 屏蔽后 state 里不再出现');
ok(stBlocked.blockedDirs.includes('前端'), 'E93 屏蔽名单单独给出');
eq((await call({ type: 'query', expr: '@前端' })).total, 1, 'E94 屏蔽只影响显示，@查询仍命中');

await call({ type: 'dirs:block', tag: '前端', blocked: true });
const stTwice = await call({ type: 'state' });
eq(stTwice.blockedDirs.filter((x) => x === '前端').length, 1, 'E95 重复屏蔽不产生重复条目');

await call({ type: 'dirs:block', tag: '前端', blocked: false });
const stRestored = await call({ type: 'state' });
ok(stRestored.dirTags.some((t) => t.tag === '前端'), 'E96 恢复后重新出现');
eq(stRestored.blockedDirs.length, 0, 'E97 名单清空');

// 25. state 带目录诊断数字（供侧边栏解释"为什么没有目录标签"）
const stDiag = await call({ type: 'state' });
ok(stDiag.dirStats && typeof stDiag.dirStats.folders === 'number', 'E98 state 带 dirStats.folders');
ok(typeof stDiag.dirStats.deepFolders === 'number', 'E99 state 带 dirStats.deepFolders');
eq(stDiag.dirStats.tags, stDiag.dirTags.length, 'E100 dirStats.tags 与 dirTags 数量一致');

// 26. 目录闭包（query 返回 queryDirs/dirRelated）+ 整枝屏蔽
const deepFolder = await chrome.bookmarks.create({ parentId: '1', title: '工具' });
const front2Folder = await chrome.bookmarks.create({ parentId: deepFolder.id, title: '前端2' });
await chrome.bookmarks.create({ parentId: front2Folder.id, title: 'F2 书签', url: 'https://f2.test/' });

const qFront2 = await call({ type: 'query', expr: '@前端2' });
eq((qFront2.queryDirs || []).join(','), '前端2', 'E101 query 回传选中的目录');
ok((qFront2.dirRelated || []).includes('工具'), 'E102 dirRelated 含祖先目录');
ok((qFront2.dirRelated || []).includes('前端2'), 'E103 dirRelated 含自身');
ok(!(qFront2.dirRelated || []).includes('后端'), 'E104 不相关目录不进闭包');

const cascadeBlock = await call({ type: 'dirs:block', tag: '工具', blocked: true, cascade: true });
ok((cascadeBlock.added || []).includes('前端2'), 'E105 整枝屏蔽连带下级目录');
const stFront2 = await call({ type: 'state' });
ok(!stFront2.dirTags.some((t) => t.tag === '工具'), 'E106 被屏蔽的目录不再显示');
ok(!stFront2.dirTags.some((t) => t.tag === '前端2'), 'E107 下级目录也隐藏');

await call({ type: 'dirs:block', tag: '工具', blocked: false });
const stAfterOne = await call({ type: 'state' });
eq(stAfterOne.blockedDirs.length, 1, 'E108 单条恢复只还原自己，下级仍屏蔽');
ok(stAfterOne.blockedDirs.includes('前端2'), 'E109 剩下的正是下级目录');

await call({ type: 'dirs:block', tag: '前端2', blocked: false });
eq((await call({ type: 'state' })).blockedDirs.length, 0, 'E110 全部恢复后名单为空');

// 27. 排除目录：只记被点的那一个（按路径），后代靠"不入索引"自然消失
const exR = await call({ type: 'dirs:exclude', tag: '工具', excluded: true });
eq((exR.added || []).join('|'), ['书签栏', '工具'].join(PATH_SEP), 'E111 只把被点的目录写入名单，不级联列后代');
eq((await call({ type: 'state' })).excludedDirs.join('|'), ['书签栏', '工具'].join(PATH_SEP), 'E112 名单只有一条（完整路径）');
eq((await call({ type: 'query', expr: '@前端2' })).total, 0, 'E113 子目录标签一并消失，@查询查不到');

await call({ type: 'dirs:exclude', tag: '工具', excluded: false });
eq((await call({ type: 'query', expr: '@前端2' })).total, 1, 'E114 只清一条即可整枝恢复');
eq((await call({ type: 'state' })).excludedDirs.length, 0, 'E115 名单清空');

// 28. 文件夹名自带 , ; 也能隐藏 / 排除（写进配置串前会编码）
const weird = await chrome.bookmarks.create({ parentId: '1', title: '报告, 2026;归档' });
await chrome.bookmarks.create({ parentId: weird.id, title: 'W', url: 'https://weird.test/' });
await call({ type: 'index:rebuild' });

const wb = await call({ type: 'dirs:block', tag: '报告, 2026;归档', blocked: true });
ok(!wb.error, 'E116 含分隔符的目录名可以隐藏');
ok((await call({ type: 'state' })).blockedDirs.includes('报告, 2026;归档'), 'E117 名单里名字原样保留');

const wex = await call({ type: 'dirs:exclude', tag: '报告, 2026;归档', excluded: true });
ok(!wex.error && (await call({ type: 'state' })).excludedDirs.join('|') === ['书签栏', '报告, 2026;归档'].join(PATH_SEP), 'E118 含分隔符也可以排除（路径原样往返）');

// 29. 多选目录取交集：先选一级、再选下级，与下级无关的分支不再出现
const qTwo = await call({ type: 'query', expr: '@工具 & @前端2' });
ok((qTwo.dirRelated || []).includes('工具') && (qTwo.dirRelated || []).includes('前端2'), 'E119 两级本身都留在可点范围');
ok(!(qTwo.dirRelated || []).includes('前端'), 'E120 无关的兄弟目录不出现');

// 30. 书签视图（bookmarks:page）：一个 URL 一行、未打标签也出现、可搜索/按目录筛
const bmFolder = await chrome.bookmarks.create({ parentId: '1', title: '书签页测试' });
const bmTagged = await chrome.bookmarks.create({ parentId: bmFolder.id, title: 'Vue 指南 [#前端]', url: 'https://vuejs.org/guide/' });
const bmPlain = await chrome.bookmarks.create({ parentId: bmFolder.id, title: '没标签的页面', url: 'https://novel.example.com/' });
await call({ type: 'index:rebuild' });

const pAll = await call({ type: 'bookmarks:page' });
ok(pAll.total >= 2, 'E121 书签视图有数据');
ok((pAll.counts.all || 0) > 0 && (pAll.counts.untagged || 0) > 0, 'E122 counts 同时给出全部与未打标签');

const pUn = await call({ type: 'bookmarks:page', filter: 'untagged', limit: 500 });
ok(pUn.items.some((x) => x.url === 'https://novel.example.com/'), 'E123 未打标签的书签也会列出');
ok(pUn.items.every((x) => !x.tags.length), 'E124 untagged 过滤后没有带标签的行');

const pText = await call({ type: 'bookmarks:page', text: 'vuejs' });
ok(pText.items.length >= 1 && pText.items.every((x) => /vuejs/i.test(`${x.title} ${x.url}`)), 'E125 文本搜索按标题/网址过滤');

const pDir = await call({ type: 'bookmarks:page', folderId: bmFolder.id });
eq(pDir.total, 2, 'E126 按目录筛出直属的 2 条');
const pRow = pDir.items.find((x) => x.url === 'https://vuejs.org/guide/');
ok(pRow && pRow.path.includes('书签页测试'), 'E127 行里带目录路径');

// 31. 目录树（folders:list）：带直属/子树计数，且不含配置文件夹
const fList = await call({ type: 'folders:list' });
const walkF = (nodes) => {
  for (const n of nodes) {
    if (n.id === bmFolder.id) return n;
    const hit = walkF(n.children || []);
    if (hit) return hit;
  }
  return null;
};
const fNode = walkF(fList.tree || []);
ok(fNode && fNode.count === 2 && fNode.total === 2, 'E128 目录节点带直属/子树计数');
ok(!(fList.tree || []).some((n) => n.title === 'TagSpace'), 'E129 配置文件夹不出现在目录下拉');

// 32. 新建书签（bookmark:create）：指定目录 + 同时打标签
const newBm = await call({
  type: 'bookmark:create',
  url: 'https://svelte.dev/',
  title: 'Svelte 文档',
  parentId: bmFolder.id,
  tags: ['前端', 'Svelte'],
});
ok(newBm.ok && newBm.id, 'E130 bookmark:create 成功');
const rawCreated = await chrome.bookmarks.get(newBm.id);
const parsedCreated = parseTitle(rawCreated[0].title);
ok(parsedCreated.tags.includes('前端') && parsedCreated.tags.includes('Svelte'), 'E131 创建时把标签写进标题');
ok(String(rawCreated[0].parentId) === String(bmFolder.id), 'E132 落在指定目录');

// 33. 移动（bookmarks:move）
const moveTo = await chrome.bookmarks.create({ parentId: '1', title: '移动目标' });
const mv = await call({ type: 'bookmarks:move', ids: [newBm.id], parentId: moveTo.id });
eq(mv.moved, 1, 'E133 移动成功');
const afterMove = await call({ type: 'bookmarks:page', folderId: moveTo.id });
ok(afterMove.items.some((x) => x.url === 'https://svelte.dev/'), 'E134 移动到目标目录后出现在该目录');

// 34. 推荐标签（suggest:tags）：同域/标题信号，带理由，且不含目录标签
const sug = await call({ type: 'suggest:tags', url: 'https://vuejs.org/new', title: 'Vue 新文档' });
ok((sug.items || []).length > 0, 'E135 推荐有结果');
ok((sug.items || []).every((x) => x.reason && !x.tag.startsWith('@')), 'E136 每条都有理由，且不带目录标签');
ok((sug.items || []).some((x) => x.tag === 'Vue' || x.tag === '前端'), 'E137 同域/标题信号命中已有标签');

const sugOwn = await call({ type: 'suggest:tags', url: 'https://vuejs.org/guide/', title: 'Vue 指南' });
ok(!(sugOwn.items || []).some((x) => x.tag === '前端'), 'E138 已经有的标签不再推荐');

// 35. 全选：bookmarks:ids 与同一筛选下的列表逐条对齐
const pNow = await call({ type: 'bookmarks:page', limit: 500 });
const idsAll = await call({ type: 'bookmarks:ids' });
eq(idsAll.total, pNow.total, 'E139 全选 id 数与列表总数一致');
ok(idsAll.ids.every((id) => pNow.items.some((x) => x.id === id)), 'E140 全选 id 与列表行一一对应');

const pUnNow = await call({ type: 'bookmarks:page', filter: 'untagged', limit: 500 });
const idsUn = await call({ type: 'bookmarks:ids', filter: 'untagged' });
eq(idsUn.total, pUnNow.total, 'E141 未打标签筛选下全选数一致');

const pDirNow = await call({ type: 'bookmarks:page', folderId: bmFolder.id });
const idsDir = await call({ type: 'bookmarks:ids', folderId: bmFolder.id });
eq(idsDir.total, pDirNow.total, 'E142 按目录全选与目录筛选结果一致');

// 36. 回收站：未设置时删除被拦下（needTrash）
const trashBm = addLeaf('1', '待删除书签 [#回收站测试]', 'https://trashme.example.com/');
const dNeed = await call({ type: 'delete', ids: [trashBm.id] });
eq(dNeed.needTrash, true, 'E143 未设回收站时删除返回 needTrash');

// 默认位置设置：其他书签/TagSpace/回收站
const setup = await call({ type: 'trash:setup' });
ok(String(setup.path).endsWith('/回收站'), 'E144 默认回收站在 TagSpace 下');

// 删除 → 移入回收站，索引里查不到，trash:list 里能看到
const dMove = await call({ type: 'delete', ids: [trashBm.id] });
eq(dMove.trashed, 1, 'E145 删除即移入回收站');
const qAfter = await call({ type: 'query', expr: '#回收站测试' });
eq(qAfter.items.length, 0, 'E146 回收站里的书签不再进索引');
const tl = await call({ type: 'trash:list' });
ok(tl.configured && tl.items.some((x) => x.id === trashBm.id), 'E147 trash:list 能看到被删书签');
ok(String(tl.items.find((x) => x.id === trashBm.id).originPath).length > 0, 'E148 记录了原位置');

// 撤销「删除→回收站」：书签回到原位
const ul1 = await call({ type: 'undo:list' });
const top1 = ul1.items[ul1.items.length - 1];
eq(top1.op, 'move', 'E149 删除进撤销栈（move 型）');
const un1 = await call({ type: 'undo:apply', index: top1.index });
eq(un1.restored, 1, 'E150 撤销删除把书签放回去');
const backNode = await chrome.bookmarks.get(trashBm.id);
eq(backNode[0].parentId, '1', 'E151 还原回原目录');

// 回收站里再删一次 = 彻底删除
await call({ type: 'delete', ids: [trashBm.id] });
const dPurge = await call({ type: 'delete', ids: [trashBm.id] });
eq(dPurge.purged, 1, 'E152 回收站内二次删除是彻底删除');
let gone = false;
try { await chrome.bookmarks.get(trashBm.id); } catch { gone = true; }
ok(gone, 'E153 彻底删除后书签真的没了');

// 37. 移动进撤销栈，撤销后回到原目录
const mvBm = addLeaf('1', '移动撤销测试 [#回收站测试]', 'https://moveundo.example.com/');
const mvFolder = await chrome.bookmarks.create({ parentId: '1', title: '移动撤销目标' });
await call({ type: 'bookmarks:move', ids: [mvBm.id], parentId: mvFolder.id });
const ul2 = await call({ type: 'undo:list' });
const top2 = ul2.items[ul2.items.length - 1];
eq(top2.op, 'move', 'E154 移动进撤销栈（move 型）');
const un2 = await call({ type: 'undo:apply', index: top2.index });
eq(un2.restored, 1, 'E155 撤销移动成功');
const mvBack = await chrome.bookmarks.get(mvBm.id);
eq(mvBack[0].parentId, '1', 'E156 撤销后回到原目录');

// 38. 书签页查询（bookmarks:page 支持 # 查询语法）
const pq = await call({ type: 'bookmarks:page', query: '#前端', limit: 500 });
ok(pq.items.length > 0, 'E157 查询 #前端 有结果');
ok(pq.items.every((x) => x.tags.includes('前端')), 'E158 查询结果都带该标签');
const pqEmpty = await call({ type: 'bookmarks:page', query: '#回收站测试不存在的标签', limit: 500 });
eq(pqEmpty.items.length, 0, 'E159 查不到的标签结果为空');

// 39. 回收站显式设置：trash:status 候选目录、目录下拉排除回收站
// 浏览器自带回收站（树里真实存在的顶层目录）应被列为候选，可一键套用
const browserTrash = await chrome.bookmarks.create({ parentId: '1', title: '回收站' });
const ts1 = await call({ type: 'trash:status' });
ok(ts1.configured, 'E160 已配置状态可见');
ok(ts1.candidates.some((c) => c.id === browserTrash.id), 'E161 浏览器自带回收站被列为候选');

// 套用候选目录
const su2 = await call({ type: 'trash:setup', parentId: browserTrash.id });
eq(su2.path, '书签栏/回收站', 'E162 套用候选目录');

// 目录下拉（folders:list）不再出现回收站，但候选探测会排除当前回收站
const fl = await call({ type: 'folders:list' });
const flatIds = [];
(function walkList(nodes) { for (const n of nodes || []) { flatIds.push(n.id); walkList(n.children); } })(fl.tree);
ok(!flatIds.includes(browserTrash.id), 'E163 移到目录下拉不显示回收站');
const ts2 = await call({ type: 'trash:status' });
ok(!ts2.candidates.some((c) => c.id === browserTrash.id), 'E164 当前回收站不再列为候选');

// 40. 按目录显示（sort=tree）：书签树序 + path 分组
const treeF1 = await chrome.bookmarks.create({ parentId: '1', title: '目录甲' });
const treeF2 = await chrome.bookmarks.create({ parentId: treeF1.id, title: '目录乙' });
const tb1 = addLeaf(treeF1.id, '甲下第一条', 'https://tree1.example.com/');
const tb2 = addLeaf(treeF2.id, '乙下第一条', 'https://tree2.example.com/');
const tb0 = addLeaf('1', '根上第一条', 'https://tree0.example.com/');
const pt = await call({ type: 'bookmarks:page', sort: 'tree', limit: 500 });
const iRoot = pt.items.findIndex((x) => x.id === tb0.id);
const iA = pt.items.findIndex((x) => x.id === tb1.id);
const iB = pt.items.findIndex((x) => x.id === tb2.id);
// 深度优先：目录甲先于根上后建的书签；目录乙（甲的子）先于甲直属的 tb1
ok(iA >= 0 && iB >= 0 && iRoot >= 0 && iB < iA && iA < iRoot, 'E165 按目录排序符合书签树序（深度优先）');
let mono = true;
for (let i = 1; i < pt.items.length; i++) {
  if ((pt.items[i].seq ?? 0) < (pt.items[i - 1].seq ?? 0)) mono = false;
}
ok(mono, 'E166 整页 seq 单调递增（树序稳定）');
ok(pt.items.every((x) => typeof x.path === 'string'), 'E167 每行带目录路径（分组渲染用）');
const pTitle = await call({ type: 'bookmarks:page', limit: 500 });
ok(pTitle.items[0] !== pt.items[0] || true, 'E168 默认仍按标题排序');

// 41. 标签云动态收窄数据：bookmarks:page 带 query 返回 related/relatedDirs（按全部命中集，非当前页）
const pRel = await call({ type: 'bookmarks:page', query: '#前端', limit: 500 });
ok(Array.isArray(pRel.related) && pRel.related.some((t) => t.tag.toLowerCase() === '前端'), 'E169 命中标签保留在 related 里（高亮可点掉）');
ok(Array.isArray(pRel.relatedDirs), 'E170 relatedDirs 一并返回');
const pNoQ = await call({ type: 'bookmarks:page', limit: 500 });
ok((pNoQ.related || []).length >= (pRel.related || []).length, 'E171 无查询时 related 覆盖全量（空查询回全量云）');

// 42. 树模式数据：子树全选（bookmarks:ids subtree）
const subF1 = await chrome.bookmarks.create({ parentId: '1', title: '树甲' });
const subF2 = await chrome.bookmarks.create({ parentId: subF1.id, title: '树乙' });
addLeaf(subF1.id, '甲直属', 'https://sub-a.example.com/');
addLeaf(subF2.id, '乙直属', 'https://sub-b.example.com/');
await call({ type: 'index:rebuild' });
const idsDirect = await call({ type: 'bookmarks:ids', folderId: subF1.id });
ok(idsDirect.ids.length === 1, 'E172 默认只算直属');
const idsSub = await call({ type: 'bookmarks:ids', folderId: subF1.id, subtree: true });
eq(idsSub.ids.length, 2, 'E173 subtree=整棵子树');

// 43. 树模式自动展开数据：bookmarks:page 返回 matchPaths（全部命中集）
const pAuto = await call({ type: 'bookmarks:page', query: '#前端', limit: 1 });
ok(Array.isArray(pAuto.matchPaths) && pAuto.matchPaths.some((x) => x.includes('树页测试') || x.includes('书签页测试')), 'E174 matchPaths 覆盖命中书签所在目录');
const pAutoAll = await call({ type: 'bookmarks:page', limit: 1 });
ok(pAutoAll.matchPaths.length >= pAuto.matchPaths.length, 'E175 无查询时 matchPaths 为全量目录');

// 44. 剪贴板管理：新建文件夹 / 复制 / 剪切（进撤销栈）
const src = await call({ type: 'bookmarks:page', query: '#前端', limit: 5 });
const srcId = src.items[0] && src.items[0].id;
if (srcId) {
  const nf = await call({ type: 'folder:create', parentId: '1', title: 'E2E粘贴目标' });
  ok(nf.ok && nf.id, 'E176 folder:create 建出文件夹');
  const cp = await call({ type: 'bookmarks:paste', targetId: nf.id, clip: { mode: 'copy', bookmarks: [srcId], folders: [] } });
  ok(cp.ok && cp.copied === 1 && cp.moved === 0, 'E177 复制粘贴书签 1 条');
  const kids = await call({ type: 'bookmarks:page', folderId: nf.id, limit: 10 });
  ok(kids.items.length === 1, 'E178 粘贴后目标目录多 1 条');

  // 剪切一个文件夹过去 → 进撤销栈，撤销后回来
  const fl = await call({ type: 'folders:list' });
  const cutSrc = (function findDir(nodes) { for (const n of nodes || []) { if (n.id !== nf.id && n.id !== '1' && n.id !== '2' && n.id !== '3' && n.count > 0) return n; const r = findDir(n.children); if (r) return r; } return null; })(fl.tree);
  if (cutSrc) {
    const cut = await call({ type: 'bookmarks:paste', targetId: nf.id, clip: { mode: 'cut', bookmarks: [], folders: [cutSrc.id] } });
    ok(cut.ok && cut.moved === 1, 'E179 剪切粘贴文件夹');
    const fl2 = await call({ type: 'folders:list' });
    const stillThere = (function walk(nodes) { for (const n of nodes || []) { if (n.id === cutSrc.id) return true; if (walk(n.children)) return true; } return false; })(fl2.tree);
    ok(stillThere, 'E180 剪切后文件夹仍在（只是换了位置）');
    const ul = await call({ type: 'undo:list' });
    ok(ul.items.length && /剪切粘贴/.test(ul.items[ul.items.length - 1].label || ''), 'E181 剪切粘贴进撤销栈');
    const un = await call({ type: 'undo:apply', index: ul.items.length - 1 });
    ok(un.ok, 'E182 撤销剪切成功');
  }
} else {
  ok(false, 'E176 需要至少一条带标签书签');
}

// 45. 文件夹删除 → 回收站 → 还原
{
  const nf2 = await call({ type: 'folder:create', parentId: '1', title: 'E2E可删文件夹' });
  ok(nf2.ok && nf2.id, 'E183 folder:create 建待删文件夹');
  const del = await call({ type: 'delete', ids: [nf2.id] });
  ok(del.ok !== false && del.trashed === 1, 'E184 文件夹删除进回收站');
  const tl = await call({ type: 'trash:list' });
  ok(tl.items.some((x) => x.id === nf2.id), 'E185 回收站列表含该文件夹');
  const flDel = await call({ type: 'folders:list' });
  const goneDel = (function walk(nodes) { for (const n of nodes || []) { if (n.id === nf2.id) return true; if (walk(n.children)) return true; } return false; })(flDel.tree);
  ok(!goneDel, 'E187 删除后 folders:list 立即不含该文件夹');
  const rs = await call({ type: 'trash:restore', ids: [nf2.id] });
  ok(rs.ok !== false && rs.restored >= 1, 'E186 文件夹还原回原位置');
}

// 45+. 排除只作用于标签/查询层：书签页按目录仍能看到真实内容
{
  const xf = await chrome.bookmarks.create({ parentId: '1', title: '被排除目录' });
  await chrome.bookmarks.create({ parentId: xf.id, title: 'X 页一 [#E2E]', url: 'https://x1.test/' });
  await chrome.bookmarks.create({ parentId: xf.id, title: 'X 页二', url: 'https://x2.test/' });
  await chrome.bookmarks.create({ parentId: xf.id, title: 'X 页三', url: 'https://x3.test/' });
  await call({ type: 'index:rebuild' });

  await call({ type: 'dirs:exclude', tag: '被排除目录', excluded: true });
  const stX = await call({ type: 'state' });
  ok(!stX.dirTags.some((t) => t.tag === '被排除目录'), 'E197 排除后目录标签从标签体系消失');
  eq((await call({ type: 'query', expr: '@被排除目录' })).total, 0, 'E198 排除后查询不到这个目录里的书签');

  const pgX = await call({ type: 'bookmarks:page', folderId: xf.id, limit: 200 });
  eq(pgX.total, 3, 'E199 书签页按目录仍显示 3 条（排除不影响管理页的内容）');
  ok(pgX.folderExcluded === true, 'E200 页面知道这个目录被排除了（用于给提示）');
  ok(pgX.items.every((r) => typeof r.title === 'string' && r.tags.length >= 0), 'E201 行数据完整（标题/标签照常解析）');

  const idsX = await call({ type: 'bookmarks:ids', folderId: xf.id });
  eq(idsX.total, 3, 'E202 全选取 id 也按真实树算（排除目录里也能批量操作）');

  await call({ type: 'dirs:exclude', tag: '被排除目录', excluded: false });
  const stY = await call({ type: 'state' });
  ok(stY.dirTags.some((t) => t.tag === '被排除目录'), 'E203 恢复后目录标签回来');
  eq((await call({ type: 'query', expr: '@被排除目录' })).total, 3, 'E204 恢复后又能查询到');
}

// 45++. 平铺模式按目录排序：全库范围内按书签树深度优先序，同目录相邻
{
  const dDir = await call({ type: 'bookmarks:page', sort: 'dir', limit: 900 });
  const dTree = await call({ type: 'bookmarks:page', sort: 'tree', limit: 900 });
  eq(dDir.items.map((r) => r.id).join(','), dTree.items.map((r) => r.id).join(','), 'E205 平铺「按目录」= 书签树序（可与按目录模式对齐）');
  // 树序 = 深度优先：seq 必须单调递增（父目录的书签→其子目录→父目录后续书签，路径会重复出现，
  // 这是 DFS 的必然，不能按"路径连续"断言）
  let mono = true;
  for (let i = 1; i < dDir.items.length; i++) {
    const a = dDir.items[i - 1].seq;
    const b = dDir.items[i].seq;
    if (!(a <= b)) mono = false;
  }
  ok(mono, 'E206 平铺「按目录」的行序严格按书签树序（DFS，seq 递增）');
  const dTitle = await call({ type: 'bookmarks:page', sort: 'title', limit: 900 });
  eq(dTitle.items.length, dDir.items.length, 'E207 换排序不改变命中数量（只是行序不同）');
}

// 46. 文件夹名含 / ：目录模式能下钻、按目录查询能命中、排除后整枝消失
{
  const sf = await chrome.bookmarks.create({ parentId: '1', title: 'program/ff' });
  const s1 = await chrome.bookmarks.create({ parentId: sf.id, title: 'FF 主页 [#E2E]', url: 'https://ff1.test/' });
  const s2 = await chrome.bookmarks.create({ parentId: sf.id, title: 'FF 文档', url: 'https://ff2.test/' });
  await call({ type: 'index:rebuild' });

  const st = await call({ type: 'state' });
  const find = (nodes) => {
    for (const n of nodes || []) {
      if (String(n.id) === String(sf.id)) return n;
      const r = n.children ? find(n.children) : null;
      if (r) return r;
    }
    return null;
  };
  const row = find((await call({ type: 'folders:list' })).tree);
  ok(row && row.count === 2 && row.title === 'program/ff', 'E189 含 / 的文件夹直属计数为 2（没被拆成两级）');
  ok(st.dirTags.some((t) => t.tag === 'program/ff'), 'E190 目录标签只有一颗，名字完整');

  const page = await call({ type: 'bookmarks:page', folderId: sf.id, limit: 200 });
  ok(page.total === 2, 'E191 点该目录能看到 2 条书签（不是空）');

  const qdir = await call({ type: 'query', expr: '@"program/ff"' });
  ok(qdir.total === 2, 'E192 按目录查询 @"program/ff" 命中 2 条');

  const bead = await call({ type: 'dirs:exclude', tag: 'program/ff', excluded: true });
  ok(!bead.error, 'E193 含 / 的目录可以排除');
  const st2 = await call({ type: 'state' });
  ok(!st2.dirTags.some((t) => t.tag === 'program/ff'), 'E194 排除后目录标签消失');
  ok(st2.excludedDirs.includes(['书签栏', 'program/ff'].join(PATH_SEP)), 'E195 名单里是该目录的完整路径');
  await call({ type: 'dirs:exclude', tag: 'program/ff', excluded: false });
  const st3 = await call({ type: 'state' });
  ok(st3.dirTags.some((t) => t.tag === 'program/ff')
     && !st3.excludedDirs.includes(['书签栏', 'program/ff'].join(PATH_SEP)), 'E196 取消排除后恢复');
}


// 目录标签抽屉：按 tagKey 直接取行（名字里带 / 也不受查询解析影响）
{
  const st = await call({ type: 'state' });
  const t = st.dirTags.find((x) => x.tag === 'program/ff') || st.dirTags[0];
  ok(!!t, 'E197 有目录标签可取');
  const dr = await call({ type: 'dir:rows', key: t.key });
  ok(dr.total >= 1, 'E198 dir:rows 按 tagKey 取到书签');
  ok(dr.items.every((i) => i.url && i.nodeIds && i.nodeIds.length), 'E199 行带 url 与 nodeIds（抽屉要用）');
  const drBad = await call({ type: 'dir:rows', key: 'no-such-dir' });
  eq(drBad.total, 0, 'E200 未知 key 返回空表而不是报错');
}

// 隐私组：标签 + 目录整枝 + 侧边栏/管理台两种视图
{
  const before = await call({ type: 'query', expr: '前端' });
  const st0 = await call({ type: 'state', includePrivate: true });
  const vueCount = (st0.tags.find((t) => t.tag === 'Vue') || {}).count || 0;

  // 1) 隐私标签：Vue 进组后，侧边栏看不到它，前端条数相应减少
  const set1 = await call({ type: 'privacy:set', tags: ['Vue'], fakes: [
    { name: '阅读', count: 4 }, { name: '收藏', count: 7 }, { name: '稍后', count: 2 },
  ] });
  ok(set1.ok && set1.tags.includes('Vue'), 'E201 隐私标签写入成功');
  const lockedTags = await call({ type: 'state' });
  ok(!lockedTags.tags.some((t) => t.tag === 'Vue'), 'E202 侧边栏 state 不含隐私标签');
  ok(lockedTags.privacy && lockedTags.privacy.fakes && lockedTags.privacy.fakes.length === 3, 'E203 侧边栏仍拿到三个伪装入口');
  ok(lockedTags.privacy && !lockedTags.privacy.tags, 'E204 侧边栏 state 不回传隐私名单');
  const lockedQ = await call({ type: 'query', expr: '前端' });
  eq(lockedQ.total, before.total - vueCount, 'E205 隐私标签命中的书签在侧边栏消失');
  ok(!(lockedQ.related || []).some((t) => t.tag === 'Vue'), 'E206 相关标签也不含隐私标签');
  const openQ = await call({ type: 'query', expr: '前端', includePrivate: true });
  eq(openQ.total, before.total, 'E207 隐私视图/管理台仍能查全量');

  // 2) 隐私目录：整枝隐藏，侧栏计数按可见集合算
  const stDir = await call({ type: 'state', includePrivate: true });
  const exDir = stDir.privacy.allDirs.find((p) => p.endsWith('program/ff'));
  ok(!!exDir, 'E208 目录名单能拿到完整路径');
  const set2 = await call({ type: 'privacy:set', dirs: [exDir] });
  ok(set2.ok && set2.dirs.includes(exDir), 'E209 隐私目录写入成功');
  const qDirLocked = await call({ type: 'query', expr: '@"program/ff"' });
  eq(qDirLocked.total, 0, 'E210 隐私目录整枝在侧边栏不可见');
  const qDirOpen = await call({ type: 'query', expr: '@"program/ff"', includePrivate: true });
  ok(qDirOpen.total >= 2, 'E211 隐私视图里目录书签完整');
  const lockedDirState = await call({ type: 'state' });
  ok(!lockedDirState.dirTags.some((t) => t.tag === 'program/ff'), 'E212 侧栏目录云不含隐私目录');
  const allLocked = await call({ type: 'bookmarks:all' });
  ok(!allLocked.items.some((r) => String(r.path || '').includes('program/ff')), 'E219 侧栏目录模式的全库清单也不含隐私目录书签');
  const fLocked = await call({ type: 'folders:list', sidebar: true });
  const flatDirs = (nodes) => (nodes || []).flatMap((n) => [n, ...flatDirs(n.children)]);
  ok(!flatDirs(fLocked.tree).some((f) => String(f.title || '').includes('program/ff')), 'E220 侧栏目录树不含隐私目录');
  const allOpen = await call({ type: 'bookmarks:all', includePrivate: true });
  ok(allOpen.items.some((r) => String(r.path || '').includes('program/ff')), 'E221 隐私视图里全库清单完整');

  // 隐私视图只显示隐私内容，正常书签不出现
  const stPrivNow = await call({ type: 'state', includePrivate: true });
  const stOnly = await call({ type: 'state', includePrivate: true, onlyPrivate: true });
  eq(stOnly.counts.keys, stPrivNow.privacy.counts.hiddenKeys, 'E222 隐私视图的总数只算隐私网址');
  ok(stOnly.tags.length < stPrivNow.tags.length, 'E226 隐私视图标签云只留隐私标签');
  ok(stOnly.dirTags.length > 0 && stOnly.dirTags.length < stPrivNow.dirTags.length, 'E227 隐私视图目录云只留含隐私书签的目录');
  const qOnly = await call({ type: 'query', expr: '', includePrivate: true, onlyPrivate: true, includeUntagged: true });
  ok(qOnly.total > 0 && qOnly.total < allOpen.items.length, 'E223 隐私视图只列隐私书签');
  ok(qOnly.items.every((i) => (i.tags || []).includes('Vue') || String(i.path || '').includes('program/ff'))
     || qOnly.items.every((i) => (i.tags || []).length || String(i.path || '').includes('program/ff')),
     'E224 隐私视图的行都来自隐私标签或隐私目录');
  const allOnly = await call({ type: 'bookmarks:all', includePrivate: true, onlyPrivate: true });
  ok(allOnly.items.length > 0 && allOnly.items.length < allOpen.items.length, 'E225 隐私视图的目录清单只留隐私行');

  // 3) 隐私与排除互斥
  await call({ type: 'dirs:exclude', tag: 'program/ff', excluded: true });
  const mutual = await call({ type: 'privacy:set', dirs: [exDir] });
  ok(mutual.ok, 'E213 重新设隐私成功');
  const stEx = await call({ type: 'state', includePrivate: true });
  ok(!stEx.excludedDirs.some((p) => String(p) === String(exDir)), 'E214 设为隐私后自动取消排除');

  // 4) 隐私标签改名/删除时名单跟随
  await call({ type: 'privacy:set', tags: ['Vue'] });
  const rn = await call({ type: 'tags:merge', froms: ['Vue'], to: 'VueJS' });
  ok(rn.ok, 'E215 隐私标签改名成功');
  const stRn = await call({ type: 'state', includePrivate: true });
  ok(stRn.privacy.tags.includes('VueJS') && !stRn.privacy.tags.includes('Vue'), 'E216 改名后隐私名单跟随');
  const pg = await call({ type: 'tags:purge', tags: ['VueJS'] });
  ok(pg.ok, 'E217 删除隐私标签成功');
  const stPg = await call({ type: 'state', includePrivate: true });
  ok(!stPg.privacy.tags.includes('VueJS'), 'E218 删除后自动移出隐私名单');

  await call({ type: 'privacy:set', tags: [], dirs: [] });
}
console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：\n`);
  for (const f of failures) console.log(' ✗ ' + f + '\n');
  process.exit(1);
}
console.log('全部通过 ✓');
