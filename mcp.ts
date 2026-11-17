// The MCP endpoint at /mcp: JSON-RPC over HTTP for the agent-native surface.
// It speaks both protocol eras the rules accept — the modern server/discover
// revision and the legacy initialize handshake — and its six tools run on the
// same store as REST, so an object made here is the same object everywhere.

import { VIEWER, branchTipCommit, createRepoRec, getRepoRec } from './forge.ts';
import { authed, type Ctx } from './http.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
} from './rest.ts';

type Json = Record<string, unknown>;

const SERVER_INFO = { name: 'liuli-forge', version: '1.0.0' };
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: {} };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, Json>;
  run: (ctx: Ctx, args: Json) => unknown;
}

function str(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function mustRepo(args: Json) {
  const repo = getRepoRec(str(args, 'owner') || VIEWER.login, str(args, 'repo'));
  if (!repo) throw new Error(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (_ctx, args) => {
      const name = str(args, 'name');
      if (getRepoRec(VIEWER.login, name)) throw new Error(`repository ${VIEWER.login}/${name} already exists`);
      const repo = createRepoRec(VIEWER.login, name, {
        description: str(args, 'description'),
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return repoJson(_ctx, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    run: (ctx, args) => repoJson(ctx, mustRepo(args)),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (ctx, args) => {
      const repo = mustRepo(args);
      const issue = createIssueRecord(repo, { title: str(args, 'title'), body: str(args, 'body') });
      return issueJson(ctx, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (ctx, args) => {
      const repo = mustRepo(args);
      const state = str(args, 'state') || 'open';
      let issues = [...repo.records.values()].filter((record) => record.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return issues.map((issue) => issueJson(ctx, repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
    },
    run: (ctx, args) => {
      const repo = mustRepo(args);
      const head = str(args, 'head');
      const base = str(args, 'base') || repo.defaultBranch;
      if (branchTipCommit(repo, head) === null) throw new Error(`head branch ${head} not found`);
      if (branchTipCommit(repo, base) === null) throw new Error(`base branch ${base} not found`);
      const pull = createPullRecord(repo, { title: str(args, 'title'), body: str(args, 'body'), head, base });
      return pullJson(ctx, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    run: (ctx, args) => {
      const repo = mustRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str(args, 'pull_number'), 10);
      const record = repo.records.get(number);
      if (!record || record.kind !== 'pull') throw new Error(`pull request #${number} not found`);
      mergePullRecord(repo, record, 'squash');
      return pullJson(ctx, repo, record);
    },
  },
];

/** The tools/list payload: a fixed literal so two answers are byte-identical. */
function toolsList(): Json[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  }));
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id as string | number | null, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } };
}

function discoverResult(): Json {
  return {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': REVISIONS[0],
      'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    },
    protocolVersion: REVISIONS[0],
    supportedVersions: REVISIONS,
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
  };
}

function handleRpc(ctx: Ctx, message: Json): Json | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = 'id' in message ? message.id : undefined;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Json;
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = REVISIONS.includes(offered) ? offered : '2025-03-26';
      return rpcResult(id, { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((entry) => entry.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      try {
        const value = tool.run(ctx, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.segments[0] !== 'mcp') return false;
  if (ctx.method !== 'POST') {
    ctx.send(404, { message: 'Not Found' });
    return true;
  }
  if (!authed(ctx)) {
    // The auth-required check reads this: a tools/call with no token is a 401.
    ctx.sendRaw(401, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } })), 'application/json');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.sendRaw(400, Buffer.from(JSON.stringify(rpcError(null, -32700, 'parse error: the body is not valid JSON'))), 'application/json');
    return true;
  }
  if (Array.isArray(parsed)) {
    const out: Json[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const answer = handleRpc(ctx, entry as Json);
        if (answer) out.push(answer);
      }
    }
    ctx.sendRaw(200, Buffer.from(JSON.stringify(out)), 'application/json');
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    ctx.sendRaw(400, Buffer.from(JSON.stringify(rpcError(null, -32600, 'invalid request'))), 'application/json');
    return true;
  }
  const answer = handleRpc(ctx, parsed as Json);
  if (answer === null) {
    ctx.res.writeHead(202, { 'x-github-request-id': 'liuli-mcp' });
    ctx.res.end();
    return true;
  }
  ctx.sendRaw(200, Buffer.from(JSON.stringify(answer)), 'application/json');
  return true;
}
