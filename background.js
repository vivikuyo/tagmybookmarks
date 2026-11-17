// TagMyBookmarks 后台：标题是唯一真实来源，内存索引是派生品。
// 所有写操作都走 writeTitle（幂等 + 回声抑制），事件只用来触发重建。

import {
  parseTitle,
  buildTitle,
  normalizeTagOrNull,
  normalizeTags,
  tagKey,
  serializeConfig,
  parseConfig,
  setCI,
  cpCompare,
} from './lib/title.js';
import {
  buildIndex,
  canonicalUrl,
  globalTagCounts, sortDirTagsByTree,
  dirRelatedKeys,
  collectFolderPaths,
  resolveDirEntries,
  pruneNestedPaths,
  PATH_SEP,
} from './lib/index.js';
import { parse as parseQuery, evaluate, relatedTags, collectQueryTags, collectQueryDirs } from './lib/query.js';
import {
  OTHER_BOOKMARKS_ID,
  CONFIG_DIR_NAME,
  CATEGORIES,
  DEFAULT_PREFS,
  categoryOf,
  configFileTitle,
  sanitizeConfFor,
  pickCanonical,
  canonicalOrder,
  mergeConfs,
  joinList,
  splitList,
} from './lib/config.js';
import { planReplaceTags, summarizePlan, validateTagTarget } from './lib/ops.js';
import { scan as diagScan, planFix } from './lib/diagnose.js';

const SNAP_KEY = 'tagspace.config.snapshot';
const PANEL_PAGE = 'sidepanel/panel.html';
const SPACE_PAGE = 'space/space.html';

let index = null;
let resolvedExcluded = [];
let configFolderId = null;
let configNodes = {}; // category → 规范文件 {id, title, url}
let configNodeSets = {}; // category → 该类别全部文件 id（重复时 >1）
let configDuplicates = []; // 重复配置文件报告
let batch = null; // 正在跑的批量：{label,total,done,failed,abort,startedAt}
const stats = { rebuilds: 0, lastBuildMs: 0, writes: 0, queries: 0 };
const config = { colors: {}, aliases: {}, prefs: { ...DEFAULT_PREFS } };
let aliasMap = new Map();
let configErrors = [];

const UNDO_KEY = 'tagspace.undo';
const JOURNAL_KEY = 'tagspace.journal';
const TRASH_ORIGIN_KEY = 'tagspace.trashOrigins'; // id → {parentId, at}，本机即可（书签 id 本就不跨设备）
const TRASH_NAME = '回收站';
const BOOKMARKS_BAR_ID = '1';
const CHUNK = 20;

const pendingTitles = new Map();
let rebuildTimer = null;
let rebuildPending = false;

let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

// ---------------------------------------------------------------- 启动

let booting = null;

function boot() {
  if (booting) return booting;
  booting = doBoot().finally(() => {
    booting = null;
  });
  return booting;
}

async function doBoot() {
  try {
    await ensureConfigFiles();
    await rebuild();
  } catch (e) {
    console.error('[TagMyBookmarks] 启动失败', e);
  } finally {
    readyResolve();
    setPanelBehavior();
  }
}

async function setPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
}

boot();

chrome.runtime.onInstalled.addListener(() => {
  boot();
});
chrome.runtime.onStartup.addListener(() => {
  boot();
});

// ------------------------------------------------------------ 配置文件

function spaceUrl(hash) {
  return chrome.runtime.getURL(`${SPACE_PAGE}#${hash}`);
}

let inboxId = null;

/** 未收藏页面打标签时的落点文件夹 */
async function ensureInbox() {
  if (inboxId) return inboxId;
  const kids = await chrome.bookmarks.getChildren(OTHER_BOOKMARKS_ID);
  let folder = kids.find((n) => !n.url && n.title === 'TagSpace 收件箱');
  if (!folder) {
    folder = await chrome.bookmarks.create({ parentId: OTHER_BOOKMARKS_ID, title: 'TagSpace 收件箱' });
  }
  inboxId = folder.id;
  return inboxId;
}

async function ensureConfigFiles() {
  const rootChildren = await chrome.bookmarks.getChildren(OTHER_BOOKMARKS_ID);
  let folder = rootChildren.find((n) => !n.url && n.title === CONFIG_DIR_NAME);
  if (!folder) {
    folder = await chrome.bookmarks.create({ parentId: OTHER_BOOKMARKS_ID, title: CONFIG_DIR_NAME });
  }
  configFolderId = folder.id;

  const snapshot = await readSnapshot();
  await scanConfigNodes();

  for (const cat of Object.values(CATEGORIES)) {
    const node = configNodes[cat.key];
    if (node) {
      // 扩展 id 变了会导致 URL 失效，顺手改回来
      const want = spaceUrl(cat.hash);
      if (node.url !== want) {
        try {
          await chrome.bookmarks.update(node.id, { url: want });
        } catch {}
      }
      continue;
    }
    // 缺文件：用 last-known 快照重建，而不是直接清空
    const body = snapshot ? serializeConfig(sanitizeConfFor(cat.key, snapshot[cat.key] || {})) : '';
    await chrome.bookmarks.create({
      parentId: folder.id,
      title: configFileTitle(cat.key, body),
      url: spaceUrl(cat.hash),
    });
  }

  await scanConfigNodes();
  await loadConfig();
}

/**
 * 扫一遍配置文件夹：登记每个类别的全部文件，挑出规范文件，记录重复。
 * 重复的来源是多设备在首次同步前各建了一套，合并前两边会各写各的。
 */
async function scanConfigNodes() {
  configDuplicates = [];
  configNodeSets = {};
  configNodes = {};
  if (!configFolderId) return;

  const kids = await chrome.bookmarks.getChildren(configFolderId);
  for (const cat of Object.values(CATEGORIES)) {
    const all = kids.filter((n) => n.url && categoryOf(n) === cat.key);
    configNodeSets[cat.key] = all.map((n) => n.id);
    if (all.length > 1) {
      configDuplicates.push({
        category: cat.key,
        label: cat.label,
        count: all.length,
        ids: all.map((n) => n.id),
        titles: all.map((n) => n.title),
      });
    }
    const canonical = pickCanonical(all);
    if (canonical) configNodes[cat.key] = canonical;
  }
}

/** 合并重复的配置文件：内容取并集，冲突以规范文件为准，其余删掉（删前备份标题） */
async function dedupeConfigFiles() {
  await scanConfigNodes();
  const report = { merged: [], removed: [], conflicts: [], filled: 0, failed: 0 };

  for (const cat of Object.values(CATEGORIES)) {
    const ids = configNodeSets[cat.key] || [];
    if (ids.length < 2) continue;

    const nodes = [];
    for (const id of ids) {
      const arr = await chrome.bookmarks.get(id).catch(() => []);
      if (arr && arr[0]) nodes.push(arr[0]);
    }
    if (nodes.length < 2) continue;

    const sorted = canonicalOrder(nodes);
    const canonical = sorted[0];
    const confs = sorted.map((n) => parseTitle(n.title).conf || parseConfig(''));
    const m = mergeConfs(cat.key, confs);

    configNodes[cat.key] = canonical;
    await writeConfig(cat.key, m.conf);

    const extras = sorted.slice(1);
    try {
      const o = await chrome.storage.local.get('cfg.dedupe.bak');
      const bak = Array.isArray(o['cfg.dedupe.bak']) ? o['cfg.dedupe.bak'] : [];
      bak.push({
        at: Date.now(),
        category: cat.key,
        kept: { id: canonical.id, title: canonical.title },
        removed: extras.map((n) => ({ id: n.id, title: n.title, url: n.url })),
      });
      await chrome.storage.local.set({ 'cfg.dedupe.bak': bak.slice(-20) });
    } catch {}

    for (const n of extras) {
      try {
        await chrome.bookmarks.remove(n.id);
        report.removed.push({ category: cat.key, id: n.id, title: n.title });
      } catch {
        report.failed++;
      }
    }

    report.filled += m.filled;
    report.conflicts.push(...m.conflicts.map((c) => ({ ...c, category: cat.key })));
    report.merged.push({
      category: cat.key,
      label: cat.label,
      kept: canonical.id,
      merged: extras.length,
      filled: m.filled,
    });
  }

  await scanConfigNodes();
  await loadConfig();
  await rebuild();
  return report;
}

async function loadConfig() {
  configErrors = [];
  config.colors = {};
  config.aliases = {};
  config.prefs = { ...DEFAULT_PREFS };

  for (const key of Object.keys(configNodes)) {
    const node = configNodes[key];
    const parsed = parseTitle(node.title);
    const conf = parsed.conf || parseConfig('');
    if (conf.errors.length) configErrors.push({ category: key, errors: conf.errors });

    if (key === 'colors') config.colors = { ...conf.colors };
    else if (key === 'aliases') config.aliases = { ...conf.aliases };
    else if (key === 'prefs') config.prefs = { ...DEFAULT_PREFS, ...conf.extras };
  }

  aliasMap = new Map(
    Object.entries(config.aliases).map(([a, canonical]) => [tagKey(a), tagKey(canonical)])
  );

  await writeSnapshot();
}

