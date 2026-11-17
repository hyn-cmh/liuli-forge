// The HTTP front door: reads each request's body, then routes it to the git
// smart-HTTP surface, the REST API, GraphQL or MCP. /healthz answers without
// a token (the environment's boot check); everything else on the API and git
// surfaces requires the trial's bearer token when one is configured.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { getRepoRec } from './forge.ts';
import { advertiseV0, advertiseV2, receivePack, uploadPackV0, uploadPackV2 } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { ApiError, authed, makeCtx, type Ctx } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** The git smart-HTTP routes: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}. */
async function handleGit(ctx: Ctx): Promise<boolean> {
  const seg = ctx.segments;
  let action: string;
  if (seg.length === 3) {
    action = seg[2] as string;
    if (action !== 'git-upload-pack' && action !== 'git-receive-pack') return false;
  } else if (seg.length === 4 && seg[2] === 'info' && seg[3] === 'refs') {
    action = 'info/refs';
  } else {
    return false;
  }
  const [owner, repoSegment] = seg as [string, string];
  if (!repoSegment.endsWith('.git')) return false;
  if (!authed(ctx)) {
    ctx.send(401, { message: 'Bad credentials' });
    return true;
  }
  const repo = getRepoRec(owner, repoSegment.slice(0, -'.git'.length));
  if (!repo) {
    ctx.send(404, { message: 'Not Found' });
    return true;
  }
  try {
    if (action === 'info/refs') {
      const service = ctx.url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        ctx.send(400, { message: 'unknown service' });
        return true;
      }
      const version2 = ctx.req.headers['git-protocol'] === 'version=2';
      const body = version2 && service === 'git-upload-pack' ? advertiseV2(repo) : advertiseV0(repo, service);
      ctx.sendRaw(200, body, `application/x-${service}-advertisement`);
      return true;
    }
    if (action === 'git-upload-pack') {
      const version2 = ctx.req.headers['git-protocol'] === 'version=2';
      const out = version2 ? uploadPackV2(repo, ctx.body) : uploadPackV0(repo, ctx.body);
      ctx.sendRaw(200, out, 'application/x-git-upload-pack-result');
      return true;
    }
    const outcome = receivePack(repo, ctx.body);
    ctx.sendRaw(outcome.status, outcome.body, 'application/x-git-receive-pack-result');
    return true;
  } catch {
    // A malformed protocol exchange must not take the repository down with
    // it: answer 400 and keep serving (the repo-survives-errors check).
    if (!ctx.res.headersSent) ctx.send(400, { message: 'bad git protocol request' });
    return true;
  }
}

async function dispatch(ctx: Ctx): Promise<void> {
  if (ctx.url.pathname === '/healthz') {
    ctx.send(200, { ok: true });
    return;
  }
  try {
    if (await handleGit(ctx)) return;
    if (await handleRest(ctx)) return;
    if (await handleGraphql(ctx)) return;
    if (await handleMcp(ctx)) return;
    ctx.send(404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof ApiError) {
      if (!ctx.res.headersSent) ctx.send(err.status, { message: err.message });
      return;
    }
    if (!ctx.res.headersSent) ctx.send(500, { message: 'Internal Server Error' });
  }
}

/** Create the forge's HTTP server (not yet listening). */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json', 'x-github-request-id': 'liuli-big' });
        res.end(JSON.stringify({ message: 'request body too large' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ctx = makeCtx(req, res, url, body, process.env.MAKEFUN_SHOP_TOKEN ?? '');
      await dispatch(ctx);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': 'liuli-err' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      }
    });
  });
}
