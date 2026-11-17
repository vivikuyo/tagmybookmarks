// 从书签树构建内存索引。纯函数：不碰 chrome API，便于单测。

import { parseTitle, tagKey, cpCompare } from './title.js';

/**
 * URL 归一化键。
 * 规则：忽略 http/https 差异、去 fragment、去默认端口、host 小写、路径尾部斜杠合并。
 * 不做的事：不剥 www、不合并 query 顺序——这些会导致误判，宁可少合并。
 */
export function canonicalUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  const proto = u.protocol.toLowerCase();

  if (proto === 'http:' || proto === 'https:') {
    const host = u.hostname.toLowerCase();
    const isDefaultPort =
      (proto === 'http:' && u.port === '80') || (proto === 'https:' && u.port === '443');
    const port = u.port && !isDefaultPort ? ':' + u.port : '';
    let path = u.pathname || '/';
    if (path === '/') path = '';
    else if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return host + port + path + (u.search || '');
  }

  return proto + '//' + u.host.toLowerCase() + u.pathname + u.search;
}

/** 书签节点上的目录路径 */
// 内部路径分隔符：控制字符，文件夹名不可能含——名字里的 "/" 不再被误当层级
// （对外显示仍拼回 "/"；排除/隐藏名单存的是名字不是路径，无迁移负担）
export const PATH_SEP = String.fromCharCode(31);

export function folderPathOf(rootPath, nodeTitle) {
  return rootPath ? `${rootPath}${PATH_SEP}${nodeTitle}` : nodeTitle;
}

/** 收集树里所有文件夹的完整路径（含根，顺序为深度优先） */
export function collectFolderPaths(tree) {
  const out = [];
  (function walk(nodes, path) {
    for (const node of nodes || []) {
      if (node.url || !node.children) continue;
      const fp = folderPathOf(path, node.title || '');
      out.push(fp);
      walk(node.children, fp);
    }
  })(tree, '');
  return out;
}

/**
 * 把排除条目解析成精确的文件夹路径。
 * 有同名文件夹时，路径才能分辨「回收站/前端」和「书签栏/前端」；老数据只有名字，
 * 按名字解析成当时的那些路径（行为等价于旧版按名排除）。
 */
export function resolveDirEntries(entries, paths) {
  const list = paths || [];
  const out = [];
  const add = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };

  // 第一遍：能精确对上路径的直接收下（新数据都是路径）
  const names = [];
  for (const raw of entries || []) {
    const e = String(raw || '').trim();
    if (!e) continue;
    // 老数据可能以 "/" 当分隔符存过路径：归一成内部分隔符再精确匹配
    const norm = e.replaceAll('/', PATH_SEP);
    if (list.includes(norm)) add(norm);
    else names.push(e);
  }

  // 第二遍：只有名字的老数据按名字解析。若候选里有"已排除目录的后代"，只取这些——
  // 老版级联排除留下的后代条目就属于这种情况，不能顺带把外面同名目录也排除掉
  for (const e of names) {
    const k = tagKey(e);
    // 候选：末段同名，或整条路径就是它 / 以它为结尾（兼容"名字本身含 /"的目录）
    const cands = list.filter((p) => {
      const s = String(p);
      return tagKey(s.split(PATH_SEP).pop()) === k || s === e || s.endsWith(PATH_SEP + e);
    });
    const inside = cands.filter((p) => out.some((q) => String(p).startsWith(`${q}${PATH_SEP}`)));
    const pick = inside.length ? inside : cands;
    for (const p of pick) add(p);
  }
  return out;
}

/**
 * @param tree chrome.bookmarks.getTree() 的结果
 * @param {{excludeIds?: Set<string>, skipDirs?: string[]}} opts
 *        excludeIds 里是配置文件节点与配置文件夹；skipDirs 是"硬排除"的目录条目（优先按
 *        **文件夹路径** 精确匹配，如 `书签栏/前端`；老数据只是名字时按名字解析成路径），
 *        命中的整棵子树都不进索引（连书签一起，搜不到）
 */