async function readSnapshot() {
  try {
    const o = await chrome.storage.local.get(SNAP_KEY);
    const snap = o[SNAP_KEY];
    if (!snap) return null;
    return {
      colors: { colors: snap.colors || {}, aliases: {}, extras: {} },
      aliases: { colors: {}, aliases: snap.aliases || {}, extras: {} },
      prefs: { colors: {}, aliases: {}, extras: snap.prefs || {} },
    };
  } catch {
    return null;
  }
}

async function writeSnapshot() {
  const hasAny =
    Object.keys(config.colors).length || Object.keys(config.aliases).length;
  if (!hasAny) return;
  try {
    await chrome.storage.local.set({
      [SNAP_KEY]: { colors: config.colors, aliases: config.aliases, prefs: config.prefs },
    });
  } catch {}
}

// ---------------------------------------------------------------- 批量执行器

async function saveJournal(j) {
  try {
    await chrome.storage.local.set({ [JOURNAL_KEY]: { ...j, at: Date.now() } });
  } catch {}
}

async function readJournal() {
  try {
    const o = await chrome.storage.local.get(JOURNAL_KEY);
    const j = o[JOURNAL_KEY];
    if (!j) return null;
    if (j.done >= j.total) return null;
    return j;
  } catch {
    return null;
  }
}

async function clearJournal() {
  try {
    await chrome.storage.local.set({ [JOURNAL_KEY]: null });
  } catch {}
}

async function pushUndo(label, entries, op) {
  try {
    const o = await chrome.storage.local.get(UNDO_KEY);
    const stack = Array.isArray(o[UNDO_KEY]) ? o[UNDO_KEY] : [];
    // op：'title' 标题改写（默认，兼容老记录）｜'move' 位置变化（移动 / 删除→回收站 / 还原）
    stack.push({ at: Date.now(), label, count: entries.length, op: op || 'title', entries: entries.slice(0, 2000) });
    await chrome.storage.local.set({ [UNDO_KEY]: stack.slice(-20) });
  } catch {}
}

async function listUndo() {
  try {
    const o = await chrome.storage.local.get(UNDO_KEY);
    const stack = Array.isArray(o[UNDO_KEY]) ? o[UNDO_KEY] : [];
    return stack.map((e, i) => ({ index: i, at: e.at, label: e.label, count: e.count, op: e.op || 'title' }));
  } catch {
    return [];
  }
}

/**
 * 执行一张标题改写清单：分批、可取消、写前留旧值、结束后只重建一次。
 * 已写过的条目再跑一次不会重复写（writeTitle 幂等），所以中断后重跑是安全的。
 */
async function runTitleBatch(label, plan, dryRun, spec) {
  const est = summarizePlan(plan);
  if (!plan.writes.length) {
    return { ...est, dryRun: !!dryRun, written: 0, done: 0, total: 0, failed: 0, aborted: false, ms: 0 };
  }
  if (dryRun) return { ...est, dryRun: true, written: 0, done: 0, total: plan.writes.length, failed: 0, aborted: false };

  batch = { label, total: plan.writes.length, done: 0, failed: 0, abort: false, startedAt: Date.now() };
  const undo = [];

  for (let i = 0; i < plan.writes.length; i += CHUNK) {
    if (batch.abort) break;
    for (const w of plan.writes.slice(i, i + CHUNK)) {
      try {
        if (await writeTitle(w.id, w.after)) undo.push({ id: w.id, before: w.before, after: w.after });
      } catch {
        batch.failed++;
      }
      batch.done++;
    }
    await saveJournal({ label, spec, done: batch.done, total: batch.total });
    await new Promise((r) => setTimeout(r, 0));
  }

  const result = {
    ...est,
    written: undo.length,
    done: batch.done,
    total: batch.total,
    failed: batch.failed,
    aborted: batch.abort,
    ms: Date.now() - batch.startedAt,
  };
  batch = null;

  await clearJournal();
  if (undo.length) await pushUndo(label, undo);
  await rebuild();
  return result;
}

/** 撤销一条记录：只回滚"当前标题仍等于我当时写的那版"的条目，被别人改过的跳过 */
async function applyUndo(index) {
  const o = await chrome.storage.local.get(UNDO_KEY);
  const stack = Array.isArray(o[UNDO_KEY]) ? o[UNDO_KEY] : [];
  const entry = stack[Number(index)];
  if (!entry) throw new Error('没有这条撤销记录');

  const isMove = entry.op === 'move';
  const stat = { restored: 0, skipped: 0, missing: 0 };
  const restoredIds = [];
  for (const e of entry.entries) {
    if (isMove) {
      // 移动类撤销：把书签放回原目录原位置；原目录没了就落到书签栏兜底
      const node = await getNode(e.id);
      if (!node) {
        stat.missing++;
        continue;
      }
      try {
        const dest = e.parentId && (await getNode(e.parentId)) ? e.parentId : BOOKMARKS_BAR_ID;
        await chrome.bookmarks.move(e.id, { parentId: dest, index: e.index });
        stat.restored++;
        restoredIds.push(e.id);
      } catch {
        stat.skipped++;
      }
      continue;
    }
    const node = await getNode(e.id);
    if (!node) {
      stat.missing++;
      continue;
    }
    if (node.title !== e.after) {
      stat.skipped++;
      continue;
    }
    if (await writeTitle(e.id, e.before)) stat.restored++;
  }
  // 从回收站撤销删除的同时，清掉对应的位置记忆
  if (restoredIds.length) await dropTrashOrigins(restoredIds);

  stack.splice(Number(index), 1);
  await chrome.storage.local.set({ [UNDO_KEY]: stack });
  await rebuild();
  return { ...stat, label: entry.label };
}

// ---------------------------------------------------------------- 推荐标签
// 纯本地启发式，五路信号加权；每条都带理由，便于解释与排查。
// 目录标签（@文件夹）不参与推荐：它是投影，写进标题会和文件夹名打架。
function hostOf(url) {
  try {
    return new URL(url).host || '';
  } catch {
    return '';
  }
}

function suggestTagsFor({ url, title, text, limit }) {
  if (!index) return [];
  const key = canonicalUrl(url || '');
  const own = new Set((index.keyToTags.get(key) || []).map(tagKey));
  const titleLow = String(title || '').toLowerCase();
  const host = hostOf(url || '');

  const scores = new Map(); // tagKey → {tag, score, why:Set}
  const bump = (tag, tagKey_, add, reason) => {
    if (!tag) return;
    const norm = normalizeTagOrNull(tag);
    if (!norm) return;
    const k = tagKey(norm);
    if (own.has(k)) return; // 已经有了不推荐
    const rec = scores.get(k) || { tag: norm, score: 0, why: new Set() };
    rec.score += add;
    if (reason) rec.why.add(reason);
    scores.set(k, rec);
  };

  // 1) 标题/地址里直接出现某个已有标签名（≥2 字，忽略大小写）
  const names = [];
  for (const [k, tag] of index.tagForm) names.push([k, tag]);
  const urlLow = String(url || '').toLowerCase();
  for (const [k, tag] of names) {
    const t = String(tag).toLowerCase();
    if (t.length < 2) continue;
    if (titleLow.includes(t) || urlLow.includes(t)) bump(tag, k, 3, '标题命中');
  }

  // 2) 同域共现：同一 host 下其他书签最爱用的标签
  if (host) {
    const counts = new Map();
    let max = 1;
    for (const [k, nodes] of index.keyToNodes) {
      const u = index.keyToUrl.get(k) || '';
      if (!u || hostOf(u) !== host) continue;
      for (const tag of index.keyToTags.get(k) || []) {
        const kk = tagKey(tag);
        counts.set(kk, (counts.get(kk) || 0) + 1);
        if (counts.get(kk) > max) max = counts.get(kk);
      }
    }
    for (const [kk, cnt] of counts) {
      const tag = index.tagForm.get(kk) || kk;
      bump(tag, kk, (2 * cnt) / max, cnt > 1 ? `同域 ${cnt} 次` : '同域');
    }
  }

  // 3) 同目录常用：这条书签所在文件夹里其他书签的标签
  const nodes = index.keyToNodes.get(key) || [];
  const folders = new Set(nodes.map((n) => n.parentId).filter(Boolean));
  if (folders.size) {
    const counts = new Map();
    let max = 1;
    for (const [k, ns] of index.keyToNodes) {
      if (!ns.some((n) => folders.has(n.parentId))) continue;
      if (k === key) continue;
      for (const tag of index.keyToTags.get(k) || []) {
        const kk = tagKey(tag);
        counts.set(kk, (counts.get(kk) || 0) + 1);
        if (counts.get(kk) > max) max = counts.get(kk);
      }
    }
    for (const [kk, cnt] of counts) {
      const tag = index.tagForm.get(kk) || kk;
      bump(tag, kk, (2 * cnt) / max, '同目录常用');
    }
  }

  // 4) 别名命中：标题里写了别名，推荐它的规范标签
  for (const [alias, canonical] of Object.entries(config.aliases || {})) {
    const a = String(alias || '');
    if (a.length < 2) continue;
    if (titleLow.includes(a.toLowerCase()) || urlLow.includes(a.toLowerCase())) {
      bump(canonical, tagKey(canonical), 2, '别名命中');
    }
  }

  // 5) 全局高频（权重最低，只用来补位）
  const total = new Set(index.allKeys).size || 1;
  for (const [kk, keys] of index.tagToKeys) {
    bump(index.tagForm.get(kk) || kk, kk, (1 * keys.size) / total, '全局常用');
  }

  // 输入中的半截文本也算命中（打字过程中即时提示）
  const typed = String(text || '').trim().toLowerCase();
  if (typed && typed.length >= 1) {
    for (const [k, tag] of names) {
      const t = String(tag).toLowerCase();
      if (t.startsWith(typed) || typed.startsWith(t)) bump(tag, k, 1.5, '输入匹配');
    }
  }

  const items = [...scores.values()]
    .sort((a, b) => b.score - a.score || cpCompare(a.tag, b.tag))
    .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20))
    .map((r) => ({
      tag: r.tag,
      score: Math.round(r.score * 100) / 100,
      reason: [...r.why].join(' · ') || '推荐',
    }));
  return items;
}

