// 单元测试：node tests/run.mjs
// 只测纯逻辑（title / index / query / config），不碰 chrome API。

import {
  parseTitle,
  buildTitle,
  normalizeTag,
  normalizeTags,
  tagKey,
  serializeConfig,
  parseConfig,
  setCI,
  lookupCI,
  splitTagInput,
} from '../lib/title.js';
import { buildIndex, canonicalUrl, globalTagCounts, sortDirTagsByTree, dirRelatedKeys, resolveDirEntries, pruneNestedPaths, collectFolderPaths, folderPathOf, PATH_SEP } from '../lib/index.js';
import {
  parse as parseQuery,
  evaluate,
  relatedTags,
  collectQueryTags,
  insertTag,
  removeTag,
} from '../lib/query.js';
import {
  categoryOf,
  configFileTitle,
  DEFAULT_PREFS,
  sanitizeConfFor,
  canonicalOrder,
  pickCanonical,
  mergeConfs,
  joinList,
  splitList,
} from '../lib/config.js';
import { colorFor, resolveColorValue, hashIndex } from '../lib/palette.js';
import { planReplaceTags, summarizePlan, validateTagTarget } from '../lib/ops.js';
import { scan as diagScan, planFix, issueMeta } from '../lib/diagnose.js';
import { readFileSync } from 'node:fs';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    failures.push(`${label}\n  期望 ${b}\n  实际 ${a}`);
  }
}

function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

function setEq(set, expected, label) {
  eq([...set].sort(), [...expected].sort(), label);
}

// ------------------------------------------------------------ 1. 标签校验

eq(normalizeTag('前端'), { ok: true, tag: '前端' }, 'T1 普通标签');
eq(normalizeTag('  设计   规范  '), { ok: true, tag: '设计 规范' }, 'T2 空白折叠');
eq(normalizeTag('C++').ok, true, 'T3 允许 +');
eq(normalizeTag('C#').ok, true, 'T4 允许 #');
eq(normalizeTag('').ok, false, 'T5 空名拒绝');
eq(normalizeTag('a[b').ok, false, 'T6 拒绝 [');
eq(normalizeTag('a]b').ok, false, 'T7 拒绝 ]');
eq(normalizeTag('a;b').ok, false, 'T8 拒绝 ;');
eq(normalizeTag('a=b').ok, false, 'T9 拒绝 =');
eq(normalizeTag('a,b').ok, false, 'T10 拒绝 ,');
eq(tagKey('JS'), 'js', 'T11 小写折叠');
eq(normalizeTags(['b', 'B', 'a']), ['a', 'b'], 'T12 大小写去重保留首次写法');
eq(normalizeTags(['Z', 'a', '中']), ['Z', 'a', '中'], 'T13 码点序（大写在小写前）');

// ------------------------------------------------------------ 2. 标题往返

eq(parseTitle('普通标题'), { text: '普通标题', tags: [], conf: null }, 'P1 无标签');
eq(
  parseTitle('普通标题 [#a][#b]'),
  { text: '普通标题', tags: ['a', 'b'], conf: null },
  'P2 标签组'
);
eq(
  parseTitle('标题 [#a] [**c:a=3]'),
  { text: '标题', tags: ['a'], conf: { v: 1, colors: { a: '3' }, aliases: {}, flags: {}, extras: {}, errors: [] } },
  'P3 标签 + 配置'
);
eq(parseTitle('[#a]').text, '', 'P4 空干净标题');
eq(parseTitle('a [#x] 中间还有字').tags, [], 'P5 标签不在末尾就不算标签');
eq(parseTitle('a [**c:x=1] 尾巴').conf, null, 'P6 配置不在末尾就不算配置');

eq(buildTitle('标题', ['b', 'a'], null), '标题 [#a][#b]', 'B1 排序');
eq(buildTitle('', ['a'], null), '[#a]', 'B2 空标题');
eq(buildTitle('标题', [], null), '标题', 'B3 无标签返回干净标题');
eq(buildTitle('标题', ['a'], { v: 1, colors: { a: '3' }, aliases: {}, flags: {}, extras: {} }), '标题 [#a] [**v:1;c:a=3]', 'B4 带配置');

// 往返不变量
const cases = [
  ['标题', ['a'], null],
  ['带空格的 标题', ['设计 规范', 'C++'], null],
  ['', [], null],
  ['只有标签', ['x'], { v: 1, colors: {}, aliases: {}, flags: {}, extras: { bmSort: 'title' } }],
  ['条目', ['p'], { v: 1, colors: {}, aliases: {}, flags: { p: 1 }, extras: {} }],
  ['多标签', ['a', 'b', 'c'], { v: 1, colors: { a: '3', b: '#4285f4' }, aliases: { x: 'a' }, flags: {}, extras: {} }],
];
for (const [text, tags, conf] of cases) {
  const built = buildTitle(text, tags, conf);
  const back = parseTitle(built);
  eq(
    { text: back.text, tags: back.tags },
    { text: text.trim(), tags: normalizeTags(tags) },
    `往返 ${JSON.stringify(text)}`
  );
  // 二次拼接必须完全一致（幂等）
  eq(buildTitle(back.text, back.tags, back.conf), built, `幂等 ${JSON.stringify(text)}`);
}

// 配置序列化顺序稳定
const c1 = { v: 1, colors: { b: '2', a: '1' }, aliases: {}, flags: {}, extras: {} };
const c2 = { v: 1, colors: { a: '1', b: '2' }, aliases: {}, flags: {}, extras: {} };
eq(serializeConfig(c1), serializeConfig(c2), 'S1 颜色按键排序，与插入顺序无关');
eq(serializeConfig({ v: 1, colors: {}, aliases: {}, flags: {}, extras: {} }), '', 'S2 只有版本号返回空');
eq(serializeConfig({ v: 1, colors: {}, aliases: {}, flags: {}, extras: { bmSort: 'title' } }), 'v:1;bmSort:title', 'S3 偏好');

eq(parseConfig('v:1;c:a=3,b=#fff').colors, { a: '3', b: '#fff' }, 'S4 解析多色');
eq(parseConfig('a:x=y').aliases, { x: 'y' }, 'S5 解析别名');
eq(parseConfig('p:1').flags.p, 1, 'S6 条目级标记');
eq(parseConfig('坏数据').errors.length, 1, 'S7 无冒号报错');

const dict = {};
setCI(dict, 'JS', '1');
setCI(dict, 'js', '2');
eq(dict, { JS: '2' }, 'S8 大小写不敏感覆盖');
eq(lookupCI(dict, 'js'), '2', 'S9 大小写不敏感读');
setCI(dict, 'js', null);
eq(dict, {}, 'S10 删键');

// ------------------------------------------------------------ 3. URL 归一化

eq(canonicalUrl('https://Example.com/A/'), 'example.com/A', 'U1 去尾斜杠 + host 小写');
eq(canonicalUrl('https://example.com'), 'example.com', 'U2 根路径');
eq(canonicalUrl('http://example.com/'), 'example.com', 'U3 http 与 https 同键');
eq(canonicalUrl('https://example.com:443/x'), 'example.com/x', 'U4 去默认端口');
eq(canonicalUrl('https://example.com:8443/x'), 'example.com:8443/x', 'U5 保留非默认端口');
eq(canonicalUrl('https://example.com/x#frag'), 'example.com/x', 'U6 去 fragment');
eq(canonicalUrl('https://example.com/x?a=1'), 'example.com/x?a=1', 'U7 保留 query');

// ------------------------------------------------------------ 4. 索引

const tree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          { id: '10', parentId: '1', title: 'Vue 官方文档 [#前端][#Vue]', url: 'https://vuejs.org/' },
          { id: '11', parentId: '1', title: 'React 文档 [#前端][#React]', url: 'https://react.dev/' },
          { id: '12', parentId: '1', title: '设计系统 [#设计][#前端]', url: 'https://design.example.com/' },
          { id: '13', parentId: '1', title: '没标签的页面', url: 'https://plain.example.com/' },
          {
            id: '14',
            parentId: '1',
            title: '重复收藏 [#Vue]',
            url: 'http://vuejs.org',
          },
        ],
      },
      {
        id: '2',
        title: '其他书签',
        children: [
          { id: '20', parentId: '2', title: 'TagSpace 配置·颜色 [**c:Vue=3]', url: 'chrome-extension://abc/space/space.html#cfg=colors' },
        ],
      },
    ],
  },
];

const idx = buildIndex(tree, { excludeIds: new Set(['20']) });

eq(idx.counts.nodes, 5, 'I1 计入的节点数');
eq(idx.counts.excluded, 1, 'I2 配置文件被排除');
eq(idx.allKeys.size, 4, 'I3 去重后的 URL 数（vuejs.org 两个位置）');
eq(idx.keyToNodes.get('vuejs.org').length, 2, 'I4 同一 URL 两个位置');
eq(idx.keyToTags.get('vuejs.org'), ['Vue', '前端'], 'I5 标签并集');
eq(idx.untaggedKeys.size, 1, 'I6 未打标签集合');
eq([...idx.untaggedKeys][0], 'plain.example.com', 'I7 未打标签的键');
eq(idx.tagToKeys.get('vue').size, 1, 'I8 标签到键（去重后仍 1）');
eq(idx.nodeById.get('10').text, 'Vue 官方文档', 'I9 干净标题');
eq(idx.nodeById.get('10').path, '书签栏', 'I10 目录路径');
eq(
  globalTagCounts(idx).map((t) => t.tag),
  ['前端', '设计', 'React', 'Vue'],
  'I11 标签按字母序（中文拼音在前、英文 A–Z 在后），次数只做平手裁决'
);

// ------------------------------------------------------------ 5. 查询

function run(expr) {
  const { ast, errors } = parseQuery(expr);
  const keys = evaluate(ast, idx, {});
  return { keys, ast, errors };
}

setEq(run('前端').keys, ['vuejs.org', 'react.dev', 'design.example.com'], 'Q1 单标签');
setEq(run('前端, Vue').keys, ['vuejs.org'], 'Q2 交集');
setEq(run('Vue + React').keys, ['vuejs.org', 'react.dev'], 'Q3 并集');
setEq(run('前端 - Vue').keys, ['react.dev', 'design.example.com'], 'Q4 差集');
setEq(run('前端 Vue').keys, ['vuejs.org'], 'Q5 隐式 AND');
setEq(run('(Vue + React), 前端').keys, ['vuejs.org', 'react.dev'], 'Q6 分组');
setEq(run('?vue').keys, ['vuejs.org'], 'Q7 全文检索（干净标题 + URL）');
setEq(run('!Vue').keys, ['react.dev', 'design.example.com', 'plain.example.com'], 'Q8 补集包含未打标签');
setEq(run('必不存在').keys, [], 'Q9 无结果');
setEq(
  run('').keys,
  ['vuejs.org', 'react.dev', 'design.example.com', 'plain.example.com'],
  'Q10 空表达式求值为全部（由背景层决定是否只显示已标签）'
);
ok(run('前端, , Vue').errors.length >= 1, 'Q11 错位逗号有提示');
setEq(run('前端, , Vue').keys, ['vuejs.org'], 'Q12 容错后仍求值（多余逗号当隐式 AND）');
setEq(run('未打标签').keys, ['plain.example.com'], 'Q13 虚拟标签');
setEq(run('(?vue)').keys, ['vuejs.org'], 'Q14 括号里的检索');
ok(run('(前端').errors.some((e) => e.reason === 'missing-paren'), 'Q15 未闭合括号提示');

// 相关标签：排除查询内标签
const rel = relatedTags(idx, run('前端').keys, { exclude: collectQueryTags(run('前端').ast) });
eq(rel.map((r) => r.tag).sort(), ['React', 'Vue', '设计'], 'Q16 相关标签排除查询标签');
eq(
  relatedTags(idx, run('前端, Vue').keys).map((r) => r.tag),
  ['前端', 'Vue'],
  'Q17 相关标签按结果集统计（不排除时包含查询标签本身；字母序：中文拼音块在前）'
);
eq(relatedTags(idx, new Set()).length, 0, 'Q18 空结果无相关标签');

// 表达式拼装
eq(insertTag('', 'a', 'and'), 'a', 'E1 空表达式加标签');
eq(insertTag('a', 'b', 'and'), 'a, b', 'E2 AND');
eq(insertTag('a', 'b', 'or'), 'a + b', 'E3 OR');
eq(insertTag('a', 'b', 'not'), 'a - b', 'E4 NOT');
eq(insertTag('', 'C++', 'and'), 'C\\+\\+', 'E5 转义');
eq(insertTag('a, b', 'a', 'and'), 'b', 'E6 已存在则移除');
eq(removeTag('a, b, c', 'b'), 'a, c', 'E7 中间移除');
eq(removeTag('b', 'b'), '', 'E8 唯一项移除');

// ------------------------------------------------------------ 6. 配置识别

eq(
  categoryOf({ url: 'chrome-extension://abc/space/space.html#cfg=colors', title: '随便改的名字' }),
  'colors',
  'C1 靠 URL 识别，改标题不影响'
);
eq(categoryOf({ url: 'chrome-extension://abc/space/space.html#cfg=prefs' }), 'prefs', 'C2 偏好');
eq(
  categoryOf({ url: 'https://x.test/y', title: 'TagSpace 配置·别名' }),
  'aliases',
  'C3 标题兜底'
);
eq(categoryOf({ url: 'https://x.test/y', title: '普通书签' }), null, 'C4 普通书签不算配置');
eq(categoryOf({ url: undefined, title: 'TagSpace 配置·颜色' }), null, 'C5 文件夹不算配置');
eq(configFileTitle('colors', 'v:1;c:a=3'), 'TagSpace 配置·颜色 [**v:1;c:a=3]', 'C6 拼配置标题');
eq(configFileTitle('colors', ''), 'TagSpace 配置·颜色', 'C7 空配置无后缀');
eq(sanitizeConfFor('aliases', { colors: { a: '1' }, aliases: { x: 'a' }, extras: {} }).colors, {}, 'C8 别名文件不透传颜色');
eq(sanitizeConfFor('prefs', { extras: { bmSort: 'url' } }).extras, { bmSort: 'url' }, 'C9 偏好只留 extras');
ok(DEFAULT_PREFS.bmSort === 'title', 'C10 默认偏好存在');