// Chrome 的固定根：1 = 书签栏，2 = 其他书签，3 = 移动设备书签；名字用于没有 parentId 的树
const ROOT_IDS = new Set(['1', '2', '3']);
const ROOT_TITLES = new Set([
  '书签栏', '其他书签', '移动设备书签', '受管理的书签',
  'bookmarks bar', 'other bookmarks', 'mobile bookmarks', 'managed bookmarks',
]);

/**
 * 去掉"已被祖先目录覆盖"的冗余条目。
 * 老版本按名字级联排除了整枝后代，那些后代条目没有意义（祖先已整枝排除），顺手清掉。
 */
export function pruneNestedPaths(paths) {
  const list = (paths || []).filter(Boolean);
  return list.filter((p) => !list.some((q) => q !== p && String(p).startsWith(`${q}${PATH_SEP}`)));
}

export function buildIndex(tree, opts = {}) {
  const exclude = opts.excludeIds || new Set();
  const skipPaths = new Set(resolveDirEntries(opts.skipDirs, collectFolderPaths(tree)));

  const idx = {
    tagToKeys: new Map(), // lower(tag) → Set<urlKey>
    keyToTags: new Map(), // urlKey → string[]（并集，保留首次写法）
    keyToText: new Map(), // urlKey → 干净标题
    keyToUrl: new Map(), // urlKey → 原始 URL
    keyToNodes: new Map(), // urlKey → 节点记录数组
    tagForm: new Map(), // lower(tag) → 展示写法
    nodeById: new Map(),
    allKeys: new Set(),
    untaggedKeys: new Set(),
    folderPath: new Map(), // folderId → "书签栏/工具"
    // 目录标签（虚拟）：文件夹层级投影，不写入任何标题
    folders: [], // 所有文件夹（含根）：{ path: '书签栏/工具', name: '工具' }
    dirOrder: new Map(), // 目录名 tagKey → 首次出现的 DFS 位次（目录云按树结构排序用）
    dirEdges: new Map(), // 子目录名 tagKey → Set<父目录名 tagKey>（去掉根层；仅供展示/兼容）
    dirNamePaths: new Map(), // 目录名 tagKey → Set<完整路径>（同名目录在不同枝各算各的）
    dirPathEdges: new Map(), // 完整路径 → Set<父路径>（按路径建图，同名不合并）
    dirPathName: new Map(), // 完整路径 → 显示名
    dirTagToKeys: new Map(), // tagKey → Set<urlKey>
    keyToDirTags: new Map(), // urlKey → string[]（显示名，已去重排序）
    dirTagForm: new Map(), // tagKey → 首见显示名
    counts: { nodes: 0, keys: 0, tags: 0, excluded: 0, dirTags: 0, folders: 0, roots: 0, deepFolders: 0 },
  };

  // 1. 展开成扁平条目，同时记录目录路径 + 各级文件夹名
  //    Chrome 的 getTree 最顶层是空标题的合成根，真实根（书签栏/其他书签）在第二层，
  //    这两层都算"结构"不算"内容"，做目录标签时都要丢掉
  const flat = [];
  (function walk(nodes, path, names, contentParent) {
    for (const node of nodes || []) {
      if (node.url) {
        flat.push({ node, path, names });
      } else if (node.children) {
        const title = node.title || '';
        // 硬排除：按"文件夹路径"精确匹配，命中则整棵子树都不索引。
        // 用路径而不是名字，才能只排除「回收站/前端」而不误伤「书签栏/前端」
        if (skipPaths.has(folderPathOf(path, title))) continue;
        // 根目录只按 Chrome 的固定 id / 根名识别：书签栏(1)、其他书签(2)、移动设备书签(3)。
        // 不能按"深度第一层"认根——书签管理类扩展会把「回收站」直接建在树根上，
        // 那样会把它连同整枝名字一起当根丢掉（表现出来就是父目录消失、子目录还在）
        // id '0' 是 Chrome 的合成根（空标题），也属于结构层，不算内容文件夹
        const isRoot = ROOT_IDS.has(node.id) || node.id === '0' || ROOT_TITLES.has(tagKey(title));
        const folderPath = folderPathOf(path, title);
        idx.folderPath.set(node.id, folderPath);

        let nextNames = names;
        if (isRoot) {
          idx.counts.roots++;
        } else {
          idx.folders.push({ path: folderPath, name: title });
          nextNames = [...names, title];
          const selfKey = tagKey(title);
          // DFS 位次：同名目录在不同枝时取最早出现的那个，保证 chip 位置稳定
          if (!idx.dirOrder.has(selfKey)) idx.dirOrder.set(selfKey, idx.folders.length - 1);
          idx.dirPathName.set(folderPath, title);
          if (!idx.dirNamePaths.has(selfKey)) idx.dirNamePaths.set(selfKey, new Set());
          idx.dirNamePaths.get(selfKey).add(folderPath);

          // 名字图（兼容用）：同名跨枝会合并，不能拿它算关系
          const parentKey = contentParent ? tagKey(contentParent) : '';
          if (parentKey && selfKey && parentKey !== selfKey) {
            if (!idx.dirEdges.has(selfKey)) idx.dirEdges.set(selfKey, new Set());
            idx.dirEdges.get(selfKey).add(parentKey);
          }
          // 路径图（关系用）：只有真正的父路径才连边，同名文件夹互不相干
          if (contentParent && path) {
            if (!idx.dirPathEdges.has(folderPath)) idx.dirPathEdges.set(folderPath, new Set());
            idx.dirPathEdges.get(folderPath).add(path);
          }
        }
        walk(node.children, folderPath, nextNames, isRoot ? contentParent : title);
      }
    }
  })(tree, '', [], '');
  idx.counts.folders = idx.folderPath.size;
  // 内容文件夹 = 去掉根之后剩下的那些（含书签的才成为目录标签，空的不计数在别处）
  idx.counts.deepFolders = Math.max(0, idx.folderPath.size - idx.counts.roots);

  // 2. 逐条解析标题、按 URL 归并
  let seq = 0; // 书签树深度优先顺序：空查询时按它显示（与书签管理器一致）
  for (const { node, path, names } of flat) {
    if (exclude.has(node.id)) {
      idx.counts.excluded++;
      continue;
    }
    const key = canonicalUrl(node.url);
    if (!key) continue;

    const parsed = parseTitle(node.title);
    const rec = {
      id: node.id,
      seq: seq++,
      parentId: node.parentId,
      url: node.url,
      title: node.title,
      path,
      text: parsed.text,
      tags: parsed.tags,
      conf: parsed.conf,
    };
    idx.nodeById.set(node.id, rec);

    if (!idx.keyToNodes.has(key)) idx.keyToNodes.set(key, []);
    idx.keyToNodes.get(key).push(rec);

    if (!idx.keyToText.has(key)) {
      idx.keyToText.set(key, parsed.text);
      idx.keyToUrl.set(key, node.url);
    }

    idx.allKeys.add(key);

    // 目录标签：各级文件夹名（去掉根），同 URL 多位置取并集
    // names 里现在只累积"内容文件夹"（根在 walk 阶段已排除），不再按深度丢弃
    const dirNames = names.filter(Boolean);
    if (dirNames.length) {
      const merged = idx.keyToDirTags.get(key) || [];
      const seenDir = new Set(merged.map(tagKey));
      for (const d of dirNames) {
        if (!seenDir.has(tagKey(d))) {
          merged.push(d);
          seenDir.add(tagKey(d));
        }
      }
      idx.keyToDirTags.set(key, merged);
    }

    const existing = idx.keyToTags.get(key) || [];
    const seen = new Set(existing.map(tagKey));
    for (const t of parsed.tags) {
      const k = tagKey(t);
      if (!seen.has(k)) {
        existing.push(t);
        seen.add(k);
      }
      if (!idx.tagForm.has(k)) idx.tagForm.set(k, t);
      if (!idx.tagToKeys.has(k)) idx.tagToKeys.set(k, new Set());
      idx.tagToKeys.get(k).add(key);
    }
    idx.keyToTags.set(key, existing);
    idx.counts.nodes++;
  }

  // 3. 排序收尾：标签按码点序，未打标签集合
  for (const [key, tags] of idx.keyToTags) {
    const normalized = [...tags].sort(cpCompare);
    idx.keyToTags.set(key, normalized);
    if (!normalized.length) idx.untaggedKeys.add(key);
  }

  // 目录标签收尾：排序 + 反向索引 + 频次
  for (const [key, dirs] of idx.keyToDirTags) {
    idx.keyToDirTags.set(key, [...dirs].sort(cpCompare));
    for (const d of dirs) {
      const k = tagKey(d);
      if (!idx.dirTagForm.has(k)) idx.dirTagForm.set(k, d);
      if (!idx.dirTagToKeys.has(k)) idx.dirTagToKeys.set(k, new Set());
      idx.dirTagToKeys.get(k).add(key);
    }
  }
  idx.counts.dirTags = idx.dirTagToKeys.size;

  idx.skipPaths = skipPaths; // 生效的排除路径（PATH_SEP 形态），供"目录被排除"提示用
  idx.counts.keys = idx.allKeys.size;
  idx.counts.tags = idx.tagToKeys.size;
  return idx;
}

