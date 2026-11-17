// The forge's store: one content-addressed git object store shared by every
// repository, per-repository refs, and the issue / pull / label / comment
// records the REST, GraphQL and MCP surfaces all read and write.
//
// Everything is in memory (a trial is one process with a fresh store) and
// every timestamp comes from a logical clock, so two runs that receive the
// same requests produce the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// identities (the contest scenario's fixed users; the bearer token's owner
// is the viewer, every other login is an empty namespace)

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------------------
// the logical clock: 2025-01-01T00:00:00Z plus one second per stamp

const EPOCH_SEC = 1_735_689_600;
let tickCount = 0;

export function tickSec(): number {
  tickCount += 1;
  return EPOCH_SEC + tickCount;
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

export function nowIso(): string {
  return isoOf(tickSec());
}

// ---------------------------------------------------------------------------
// git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  readonly type: ObjType;
  readonly data: Buffer;
}

const objects = new Map<string, GitObj>();

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObj | undefined {
  return objects.get(oid);
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

export function objectCount(): number {
  return objects.size;
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(entries: readonly TreeEntry[]): string {
  return storeObject('tree', buildTreeData(entries));
}

/** One level of a tree as a name -> entry map (empty map for no tree). */
export function treeLevel(treeOid: string | null): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (treeOid === null) return map;
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return map;
  for (const entry of parseTree(obj.data)) map.set(entry.name, entry);
  return map;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (and submodule) under a tree, by full path. */
export function flattenTree(treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string | null, prefix: string): void => {
    for (const entry of treeLevel(oid).values()) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Set (or, with oid null, delete) the file at `parts` under a tree; returns
 * the new tree's id. Intermediate trees are created as needed and emptied
 * directories are pruned, as git does.
 */
export function setTreePath(treeOid: string | null, parts: readonly string[], mode: string, oid: string | null): string {
  const level = treeLevel(treeOid);
  const [head, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) {
    if (oid === null) level.delete(head);
    else level.set(head, { mode, name: head, oid });
  } else {
    const existing = level.get(head);
    const sub = existing && existing.mode === '40000' ? existing.oid : null;
    const newSub = setTreePath(sub, rest, mode, oid);
    if (newSub === EMPTY_TREE_OID) level.delete(head);
    else level.set(head, { mode: '40000', name: head, oid: newSub });
  }
  return storeTree([...level.values()]);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const header = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function getCommit(oid: string): CommitView | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

export function commitTreeOid(oid: string): string | null {
  const commit = getCommit(oid);
  return commit ? commit.tree : null;
}

/** The author/committer line every forge-made commit carries. */
export function forgeIdent(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

export function createCommit(treeOid: string, parents: readonly string[], message: string): string {
  const ident = forgeIdent(tickSec());
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const header = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel a ref target through tag objects to the commit it names (or null). */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel one tag layer: the object a tag names, or null when `oid` is no tag. */
export function peelTag(oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object reachable from `tips` (commits walk to trees and parents). */
export function closure(tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** The commit ancestors of `tip` (itself included), parents only. */
export function commitAncestors(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(oid);
    if (!commit) continue;
    seen.add(oid);
    stack.push(...commit.parents);
  }
  return seen;
}

export function isAncestor(ancestor: string, tip: string): boolean {
  return commitAncestors(tip).has(ancestor);
}

/** A best common ancestor of two commits, or null when they share none. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsA = commitAncestors(a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(oid);
    if (commit) queue.push(...commit.parents);
  }
  return null;
}

/**
 * The objects a fetch of `wants` must carry: the closure of the wants,
 * bounded by `depth` commit generations when `depth` is set, minus the
 * closure of `haves`. Also returns the shallow boundary (commits included
 * whose parents were left out) when a depth applies.
 */
export function fetchSet(
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
): { objects: Set<string>; boundary: string[] } {
  const haveSet = haves.length > 0 ? closure(haves) : new Set<string>();
  const out = new Set<string>();
  const boundary: string[] = [];
  const addClosure = (tip: string): void => {
    for (const oid of closure([tip])) if (!haveSet.has(oid)) out.add(oid);
  };
  if (depth === null) {
    for (const want of wants) addClosure(want);
    return { objects: out, boundary };
  }
  // Shallow: a "have" in a shallow fetch is a commit the client holds WITHOUT
  // its ancestry (that is what shallow means), so the exclusion set is the
  // have commits plus their tree closures — never their parents. Expanding
  // haves by full closure here would wrongly swallow the very parents a
  // deepen request exists to deliver.
  const shallowHaveSet = new Set<string>();
  const addTreeClosure = (oid: string): void => {
    if (shallowHaveSet.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    shallowHaveSet.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addTreeClosure(entry.oid);
    }
  };
  for (const have of haves) {
    shallowHaveSet.add(have);
    const commit = getCommit(have);
    if (commit) addTreeClosure(commit.tree);
  }
  const haveSetShallow = shallowHaveSet;
  // Shallow: walk commits by generation from each want (peeling tags).
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const addWithTrees = (oid: string): void => {
    const obj = objects.get(oid);
    if (!obj) return;
    if (!haveSetShallow.has(oid)) out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addWithTrees(entry.oid);
    }
  };
  for (const want of wants) {
    let current = want;
    // include any tag chain in full, then start counting at the commit
    for (;;) {
      const obj = objects.get(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        if (!haveSetShallow.has(current)) out.add(current);
        current = parseTag(obj.data).object;
        continue;
      }
      break;
    }
    if (getCommit(current) !== null) queue.push({ oid: current, gen: 0 });
    else if (objects.has(current)) addWithTrees(current);
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    generations.set(oid, gen);
    const commit = getCommit(oid);
    if (!commit) continue;
    if (!haveSetShallow.has(oid)) out.add(oid);
    addWithTrees(commit.tree);
    if (gen + 1 < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    } else if (commit.parents.length > 0) {
      boundary.push(oid);
    }
  }
  return { objects: out, boundary };
}

// ---------------------------------------------------------------------------
// packfiles

const PACK_TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Built packs, memoised by their object set: a pack is a pure function of the
 * objects it carries, so concurrent clones of the same tip all stream the
 * first build's bytes instead of each paying the deflate cost again. The
 * cache is bounded and simply cleared when full.
 */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 32;

/** A version-2 pack of full (never delta) objects, with its SHA-1 trailer. */
export function buildPack(oids: Iterable<string>): Buffer {
  const key = createHash('sha1').update([...oids].sort().join(' ')).digest('hex');
  const cached = packCache.get(key);
  if (cached) return cached;
  const pack = buildPackUncached(oids);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function buildPackUncached(oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = objects.get(oid);
    if (!obj) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream at `offset`; returns the bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  /** Every object the pack carried, resolved and stored. */
  oids: string[];
}

/**
 * Read a pack into the object store, resolving OFS/REF deltas (a REF_DELTA
 * base may already be in the store). Throws on any structural problem; the
 * caller turns that into an `unpack` failure and applies no ref update.
 */
export function readPackIntoStore(pack: Buffer): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: ObjType; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        base = (base + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error(`pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid as string);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = objects.get(entry.baseOid as string);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = storeObject(type, data);
    entry.resolved = { type, data, oid };
    byOid.set(oid, entry);
    return entry.resolved;
  };
  const oids: string[] = [];
  for (const entry of raw) oids.push(resolve(entry).oid);
  return { oids };
}

// ---------------------------------------------------------------------------
// repositories and records

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  dbId: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  kind: 'issue';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  kind: 'pull';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export type Record = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  records: Map<number, Record>;
  nextNumber: number;
  nextLabelId: number;
}

const reposByKey = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextDbId = 1;
let nextCommentDbId = 1;

export function allocDbId(): number {
  const id = nextDbId;
  nextDbId += 1;
  return id;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepoRec(owner: string, name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): RepoRec {
  const stamp = nowIso();
  const repo: RepoRec = {
    id: nextRepoId,
    owner,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: options.defaultBranch ?? 'main',
    createdAt: stamp,
    updatedAt: stamp,
    refs: new Map(),
    labels: new Map(),
    records: new Map(),
    nextNumber: 1,
    nextLabelId: 1,
  };
  nextRepoId += 1;
  reposByKey.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepoRec(owner: string, name: string): RepoRec | undefined {
  return reposByKey.get(repoKey(owner, name));
}

export function deleteRepoRec(owner: string, name: string): boolean {
  return reposByKey.delete(repoKey(owner, name));
}

export function listReposOf(owner: string): RepoRec[] {
  return [...reposByKey.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
}

/** The branch a ref name or short name resolves through, or null. */
export function refTip(repo: RepoRec, refOrBranch: string): string | null {
  const full = refOrBranch.startsWith('refs/') ? refOrBranch : `refs/heads/${refOrBranch}`;
  return repo.refs.get(full) ?? null;
}

/** The tip commit of a branch (peeling tags), or null when unborn/missing. */
export function branchTipCommit(repo: RepoRec, branch: string): string | null {
  const tip = refTip(repo, branch);
  return tip === null ? null : peelToCommit(tip);
}

/** The tree at a branch or commit, or null. */
export function treeAt(repo: RepoRec, refOrCommit: string): string | null {
  const asRef = refTip(repo, refOrCommit);
  const oid = asRef ?? (hasObject(refOrCommit) ? refOrCommit : null);
  if (oid === null) return null;
  const commit = peelToCommit(oid);
  return commit === null ? null : commitTreeOid(commit);
}

export function newComment(body: string): CommentRec {
  const stamp = nowIso();
  const rec: CommentRec = { id: nextCommentDbId, dbId: nextCommentDbId, body, user: VIEWER.login, createdAt: stamp, updatedAt: stamp };
  nextCommentDbId += 1;
  return rec;
}

// ---------------------------------------------------------------------------
// tree diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** Line-diff counts between two texts (LCS on lines; exact for small files). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) {
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

function blobText(oid: string | null): string {
  if (oid === null) return '';
  const obj = objects.get(oid);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

/** The file changes between two flat trees. */
export function diffFlat(base: Map<string, FlatEntry>, head: Map<string, FlatEntry>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      const { additions } = lineDiffCounts('', blobText(after.oid));
      changes.push({ path, status: 'added', additions, deletions: 0, changes: additions, sha: after.oid });
    } else if (before && !after) {
      const { deletions } = lineDiffCounts(blobText(before.oid), '');
      changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions, sha: before.oid });
    } else if (before && after) {
      const { additions, deletions } = lineDiffCounts(blobText(before.oid), blobText(after.oid));
      changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions, sha: after.oid });
    }
  }
  return changes;
}

/**
 * A file-level three-way merge of flat trees. Returns the merged flat map,
 * or null when any path was changed on both sides in different ways.
 */
export function mergeFlat(
  base: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): Map<string, FlatEntry> | null {
  const merged = new Map<string, FlatEntry>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOid = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (sameOid(o, t)) {
      if (o) merged.set(path, o);
    } else if (sameOid(b, o)) {
      if (t) merged.set(path, t);
    } else if (sameOid(b, t)) {
      if (o) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

/** Build a tree from a flat path map (used by merges). */
export function treeFromFlat(flat: Map<string, FlatEntry>): string {
  let root: string | null = null;
  const paths = [...flat.keys()].sort();
  for (const path of paths) {
    const entry = flat.get(path) as FlatEntry;
    root = setTreePath(root, path.split('/'), entry.mode, entry.oid);
  }
  return root ?? storeTree([]);
}
