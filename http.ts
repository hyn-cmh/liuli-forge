// Shared HTTP plumbing for the forge's surfaces: the request context, the
// JSON reply discipline (application/json everywhere, a request id on every
// reply), and the ApiError the handlers throw to fail with a status.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

export function nextRequestId(): string {
  requestSeq += 1;
  return `liuli-${requestSeq.toString(16).padStart(8, '0')}`;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(what = 'Not Found'): ApiError {
  return new ApiError(404, what);
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  /** The decoded path segments of the request URL. */
  segments: string[];
  /** The raw request body. */
  body: Buffer;
  /** The bearer token the process was given ('' when unset). */
  token: string;
  /** The Authorization header's bearer token, or null when absent. */
  presentedToken: string | null;

  /** The request body parsed as JSON ({} for an empty body); 400 on junk. */
  json(): Record<string, unknown>;
  /** Answer with a JSON body and the forge's standard headers. */
  send(status: number, body: unknown, headers?: Readonly<Record<string, string>>): void;
  /** Answer with raw bytes (the git protocol's answers). */
  sendRaw(status: number, data: Buffer, contentType: string, headers?: Readonly<Record<string, string>>): void;
  /** This request's origin, for absolute URLs in bodies and Link headers. */
  origin(): string;
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, token: string): Ctx {
  const authorization = req.headers.authorization ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
  let parsedJson: Record<string, unknown> | undefined;
  const ctx: Ctx = {
    req,
    res,
    url,
    method: (req.method ?? 'GET').toUpperCase(),
    segments: url.pathname
      .split('/')
      .filter((piece) => piece !== '')
      .map((piece) => {
        try {
          return decodeURIComponent(piece);
        } catch {
          return piece;
        }
      }),
    body,
    token,
    presentedToken: presented,
    json(): Record<string, unknown> {
      if (parsedJson !== undefined) return parsedJson;
      if (body.length === 0) {
        parsedJson = {};
        return parsedJson;
      }
      try {
        const value = JSON.parse(body.toString('utf8')) as unknown;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ApiError(400, 'the request body is not a JSON object');
        }
        parsedJson = value as Record<string, unknown>;
        return parsedJson;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Malformed JSON in the request body');
      }
    },
    send(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): void {
      const text = `${JSON.stringify(value)}\n`;
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'content-length': Buffer.byteLength(text),
        'x-github-request-id': nextRequestId(),
        ...headers,
      });
      res.end(text);
    },
    sendRaw(status: number, data: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
      res.writeHead(status, {
        'content-type': contentType,
        'content-length': data.length,
        'x-github-request-id': nextRequestId(),
        ...headers,
      });
      res.end(data);
    },
    origin(): string {
      const host = req.headers.host ?? 'localhost';
      return `http://${host}`;
    },
  };
  return ctx;
}

/** Whether the request carries the process's bearer token. */
export function authed(ctx: Ctx): boolean {
  if (ctx.token === '') return true;
  return ctx.presentedToken === ctx.token;
}