/** 全局标签频次（空查询时用于标签云） */
/**
 * 目录标签的相关闭包：选中若干目录名后，返回与其同一枝（祖先/后代/自身）的目录名集合。
 *
 * 关键：必须在**路径图**上算，而不是名字图。目录标签是"文件夹名的投影"，
 * 同名文件夹可能出现在不同枝；按名字建图会把它们合并成一个节点，
 * 于是 A 枝的 Design 会经由同名子目录跟 B 枝的网络技巧"连成同枝"，
 * 出现两个毫无交集的目录被同时选中（结果 0 条）的怪象。
 */
export function dirRelatedKeys(idx, keys) {
  const list = [...(keys || [])];
  if (!list.length) return new Set();

  const namePaths = idx.dirNamePaths;
  const edges = idx.dirPathEdges;
  // 老索引（没有路径图）时退化为"只保留已选"
  if (!namePaths || !namePaths.size || !edges || !edges.size) return new Set(list);

  const pathName = (path) => idx.dirPathName.get(path) || String(path).split(PATH_SEP).pop();

  // 单条路径的同枝闭包：自身 + 祖先 + 后代
  const pathClosure = (start) => {
    const out = new Set([start]);
    const up = [start];
    while (up.length) {
      const x = up.pop();
      for (const parent of edges.get(x) || []) if (!out.has(parent)) { out.add(parent); up.push(parent); }
    }
    const down = [start];
    while (down.length) {
      const x = down.pop();
      for (const [child, parents] of edges) {
        if (parents.has(x) && !out.has(child)) { out.add(child); down.push(child); }
      }
    }
    return out;
  };

  // 一个目录名可能对应多条路径（同名多处），并集算
  let acc = null;
  for (const k of list) {
    const paths = namePaths.get(k) || new Set();
    const c = new Set();
    for (const path of paths) for (const x of pathClosure(path)) c.add(x);
    acc = acc ? new Set([...acc].filter((x) => c.has(x))) : c;
  }

  // 路径结果投影回名字：同一名字无论出现在几条路径，chip 只有一个
  const out = new Set();
  for (const path of acc || []) out.add(tagKey(pathName(path)));
  // 已选项永远保留（否则 chip 自己消失，用户以为选择丢了）
  for (const k of list) out.add(k);
  return out;
}

/** 目录标签按树结构序（DFS 位次，同名取最早）；次数只做平手裁决 */
export function sortDirTagsByTree(idx, list) {
  return [...list].sort(
    (a, b) =>
      ((idx.dirOrder && idx.dirOrder.get(a.key)) ?? Infinity) -
        ((idx.dirOrder && idx.dirOrder.get(b.key)) ?? Infinity) ||
      b.count - a.count ||
      (a.key < b.key ? -1 : 1)
  );
}

export function globalTagCounts(idx) {
  const out = [];
  for (const [k, keys] of idx.tagToKeys) {
    out.push({ key: k, tag: idx.tagForm.get(k) || k, count: keys.size });
  }
  // 字母序（中文按拼音），次数只做平手裁决
  return out.sort((a, b) => a.tag.localeCompare(b.tag, 'zh') || b.count - a.count || cpCompare(a.tag, b.tag));
}
