// The REST v3 surface: the API root and meta, the token's user, repositories
// and their branches, commits and contents, labels, issues and comments,
// pull requests and merges, and the git refs API. Every handler reads and
// writes the one store in forge.ts, so a change made here is visible to the
// git protocol, GraphQL and MCP at once.

import {
  EMPTY_TREE_OID,
  VIEWER,
  ZERO_OID,
  allocDbId,
  branchTipCommit,
  commitTreeOid,
  createCommit,
  createRepoRec,
  deleteRepoRec,
  diffFlat,
  flattenTree,
  getCommit,
  getObject,
  getRepoRec,
  hasObject,
  isoOf,
  listReposOf,
  mergeBase,
  mergeFlat,
  newComment,
  nowIso,
  peelToCommit,
  refTip,
  setTreePath,
  storeObject,
  treeFromFlat,
  treeLevel,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type Record,
  type RepoRec,
} from './forge.ts';
import { ApiError, authed, notFound, type Ctx } from './http.ts';

// ---------------------------------------------------------------------------
// small helpers

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function userJson(login: string): Json {
  if (login === VIEWER.login) {
    return { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id), type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email };
  }
  return { login, id: 0, type: 'User', site_admin: false };
}

/** The forge's global id for a record: opaque, stable, and decodable by us. */
export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function repoJson(ctx: Ctx, repo: RepoRec): Json {
  const origin = ctx.origin();
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.records.values()].filter((record) => record.state === 'open').length,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    license: null,
  };
}

function labelJson(label: LabelRec): Json {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function commentJson(comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function issueJson(ctx: Ctx, repo: RepoRec, issue: IssueRec): Json {
  const origin = ctx.origin();
  return {
    id: issue.dbId,
    node_id: globalId('Issue', issue.dbId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, node_id: '', name, color: 'ededed', default: false, description: null };
    }),
    user: userJson(VIEWER.login),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function pullJson(ctx: Ctx, repo: RepoRec, pull: PullRec): Json {
  const origin = ctx.origin();
  const side = (ref: string): Json => {
    const tip = refTip(repo, ref);
    return {
      label: `${repo.owner}:${ref}`,
      ref,
      sha: tip ?? ZERO_OID,
      user: userJson(repo.owner),
      repo: repoJson(ctx, repo),
    };
  };
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', pull.dbId),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER.login),
    labels: [],
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    merged_by: pull.merged ? userJson(VIEWER.login) : null,
    comments: pull.comments.length,
    head: side(pull.headRef),
    base: side(pull.baseRef),
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

/** Slice a list by page/per_page and build the Link header set. */
function paginate(ctx: Ctx, all: readonly unknown[]): Page {
  const query = ctx.url.searchParams;
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const total = all.length;
  const items = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (total > 0 && (page < lastPage || page > 1)) {
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `<${ctx.origin()}${ctx.url.pathname}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < lastPage) links.push(`${linkFor(page + 1)}; rel="next"`, `${linkFor(lastPage)}; rel="last"`);
    if (page > 1) links.push(`${linkFor(1)}; rel="first"`, `${linkFor(page - 1)}; rel="prev"`);
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items, headers };
}

function mustRepo(owner: string, name: string): RepoRec {
  const repo = getRepoRec(owner, name);
  if (!repo) throw notFound('Repository not found');
  return repo;
}

function mustRecord(repo: RepoRec, number: number): Record {
  const record = repo.records.get(number);
  if (!record) throw notFound('Issue not found');
  return record;
}

// ---------------------------------------------------------------------------
// repositories

function createRepo(ctx: Ctx): void {
  const body = ctx.json();
  const name = str(body.name);
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    throw new ApiError(422, 'Repository name is invalid');
  }
  if (getRepoRec(VIEWER.login, name)) {
    throw new ApiError(422, `Repository already exists: ${VIEWER.login}/${name}`);
  }
  const repo = createRepoRec(VIEWER.login, name, {
    description: str(body.description),
    isPrivate: boolOr(body.private, false),
    defaultBranch: str(body.default_branch) || 'main',
  });
  ctx.send(201, repoJson(ctx, repo));
}

function patchRepo(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.json();
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  repo.updatedAt = nowIso();
  ctx.send(200, repoJson(ctx, repo));
}

function listBranches(ctx: Ctx, repo: RepoRec): void {
  const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
  const out = names.map((name) => ({
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: `${ctx.origin()}/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
    protected: false,
  }));
  const page = paginate(ctx, out);
  ctx.send(200, page.items, page.headers);
}

function getBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const tip = refTip(repo, branch);
  if (tip === null) throw notFound('Branch not found');
  ctx.send(200, {
    name: branch,
    commit: { sha: tip, url: `${ctx.origin()}/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` },
    protected: false,
  });
}

function identParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: isoOf(1_735_689_600) };
  return { name: match[1] as string, email: match[2] as string, date: isoOf(Number.parseInt(match[3] as string, 10)) };
}

function commitJson(ctx: Ctx, oid: string): Json {
  const commit = getCommit(oid);
  if (!commit) throw notFound('Commit not found');
  const author = identParts(commit.author);
  const committer = identParts(commit.committer);
  return {
    sha: oid,
    node_id: globalId('Commit', 0) + oid.slice(0, 8),
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `${ctx.origin()}/api/v3/repos/x/y/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    author: author.email === VIEWER.email ? userJson(VIEWER.login) : null,
    committer: committer.email === VIEWER.email ? userJson(VIEWER.login) : null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${ctx.origin()}/api/v3/repos/x/y/commits/${parent}` })),
  };
}

function listCommits(ctx: Ctx, repo: RepoRec): void {
  const shaParam = ctx.url.searchParams.get('sha');
  let start: string | null;
  if (shaParam === null || shaParam === '') {
    start = branchTipCommit(repo, repo.defaultBranch);
  } else if (hasObject(shaParam) && getCommit(shaParam)) {
    start = shaParam;
  } else {
    start = branchTipCommit(repo, shaParam);
  }
  if (start === null) {
    const page = paginate(ctx, []);
    ctx.send(200, page.items, page.headers);
    return;
  }
  // Depth-first walk from the tip, parents in order: newest first for the
  // linear histories the API is exercised with, and always topological.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const commit = getCommit(oid);
    if (!commit) return;
    seen.add(oid);
    order.push(oid);
    for (const parent of commit.parents) visit(parent);
  };
  visit(start);
  const page = paginate(ctx, order.map((oid) => commitJson(ctx, oid)));
  ctx.send(200, page.items, page.headers);
}

// ---------------------------------------------------------------------------
// contents

interface PathTarget {
  branch: string;
  tip: string | null;
  tree: string | null;
}

/** Resolve a branch name (writes) or a branch/sha ref (reads) to its tree. */
function contentsTarget(repo: RepoRec, refName: string | undefined): PathTarget {
  if (refName !== undefined && refTip(repo, refName) === null && hasObject(refName)) {
    const commit = peelToCommit(refName);
    return { branch: repo.defaultBranch, tip: commit, tree: commit === null ? null : commitTreeOid(commit) };
  }
  const branch = refName ?? repo.defaultBranch;
  const tip = branchTipCommit(repo, branch);
  return { branch, tip, tree: tip === null ? null : commitTreeOid(tip) };
}

