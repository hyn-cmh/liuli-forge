// The git smart-HTTP protocol: pkt-line framing, ref advertisements,
// protocol v2 ls-refs and fetch, protocol v0 fetch, and v0 receive-pack
// with report-status. Packs are built from full objects only; packs the
// client sends are read with delta resolution (forge.readPackIntoStore).

import {
  ZERO_OID,
  buildPack,
  closure,
  fetchSet,
  getCommit,
  getObject,
  hasObject,
  isAncestor,
  peelTag,
  peelToCommit,
  readPackIntoStore,
  type RepoRec,
} from './forge.ts';

// ---------------------------------------------------------------------------
// pkt-lines

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every packet in a fully buffered request body. Throws on junk. */
export function decodePackets(body: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`bad pkt-line length ${length}`);
    } else {
      if (offset + length > body.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: body.subarray(offset) };
}

function packetText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

// ---------------------------------------------------------------------------
// advertisements

export const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=liuli-forge/1.0';
export const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta quiet agent=liuli-forge/1.0';

function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Ref lines for a v0 advertisement / ls-refs, in git's order. */
function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

function peeledLine(repo: RepoRec, name: string, oid: string): string | null {
  const peeled = peelTag(oid);
  if (peeled === null) return null;
  void repo;
  return `${peeled} ${name}^{}`;
}

/** The v0 ref advertisement body for one service. */
export function advertiseV0(repo: RepoRec, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : UPLOAD_CAPS_V0;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const lines: string[] = [];
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  const allCaps = `${caps} symref=HEAD:${head}`;
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${allCaps}`);
  } else {
    const headOid = headTip ?? [...repo.refs.values()][0] ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${allCaps}`);
    for (const name of sortedRefNames(repo)) {
      const oid = repo.refs.get(name) as string;
      lines.push(`${oid} ${name}`);
      const peeled = peeledLine(repo, name, oid);
      if (peeled !== null) lines.push(peeled);
    }
  }
  for (const line of lines) parts.push(pkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body for git-upload-pack. */
export function advertiseV2(repo: RepoRec): Buffer {
  void repo;
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), PKT_FLUSH];
  const lines = [
    'version 2',
    'agent=liuli-forge/1.0',
    'ls-refs=unborn',
    'fetch=shallow wait-for-done',
    'object-format=sha1',
  ];
  for (const line of lines) parts.push(pkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function runLsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      let line = `${headTip} HEAD`;
      if (args.symrefs) line += ` symref-target:${head}`;
      parts.push(pkt(`${line}\n`));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${head}`;
      parts.push(pkt(`${line}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelTag(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (shared by v2 and v0)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
}

interface FetchPlan {
  pack: Buffer | null;
  shallowLines: string[];
  acks: string[];
  nak: boolean;
  nothingToSend: boolean;
}

function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  void repo;
  const validWants = args.wants.filter((oid) => hasObject(oid));
  const acks: string[] = [];
  for (const have of args.haves) if (hasObject(have)) acks.push(have);
  const nak = args.haves.length > 0 && acks.length === 0;
  if (validWants.length === 0 && args.wants.length > 0) {
    return { pack: null, shallowLines: [], acks, nak, nothingToSend: false };
  }
  let depth = args.deepen;
  if (depth !== null && args.deepenRelative) {
    // A deepen against an existing shallow boundary: the client counts the
    // new total depth from its tips; deepen by that many extra generations
    // is the same walk when the boundary is one generation deep per step.
    depth = args.deepen;
  }
  const { objects, boundary } = fetchSet(validWants, args.haves, depth);
  const shallowLines: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) shallowLines.push(`shallow ${oid}`);
    const boundarySet = new Set(boundary);
    for (const oid of args.shallow) {
      if (objects.has(oid) && !boundarySet.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  }
  const nothingToSend = objects.size === 0;
  return {
    pack: nothingToSend ? null : buildPack(objects),
    shallowLines,
    acks,
    nak,
    nothingToSend,
  };
}