// ------------------------------------------------------------ 7. 颜色

eq(resolveColorValue('3'), '#c9a227', 'K1 调色板序号');
eq(resolveColorValue('#4285f4'), '#4285f4', 'K2 hex');
eq(resolveColorValue('#abc'), '#aabbcc', 'K3 三位 hex 展开');
eq(resolveColorValue('99'), null, 'K4 越界序号');
eq(colorFor('前端', { 前端: '3' }), '#c9a227', 'K5 配置优先');
ok(/^#[0-9a-f]{6}$/.test(colorFor('随便什么', {})), 'K6 未设色走哈希');
ok(hashIndex('前端') >= 0 && hashIndex('前端') < 12, 'K7 哈希范围');

// ------------------------------------------------------------ 8. 重复配置文件

const dupA = { id: '300', title: 'TagSpace 配置·颜色 [**v:1;c:前端=3]', url: 'chrome-extension://x/space/space.html#cfg=colors', dateAdded: 1000 };
const dupB = { id: '301', title: 'TagSpace 配置·颜色 [**v:1;c:前端=5,Chrome=#ff0000]', url: 'chrome-extension://x/space/space.html#cfg=colors', dateAdded: 2000 };
const dupC = { id: '302', title: 'TagSpace 配置·颜色 [**v:1;c:设计=7]', url: 'chrome-extension://x/space/space.html#cfg=colors', dateAdded: 1000 };

eq(canonicalOrder([dupB, dupA])[0].id, '300', 'R1 老文件优先');
eq(canonicalOrder([dupA, dupC]).map((n) => n.id), ['300', '302'], 'R2 同 dateAdded 按 id 排');
eq(pickCanonical([dupB, dupA]).id, '300', 'R3 挑出规范文件');
eq(pickCanonical([]), null, 'R4 空集合');
eq(canonicalOrder([dupA, dupB]).map((n) => n.id), canonicalOrder([dupB, dupA]).map((n) => n.id), 'R5 顺序与入参无关（跨设备一致）');

const m1 = mergeConfs('colors', [parseConfig('v:1;c:前端=3'), parseConfig('v:1;c:前端=5,Chrome=#ff0000')]);
eq(m1.conf.colors, { 前端: '3', Chrome: '#ff0000' }, 'R6 冲突以规范文件为准，其余并集填充');
eq(m1.conflicts, [{ key: '前端', kept: '3', dropped: '5' }], 'R7 冲突被记录');
eq(m1.filled, 1, 'R8 填充计数');

const m2 = mergeConfs('colors', [parseConfig('v:1;c:设计=7'), parseConfig('v:1;c:设计=7')]);
eq(m2.conflicts.length, 0, 'R9 同值不算冲突');

const m3 = mergeConfs('aliases', [parseConfig('v:1'), parseConfig('v:1;a:前端开发=前端;c:前端=3')]);
eq(m3.conf.aliases, { 前端开发: '前端' }, 'R10 别名文件不混入 c:');
eq(m3.conf.colors, {}, 'R11 别名合并后颜色为空');

const m4 = mergeConfs('prefs', [parseConfig('v:1;bmSort:title;view:cloud'), parseConfig('v:1;bmSort:url;click:new')]);
eq(m4.conf.extras, { bmSort: 'title', view: 'cloud', click: 'new' }, 'R12 偏好冲突保留规范值，其余补齐');
eq(m4.conf.v, 1, 'R13 版本号');

const m5 = mergeConfs('prefs', [parseConfig('v:1;p:1'), parseConfig('v:2;r:1')]);
eq(m5.conf.v, 2, 'R14 版本取最大');
eq(m5.conf.flags, { p: 1, r: 1 }, 'R15 布尔标记取或');

eq(mergeConfs('colors', []).sources, 0, 'R16 空输入不炸');

// ------------------------------------------------------------ 9. 批量计划

const p1 = planReplaceTags(idx, ['前端'], '前端开发');
eq(p1.keys, 3, 'T1 三个标签集合用到「前端」');
eq(p1.writes.length, 4, 'T2 四个位置要改写（vuejs 两处）');
eq(p1.writes[0].before, 'Vue 官方文档 [#前端][#Vue]', 'T3 旧标题');
eq(p1.writes[0].after, 'Vue 官方文档 [#Vue][#前端开发]', 'T4 新标题按码点序重排');
eq(p1.to, '前端开发', 'T5 目标标签');
eq(p1.mergedIntoExisting, 0, 'T6 目标原本不存在');

const p2 = planReplaceTags(idx, ['设计'], '');
eq(p2.writes.length, 1, 'T7 删除标签只改受影响的集合');
eq(p2.writes[0].after, '设计系统 [#前端]', 'T8 剩下别的标签');

const p3 = planReplaceTags(idx, ['Vue'], '前端');
eq(p3.mergedIntoExisting, 1, 'T9 目标已存在时算合并');
eq(p3.writes.length, 2, 'T10 两个位置都写');
eq(p3.writes[0].after, 'Vue 官方文档 [#前端]', 'T11 去重后只剩一个');

const p4 = planReplaceTags(idx, ['vue'], 'Vue2');
eq(p4.writes.length, 2, 'T12 源标签大小写不敏感');

const p5 = planReplaceTags(idx, ['前端'], '前端');
eq(p5.writes.length, 0, 'T13 改成同名不产生写');
eq(p5.unchangedKeys, 3, 'T14 三个集合被跳过');

const p6 = planReplaceTags(idx, ['不存在的标签'], 'X');
eq(p6.writes.length, 0, 'T15 没有匹配的标签');
eq(p6.keys, 0, 'T16 影响集合为 0');

const s1 = summarizePlan(p1);
eq(s1.nodes, 4, 'T17 预演节点数');
eq(s1.ms, 32, 'T18 预估耗时（8ms/条）');
eq(s1.samples.length, 4, 'T19 样例条数');

ok(validateTagTarget('').ok === false, 'T20 空名字不合法');
ok(validateTagTarget('a;b').ok === false, 'T21 含分号不合法');
ok(validateTagTarget('a[b').ok === false, 'T22 含方括号不合法');
eq(validateTagTarget('  前端开发  ').tag, '前端开发', 'T23 去空格后合法');
ok(validateTagTarget('C++').ok, 'T24 允许加号');

// ------------------------------------------------------------ 9.7 名单编码
// 文件夹名里的 , ; % 不能把配置串拆坏
eq(splitList(joinList(['回收站', 'A,B;C', '100%'])).join('|'), '回收站|A,B;C|100%', 'T65 名单往返保留 , ; %');
eq(joinList(['A,B;C']), 'A%2CB%3BC', 'T66 编码把分隔符换成 %2C / %3B');

// ------------------------------------------------------------ 9.8 目录闭包
// 单选：同枝全部；先选一级再选下级：只留跟每个已选项都同枝的目录
const sibTree = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', children: [
    { id: '11', title: 'A', children: [
      { id: '111', title: 'B', children: [{ id: '1111', title: 'b', url: 'https://b.test/' }] },
      { id: '112', title: 'C', children: [{ id: '1121', title: 'c', url: 'https://c.test/' }] },
    ] },
    { id: '12', title: 'D', children: [{ id: '121', title: 'd', url: 'https://d.test/' }] },
  ] },
  { id: '2', title: '其他书签', children: [] },
] }];
const sibIdx = buildIndex(sibTree);
const relA = dirRelatedKeys(sibIdx, [tagKey('A')]);
ok(relA.has(tagKey('B')) && relA.has(tagKey('C')), 'T73 单选 A：B 与 C 都算同枝');
ok(!relA.has(tagKey('D')), 'T74 单选 A：另一枝的 D 不在闭包内');

const relAB = dirRelatedKeys(sibIdx, [tagKey('A'), tagKey('B')]);
ok(relAB.has(tagKey('A')) && relAB.has(tagKey('B')), 'T75 A+B：两级本身都留着');
ok(!relAB.has(tagKey('C')), 'T76 A+B：与 B 无关的兄弟分支 C 消失');
ok(!relAB.has(tagKey('D')), 'T77 A+B：跨枝的 D 也不在');

// 同名子目录不能把两条枝"缝"成同枝：目录关系必须在路径图上算
const twinTree = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', children: [
    { id: '11', title: '设计', children: [
      { id: '111', title: 'blog', children: [{ id: '1111', title: 'b1', url: 'https://b1.test/' }] },
      { id: '112', title: 'Animate', children: [{ id: '1121', title: 'a1', url: 'https://a1.test/' }] },
    ] },
    { id: '12', title: '技巧', children: [
      { id: '121', title: '网络技巧', children: [
        { id: '1211', title: 'blog', children: [{ id: '12111', title: 'b2', url: 'https://b2.test/' }] },
        { id: '1212', title: 'Animate', children: [{ id: '12121', title: 'a2', url: 'https://a2.test/' }] },
      ] },
    ] },
  ] },
  { id: '2', title: '其他书签', children: [] },
] }];
const twinIdx = buildIndex(twinTree);
const twinRel = dirRelatedKeys(twinIdx, [tagKey('设计'), tagKey('网络技巧')]);
eq([...twinRel].sort().join('|'), [tagKey('设计'), tagKey('网络技巧')].sort().join('|'),
   'T81 两条枝各有同名 blog/Animate，也不会被算成同枝');
ok(!dirRelatedKeys(twinIdx, [tagKey('设计')]).has(tagKey('网络技巧')),
   'T82 单选 设计 时 网络技巧 不在相关集里');

// ------------------------------------------------------------ 10. 健康检查

const dirty = [
  {
    id: '0',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          { id: '30', title: '顺序错 [#前端][#Vue]', url: 'https://a.example/' },
          { id: '31', title: '重复标签 [#JS][#js]', url: 'https://b.example/' },
          { id: '32', title: '括号漏了 [#前后端', url: 'https://c.example/' },
          { id: '33', title: '中间夹标签 [#游离] 后面还有字', url: 'https://d.example/' },
          { id: '34', title: '配置不在末尾 [#末][**v:1] 尾巴', url: 'https://e.example/' },
          { id: '35', title: '同网址位置一 [#甲]', url: 'https://same.example/' },
          { id: '36', title: '同网址位置二 [#乙]', url: 'https://same.example/' },
          { id: '37', title: '干净 [#Alpha][#Beta]', url: 'https://clean.example/' },
        ],
      },
      {
        id: '2',
        title: '其他书签',
        children: [
          { id: '40', title: 'TagSpace 配置·颜色 [**c:JS=0;c:不存在=5;c:坏=zzz]', url: 'chrome-extension://abc/space/space.html#cfg=colors' },
        ],
      },
    ],
  },
];

const didx = buildIndex(dirty, { excludeIds: new Set(['40']) });
const issues = diagScan(didx, {
  config: { colors: { JS: '0', 不存在: '5', 坏: 'zzz' }, aliases: {} },
  configFiles: {},
  duplicates: [],
  configErrors: [],
});
const kindsOf = new Set(issues.map((i) => i.kind));

ok(kindsOf.has('tag-order'), 'T25 查出标签顺序不合规');
ok(kindsOf.has('tag-duplicate'), 'T26 查出同标签重复');
ok(kindsOf.has('tag-unclosed'), 'T27 查出括号不闭合');
ok(kindsOf.has('tag-stray'), 'T28 查出标签混在正文里');
ok(kindsOf.has('conf-not-last'), 'T29 查出配置组不在末尾');
ok(kindsOf.has('multi'), 'T30 查出同网址多位置不一致');
ok(kindsOf.has('color-invalid'), 'T31 查出非法颜色值');
ok(kindsOf.has('color-orphan'), 'T32 查出颜色指向不存在的标签');
ok(kindsOf.has('cfg-missing'), 'T33 查出配置文件缺失');

const cleanHit = issues.find((i) => i.kind === 'tag-order');
eq(cleanHit.count, 1, 'T34 只有 #30 顺序不合规（单标签无从谈顺序）');
ok(cleanHit.samples.length <= 5, 'T35 样例最多 5 条');
eq(issueMeta('tag-order').fixable, true, 'T36 顺序可自动修');
eq(issueMeta('tag-unclosed').fixable, false, 'T37 括号不闭合只报告');

const fixOrder = planFix(didx, ['tag-order']);
eq(fixOrder.writes.length, 1, 'T38 顺序问题只改那一条');
eq(fixOrder.writes[0].after, '顺序错 [#Vue][#前端]', 'T39 改成码点序');

const fixDup = planFix(didx, ['tag-duplicate']);
eq(fixDup.writes[0].after, '重复标签 [#JS]', 'T40 重复的只留一个');

const fixMulti = planFix(didx, ['multi']);
eq(fixMulti.writes.length, 2, 'T41 两个位置都写');
ok(fixMulti.writes.every((w) => w.after.includes('[#甲]') && w.after.includes('[#乙]')), 'T42 按并集统一');

const fixColor = planFix(didx, ['color-invalid', 'color-orphan'], { config: { colors: { JS: '0', 不存在: '5', 坏: 'zzz' } } });
eq(Object.keys(fixColor.colors).join(','), 'JS', 'T43 只留下合法且有用的颜色');

// 干净数据不该报问题
const clean = [
  { id: '0', children: [{ id: '1', title: '书签栏', children: [{ id: '50', title: '正常 [#Alpha][#Beta]', url: 'https://ok.example/' }] }] },
];
const cidx = buildIndex(clean);
const cissues = diagScan(cidx, { config: { colors: {}, aliases: {} }, configFiles: {
    colors: { id: '9', title: 'x [**v:1]' },
    prefs: { id: '8', title: 'x [**v:1]' },
    aliases: { id: '7', title: 'x [**v:1]' },
  }, duplicates: [], configErrors: [] });
eq(cissues.length, 0, 'T44 干净数据零误报');

// ------------------------------------------------------------ 10.4 @ 前缀拼查询

eq(insertTag('', '前端', 'and', '@'), '@前端', 'T50 空表达式直接得到 @标签');
eq(insertTag('react', '前端', 'and', '@'), 'react, @前端', 'T51 追加保持 AND');
eq(insertTag('react, @前端', '前端', 'and', '@'), 'react', 'T52 再次点击同目录标签即取消');
eq(insertTag('', '前端', 'not', '@'), '!@前端', 'T53 非模式带前缀');