// ---------------------------------------------------------------- 索引

async function rebuild() {
  const t0 = Date.now();
  const countsBefore = index ? JSON.stringify(index.counts) : '';
  if (configFolderId) await scanConfigNodes();
  const tree = await chrome.bookmarks.getTree();
  const exclude = new Set();
  if (configFolderId) exclude.add(configFolderId);
  for (const n of Object.values(configNodes)) if (n && n.id) exclude.add(n.id);
  // 排除名单按"文件夹路径"解析；祖先已排除的后代条目自动清掉，名单里只留你点的那几个
  const exEntries = excludedDirList();
  const exPaths = pruneNestedPaths(resolveDirEntries(exEntries, collectFolderPaths(tree)));
  resolvedExcluded = exPaths;
  if (exPaths.join('\u0001') !== exEntries.join('\u0001')) {
    await writePrefs({ excludeDirs: joinList(exPaths) });
  }
  // 回收站自动排除（不占用户自己的排除名单）：删掉的书签不该再出现在查询/云/推荐里
  const trashPath = String(config.prefs.trashPath || '').trim();
  const skip = trashPath && !exPaths.includes(trashPath) ? [...exPaths, trashPath] : exPaths;
  index = buildIndex(tree, { excludeIds: exclude, skipDirs: skip });
  rebuildPending = false;
  stats.rebuilds++;
  stats.lastBuildMs = Date.now() - t0;
  // 计数真的变了才广播：侧边栏/管理页的云计数、目录标签计数才能实时跟上。
  // 覆盖所有写路径（delete/paste/move/标签增删/撤销）与书签事件两条链路。
  if (countsBefore !== JSON.stringify(index.counts)) {
    try { await chrome.runtime.sendMessage({ type: 'app:changed', reason: 'index' }); } catch {}
  }
  return index;
}

function scheduleRebuild(delay = 250) {
  rebuildPending = true;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    try {
      await rebuild();
    } catch (e) {
      console.error('[TagMyBookmarks] 重建索引失败', e);
    }
  }, delay);
}

chrome.bookmarks.onCreated.addListener(() => scheduleRebuild());
chrome.bookmarks.onRemoved.addListener(() => scheduleRebuild());
chrome.bookmarks.onMoved.addListener(() => scheduleRebuild());
chrome.bookmarks.onChildrenReordered.addListener(() => scheduleRebuild());
chrome.bookmarks.onImportEnded.addListener(() => scheduleRebuild(1000));

chrome.bookmarks.onChanged.addListener((id, info) => {
  // 自己写的标题不回灌，避免事件风暴
  if (pendingTitles.get(id) === info.title) return;
  // 配置文件被改 → 立刻重读配置
  if (Object.values(configNodes).some((n) => n && n.id === id)) {
    (async () => {
      const node = (await chrome.bookmarks.get(id))[0];
      if (node) {
        const key = Object.keys(configNodes).find((k) => configNodes[k].id === id);
        if (key) configNodes[key] = node;
        await loadConfig();
      }
      scheduleRebuild();
    })();
    return;
  }
  scheduleRebuild();
});

// ---------------------------------------------------------------- 写通道

async function getNode(id) {
  try {
    const arr = await chrome.bookmarks.get(id);
    return arr && arr[0];
  } catch {
    return null;
  }
}

async function writeTitle(id, title) {
  const node = await getNode(id);
  if (!node) return false;
  if (node.title === title) return false; // 幂等：目标一致就跳过
  pendingTitles.set(id, title);
  try {
    await chrome.bookmarks.update(id, { title });
    stats.writes++;
  } finally {
    setTimeout(() => {
      if (pendingTitles.get(id) === title) pendingTitles.delete(id);
    }, 300);
  }
  return true;
}

/**
 * 按 URL 写标签：per-URL 语义，同一 URL 的所有位置一起改。
 * @returns {Promise<number>} 实际改写条数
 */
async function writeTagsForKey(key, tags) {
  const recs = (index && index.keyToNodes.get(key)) || [];
  let written = 0;
  for (const rec of recs) {
    const node = await getNode(rec.id);
    if (!node || !node.url) continue;
    const parsed = parseTitle(node.title);
    const next = buildTitle(parsed.text, tags, parsed.conf);
    if (await writeTitle(rec.id, next)) written++;
  }
  return written;
}

async function collectTargets(ids) {
  const byKey = new Map();
  for (const id of ids) {
    const rec = index && index.nodeById.get(id);
    if (!rec) continue;
    const key = canonicalUrl(rec.url);
    if (!byKey.has(key)) byKey.set(key, index.keyToTags.get(key) || []);
  }
  return byKey;
}

async function addTags(ids, rawTags) {
  const tags = normalizeTags(rawTags.map(normalizeTagOrNull).filter(Boolean));
  if (!tags.length) return { written: 0, skipped: true };
  const targets = await collectTargets(ids);
  let written = 0;
  for (const [key, current] of targets) {
    written += await writeTagsForKey(key, normalizeTags([...current, ...tags]));
  }
  await rebuild();
  return { written, keys: targets.size, tags };
}

async function removeTags(ids, rawTags) {
  const remove = new Set(rawTags.map(tagKey));
  const targets = await collectTargets(ids);
  let written = 0;
  for (const [key, current] of targets) {
    written += await writeTagsForKey(key, current.filter((t) => !remove.has(tagKey(t))));
  }
  await rebuild();
  return { written, keys: targets.size };
}

async function clearTags(ids) {
  const targets = await collectTargets(ids);
  let written = 0;
  for (const [key] of targets) written += await writeTagsForKey(key, []);
  await rebuild();
  return { written, keys: targets.size };
}

async function writeConfig(categoryKey, conf) {
  const node = configNodes[categoryKey];
  if (!node) throw new Error(`配置文件不存在：${categoryKey}`);
  const body = serializeConfig(sanitizeConfFor(categoryKey, conf));
  const title = configFileTitle(categoryKey, body);
  const written = await writeTitle(node.id, title);
  const fresh = await getNode(node.id);
  if (fresh) configNodes[categoryKey] = fresh;
  await loadConfig();
  // 配置（颜色/偏好/别名）任一页改了，其他页必须立刻看到：侧边栏的目录屏蔽、
  // 色点都来自 state，不广播就会一直显示旧状态
  try {
    await chrome.runtime.sendMessage({ type: 'app:changed', reason: 'config' });
  } catch {}
  return { written, title, body };
}

async function setTagColor(tag, value) {
  const colorsConf = { v: 1, colors: { ...config.colors }, aliases: {}, flags: {}, extras: {} };
  setCI(colorsConf.colors, tag, value == null || value === '' ? null : String(value));
  return writeConfig('colors', colorsConf);
}

async function writePrefs(patch) {
  const extras = { ...config.prefs, ...(patch || {}) };
  return writeConfig('prefs', { v: 1, colors: {}, aliases: {}, flags: {}, extras });
}

