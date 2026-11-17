// The GraphQL v4 surface: a small lexer, parser and executor for the
// document shapes gh and github-mcp-server send, resolved over the same store
// the REST and git surfaces use. Global ids are the forge's base64
// `Type:dbId` strings, so node(id:) round-trips and ids are stable and
// opaque. Unknown fields answer 200 with an errors array, as GitHub does.

import {
  VIEWER,
  branchTipCommit,
  commitTreeOid,
  diffFlat,
  flattenTree,
  getRepoRec,
  listReposOf,
  mergeBase,
  mergeFlat,
  newComment,
  nowIso,
  refTip,
  type IssueRec,
  type PullRec,
  type Record,
  type RepoRec,
} from './forge.ts';
import { ApiError, authed, type Ctx } from './http.ts';
import { createIssueRecord, createPullRecord, globalId, mergePullRecord } from './rest.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`invalid number ${text}`);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: Value }[] {
    const args: { name: string; value: Value }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.expectName();
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      let args: { name: string; value: Value }[] = [];
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }
}

// ---------------------------------------------------------------------------
// values and ids

function valueOf(value: Value, variables: Json): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Json = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function decodeGlobalId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { type: match[1] as string, dbId: Number.parseInt(match[2] as string, 10) };
  } catch {
    return null;
  }
}

function allRepos(): RepoRec[] {
  return listReposOf(VIEWER.login);
}

function repoByDbId(dbId: number): RepoRec | null {
  return allRepos().find((repo) => repo.id === dbId) ?? null;
}

