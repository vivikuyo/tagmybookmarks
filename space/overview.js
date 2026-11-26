// 概览：四张卡 + 健康检查清单 + 会话统计
import { modal } from './tags.js';

const $ = (sel) => document.querySelector(sel);

function toast(text, isErr = false) {
  const el = $('#toast');
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

function card(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function renderCards(r) {
  const c = r.counts || {};
  card('#cardNodes', c.nodes || 0);
  card('#cardKeys', c.keys || 0);
  card('#cardTags', c.tags || 0);
  card('#cardUntagged', r.untagged || 0);
}

function issueRow(issue) {
  const row = document.createElement('div');
  row.className = `issue sev-${issue.severity}`;

  const dot = document.createElement('span');
  dot.className = 'sev-dot';

  const body = document.createElement('div');
  body.className = 'issue-body';

  const title = document.createElement('p');
  title.className = 'issue-title';
  title.textContent = issue.label;
  const num = document.createElement('b');
  num.textContent = ` ${issue.count}`;
  title.append(num, ' 处');

  const hint = document.createElement('p');
  hint.className = 'issue-hint';
  hint.textContent = issue.hint;

  body.append(title, hint);

  if (issue.samples && issue.samples.length) {
    const det = document.createElement('details');
    det.className = 'issue-samples';
    const sum = document.createElement('summary');
    sum.textContent = `看 ${issue.samples.length} 个例子`;
    det.append(sum);
    const ul = document.createElement('ul');
    for (const s of issue.samples) {
      const li = document.createElement('li');
      const t = document.createElement('code');
      t.textContent = String(s.title || '').slice(0, 160);
      li.append(t);
      if (s.note) {
        const n = document.createElement('span');
        n.className = 'note';
        n.textContent = ' · ' + s.note;
        li.append(n);
      }
      ul.append(li);
    }
    det.append(ul);
    body.append(det);
  }

  const ops = document.createElement('div');
  ops.className = 'issue-ops';
  if (issue.fixable) {
    const fix = document.createElement('button');
    fix.className = 'btn small';
    fix.textContent = '修复';
    fix.addEventListener('click', () => runFix([issue.kind], issue));
    ops.append(fix);
  } else {
    const tag = document.createElement('span');
    tag.className = 'hint';
    tag.textContent = '只报告';
    ops.append(tag);
  }

  row.append(dot, body, ops);
  return row;
}

async function runFix(kinds, issue) {
  const desc = issue
    ? `${issue.label}：将改写 ${issue.count} 处。${issue.hint}`
    : `将修复 ${kinds.length} 类问题。`;
  const ok = await modal({ title: '修复', desc, input: null, okText: '开始修复' });
  if (ok === null) return;

  try {
    const r = await send({ type: 'diag:fix', kinds });
    const bits = [];
    if (r.written) bits.push(`改写 ${r.written} 条标题`);
    if (r.configWritten) bits.push(`更新 ${r.configWritten} 个配置文件`);
    if (!bits.length) bits.push('没有实际改动');
    bits.push(`剩余问题 ${r.remaining} 处`);
    toast(bits.join('，'));
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderIssues(r) {
  const list = $('#issueList');
  list.textContent = '';
  const issues = r.issues || [];

  const fixable = issues.filter((i) => i.fixable);
  const btn = $('#btnFixAll');
  const totalWarn = issues.filter((i) => i.severity === 'warn').length;

  $('#healthSummary').textContent = issues.length
    ? `${issues.length} 类问题 · 其中 ${totalWarn} 类建议处理`
    : '没有发现问题';

  if (fixable.length) {
    btn.hidden = false;
    btn.textContent = `一键修复 ${fixable.length} 类可修项`;
    btn.onclick = () => runFix(fixable.map((i) => i.kind), null);
  } else {
    btn.hidden = true;
  }

  if (!issues.length) {
    const ok = document.createElement('div');
    ok.className = 'issue ok';
    const dot = document.createElement('span');
    dot.className = 'sev-dot';
    const body = document.createElement('div');
    body.className = 'issue-body';
    const p = document.createElement('p');
    p.className = 'issue-title';
    p.textContent = '标题格式、配置、颜色、别名都没发现问题';
    const h = document.createElement('p');
    h.className = 'issue-hint';
    h.textContent = '注意：这里只检查"能被规则判定"的问题。"书签内容本身该不该打这个标签"没法自动判断。';
    body.append(p, h);
    ok.append(dot, body);
    list.append(ok);
    return;
  }

  for (const issue of issues) list.append(issueRow(issue));
}

function renderStats(stats) {
  const s = stats || {};
  $('#statsLine').textContent =
    `本次会话：索引重建 ${s.rebuilds || 0} 次（最近一次 ${s.lastBuildMs || 0}ms）` +
    ` · 写标题 ${s.writes || 0} 次 · 查询 ${s.queries || 0} 次`;
}

export async function refresh() {
  try {
    const st = await send({ type: 'state', includePrivate: true });
    const scan = await send({ type: 'diag:scan' });
    renderCards(scan);
    renderIssues(scan);
    renderStats(scan.stats || st.stats);
  } catch (e) {
    toast(e.message, true);
  }
}
