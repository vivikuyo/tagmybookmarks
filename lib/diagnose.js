// 一致性诊断：只读扫描 + 生成"能安全自动修"的改写清单。
// 原则：看不懂的一律只报告，不猜；能修的都是幂等的标题重写。

import { parseTitle, buildTitle, normalizeTagOrNull, tagKey, sortTags, dedupeTags } from './title.js';
import { resolveColorValue } from './palette.js';
import { CATEGORIES } from './config.js';

const RAW_TAG = /\[#([^\[\]]*)\]/g;

const KINDS = {
  'tag-unclosed': { label: '标签括号不闭合', severity: 'warn', fixable: false, hint: '标题里有 [# 但没闭合，解析器读不到这些标签。多半是手改标题时漏了 ]。' },
  'tag-illegal': { label: '标签名含非法字符', severity: 'warn', fixable: false, hint: '标签名里有 [ ] ; = , 之一，无法写回标题。' },
  'tag-duplicate': { label: '同一标签重复出现', severity: 'info', fixable: true, hint: '同一个标签在一条标题里出现了两次（大小写可能不同）。' },
  'tag-order': { label: '标签顺序不合规', severity: 'info', fixable: true, hint: '标签没按码点序排列。功能上没影响，但会让不同设备的序列化结果不一致。' },
  'tag-stray': { label: '标签混在标题正文里', severity: 'warn', fixable: false, hint: '标签组必须紧贴标题末尾才能被识别。中间出现的 [#xx] 不会被索引。' },
  'conf-not-last': { label: '配置组不在末尾', severity: 'warn', fixable: false, hint: '配置组 [**...] 必须在标题最末尾，否则读不到。' },
  multi: { label: '同一 URL 的多处标签不一致', severity: 'warn', fixable: true, hint: '同一个网址存在两个书签位置，标签却不同。按并集统一。' },
  'cfg-missing': { label: '配置文件缺失', severity: 'warn', fixable: false, hint: '三类配置里有的文件不存在。下次启动会自动重建，也可以在配置页手动重建。' },
  'cfg-duplicate': { label: '配置文件重复', severity: 'warn', fixable: false, hint: '同一类别存在多个文件，通常是两台设备各建了一套。去配置页合并。' },
  'cfg-version': { label: '配置文件缺版本号', severity: 'info', fixable: true, hint: '配置标题里没有 v:1，未来格式升级无法识别。' },
  'cfg-parse-error': { label: '配置里有无法解析的指令', severity: 'warn', fixable: false, hint: '配置文本里有片段读不懂，保存时不会覆盖它们，但也不会生效。' },
  'color-invalid': { label: '颜色值非法', severity: 'info', fixable: true, hint: '颜色既不是 0–11 的调色板序号，也不是 #RRGGBB。' },
  'color-orphan': { label: '颜色指向不存在的标签', severity: 'info', fixable: true, hint: '颜色表里有标签已经没有任何书签在用了。' },
  'alias-missing': { label: '别名指向不存在的标签', severity: 'info', fixable: false, hint: '别名映射到的规范标签当前没有任何书签在用。' },
  'alias-cycle': { label: '别名成环', severity: 'warn', fixable: false, hint: 'A 指向 B、B 又指回 A，解析时会绕死。' },
};

export function issueMeta(kind) {
  return KINDS[kind] || { label: kind, severity: 'info', fixable: false, hint: '' };
}

/** 单条标题的原始结构检查（不看索引，只看字符串） */
function scanRawTitle(raw) {
  const parsed = parseTitle(raw);
  const hits = [...String(raw == null ? '' : raw).matchAll(RAW_TAG)].map((m) => m[1]);
  const opens = (String(raw == null ? '' : raw).match(/\[#/g) || []).length;
  const kinds = [];

  if (opens > hits.length) kinds.push('tag-unclosed');
  const illegal = hits.filter((h) => !normalizeTagOrNull(h));
  if (illegal.length) kinds.push('tag-illegal');

  const valid = hits.map((h) => normalizeTagOrNull(h)).filter(Boolean);
  const uniq = dedupeTags(valid);
  if (valid.length && uniq.length !== valid.length) kinds.push('tag-duplicate');

  if (uniq.length > 1) {
    const got = uniq.map(tagKey).join('\u0001');
    const want = sortTags(uniq).map(tagKey).join('\u0001');
    if (got !== want) kinds.push('tag-order');
  }

  // 正文里残留标签/配置字样 → 说明它们没被读到
  if (/\[#|\[\*\*/.test(parsed.text)) kinds.push('tag-stray');
  if ((String(raw == null ? '' : raw).match(/\[\*\*/g) || []).length && !parsed.conf) kinds.push('conf-not-last');

  return { parsed, kinds, valid, uniq };
}

/**
 * 全量扫描。
 * @returns {Array<{kind,label,severity,fixable,hint,count,samples}>}
 */
export function scan(index, ctx = {}) {
  const buckets = new Map();
  const add = (kind, sample) => {
    if (!buckets.has(kind)) buckets.set(kind, { kind, count: 0, samples: [] });
    const b = buckets.get(kind);
    b.count++;
    if (b.samples.length < 5 && sample) b.samples.push(sample);
  };

  // 1. 逐条标题
  for (const [id, rec] of index.nodeById) {
    const { kinds } = scanRawTitle(rec.title);
    for (const k of kinds) {
      add(k, { nodeId: id, title: rec.title, note: '' });
    }
  }

  // 2. 同一 URL 多位置标签不一致
  for (const [key, recs] of index.keyToNodes) {
    if (!recs || recs.length < 2) continue;
    const sigs = recs.map((r) => r.tags.map(tagKey).sort().join('|'));
    if (new Set(sigs).size > 1) {
      add('multi', { nodeId: recs[0].id, title: recs.map((r) => r.tags.map((t) => '#' + t).join(' ') || '(无标签)').join('  /  '), note: key });
    }
  }

  // 3. 配置
  const cfg = ctx.config || { colors: {}, aliases: {} };
  const files = ctx.configFiles || {};
  for (const cat of Object.values(CATEGORIES)) {
    const node = files[cat.key];
    if (!node) {
      add('cfg-missing', { nodeId: '', title: cat.file, note: cat.label });
      continue;
    }
    // 空配置文件的标题本来就不带 [**v:1]（serializeConfig 只含版本号时返回空串），
    // 直接判"缺版本"会永远报个不停。只有"有配置组但组里没 v"才是真异常（手改/旧数据）。
    const raw = String(node.title || '');
    if (/\[\*\*/.test(raw) && !/v\s*:\s*\d/.test(raw)) {
      add('cfg-version', { nodeId: node.id, title: node.title, note: cat.label });
    }
  }
  for (const d of ctx.duplicates || []) {
    add('cfg-duplicate', { nodeId: '', title: `${d.label} ×${d.count}`, note: d.category });
  }
  for (const e of ctx.configErrors || []) {
    add('cfg-parse-error', {
      nodeId: '',
      title: `${CATEGORIES[e.category] ? CATEGORIES[e.category].file : e.category}：${(e.errors || []).length} 处`,
      note: '',
    });
  }

  // 4. 颜色
  const tagKeys = index.tagToKeys;
  for (const [tag, val] of Object.entries(cfg.colors || {})) {
    if (!resolveColorValue(val)) add('color-invalid', { nodeId: '', title: `${tag} = ${val}`, note: tag });
    else if (!tagKeys.has(tagKey(tag)) && !(index.dirTagToKeys && index.dirTagToKeys.has(tagKey(tag))))
      add('color-orphan', { nodeId: '', title: `${tag} = ${val}`, note: tag });
  }

  // 5. 别名
  const aliases = cfg.aliases || {};
  const map = new Map();
  for (const [a, t] of Object.entries(aliases)) map.set(tagKey(a), tagKey(t));
  for (const [a, t] of Object.entries(aliases)) {
    if (!tagKeys.has(tagKey(t))) add('alias-missing', { nodeId: '', title: `${a} → ${t}`, note: a });
    // 成环检测：走两步能回到自己
    let cur = tagKey(t);
    let hop = 0;
    while (map.has(cur) && hop < 8) {
      cur = map.get(cur);
      hop++;
      if (cur === tagKey(a)) {
        add('alias-cycle', { nodeId: '', title: `${a} → ${t}`, note: a });
        break;
      }
    }
  }

  const out = [];
  for (const b of buckets.values()) {
    const meta = issueMeta(b.kind);
    out.push({ ...meta, ...b });
  }
  return out.sort((a, b) => {
    const rank = { warn: 0, info: 1 };
    return (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) || b.count - a.count;
  });
}

/**
 * 生成自动修复：只处理 fixable 的 kind，其余只报告。
 * @returns {{writes:Array, colors:object|null, aliases:object|null, fixVersion:boolean}}
 */
export function planFix(index, kinds, ctx = {}) {
  const want = new Set(kinds || []);
  const writes = [];
  const seen = new Set();

  const pushWrite = (nodeId, nextTitle) => {
    if (seen.has(nodeId)) return;
    const rec = index.nodeById.get(nodeId);
    if (!rec || rec.title === nextTitle) return;
    seen.add(nodeId);
    writes.push({ id: nodeId, before: rec.title, after: nextTitle });
  };

  // 顺序 / 重复：按"解析后再规范化"重写，等于把标题改成解析器认可的形状
  if (want.has('tag-order') || want.has('tag-duplicate')) {
    for (const [id, rec] of index.nodeById) {
      const { parsed, kinds: local } = scanRawTitle(rec.title);
      // 只处理本次点名的毛病：没点名的不碰
      if (!local.some((k) => want.has(k))) continue;
      pushWrite(id, buildTitle(parsed.text, parsed.tags, parsed.conf));
    }
  }

  // 多位置不一致：按并集统一到每个位置
  if (want.has('multi')) {
    for (const [key, recs] of index.keyToNodes) {
      if (!recs || recs.length < 2) continue;
      const sigs = recs.map((r) => r.tags.map(tagKey).sort().join('|'));
      if (new Set(sigs).size === 1) continue;
      const union = index.keyToTags.get(key) || [];
      for (const r of recs) pushWrite(r.id, buildTitle(r.text, union, r.conf));
    }
  }

  let colors = null;
  if (want.has('color-invalid') || want.has('color-orphan')) {
    colors = {};
    for (const [tag, val] of Object.entries((ctx.config || {}).colors || {})) {
      if (want.has('color-invalid') && !resolveColorValue(val)) continue;
      if (want.has('color-orphan') && !index.tagToKeys.has(tagKey(tag)) && !index.dirTagToKeys.has(tagKey(tag))) continue;
      colors[tag] = val;
    }
  }

  let aliases = null;
  if (want.has('alias-missing') || want.has('alias-cycle')) {
    aliases = {};
    const src = (ctx.config || {}).aliases || {};
    const map = new Map(Object.entries(src).map(([a, t]) => [tagKey(a), tagKey(t)]));
    for (const [a, t] of Object.entries(src)) {
      const missing = !index.tagToKeys.has(tagKey(t));
      let cur = tagKey(t);
      let hop = 0;
      let cyclic = false;
      while (map.has(cur) && hop < 8) {
        cur = map.get(cur);
        hop++;
        if (cur === tagKey(a)) {
          cyclic = true;
          break;
        }
      }
      if (want.has('alias-missing') && missing) continue;
      if (want.has('alias-cycle') && cyclic) continue;
      aliases[a] = t;
    }
  }

  return { writes, colors, aliases, fixVersion: want.has('cfg-version') };
}
