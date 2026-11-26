// 批量标签操作的"计划层"：只算该写什么，不碰 chrome。
// 一切批量都收敛成一张 { id, before, after } 清单，执行器只负责按清单写。

import { buildTitle, normalizeTags, tagKey } from './title.js';

function keySet(tags) {
  return new Set((tags || []).map(tagKey));
}

function sameTagList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 把 fromTags 里的标签替换成 toTag（toTag 为空 = 删除这些标签）。
 * 同一 URL 的多个位置共用一套标签，所以按 urlKey 算一次、写到每个位置。
 */
export function planReplaceTags(index, fromTags, toTag) {
  const from = keySet(fromTags);
  const target = toTag ? normalizeTags([toTag])[0] : '';
  const writes = [];
  let keys = 0;
  let unchangedKeys = 0;
  let mergedIntoExisting = 0;

  for (const [key, tags] of index.keyToTags) {
    if (!tags.length || !tags.some((t) => from.has(tagKey(t)))) continue;
    keys++;

    const rest = tags.filter((t) => !from.has(tagKey(t)));
    // 目标已经在该书签上 → 不是"改名"而是"并进去"，去重后条数会减少
    if (target && rest.some((t) => tagKey(t) === tagKey(target))) mergedIntoExisting++;
    const next = normalizeTags(target ? [...rest, target] : rest);

    // 标签身份大小写不敏感（tagKey 折叠），但展示写法要能单独改：
    // 这里按字面比较，ad → AD 也算需要改写，否则用户改大小写会被判成"无变化"
    if (sameTagList(tags, next)) {
      unchangedKeys++;
      continue;
    }

    for (const rec of index.keyToNodes.get(key) || []) {
      const after = buildTitle(rec.text, next, rec.conf);
      if (after === rec.title) continue;
      writes.push({ id: rec.id, key, before: rec.title, after });
    }
  }

  return { writes, keys, unchangedKeys, mergedIntoExisting, from: [...fromTags], to: target };
}

/** 计划摘要：给"预演"对话框用 */
export function summarizePlan(plan, msPerWrite = 8) {
  const nodes = plan.writes.length;
  return {
    nodes,
    keys: plan.keys,
    unchangedKeys: plan.unchangedKeys,
    mergedIntoExisting: plan.mergedIntoExisting,
    ms: nodes * msPerWrite,
    samples: plan.writes.slice(0, 5).map((w) => ({ before: w.before, after: w.after })),
  };
}

/** 校验标签名能不能当目标：非空、不含配置分隔符 */
export function validateTagTarget(name) {
  const t = String(name == null ? '' : name).trim();
  if (!t) return { ok: false, reason: '不能为空' };
  if (/[\[\];=,]/.test(t)) return { ok: false, reason: '不能含 [ ] ; = , 这几个字符' };
  return { ok: true, tag: t };
}