// 目录闭包：同一枝（祖先/后代/自身），跨枝不相关
const hierTree = [{ id: '0', title: '', children: [{ id: '1', title: '书签栏', children: [
  { id: '20', title: '工具', children: [
    { id: '21', title: '前端', children: [
      { id: '22', title: 'Vue', children: [
        { id: '23', title: '文档', children: [
          { id: '24', title: 'Vue 文档', url: 'https://x.test/', parentId: '23' },
        ] },
      ] },
    ] },
  ] },
  { id: '30', title: '设计', children: [
    { id: '31', title: '配色', children: [
      { id: '32', title: '色板', url: 'https://y.test/', parentId: '31' },
    ] },
  ] },
] }] }];
const hierIdx = buildIndex(hierTree);
ok(hierIdx.dirEdges.get(tagKey('前端')).has(tagKey('工具')), 'T54 父子边：前端 的父是 工具');
const relFront = dirRelatedKeys(hierIdx, [tagKey('前端')]);
eq([...relFront].sort().join('|'),
   [tagKey('工具'), tagKey('前端'), tagKey('Vue'), tagKey('文档')].sort().join('|'),
   'T55 选中前端：上下级全在闭合内');
ok(!relFront.has(tagKey('设计')) && !relFront.has(tagKey('配色')), 'T56 跨枝的 设计/配色 被排除');

// 硬排除：整棵子树不入索引
const skipIdx = buildIndex(hierTree, { skipDirs: ['书签栏/工具'] });
eq(skipIdx.counts.dirTags, 2, 'T57 排除 工具 后只剩另一枝的两个目录名');
ok(![...skipIdx.dirTagToKeys.keys()].includes(tagKey('前端')), 'T58 被排除枝的目录名不在索引里');
eq(skipIdx.allKeys.size, 1, 'T59 被排除枝里的书签也不进索引');

// 同名文件夹：按路径排除「回收站/前端」不能误伤「书签栏/前端」
const dupTree = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', children: [
    { id: '11', title: '前端', children: [
      { id: '111', title: 'keep', url: 'https://keep.test/' },
    ] },
  ] },
  { id: '9', title: '回收站', children: [
    { id: '91', title: '前端', children: [
      { id: '911', title: 'drop', url: 'https://drop.test/' },
    ] },
  ] },
] }];
const dupIdx = buildIndex(dupTree, { skipDirs: ['回收站/前端'] });
eq(dupIdx.allKeys.size, 1, 'T67 只排除同名的那一个：书签栏/前端 仍在索引');
// 老数据只有名字时，按名字解析成路径（行为与旧版等价）
const nameIdx = buildIndex(dupTree, { skipDirs: ['前端'] });
eq(nameIdx.allKeys.size, 0, 'T68 只有名字时按名字解析（两处同名一起排除）');
eq(resolveDirEntries(['前端'], [['书签栏', '前端'].join(PATH_SEP), ['回收站', '前端'].join(PATH_SEP)]).length, 2, 'T69 名字解析出全部同名路径');

// 老数据的级联后代条目：祖先已排除，后代条目应被清掉
eq(pruneNestedPaths([['回收站'].join(PATH_SEP), ['回收站', 't'].join(PATH_SEP), ['回收站', '已保存', '子'].join(PATH_SEP), ['书签栏', '工具'].join(PATH_SEP)]).join('|'),
  [['回收站'].join(PATH_SEP), ['书签栏', '工具'].join(PATH_SEP)].join('|'), 'T70 冗余后代条目被剪掉，只剩顶级目录');

// 老数据：级联后代同名条目只落在已排除目录内部，不能波及外面同名目录
const P = (...segs) => segs.join(PATH_SEP);
const legacyPaths = [P('回收站'), P('回收站', 't'), P('回收站', '前端'), P('书签栏', '前端'), P('书签栏', '工具')];
const legacyResolved = resolveDirEntries(['回收站', 't', '前端', '工具'], legacyPaths);
eq(legacyResolved.join('|'), [P('回收站'), P('回收站', 't'), P('回收站', '前端'), P('书签栏', '工具')].join('|'), 'T71 同名后代条目只解析到已排除目录内部');
eq(pruneNestedPaths(legacyResolved).join('|'), [P('回收站'), P('书签栏', '工具')].join('|'), 'T72 剪枝后书签栏/前端 不受牵连');

// 树根上的内容文件夹（如书签管理扩展建的「回收站」）不能当成根丢掉
const trashTree = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', children: [] },
  { id: '2', title: '其他书签', children: [] },
  { id: '9', title: '回收站', children: [
    { id: '91', title: '已保存的标签页 (2026-10-03, 11:34:53)', children: [
      { id: '92', title: '页面A', url: 'https://trash.test/', parentId: '91' },
    ] },
  ] },
] }];
const trashIdx = buildIndex(trashTree);
ok(trashIdx.dirTagToKeys.has(tagKey('回收站')), 'T60 直接挂在树根的回收站也是目录标签');
ok(trashIdx.dirTagToKeys.has(tagKey('已保存的标签页 (2026-10-03, 11:34:53)')), 'T61 它的子文件夹同样成为目录标签');
ok(trashIdx.dirEdges.get(tagKey('已保存的标签页 (2026-10-03, 11:34:53)')).has(tagKey('回收站')), 'T62 父子边正确');
ok(!trashIdx.dirTagToKeys.has(tagKey('书签栏')) && !trashIdx.dirTagToKeys.has(tagKey('其他书签')), 'T63 真正的根仍然不成为目录标签');
eq(trashIdx.counts.deepFolders, 2, 'T64 内容文件夹计数不含三个结构层');

// ------------------------------------------------------------ 10.5 目录标签诊断计数

const diagTree = [{
  id: '0', title: '', children: [
    { id: '1', title: '书签栏', children: [
      { id: '10', title: '前端', children: [
        { id: '11', title: 'Vue 文档', url: 'https://vuejs.org/', parentId: '10' },
      ] },
      { id: '12', title: '空文件夹', children: [] },
      { id: '13', title: '不在目录的资料', url: 'https://a.test/', parentId: '1' },
    ] },
    { id: '2', title: '其他书签', children: [] },
  ],
}];
const diagIdx = buildIndex(diagTree);
eq(diagIdx.counts.dirTags, 1, 'T47 只有含书签的文件夹成为目录标签');
eq(diagIdx.counts.deepFolders, 2, 'T48 深层文件夹计数含空文件夹、不含两个根');
ok(diagIdx.keyToDirTags.size === 1, 'T49 根上直挂的书签不带目录标签');

// ------------------------------------------------------------ 11. 样式兜底

// 组件自带 display:flex 会盖掉 [hidden]，没有这条兜底，抽屉/弹窗会常显且关不掉
for (const f of ['space/space.css', 'sidepanel/panel.css', 'popup/popup.css']) {
  const css = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css), `T45 ${f} 有 [hidden] 兜底`);
}

// T46：拼接损伤守卫——脚本批量改文件时若把标识符和 $( 粘在一起（如 `x$('#btnSpace')`），
// 语法仍合法但会在运行时把整段逻辑吞掉，node --check 抓不出来，只能靠源码扫描
for (const f of ['space/space.js', 'space/tags.js', 'space/overview.js', 'sidepanel/panel.js', 'popup/popup.js']) {
  const js = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const bad = js.match(/[A-Za-z0-9_]\$\(\s*['"]#/g) || [];
  eq(bad.length, 0, `T46 ${f} 无标识符粘连 $( 的拼接损伤`);
}

// T46a：侧边栏不能依赖原生 confirm——内嵌视图里它不弹窗、直接返回 false
{
  const js = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  ok(!/\bconfirm\s*\(/.test(js), 'T46a 侧边栏不使用原生 confirm');
  ok(/armOrConfirm/.test(js), 'T46b 删除/清空改成就地二次确认');
}

// T46c：行密度三档（侧边栏），标签不做截断
{
  const html = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  ok(/id="densityBtn"/.test(html), 'T46c 侧边栏有密度按钮');
  ok(/\['normal', 'compact', 'ultra'\]/.test(js), 'T46d 密度三档');
  ok(/'panel\.density'/.test(js), 'T46e 密度只存本机');
  ok(/data-density="ultra"/.test(css), 'T46f 极简档有样式');
  ok(!/LEARN|\+N|maxTags/.test(js), 'T46g 标签不截断');
  ok(/li\.addEventListener\('click'/.test(js), 'T46h 整行可点勾选');
  ok(/closest\('input, button, \.chip, \.badge'\)/.test(js), 'T46i 交互区不抢点击');
  ok(/width: fit-content; max-width: 100%/.test(css), 'T46j 标题按钮只包文字（右侧留白可勾选）');
}

// T83：回收站机制（后台）——删除进回收站、二次删除彻底删、索引排除、move 型撤销
{
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const pn = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  ok(bg.includes("type === 'trash:setup'"), 'T83a trash:setup 消息');
  ok(bg.includes("type === 'trash:list'"), 'T83b trash:list 消息');
  ok(bg.includes("type === 'trash:restore'"), 'T83c trash:restore 消息');
  ok(bg.includes("type === 'trash:purge'"), 'T83d trash:purge 消息');
  ok(bg.includes('needTrash'), 'T83e 未设回收站时删除返回 needTrash');
  ok(bg.includes('removeTree'), 'T83f 彻底删除用 removeTree');
  ok(/trashPath.*skipDirs|skipDirs.*trashPath/s.test(bg) || bg.includes("skip = trashPath && !exPaths.includes(trashPath)"), 'T83g rebuild 把回收站路径注入排除');
  ok(bg.includes('pushUndo(label, entries, op)'), 'T83h pushUndo 带 op');
  ok(/entry\.op === 'move'/.test(bg), 'T83i applyUndo 按 move 分发');
  ok(/`删除 \${undoEntries\.length} 条 → 回收站`/.test(bg), 'T83j 删除标签文案');
  // 管理页
  ok(sp.includes('id="bmTrash"') && sp.includes('id="trashPanel"'), 'T84a 管理页有回收站入口与面板');
  ok(sp.includes('id="bmUndoBox"') && sp.includes('id="bmUndoList"'), 'T84b 管理页有最近操作面板');
  ok(bm.includes("query: st.query"), 'T84c 书签页请求带查询');
  ok(bm.includes('纯查询框'), 'T84d 搜索框=纯查询（输入即查询，全文走 ?词）');
  ok(/UNDO_SHOW = 5/.test(bm) && /UNDO_MAX = 10/.test(bm), 'T84e 最近操作 5 条 + 更多 10 条');
  ok(bm.includes("closest('input, button, a, .chip, .x, .bm-badge, .bm-sug')"), 'T84f 管理页整行空白可勾选');
  // 侧边栏
  ok(pn.includes('askTrashSetup'), 'T85a 侧边栏首次删除询问回收站');
  ok(pn.includes('needTrash'), 'T85b 侧边栏处理 needTrash');
  ok(pn.includes('已移入回收站'), 'T85c 侧边栏删除提示改为回收站');
  // bookmarks:page 查询
  ok(bg.includes('queryKeySet'), 'T86 bookmarks:page/ids 查询交集');
}

// T87：书签页标签云 / 按目录显示 / 回收站显式设置
{
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  ok(bg.includes("type === 'trash:status'"), 'T87a trash:status 消息');
  ok(bg.includes('TRASH_CANDIDATE_NAMES'), 'T87b 候选回收站名列表');
  ok(bg.includes('detectTrashCandidates'), 'T87c 候选目录探测');
  ok(/resolveTrash\(false\).*skipIds|skipIds.add\(trashNow.id\)/s.test(bg), 'T87d 目录下拉排除回收站');
  ok(bg.includes("msg.sort === 'tree'"), 'T87e bookmarks:page 树序');
  ok(sp.includes('id="bmCloud"') && sp.includes('id="bmCloudBtn"'), 'T87f 书签页标签云');
  ok(sp.includes('id="bmSort"') && sp.includes('data-s="tree"'), 'T87g 按标题/按目录切换');
  ok(sp.includes('id="trashCandidates"') && sp.includes('id="trashNoDetect"'), 'T87h 候选与"识别不到"提示');
  ok(sp.includes('id="trashRelocate"'), 'T87i 更换位置入口');
  ok(bm.includes('toggleCloudToken'), 'T87j 云 chip 点击切换查询词');
  ok(bm.includes('renderFolderRow'), 'T87k 目录树文件夹行渲染');
  ok(bm.includes('renderTrashSetup'), 'T87l 设置界面渲染');
  ok(/bookmarks:page'\)[^}]*rebuildPending/s.test(bg) || /if \(rebuildPending\) await rebuild\(\); \/\/ 刚增删的书签/s.test(bg), 'T87m bookmarks:page 索引过期先重建');
}

// T88：目录树折叠 / 标签云收窄与着色
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(!sp.includes('bmFolderBtn') && !sp.includes('bmFolderPop'), 'T88a 「所有目录」筛选下拉已移除（用目录 chip + 组头下钻）');
  ok(!sp.includes('bmMoveToBtn') && !sp.includes('bmMoveToPop'), 'T88b 移到目录按钮+浮层已移除（剪贴板粘贴替代）');
  ok(!sp.includes('<select id="bmFolder"') && !sp.includes('<select id="bmMoveTo"'), 'T88c 原生下拉已移除（不可折叠）');
  ok(bm.includes('const paneState = { L: newPane(), R: newPane() }'), 'T88d 每栏独立折叠/选中状态（双窗）');
  ok(bm.includes("'bm.dirOpen'"), 'T88e 折叠状态存本机');
  ok(!bm.includes('function openTreePop') && !bm.includes('function renderTreeInto'), 'T88f 浮层树渲染已随移到目录移除');
  ok(bm.includes('function renderTreeMode'), 'T88g 树模式整棵树渲染');
  ok(bm.includes('function loadDirRows'), 'T88g1 展开目录懒加载直属书签');
  ok(bm.includes('hiddenRows'), 'T88h 折叠数进摘要');
  ok(!bm.includes('moveTarget'), 'T88i 移动目标状态已删（粘贴承担移动）');
  ok(bm.includes('st.related') && bm.includes('st.relatedDirs'), 'T88j 云收窄数据接入');
  ok(bm.includes('colorFor(name, colors)'), 'T88k 云 chip 用 colorFor 着色');
  ok(css.includes('.bm-cloud-chip.on') && css.includes('background: currentColor'), 'T88l 选中态反白与侧边栏同款');
  ok(!css.includes('.bm-pop') && css.includes('.bm-group-arrow'), 'T88m 浮层样式已删、组头箭头样式保留');
  ok(/bookmarks:page[\s\S]{0,6000}relatedTags\(index, matchedKeys\)/.test(bg), 'T88n bookmarks:page 返回 related');
  ok(bg.includes('翻页时云不能跟着变'), 'T88o related 按全部命中集算');
}

// T89：管理页搜索框纯查询化 + 组头下钻
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(sp.includes('?全文'), 'T89a placeholder 明示全文搜走 ?');
  ok(bm.includes('currentNeedle'), 'T89b 打字即时过滤云');
  ok(bm.includes('activeQueryNames'), 'T89c 裸名/#/@ 归一化高亮与摘除');
  ok(bm.includes("e.key !== 'Escape'"), 'T89d Esc 逐词回退');
  ok(bm.includes('160'), 'T89e 输入防抖');
  ok(bm.includes('function renderCrumb'), 'T89f 下钻面包屑');
  ok(sp.includes('id="bmCrumb"'), 'T89g 面包屑容器');
  ok(bm.includes("点击只看这个目录"), 'T89h 组头名字=下钻');
  ok(css.includes('.bm-crumb-seg'), 'T89i 面包屑样式');
}

// T90：按目录=真目录树（方案 B）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(bm.includes('DIR_FETCH_LIMIT'), 'T90a 直属书签一次出全（500 截断有提示）');
  ok(bm.includes('curPane().visible'), 'T90b 全选可见=活动窗格当前渲染的书签');
  ok(bm.includes("tree ? '全选可见' : '全选本页'"), 'T90c 按钮文案按模式切换');
  ok(bm.includes('subtree: st.sort'), 'T90d 全选全部在树模式按子树');
  ok(bm.includes('invalidateTree'), 'T90e 条件变化作废懒加载缓存');
  ok(bm.includes('findFolderNode'), 'T90f 下钻定位子树');
  ok(bm.includes("p.textContent = '载入中…'"), 'T90g 懒加载占位提示');
  ok(bm.includes('仅显示前'), 'T90h 超限截断明示');
  ok(bg.includes('msg.subtree'), 'T90i bookmarks:ids 支持子树范围');
  ok(bg.includes('folderScope.has(String(n.parentId))'), 'T90j 子树按父目录集合过滤');
}

// T91：树行序与叶子文件夹可展开
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes('walk(n.children, true, depth + 1); // 文件夹靠前'), 'T91a 子文件夹先于直属书签');
  ok(bm.includes('node.count > 0'), 'T91b 叶子文件夹（无子但有书签）也可展开');
}

// T92：树模式查询自动展开
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(bg.includes('matchPaths'), 'T92a bookmarks:page 返回全部命中目录路径');
  ok(bm.includes('function updateAutoOpen'), 'T92b 自动展开集合计算');
  ok(bm.includes('autoCollapsed'), 'T92c 手动收起优先于自动展开');
  ok(/return pane\.dirOpen\.has\(id\) \|\| pane\.autoOpen\.has\(id\)/.test(bm), 'T92d dirIsOpen 融合自动展开（按窗格）');
}