function recordByDbId(dbId: number): { repo: RepoRec; record: Record } | null {
  for (const repo of allRepos()) {
    for (const record of repo.records.values()) {
      if (record.dbId === dbId) return { repo, record };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// schema

/** A value in the graph: a tagged record the executor completes by type. */
interface GObj {
  __typename: string;
  [key: string]: unknown;
}

function gobj(typename: string, fields: Json): GObj {
  return { __typename: typename, ...fields };
}

const userObj = (login: string): GObj => gobj('User', { login });
const repoObj = (repo: RepoRec): GObj => gobj('Repository', { repo });
const issueObj = (repo: RepoRec, issue: IssueRec): GObj => gobj('Issue', { repo, record: issue });
const pullObj = (repo: RepoRec, pull: PullRec): GObj => gobj('PullRequest', { repo, record: pull });

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(after, 'base64').toString('utf8'));
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

interface Connection {
  items: GObj[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function connect(items: GObj[], args: Json): Connection {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const start = indexOfCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  return {
    items: slice,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
  };
}

function pullMergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  const baseTip = branchTipCommit(repo, pull.baseRef);
  const headTip = branchTipCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const mb = mergeBase(baseTip, headTip);
  if (mb === null) return 'UNKNOWN';
  const merged = mergeFlat(flattenTree(commitTreeOid(mb)), flattenTree(commitTreeOid(baseTip)), flattenTree(commitTreeOid(headTip)));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'url', 'homepageUrl',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'createdAt',
    'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'labels', 'primaryLanguage', 'licenseInfo', 'isArchived', 'isDisabled', 'visibility',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'titleHTML', 'body', 'bodyText', 'bodyHTML', 'state', 'stateReason',
    'url', 'author', 'editor', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked',
    'assignees', 'milestone', 'repository', 'viewerDidAuthor', 'reactionGroups', 'participants',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'state', 'merged', 'mergedAt', 'mergedBy',
    'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository',
    'files', 'commits', 'comments', 'url', 'author', 'createdAt', 'updatedAt', 'closedAt', 'closed',
    'additions', 'deletions', 'changedFiles', 'mergeCommit', 'labels', 'isDraft', 'reviewDecision',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

type Resolver = (parent: GObj, args: Json) => unknown;

const SCHEMA: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER.login),
    repository: (_parent, args) => {
      const repo = getRepoRec(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    },
    node: (_parent, args) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = repoByDbId(decoded.dbId);
        return repo ? repoObj(repo) : null;
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const found = recordByDbId(decoded.dbId);
        if (!found) return null;
        return found.record.kind === 'issue' ? issueObj(found.repo, found.record) : pullObj(found.repo, found.record as PullRec);
      }
      if (decoded.type === 'User') return userObj(VIEWER.login);
      return null;
    },
    user: (_parent, args) => userObj(String(args.login ?? VIEWER.login)),
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name]) return gobj('__Type', { name, kind: 'OBJECT' });
      if (ENUM_VALUES[name]) return gobj('__Type', { name, kind: 'ENUM' });
      return null;
    },
    __schema: () => gobj('__Schema', {}),
  },
  Mutation: {
    createIssue: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? repoByDbId(decoded.dbId) : null;
      if (!repo) throw new Error('repository not found');
      const issue = createIssueRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return gobj('CreateIssuePayload', { issue: issueObj(repo, issue) });
    },
    closeIssue: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded ? recordByDbId(decoded.dbId) : null;
      if (!found || found.record.kind !== 'issue') throw new Error('issue not found');
      found.record.state = 'closed';
      found.record.updatedAt = nowIso();
      return gobj('CloseIssuePayload', { issue: issueObj(found.repo, found.record) });
    },
    reopenIssue: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded ? recordByDbId(decoded.dbId) : null;
      if (!found || found.record.kind !== 'issue') throw new Error('issue not found');
      found.record.state = 'open';
      found.record.updatedAt = nowIso();
      return gobj('ReopenIssuePayload', { issue: issueObj(found.repo, found.record) });
    },
    createPullRequest: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? repoByDbId(decoded.dbId) : null;
      if (!repo) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      if (branchTipCommit(repo, head) === null) throw new Error(`head branch ${head} not found`);
      if (branchTipCommit(repo, base) === null) throw new Error(`base branch ${base} not found`);
      const pull = createPullRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), head, base });
      return gobj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    },
    mergePullRequest: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded ? recordByDbId(decoded.dbId) : null;
      if (!found || found.record.kind !== 'pull') throw new Error('pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      mergePullRecord(found.repo, found.record, method === 'merge' ? 'merge' : 'squash');
      return gobj('MergePullRequestPayload', { pullRequest: pullObj(found.repo, found.record) });
    },
    addComment: (_parent, args) => {
      const input = (args.input ?? {}) as Json;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const found = decoded ? recordByDbId(decoded.dbId) : null;
      if (!found) throw new Error('subject not found');
      const comment = newComment(String(input.body ?? ''));
      found.record.comments.push(comment);
      found.record.updatedAt = nowIso();
      const node = gobj('IssueComment', { idNum: comment.id, body: comment.body });
      return gobj('AddCommentPayload', { commentEdge: gobj('IssueCommentEdge', { node }) });
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: (parent) => parent.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `/${VIEWER.login}`,
    avatarUrl: () => '',
    isViewer: (parent) => parent.login === VIEWER.login,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
  },
  Repository: {
    id: (parent) => globalId('Repository', (parent.repo as RepoRec).id),
    databaseId: (parent) => (parent.repo as RepoRec).id,
    name: (parent) => (parent.repo as RepoRec).name,
    nameWithOwner: (parent) => `${(parent.repo as RepoRec).owner}/${(parent.repo as RepoRec).name}`,
    owner: (parent) => userObj((parent.repo as RepoRec).owner),
    description: (parent) => (parent.repo as RepoRec).description || null,
    isPrivate: (parent) => (parent.repo as RepoRec).isPrivate,
    isFork: () => false,
    url: (parent) => `/${(parent.repo as RepoRec).owner}/${(parent.repo as RepoRec).name}`,
    homepageUrl: () => null,
    defaultBranchRef: (parent) => {
      const repo = parent.repo as RepoRec;
      if (refTip(repo, repo.defaultBranch) === null) return null;
      return gobj('Ref', { name: repo.defaultBranch, repo });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    createdAt: (parent) => (parent.repo as RepoRec).createdAt,
    updatedAt: (parent) => (parent.repo as RepoRec).updatedAt,
    pushedAt: (parent) => (parent.repo as RepoRec).updatedAt,
    stargazerCount: () => 0,
    forkCount: () => 0,
    isArchived: () => false,
    isDisabled: () => false,
    visibility: (parent) => ((parent.repo as RepoRec).isPrivate ? 'PRIVATE' : 'PUBLIC'),
    primaryLanguage: () => null,
    licenseInfo: () => null,
    issue: (parent, args) => {
      const repo = parent.repo as RepoRec;
      const record = repo.records.get(Number(args.number));
      return record && record.kind === 'issue' ? issueObj(repo, record) : null;
    },
    issues: (parent, args) => {
      const repo = parent.repo as RepoRec;
      let issues = [...repo.records.values()].filter((record): record is IssueRec => record.kind === 'issue');
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? null) as Json | null;
      const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      const field = orderBy && typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
      issues.sort((a, b) => {
        let cmp = 0;
        if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
        else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
        else cmp = a.number - b.number;
        return direction === 'ASC' ? cmp : -cmp;
      });
      const connection = connect(issues.map((issue) => issueObj(repo, issue)), args);
      return gobj('IssueConnection', { connection });
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as RepoRec;
      const record = repo.records.get(Number(args.number));
      return record && record.kind === 'pull' ? pullObj(repo, record) : null;
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as RepoRec;
      let pulls = [...repo.records.values()].filter((record): record is PullRec => record.kind === 'pull');
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
      pulls = pulls.filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
        return states.includes(state);
      });
      pulls.sort((a, b) => b.number - a.number);
      const connection = connect(pulls.map((pull) => pullObj(repo, pull)), args);
      return gobj('PullRequestConnection', { connection });
    },
    labels: (parent) => {
      const repo = parent.repo as RepoRec;
      const connection = connect(
        [...repo.labels.values()].map((label) => gobj('Label', { idNum: label.id, name: label.name, color: label.color, description: label.description })),
        {},
      );
      return gobj('LabelConnection', { connection });
    },
  },
  Issue: {
    id: (parent) => globalId('Issue', (parent.record as IssueRec).dbId),
    databaseId: (parent) => (parent.record as IssueRec).dbId,
    number: (parent) => (parent.record as IssueRec).number,
    title: (parent) => (parent.record as IssueRec).title,
    titleHTML: (parent) => (parent.record as IssueRec).title,
    body: (parent) => (parent.record as IssueRec).body,
    bodyText: (parent) => (parent.record as IssueRec).body,
    bodyHTML: (parent) => (parent.record as IssueRec).body,
    state: (parent) => (parent.record as IssueRec).state.toUpperCase(),
    stateReason: () => null,
    url: (parent) => `/${(parent.repo as RepoRec).owner}/${(parent.repo as RepoRec).name}/issues/${(parent.record as IssueRec).number}`,
    author: () => userObj(VIEWER.login),
    editor: () => null,
    labels: (parent) => {
      const repo = parent.repo as RepoRec;
      const issue = parent.record as IssueRec;
      const connection = connect(
        issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return gobj('Label', { idNum: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: label?.description ?? null });
        }),
        {},
      );
      return gobj('LabelConnection', { connection });
    },
    comments: (parent) => {
      const issue = parent.record as IssueRec;
      const connection = connect(
        issue.comments.map((comment) => gobj('IssueComment', { idNum: comment.id, body: comment.body })),
        {},
      );
      return gobj('IssueCommentConnection', { connection });
    },
    createdAt: (parent) => (parent.record as IssueRec).createdAt,
    updatedAt: (parent) => (parent.record as IssueRec).updatedAt,
    closedAt: (parent) => ((parent.record as IssueRec).state === 'closed' ? (parent.record as IssueRec).updatedAt : null),
    closed: (parent) => (parent.record as IssueRec).state === 'closed',
    locked: () => false,
    assignees: () => gobj('UserConnection', { connection: connect([], {}) }),
    milestone: () => null,
    repository: (parent) => repoObj(parent.repo as RepoRec),
    viewerDidAuthor: () => true,
    reactionGroups: () => [],
    participants: () => gobj('UserConnection', { connection: connect([], {}) }),
  },
  PullRequest: {
    id: (parent) => globalId('PullRequest', (parent.record as PullRec).dbId),
    databaseId: (parent) => (parent.record as PullRec).dbId,
    number: (parent) => (parent.record as PullRec).number,
    title: (parent) => (parent.record as PullRec).title,
    body: (parent) => (parent.record as PullRec).body,
    bodyHTML: (parent) => (parent.record as PullRec).body,
    state: (parent) => {
      const pull = parent.record as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (parent) => (parent.record as PullRec).merged,
    mergedAt: (parent) => (parent.record as PullRec).mergedAt,
    mergedBy: (parent) => ((parent.record as PullRec).merged ? userObj(VIEWER.login) : null),
    mergeable: (parent) => pullMergeable(parent.repo as RepoRec, parent.record as PullRec),
    headRefName: (parent) => (parent.record as PullRec).headRef,
    baseRefName: (parent) => (parent.record as PullRec).baseRef,
    headRef: (parent) => {
      const repo = parent.repo as RepoRec;
      const pull = parent.record as PullRec;
      return refTip(repo, pull.headRef) === null ? null : gobj('Ref', { name: pull.headRef, repo });
    },
    baseRef: (parent) => {
      const repo = parent.repo as RepoRec;
      const pull = parent.record as PullRec;
      return refTip(repo, pull.baseRef) === null ? null : gobj('Ref', { name: pull.baseRef, repo });
    },
    headRepository: (parent) => repoObj(parent.repo as RepoRec),
    baseRepository: (parent) => repoObj(parent.repo as RepoRec),
    files: (parent, args) => {
      const repo = parent.repo as RepoRec;
      const pull = parent.record as PullRec;
      const headTip = branchTipCommit(repo, pull.headRef);
      const baseTip = branchTipCommit(repo, pull.baseRef);
      let files: ReturnType<typeof diffFlat> = [];
      if (headTip !== null && baseTip !== null) {
        const mb = mergeBase(baseTip, headTip);
        files = diffFlat(flattenTree(mb === null ? null : commitTreeOid(mb)), flattenTree(commitTreeOid(headTip)));
      }
      const connection = connect(
        files.map((file) =>
          gobj('PullRequestChangedFile', {
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }),
        ),
        args,
      );
      return gobj('PullRequestChangedFileConnection', { connection });
    },
    commits: () => gobj('PullRequestCommitConnection', { connection: connect([], {}) }),
    comments: (parent) => {
      const pull = parent.record as PullRec;
      const connection = connect(pull.comments.map((comment) => gobj('IssueComment', { idNum: comment.id, body: comment.body })), {});
      return gobj('IssueCommentConnection', { connection });
    },
    url: (parent) => `/${(parent.repo as RepoRec).owner}/${(parent.repo as RepoRec).name}/pull/${(parent.record as PullRec).number}`,
    author: () => userObj(VIEWER.login),
    createdAt: (parent) => (parent.record as PullRec).createdAt,
    updatedAt: (parent) => (parent.record as PullRec).updatedAt,
    closedAt: (parent) => ((parent.record as PullRec).state === 'closed' ? (parent.record as PullRec).updatedAt : null),
    closed: (parent) => (parent.record as PullRec).state === 'closed',
    additions: (parent) => (parent as unknown as { _additions?: number })._additions ?? 0,
    deletions: () => 0,
    changedFiles: () => 0,
    mergeCommit: (parent) => {
      const pull = parent.record as PullRec;
      return pull.mergeCommitSha ? gobj('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    labels: () => gobj('LabelConnection', { connection: connect([], {}) }),
    isDraft: () => false,
    reviewDecision: () => null,
  },
  Ref: {
    id: (parent) => globalId('Ref', 0) + String(parent.name ?? ''),
    name: (parent) => parent.name,
    prefix: () => 'refs/heads/',
    target: (parent) => {
      const repo = parent.repo as RepoRec | undefined;
      const tip = repo ? refTip(repo, String(parent.name ?? '')) : null;
      return tip ? gobj('Commit', { oid: tip }) : null;
    },
    repository: (parent) => (parent.repo ? repoObj(parent.repo as RepoRec) : null),
  },
  Commit: {
    oid: (parent) => parent.oid,
    id: (parent) => globalId('Commit', 0) + String(parent.oid ?? '').slice(0, 8),
  },
  IssueComment: {
    id: (parent) => globalId('IssueComment', Number(parent.idNum ?? 0)),
    databaseId: (parent) => Number(parent.idNum ?? 0),
    body: (parent) => parent.body,
    bodyText: (parent) => parent.body,
    author: () => userObj(VIEWER.login),
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    url: () => '',
    issue: () => null,
  },
  Label: {
    id: (parent) => globalId('Label', Number(parent.idNum ?? 0)),
    name: (parent) => parent.name,
    color: (parent) => parent.color,
    description: (parent) => parent.description ?? null,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },
  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    description: () => null,
    fields: (parent) => {
      const fields = TYPE_FIELDS[String(parent.name)];
      return fields ? fields.map((name) => gobj('__Field', { name })) : null;
    },
    enumValues: (parent) => {
      const values = ENUM_VALUES[String(parent.name)];
      return values ? values.map((name) => gobj('__EnumValue', { name })) : null;
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
    isOneOf: () => false,
  },
  __Field: {
    name: (parent) => parent.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (parent) => parent.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => [],
    queryType: () => gobj('__Type', { name: 'Query', kind: 'OBJECT' }),
    mutationType: () => gobj('__Type', { name: 'Mutation', kind: 'OBJECT' }),
    subscriptionType: () => null,
    directives: () => [],
  },
};

// Connection types resolve through their `connection` payload.
for (const typeName of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'IssueCommentConnection', 'LabelConnection', 'UserConnection', 'PullRequestCommitConnection']) {
  SCHEMA[typeName] = {
    nodes: (parent) => (parent.connection as Connection).items,
    edges: (parent) =>
      (parent.connection as Connection).items.map((node) => gobj('Edge', { node, cursor: (parent.connection as Connection).endCursor ?? '' })),
    pageInfo: (parent) => {
      const connection = parent.connection as Connection;
      return gobj('PageInfo', { hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: connection.endCursor });
    },
    totalCount: (parent) => (parent.connection as Connection).totalCount,
  };
}
SCHEMA.Edge = { node: (parent) => parent.node, cursor: (parent) => parent.cursor };
SCHEMA.PageInfo = {
  hasNextPage: (parent) => parent.hasNextPage,
  hasPreviousPage: (parent) => parent.hasPreviousPage,
  startCursor: (parent) => parent.startCursor,
  endCursor: (parent) => parent.endCursor,
};
// Mutation payloads expose their single object field.
for (const [typeName, field] of [
  ['CreateIssuePayload', 'issue'],
  ['CloseIssuePayload', 'issue'],
  ['ReopenIssuePayload', 'issue'],
  ['CreatePullRequestPayload', 'pullRequest'],
  ['MergePullRequestPayload', 'pullRequest'],
] as const) {
  SCHEMA[typeName] = { [field]: (parent) => parent[field], clientMutationId: () => null };
}
SCHEMA.AddCommentPayload = { commentEdge: (parent) => parent.commentEdge, clientMutationId: () => null };
SCHEMA.IssueCommentEdge = { node: (parent) => parent.node, cursor: () => cursorOf(0) };

// ---------------------------------------------------------------------------
// executor

interface ExecState {
  doc: DocumentNode;
  variables: Json;
  errors: { message: string }[];
}

function collectFields(state: ExecState, typeName: string, selections: SelectionNode[]): FieldNode[] {
  const out: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        out.push(...collectFields(state, typeName, selection.selectionSet));
      }
    } else {
      const fragment = state.doc.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === typeName) {
        out.push(...collectFields(state, typeName, fragment.selectionSet));
      }
    }
  }
  return out;
}