/** Chunk a pack into sideband band-1 packets. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

function fetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  const hasNegotiation = args.haves.length > 0 || args.shallow.length > 0;
  if (hasNegotiation || plan.nothingToSend) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.nak) parts.push(pkt('NAK\n'));
    for (const oid of plan.acks) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallowLines.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pkt(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.pack !== null) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(plan.pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const line of plan.shallowLines) parts.push(pkt(`${line}\n`));
  if (plan.acks.length > 0) {
    for (const oid of plan.acks) parts.push(pkt(`ACK ${oid}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  if (plan.pack !== null) parts.push(...sidebandPack(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack entry points

/** Parse the argument section of a v2 command request. */
function parseV2Args(packets: Packet[]): { command: string; args: Map<string, string[]>; listArgs: string[] } {
  const args = new Map<string, string[]>();
  const listArgs: string[] = [];
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    listArgs.push(line);
    const space = line.indexOf(' ');
    if (space < 0) {
      const list = args.get(line) ?? [];
      list.push('');
      args.set(line, list);
    } else {
      const key = line.slice(0, space);
      const list = args.get(key) ?? [];
      list.push(line.slice(space + 1));
      args.set(key, list);
    }
  }
  return { command, args, listArgs };
}

export function uploadPackV2(repo: RepoRec, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const { command, args } = parseV2Args(packets);
  if (command === 'ls-refs') {
    return runLsRefs(repo, {
      peel: args.has('peel'),
      symrefs: args.has('symrefs'),
      unborn: args.has('unborn'),
      prefixes: args.get('ref-prefix') ?? [],
    });
  }
  if (command === 'fetch') {
    const deepenRaw = args.get('deepen')?.[0];
    return fetchV2(repo, {
      wants: args.get('want') ?? [],
      haves: args.get('have') ?? [],
      shallow: args.get('shallow') ?? [],
      deepen: deepenRaw !== undefined ? Number.parseInt(deepenRaw, 10) : null,
      deepenRelative: false,
    });
  }
  throw new Error(`unknown v2 command ${command}`);
}

export function uploadPackV0(repo: RepoRec, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
  }
  void section;
  return fetchV0(repo, { wants, haves, shallow, deepen, deepenRelative: false });
}

// ---------------------------------------------------------------------------
// receive-pack (v0)

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  status: number;
  body: Buffer;
}

const REF_NAME_OK = /^refs\/[A-Za-z0-9._\/-]+$/;

function validatePush(repo: RepoRec, command: PushCommand, packOk: boolean): string | null {
  if (!packOk) return 'unpacker error';
  const { oldOid, newOid, ref } = command;
  if (!REF_NAME_OK.test(ref) || ref.includes('..') || ref.includes('//')) return 'invalid ref name';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return 'stale info';
  if (newOid === ZERO_OID) {
    if (ref === headRef(repo)) return 'deletion of the current branch prohibited';
    return null;
  }
  if (!hasObject(newOid)) return 'missing object';
  const commit = peelToCommit(newOid);
  if (commit === null) return 'not a commit';
  if (oldOid !== ZERO_OID && ref.startsWith('refs/heads/')) {
    const oldCommit = peelToCommit(oldOid);
    if (oldCommit === null || !isAncestor(oldCommit, commit)) return 'non-fast-forward';
  }
  return null;
}

export function receivePack(repo: RepoRec, body: Buffer): PushOutcome {
  let packets: Packet[];
  let rest: Buffer;
  try {
    const decoded = decodePackets(body);
    packets = decoded.packets;
    rest = decoded.rest;
  } catch {
    return { status: 400, body: Buffer.alloc(0) };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (!sawFlush && commands.length === 0) {
    return { status: 400, body: Buffer.alloc(0) };
  }
  // The pack follows the command list's flush packet. decodePackets stopped
  // at the first non-pkt-line byte; the pack begins right after the flush.
  let packBytes = rest;
  if (packBytes.length === 0 && commands.some((command) => command.newOid !== ZERO_OID)) {
    packBytes = Buffer.alloc(0);
  }
  let packOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      packOk = false;
      unpackDetail = 'no pack sent';
    } else {
      try {
        readPackIntoStore(packBytes);
      } catch (err) {
        packOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  const reportLines: string[] = [`unpack ${packOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    const problem = validatePush(repo, command, packOk);
    if (problem !== null) {
      reportLines.push(`ng ${command.ref} ${problem}`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  const reportBody = Buffer.concat(reportLines.map((line) => pkt(`${line}\n`)).concat([PKT_FLUSH]));
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), reportBody.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts) };
  }
  return { status: 200, body: reportBody };
}

// ---------------------------------------------------------------------------
// helpers for the REST layer

/** The refs a repository advertises, with peeled tag targets. */
export function advertisedRefs(repo: RepoRec): Array<{ name: string; oid: string; peeled: string | null }> {
  const out: Array<{ name: string; oid: string; peeled: string | null }> = [];
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    out.push({ name, oid, peeled: peelTag(oid) });
  }
  return out;
}

export function repoHasObjects(repo: RepoRec): boolean {
  return repo.refs.size > 0;
}

export { closure, getCommit, getObject };