// T93：操作带书签搜索框 + 返回上级 + 切换按钮搬家
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  ok(sp.includes('id="bmTextSearch"'), 'T93a 操作带书签搜索框');
  ok(sp.indexOf('bmTextSearch') < sp.indexOf('bmAllPage'), 'T93b 搜索框在「全选可见」左侧');
  ok(sp.includes('平铺书签'), 'T93c 按标题已改名平铺书签');
  ok(!sp.includes('按标题'), 'T93d 旧「按标题」文案已移除');
  ok(sp.indexOf('id="bmSort"') > sp.indexOf('id="bmBulk"'), 'T93e 排序切换已搬进操作带');
  ok(!sp.includes('bmUpBtn'), 'T93f 返回上级按钮已删（面包屑是唯一回退入口）');
  ok(!bm.includes('bmUpBtn'), 'T93g 返回上级逻辑已删');
  ok(bm.includes('function renderCrumb') && bm.includes("pane.folderId = targetPath ? pathToId.get(targetPath)"), 'T93h 面包屑承担回退（双窗按栏跳转）');
  ok(bm.includes("st.text = e.target.value.trim()"), 'T93i 书签搜索写 st.text');
  ok(!/st\.query = e\.target\.value\.trim\(\);\s*\n\s*st\.text = ''/.test(bm), 'T93j 标签查询框不清书签搜索词');
  ok(bm.includes('text: st.text'), 'T93k 懒加载带书签搜索词');
}

// T94：剪贴板管理（新建文件夹/复制/剪切/粘贴）+ 文件夹复选框 + 紧凑 + 箭头
{
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bg.includes("type === 'folder:create'"), 'T94a 后台支持新建文件夹');
  ok(bg.includes("type === 'bookmarks:paste'"), 'T94b 后台支持剪贴板粘贴');
  ok(bg.includes('pushUndo(`剪切粘贴'), 'T94c 剪切粘贴进撤销栈');
  ok(bg.includes('copyTree'), 'T94d 文件夹整棵复制（标题带走=标签保留）');
  ok(sp.includes('bmNewFolder') && sp.includes('bmCopy') && sp.includes('bmCut') && sp.includes('bmPaste'), 'T94e 四个剪贴板按钮');
  ok(!sp.includes('bmMoveTo') && !sp.includes('id="bmMove"'), 'T94f 移到目录/移动按钮已删');
  ok(bm.includes('function splitSelection'), 'T94g 选中拆书签/文件夹');
  ok(bm.includes('clip = { mode'), 'T94h 剪贴板状态');
  ok(bm.includes("sel.has(node.id) ? ' on' : ''"), 'T94i 文件夹行复选框选中态（按窗格选中集）');
  ok(bm.includes("cb.addEventListener('change', () => setSelected(node.id"), 'T94j 文件夹复选框可点');
  ok(css.includes('.bm-folder-row.on'), 'T94k 文件夹行选中高亮');
  ok(/\.bm-group-arrow\s*{[^}]*font-size:\s*14px/.test(css), 'T94l 箭头加大到 14px');
  ok(/\.bm-head, \.bm-row {[^}]*padding: 4px/.test(css), 'T94m 行距紧凑 4px');
  ok(/\.bm-url {[^}]*line-height:\s*1\.3/.test(css), 'T94n 行高收紧');
}

// T95：面包屑进表头 / 剪贴板组分隔符 / 当前层级橙色
{
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const head = sp.slice(sp.indexOf('class="bm-head"'), sp.indexOf('id="bmRows"'));
  ok(head.includes('id="bmCrumb"') && !head.includes('bmUpBtn'), 'T95a 面包屑内嵌表头（返回上级已删）');
  ok(!/<div id="bmCrumb"/.test(sp), 'T95b 顶部独立面包屑行已移除');
  const seps = [...sp.matchAll(/bulk-sep/g)].map((m) => m.index);
  // 操作带新分区：视图切换 | 打标签与目录操作 | 选择与剪贴板，两处分隔符夹住中间组
  const iDual = sp.indexOf('id="bmDual"');
  const iAllPage = sp.indexOf('id="bmAllPage"');
  const iNewFolder = sp.indexOf('id="bmNewFolder"');
  const iCopy = sp.indexOf('id="bmCopy"');
  const sepBetween = (a, b) => seps.some((i) => i > a && i < b);
  ok(sepBetween(iDual, iAllPage), 'T95c 批量选择组左侧分隔符（收起目录/双窗之后）');
  ok(sepBetween(iNewFolder, iCopy), 'T95c2 剪贴板组左侧分隔符（新建文件夹之后）');
  ok(bm.includes('const isCur = dirIsOpen(pane, node.id)'), 'T95d 橙色=展开状态（手动+自动都算，按窗格）');
  ok(css.includes('.bm-folder-row.cur') && css.includes('#f59e0b'), 'T95e 展开行橙色样式');
  ok(css.includes('.bm-crumb-head'), 'T95f 表头内嵌面包屑样式');
}

// T96：操作带设计语言统一 + 删除按钮支持文件夹
{
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(/\.bulk \.btn, \.bulk \.input, \.bulk select, \.bulk \.seg { height: 28px; border-radius: 8px; }/.test(css), 'T96a 操作带控件同高同圆角');
  ok(/\.bulk \.input, \.bulk select\.input { font-size: 12\.5px/.test(css), 'T96b 输入框同字号');
  ok(!sp.includes('>删除书签<'), 'T96c 删除书签已改名「删除」');
  ok(sp.includes('title="删除选中的书签/文件夹（移入回收站，可还原）"'), 'T96d 删除按钮提示含文件夹');
  ok(bm.includes('个文件夹`'), 'T96e 确认文案按书签/文件夹分别计数');
}

// T97：树模式 refresh 重拉目录树（删除/剪切/新建后立即生效）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(/async function refresh\(\) \{[\s\S]*?await loadFolders\(\)/.test(bm), 'T97a refresh 时重拉 folders:list');
  ok(bm.includes('!idToPath.get(p.folderId)'), 'T97b 下钻目录被删后自动退回全部目录（逐栏守卫）');
  ok(/invalidateTree\(\);[\s\S]{0,120}dirtyTree\(\);/.test(bm), 'T97c refresh 时打脏树行缓存（删除书签立即消失）');
}

// T98：侧边栏云高自适应（=内容高度，刚好展示到最底下一行）
{
  const pj = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  const ph = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  ok(pj.includes('function applyCloudMode'), 'T98a 云高自适应函数');
  ok(pj.includes("el.style.height = 'auto'") && pj.includes('60vh'), 'T98b 高度=内容、上限 60vh');
  ok(pj.includes('applyCloudMode();'), 'T98c render 同步');
  ok(!ph.includes('splitter') && !pc.includes('.splitter') && !pj.includes('LAYOUT_KEY'), 'T98d 拖动分隔线机制已退役');
  ok(!pj.includes('applyCloudHeights'), 'T98e 旧的固定高度函数已移除');
}

// T99：目录云按树结构序（DFS 位次，同名取最早）
{
  // twinTree：设计(book, Animate) —— DFS 位次 设计=0, blog=1, Animate=2
  const twinIdx = buildIndex(twinTree, {});
  eq(
    [twinIdx.dirOrder.get(tagKey('设计')), twinIdx.dirOrder.get(tagKey('blog')), twinIdx.dirOrder.get(tagKey('animate'))].join(','),
    '0,1,2',
    'T99a dirOrder 记录 DFS 位次'
  );
  const list = [
    { key: 'animate', tag: 'Animate', count: 1 },
    { key: 'blog', tag: 'blog', count: 1 },
    { key: '设计', tag: '设计', count: 1 },
  ];
  eq(
    sortDirTagsByTree(twinIdx, list).map((t) => t.tag),
    ['设计', 'blog', 'Animate'],
    'T99b 目录云按树结构序（父目录在前，子目录紧随其后）'
  );
  // 同名跨枝：取最早出现的位次，位置稳定
  const sameTree = [{ id: '0', title: '', children: [
    { id: '1', title: '书签栏', children: [
      { id: 'x1', title: '工具', children: [{ id: 'x11', title: 'a', url: 'https://a.test/' }] },
      { id: 'x2', title: '杂', children: [{ id: 'x21', title: 'b', url: 'https://b.test/' }] },
    ] },
    { id: '2', title: '其他书签', children: [
      { id: 'y1', title: '工具', children: [{ id: 'y11', title: 'c', url: 'https://c.test/' }] },
    ] },
  ] }];
  const sameIdx = buildIndex(sameTree, {});
  eq(sameIdx.dirOrder.get(tagKey('工具')), 0, 'T99c 同名目录取最早 DFS 位次');
  ok(/sortDirTagsByTree\(idx, out\)/.test(readFileSync(new URL('../background.js', import.meta.url), 'utf8')), 'T99d 后台三处目录云排序统一走 lib');
}

// T100：侧边栏清除体验与图标统一
{
  const pj = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  const ph = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  ok(/\.clear {[^}]*width: 26px/.test(pc), 'T100a 清除 × 点击区加大到 26px');
  ok(pj.includes("el.addEventListener('dblclick'"), 'T100b 双击云区空白清空输入');
  ok(pj.includes("e.target.closest('.tag, button, input, a, label, .mini')"), 'T100c chip/按钮上双击不误触');
  ok(ph.includes('id="btnRebuild" class="icon" title="重建索引"><svg'), 'T100d 重建按钮换 SVG 图标（与齿轮同规格）');
  ok(pc.includes('.icon svg { display: block; }'), 'T100e 图标 flex 居中');
}

// T101：侧边栏操作带重构 + 目录栏收起
{
  const pj = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  const ph = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  ok(!ph.includes('id="selAll"'), 'T101a 列表头全选按钮已删');
  ok(ph.includes('id="bulkAll"'), 'T101b 全选=操作带勾选框');
  ok(pj.includes('all.indeterminate'), 'T101c 半选三态');
  ok(!ph.includes('<div class="pane-head">\n      <span class="pane-title" id="count"'), 'T101d 列表头两行并一行');
  ok(ph.includes('id="densityBtn"') && ph.indexOf('id="densityBtn"') < ph.indexOf('id="tagInput"'), 'T101e 紧凑按钮在标签输入框左侧');
  ok(/\.bulk {[^}]*border-bottom: 1px solid/.test(pc), 'T101g 操作带上下分割线');
  ok(!/\.bulk {[^}]*border-radius/.test(pc) && !/\.bulk {[^}]*background: var\(--bg-soft\)/.test(pc), 'T101h 操作带无外框无底色');
  ok(pj.includes("bulkEl.querySelectorAll('[data-act]')"), 'T101i 操作带常驻按钮置灰');
  ok(/\.dir-pane\.off \.[\s\S]{0,80}display: none/.test(pc), 'T101j 目录关闭时整栏收起');
  ok(!pj.includes('目录标签已关闭'), 'T101k 已关闭提示文案删除');
  ok(pj.includes('splitTagInput(input)') && pj.includes('normalizeTagOrNull'), 'T101l 打标签切分规则与书签管理页一致');
  ok(ph.includes('带空格用引号'), 'T101m 打标签占位文案一致');
  ok(ph.includes('id="tagClear"'), 'T101n 打标签输入带 × 清除');
}