function completeValue(state: ExecState, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(state, item, selectionSet));
  if (typeof value === 'object') {
    const obj = value as GObj;
    if (typeof obj.__typename === 'string') {
      if (!selectionSet) return null;
      return executeSelectionSet(state, obj, selectionSet);
    }
    return value;
  }
  return value;
}

function executeSelectionSet(state: ExecState, parent: GObj, selections: SelectionNode[]): Json {
  const typeName = parent.__typename;
  const out: Json = {};
  for (const field of collectFields(state, typeName, selections)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const typeResolvers = SCHEMA[typeName];
    const resolver = typeResolvers?.[field.name];
    if (!resolver) {
      state.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Json = {};
    for (const arg of field.args) args[arg.name] = valueOf(arg.value, state.variables);
    try {
      const value = resolver(parent, args);
      out[key] = completeValue(state, value, field.selectionSet);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function runOperation(doc: DocumentNode, operationName: string | undefined, variables: Json): Json {
  const operation = doc.operations.find((op) => operationName === undefined || op.name === operationName) ?? doc.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in the document' }] };
  const state: ExecState = { doc, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(state, gobj(rootType, {}), operation.selectionSet);
  const out: Json = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

// ---------------------------------------------------------------------------
// the route

export async function handleGraphql(ctx: Ctx): Promise<boolean> {
  if (ctx.segments[0] !== 'api' || ctx.segments[1] !== 'graphql') return false;
  if (ctx.method !== 'POST') {
    ctx.send(404, { message: 'Not Found' });
    return true;
  }
  if (!authed(ctx)) {
    ctx.send(401, { message: 'Bad credentials' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.send(400, { errors: [{ message: 'the request body is not valid JSON' }] });
    return true;
  }
  const runOne = (entry: unknown): Json => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'each operation must be an object' }] };
    const record = entry as Json;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Json;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    try {
      const doc = new Parser(lex(query)).parseDocument();
      return runOperation(doc, operationName, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    ctx.send(200, body.map(runOne));
    return true;
  }
  const result = runOne(body);
  ctx.send(200, result);
  return true;
}

// ApiError is re-exported for callers that map resolver failures themselves.
export { ApiError };