/** 查询表达式 → 命中 key 集合；空表达式返回 null（不过滤）。语法错误直接抛出 */
async function queryKeySet(expr) {
  const text = String(expr || '').trim();
  if (!text) return null;
  const { ast, errors } = parseQuery(text);
  if (errors && errors.length) throw new Error(`查询语法：${errors[0]}`);
  if (!ast) return null;
  const dirEnabled = String(config.prefs.folderTags ?? '1') !== '0';
  return evaluate(ast, index, { resolveAlias: (k) => aliasMap.get(k) || k, dirEnabled });
}

// ---------------------------------------------------------------- 回收站

/** 树里所有文件夹（含路径），一次遍历
 *  路径口径与索引一致：顶层的书签栏 / 其他书签是根名，如 `其他书签/TagSpace/回收站` */
async function collectAllFolders() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  (function walk(nodes, path) {
    for (const node of nodes || []) {
      if (node.url || !node.children) continue;
      const fp = path ? `${path}${PATH_SEP}${node.title || ''}` : node.title || '';
      out.push({ id: node.id, title: node.title || '', path: fp, parentId: node.parentId || '' });
      walk(node.children, fp);
    }
  })(tree, '');
  return out;
}

/**
 * 解析当前生效的回收站：
 * 1) 偏好里记的路径（trashPath，随 Sync）→ 按路径找文件夹；
 * 2) 没记过 → 找现成的「回收站」目录（第三方浏览器自带的、用户自建的），直接套用并记下；
 * 3) 都没有 → null，由前端提示设置（默认 其他书签/TagSpace/回收站，或自选目录）。
 * 注意：路径记的是书签路径不是 id——书签 id 不跨设备同步，路径（标题链）才同步。
 */
/** 可能是浏览器/用户自建回收站的名字。只有「回收站」参与自动套用，其余只在设置界面列为候选 */
const TRASH_CANDIDATE_NAMES = ['回收站', '垃圾桶', 'Trash', '已删除的书签'];

/** 找出树里所有长得像回收站的目录（按路径去重排序，排除当前已启用的那个） */
async function detectTrashCandidates(activeTrashId) {
  const folders = await collectAllFolders();
  const seen = new Set();
  const out = [];
  for (const name of TRASH_CANDIDATE_NAMES) {
    for (const f of folders) {
      if (f.title !== name) continue;
      if (f.id === configFolderId || f.id === activeTrashId) continue;
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push({ id: f.id, title: f.title, path: f.path });
    }
  }
  return out;
}

/**
 * adopt=false：只解析不落盘（folders:list、trash:status 用，避免查询也改配置）。
 * adopt=true（默认）：探测命中时顺手写进偏好——"有现成的就直接套用"。
 */
async function resolveTrash(adopt = true) {
  const folders = await collectAllFolders();
  const wanted = String(config.prefs.trashPath || '').trim();
  if (wanted) {
    const hit = folders.find((f) => f.path === wanted && f.id !== configFolderId);
    return hit ? { id: hit.id, path: hit.path } : null; // 记过但找不到（被删/改名）→ 重新设置
  }
  const hits = folders.filter((f) => f.title === TRASH_NAME && f.id !== configFolderId);
  if (hits.length) {
    const pick = hits.find((f) => f.parentId === OTHER_BOOKMARKS_ID) || hits[0];
    if (adopt) await writePrefs({ trashPath: pick.path });
    return { id: pick.id, path: pick.path };
  }
  return null;
}

async function loadTrashOrigins() {
  try {
    const o = await chrome.storage.local.get(TRASH_ORIGIN_KEY);
    return o && o[TRASH_ORIGIN_KEY] && typeof o[TRASH_ORIGIN_KEY] === 'object' ? o[TRASH_ORIGIN_KEY] : {};
  } catch {
    return {};
  }
}

async function saveTrashOrigins(adds) {
  const map = await loadTrashOrigins();
  Object.assign(map, adds);
  const keys = Object.keys(map).sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
  for (const k of keys.slice(0, Math.max(0, keys.length - 5000))) delete map[k]; // 上限 5000 条，丢最旧
  await chrome.storage.local.set({ [TRASH_ORIGIN_KEY]: map });
}

async function dropTrashOrigins(ids) {
  const map = await loadTrashOrigins();
  let hit = false;
  for (const id of ids || []) {
    if (map[id]) {
      delete map[id];
      hit = true;
    }
  }
  if (hit) await chrome.storage.local.set({ [TRASH_ORIGIN_KEY]: map });
}

/** 节点是否在回收站子树里（直接子级或回收站里的文件夹之下） */
async function isUnderTrash(node, trashId) {
  let p = node.parentId;
  while (p) {
    if (p === trashId) return true;
    if (p === '0') return false;
    const pn = await getNode(p);
    if (!pn) return false;
    p = pn.parentId;
  }
  return false;
}

// ---------------------------------------------------------------- 查询

function buildItems(keys, byTitle = true) {
  const items = [];
  for (const key of keys) {
    const tags = index.keyToTags.get(key) || [];
    const nodes = index.keyToNodes.get(key) || [];
    items.push({
      key,
      title: index.keyToText.get(key) || '',
      url: index.keyToUrl.get(key) || '',
      tags,
      nodeIds: nodes.map((n) => n.id),
      path: nodes[0] ? nodes[0].path : '',
      locations: nodes.length,
      // 多位置书签取最靠前的位置，作为它在书签管理器里的位置
      seq: nodes.length ? Math.min(...nodes.map((n) => n.seq ?? Infinity)) : Infinity,
    });
  }
  // 空查询按书签树默认顺序显示；有查询条件时保持标题排序（结果可预期）
  items.sort((a, b) =>
    byTitle
      ? (a.title || a.url).localeCompare(b.title || b.url, 'zh')
      : a.seq - b.seq
  );
  return items;
}

/** 目录标签屏蔽名单：存偏好配置文件（随 Sync），存显示名、比对用 tagKey */
function blockedDirList() {
  return splitList(config.prefs.blockedDirs);
}

function excludedDirList() {
  return splitList(config.prefs.excludeDirs);
}

function blockedDirKeys() {
  return new Set(blockedDirList().map((x) => tagKey(x)));
}

/** 某个目录名下所有下级目录的显示名（含自己） */
function descendantDirNames(name) {
  const k = tagKey(name);
  const out = new Set([name]);
  const folders = index.folders || [];
  const roots = folders.filter((f) => tagKey(f.name) === k);
  for (const r of roots) {
    const prefix = String(r.path) + PATH_SEP;
    for (const f of folders) {
      if (f.name && String(f.path).startsWith(prefix)) out.add(f.name);
    }
  }
  return [...out];
}

/** 目录标签频次（给侧边栏"目录"一栏与标签页）；屏蔽的不出现 */
function dirTagCounts(idx) {
  if (!idx) return [];
  const blocked = blockedDirKeys();
  const out = [];
  for (const [k, keys] of idx.dirTagToKeys) {
    if (blocked.has(k)) continue;
    out.push({ key: k, tag: idx.dirTagForm.get(k) || k, count: keys.size });
  }
  // 目录结构序：按目录树 DFS 位次（父目录在前、子目录紧随其后），次数只做平手裁决
  return sortDirTagsByTree(idx, out);
}

async function doQuery(expr, opts = {}) {
  const { ast, errors } = parseQuery(expr);
  const taggedKeys = new Set(index.allKeys);
  for (const k of index.untaggedKeys) taggedKeys.delete(k);

  const dirEnabled = String(config.prefs.folderTags ?? '1') !== '0';
  const keys = ast
    ? evaluate(ast, index, { resolveAlias: (k) => aliasMap.get(k) || k, dirEnabled })
    : new Set(taggedKeys);
  const queryTags = collectQueryTags(ast);
  const queryDirs = [...collectQueryDirs(ast)];
  // 裸名（mac）会同时命中同名目录，所以目录栏的高亮与「同枝收窄」也要把它算进去。
  // 只收裸名（type 'tag'），#前缀是"只要标签"，不该带动目录栏。
  if (dirEnabled) {
    const bareTags = new Set();
    (function walk(n) {
      if (!n) return;
      if (n.type === 'tag') bareTags.add(tagKey(n.name));
      if (n.node) walk(n.node);
      if (n.left) walk(n.left);
      if (n.right) walk(n.right);
    })(ast);
    for (const k of bareTags) {
      const target = aliasMap.get(k) || k;
      if (index.dirTagToKeys.has(target) && !queryDirs.includes(target)) queryDirs.push(target);
    }
  }
  // 目录云只允许同一枝（父子链）同时生效：选中任一目录后，其余不相关目录在侧边栏隐藏
  const dirRelated = queryDirs.length ? [...dirRelatedKeys(index, queryDirs)] : null;

  // 不再把查询里已有的标签排除掉：它们本身就是"命中"，要出现在相关标签里（高亮）
  const related = relatedTags(index, keys);

  // 当前结果里还有书的目录（给侧边栏目录栏的「仅相关」用）
  const blockedDirs = blockedDirKeys();
  let relatedDirs = [];
  for (const [k, set] of index.dirTagToKeys) {
    if (blockedDirs.has(k)) continue;
    let n = 0;
    for (const key of set) if (keys.has(key)) n++;
    if (n) relatedDirs.push({ key: k, tag: index.dirTagForm.get(k) || k, count: n });
  }
  relatedDirs = sortDirTagsByTree(index, relatedDirs);
  const untaggedCount = [...keys].filter((k) => index.untaggedKeys.has(k)).length;

  const items = buildItems(keys, !!ast);
  const LIMIT = 1000;

  return {
    total: items.length,
    truncated: items.length > LIMIT,
    items: items.slice(0, LIMIT),
    related,
    untaggedCount,
    untaggedTotal: index.untaggedKeys.size,
    queryTags: [...queryTags],
    queryDirs,
    dirRelated,
    relatedDirs,
    errors,
    ast: !!ast,
    allTags: opts.allTags ? globalTagCounts(index) : null,
  };
}