// T102：全选框原生尺寸 + 勾选框/已选计数在总条数左侧
{
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  const ph = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  ok(pc.includes('.bulk input[type="text"] {'), 'T102a 文本框样式不再命中勾选框');
  ok(ph.indexOf('id="bulkAll"') < ph.indexOf('id="count"'), 'T102b 勾选框+已选计数在总条数左侧');
  ok(!/\.bulk input {/.test(pc.replace('.bulk input[type="text"] {', '.bulk-x {')), 'T102c 旧的 .bulk input 通配样式已收窄');
}

// T103：书签页补全 + 云默认开 + 目录子串补齐
{
  const pj = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const ps = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const pc = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(ps.includes('id="bmSuggest"'), 'T103a 补全下拉容器存在');
  ok(pc.includes('.suggest {') && pc.includes('top: calc(100% + 4px)'), 'T103b 补全下拉贴输入框下沿');
  ok(pj.includes('updateSug()') && pj.includes('ArrowDown') && pj.includes('acceptSug'), 'T103c 补全键盘与采纳');
  ok(pj.includes("input.dispatchEvent(new Event('input'"), 'T103d 采纳后走统一 input 通路');
  ok(pj.includes("$('#bmCloud').hidden = false"), 'T103e 云默认开启：解除容器 hidden');
  ok(pj.includes('let fullDirs = []'), 'T103f 全量目录缓存');
  ok(pj.includes('terms.some((t) => n.includes(t))'), 'T103g 目录名含查询词即补齐（blog→blogbus）');
  ok(pj.includes('function queryTerms'), 'T103h 查询纯词提取');
}

// T104：双窗管理模式（双树实例 + 拖拽移动）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm.includes("const paneState = { L: newPane(), R: newPane() }") && bm.includes('let activePane'), 'T104a 双窗状态：两栏独立 cwd/展开/选中');
  ok(bm.includes('function activatePane') && bm.includes('selected = paneState[paneKey].selected'), 'T104b 活动窗格切换（操作带跟随）');
  ok(bm.includes("wrap.className = 'bm-dual-wrap' + (dual ? ' dual' : ' single')"), 'T104c 双窗/单窗布局切换');
  ok(bm.includes('function buildPane') && bm.includes('renderCrumbInto(crumbEl, pane)'), 'T104d 每栏独立面包屑');
  ok(sp.includes('id="bmDual"'), 'T104e 双窗开关按钮');
  ok(bm.includes("chrome.storage.local.set({ 'bm.dual': dual })"), 'T104f 双窗开关存本机');
  ok(bm.includes('bm.dirOpen.L') && bm.includes("bm.dirOpen.R'") && bm.includes('bm.paneFolder'), 'T104g 每栏展开/下钻位置持久化（含旧版迁移）');
  ok(bm.includes('function bindRowDrag') && bm.includes("e.dataTransfer.effectAllowed = 'move'"), 'T104h 行可拖拽');
  ok(bm.includes('function bindFolderDnD') && bm.includes('toggleDir(pane, node.id), 600'), 'T104i 文件夹行投放+悬停自动展开');
  ok(bm.includes('function bindDropTarget') && bm.includes('async function dropMove'), 'T104j 栏级投放=移到本栏下钻目录');
  ok(bm.includes("type: 'bookmarks:move', ids, parentId: targetId"), 'T104k 拖拽复用 bookmarks:move（后台撤销栈）');
  ok(bm.includes('for (const k of PANE_LIST) paneState[k].selected.clear()'), 'T104l 拖拽后清空两栏选择');
  ok(css.includes('.bm-dual-wrap.dual') && css.includes('.bm-folder-row.drop'), 'T104n 双窗布局与投放高亮样式');
  ok(bm.includes("for (const k of PANE_LIST) paneState[k].selected.clear();\n  selected = curPane().selected;"), 'T104o 筛选变化清空两栏选择');
}

// T105：双窗打磨（栏内列头/中缝按钮/插入拖拽/右键菜单/双窗按钮搬家）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(bm.includes("outerHead.hidden = dual"), 'T105a 双窗隐藏外层表头（每栏自己的列头）');
  ok(bm.includes("cols.className = 'bm-head bm-pane-cols'"), 'T105b 栏内列头与行同栅格');
  ok(sp.indexOf('id="bmDual"') > sp.indexOf('id="bmSort"'), 'T105c 双窗按钮在视图切换（按目录）右侧');
  ok(bm.includes("dualBtn.disabled = !tree"), 'T105d 双窗按钮随模式置灰');
  ok(bm.includes('function buildRail') && bm.includes("'复制 ⇨'") && bm.includes("'⇦ 移动'"), 'T105e 中缝固定方向复制/移动按钮（⇦/⇨ 统一箭头）');
  ok(bm.includes('function railRun') && bm.includes("type: 'bookmarks:paste', targetId, clip: { mode: 'copy'"), 'T105f 跨栏复制走剪贴板通路');
  ok(bm.includes('function bindBookmarkDrop') && bm.includes("above ? n.index : n.index + 1"), 'T105g 书签行投放=插入前/后（上下半行判定）');
  ok(bg.includes('idx != null ? { index: idx } : {}') && bg.includes('if (idx != null) idx++'), 'T105h 后台 move 支持插入位次（多条按序）');
  ok(css.includes('.bm-row.drop-above') && css.includes('.bm-row.drop-below'), 'T105i 插入指示线样式');
  ok(bm.includes('function openCtx') && bm.includes("addEventListener('contextmenu'"), 'T105j 右键菜单（文件夹+书签行）');
  ok(bm.includes('function renameFolder') && bm.includes('function renameRow'), 'T105k 行内重命名');
  ok(bg.includes("type === 'node:rename'") && bg.includes('buildTitle(title, p.tags, p.conf)'), 'T105l node:rename：书签改名保留标签后缀与指令串');
  ok(bm.includes('async function deleteNodes') && bm.includes('function createSubFolder'), 'T105m 右键删除/新建子文件夹复用现有流程');
  ok(bm.includes("for (const b of rail.querySelectorAll('[data-rail]')"), 'T105n 中缝按钮随来源栏选中置灰');
}

// T106：双窗二轮打磨（列头对齐/拖宽/收起目录/按钮简化）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm.includes("cols.append(c0, c1, c2)") && bm.includes("cols.classList.add('no-path')"), 'T106a 栏内列头含复选框占位（与行对齐），树模式无目录列');
  ok(css.includes('.bm-pane-cols span { white-space: nowrap; }'), 'T106b 列头文字不换行');
  ok(bm.includes('railFrac') && bm.includes("'bm.railFrac'") && bm.includes('gridTemplateColumns'), 'T106c 中缝拖拽调两栏宽度（存本机）');
  ok(css.includes('cursor: col-resize'), 'T106d 中缝拖拽光标');
  ok(sp.includes('id="bmCollapse"') && bm.includes("pane.dirOpen.clear()"), 'T106e 收起目录按钮：清活动窗格展开集');
  ok(bm.includes("collapseBtn.disabled = !tree"), 'T106f 收起目录随模式置灰');
  ok(!bm.includes('全选全部（'), 'T106g 全选全部不带数量');
  ok(bm.includes("'复制 ⇨'") && bm.includes("'⇦ 复制'"), 'T106h 中缝按钮简化');
}

// T107：表头列分隔线 + 拖拽调列宽
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(css.includes('minmax(180px, var(--bm-colW-t, 1.5fr))') && css.includes('minmax(120px, var(--bm-colW-g, 1.4fr))'), 'T107a 列宽走 CSS 变量（表头与行同一套栅格）');
  ok(css.includes('.bm-colsplit') && css.includes('cursor: col-resize'), 'T107b 表头分隔线样式与拖拽光标');
  ok(bm.includes('function attachColSplit') && bm.includes("mk(2, 't', 180)") && bm.includes("mk(3, 'g', 120)"), 'T107c 两条分隔线：标题|标签、标签|目录');
  ok(bm.includes("'bm.colW'") && bm.includes('applyColW'), 'T107d 列宽存本机 bm.colW');
  ok(bm.includes("addEventListener('dblclick'") && bm.includes("colW[view][key] = null"), 'T107e 双击分隔线恢复默认');
  ok(bm.includes('attachColSplit(cols') && bm.includes("attachColSplit(outerHead"), 'T107f 双窗栏内列头与平铺外层表头都有分隔线');
  ok(css.includes('minmax(60px, 1fr)'), 'T107g 目录列吃剩余空间（保底 60px）');
  ok(!css.includes('grid-template-columns: 30px minmax(220px, 1.5fr)'), 'T107h 覆盖规则不得回退为固定栅格（曾导致拖拽失效）');
}

// T108：列对齐修复 + 分隔线可见性 + 拖拽上限
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm.includes('box.className = \'bm-dirrows\'; // 不再整盒缩进') || bm.includes('不再整盒缩进'), 'T108a 树书签行不再整盒缩进（缩进放标题格内）');
  ok(bm.includes('function renderRow(row, pane, depth = 0)') && bm.includes('main.style.paddingLeft = `${10 + depth * 12}px`'), 'T108b 深度缩进在「标题+网址」整格内（两行左缘对齐），行栅格与表头同轨');
  ok(css.includes('background: var(--line);') && css.includes('.bm-colsplit:hover::after, .bm-colsplit.drag::after { background: var(--accent); width: 3px; }'), 'T108c 分隔线默认常显，悬停/拖动橙色加粗');
  ok(bm.includes('const maxW = Math.max(minW, avail - 30 - otherNow - (noPath ? 120 : 60) - 24);'), 'T108d 列宽拖拽有上限（按另一列实际冻结宽算），目录列不被挤出可视区');
}

// T109：分隔线稳定性（冻结弹性列 / 双线重定位 / 窗口缩放）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes("if (key === 'g' && !colW[view].t) colW[view].t = Math.round(kids[1].getBoundingClientRect().width);"), 'T109a 拖拽时冻结未拖的弹性列成像素宽（防 fr 重分配挤动）');
  ok(bm.includes('head._placeSplits(); // 两条分隔线都跟着栅格走'), 'T109b 拖动中两条分隔线实时重定位');
  ok(bm.includes("window.addEventListener('resize'") && bm.includes('for (const head of splitHeads)'), 'T109c 窗口缩放后分隔线重定位');
  ok(bm.includes('requestAnimationFrame(() => head._placeSplits())'), 'T109d 双击恢复默认后双线重定位');
}

// T110：列宽按视图独立（根治双窗共享列宽互相挤垮）+ 表头滚动条补偿（根治错位）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes("colW = { flat: { t: null, g: null }, tree: { t: null, g: null }, L: { t: null, g: null }, R: { t: null, g: null } }"), 'T110a 列宽 flat/tree/L/R 四视图独立');
  ok(bm.includes("function applyColW(host, view)"), 'T110b 列宽变量落到宿主（pane 或 bm-table）');
  ok(bm.includes('applyColW(el, paneKey); // pane 每次渲染重建，列宽变量重打'), 'T110c 双窗 pane 渲染时重打本栏列宽');
  ok(bm.includes('attachColSplit(cols, paneKey)') && bm.includes("attachColSplit(outerHead, 'flat')"), 'T110d 分隔线带视图键');
  ok(bm.includes('function compensateScrollbar') && bm.includes('flatRows.offsetWidth - flatRows.clientWidth'), 'T110e 表头补偿滚动条宽度');
  ok(bm.includes('requestAnimationFrame(compensateScrollbar)'), 'T110f render 后补滚动条（含懒加载重渲染）');
  ok(bm.includes('saved.t != null') && bm.includes('!saved.flat'), 'T110g 旧全局列宽迁移给平铺视图');
}

// T111：拖拽上限按另一列实际宽算 + 目录列保底降到 60px
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes("(key === 'g' ? colW[view].t : colW[view].g) || Math.round(kids[otherIdx].getBoundingClientRect().width)"), 'T111a 上限用另一列实际冻结宽（无值时回退实测宽，防上限虚高致行区横向溢出）');
  ok(bm.includes('getComputedStyle(head)'), 'T111b 上限扣真实内边距（含滚动条补偿）');
  ok(!bm.includes('otherMin'), 'T111c 旧的最小宽口径已移除');
}

// T112：中缝两组按钮之间留足间隔（防误点）+ 箭头统一
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(css.includes('gap: min(300px, 22vh)'), 'T112a 两组方向按钮间隔 300px（窗口矮时按 22vh 收）');
  ok(bm.includes("'复制 ⇨'") && bm.includes("'移动 ⇨'") && bm.includes("'⇦ 复制'") && bm.includes("'⇦ 移动'"), 'T112b 箭头统一 ⇦/⇨');
  ok(!bm.includes('➤') && !bm.includes('⇤ 复'), 'T112c 旧箭头已清理');
}

// T113：按目录模式不显示目录列（3 列）+ 缩进整格上提（标题/网址左缘对齐）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm.includes('function setHeadPath(head, mode)'), 'T113a 表头列数随模式切换（同时切列宽视图）');
  ok(bm.includes("setHeadPath(outerHead, 'tree')") && bm.includes("setHeadPath(outerHead, 'flat')"), 'T113b 树模式去目录列、平铺模式恢复');
  ok(bm.includes("line.classList.add('no-path')") && bm.includes('line.append(cb, main, tags);'), 'T113c 树模式行不渲染目录格');
  ok(css.includes('.bm-head.no-path, .bm-row.no-path') && css.includes('minmax(120px, 1fr);'), 'T113d 无目录列 3 栏栅格（标签列恒吃剩余）');
  ok(bm.includes('if (kids.length >= 4) mk(3'), 'T113e 无目录列时只挂「标题|标签」一条分隔线');
  ok(bm.includes("Math.min(node.depth, 6) * 12"), 'T113f 文件夹行缩进级距与书签行统一 12px');
}