/** The blob at a path in a tree, walking directories; null when absent. */
function blobAt(treeOid: string | null, parts: readonly string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    if (current === null) return null;
    const obj = getObject(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = treeLevel(current).get(parts[index] as string);
    if (!entry) return null;
    if (index === parts.length - 1) {
      return entry.mode === '40000' ? null : { oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function getContents(ctx: Ctx, repo: RepoRec, parts: string[]): void {
  const ref = ctx.url.searchParams.get('ref') ?? undefined;
  const target = contentsTarget(repo, ref);
  const tree = target.tree;
  const origin = ctx.origin();
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents`;
  if (parts.length === 0) {
    const entries = [...treeLevel(tree).values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const out = entries.map((entry) => dirEntryJson(ctx, repo, entry, '', base));
    ctx.send(200, out);
    return;
  }
  // Walk to the addressed entry.
  let current = tree;
  for (let index = 0; index < parts.length; index += 1) {
    if (current === null) throw notFound('Not Found');
    const entry = treeLevel(current).get(parts[index] as string);
    if (!entry) throw notFound('Not Found');
    if (index < parts.length - 1) {
      if (entry.mode !== '40000') throw notFound('Not Found');
      current = entry.oid;
      continue;
    }
    const path = parts.join('/');
    if (entry.mode === '40000') {
      const children = [...treeLevel(entry.oid).values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      const out = children.map((child) => dirEntryJson(ctx, repo, child, path, base));
      ctx.send(200, out);
      return;
    }
    const blob = getObject(entry.oid);
    const data = blob && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
    ctx.send(200, {
      name: entry.name,
      path,
      sha: entry.oid,
      size: data.length,
      url: `${base}/${path}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
      download_url: `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      _links: { self: `${base}/${path}`, git: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`, html: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
    });
    return;
  }
}

function dirEntryJson(ctx: Ctx, repo: RepoRec, entry: { name: string; mode: string; oid: string }, prefix: string, base: string): Json {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const blob = !isDir ? getObject(entry.oid) : undefined;
  return {
    name: entry.name,
    path,
    sha: entry.oid,
    size: blob && blob.type === 'blob' ? blob.data.length : 0,
    url: `${base}/${path}`,
    html_url: `${ctx.origin()}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    git_url: `${ctx.origin()}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `${ctx.origin()}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    type: isDir ? 'dir' : 'file',
    _links: { self: `${base}/${path}`, git: '', html: '' },
  };
}

function commitShape(ctx: Ctx, repo: RepoRec, sha: string): Json {
  const commit = getCommit(sha);
  const author = commit ? identParts(commit.author) : { name: VIEWER.name, email: VIEWER.email, date: nowIso() };
  const committer = commit ? identParts(commit.committer) : author;
  return {
    sha,
    url: `${ctx.origin()}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${ctx.origin()}/${repo.owner}/${repo.name}/commit/${sha}`,
    author,
    committer,
    tree: { sha: commit?.tree ?? EMPTY_TREE_OID, url: '' },
    message: commit?.message ?? '',
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function putContents(ctx: Ctx, repo: RepoRec, parts: string[]): void {
  const body = ctx.json();
  const message = str(body.message);
  const contentB64 = str(body.content);
  const branchName = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentsTarget(repo, branchName);
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const existing = blobAt(target.tree, parts);
  if (existing) {
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    if (givenSha === null) throw new ApiError(422, '"sha" wasn\'t supplied');
    if (givenSha !== existing.oid) throw new ApiError(409, `${parts.join('/')} sha ${givenSha} does not match ${existing.oid}`);
  }
  const blobOid = storeObject('blob', data);
  const newTree = setTreePath(target.tree, parts, existing?.mode ?? '100644', blobOid);
  const commit = createCommit(newTree, target.tip === null ? [] : [target.tip], message);
  repo.refs.set(`refs/heads/${target.branch}`, commit);
  repo.updatedAt = nowIso();
  const status = existing ? 200 : 201;
  ctx.send(status, {
    content: {
      name: parts[parts.length - 1] as string,
      path: parts.join('/'),
      sha: blobOid,
      size: data.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
      type: 'file',
      encoding: 'base64',
      _links: { self: '', git: '', html: '' },
    },
    commit: commitShape(ctx, repo, commit),
  });
}

function deleteContents(ctx: Ctx, repo: RepoRec, parts: string[]): void {
  const body = ctx.json();
  const message = str(body.message);
  const branchName = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentsTarget(repo, branchName);
  const existing = blobAt(target.tree, parts);
  if (!existing) throw notFound('Not Found');
  const givenSha = typeof body.sha === 'string' ? body.sha : null;
  if (givenSha !== null && givenSha !== existing.oid) throw new ApiError(409, 'sha does not match');
  const newTree = setTreePath(target.tree, parts, existing.mode, null);
  const commit = createCommit(newTree, target.tip === null ? [] : [target.tip], message);
  repo.refs.set(`refs/heads/${target.branch}`, commit);
  repo.updatedAt = nowIso();
  ctx.send(200, { content: null, commit: commitShape(ctx, repo, commit) });
}

// ---------------------------------------------------------------------------
// git refs API

function createRef(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.json();
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/')) throw new ApiError(422, 'ref must start with refs/');
  if (!hasObject(sha) || peelToCommit(sha) === null) throw new ApiError(422, 'sha is not a commit');
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  ctx.send(201, { ref, node_id: globalId('Ref', 0), url: '', object: { type: 'commit', sha } });
}

function getRef(ctx: Ctx, repo: RepoRec, tail: string[]): void {
  const joined = tail.join('/');
  const full = joined.startsWith('refs/') ? joined : `refs/${joined}`;
  const sha = repo.refs.get(full);
  if (sha === undefined) throw notFound('Reference not found');
  const obj = getObject(sha);
  ctx.send(200, { ref: full, node_id: globalId('Ref', 0), url: '', object: { type: obj?.type ?? 'commit', sha } });
}

function listRefs(ctx: Ctx, repo: RepoRec): void {
  const out = [...repo.refs.entries()].sort().map(([ref, sha]) => ({
    ref,
    node_id: globalId('Ref', 0),
    url: '',
    object: { type: getObject(sha)?.type ?? 'commit', sha },
  }));
  const page = paginate(ctx, out);
  ctx.send(200, page.items, page.headers);
}

// ---------------------------------------------------------------------------
// labels

function createLabel(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.json();
  const name = str(body.name);
  if (name === '') throw new ApiError(422, 'Label name is required');
  if (repo.labels.has(name)) throw new ApiError(422, 'Label already exists');
  const label: LabelRec = {
    id: repo.nextLabelId,
    name,
    color: str(body.color).replace(/^#/, '') || 'ededed',
    description: typeof body.description === 'string' ? body.description : null,
  };
  repo.nextLabelId += 1;
  repo.labels.set(name, label);
  ctx.send(201, labelJson(label));
}

// ---------------------------------------------------------------------------
// issues and comments

function labelNamesOf(repo: RepoRec, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Json).name === 'string') names.push((item as Json).name as string);
  }
  for (const name of names) {
    if (!repo.labels.has(name)) throw new ApiError(422, `Label '${name}' does not exist`);
  }
  return names;
}

export function createIssueRecord(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
  const stamp = nowIso();
  const issue: IssueRec = {
    kind: 'issue',
    dbId: allocDbId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextNumber += 1;
  repo.records.set(issue.number, issue);
  return issue;
}

function createIssue(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.json();
  const title = str(body.title);
  if (title === '') throw new ApiError(422, 'Title is required');
  const labels = labelNamesOf(repo, body.labels);
  const issue = createIssueRecord(repo, { title, body: str(body.body), labels });
  ctx.send(201, issueJson(ctx, repo, issue));
}

function listIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.records.values()].filter((record): record is IssueRec => record.kind === 'issue');
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(ctx, issues.map((issue) => issueJson(ctx, repo, issue)));
  ctx.send(200, page.items, page.headers);
}

function patchIssue(ctx: Ctx, repo: RepoRec, record: Record): void {
  if (record.kind !== 'issue') throw notFound('Issue not found');
  const body = ctx.json();
  if (typeof body.title === 'string') record.title = body.title;
  if (typeof body.body === 'string') record.body = body.body;
  if (body.state === 'open' || body.state === 'closed') record.state = body.state;
  if (Array.isArray(body.labels)) record.labels = labelNamesOf(repo, body.labels);
  record.updatedAt = nowIso();
  ctx.send(200, issueJson(ctx, repo, record));
}

function createComment(ctx: Ctx, repo: RepoRec, record: Record): void {
  const body = ctx.json();
  const text = str(body.body);
  if (text === '') throw new ApiError(422, 'Body is required');
  const comment = newComment(text);
  record.comments.push(comment);
  record.updatedAt = nowIso();
  ctx.send(201, commentJson(comment));
}

function listComments(ctx: Ctx, repo: RepoRec, record: Record): void {
  void repo;
  const page = paginate(ctx, record.comments.map((comment) => commentJson(comment)));
  ctx.send(200, page.items, page.headers);
}

// ---------------------------------------------------------------------------
// pull requests

export function pullDiff(repo: RepoRec, pull: PullRec): { base: string | null; head: string | null; files: ReturnType<typeof diffFlat> } {
  const headTip = branchTipCommit(repo, pull.headRef);
  const baseTip = branchTipCommit(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { base: baseTip, head: headTip, files: [] };
  const mb = mergeBase(baseTip, headTip);
  const baseTree = mb === null ? null : commitTreeOid(mb);
  const headTree = commitTreeOid(headTip);
  const files = diffFlat(flattenTree(baseTree), flattenTree(headTree));
  return { base: baseTip, head: headTip, files };
}

export function createPullRecord(repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec {
  const stamp = nowIso();
  const pull: PullRec = {
    kind: 'pull',
    dbId: allocDbId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextNumber += 1;
  repo.records.set(pull.number, pull);
  return pull;
}

function shortRef(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function createPull(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.json();
  const title = str(body.title);
  const head = shortRef(str(body.head));
  const base = shortRef(str(body.base)) || repo.defaultBranch;
  if (title === '') throw new ApiError(422, 'Title is required');
  if (head === '') throw new ApiError(422, 'Head is required');
  const headTip = branchTipCommit(repo, head);
  const baseTip = branchTipCommit(repo, base);
  if (headTip === null) throw new ApiError(422, `Head branch '${head}' does not exist`);
  if (baseTip === null) throw new ApiError(422, `Base branch '${base}' does not exist`);
  if (headTip === baseTip) throw new ApiError(422, 'No commits between base and head');
  for (const record of repo.records.values()) {
    if (record.kind === 'pull' && record.state === 'open' && record.headRef === head && record.baseRef === base) {
      throw new ApiError(422, 'A pull request already exists for this head and base');
    }
  }
  const pull = createPullRecord(repo, { title, body: str(body.body), head, base });
  ctx.send(201, pullJson(ctx, repo, pull));
}

function listPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let pulls = [...repo.records.values()].filter((record): record is PullRec => record.kind === 'pull');
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(ctx, pulls.map((pull) => pullJson(ctx, repo, pull)));
  ctx.send(200, page.items, page.headers);
}

/** Merge a pull request; shared by the REST route, GraphQL and MCP. */
export function mergePullRecord(repo: RepoRec, pull: PullRec, method: string): { sha: string } {
  if (pull.state !== 'open' || pull.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  const baseTip = branchTipCommit(repo, pull.baseRef);
  const headTip = branchTipCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const mb = mergeBase(baseTip, headTip);
  if (mb === null) throw new ApiError(405, 'Pull Request has no common ancestor with its base');
  const merged = mergeFlat(
    flattenTree(commitTreeOid(mb)),
    flattenTree(commitTreeOid(baseTip)),
    flattenTree(commitTreeOid(headTip)),
  );
  if (merged === null) throw new ApiError(405, 'Merge conflict: this branch cannot be merged');
  const tree = treeFromFlat(merged);
  let sha: string;
  if (method === 'merge') {
    sha = createCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
  } else {
    sha = createCommit(tree, [baseTip], `${pull.title} (#${pull.number})`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return { sha };
}

function mergePullRoute(ctx: Ctx, repo: RepoRec, record: Record): void {
  if (record.kind !== 'pull') throw notFound('Pull Request not found');
  const body = ctx.body.length > 0 ? ctx.json() : {};
  const method = str(body.merge_method) || 'merge';
  const { sha } = mergePullRecord(repo, record, method);
  ctx.send(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// the router

export async function handleRest(ctx: Ctx): Promise<boolean> {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  if (!authed(ctx)) {
    ctx.send(401, { message: 'Bad credentials' });
    return true;
  }
  const rest = seg.slice(2);
  try {
    routeRest(ctx, rest);
  } catch (err) {
    if (err instanceof ApiError) ctx.send(err.status, { message: err.message });
    else throw err;
  }
  return true;
}

function routeRest(ctx: Ctx, rest: string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method !== 'GET') throw notFound();
    const origin = ctx.origin();
    ctx.send(
      200,
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
        user_repositories_url: `${origin}/api/v3/user/repos`,
        organization_url: `${origin}/api/v3/orgs/{org}`,
        emojis_url: `${origin}/api/v3/emojis`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    ctx.send(200, {
      verifiable_password_authentication: false,
      installed_version: 'liuli-forge/1.0.0',
      github_developer_experience: false,
    });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    ctx.send(200, userJson(VIEWER.login));
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const page = paginate(ctx, listReposOf(VIEWER.login).map((repo) => repoJson(ctx, repo)));
      ctx.send(200, page.items, page.headers);
      return;
    }
    if (method === 'POST') {
      createRepo(ctx);
      return;
    }
    throw notFound();
  }
  if (rest[0] !== 'repos' || rest.length < 3) throw notFound();
  const owner = rest[1] as string;
  const name = rest[2] as string;
  const tail = rest.slice(3);
  const repo = mustRepo(owner, name);

  if (tail.length === 0) {
    if (method === 'GET') ctx.send(200, repoJson(ctx, repo));
    else if (method === 'PATCH') patchRepo(ctx, repo);
    else if (method === 'DELETE') {
      deleteRepoRec(owner, name);
      ctx.res.writeHead(204, { 'x-github-request-id': 'liuli-del' });
      ctx.res.end();
    } else throw notFound();
    return;
  }
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') return listBranches(ctx, repo);
    if (tail.length >= 2 && method === 'GET') return getBranch(ctx, repo, tail.slice(1).join('/'));
    throw notFound();
  }
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') throw notFound();
    return listCommits(ctx, repo);
  }
  if (tail[0] === 'contents') {
    const parts = tail.slice(1);
    if (method === 'GET') return getContents(ctx, repo, parts);
    if (method === 'PUT') return putContents(ctx, repo, parts);
    if (method === 'DELETE') return deleteContents(ctx, repo, parts);
    throw notFound();
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'POST') return createRef(ctx, repo);
      if (method === 'GET') return listRefs(ctx, repo);
      throw notFound();
    }
    if (method === 'GET') return getRef(ctx, repo, tail.slice(2));
    throw notFound();
  }
  if (tail[0] === 'labels') {
    if (tail.length === 1) {
      if (method === 'POST') return createLabel(ctx, repo);
      if (method === 'GET') {
        const page = paginate(ctx, [...repo.labels.values()].map((label) => labelJson(label)));
        ctx.send(200, page.items, page.headers);
        return;
      }
      throw notFound();
    }
    if (method === 'GET' && tail.length === 2) {
      const label = repo.labels.get(tail[1] as string);
      if (!label) throw notFound('Label not found');
      ctx.send(200, labelJson(label));
      return;
    }
    throw notFound();
  }
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      throw notFound();
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) throw notFound();
    const record = mustRecord(repo, number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (record.kind !== 'issue') throw notFound('Issue not found');
        ctx.send(200, issueJson(ctx, repo, record));
        return;
      }
      if (method === 'PATCH') return patchIssue(ctx, repo, record);
      throw notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') return createComment(ctx, repo, record);
      if (method === 'GET') return listComments(ctx, repo, record);
      throw notFound();
    }
    throw notFound();
  }
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      throw notFound();
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) throw notFound();
    const record = repo.records.get(number);
    if (tail.length === 2) {
      if (!record || record.kind !== 'pull') throw notFound('Pull Request not found');
      if (method === 'GET') {
        ctx.send(200, pullJson(ctx, repo, record));
        return;
      }
      throw notFound();
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (!record) throw notFound('Pull Request not found');
      return mergePullRoute(ctx, repo, record);
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!record || record.kind !== 'pull') throw notFound('Pull Request not found');
      const { files } = pullDiff(repo, record);
      const page = paginate(
        ctx,
        files.map((file) => ({
          sha: file.sha ?? '',
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
      );
      ctx.send(200, page.items, page.headers);
      return;
    }
    throw notFound();
  }
  throw notFound();
}