// ---------------------------------------------------------------- 对外接口

async function handle(msg) {
  const type = msg.type;

  if (type === 'tags:merge' || type === 'tags:rename') {
    await ready;
    if (rebuildPending) await rebuild();
    const froms = msg.froms || (msg.from != null ? [msg.from] : []);
    if (!froms.length) throw new Error('没有要改的标签');
    const v = validateTagTarget(msg.to);
    if (!v.ok) throw new Error('目标标签名' + v.reason);
    const plan = planReplaceTags(index, froms, v.tag);
    const spec = { type: 'tags:merge', froms, to: v.tag };
    const label = `${froms.length > 1 ? '合并' : '重命名'} ${froms.join(' / ')} → ${v.tag}`;
    return { ok: true, froms, to: v.tag, ...(await runTitleBatch(label, plan, !!msg.dryRun, spec)) };
  }

  if (type === 'tags:purge') {
    await ready;
    if (rebuildPending) await rebuild();
    const tags = msg.tags || [];
    if (!tags.length) throw new Error('没有选中标签');
    const plan = planReplaceTags(index, tags, '');
    const label = `删除标签 ${tags.join(' / ')}`;
    return { ok: true, ...(await runTitleBatch(label, plan, !!msg.dryRun, { type: 'tags:purge', tags })) };
  }

  if (type === 'bulk:progress') {
    return {
      ok: true,
      batch: batch
        ? { label: batch.label, total: batch.total, done: batch.done, failed: batch.failed, abort: batch.abort }
        : null,
    };
  }

  if (type === 'bulk:cancel') {
    const was = !!batch;
    if (batch) batch.abort = true;
    return { ok: true, cancelling: was };
  }

  if (type === 'undo:list') {
    return { ok: true, items: await listUndo() };
  }

  if (type === 'undo:apply') {
    await ready;
    return { ok: true, ...(await applyUndo(msg.index)) };
  }

  if (type === 'journal:read') {
    return { ok: true, journal: await readJournal() };
  }

  if (type === 'diag:scan') {
    await ready;
    if (rebuildPending) await rebuild();
    const issues = diagScan(index, {
      config,
      configFiles: configNodes,
      duplicates: configDuplicates,
      configErrors,
    });
    return { ok: true, issues, counts: index.counts, untagged: index.untaggedKeys.size, stats: { ...stats } };
  }

  if (type === 'diag:fix') {
    await ready;
    if (rebuildPending) await rebuild();
    const kinds = msg.kinds || [];
    const plan = planFix(index, kinds, { config });

    if (msg.dryRun) {
      return {
        ok: true,
        dryRun: true,
        nodes: plan.writes.length,
        colors: !!plan.colors,
        aliases: !!plan.aliases,
        fixVersion: plan.fixVersion,
      };
    }

    let configWritten = 0;

    if (plan.fixVersion) {
      for (const cat of Object.values(CATEGORIES)) {
        const node = configNodes[cat.key];
        if (!node) continue;
        const raw = String(node.title || '');
        // 没有配置组 = 空配置文件，属于正常形态，不补也不需要补
        if (!/\[\*\*/.test(raw)) continue;
        if (/v\s*:\s*\d/.test(raw)) continue;
        // 用解析出来的配置补版本号，原有颜色/别名/偏好必须原样带回去
        const parsed = parseTitle(node.title);
        const conf = parsed.conf || parseConfig('');
        conf.v = 1;
        const res = await writeConfig(cat.key, conf);
        if (res.written) configWritten++;
      }
    }

    if (plan.colors) {
      await writeConfig('colors', { v: 1, colors: plan.colors });
      configWritten++;
    }

    if (plan.aliases) {
      await writeConfig('aliases', { v: 1, aliases: plan.aliases });
      configWritten++;
    }

    const batchResult = await runTitleBatch(
      `修复 ${kinds.join(' / ')}`,
      { writes: plan.writes, keys: 0, unchangedKeys: 0, mergedIntoExisting: 0 },
      false,
      { type: 'diag:fix', kinds }
    );

    const after = diagScan(index, {
      config,
      configFiles: configNodes,
      duplicates: configDuplicates,
      configErrors,
    });

    return { ok: true, ...batchResult, configWritten, remaining: after.length, issues: after };
  }

  if (type === 'state') {
    await ready;
    if (rebuildPending) await rebuild();
    return {
      ok: true,
      counts: index ? index.counts : null,
      configFolderId,
      configFiles: Object.fromEntries(
        Object.entries(configNodes).map(([k, n]) => [k, { id: n.id, title: n.title, url: n.url }])
      ),
      config: { colors: config.colors, aliases: config.aliases, prefs: config.prefs },
      configErrors,
      configDuplicates,
      untagged: index ? index.untaggedKeys.size : 0,
      stats: { ...stats },
      prefs: config.prefs,
      tags: globalTagCounts(index),
      dirTags: dirTagCounts(index),
      blockedDirs: blockedDirList(),
      excludedDirs: resolvedExcluded.length ? resolvedExcluded : excludedDirList(),
      dirStats: {
        folders: (index.counts && index.counts.folders) || 0,
        deepFolders: (index.counts && index.counts.deepFolders) || 0,
        tags: (index.counts && index.counts.dirTags) || 0,
      },
    };
  }

  if (type === 'query') {
    await ready;
    if (rebuildPending) await rebuild();
    stats.queries++;
    return { ok: true, ...(await doQuery(msg.expr || '', { allTags: !!msg.allTags })) };
  }

  if (type === 'tags:add') {
    await ready;
    return { ok: true, ...(await addTags(msg.ids || [], msg.tags || [])) };
  }

  if (type === 'tags:remove') {
    await ready;
    return { ok: true, ...(await removeTags(msg.ids || [], msg.tags || [])) };
  }

  if (type === 'tags:clear') {
    await ready;
    return { ok: true, ...(await clearTags(msg.ids || [])) };
  }

  if (type === 'dirs:block') {
    await ready;
    const name = String(msg.tag || '').trim();
    if (!name) return { error: '名字为空' };
    // ';' 是配置指令分隔符、',' 是名单分隔符，含这两者的文件夹名存不进去


    const list = blockedDirList();
    const k = tagKey(name);
    // 按文件夹屏蔽：连同它下面的所有下级目录一起屏蔽（目录标签按名字归并，故按名字级联）
    const names = msg.cascade && msg.blocked ? descendantDirNames(name) : [name];


    if (msg.blocked) {
      for (const n of names) {
        if (!list.some((x) => tagKey(x) === tagKey(n))) list.push(n);
      }
    } else {
      for (const n of names) {
        const at = list.findIndex((x) => tagKey(x) === tagKey(n));
        if (at >= 0) list.splice(at, 1);
      }
    }
    await writePrefs({ blockedDirs: joinList(list) });
    return { ok: true, blockedDirs: blockedDirList(), added: names, changed: true };
  }

  if (type === 'dirs:exclude') {
    await ready;
    const name = String(msg.tag || '').trim();
    if (!name) return { error: '名字为空' };

    // 按"文件夹路径"精确排除：只记你点的这一个目录，后代不用一条条列（整枝本就不入索引）
    const tree = await chrome.bookmarks.getTree();
    const paths = collectFolderPaths(tree);
    const targets = resolveDirEntries([name], paths);
    const list = excludedDirList().map((e) => String(e).replaceAll('/', PATH_SEP)); // 内部统一用 PATH_SEP 比对

    if (msg.excluded) {
      for (const t of targets) {
        if (!list.some((x) => x === t)) list.push(t);
      }
    } else {
      const remove = new Set([...targets]);
      for (let i = list.length - 1; i >= 0; i--) {
        if (remove.has(list[i]) || list[i] === name) list.splice(i, 1);
      }
    }
    // 落盘仍用 PATH_SEP（encodeListName 会把它编成 %1F，配置串里不出现控制字符）
    await writePrefs({ excludeDirs: joinList(list) });
    await rebuild();
    // writePrefs 的广播发生在 rebuild 之前，侧边栏那时拿到的还是旧索引；
    // 重建完成后再广播一次，否则界面永远停留在"上一次开关"的状态
    try {
      await chrome.runtime.sendMessage({ type: 'app:changed', reason: 'exclude' });
    } catch {}
    return {
      ok: true,
      excludedDirs: resolvedExcluded,
      added: targets,
      ambiguous: targets.length > 1,
      changed: true,
    };
  }

  if (type === 'color:set') {
    await ready;
    return { ok: true, ...(await setTagColor(msg.tag, msg.value)) };
  }

  if (type === 'alias:set') {
    await ready;
    const alias = String(msg.alias || '').trim();
    const target = msg.target == null ? '' : String(msg.target).trim();

    if (!alias) return { error: '别名为空' };
    const chkA = validateTagTarget(alias);
    if (!chkA.ok) return { error: `别名不合法：${chkA.reason}` };

    const aliases = { ...config.aliases };

    if (!target) {
      // 删除：没有这个别名就当无事发生
      const exists = Object.keys(aliases).some((k) => tagKey(k) === tagKey(alias));
      if (!exists) return { ok: true, written: 0, removed: 0 };
      setCI(aliases, alias, null);
      const res = await writeConfig('aliases', { v: 1, aliases });
      return { ok: true, written: res.written, removed: 1 };
    }

    const chkT = validateTagTarget(target);
    if (!chkT.ok) return { error: `规范标签不合法：${chkT.reason}` };
    if (tagKey(target) === tagKey(alias)) return { error: '别名和规范标签不能相同' };

    // 环检测：目标链走下去若能回到别名本身，拒绝
    const map = new Map(Object.entries(aliases).map(([a, t]) => [tagKey(a), tagKey(t)]));
    map.set(tagKey(alias), tagKey(target));
    let cur = tagKey(target);
    for (let hop = 0; map.has(cur) && hop < 8; hop++) {
      cur = map.get(cur);
      if (cur === tagKey(alias)) return { error: '会形成别名环' };
    }

    setCI(aliases, alias, target);
    const res = await writeConfig('aliases', { v: 1, aliases });
    return { ok: true, written: res.written };
  }

  if (type === 'prefs:set') {
    await ready;
    return { ok: true, ...(await writePrefs(msg.patch || {})) };
  }

  if (type === 'config:read') {
    await ready;
    const key = msg.category;
    const node = configNodes[key];
    const parsed = parseTitle(node ? node.title : '');
    return {
      ok: true,
      category: key,
      title: node ? node.title : '',
      raw: parsed.conf ? serializeConfig(parsed.conf) : '',
      errors: parsed.conf ? parsed.conf.errors : [],
      hint: CATEGORIES[key] ? CATEGORIES[key].hint : '',
      file: CATEGORIES[key] ? CATEGORIES[key].file : '',
    };
  }

  if (type === 'config:write') {
    await ready;
    const key = msg.category;
    if (!CATEGORIES[key]) throw new Error('未知配置类别');
    const conf = parseConfig(msg.raw || '');
    const r = await writeConfig(key, conf);
    return { ok: true, ...r, errors: conf.errors };
  }

  if (type === 'config:dedupe') {
    await ready;
    return { ok: true, ...(await dedupeConfigFiles()) };
  }

  if (type === 'config:restore') {
    await ready;
    // 重建全部缺失的配置文件（不覆盖已存在的）
    const snapshot = await readSnapshot();
    const kids = await chrome.bookmarks.getChildren(configFolderId);
    for (const cat of Object.values(CATEGORIES)) {
      const exists = kids.some((n) => n.url && categoryOf(n) === cat.key);
      if (exists) continue;
      const body = snapshot ? serializeConfig(sanitizeConfFor(cat.key, snapshot[cat.key] || {})) : '';
      configNodes[cat.key] = await chrome.bookmarks.create({
        parentId: configFolderId,
        title: configFileTitle(cat.key, body),
        url: spaceUrl(cat.hash),
      });
    }
    await loadConfig();
    return { ok: true, configFiles: Object.fromEntries(Object.entries(configNodes).map(([k, n]) => [k, n.title])) };
  }

  if (type === 'open') {
    await ready;
    const where = msg.where || 'tab';
    for (const id of msg.ids || []) {
      const rec = index.nodeById.get(id);
      const node = await getNode(id);
      const url = node && node.url ? node.url : rec && rec.url;
      if (!url) continue;
      await chrome.tabs.create({ url, active: where !== 'background' });
    }
    return { ok: true };
  }

  if (type === 'delete') {
    await ready;
    const trash = await resolveTrash();
    if (!trash) return { needTrash: true }; // 前端据此弹出回收站设置
    const undoEntries = [];
    const origins = {};
    let trashed = 0, purged = 0, failed = 0;
    for (const raw of msg.ids || []) {
      const id = String(raw);
      if (id === trash.id) {
        failed++;
        continue; // 回收站本身不能删
      }
      const node = await getNode(id);
      if (!node) {
        failed++;
        continue;
      }
      try {
        if (await isUnderTrash(node, trash.id)) {
          // 回收站里的再删一次 = 彻底删除（不可撤销，前端已二次确认）
          if (node.url) await chrome.bookmarks.remove(id);
          else await chrome.bookmarks.removeTree(id);
          purged++;
        } else {
          undoEntries.push({ id, parentId: node.parentId, index: node.index });
          await chrome.bookmarks.move(id, { parentId: trash.id });
          origins[id] = { parentId: node.parentId, at: Date.now() };
          trashed++;
        }
      } catch {
        failed++;
      }
    }
    if (Object.keys(origins).length) await saveTrashOrigins(origins);
    if (undoEntries.length) await pushUndo(`删除 ${undoEntries.length} 条 → 回收站`, undoEntries, 'move');
    await rebuild();
    return { ok: true, trashed, purged, failed, path: trash.path };
  }

  if (type === 'trash:status') {
    await ready;
    const resolved = await resolveTrash(false);
    const candidates = await detectTrashCandidates(resolved ? resolved.id : null);
    return {
      ok: true,
      configured: !!String(config.prefs.trashPath || '').trim(),
      configuredPath: String(config.prefs.trashPath || '').trim().split(PATH_SEP).join('/'),
      resolved: !!resolved, // 配置了但目录没了 → false，前端要明确提示重新设置
      path: resolved ? resolved.path : '',
      candidates,
    };
  }

  if (type === 'folder:create') {
    await ready;
    const parentId = String(msg.parentId || '');
    const title = String(msg.title || '').trim() || '新建文件夹';
    if (!parentId) return { error: '缺少目标目录' };
    let node;
    try {
      node = await chrome.bookmarks.create({ parentId, title });
    } catch (e) {
      return { error: `无法在该目录创建文件夹：${String((e && e.message) || e)}` };
    }
    await rebuild();
    return { ok: true, id: node.id, title: node.title };
  }

  // 剪贴板粘贴：复制=按标题原样重建（标签随标题保留）；剪切=移动（进撤销栈）
  if (type === 'bookmarks:paste') {
    await ready;
    const targetId = String(msg.targetId || '');
    if (!targetId) return { error: '缺少目标目录' };
    const clip = msg.clip || {};
    const mode = clip.mode === 'cut' ? 'cut' : 'copy';
    let copied = 0;
    let moved = 0;
    const undoEntries = [];

    const copyTree = async (node, parentId) => {
      const created = await chrome.bookmarks.create({ parentId, title: node.title });
      copied++;
      for (const c of node.children || []) {
        if (c.url) await chrome.bookmarks.create({ parentId: created.id, title: c.title, url: c.url });
        else await copyTree(c, created.id);
      }
    };

    // 复制书签（标题带标签后缀，粘出来标签就在）
    for (const id of clip.bookmarks || []) {
      try {
        const [n] = await chrome.bookmarks.get(String(id));
        if (!n || !n.url) continue;
        await chrome.bookmarks.create({ parentId: targetId, title: n.title, url: n.url });
        copied++;
      } catch {}
    }
    // 复制文件夹：整棵子树
    for (const id of clip.folders || []) {
      try {
        const [n] = await chrome.bookmarks.get(String(id));
        if (!n || n.url) continue;
        await copyTree(n, targetId);
      } catch {}
    }

    // 剪切：原对象移动到目标（会推动失效缓存），进撤销栈
    if (mode === 'cut') {
      for (const id of [...(clip.bookmarks || []), ...(clip.folders || [])]) {
        try {
          const [n] = await chrome.bookmarks.get(String(id));
          if (n && String(n.parentId) !== targetId) {
            undoEntries.push({ id: String(id), parentId: n.parentId, index: n.index });
            await chrome.bookmarks.move(String(id), { parentId: targetId });
            moved++;
          }
        } catch {}
      }
      if (undoEntries.length) {
        await pushUndo(`剪切粘贴 ${undoEntries.length} 项 → ${index.folderPath.get(targetId) || targetId}`, undoEntries, 'move');
      }
    }

    await rebuild();
    return { ok: true, copied, moved };
  }

  if (type === 'trash:setup') {
    await ready;
    let target = null;
    if (msg.parentId) {
      // 自定义位置：用现成目录。路径从树上现算——刚建的目录可能还不在索引里（索引是派生品）
      const node = await getNode(String(msg.parentId));
      if (!node || node.url) return { error: '目标不是目录' };
      const all = await collectAllFolders();
      const hit = all.find((f) => f.id === node.id);
      target = { id: node.id, path: (hit && hit.path) || node.title || '' };
    } else {
      // 默认位置：其他书签/TagSpace/回收站（配置文件夹已整体排除，不用再注入 skipDirs）
      const kids = await chrome.bookmarks.getChildren(configFolderId);
      const found = kids.find((n) => !n.url && n.title === TRASH_NAME);
      const folder = found || (await chrome.bookmarks.create({ parentId: configFolderId, title: TRASH_NAME }));
      // 路径按当前树的真实标题算：配置文件夹本身被排除在索引外（folderPath 里没有），
      // 直接从树上取；非中文 locale 的根名是 Other bookmarks
      const all = await collectAllFolders();
      const base = (all.find((f) => f.id === configFolderId) || {}).path || CONFIG_DIR_NAME;
      target = { id: folder.id, path: `${base}${PATH_SEP}${TRASH_NAME}` };
    }
    await writePrefs({ trashPath: target.path });
    await rebuild();
    return { ok: true, ...target, path: target.path.split(PATH_SEP).join('/') };
  }

  if (type === 'trash:list') {
    await ready;
    const trash = await resolveTrash();
    if (!trash) return { ok: true, configured: false, items: [] };
    const origins = await loadTrashOrigins();
    const items = [];
    const walk = (nodes, path) => {
      for (const n of nodes || []) {
        const fp = path ? `${path}${PATH_SEP}${n.title || ''}` : `${trash.path}${PATH_SEP}${n.title || ''}`;
        const o = origins[n.id] || null;
        if (n.url) {
          items.push({
            id: n.id,
            title: n.title || '',
            url: n.url,
            isFolder: false,
            originPath: String((o && index.folderPath.get(o.parentId)) || '').split(PATH_SEP).join('/'),
            at: (o && o.at) || 0,
          });
        } else if (Array.isArray(n.children)) {
          // 文件夹（含删除的目录）：getChildren 不带 children，改从 getTree 遍历才看得见
          items.push({
            id: n.id,
            title: n.title || '',
            isFolder: true,
            originPath: (o && index.folderPath.get(o.parentId)) || '',
            at: (o && o.at) || 0,
          });
          walk(n.children, fp);
        }
      }
    };
    // getChildren 返回的节点不带 children 字段（文件夹会被漏掉），改用整棵树定位回收站
    const tree = await chrome.bookmarks.getTree();
    const trashNode = (function findTrash(nodes) {
      for (const n of nodes || []) {
        if (String(n.id) === String(trash.id)) return n;
        const h = findTrash(n.children);
        if (h) return h;
      }
      return null;
    })(tree);
    walk((trashNode && trashNode.children) || [], '');
    return { ok: true, configured: true, path: trash.path, items };
  }

  if (type === 'trash:restore') {
    await ready;
    const trash = await resolveTrash();
    if (!trash) return { error: '回收站未设置' };
    const origins = await loadTrashOrigins();
    const undoEntries = [];
    let restored = 0, failed = 0;
    for (const raw of msg.ids || []) {
      const id = String(raw);
      const node = await getNode(id);
      if (!node || !(await isUnderTrash(node, trash.id))) {
        failed++;
        continue;
      }
      try {
        const o = origins[id];
        const dest = o && o.parentId && (await getNode(o.parentId)) ? o.parentId : BOOKMARKS_BAR_ID;
        undoEntries.push({ id, parentId: trash.id });
        await chrome.bookmarks.move(id, { parentId: dest });
        restored++;
      } catch {
        failed++;
      }
    }
    if (restored) await dropTrashOrigins(msg.ids.map(String).filter((x) => origins[x]));
    if (undoEntries.length) await pushUndo(`从回收站还原 ${undoEntries.length} 条`, undoEntries, 'move');
    await rebuild();
    return { ok: true, restored, failed };
  }

  if (type === 'trash:purge') {
    await ready;
    const trash = await resolveTrash();
    if (!trash) return { error: '回收站未设置' };
    let purged = 0, failed = 0;
    const ids = (msg.ids || []).map(String);
    if (msg.empty) {
      // 清空：回收站整棵子树
      const kids = await chrome.bookmarks.getChildren(trash.id);
      ids.push(...kids.map((k) => k.id));
    }
    for (const id of ids) {
      const node = await getNode(id);
      if (!node) {
        failed++;
        continue;
      }
      try {
        if (node.url) await chrome.bookmarks.remove(id);
        else await chrome.bookmarks.removeTree(id);
        purged++;
      } catch {
        failed++;
      }
    }
    if (purged) await dropTrashOrigins(ids);
    await rebuild();
    return { ok: true, purged, failed };
  }

  if (type === 'index:rebuild') {
    await ready;
    const idx = await rebuild();
    return { ok: true, counts: idx.counts };
  }

  if (type === 'suggest:tags') {
    await ready;
    return {
      ok: true,
      items: suggestTagsFor({
        url: msg.url,
        title: msg.title,
        text: msg.text,
        limit: msg.limit,
      }),
    };
  }

  // ------------------------------------------------ 书签视图（M1/M2）
  if (type === 'bookmarks:page') {
    await ready;
    if (rebuildPending) await rebuild(); // 刚增删的书签要先重建索引，否则查不到
    // 查询语法（#标签 @目录 ?关键词，与侧边栏一致）：与文字筛选、目录筛选求交集
    const queryKeys = await queryKeySet(msg.query);
    const limit = Math.min(Math.max(Number(msg.limit) || 200, 1), 500);
    const offset = Math.max(Number(msg.offset) || 0, 0);
    const filter = msg.filter === 'untagged' || msg.filter === 'tagged' ? msg.filter : 'all';
    const q = String(msg.text || '').trim().toLowerCase();
    const folderId = msg.folderId || null;

    const rows = [];
    let cAll = 0;
    let cUntagged = 0;
    for (const [key, nodes] of index.keyToNodes) {
      if (queryKeys && !queryKeys.has(key)) continue;
      const tags = index.keyToTags.get(key) || [];
      const untagged = tags.length === 0;
      cAll++;
      if (untagged) cUntagged++;
      if (filter === 'untagged' && !untagged) continue;
      if (filter === 'tagged' && untagged) continue;
      const title = index.keyToText.get(key) || '';
      const url = index.keyToUrl.get(key) || '';
      if (q && !`${title} ${url}`.toLowerCase().includes(q)) continue;
      // 一个 URL 一行：多位置时挑第一个命中的位置，其余位置算 locations
      let pick = null;
      for (const n of nodes) {
        if (folderId && n.parentId !== folderId) continue;
        pick = n;
        break;
      }
      if (!pick) continue;
      rows.push({
        id: pick.id,
        key,
        parentId: pick.parentId,
        title,
        url,
        tags,
        path: pick.path,
        locations: nodes.length,
        seq: pick.seq ?? Infinity, // 树深度优先序，sort=tree 用
      });
    }
    if (msg.sort === 'tree') {
      // 按书签树默认顺序（与书签管理器一致）；同一目录内保持原有先后
      rows.sort((a, b) => a.seq - b.seq);
    } else {
      rows.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url, 'zh'));
    }

    // 标签云动态收窄（与侧边栏 query 同一套口径）：按全部命中集算相关标签/目录，
    // 不是只算当前页——翻页时云不能跟着变
    const matchedKeys = new Set(rows.map((r) => r.key));
    const related = relatedTags(index, matchedKeys);
    const blockedSet = blockedDirKeys();
    const relatedDirs = [];
    for (const [k, set] of index.dirTagToKeys) {
      if (blockedSet.has(k)) continue;
      let n = 0;
      for (const key of set) if (matchedKeys.has(key)) n++;
      if (n) relatedDirs.push({ key: k, tag: index.dirTagForm.get(k) || k, count: n });
    }
    const relatedDirsSorted = sortDirTagsByTree(index, relatedDirs);

    return {
      total: rows.length,
      offset,
      limit,
      items: rows.slice(offset, offset + limit),
      counts: { all: cAll, untagged: cUntagged, tagged: cAll - cUntagged },
      related,
      relatedDirs: relatedDirsSorted,
      // 全部命中集涉及的目录路径（树模式自动展开用；按全部算，与翻页无关）
      matchPaths: [...new Set(rows.map((r) => r.path).filter(Boolean))],
    };
  }

  if (type === 'bookmarks:ids') {
    await ready;
    if (rebuildPending) await rebuild();
    const queryKeys = await queryKeySet(msg.query);
    const filter = msg.filter === 'untagged' || msg.filter === 'tagged' ? msg.filter : 'all';
    const q = String(msg.text || '').trim().toLowerCase();
    const folderId = msg.folderId || null;
    // subtree=true：folderId 指整棵子树（树模式下钻后的「全选全部」）；
    // 否则保持旧语义：只算该目录的直属书签
    let folderScope = null;
    if (folderId) {
      folderScope = new Set([String(folderId)]);
      if (msg.subtree) {
        const tree = await chrome.bookmarks.getTree();
        (function collect(nodes) {
          for (const n of nodes || []) {
            if (String(n.id) === String(folderId)) {
              (function walkAll(x) {
                folderScope.add(String(x.id));
                for (const c of x.children || []) if (!c.url) walkAll(c);
              })(n);
            } else collect(n.children);
          }
        })(tree);
      }
    }
    const ids = [];
    for (const [key, nodes] of index.keyToNodes) {
      if (queryKeys && !queryKeys.has(key)) continue;
      const tags = index.keyToTags.get(key) || [];
      const untagged = tags.length === 0;
      if (filter === 'untagged' && !untagged) continue;
      if (filter === 'tagged' && untagged) continue;
      const title = index.keyToText.get(key) || '';
      const url = index.keyToUrl.get(key) || '';
      if (q && !`${title} ${url}`.toLowerCase().includes(q)) continue;
      let pick = null;
      for (const n of nodes) {
        if (folderScope && !folderScope.has(String(n.parentId))) continue;
        pick = n;
        break;
      }
      if (pick) ids.push(pick.id);
    }
    return { ok: true, ids, total: ids.length };
  }

  if (type === 'folders:list') {
    await ready;
    const tree = await chrome.bookmarks.getTree();
    const skipIds = new Set();
    if (configFolderId) skipIds.add(configFolderId);
    for (const n of Object.values(configNodes)) if (n && n.id) skipIds.add(n.id);
    // 当前回收站整枝不进目录下拉（移到目录、按目录筛都不该把回收站当目标）
    const trashNow = await resolveTrash(false);
    if (trashNow) skipIds.add(trashNow.id);

    const countOf = (node) => {
      let direct = 0;
      let total = 0;
      for (const c of node.children || []) {
        if (c.url) { direct++; total++; }
        else if (c.children) { const s = countOf(c); total += s.total; }
      }
      return { direct, total };
    };

    const build = (nodes, depth, parentPath) => {
      const out = [];
      for (const node of nodes || []) {
        if (node.url || !node.children) continue;
        if (skipIds.has(node.id)) continue;
        if (node.title === CONFIG_DIR_NAME) continue;
        const path = parentPath ? `${parentPath}${PATH_SEP}${node.title}` : node.title;
        const c = countOf(node);
        out.push({
          id: node.id,
          title: node.title || '',
          path,
          depth,
          count: c.direct,
          total: c.total,
          children: build(node.children, depth + 1, path),
        });
      }
      return out;
    };
    return { ok: true, tree: build(tree, 0, '') };
  }

  if (type === 'bookmark:create') {
    await ready;
    const url = String(msg.url || '');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return { error: 'URL 不合法' };
    const parentId = msg.parentId || (await ensureInbox());
    const title = String(msg.title || url);
    let node;
    try {
      node = await chrome.bookmarks.create({ parentId, title, url });
    } catch (e) {
      return { error: `无法在该目录创建书签：${String((e && e.message) || e)}` };
    }
    await rebuild();
    const tags = msg.tags || [];
    let written = 0;
    if (tags.length) {
      const r = await addTags([node.id], tags);
      written = r.written || 0;
    }
    const place = index.folderPath.get(parentId) || parentId;
    return { ok: true, created: true, id: node.id, written, place };
  }

  if (type === 'bookmarks:move') {
    await ready;
    const parentId = String(msg.parentId || '');
    if (!parentId) return { error: '缺少目标目录' };
    const undoEntries = [];
    let moved = 0;
    // index：插入到目标目录的第 index 位（拖拽到书签之间用）；多条按序依次下移一位
    let idx = msg.index == null ? null : Number(msg.index);
    for (const raw of msg.ids || []) {
      const id = String(raw);
      try {
        const node = await getNode(id);
        if (node) undoEntries.push({ id, parentId: node.parentId, index: node.index });
        await chrome.bookmarks.move(id, { parentId, ...(idx != null ? { index: idx } : {}) });
        if (idx != null) idx++;
        moved++;
      } catch {
        undoEntries.pop(); // 没动成就别记
      }
    }
    const path = index.folderPath.get(parentId) || parentId;
    if (undoEntries.length) await pushUndo(`移动 ${undoEntries.length} 条 → ${path}`, undoEntries, 'move');
    await rebuild();
    return { ok: true, moved, path };
  }

  // 重命名：文件夹直接改标题；书签只换干净标题（标签后缀与 [**指令串] 原样保留）
  if (type === 'node:rename') {
    await ready;
    const id = String(msg.id || '');
    const title = String(msg.title || '').trim();
    if (!id) return { error: '缺少节点' };
    if (!title) return { error: '名称不能为空' };
    const [node] = await chrome.bookmarks.get(id).catch(() => [null]);
    if (!node) return { error: '节点不存在' };
    let next = title;
    if (node.url) {
      const p = parseTitle(node.title);
      next = buildTitle(title, p.tags, p.conf);
    }
    await chrome.bookmarks.update(id, { title: next });
    await rebuild();
    return { ok: true, title: next };
  }

  if (type === 'page:info') {
    await ready;
    const key = canonicalUrl(msg.url || '');
    const recs = index.keyToNodes.get(key) || [];
    return {
      ok: true,
      collected: recs.length,
      tags: index.keyToTags.get(key) || [],
      cleanTitle: index.keyToText.get(key) || msg.title || '',
      ids: recs.map((r) => r.id),
      key,
    };
  }

  if (type === 'page:tag') {
    await ready;
    const key = canonicalUrl(msg.url || '');
    let recs = index.keyToNodes.get(key) || [];
    let created = false;
    if (!recs.length && msg.createIfMissing) {
      const inbox = await ensureInbox();
      await chrome.bookmarks.create({
        parentId: inbox,
        title: msg.title || msg.url,
        url: msg.url,
      });
      created = true;
      await rebuild();
      recs = index.keyToNodes.get(key) || [];
    }
    if (!recs.length) return { ok: true, written: 0, created: false };
    const r = await addTags(recs.map((x) => x.id), msg.tags || []);
    return { ok: true, created, ...r };
  }

  throw new Error(`未知消息类型：${type}`);
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg || {})
    .then((r) => respond(r))
    .catch((e) => respond({ error: String((e && e.message) || e) }));
  return true; // 异步响应
});