// T114：平铺/按目录列宽彻底分开（栅格结构不同，共用会互相污染）+ 树模式标签列恒吃剩余
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(!/no-path[^}]*var\(--bm-colW-g/.test(css), 'T114a 树模式标签列不接像素列宽（右侧不留空）');
  ok(bm.includes("head.dataset.colview = mode"), 'T114b 模式切换时改列宽视图键');
  ok(bm.includes("const view = head.dataset.colview || 'flat'"), 'T114c 分隔线运行时读视图键（切换后写对的那份）');
  ok(bm.includes('if (!noPathMode) {'), 'T114d 树模式不冻结标签列为像素宽');
  ok(bm.includes("tree: { t: Number(saved.tree && saved.tree.t) || null"), 'T114e tree 视图独立持久化');
}

// T115：分隔线加粗 + 与右侧列名留空隙（表头与行同步左内距，不破坏逐列对齐）
{
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(css.includes('left: 5px; width: 2px;'), 'T115a 分隔线默认 2px 加粗');
  ok(css.includes('width: 3px; }') && css.includes('var(--accent); width: 3px'), 'T115b 悬停/拖动 3px 橙色');
  ok(css.includes('.bm-head > span + span, .bm-row > :nth-child(n + 2) { padding-left: 10px; }'), 'T115c 表头与第 2 列起统一 10px 左内距（分隔线不贴列名）');
}

// T116：书签右键菜单三处补齐（目录模式 + 平铺模式 + 侧边栏）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const pn = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  ok(bm.includes('function bookmarkCtxItems(line, row, withClip)') && bm.includes("label: '复制网址'"), 'T116a 书签菜单含「复制网址」');
  ok(bm.includes("label: '重命名（标签保留）'") && bm.includes("label: '删除（进回收站）'"), 'T116b 菜单含重命名与删除');
  ok(bm.includes("ctxClip('cut', row.id)"), 'T116c 目录模式菜单含剪切（勾选集优先）');
  ok(bm.includes("ctxClip('copy', row.id)"), 'T116d 目录模式菜单含复制（勾选集优先）');
  ok(bm.includes('bookmarkCtxItems(line, row, !!pane)'), 'T116e 平铺模式也挂右键菜单（无剪切/复制）');
  ok(bm.includes('async function copyUrl') && bm.includes("document.execCommand('copy')"), 'T116f 复制网址带 textarea 回退');
  ok(pn.includes('function openCtx(x, y, items)') && pn.includes("label: '复制网址'"), 'T116g 侧边栏右键含复制网址');
  ok(pn.includes("type: 'node:rename'") && pn.includes('await run();'), 'T116h 侧边栏重命名走 node:rename 并重查');
  ok(pc.includes('.ctx-menu') && pc.includes('.row-rename'), 'T116i 侧边栏菜单/行内输入框样式');
}

// T117：目录模式右键「粘贴到此处目录」——目标由右键位置推出，不是当前下钻目录
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes('async function pasteInto(targetId, targetName)'), 'T117a 右键专用 pasteInto（显式目标目录）');
  ok(bm.includes('const parentId = row.parentId ? String(row.parentId) : curPane().folderId || BOOKMARKS_BAR_ID;'), 'T117b 书签右键 → 粘贴到它所在的父目录');
  ok(bm.includes('run: () => pasteInto(node.id, name)'), 'T117c 文件夹右键 → 粘贴进该文件夹本身');
  ok(bm.includes('targetPath.startsWith(`${p}${PATH_SEP}`)'), 'T117d 防呆：剪切的文件夹不能粘进自己/子树');
  ok(bm.includes('已粘贴到「${targetName}」'), 'T117e 粘贴结果 toast 标出目标目录');
  ok(bm.includes("if (clip.mode === 'cut') clip = null; // 剪切是一次性的"), 'T117f 剪切粘贴后清空剪贴板');
}

// T118：右键复制/剪切的作用域（无勾选=右键这一项，有勾选=勾选集）
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes('function ctxClip(mode, fallbackId)'), 'T118a ctxClip 统一入口');
  ok(bm.includes('const ids = selected.size ? [...selected] : [fallbackId];'), 'T118b 有勾选走勾选集，否则只右键的这一项');
  ok(bm.includes("ctxClip('cut', node.id)") && bm.includes("ctxClip('copy', node.id)"), 'T118c 文件夹右键同样走 ctxClip');
  ok(bm.includes('const { bmIds, dirIds } = splitSel(new Set(ids));'), 'T118d 书签/文件夹分开归类进剪贴板');
}

// T119：操作带三段分区（视图切换 | 打标签与目录操作 | 选择与剪贴板），中间组两侧有分隔符
{
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const ids = ['bmTextSearch', 'bmSort', 'bmCollapse', 'bmDual', 'bmAllPage', 'bmAllMatch', 'bmClearSel',
    'bmTags', 'bmAdd', 'bmRemove', 'bmNewFolder', 'bmCopy', 'bmCut', 'bmPaste', 'bmDelete'];
  const pos = ids.map((id) => sp.indexOf(`id="${id}"`));
  ok(pos.every((v, i) => v > 0 && (i === 0 || v > pos[i - 1])), 'T119a 操作带顺序：搜索|切换|收起目录|双窗 → 全选组|打标签 → 剪贴板');
  const seps = [...sp.matchAll(/bulk-sep/g)].map((m) => m.index);
  const sepBetween = (a, b) => seps.some((i) => i > a && i < b);
  ok(sepBetween(sp.indexOf('id="bmDual"'), sp.indexOf('id="bmAllPage"')) && sepBetween(sp.indexOf('id="bmNewFolder"'), sp.indexOf('id="bmCopy"')),
    'T119b 两处分隔符：双窗之后、新建文件夹之后');
}

// T120：品牌名 TagMyBookmarks / 作者 vivikuyo，且磁盘数据标识（TagSpace 配置目录）保持不变
{
  const mf = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const cfg = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
  ok(mf.name === 'TagMyBookmarks' && mf.action.default_title === 'TagMyBookmarks', 'T120a 扩展显示名与按钮标题');
  ok(pkg.author === 'vivikuyo', 'T120b package.json 作者 vivikuyo');
  ok(cfg.includes("CONFIG_DIR_NAME = 'TagSpace'") && cfg.includes("CONFIG_FILE_PREFIX = 'TagSpace 配置·'"), 'T120c 磁盘标识仍为 TagSpace（旧配置/同步数据不受影响）');
  const panel = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  ok(panel.includes('Tag<span>MyBookmarks</span>') && !panel.includes('Tag<span>Space</span>'), 'T120d 侧边栏顶栏品牌名 TagMyBookmarks');
}

// T121：标签页「最近操作」与书签页同口径折叠（默认 5 条，更多→10 条，再点收起）
{
  const sp = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const tg = readFileSync(new URL('../space/tags.js', import.meta.url), 'utf8');
  ok(sp.includes('id="undoMore"'), 'T121a 标签页最近操作有「更多/收起」按钮');
  ok(tg.includes('const UNDO_SHOW = 5;') && tg.includes('const UNDO_MAX = 10;'), 'T121b 折叠阈值与书签页一致（5 → 10）');
  ok(tg.includes('const show = undoExpanded ? UNDO_MAX : UNDO_SHOW;'), 'T121c 列表按折叠状态截断');
  ok(tg.includes("more.textContent = undoExpanded ? '收起' : `更多（${Math.min(r.items.length, UNDO_MAX)}）`;"), 'T121d 按钮文案：更多（N）/收起');
  ok(tg.includes("undoMore.addEventListener('click'"), 'T121e 点击切换展开状态并重渲染');
}

// T122：标签墙每个 chip 常驻「重命名 / 删除」，且不触发外层点击
{
  const tg = readFileSync(new URL('../space/tags.js', import.meta.url), 'utf8');
  ok(tg.includes('function chipActions(t)'), 'T122a chip 操作组构造器');
  ok(tg.includes("renameBtn.textContent = '重命名'") && tg.includes("purgeBtn.textContent = '删除'"), 'T122b 两个动作常驻（不靠 hover）');
  const usesStop = (tg.match(/e\.stopPropagation\(\);/g) || []).length >= 2
    && tg.includes('doReplace([t.tag])') && tg.includes('doPurge([t.tag])');
  ok(usesStop, 'T122c 点击动作不透传到 chip，避免同时触发查询');
  ok(tg.includes("chip.append(ck, dot, name, n, chipActions(t));"), 'T122d chip 结构：勾选 + 颜色点 + 名字 + 计数 + 就地操作');
  ok(!tg.includes("'big'") && !tg.includes("'mid'") && tg.includes("chip.className = 'tagchip';"), 'T122e chip 统一尺寸（不再按书签数分档）');
}

// T123：chip 与「目录标签」云 chip 同一套视觉规格
{
  const cc = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(cc.includes('font-size: 14px; line-height: 1.4;') && cc.includes('padding: 2px 8px;'),
     'T123a chip 字号与内边距与云 chip 一致');
  ok(cc.includes('.tagchip:hover { border-color: var(--accent); color: var(--accent); }'),
     'T123b 悬停同为描边+文字变 accent');
  ok(cc.includes('.tagchip.on { border-color: var(--accent); background: var(--accent); color: #fff; }'),
     'T123c 选中同为反白实底');
  ok(cc.includes('.tagchip.on .chip-acts button') && cc.includes('.tagchip.on .chip-n'),
     'T123d 反白态下计数与就地按钮一起转白（可读性）');
}

// T124：chip 圆弧外框尺寸统一 —— 高度写死、盒模型按 border-box，内部件不再把 pill 撑高
{
  const cc2 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(cc2.includes('height: 26px; box-sizing: border-box; padding: 0 10px;'), 'T124a chip 高度统一 24px（含描边）');
  ok(cc2.includes('display: inline-flex; align-items: center; gap: 6px;'), 'T124b 勾选框/色点/文字之间 4px 缝');
  ok(cc2.includes('line-height: 20px;'), 'T124c chip 内按钮行高受限，不撑出 pill');
}

// T125：标签墙根类必须独立命名（书签页 .chip 定义在本文件更后面，同名会被整块覆盖）
{
  const cc3 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const wall = cc3.slice(cc3.indexOf('/* ---------------- 标签墙'), cc3.indexOf('.chipwall-empty'));
  ok(/^\.tagchip {/m.test(wall), 'T125a 标签墙根类为 .tagchip');
  ok(!/^\.chip[ .,{]/m.test(wall), 'T125b 标签墙内不出现裸 .chip 选择器（防被书签页同名规则覆盖）');
  const tj = readFileSync(new URL('../space/tags.js', import.meta.url), 'utf8');
  ok(tj.includes("chip.className = 'tagchip'"), 'T125c DOM 根类与 CSS 一致');
}

// T126：目录标签（@chip）与标签墙同一规格，按钮去边框，名字点开抽屉
{
  const cc4 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(cc4.includes('.dir-chip {') && cc4.includes('height: 26px; box-sizing: border-box;\n  padding: 0 10px;'),
     'T126a dir-chip 与 tagchip 同高同内边距');
  ok(cc4.includes('.dir-chip .btn {\n  border: 0; background: transparent; box-shadow: none;'),
     'T126b dir-chip 内按钮无边框（纯文字）');
  const tj2 = readFileSync(new URL('../space/tags.js', import.meta.url), 'utf8');
  ok(tj2.includes("openDrawer(t.tag, true)") && tj2.includes("(isDir ? '@' : '#') + quoteTag(tag)"),
     'T126c 点目录名打开 @ 抽屉');
}


// 配置缺版本号：空文件不算，有配置组却没 v 才算
const emptyCfg = [
  { id: '0', children: [{ id: '1', title: '书签栏', children: [] }] },
];
const emptyFiles = {
  colors: { id: '9', title: 'TagSpace 配置·颜色' },
  prefs: { id: '8', title: 'TagSpace 配置·偏好' },
  aliases: { id: '7', title: 'TagSpace 配置·别名' },
};
const scanEmpty = diagScan(buildIndex(emptyCfg), {
  config: { colors: {}, aliases: {} },
  configFiles: emptyFiles,
  duplicates: [],
  configErrors: [],
});
ok(!scanEmpty.some((i) => i.kind === 'cfg-version'), 'T45a 空配置文件不报缺版本号');

const handFiles = { ...emptyFiles, colors: { id: '9', title: 'TagSpace 配置·颜色 [**c:X=1]' } };
const scanHand = diagScan(buildIndex(emptyCfg), {
  config: { colors: { X: '1' }, aliases: {} },
  configFiles: handFiles,
  duplicates: [],
  configErrors: [],
});
ok(scanHand.some((i) => i.kind === 'cfg-version'), 'T45b 有配置组但缺 v 才算真异常');

// ------------------------------------------------------------ 12. 目录标签

const dirTree = [
  {
    id: '0',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          {
            id: '10',
            title: '前端',
            children: [
              { id: '11', title: 'Vue 文档 [#Vue]', url: 'https://vuejs.org/' },
              { id: '12', title: '通用页', url: 'https://generic.example/' },
              { id: '13', title: 'Vue', children: [{ id: '14', title: '深层页 [#深]', url: 'https://deep.example/' }] },
            ],
          },
          { id: '20', title: '设计', children: [{ id: '21', title: '设计系统', url: 'https://generic.example/' }] },
          { id: '30', title: '根下直接放', url: 'https://root.example/' },
        ],
      },
      { id: '2', title: '其他书签', children: [] },
    ],
  },
];
const di = buildIndex(dirTree);

eq(di.counts.dirTags, 3, 'T46 根文件夹不算目录标签，只有 前端/设计/Vue');
ok(!di.dirTagToKeys.has('书签栏'), 'T47 书签栏本身不出现');
ok(di.keyToDirTags.get('deep.example') !== undefined, 'T48 深层书签有目录标签（URL 规范化后的键）');
eq(di.keyToDirTags.get('root.example'), undefined, 'T49 根下直接放的书签没有目录标签');
const seqs = [...di.nodeById.values()].map((r) => r.seq);
eq(new Set(seqs).size, seqs.length, 'T49a 每个书签节点有唯一树序 seq');

// 硬排除：按名字解析成路径，整枝不进索引（侧边栏目录云也必须消失）
const exTree = [{ id: '0', title: '', children: [{ id: '1', title: '书签栏', children: [
  { id: '10', title: '工具', children: [{ id: '11', title: '古董', children: [{ id: '12', title: '旧站', url: 'https://old.example/' }] }] },
  { id: '20', title: '保留', children: [{ id: '21', title: '新站', url: 'https://keep.example/' }] },
] }] }];
const exPaths = pruneNestedPaths(resolveDirEntries(['古董'], collectFolderPaths(exTree)));
eq(exPaths.join(','), ['书签栏', '工具', '古董'].join(PATH_SEP), 'T49b 排除条目按名字解析成精确路径（内部用 PATH_SEP）');
const exIdx = buildIndex(exTree, { skipDirs: exPaths });
ok(!exIdx.dirTagToKeys.has(tagKey('古董')), 'T49c 排除后目录标签不再出现');
ok(!exIdx.allKeys.has('old.example'), 'T49d 排除后整枝书签不进索引');
ok(exIdx.allKeys.has('keep.example'), 'T49e 其他目录不受影响');

const { parse: dp, evaluate: de, insertTag: dit, escapeTag: det, hasTag } = await import('../lib/query.js');
eq([...de(dp('@前端').ast, di, {})].sort().join(','), ['deep.example', 'generic.example', 'vuejs.org'].join(','), 'T50 @前端 含子级全部');
eq([...de(dp('@前端 & #Vue').ast, di, {})].join(','), 'vuejs.org', 'T51 目录标签与普通标签可混算（# 精确到标签）');
eq([...de(dp('@前端 & Vue').ast, di, {})].sort().join(','), ['vuejs.org', 'deep.example'].sort().join(','), 'T51a 裸名混算时同名目录也参与');
eq([...de(dp('@Vue').ast, di, {})].join(','), 'deep.example', 'T52 深层文件夹名也是目录标签');
eq([...de(dp('@设计 | Vue').ast, di, {})].sort().join(','), ['deep.example', 'generic.example', 'vuejs.org'].join(','), 'T53 OR 混用（裸名 Vue 含同名目录）');
eq([...de(dp('Vue').ast, di, {})].sort().join(','), ['deep.example', 'vuejs.org'].join(','), 'T53a 裸名 = 标签 ∪ 同名目录');
const relVue = relatedTags(di, de(dp('Vue').ast, di, {}));
ok(relVue.some((t) => tagKey(t.tag) === tagKey('Vue')), 'T53a1 命中标签本身也留在相关标签里（不再被排除）');
eq([...de(dp('#Vue').ast, di, {})].join(','), 'vuejs.org', 'T53b # 前缀只要标签，不掺目录');
eq([...de(dp('@Vue').ast, di, {})].join(','), 'deep.example', 'T53c @ 前缀只要目录');
eq([...de(dp('Vue').ast, di, { dirEnabled: false })].join(','), 'vuejs.org', 'T53d 目录开关关掉时裸名退回纯标签');
eq(de(dp('@前端').ast, di, { dirEnabled: false }).size, 0, 'T54 关掉后 @ 求值为空');
eq(det('a@b'), 'a\\@b', 'T55 标签名含 @ 要转义');
eq(det('a#b'), 'a\\#b', 'T55a 标签名含 # 也要转义');
eq(dp('#前端 & @Vue').ast.type, 'and', 'T55b # 与 @ 可与运算符组合');
eq(dp('#前端 & @Vue').ast.left.type, 'tagOnly', 'T55c # 前缀解析为 tagOnly 节点');
eq(dit('', '前端', 'and', '@'), '@前端', 'T56 插入带 @ 前缀');
eq(dit('', '前端', 'and', '#'), '#前端', 'T56a 标签 chip 插入带 # 前缀');
eq(dit('#前端', '前端', 'and', '#'), '', 'T56b #前缀再点一次即摘掉');
ok(hasTag('前端', '前端', '#') === false, 'T56c 裸名不会被当成 #标签 toggle');
eq(dit('mac', 'mac', 'and', '#'), '#mac', 'T56d 裸名已存在时升级为 #，不叠加');
eq(dit('@mac, foo', 'mac', 'and', '#'), '@mac, foo, #mac', 'T56e @与#语义不同允许共存');
eq(dit('mac', 'mac', 'and', '@'), '@mac', 'T56f 裸名已存在时升级为 @，不叠加');
eq(dit('@前端, Vue', '前端', 'and', '@'), 'Vue', 'T57 再点一次摘掉的是 @前端');

// 目录标签设色不算孤儿颜色
const dscan = diagScan(di, {
  config: { colors: { 前端: '3' }, aliases: {} },
  configFiles: { colors: { id: '9', title: 'x [**v:1]' }, prefs: { id: '8', title: 'x [**v:1]' }, aliases: { id: '7', title: 'x [**v:1]' } },
  duplicates: [],
  configErrors: [],
});
ok(!dscan.some((i) => i.kind === 'color-orphan'), 'T58 给目录标签设色不算孤儿');

// ---------------------------------------------------------------- 输入切分（弹窗/书签页共用）
eq(splitTagInput('前端 学习 "Chrome 扩展" 设计'), ['前端', '学习', 'Chrome 扩展', '设计'], 'T59 空格分隔 + 引号包住含空格标签');
eq(splitTagInput('前端,后端；设计、工具'), ['前端', '后端', '设计', '工具'], 'T60 逗号/分号/顿号都算分隔');
eq(splitTagInput('   '), [], 'T61 全空白不产出标签');
eq(splitTagInput('“标签 一” 二'), ['标签 一', '二'], 'T62 中文引号同样生效');
eq(splitTagInput('a\nb\tc'), ['a', 'b', 'c'], 'T63 换行/制表符也算分隔');

// ---------------------------------------------------------------- 静态守卫：脚本引用的 DOM id 必须在页面里
const bmSrc = readFileSync('space/bookmarks.js', 'utf8');
const spHtml = readFileSync('space/space.html', 'utf8');
const bmIds = [...new Set([...bmSrc.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))];
// bmRail 是双窗模式下动态创建的中缝操作条，不在静态 HTML 里
const bmMissing = bmIds.filter((id) => id !== 'bmRail' && !spHtml.includes(`id="${id}"`));
ok(bmMissing.length === 0, `T64 书签视图引用的 id 都存在（缺 ${bmMissing.join(',')}）`);

const popSrc = readFileSync('popup/popup.js', 'utf8');
const popHtml = readFileSync('popup/popup.html', 'utf8');
const popIds = [...new Set([...popSrc.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))];
const popMissing = popIds.filter((id) => !popHtml.includes(`id="${id}"`));
ok(popMissing.length === 0, `T65 弹窗引用的 id 都存在（缺 ${popMissing.join(',')}）`);
ok(!popHtml.includes('btnAdd') && !popSrc.includes('btnAdd'), 'T65b 弹窗标签输入行不再有「加」按钮（Enter 提交）');
ok(popSrc.includes('目录加载失败，点此重试'), 'T65c 收藏位置下拉加载失败有重试占位');

// T127：索引重建完成后必须广播 app:changed（否则侧边栏目录标签计数停在旧快照）
{
  const bg = readFileSync('background.js', 'utf8');
  ok(bg.includes("chrome.runtime.sendMessage({ type: 'app:changed', reason: 'index' })"),
     'T127a rebuild 后广播 app:changed');
  ok(bg.includes('if (countsBefore !== JSON.stringify(index.counts))'),
     'T127b 只在计数真的变化时广播（防事件风暴，广播位于 rebuild 内覆盖全部写路径）');
  ok(!bg.includes("const before = index ? JSON.stringify(index.counts) : '';\n      await rebuild();"),
     'T127c scheduleRebuild 不再重复广播');
}

// T128：带空格的目录/标签（如 web skill）整词查询，清除输入必须重置云
{
  const qq = readFileSync(new URL('../lib/query.js', import.meta.url), 'utf8');
  ok(qq.includes("export function quoteTag(name)"), 'T128a quoteTag 存在');
  ok(qq.includes(String.raw`if (ch === '"')`), 'T128b 词法器支持引号包裹的词（@/# 后亦生效）');
  ok(qq.includes('const t = prefix + quoteTag(tag);'), 'T128c insertTag 走 quoteTag');
  const pp = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
  ok(pp.includes("app.filterText = '';\n    run();"), 'T128d 清除输入时同步重置云区过滤词');
  ok(pp.includes("prefix + quoteTag(tag)"), 'T128e 建议插入带空格标签也包引号');
}

// T129：删除/移动后列表不跳动、不失焦
{
  const bm = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm.includes('const prevScroll = rows.scrollTop;') && bm.includes('rows.scrollTop = Math.min(prevScroll'),
     'T129a 平铺/按目录重画前后保存并恢复滚动位置');
  ok(bm.includes('prevFocusId') && bm.includes('line.tabIndex = -1;'),
     'T129b 焦点行记忆 + 行可编程聚焦');
  ok(bm.includes('st.offset = Math.max(0, st.offset - (r.trashed || 0)'),
     'T129c 删除后 offset 回正（不落空页）');
  ok(bm.includes('st.offset = Math.max(0, st.offset - r.moved)'),
     'T129d 剪切粘贴移走后 offset 回正');
}

// T130：按目录模式重画后按锚点行恢复视觉位置（scrollTop 会因行数变化漂移）
{
  const bm2 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bm2.includes('function capturePaneAnchors()'), 'T130a 视口首行锚点抓取');
  ok(bm2.includes('function restoreAllPaneAnchors()') && bm2.includes('restoreAllPaneAnchors(); // 面板已挂载'),
     'T130b 挂载完成后按真容器恢复（单窗=#bmRows，双窗=各栏 rowsEl）；buildPane 内不做恢复');
  ok(bm2.includes('div.dataset.id = node.id;'), 'T130c 文件夹行有 data-id 可锚定');
  ok(bm2.includes("capturePaneAnchors(); // 只在改动前的稳定 DOM 抓一次"), 'T130d refresh 清缓存前抓锚点（render 不重抓，防中间态漂移）');
  ok(bm2.includes('if (dirLoading.size) return; // 锚点行还没渲染出来'), 'T130f 锚点行未现且懒加载中：等待下一轮');
  ok(bm2.includes('if (!dirLoading.size) pane.anchor = null;'), 'T130g 锚点活到全部懒加载结束才消费（防上方目录膨胀推走视口）');
  ok(bm2.includes('paneState[k].anchor = null;'), 'T130e 查询条件变化时锚点作废');
}

// T131：标签云区域标识 + 双击空白清空查询
{
  const bm2 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(css.includes(".bm-cloud-row::before") && css.includes("'# 标签'"), 'T131a 普通标签区有 # 标签徽标（::before 不受 renderCloud 清 DOM 影响）');
  ok(css.includes(".bm-cloud-row.bm-cloud-dirs::before") && css.includes("'@ 目录'"), 'T131b 目录标签区有 @ 目录徽标');
  ok(bm2.includes("$('#bmCloud').addEventListener('dblclick'"), 'T131c 双击 chips 区空白清空查询');
  ok(bm2.includes("if (e.target.closest('.bm-cloud-chip')) return;"), 'T131d 点 chip 的双击不触发清空（chip 双击=两次 toggle）');
  ok(bm2.includes("input.dispatchEvent(new Event('input', { bubbles: true }));"), 'T131e 复用 × 按钮同一条 input 链路（文字/has 态/云高亮/列表一起复位）');
}

// T132：标签管理页去分隔线 + 云字号 +2 + 最近操作分隔线
{
  const css = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(css.includes('#view-tags .alias-sec { border-top: 1px solid var(--line); }') && css.includes('#view-tags .health-head { border-bottom: 0;'), 'T132a 标签管理页：区块顶线保留、标题下线移除（概览页不受影响）');
  ok((css.match(/font-size: 14px; line-height: 1;/g) || []).length >= 2, 'T132b tagchip/dir-chip 字号 12→14');
  ok(/\.bm-cloud-chip \{[\s\S]*?font-size: 14px;/.test(css), 'T132c 书签页云 chip 字号 12→14');
  ok(css.includes('#undoBox { border-top: 1px solid var(--line); padding-top: 12px; }'), 'T132d 最近操作（可撤销）上方分隔线');
  const pc = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');
  ok(pc.includes('font-size: 13px;'), 'T132e 侧边栏云 chip 字号 13px');
  ok(css.includes('#dirExcluded .hint { flex-basis: 100%; }'), 'T132f 已排除目录提示占满整行，chips 另起一行');
}

// T133：抽屉点击外部关闭 + 抽屉内书签右键菜单
{
  const tg = readFileSync(new URL('../space/tags.js', import.meta.url), 'utf8');
  ok(tg.includes("document.addEventListener('mousedown'") && tg.includes('!drawer.contains(e.target)'), 'T133a mousedown 抽屉外自动关闭（不会刚开就被 chip 的 click 误关）');
  ok(tg.includes("li.addEventListener('contextmenu'"), 'T133b 抽屉书签可右键');
  ok(tg.includes('function openDrawerCtx') && tg.includes("el.className = 'bm-ctx'"), 'T133c 右键菜单复用书签页 .bm-ctx 样式');
  ok(tg.includes("type: 'node:rename', id: item.nodeIds[0]") && tg.includes("type: 'delete', ids: [item.nodeIds[0]]"), 'T133d 重命名/删除走 node:rename 与 delete（nodeIds[0]，多位置书签取最前位置）');
  ok(tg.includes('if (drawerTag) openDrawer(drawerTag, drawerIsDir);'), 'T133e 操作后重开抽屉刷新内容');
}

// T142：退出下钻后面包屑必须真的消失（列表回到所有目录，表头不许残留旧分段）
{
  const bm11 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(!bm11.includes("$('#bmCrumb').hidden = dual;"), 'T142a 不再有"按 dual 强制 set hidden"把面包屑亮回来');
  ok(bm11.includes("if (dual) $('#bmCrumb').hidden = true;"), 'T142b 单窗可见性交给 renderCrumb() 判断');
  ok(/function renderCrumb\(\)[\s\S]{0,400}el\.hidden = true;\s*el\.textContent = '';/.test(bm11), 'T142c 隐藏时顺带清空旧分段');
  ok(/function renderCrumbInto\(el, pane\)[\s\S]{0,300}el\.hidden = true;\s*el\.textContent = '';/.test(bm11), 'T142d 双窗每栏同样隐藏即清空');
}

// T141：目录标签 = 写 @目录 词（云收窄）+ 定位（非面包屑展开、面包屑下钻）
{
  const bm10 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css10 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm10.includes('function dirIdForName(') && bm10.includes('dirNameIndex.get(key)'), 'T141a 文件夹名 → 目录 id（查表）');
  ok(bm10.indexOf("isDir && st.sort === 'tree'") > 0
     && bm10.indexOf('dirChipClick(name)', bm10.indexOf("isDir && st.sort === 'tree'")) >= 0, 'T141b 按目录模式下目录标签走 dirChipClick');
  ok(bm10.includes('if (adding) parts.push(`@${name}`);'), 'T141c 点击即把 @目录 词写进查询框（云随之收窄）');
  ok(bm10.includes('if (pane.folderId) {') && bm10.includes('pane.folderId = id;'), 'T141d 面包屑模式：同时下钻到该目录');
  ok(bm10.includes("row.scrollIntoView({ block: 'center' })") && bm10.includes("row.classList.add('flash')"), 'T141e 非面包屑模式：滚到该目录那一行并闪一下');
  ok(bm10.includes('const adding = at < 0;') && bm10.includes('else parts.splice(at, 1);'), 'T141f 再点一次 = 去掉这条 @词（切换语义）');
  ok(bm10.includes('if (!targetPath) resetQueryBox();'), 'T141g 退出面包屑清空查询框');
  ok(bm10.includes('function resetQueryBox('), 'T141h 只清查询框，不动书名搜索与批量标签输入');
  ok(css10.includes('.bm-folder-row.flash'), 'T141i 定位到的那一行有高亮提示');
  ok(bm10.includes("if (active.has(name.toLowerCase())) b.classList.add('on');")
     && bm10.indexOf("if (active.has(name.toLowerCase())) b.classList.add('on');", bm10.indexOf("isDir && st.sort === 'tree'")) > 0, 'T141j @词 在查询里时目录 chip 高亮');
}