// ---------------------------------------------------------------- 其他入口

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    if (cmd === 'open-panel') {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
    } else if (cmd === 'open-space') {
      await chrome.tabs.create({ url: chrome.runtime.getURL(SPACE_PAGE) });
    }
  } catch (e) {
    console.error('[TagMyBookmarks] 命令失败', e);
  }
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  await ready;
  const q = String(text || '').trim().toLowerCase();
  const starts = [];
  const contains = [];
  for (const [k, form] of index.tagForm) {
    if (!q) {
      if (starts.length < 6) starts.push(form);
      continue;
    }
    if (k.startsWith(q) && starts.length < 6) starts.push(form);
    else if (k.includes(q) && contains.length < 6) contains.push(form);
  }
  // 目录标签建议（功能开着才给）
  const dirSugg = [];
  if (String(config.prefs.folderTags ?? '1') !== '0') {
    const blocked = blockedDirKeys();
    const isDir = q.startsWith('@');
    const dq = isDir ? q.slice(1) : q;
    for (const [k, form] of index.dirTagForm) {
      if (dirSugg.length >= 6) break;
      if (blocked.has(k)) continue;
      if (dq && !k.includes(dq)) continue;
      dirSugg.push({ content: `@${form}`, description: `目录：${form} 文件夹（含子级）` });
    }
  }

  suggest([
    ...starts.map((t) => ({ content: t, description: `在 TagMyBookmarks 中查 #${t}` })),
    ...contains.map((t) => ({ content: t, description: `包含 #${t}` })),
    ...dirSugg,
  ]);
});

chrome.omnibox.onInputEntered.addListener(async (text) => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`${SPACE_PAGE}#q=${encodeURIComponent(text || '')}`),
  });
});