// T144：云收窄仍走查询（不残留上一版"作用域云"那套），面包屑挂模式徽标
{
  const bm13 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const bg13 = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const css13 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  const html13 = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  ok(!bm13.includes('cloud:scope') && !bg13.includes('cloud:scope'), 'T144a 不残留作用域云通道（收窄只由查询驱动）');
  ok(!html13.includes('bmCloudScope') && !css13.includes('.bm-cloud-scope'), 'T144b 不残留云顶作用域条');
  ok(!bm13.includes('scopeInfo'), 'T144c 不残留作用域状态变量');
  ok(bm13.includes("textContent = '只看此目录'") && css13.includes('.bm-crumb-scope'), 'T144d 面包屑挂「只看此目录」，下钻可见');
  ok(!bm13.includes('gotoDirChip') && !bm13.includes('focusDirInTree'), 'T144e 只保留一条目录标签路径，不并存两套导航实现');
}

// T140：功能带按模式分工——按目录专属控件在平铺里隐藏而不是置灰
{
  const bm9 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp9 = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  ok(bm9.includes("for (const id of ['#bmCollapse', '#bmDual', '#bmNewFolder', '#bmCopy', '#bmCut', '#bmPaste', '#bmClipSep'])"), 'T140a 六个按目录专属控件 + 分隔线整块隐藏');
  ok(bm9.includes('if (el) el.hidden = !tree;'), 'T140b 平铺隐藏、按目录显示');
  ok(sp9.includes('id="bmClipSep"'), 'T140c 剪贴板分隔线有 id 才能跟着一起隐');
  ok(bm9.includes("pageBtn.textContent = tree ? '全选可见' : '全选本页'"), 'T140d 全选按钮按模式换语义与文案');
}

// T139：平铺模式的排序（目录 / 标题）
{
  const bm8 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const sp8 = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const bg8 = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(bm8.includes("order: 'dir', // 平铺模式的排序"), 'T139a 平铺默认按目录排序');
  ok(bm8.includes("sort: st.sort === 'tree' ? 'tree' : st.order,"), 'T139b 平铺把 order 当排序参数传下去');
  ok(/msg\.sort === 'tree' \|\| msg\.sort === 'dir'/.test(bg8), 'T139c 后台 dir 走树序');
  ok(sp8.includes('id="bmOrder"'), 'T139d 顶部有「目录/标题」排序开关');
  ok(bm8.includes("if (orderEl) orderEl.hidden = tree;"), 'T139e 按目录模式下隐藏排序开关');
}

// T138：下钻只属于"按目录"视图，平铺是全部书签的清单
{
  const bm7 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(/bookmarks:page[\s\S]{0,400}folderId: '',/.test(bm7), 'T138a 主查询不按下钻收窄（平铺=全库）');
  ok(bm7.includes("folderId: st.sort === 'tree' ? st.folderId : ''"), 'T138b 平铺的「全选全部」也不被下钻目录偷偷限制');
  ok(/type: 'bookmarks:page',[\s\S]{0,300}folderId: st\.folderId/.test(bm7) === false, 'T138c 主查询不再把下钻目录当筛选条件');
}

// T137：删除按钮就地二次确认（不再弹 window.confirm）
{
  const bm6 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const css6 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(bm6.includes('function armDelete()'), 'T137a 删除上膛函数存在');
  ok(bm6.includes('function disarmDelete()'), 'T137b 复位函数存在');
  ok(bm6.includes('b.textContent = `确认 ${selected.size}？`'), 'T137c 上膛文字带数量');
  ok(bm6.includes('delArmTimer = setTimeout(disarmDelete, 3000)'), 'T137d 3 秒自动复位（与侧边栏一致）');
  ok(bm6.includes('再点一次确认：删除${parts.join'), 'T137e 上膛时给出提示（带类型拆分）');
  ok(/\$\('#bmDelete'\)\.addEventListener\('click'[\s\S]{0,200}armDelete\(\)\) return/.test(bm6), 'T137f 底部删除第一次点击只上膛');
  ok(!/\$\('#bmDelete'\)[\s\S]{0,400}window\.confirm/.test(bm6), 'T137g 底部删除不再用 window.confirm');
  ok(bm6.includes('disarmDelete(); // 选中项变了'), 'T137h 选中项变化就复位');
  ok(/st\.sort = btn\.dataset\.s;[\s\S]{0,200}clearSelectionOnFilterChange\(\)/.test(bm6), 'T137l 切视图（平铺↔按目录）清空选择，避免旧勾选跟着新视图走');
  ok(bm6.includes('function folderBranchIds('), 'T137m 勾文件夹时剔掉同枝重复项');
  ok(bm6.includes('const drop = folderBranchIds(id, sel);'), 'T137n 勾选文件夹立刻剪掉后代/祖先');
  ok(css6.includes('.btn.danger.armed'), 'T137i 上膛态有视觉标记');
  ok(bm6.includes("window.confirm('清空回收站"), 'T137j 回收站的不可逆操作仍保留系统确认');
  ok(bm6.includes('run: () => deleteNodes([row.id])'), 'T137k 右键删除保持直接删除');
}

// T136：排除只作用于标签/查询层，书签页按目录照常显示
{
  const bg5 = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const bm5 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(bg5.includes('let rawTree = null;'), 'T136a rebuuild 时缓存原始树');
  ok(bg5.includes('rawTree = tree;'), 'T136b 重建时刷新原始树快照');
  ok(bg5.includes('function treeScopeRows('), 'T136c 按目录从真实树组行');
  ok(/bookmarks:page[\s\S]{0,900}if \(folderId\) \{[\s\S]{0,600}treeScopeRows/.test(bg5), 'T136d bookmarks:page 带到目录就走真实树');
  const idsIdx = bg5.indexOf("type === 'bookmarks:ids'");
  ok(idsIdx > 0 && bg5.indexOf('treeScopeRows(folderId, { subtree', idsIdx) > 0, 'T136e bookmarks:ids 同样按真实树');
  ok(bg5.includes('folderExcluded,'), 'T136f 回包带 folderExcluded');
  ok(bm5.includes('folderExcluded: !!r.folderExcluded'), 'T136g 前端记住目录被排除');
  ok(bm5.includes('此目录已在标签管理页被排除：这里照常显示，但它不进标签云、也搜不到'), 'T136h 明确提示，不再让人以为目录坏了');
  ok(bm5.includes("b.textContent = '恢复收录'"), 'T136i 一键恢复收录');
}

// T135：「当前生效」条件条——空页不再是哑的，失效目录词可一键移除
{
  const bm4 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  const html4 = readFileSync(new URL('../space/space.html', import.meta.url), 'utf8');
  const css4 = readFileSync(new URL('../space/space.css', import.meta.url), 'utf8');
  ok(html4.includes('id="bmFilterNote"'), 'T135a 工具条下有「当前生效」条容器');
  ok(css4.includes('.bm-filter-note{'), 'T135b 条件条有样式');
  ok(bm4.includes('async function syncFilterNote()'), 'T135c 条件条渲染函数存在');
  ok(bm4.includes("dirTerms = qTerms.filter((p) => /^!?@/.test(p))"), 'T135d 从查询里挑出目录词');
  ok(bm4.includes('!names.has(n)'), 'T135e 目录词与现有目录名比对，判失效');
  ok(bm4.includes('已不存在（目录被改名或移动了）'), 'T135f 失效词有明确说明');
  ok(bm4.includes("b.textContent = '移除失效词'"), 'T135g 一键移除失效词');
  ok(bm4.includes("input.dispatchEvent(new Event('input', { bubbles: true }))"), 'T135h 清除走与 × 同一条 input 链路');
  ok(bm4.includes('直属书签都被当前查询/搜索/筛选筛掉了'), 'T135i 空目录提示说清是被筛选掉的');
  ok(bm4.includes('fullDirs = []; // 目录名可能变了'), 'T135j 条件变化后清全量目录缓存');
}

// T134：文件夹名里含 "/" 不再被误拆成两级
{
  ok(folderPathOf('书签栏', 'program/ff') === ['书签栏', 'program/ff'].join(PATH_SEP),
     'T134a folderPathOf 单段折叠：名字里的 / 不当分隔符');
  const slashTree = [{ id: '0', title: '', children: [{ id: '1', title: '书签栏', children: [
    { id: '40', title: 'program/ff', children: [{ id: '41', title: 'ff 页', url: 'https://ff.test/' }] },
  ] }] }];
  const slashIdx = buildIndex(slashTree);
  ok(slashIdx.dirTagToKeys.has(tagKey('program/ff')), 'T134b 目录标签按整个名字投影（一个 chip，不是两级）');
  eq(slashIdx.counts.dirTags, 1, 'T134c 目录计数为 1（没被拆成 program 和 ff 两级）');
  const bm3 = readFileSync(new URL('../space/bookmarks.js', import.meta.url), 'utf8');
  ok(!bm3.includes("path.split('/')") && bm3.includes('path.split(PATH_SEP)'), 'T134d 树渲染/面包屑/目录格全部按 PATH_SEP 拆分');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  ok(bg.includes('PATH_SEP') && bg.includes('folders:list') === true, 'T134e folders:list 树路径同用 PATH_SEP');
  // 名字本身含 / 的目录：按名字排除能解析到（整条路径以它为结尾）
  eq(resolveDirEntries(['program/ff'], collectFolderPaths(slashTree)).join('|'),
     ['书签栏', 'program/ff'].join(PATH_SEP), 'T134f 含 / 的目录名按名字也能排除');
  // 落盘不存控制字符：配置串写回 '/' 显示形
  ok(bg.includes(".split(PATH_SEP).join('/')"), 'T134g 排除名单落盘转回 / 显示形（防 Chrome 规整控制字符）');
}

// 选择控件两页统一：表头复选框 + 「全选全部」+「取消选择」，不再有工具栏文字按钮
ok(spHtml.includes('id="tagAllPage"'), 'T66 标签页的全选在常驻操作带里');
ok(spHtml.includes('id="bmAllPage"'), 'T67 书签页的全选在常驻操作带里');
ok(!spHtml.includes('btnSelectAll'), 'T68 旧的「全选显示的」工具栏按钮已移除');
ok(spHtml.includes('全选全部'), 'T69 两个页面都提供「全选全部」入口');

// 样式统一守卫：危险色只有一个来源；操作带里不留会伸缩的计数文本
const cssSrc = readFileSync('space/space.css', 'utf8');
ok(!spHtml.includes('id="bulkCount"') && !spHtml.includes('id="bmBulkCount"'), 'T70 操作带里不再放会伸缩的计数文本');
ok(!cssSrc.includes('#c0392b'), 'T71 危险色只用 var(--danger)，不再有第二个红');
ok(spHtml.includes('全选本页</button>\n      <button class="btn ghost" data-bulk="clear"') && !cssSrc.includes('.bulk-clear'),
   'T72 「取消选择」紧挨着全选，不再单独推到右边');
ok(cssSrc.includes('.bm-row.on'), 'T73 书签行选中也有整行高亮');

// 标签页主列表已改成「标签墙」：表格整体退场
ok(spHtml.includes('id="tagWall"') && spHtml.includes('class="tagwall-panel"') && !spHtml.includes('id="tagRows"'),
   'T74 标签页主列表是标签墙（旧表格已移除）');
ok(!cssSrc.includes('.tagtable'), 'T75 旧的表格样式已清干净');

// chip 内部件与兜底样式
ok(readFileSync('space/tags.js', 'utf8').includes("ck.className = 'bm-cb chip-ck'"), 'T76 chip 内复选框与表头同款');
ok(readFileSync('space/bookmarks.js', 'utf8').includes("cb.className = 'bm-cb'"), 'T77 书签行内复选框与表头同款');
ok(cssSrc.includes('.tagchip .chip-acts button.danger-text'), 'T78 chip 内危险操作有独立配色');
ok(cssSrc.includes('.tagchip input[type="checkbox"]'), 'T79 标签 chip 复选框有兜底样式');
ok(cssSrc.includes('.tagchip .chip-name') && cssSrc.includes('max-width: 220px'), 'T80 长标签名省略号截断，不撑破 chip');

// ---------------------------------------------------------------- 汇总







console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：\n`);
  for (const f of failures) console.log(' ✗ ' + f + '\n');
  process.exit(1);
}
console.log('全部通过 ✓');
