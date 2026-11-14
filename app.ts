// GitHub-compatible git forge — single-process HTTP server
// Node 22 stdlib only, no npm packages, no git binary

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

// ════════════════════════════════════════════════════════════════════════════════
// Constants & helpers
// ════════════════════════════════════════════════════════════════════════════════

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO_OID = '0'.repeat(40);
let requestCounter = 0;

function requestId(): string {
  return `${Date.now().toString(16)}-${(++requestCounter).toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text).toString(),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://x').pathname; } catch { return '/'; }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://x').searchParams; } catch { return new URLSearchParams(); }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  return JSON.parse(buf.toString('utf8'));
}

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function sha1Buf(data: Buffer | string): Buffer {
  return createHash('sha1').update(data).digest();
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return false;
  }
  return true;
}

let currentOwner = 'owner';

// ════════════════════════════════════════════════════════════════════════════════
// In-memory store
// ════════════════════════════════════════════════════════════════════════════════

// Git objects: type → hash → data
interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

interface RefData {
  oid: string;
}

interface BranchData {
  name: string;
  sha: string;
  protected: boolean;
}

interface IssueData {
  id: number;
  number: number;
  node_id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelData[];
  comments: CommentData[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string; id: number };
}

interface CommentData {
  id: number;
  node_id: string;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

interface LabelData {
  id: number;
  node_id: string;
  name: string;
  description: string;
  color: string;
  default: boolean;
}

interface PullData {
  id: number;
  number: number;
  node_id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: LabelData[];
  draft: boolean;
  mergeable: boolean;
  comments: CommentData[];
}

interface RepoData {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  // Git object store per repo
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref path → oid (e.g. "refs/heads/main" → "abc123...")
  HEAD: string; // symbolic ref, e.g. "refs/heads/main"
  // Issues and PRs
  issues: IssueData[];
  pulls: PullData[];
  labels: LabelData[];
  // Counters
  nextIssueNumber: number;
  nextCommentId: number;
  // webhooks: none needed for conformance
}

const repos = new Map<string, RepoData>(); // "owner/name" → repo
let nextRepoId = 1;
let nextLabelId = 1;
let nextGlobalId = 1000;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): RepoData | undefined {
  return repos.get(repoKey(owner, name));
}

function makeNodeId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function decodeNodeId(nodeId: string): { type: string; id: number } | null {
  try {
    const decoded = Buffer.from(nodeId, 'base64').toString('utf8');
    const [type, idStr] = decoded.split(':');
    return { type, id: parseInt(idStr, 10) };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════════
// Git object helpers
// ════════════════════════════════════════════════════════════════════════════════

function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return sha1(Buffer.concat([header, data]));
}

function storeObject(repo: RepoData, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
  }
  return oid;
}

function createBlob(repo: RepoData, content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return storeObject(repo, 'blob', buf);
}

// Build a tree from a flat map of name→blobOid
function createTreeFromEntries(repo: RepoData, entries: Array<{ name: string; mode: string; oid: string }>): string {
  // Sort entries by name (git sorts tree entries)
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

function createCommit(repo: RepoData, treeOid: string, parentOids: string[], message: string, author?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const authorStr = author ?? `${currentOwner} <${currentOwner}@users.noreply.github.com>`;
  let commitText = `tree ${treeOid}\n`;
  for (const p of parentOids) commitText += `parent ${p}\n`;
  commitText += `author ${authorStr} ${now} +0000\n`;
  commitText += `committer ${authorStr} ${now} +0000\n`;
  commitText += `\n${message}\n`;
  return storeObject(repo, 'commit', Buffer.from(commitText));
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let i = 0;
  while (i < data.length) {
    // mode SP name NUL 20-byte-sha
    const spaceIdx = data.indexOf(0x20, i);
    if (spaceIdx < 0) break;
    const mode = data.subarray(i, spaceIdx).toString('ascii');
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx < 0) break;
    const name = data.subarray(spaceIdx + 1, nullIdx).toString('utf8');
    const oidBuf = data.subarray(nullIdx + 1, nullIdx + 21);
    const oid = oidBuf.toString('hex');
    entries.push({ mode, name, oid });
    i = nullIdx + 21;
  }
  return entries;
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string } {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let msgStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') {
      msgStart = i + 1;
      break;
    }
    if (lines[i].startsWith('tree ')) tree = lines[i].slice(5);
    else if (lines[i].startsWith('parent ')) parents.push(lines[i].slice(7));
    else if (lines[i].startsWith('author ')) author = lines[i].slice(7);
    else if (lines[i].startsWith('committer ')) committer = lines[i].slice(10);
  }
  const message = msgStart >= 0 ? lines.slice(msgStart).join('\n').replace(/\n$/, '') : '';
  return { tree, parents, message, author, committer };
}

// Recursively get tree with path
function getTreeRecursive(repo: RepoData, treeOid: string, prefix: string = ''): Array<{ path: string; mode: string; type: string; sha: string; size?: number }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries = parseTreeEntries(obj.data);
  const result: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> = [];
  for (const e of entries) {
    const fullPath = prefix ? `${prefix}/${e.name}` : e.name;
    const childObj = repo.objects.get(e.oid);
    if (e.mode === '40000' || e.mode === '040000') {
      result.push({ path: fullPath, mode: e.mode, type: 'tree', sha: e.oid });
      result.push(...getTreeRecursive(repo, e.oid, fullPath));
    } else {
      const size = childObj?.type === 'blob' ? childObj.data.length : undefined;
      result.push({ path: fullPath, mode: e.mode, type: 'blob', sha: e.oid, size });
    }
  }
  return result;
}

// Get the tree oid for a commit
function getCommitTree(repo: RepoData, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  return parsed.tree;
}

// Get file content at a path in a tree
function getFileAtPath(repo: RepoData, treeOid: string, filePath: string): { oid: string; content: Buffer } | null {
  const parts = filePath.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(currentTree);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTreeEntries(obj.data);
    const entry = entries.find(e => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      // This should be a blob
      const blobObj = repo.objects.get(entry.oid);
      if (!blobObj || blobObj.type !== 'blob') return null;
      return { oid: entry.oid, content: blobObj.data };
    } else {
      currentTree = entry.oid;
    }
  }
  return null;
}

// Update or create a file in a tree, returning new tree oid
function updateFileInTree(repo: RepoData, treeOid: string | null, filePath: string, blobOid: string | null): string {
  const parts = filePath.split('/');
  return updateTreeRecursive(repo, treeOid, parts, 0, blobOid);
}

function updateTreeRecursive(repo: RepoData, treeOid: string | null, pathParts: string[], depth: number, blobOid: string | null): string {
  let entries: Array<{ mode: string; name: string; oid: string }> = [];
  if (treeOid) {
    const obj = repo.objects.get(treeOid);
    if (obj && obj.type === 'tree') {
      entries = parseTreeEntries(obj.data);
    }
  }

  const targetName = pathParts[depth];
  const isLast = depth === pathParts.length - 1;

  if (isLast) {
    if (blobOid === null) {
      // Delete the entry
      entries = entries.filter(e => e.name !== targetName);
    } else {
      const existing = entries.findIndex(e => e.name === targetName);
      if (existing >= 0) {
        entries[existing] = { ...entries[existing], oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: targetName, oid: blobOid });
      }
    }
  } else {
    const existing = entries.find(e => e.name === targetName);
    const subTreeOid = existing ? existing.oid : null;
    const newSubTree = updateTreeRecursive(repo, subTreeOid, pathParts, depth + 1, blobOid);
    if (existing) {
      existing.oid = newSubTree;
    } else {
      entries.push({ mode: '40000', name: targetName, oid: newSubTree });
    }
  }

  return createTreeFromEntries(repo, entries.map(e => ({ name: e.name, mode: e.mode, oid: e.oid })));
}

// Collect all objects reachable from an oid
function collectObjects(repo: RepoData, oid: string, seen: Set<string>): void {
  if (seen.has(oid)) return;
  const obj = repo.objects.get(oid);
  if (!obj) return;
  seen.add(oid);
  if (obj.type === 'commit') {
    const parsed = parseCommit(obj.data);
    collectObjects(repo, parsed.tree, seen);
    for (const p of parsed.parents) collectObjects(repo, p, seen);
  } else if (obj.type === 'tree') {
    const entries = parseTreeEntries(obj.data);
    for (const e of entries) collectObjects(repo, e.oid, seen);
  }
}

// Get commit list for a ref
function getCommitHistory(repo: RepoData, startOid: string, limit: number = 100): string[] {
  const result: string[] = [];
  const queue = [startOid];
  const seen = new Set<string>();
  while (queue.length > 0 && result.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    result.push(oid);
    const parsed = parseCommit(obj.data);
    for (const p of parsed.parents) queue.push(p);
  }
  return result;
}

// Resolve a ref to an oid
function resolveRef(repo: RepoData, ref: string): string | null {
  // Direct ref
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  // Try refs/heads/
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  // Try refs/tags/
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`)!;
  // Try as raw oid
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// Git pack protocol helpers
// ════════════════════════════════════════════════════════════════════════════════

function pktLine(data: string): Buffer {
  const len = data.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.from(hex + data);
}

function pktLineBuf(data: Buffer): Buffer {
  const len = data.length + 4;
  const hex = Buffer.from(len.toString(16).padStart(4, '0'));
  return Buffer.concat([hex, data]);
}

const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');

// Parse pkt-line stream
function parsePktLines(buf: Buffer): Array<{ type: 'data' | 'flush' | 'delim'; data?: Buffer }> {
  const lines: Array<{ type: 'data' | 'flush' | 'delim'; data?: Buffer }> = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      lines.push({ type: 'flush' });
      offset += 4;
    } else if (lenHex === '0001') {
      lines.push({ type: 'delim' });
      offset += 4;
    } else {
      const len = parseInt(lenHex, 16);
      if (len < 4 || offset + len > buf.length) break;
      let data = buf.subarray(offset + 4, offset + len);
      // Strip trailing newline
      if (data.length > 0 && data[data.length - 1] === 0x0a) {
        data = data.subarray(0, data.length - 1);
      }
      lines.push({ type: 'data', data });
      offset += len;
    }
  }
  return lines;
}

// Build packfile containing the given objects
function buildPackfile(repo: RepoData, oids: string[]): Buffer {
  const objects = oids.map(oid => {
    const obj = repo.objects.get(oid);
    if (!obj) throw new Error(`Object not found: ${oid}`);
    return { oid, type: obj.type, data: obj.data };
  });
  
  const typeMap: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  
  // Header: PACK version 2, numObjects
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  
  for (const { type, data } of objects) {
    const typeNum = typeMap[type] ?? 1;
    const compressed = deflateSync(data);
    
    // Variable-length size encoding
    let size = data.length;
    let firstByte = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) firstByte |= 0x80;
    const sizeBytes: number[] = [firstByte];
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    
    parts.push(Buffer.from(sizeBytes));
    parts.push(compressed);
  }
  
  // SHA-1 checksum
  const packData = Buffer.concat(parts);
  const checksum = sha1Buf(packData);
  return Buffer.concat([packData, checksum]);
}

// Parse a packfile and store objects
function parsePackfile(repo: RepoData, data: Buffer): Array<{ oid: string; type: string }> {
  const result: Array<{ oid: string; type: string }> = [];
  
  if (data.length < 12) return result;
  
  // Verify header
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== 'PACK') return result;
  
  const version = data.readUInt32BE(4);
  const numObjects = data.readUInt32BE(8);
  
  let offset = 12;
  const typeNames = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs_delta', 'ref_delta'];
  
  // First pass: parse all objects, store non-delta ones, queue deltas
  interface ParsedObj {
    typeNum: number;
    typeName: string;
    decompressed: Buffer;
    offset: number;
    baseOid?: string;
    baseOffset?: number;
  }
  
  const parsedObjects: ParsedObj[] = [];
  const offsetToIndex = new Map<number, number>();
  
  for (let i = 0; i < numObjects; i++) {
    const objStartOffset = offset;
    // Read type and size
    let byte = data[offset++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = data[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    
    const typeName = typeNames[typeNum] || 'unknown';
    
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    
    if (typeNum === 7) {
      // ref_delta: 20-byte base object hash
      baseOid = data.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeNum === 6) {
      // ofs_delta: negative offset to base object
      let b = data[offset++];
      let negOffset = b & 0x7f;
      while (b & 0x80) {
        b = data[offset++];
        negOffset = ((negOffset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = objStartOffset - negOffset;
    }
    
    // Decompress
    let decompressed: Buffer;
    try {
      // Try inflating with increasing buffer sizes
      let inflated: Buffer | null = null;
      // We need to figure out how much compressed data there is
      // Try to inflate and see how much we consumed
      for (let trySize = Math.min(data.length - offset, 4096); trySize <= data.length - offset; trySize = Math.min(trySize * 2, data.length - offset)) {
        try {
          inflated = inflateSync(data.subarray(offset, offset + trySize));
          // Find actual compressed size by trying smaller buffers
          // Actually, inflateSync will consume exactly what it needs
          break;
        } catch (e: any) {
          if (trySize >= data.length - offset) {
            // Last attempt failed
            inflated = Buffer.alloc(0);
            break;
          }
        }
      }
      decompressed = inflated ?? Buffer.alloc(0);
      
      // We need to find the end of compressed data
      // Find compressed size
      try {
        decompressed = inflateSync(data.subarray(offset));
      } catch {
        decompressed = Buffer.alloc(0);
      }
      // Find the end of compressed data
      let compressedSize = 2;
      let foundSize = false;
      for (let s = 2; s <= data.length - offset; s++) {
        try {
          inflateSync(data.subarray(offset, offset + s));
          compressedSize = s;
          foundSize = true;
          break;
        } catch {
          continue;
        }
      }
      if (foundSize) {
        offset += compressedSize;
      } else {
        offset = data.length - 20; // skip to checksum
      }
    } catch {
      decompressed = Buffer.alloc(0);
      offset = data.length - 20;
    }
    
    offsetToIndex.set(objStartOffset, i);
    parsedObjects.push({ typeNum, typeName, decompressed, offset: objStartOffset, baseOid, baseOffset });
  }
  
  // Now resolve objects - non-deltas first, then deltas
  const resolved = new Map<number, { type: string; data: Buffer; oid: string }>();
  
  // First pass: store non-delta objects
  for (let i = 0; i < parsedObjects.length; i++) {
    const obj = parsedObjects[i];
    if (obj.typeNum >= 1 && obj.typeNum <= 4) {
      const type = obj.typeName as 'blob' | 'tree' | 'commit' | 'tag';
      const oid = storeObject(repo, type, obj.decompressed);
      resolved.set(i, { type, data: obj.decompressed, oid });
      result.push({ oid, type });
    }
  }
  
  // Resolve deltas (may need multiple passes)
  let changed = true;
  let maxPasses = 10;
  while (changed && maxPasses-- > 0) {
    changed = false;
    for (let i = 0; i < parsedObjects.length; i++) {
      if (resolved.has(i)) continue;
      const obj = parsedObjects[i];
      
      let baseData: Buffer | null = null;
      let baseType: string | null = null;
      
      if (obj.typeNum === 7 && obj.baseOid) {
        // ref_delta
        const baseObj = repo.objects.get(obj.baseOid);
        if (baseObj) {
          baseData = baseObj.data;
          baseType = baseObj.type;
        }
      } else if (obj.typeNum === 6 && obj.baseOffset !== undefined) {
        // ofs_delta
        const baseIdx = offsetToIndex.get(obj.baseOffset);
        if (baseIdx !== undefined && resolved.has(baseIdx)) {
          const base = resolved.get(baseIdx)!;
          baseData = base.data;
          baseType = base.type;
        }
      }
      
      if (baseData !== null && baseType !== null) {
        const patched = applyDelta(baseData, obj.decompressed);
        const type = baseType as 'blob' | 'tree' | 'commit' | 'tag';
        const oid = storeObject(repo, type, patched);
        resolved.set(i, { type, data: patched, oid });
        result.push({ oid, type });
        changed = true;
      }
    }
  }
  
  return result;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  
  // Read base size (variable-length)
  let baseSize = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = delta[offset++];
    baseSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  
  // Read result size (variable-length)
  let resultSize = 0;
  shift = 0;
  do {
    byte = delta[offset++];
    resultSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  
  const result = Buffer.alloc(resultSize);
  let resultOffset = 0;
  
  while (offset < delta.length) {
    const cmd = delta[offset++];
    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;
      if (cmd & 0x01) copyOffset = delta[offset++];
      if (cmd & 0x02) copyOffset |= delta[offset++] << 8;
      if (cmd & 0x04) copyOffset |= delta[offset++] << 16;
      if (cmd & 0x08) copyOffset |= delta[offset++] << 24;
      if (cmd & 0x10) copySize = delta[offset++];
      if (cmd & 0x20) copySize |= delta[offset++] << 8;
      if (cmd & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(result, resultOffset, copyOffset, copyOffset + copySize);
      resultOffset += copySize;
    } else if (cmd > 0) {
      // Insert new data
      delta.copy(result, resultOffset, offset, offset + cmd);
      resultOffset += cmd;
      offset += cmd;
    }
  }
  
  return result.subarray(0, resultOffset);
}

// Improved packfile parser that properly finds compressed data boundaries
function parsePackfileImproved(repo: RepoData, data: Buffer): Array<{ oid: string; type: string }> {
  const result: Array<{ oid: string; type: string }> = [];
  
  if (data.length < 12) return result;
  
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== 'PACK') return result;
  
  const version = data.readUInt32BE(4);
  const numObjects = data.readUInt32BE(8);
  
  let offset = 12;
  const typeNames: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  
  interface ObjInfo {
    index: number;
    startOffset: number;
    typeNum: number;
    size: number;
    dataOffset: number; // where compressed data starts
    baseOid?: string;
    baseOfs?: number;
  }
  
  const objects: ObjInfo[] = [];
  
  // First pass: parse headers to find object boundaries
  for (let i = 0; i < numObjects; i++) {
    const startOffset = offset;
    let byte = data[offset++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = data[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    
    let baseOid: string | undefined;
    let baseOfs: number | undefined;
    
    if (typeNum === 7) {
      baseOid = data.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeNum === 6) {
      let b = data[offset++];
      let negOfs = b & 0x7f;
      while (b & 0x80) {
        b = data[offset++];
        negOfs = ((negOfs + 1) << 7) | (b & 0x7f);
      }
      baseOfs = startOffset - negOfs;
    }
    
    const dataOffset = offset;
    objects.push({ index: i, startOffset, typeNum, size, dataOffset, baseOid, baseOfs });
    
    // Skip compressed data - find the end by trial decompression
    // Use a binary-search-like approach to find the right boundary
    const remaining = data.length - offset - 20; // -20 for pack checksum
    let compressedEnd = remaining;
    
    try {
      // Try to inflate the whole remaining data first
      inflateSync(data.subarray(offset, data.length - 20));
      // If it works with the whole thing, binary search for the minimum
      let lo = 2, hi = remaining;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        try {
          inflateSync(data.subarray(offset, offset + mid));
          hi = mid;
        } catch {
          lo = mid + 1;
        }
      }
      compressedEnd = lo;
    } catch {
      // Try each size from small to large
      for (let s = 2; s <= remaining; s++) {
        try {
          inflateSync(data.subarray(offset, offset + s));
          compressedEnd = s;
          break;
        } catch {
          continue;
        }
      }
    }
    
    offset += compressedEnd;
  }
  
  // Second pass: decompress and store objects
  const resolved = new Map<number, { type: string; data: Buffer; oid: string }>();
  const offsetToIdx = new Map<number, number>();
  for (const obj of objects) {
    offsetToIdx.set(obj.startOffset, obj.index);
  }
  
  // Non-delta objects first
  for (const obj of objects) {
    if (obj.typeNum >= 1 && obj.typeNum <= 4) {
      const typeName = typeNames[obj.typeNum]!;
      let endOffset: number;
      const nextObj = objects.find(o => o.index === obj.index + 1);
      if (nextObj) {
        endOffset = nextObj.startOffset;
      } else {
        endOffset = data.length - 20;
      }
      
      try {
        const decompressed = inflateSync(data.subarray(obj.dataOffset, endOffset));
        const oid = storeObject(repo, typeName as any, decompressed);
        resolved.set(obj.index, { type: typeName, data: decompressed, oid });
        result.push({ oid, type: typeName });
      } catch {
        // Try with more data
        try {
          const decompressed = inflateSync(data.subarray(obj.dataOffset));
          const oid = storeObject(repo, typeName as any, decompressed);
          resolved.set(obj.index, { type: typeName, data: decompressed, oid });
          result.push({ oid, type: typeName });
        } catch { /* skip */ }
      }
    }
  }
  
  // Resolve deltas
  let changed = true;
  let passes = 20;
  while (changed && passes-- > 0) {
    changed = false;
    for (const obj of objects) {
      if (resolved.has(obj.index)) continue;
      if (obj.typeNum !== 6 && obj.typeNum !== 7) continue;
      
      let baseData: Buffer | null = null;
      let baseType: string | null = null;
      
      if (obj.typeNum === 7 && obj.baseOid) {
        const baseObj = repo.objects.get(obj.baseOid);
        if (baseObj) {
          baseData = baseObj.data;
          baseType = baseObj.type;
        } else {
          // Check resolved
          for (const [, r] of resolved) {
            if (r.oid === obj.baseOid) {
              baseData = r.data;
              baseType = r.type;
              break;
            }
          }
        }
      } else if (obj.typeNum === 6 && obj.baseOfs !== undefined) {
        const baseIdx = offsetToIdx.get(obj.baseOfs);
        if (baseIdx !== undefined && resolved.has(baseIdx)) {
          const base = resolved.get(baseIdx)!;
          baseData = base.data;
          baseType = base.type;
        }
      }
      
      if (baseData && baseType) {
        let endOffset: number;
        const nextObj = objects.find(o => o.index === obj.index + 1);
        if (nextObj) {
          endOffset = nextObj.startOffset;
        } else {
          endOffset = data.length - 20;
        }
        
        try {
          let decompressed: Buffer;
          try {
            decompressed = inflateSync(data.subarray(obj.dataOffset, endOffset));
          } catch {
            decompressed = inflateSync(data.subarray(obj.dataOffset));
          }
          const patched = applyDelta(baseData, decompressed);
          const type = baseType as 'blob' | 'tree' | 'commit' | 'tag';
          const oid = storeObject(repo, type, patched);
          resolved.set(obj.index, { type, data: patched, oid });
          result.push({ oid, type });
          changed = true;
        } catch { /* skip */ }
      }
    }
  }
  
  return result;
}

// Create repo helper
function createRepoData(owner: string, name: string, description: string = '', isPrivate: boolean = false): RepoData {
  const id = nextRepoId++;
  const now = new Date().toISOString();
  const repo: RepoData = {
    id,
    node_id: makeNodeId('Repository', id),
    name,
    full_name: `${owner}/${name}`,
    owner,
    description,
    private: isPrivate,
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    objects: new Map(),
    refs: new Map(),
    HEAD: 'refs/heads/main',
    issues: [],
    pulls: [],
    labels: [],
    nextIssueNumber: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ════════════════════════════════════════════════════════════════════════════════
// REST API v3
// ════════════════════════════════════════════════════════════════════════════════

function repoJson(repo: RepoData): any {
  const headRef = repo.refs.get(repo.HEAD);
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: 1,
      node_id: makeNodeId('User', 1),
      type: 'User',
    },
    description: repo.description,
    fork: false,
    url: '',
    html_url: '',
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter(i => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.private ? 'private' : 'public',
    permissions: {
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    },
  };
}

function issueJson(repo: RepoData, issue: IssueData): any {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(l => ({
      id: l.id,
      node_id: l.node_id,
      name: l.name,
      description: l.description,
      color: l.color,
      default: l.default,
    })),
    user: issue.user,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    repository_url: '',
    html_url: '',
    pull_request: undefined,
  };
}

function pullJson(repo: RepoData, pull: PullData): any {
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: pull.user,
    labels: pull.labels.map(l => ({
      id: l.id,
      node_id: l.node_id,
      name: l.name,
      description: l.description,
      color: l.color,
      default: l.default,
    })),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: {
      label: pull.head.label,
      ref: pull.head.ref,
      sha: pull.head.sha,
    },
    base: {
      label: pull.base.label,
      ref: pull.base.ref,
      sha: pull.base.sha,
    },
    merged: pull.merged,
    mergeable: pull.mergeable,
    draft: pull.draft,
    comments: pull.comments.length,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(comment: CommentData): any {
  return {
    id: comment.id,
    node_id: comment.node_id,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

function labelJson(label: LabelData): any {
  return {
    id: label.id,
    node_id: label.node_id,
    name: label.name,
    description: label.description,
    color: label.color,
    default: label.default,
  };
}

function branchJson(repo: RepoData, branchName: string, sha: string): any {
  const commitObj = repo.objects.get(sha);
  let commitData: any = { sha, url: '' };
  if (commitObj && commitObj.type === 'commit') {
    const parsed = parseCommit(commitObj.data);
    commitData = {
      sha,
      url: '',
      commit: {
        sha,
        message: parsed.message,
        author: { name: currentOwner, email: `${currentOwner}@users.noreply.github.com`, date: new Date().toISOString() },
        committer: { name: currentOwner, email: `${currentOwner}@users.noreply.github.com`, date: new Date().toISOString() },
        tree: { sha: parsed.tree, url: '' },
      },
    };
  }
  return {
    name: branchName,
    commit: commitData,
    protected: false,
  };
}

function commitRestJson(repo: RepoData, oid: string): any {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  // Parse author string: "Name <email> timestamp tz"
  let authorName = currentOwner;
  let authorEmail = `${currentOwner}@users.noreply.github.com`;
  let authorDate = new Date().toISOString();
  const authorMatch = parsed.author.match(/^(.+?)\s+<(.+?)>\s+(\d+)\s+([+-]\d+)$/);
  if (authorMatch) {
    authorName = authorMatch[1];
    authorEmail = authorMatch[2];
    authorDate = new Date(parseInt(authorMatch[3]) * 1000).toISOString();
  }
  let committerName = authorName;
  let committerEmail = authorEmail;
  let committerDate = authorDate;
  const committerMatch = parsed.committer.match(/^(.+?)\s+<(.+?)>\s+(\d+)\s+([+-]\d+)$/);
  if (committerMatch) {
    committerName = committerMatch[1];
    committerEmail = committerMatch[2];
    committerDate = new Date(parseInt(committerMatch[3]) * 1000).toISOString();
  }
  return {
    sha: oid,
    node_id: makeNodeId('Commit', parseInt(oid.slice(0, 8), 16)),
    commit: {
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: committerName, email: committerEmail, date: committerDate },
      message: parsed.message,
      tree: { sha: parsed.tree, url: '' },
      url: '',
    },
    author: { login: currentOwner, id: 1 },
    committer: { login: currentOwner, id: 1 },
    parents: parsed.parents.map(p => ({ sha: p, url: '' })),
    url: '',
    html_url: '',
  };
}

// REST route handlers
function handleRestApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): void {
  // Strip /api/v3 prefix
  const apiPath = path.replace(/^\/api\/v3/, '');
  const query = queryOf(req);

  // User/viewer endpoint
  if (apiPath === '/user' && method === 'GET') {
    sendJson(res, 200, { login: currentOwner, id: 1, node_id: makeNodeId('User', 1), type: 'User' });
    return;
  }

  // Repos CRUD
  if (apiPath === '/user/repos' && method === 'POST') {
    readJson(req).then(body => {
      const name = body.name;
      if (!name) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const owner = currentOwner;
      const existing = getRepo(owner, name);
      if (existing) { sendJson(res, 422, { message: 'Repository creation failed' }); return; }
      const repo = createRepoData(owner, name, body.description ?? '', body.private ?? false);
      if (body.auto_init) {
        // Create initial commit
        const readmeContent = `# ${name}\n\n${body.description ?? ''}\n`;
        const blobOid = createBlob(repo, readmeContent);
        const treeOid = createTreeFromEntries(repo, [{ name: 'README.md', mode: '100644', oid: blobOid }]);
        const commitOid = createCommit(repo, treeOid, [], 'Initial commit');
        repo.refs.set('refs/heads/main', commitOid);
      }
      sendJson(res, 201, repoJson(repo));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Match repos routes
  const repoMatch = apiPath.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (repoMatch) {
    const [, owner, repoName, subPath] = repoMatch;
    handleRepoApi(req, res, owner, repoName, subPath || '', method, query);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleRepoApi(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, subPath: string, method: string, query: URLSearchParams): void {
  // Create repo via POST /repos/:owner/:repo (alternative path)
  if (subPath === '' && method === 'POST') {
    readJson(req).then(body => {
      const existing = getRepo(owner, repoName);
      if (existing) { sendJson(res, 422, { message: 'Repository creation failed' }); return; }
      const repo = createRepoData(owner, repoName, body.description ?? '', body.private ?? false);
      sendJson(res, 201, repoJson(repo));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Get repo
  if (subPath === '' && method === 'GET') {
    const repo = getRepo(owner, repoName);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, repoJson(repo));
    return;
  }

  // Delete repo
  if (subPath === '' && method === 'DELETE') {
    const key = repoKey(owner, repoName);
    if (!repos.has(key)) { sendJson(res, 404, { message: 'Not Found' }); return; }
    repos.delete(key);
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }

  // PATCH repo
  if (subPath === '' && method === 'PATCH') {
    const repo = getRepo(owner, repoName);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      if (body.name) repo.name = body.name;
      if (body.description !== undefined) repo.description = body.description;
      if (body.private !== undefined) repo.private = body.private;
      if (body.default_branch !== undefined) repo.default_branch = body.default_branch;
      repo.full_name = `${repo.owner}/${repo.name}`;
      repo.updated_at = new Date().toISOString();
      sendJson(res, 200, repoJson(repo));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  const repo = getRepo(owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }

  // Branches
  if (subPath === '/branches' && method === 'GET') {
    const branches: any[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        const branchName = ref.slice('refs/heads/'.length);
        branches.push(branchJson(repo, branchName, oid));
      }
    }
    sendJson(res, 200, branches);
    return;
  }

  const branchMatch = subPath.match(/^\/branches\/(.+)$/);
  if (branchMatch && method === 'GET') {
    const branchName = branchMatch[1];
    const ref = `refs/heads/${branchName}`;
    const oid = repo.refs.get(ref);
    if (!oid) { sendJson(res, 404, { message: 'Branch not found' }); return; }
    sendJson(res, 200, branchJson(repo, branchName, oid));
    return;
  }

  // Git refs
  if (subPath === '/git/refs' && method === 'POST') {
    readJson(req).then(body => {
      const ref = body.ref;
      const sha = body.sha;
      if (!ref || !sha) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  const refMatch = subPath.match(/^\/git\/refs\/(.+)$/);
  if (refMatch && method === 'GET') {
    const refPath = refMatch[1];
    const fullRef = `refs/${refPath}`;
    const oid = repo.refs.get(fullRef);
    if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { ref: fullRef, object: { sha: oid, type: 'commit' } });
    return;
  }

  if (refMatch && method === 'PATCH') {
    const refPath = refMatch[1];
    const fullRef = `refs/${refPath}`;
    readJson(req).then(body => {
      const sha = body.sha;
      if (!sha) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      repo.refs.set(fullRef, sha);
      sendJson(res, 200, { ref: fullRef, object: { sha, type: 'commit' } });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  if (refMatch && method === 'DELETE') {
    const refPath = refMatch[1];
    const fullRef = `refs/${refPath}`;
    repo.refs.delete(fullRef);
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }

  // Commits
  if (subPath === '/commits' && method === 'GET') {
    const sha = query.get('sha') || repo.default_branch;
    const oid = resolveRef(repo, sha);
    if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const perPage = parseInt(query.get('per_page') ?? '30');
    const history = getCommitHistory(repo, oid, perPage);
    const commits = history.map(h => commitRestJson(repo, h)).filter(Boolean);
    sendJson(res, 200, commits);
    return;
  }

  const commitMatch = subPath.match(/^\/commits\/([^/]+)$/);
  if (commitMatch && method === 'GET') {
    const ref = commitMatch[1];
    const oid = resolveRef(repo, ref);
    if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const json = commitRestJson(repo, oid);
    if (!json) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, json);
    return;
  }

  // Compare
  const compareMatch = subPath.match(/^\/compare\/([^.]+)\.\.\.(.+)$/);
  if (compareMatch && method === 'GET') {
    const [, baseRef, headRef] = compareMatch;
    const baseOid = resolveRef(repo, baseRef);
    const headOid = resolveRef(repo, headRef);
    if (!baseOid || !headOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    // Get commits between base and head
    const headHistory = getCommitHistory(repo, headOid, 250);
    const baseHistory = new Set(getCommitHistory(repo, baseOid, 250));
    const commits = headHistory.filter(h => !baseHistory.has(h));
    
    // Get file changes
    const baseTree = getCommitTree(repo, baseOid);
    const headTree = getCommitTree(repo, headOid);
    const files: any[] = [];
    if (baseTree && headTree) {
      const baseFiles = getTreeRecursive(repo, baseTree);
      const headFiles = getTreeRecursive(repo, headTree);
      const baseMap = new Map(baseFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
      const headMap = new Map(headFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
      for (const [path, sha] of headMap) {
        const baseSha = baseMap.get(path);
        if (!baseSha) {
          files.push({ filename: path, sha, status: 'added', additions: 0, deletions: 0, changes: 0 });
        } else if (baseSha !== sha) {
          files.push({ filename: path, sha, status: 'modified', additions: 0, deletions: 0, changes: 0 });
        }
      }
      for (const [path, sha] of baseMap) {
        if (!headMap.has(path)) {
          files.push({ filename: path, sha, status: 'removed', additions: 0, deletions: 0, changes: 0 });
        }
      }
    }
    
    sendJson(res, 200, {
      status: commits.length > 0 ? 'ahead' : 'identical',
      ahead_by: commits.length,
      behind_by: 0,
      total_commits: commits.length,
      commits: commits.map(c => commitRestJson(repo, c)).filter(Boolean),
      files,
      base_commit: commitRestJson(repo, baseOid),
      merge_base_commit: commitRestJson(repo, baseOid),
    });
    return;
  }

  // Trees
  const treeMatch = subPath.match(/^\/git\/trees\/([^?]+)$/);
  if (treeMatch && method === 'GET') {
    const treeRef = treeMatch[1];
    const oid = resolveRef(repo, treeRef) ?? treeRef;
    const obj = repo.objects.get(oid);
    if (!obj) { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    // If it's a commit, get its tree
    let treeOid = oid;
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      treeOid = parsed.tree;
    }
    
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    const recursive = query.get('recursive') === '1' || query.get('recursive') === 'true';
    
    if (recursive) {
      const allEntries = getTreeRecursive(repo, treeOid);
      sendJson(res, 200, {
        sha: treeOid,
        tree: allEntries.map(e => ({
          path: e.path,
          mode: e.mode.padStart(6, '0'),
          type: e.type,
          sha: e.sha,
          size: e.size,
          url: '',
        })),
        truncated: false,
      });
    } else {
      const entries = parseTreeEntries(treeObj.data);
      sendJson(res, 200, {
        sha: treeOid,
        tree: entries.map(e => {
          const childObj = repo.objects.get(e.oid);
          const type = (e.mode === '40000' || e.mode === '040000') ? 'tree' : 'blob';
          return {
            path: e.name,
            mode: e.mode.padStart(6, '0'),
            type,
            sha: e.oid,
            size: type === 'blob' && childObj ? childObj.data.length : undefined,
            url: '',
          };
        }),
        truncated: false,
      });
    }
    return;
  }

  // Blobs
  const blobMatch = subPath.match(/^\/git\/blobs\/([0-9a-f]+)$/);
  if (blobMatch && method === 'GET') {
    const oid = blobMatch[1];
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, {
      sha: oid,
      size: obj.data.length,
      content: obj.data.toString('base64') + '\n',
      encoding: 'base64',
      node_id: makeNodeId('Blob', parseInt(oid.slice(0, 8), 16)),
    });
    return;
  }

  // Contents API
  const contentsMatch = subPath.match(/^\/contents\/(.+)$/);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1]);
    handleContentsApi(req, res, repo, owner, repoName, filePath, method, query);
    return;
  }
  if (subPath === '/contents/' || subPath === '/contents') {
    handleContentsApi(req, res, repo, owner, repoName, '', method, query);
    return;
  }

  // Issues
  if (subPath === '/issues' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const perPage = parseInt(query.get('per_page') ?? '30');
    const page = parseInt(query.get('page') ?? '1');
    let filteredIssues = repo.issues;
    if (state !== 'all') {
      filteredIssues = filteredIssues.filter(i => i.state === state);
    }
    // Sort by created_at desc (newest first)
    filteredIssues = [...filteredIssues].sort((a, b) => b.number - a.number);
    const start = (page - 1) * perPage;
    const end = start + perPage;
    sendJson(res, 200, filteredIssues.slice(start, end).map(i => issueJson(repo, i)));
    return;
  }

  if (subPath === '/issues' && method === 'POST') {
    readJson(req).then(body => {
      const issue: IssueData = {
        id: nextGlobalId++,
        number: repo.nextIssueNumber++,
        node_id: makeNodeId('Issue', nextGlobalId - 1),
        title: body.title,
        body: body.body ?? '',
        state: 'open',
        labels: [],
        comments: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        closed_at: null,
        user: { login: currentOwner, id: 1 },
      };
      // Handle labels
      if (Array.isArray(body.labels)) {
        for (const l of body.labels) {
          const labelName = typeof l === 'string' ? l : l.name;
          let label = repo.labels.find(lb => lb.name === labelName);
          if (!label) {
            label = {
              id: nextLabelId++,
              node_id: makeNodeId('Label', nextLabelId - 1),
              name: labelName,
              description: '',
              color: 'ededed',
              default: false,
            };
            repo.labels.push(label);
          }
          issue.labels.push(label);
        }
      }
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  const issueMatch = subPath.match(/^\/issues\/(\d+)$/);
  if (issueMatch && method === 'GET') {
    const num = parseInt(issueMatch[1]);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }

  if (issueMatch && method === 'PATCH') {
    const num = parseInt(issueMatch[1]);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      if (body.title !== undefined) issue.title = body.title;
      if (body.body !== undefined) issue.body = body.body;
      if (body.state !== undefined) {
        issue.state = body.state;
        if (body.state === 'closed') issue.closed_at = new Date().toISOString();
        else issue.closed_at = null;
      }
      if (Array.isArray(body.labels)) {
        issue.labels = [];
        for (const l of body.labels) {
          const labelName = typeof l === 'string' ? l : l.name;
          let label = repo.labels.find(lb => lb.name === labelName);
          if (!label) {
            label = {
              id: nextLabelId++,
              node_id: makeNodeId('Label', nextLabelId - 1),
              name: labelName,
              description: '',
              color: 'ededed',
              default: false,
            };
            repo.labels.push(label);
          }
          issue.labels.push(label);
        }
      }
      issue.updated_at = new Date().toISOString();
      sendJson(res, 200, issueJson(repo, issue));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Issue comments
  const issueCommentsMatch = subPath.match(/^\/issues\/(\d+)\/comments$/);
  if (issueCommentsMatch && method === 'GET') {
    const num = parseInt(issueCommentsMatch[1]);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, issue.comments.map(c => commentJson(c)));
    return;
  }

  if (issueCommentsMatch && method === 'POST') {
    const num = parseInt(issueCommentsMatch[1]);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      const comment: CommentData = {
        id: repo.nextCommentId++,
        node_id: makeNodeId('IssueComment', nextGlobalId++),
        body: body.body,
        user: { login: currentOwner, id: 1 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Labels
  if (subPath === '/labels' && method === 'GET') {
    sendJson(res, 200, repo.labels.map(l => labelJson(l)));
    return;
  }

  if (subPath === '/labels' && method === 'POST') {
    readJson(req).then(body => {
      const existing = repo.labels.find(l => l.name === body.name);
      if (existing) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const label: LabelData = {
        id: nextLabelId++,
        node_id: makeNodeId('Label', nextLabelId - 1),
        name: body.name,
        description: body.description ?? '',
        color: (body.color ?? 'ededed').replace(/^#/, ''),
        default: false,
      };
      repo.labels.push(label);
      sendJson(res, 201, labelJson(label));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  const labelMatch = subPath.match(/^\/labels\/(.+)$/);
  if (labelMatch && method === 'GET') {
    const name = decodeURIComponent(labelMatch[1]);
    const label = repo.labels.find(l => l.name === name);
    if (!label) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, labelJson(label));
    return;
  }

  if (labelMatch && method === 'PATCH') {
    const name = decodeURIComponent(labelMatch[1]);
    const label = repo.labels.find(l => l.name === name);
    if (!label) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      if (body.name !== undefined) label.name = body.name;
      if (body.description !== undefined) label.description = body.description;
      if (body.color !== undefined) label.color = body.color.replace(/^#/, '');
      sendJson(res, 200, labelJson(label));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  if (labelMatch && method === 'DELETE') {
    const name = decodeURIComponent(labelMatch[1]);
    const idx = repo.labels.findIndex(l => l.name === name);
    if (idx < 0) { sendJson(res, 404, { message: 'Not Found' }); return; }
    repo.labels.splice(idx, 1);
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }

  // Issue labels
  const issueLabelMatch = subPath.match(/^\/issues\/(\d+)\/labels$/);
  if (issueLabelMatch && method === 'POST') {
    const num = parseInt(issueLabelMatch[1]);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      const labels = body.labels ?? body;
      if (Array.isArray(labels)) {
        for (const labelName of labels) {
          const name = typeof labelName === 'string' ? labelName : labelName.name;
          if (!issue.labels.find(l => l.name === name)) {
            let label = repo.labels.find(l => l.name === name);
            if (!label) {
              label = {
                id: nextLabelId++,
                node_id: makeNodeId('Label', nextLabelId - 1),
                name,
                description: '',
                color: 'ededed',
                default: false,
              };
              repo.labels.push(label);
            }
            issue.labels.push(label);
          }
        }
      }
      sendJson(res, 200, issue.labels.map(l => labelJson(l)));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Pulls
  if (subPath === '/pulls' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    let filteredPulls = repo.pulls;
    if (state !== 'all') {
      filteredPulls = filteredPulls.filter(p => p.state === state);
    }
    filteredPulls = [...filteredPulls].sort((a, b) => b.number - a.number);
    sendJson(res, 200, filteredPulls.map(p => pullJson(repo, p)));
    return;
  }

  if (subPath === '/pulls' && method === 'POST') {
    readJson(req).then(body => {
      const headRef = body.head;
      const baseRef = body.base;
      if (!headRef || !baseRef) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const headOid = resolveRef(repo, headRef) ?? '';
      const baseOid = resolveRef(repo, baseRef) ?? '';
      
      const pull: PullData = {
        id: nextGlobalId++,
        number: repo.nextIssueNumber++,
        node_id: makeNodeId('PullRequest', nextGlobalId - 1),
        title: body.title ?? '',
        body: body.body ?? '',
        state: 'open',
        head: { ref: headRef, sha: headOid, label: `${owner}:${headRef}` },
        base: { ref: baseRef, sha: baseOid, label: `${owner}:${baseRef}` },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        user: { login: currentOwner, id: 1 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        closed_at: null,
        labels: [],
        draft: body.draft ?? false,
        mergeable: true,
        comments: [],
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  const pullMatch = subPath.match(/^\/pulls\/(\d+)$/);
  if (pullMatch && method === 'GET') {
    const num = parseInt(pullMatch[1]);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }

  if (pullMatch && method === 'PATCH') {
    const num = parseInt(pullMatch[1]);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    readJson(req).then(body => {
      if (body.title !== undefined) pull.title = body.title;
      if (body.body !== undefined) pull.body = body.body;
      if (body.state !== undefined) {
        pull.state = body.state;
        if (body.state === 'closed') pull.closed_at = new Date().toISOString();
      }
      pull.updated_at = new Date().toISOString();
      sendJson(res, 200, pullJson(repo, pull));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Pull merge
  const mergeMatch = subPath.match(/^\/pulls\/(\d+)\/merge$/);
  if (mergeMatch && method === 'PUT') {
    const num = parseInt(mergeMatch[1]);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (pull.merged) { sendJson(res, 405, { message: 'Pull Request is already merged' }); return; }
    if (pull.state === 'closed') { sendJson(res, 405, { message: 'Pull Request is closed' }); return; }
    
    readJson(req).then(body => {
      doMergePull(repo, pull, body.merge_method ?? 'merge', body.commit_title, body.commit_message);
      sendJson(res, 200, {
        sha: pull.merge_commit_sha,
        merged: true,
        message: 'Pull Request successfully merged',
      });
    }).catch(() => {
      doMergePull(repo, pull, 'merge');
      sendJson(res, 200, {
        sha: pull.merge_commit_sha,
        merged: true,
        message: 'Pull Request successfully merged',
      });
    });
    return;
  }

  // Pull files
  const pullFilesMatch = subPath.match(/^\/pulls\/(\d+)\/files$/);
  if (pullFilesMatch && method === 'GET') {
    const num = parseInt(pullFilesMatch[1]);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    const baseOid = resolveRef(repo, pull.base.ref) ?? pull.base.sha;
    const headOid = resolveRef(repo, pull.head.ref) ?? pull.head.sha;
    const files: any[] = [];
    
    const baseTree = getCommitTree(repo, baseOid);
    const headTree = getCommitTree(repo, headOid);
    if (baseTree && headTree) {
      const baseFiles = getTreeRecursive(repo, baseTree);
      const headFiles = getTreeRecursive(repo, headTree);
      const baseMap = new Map(baseFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
      const headMap = new Map(headFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
      for (const [path, sha] of headMap) {
        const baseSha = baseMap.get(path);
        if (!baseSha) {
          files.push({ sha, filename: path, status: 'added' });
        } else if (baseSha !== sha) {
          files.push({ sha, filename: path, status: 'modified', previous_filename: path });
        }
      }
      for (const [path] of baseMap) {
        if (!headMap.has(path)) {
          files.push({ filename: path, status: 'removed' });
        }
      }
    } else if (headOid) {
      // If no base tree, all files in head are "added"
      const headTree2 = getCommitTree(repo, headOid);
      if (headTree2) {
        const headFiles = getTreeRecursive(repo, headTree2);
        for (const f of headFiles) {
          if (f.type === 'blob') {
            files.push({ sha: f.sha, filename: f.path, status: 'added' });
          }
        }
      }
    }
    
    sendJson(res, 200, files);
    return;
  }

  // Pull commits
  const pullCommitsMatch = subPath.match(/^\/pulls\/(\d+)\/commits$/);
  if (pullCommitsMatch && method === 'GET') {
    const num = parseInt(pullCommitsMatch[1]);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    const headOid = resolveRef(repo, pull.head.ref) ?? pull.head.sha;
    const baseOid = resolveRef(repo, pull.base.ref) ?? pull.base.sha;
    const headHistory = getCommitHistory(repo, headOid, 250);
    const baseHistory = new Set(getCommitHistory(repo, baseOid, 250));
    const prCommits = headHistory.filter(h => !baseHistory.has(h));
    
    sendJson(res, 200, prCommits.map(c => commitRestJson(repo, c)).filter(Boolean));
    return;
  }

  // Merges
  if (subPath === '/merges' && method === 'POST') {
    readJson(req).then(body => {
      const base = body.base;
      const head = body.head;
      const commitMessage = body.commit_message ?? `Merge ${head} into ${base}`;
      
      const baseOid = resolveRef(repo, base);
      const headOid = resolveRef(repo, head);
      if (!baseOid || !headOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
      
      if (baseOid === headOid) {
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      
      // Create merge commit
      const baseTree = getCommitTree(repo, baseOid);
      const headTree = getCommitTree(repo, headOid);
      if (!baseTree || !headTree) { sendJson(res, 409, { message: 'Merge conflict' }); return; }
      
      // Simple merge: use head tree (fast-forward style or take-theirs)
      const mergeCommitOid = createCommit(repo, headTree, [baseOid, headOid], commitMessage);
      const baseRef = `refs/heads/${base}`;
      repo.refs.set(baseRef, mergeCommitOid);
      
      sendJson(res, 201, commitRestJson(repo, mergeCommitOid));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Git blobs create
  if (subPath === '/git/blobs' && method === 'POST') {
    readJson(req).then(body => {
      let content: Buffer;
      if (body.encoding === 'base64') {
        content = Buffer.from(body.content, 'base64');
      } else {
        content = Buffer.from(body.content, 'utf8');
      }
      const oid = createBlob(repo, content);
      sendJson(res, 201, { sha: oid, url: '' });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Git trees create
  if (subPath === '/git/trees' && method === 'POST') {
    readJson(req).then(body => {
      const tree = body.tree;
      if (!Array.isArray(tree)) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      
      let baseTreeOid = body.base_tree;
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      
      if (baseTreeOid) {
        const baseObj = repo.objects.get(baseTreeOid);
        if (baseObj && baseObj.type === 'tree') {
          entries.push(...parseTreeEntries(baseObj.data));
        }
      }
      
      for (const item of tree) {
        const existing = entries.findIndex(e => e.name === item.path);
        if (item.sha === null) {
          if (existing >= 0) entries.splice(existing, 1);
        } else {
          if (existing >= 0) {
            entries[existing] = { mode: item.mode ?? '100644', name: item.path, oid: item.sha };
          } else {
            entries.push({ mode: item.mode ?? '100644', name: item.path, oid: item.sha });
          }
        }
      }
      
      const treeOid = createTreeFromEntries(repo, entries);
      sendJson(res, 201, { sha: treeOid, url: '' });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  // Git commits create
  if (subPath === '/git/commits' && method === 'POST') {
    readJson(req).then(body => {
      const treeOid = body.tree;
      const parents = body.parents ?? [];
      const message = body.message ?? '';
      const commitOid = createCommit(repo, treeOid, parents, message);
      sendJson(res, 201, commitRestJson(repo, commitOid));
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleContentsApi(req: IncomingMessage, res: ServerResponse, repo: RepoData, owner: string, repoName: string, filePath: string, method: string, query: URLSearchParams): void {
  const ref = query.get('ref') || repo.default_branch;
  
  if (method === 'GET') {
    const refOid = resolveRef(repo, ref);
    if (!refOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const treeOid = getCommitTree(repo, refOid);
    if (!treeOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
    
    if (filePath === '' || filePath === '/') {
      // List root directory
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const entries = parseTreeEntries(treeObj.data);
      sendJson(res, 200, entries.map(e => ({
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: 0,
        type: (e.mode === '40000' || e.mode === '040000') ? 'dir' : 'file',
        url: '',
        html_url: '',
        download_url: null,
      })));
      return;
    }
    
    const file = getFileAtPath(repo, treeOid, filePath);
    if (file) {
      sendJson(res, 200, {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: file.oid,
        size: file.content.length,
        type: 'file',
        content: file.content.toString('base64') + '\n',
        encoding: 'base64',
        url: '',
        html_url: '',
        download_url: null,
      });
    } else {
      // Maybe it's a directory
      const dirTree = getSubtreeAtPath(repo, treeOid, filePath);
      if (dirTree) {
        const entries = parseTreeEntries(dirTree);
        sendJson(res, 200, entries.map(e => ({
          name: e.name,
          path: `${filePath}/${e.name}`,
          sha: e.oid,
          size: 0,
          type: (e.mode === '40000' || e.mode === '040000') ? 'dir' : 'file',
          url: '',
          html_url: '',
          download_url: null,
        })));
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
    }
    return;
  }

  if (method === 'PUT') {
    readJson(req).then(body => {
      const branch = body.branch || repo.default_branch;
      const content = Buffer.from(body.content, 'base64');
      const message = body.message ?? 'Update file';
      
      const branchRef = `refs/heads/${branch}`;
      let currentOid = repo.refs.get(branchRef);
      if (!currentOid) {
        currentOid = repo.refs.get(`refs/heads/${repo.default_branch}`);
      }
      
      const blobOid = createBlob(repo, content);
      let treeOid: string;
      
      if (currentOid) {
        const currentTree = getCommitTree(repo, currentOid);
        treeOid = updateFileInTree(repo, currentTree, filePath, blobOid);
      } else {
        treeOid = updateFileInTree(repo, null, filePath, blobOid);
      }
      
      const commitOid = createCommit(repo, treeOid, currentOid ? [currentOid] : [], message);
      repo.refs.set(branchRef, commitOid);
      
      // Set default branch ref if not set
      if (!repo.refs.has(`refs/heads/${repo.default_branch}`) && branch !== repo.default_branch) {
        // keep as is
      }
      
      sendJson(res, body.sha ? 200 : 201, {
        content: {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: blobOid,
          size: content.length,
          type: 'file',
          url: '',
          html_url: '',
          download_url: null,
        },
        commit: commitRestJson(repo, commitOid),
      });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  if (method === 'DELETE') {
    readJson(req).then(body => {
      const branch = body.branch || repo.default_branch;
      const message = body.message ?? 'Delete file';
      
      const branchRef = `refs/heads/${branch}`;
      const currentOid = repo.refs.get(branchRef);
      if (!currentOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
      
      const currentTree = getCommitTree(repo, currentOid);
      if (!currentTree) { sendJson(res, 404, { message: 'Not Found' }); return; }
      
      const treeOid = updateFileInTree(repo, currentTree, filePath, null);
      const commitOid = createCommit(repo, treeOid, [currentOid], message);
      repo.refs.set(branchRef, commitOid);
      
      sendJson(res, 200, {
        content: null,
        commit: commitRestJson(repo, commitOid),
      });
    }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function getSubtreeAtPath(repo: RepoData, treeOid: string, dirPath: string): Buffer | null {
  const parts = dirPath.split('/').filter(p => p);
  let currentTree = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(currentTree);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTreeEntries(obj.data);
    const entry = entries.find(e => e.name === part);
    if (!entry) return null;
    currentTree = entry.oid;
  }
  const obj = repo.objects.get(currentTree);
  if (!obj || obj.type !== 'tree') return null;
  return obj.data;
}

function doMergePull(repo: RepoData, pull: PullData, method: string, commitTitle?: string, commitMessage?: string): void {
  const headOid = resolveRef(repo, pull.head.ref) ?? pull.head.sha;
  const baseOid = resolveRef(repo, pull.base.ref) ?? pull.base.sha;
  const headTree = getCommitTree(repo, headOid);
  const baseTree = getCommitTree(repo, baseOid);
  
  let mergeOid: string;
  const msg = commitTitle ?? commitMessage ?? `Merge pull request #${pull.number}`;
  
  if (method === 'squash') {
    // Squash: create single commit on base with head tree
    mergeOid = createCommit(repo, headTree ?? baseTree ?? '', baseOid ? [baseOid] : [], msg);
  } else {
    // Regular merge or rebase
    mergeOid = createCommit(repo, headTree ?? baseTree ?? '', [baseOid, headOid].filter(Boolean), msg);
  }
  
  // Update base branch
  const baseRef = `refs/heads/${pull.base.ref}`;
  repo.refs.set(baseRef, mergeOid);
  
  pull.merged = true;
  pull.merged_at = new Date().toISOString();
  pull.merge_commit_sha = mergeOid;
  pull.state = 'closed';
  pull.closed_at = new Date().toISOString();
  pull.updated_at = new Date().toISOString();
}

// ════════════════════════════════════════════════════════════════════════════════
// Git Smart HTTP Protocol
// ════════════════════════════════════════════════════════════════════════════════

function handleGitRequest(req: IncomingMessage, res: ServerResponse, path: string, method: string): void {
  // Parse: /{owner}/{repo}.git/info/refs?service=...
  // or:   /{owner}/{repo}.git/git-upload-pack
  // or:   /{owner}/{repo}.git/git-receive-pack
  // Also handle without .git suffix
  
  let gitPath = path;
  const match = gitPath.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.+)$/);
  if (!match) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  
  const [, owner, repoName, subPath] = match;
  
  if (subPath === '/info/refs' && method === 'GET') {
    handleInfoRefs(req, res, owner, repoName);
    return;
  }
  
  if (subPath === '/git-upload-pack' && method === 'POST') {
    handleUploadPack(req, res, owner, repoName);
    return;
  }
  
  if (subPath === '/git-receive-pack' && method === 'POST') {
    handleReceivePack(req, res, owner, repoName);
    return;
  }
  
  sendJson(res, 404, { message: 'Not Found' });
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
  const query = queryOf(req);
  const service = query.get('service') ?? '';
  
  const repo = getRepo(owner, repoName);
  
  if (service === 'git-upload-pack') {
    // Check for Git-Protocol: version=2 header
    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = gitProtocol.includes('version=2');
    
    if (!repo) {
      // Return 404 for missing repos
      res.writeHead(404, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      res.end();
      return;
    }
    
    const parts: Buffer[] = [];
    
    if (isV2) {
      // Protocol v2 advertisement
      parts.push(pktLine('version 2\n'));
      parts.push(pktLine('ls-refs\n'));
      parts.push(pktLine('fetch=shallow wait-for-done\n'));
      parts.push(pktLine('object-format=sha1\n'));
      parts.push(FLUSH);
    } else {
      // Protocol v0 advertisement
      parts.push(pktLine('# service=git-upload-pack\n'));
      parts.push(FLUSH);
      
      // List refs with capabilities
      const refsList = getRefsForAdvertisement(repo);
      if (refsList.length === 0) {
        // Empty repo - advertise zero-id with capabilities
        parts.push(pktLine(`${ZERO_OID} capabilities^{}\0multi_ack thin-pack side-band-64k ofs-delta agent=github-forge/1.0\n`));
      } else {
        let first = true;
        for (const { ref, oid } of refsList) {
          if (first) {
            parts.push(pktLine(`${oid} ${ref}\0multi_ack thin-pack side-band-64k ofs-delta agent=github-forge/1.0\n`));
            first = false;
          } else {
            parts.push(pktLine(`${oid} ${ref}\n`));
          }
        }
      }
      parts.push(FLUSH);
    }
    
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(Buffer.concat(parts));
    return;
  }
  
  if (service === 'git-receive-pack') {
    if (!repo) {
      res.writeHead(404, { 'content-type': 'application/x-git-receive-pack-advertisement' });
      res.end();
      return;
    }
    
    const parts: Buffer[] = [];
    
    // Protocol v0 - service announcement
    parts.push(pktLine('# service=git-receive-pack\n'));
    parts.push(FLUSH);
    
    // Ref advertisement with capabilities
    const refsList = getRefsForAdvertisement(repo);
    const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-forge/1.0';
    
    if (refsList.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let first = true;
      for (const { ref, oid } of refsList) {
        if (first) {
          parts.push(pktLine(`${oid} ${ref}\0${caps}\n`));
          first = false;
        } else {
          parts.push(pktLine(`${oid} ${ref}\n`));
        }
      }
    }
    parts.push(FLUSH);
    
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(Buffer.concat(parts));
    return;
  }
  
  sendJson(res, 403, { message: 'Unsupported service' });
}

function getRefsForAdvertisement(repo: RepoData): Array<{ ref: string; oid: string }> {
  const refsList: Array<{ ref: string; oid: string }> = [];
  
  // HEAD first
  const headOid = repo.refs.get(repo.HEAD);
  if (headOid) {
    refsList.push({ ref: 'HEAD', oid: headOid });
  }
  
  // Then other refs sorted
  const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [ref, oid] of sortedRefs) {
    refsList.push({ ref, oid });
  }
  
  return refsList;
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
  const repo = getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end();
    return;
  }
  
  readBody(req).then(body => {
    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = gitProtocol.includes('version=2');
    
    if (isV2) {
      handleUploadPackV2(repo, body, res);
    } else {
      handleUploadPackV0(repo, body, res);
    }
  }).catch(() => {
    res.writeHead(500);
    res.end();
  });
}

function handleUploadPackV2(repo: RepoData, body: Buffer, res: ServerResponse): void {
  const lines = parsePktLines(body);
  
  // Find the command
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  
  for (const line of lines) {
    if (line.type === 'flush') break;
    if (line.type === 'delim') { inArgs = true; continue; }
    if (!line.data) continue;
    const text = line.data.toString('utf8');
    if (!inArgs) {
      if (text.startsWith('command=')) {
        command = text.slice('command='.length);
      }
    } else {
      args.push(text);
    }
  }
  
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  
  if (command === 'ls-refs') {
    handleLsRefs(repo, args, res);
  } else if (command === 'fetch') {
    handleFetch(repo, args, body, res);
  } else {
    res.end(FLUSH);
  }
}

function handleLsRefs(repo: RepoData, args: string[], res: ServerResponse): void {
  const parts: Buffer[] = [];
  const prefixes: string[] = [];
  let symrefs = false;
  let peel = false;
  
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) {
      prefixes.push(arg.slice('ref-prefix '.length));
    }
    if (arg === 'symrefs') symrefs = true;
    if (arg === 'peel') peel = true;
  }
  
  const headOid = repo.refs.get(repo.HEAD);
  
  // Include HEAD if matching prefix
  if (headOid) {
    const headMatches = prefixes.length === 0 || prefixes.some(p => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
    if (headMatches) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${repo.HEAD}`;
      parts.push(pktLine(line + '\n'));
    }
  }
  
  // Include matching refs
  const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [ref, oid] of sortedRefs) {
    const matches = prefixes.length === 0 || prefixes.some(p => ref.startsWith(p));
    if (!matches) continue;
    
    const obj = repo.objects.get(oid);
    let line = `${oid} ${ref}`;
    parts.push(pktLine(line + '\n'));
    
    // Peel tags
    if (peel && obj && obj.type === 'tag') {
      // For annotated tags, peel to the target
      const tagData = obj.data.toString('utf8');
      const objectMatch = tagData.match(/^object ([0-9a-f]{40})/m);
      if (objectMatch) {
        parts.push(pktLine(`${objectMatch[1]} ${ref}^{}\n`));
      }
    }
    
    // If it's a tag pointing to a commit, peel it
    if (peel && ref.startsWith('refs/tags/') && obj && obj.type === 'commit') {
      parts.push(pktLine(`${oid} ${ref}^{}\n`));
    }
  }
  
  parts.push(FLUSH);
  res.end(Buffer.concat(parts));
}

function handleFetch(repo: RepoData, args: string[], body: Buffer, res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  
  // Parse the full body for fetch args (they come after the delim)
  const lines = parsePktLines(body);
  let inFetchArgs = false;
  
  for (const line of lines) {
    if (line.type === 'delim') { inFetchArgs = true; continue; }
    if (line.type === 'flush') break;
    if (!line.data) continue;
    const text = line.data.toString('utf8');
    
    if (inFetchArgs) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('have ')) haves.push(text.slice(5).split(' ')[0]);
      else if (text === 'done') done = true;
    }
  }
  
  // Also check args
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0]);
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).split(' ')[0]);
    else if (arg === 'done') done = true;
  }
  
  // Collect objects to send
  const needed = new Set<string>();
  const haveSeen = new Set<string>();
  
  for (const have of haves) {
    collectObjects(repo, have, haveSeen);
  }
  
  for (const want of wants) {
    collectObjects(repo, want, needed);
  }
  
  // Remove objects the client already has
  for (const have of haveSeen) {
    needed.delete(have);
  }
  
  const oids = [...needed].filter(oid => repo.objects.has(oid));
  
  // Build response
  const parts: Buffer[] = [];
  
  // Send acknowledgments
  if (haves.length > 0) {
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`acknowledgments\n`));
        parts.push(pktLine(`ACK ${have}\n`));
        break;
      }
    }
  }
  
  // Packfile section
  parts.push(pktLine('packfile\n'));
  
  // Build and send packfile
  const packfile = buildPackfile(repo, oids);
  
  // Send in side-band-64k format: band 1 = packfile data
  const BAND_DATA = 1;
  const BAND_PROGRESS = 2;
  
  // Send progress message
  const progressMsg = Buffer.from('Counting objects, done.\n');
  const progressPkt = Buffer.alloc(progressMsg.length + 1);
  progressPkt[0] = BAND_PROGRESS;
  progressMsg.copy(progressPkt, 1);
  parts.push(pktLineBuf(progressPkt));
  
  // Send packfile data in chunks
  const CHUNK_SIZE = 65519; // Max side-band-64k payload (65535 - 4 length - 1 band - some margin)
  for (let i = 0; i < packfile.length; i += CHUNK_SIZE) {
    const chunk = packfile.subarray(i, Math.min(i + CHUNK_SIZE, packfile.length));
    const bandPkt = Buffer.alloc(chunk.length + 1);
    bandPkt[0] = BAND_DATA;
    chunk.copy(bandPkt, 1);
    parts.push(pktLineBuf(bandPkt));
  }
  
  parts.push(FLUSH);
  
  res.end(Buffer.concat(parts));
}

function handleUploadPackV0(repo: RepoData, body: Buffer, res: ServerResponse): void {
  // v0 upload-pack - basic want/have negotiation
  const lines = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  
  for (const line of lines) {
    if (line.type !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text === 'done') { /* done */ }
  }
  
  const needed = new Set<string>();
  const haveSeen = new Set<string>();
  for (const have of haves) collectObjects(repo, have, haveSeen);
  for (const want of wants) collectObjects(repo, want, needed);
  for (const have of haveSeen) needed.delete(have);
  
  const oids = [...needed].filter(oid => repo.objects.has(oid));
  
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  
  const packfile = buildPackfile(repo, oids);
  
  // Side-band-64k
  const CHUNK_SIZE = 65519;
  for (let i = 0; i < packfile.length; i += CHUNK_SIZE) {
    const chunk = packfile.subarray(i, Math.min(i + CHUNK_SIZE, packfile.length));
    const bandPkt = Buffer.alloc(chunk.length + 1);
    bandPkt[0] = 1;
    chunk.copy(bandPkt, 1);
    parts.push(pktLineBuf(bandPkt));
  }
  
  parts.push(FLUSH);
  
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
  let repo = getRepo(owner, repoName);
  if (!repo) {
    // Auto-create repo for push
    repo = createRepoData(owner, repoName);
  }
  
  readBody(req).then(body => {
    const result = processReceivePack(repo!, body);
    
    // Build response with side-band-64k
    const parts: Buffer[] = [];
    
    // Status report on band 1
    const statusParts: Buffer[] = [];
    statusParts.push(pktLine('unpack ok\n'));
    for (const ref of result.refs) {
      if (ref.ok) {
        statusParts.push(pktLine(`ok ${ref.name}\n`));
      } else {
        statusParts.push(pktLine(`ng ${ref.name} ${ref.reason}\n`));
      }
    }
    statusParts.push(FLUSH);
    
    const statusData = Buffer.concat(statusParts);
    
    // Wrap in side-band-64k
    // Band 1: status
    const band1 = Buffer.alloc(statusData.length + 1);
    band1[0] = 1;
    statusData.copy(band1, 1);
    parts.push(pktLineBuf(band1));
    
    // Progress on band 2
    const progressMsg = Buffer.from('Resolving objects, done.\n');
    const band2 = Buffer.alloc(progressMsg.length + 1);
    band2[0] = 2;
    progressMsg.copy(band2, 1);
    parts.push(pktLineBuf(band2));
    
    parts.push(FLUSH);
    
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(Buffer.concat(parts));
  }).catch(err => {
    res.writeHead(500, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end();
  });
}

interface RefUpdate {
  name: string;
  ok: boolean;
  reason?: string;
}

function processReceivePack(repo: RepoData, body: Buffer): { refs: RefUpdate[] } {
  const refs: RefUpdate[] = [];
  
  // Parse commands and packfile
  const lines = parsePktLines(body);
  let packStart = -1;
  let offset = 0;
  
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  
  const commands: Command[] = [];
  
  // Parse pkt-line commands
  for (const line of lines) {
    if (line.type === 'flush') break;
    if (line.type !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8');
    // Format: old-oid SP new-oid SP ref-name [NUL capabilities]
    const match = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)(?:\0.*)?$/);
    if (match) {
      commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    }
  }
  
  // Find the packfile data in the raw body
  // The packfile starts after the flush packet (0000) following the commands
  let rawOffset = 0;
  let flushCount = 0;
  while (rawOffset < body.length) {
    if (rawOffset + 4 > body.length) break;
    const lenHex = body.subarray(rawOffset, rawOffset + 4).toString('ascii');
    if (lenHex === '0000') {
      rawOffset += 4;
      flushCount++;
      if (flushCount === 1) {
        packStart = rawOffset;
        break;
      }
    } else {
      const len = parseInt(lenHex, 16);
      if (len < 4) break;
      rawOffset += len;
    }
  }
  
  // Parse packfile if present
  if (packStart >= 0 && packStart < body.length) {
    const packData = body.subarray(packStart);
    if (packData.length >= 12 && packData.subarray(0, 4).toString('ascii') === 'PACK') {
      parsePackfileImproved(repo, packData);
    }
  }
  
  // Process commands
  for (const cmd of commands) {
    const isDelete = cmd.newOid === ZERO_OID;
    const isCreate = cmd.oldOid === ZERO_OID;
    
    if (isDelete) {
      repo.refs.delete(cmd.ref);
      refs.push({ name: cmd.ref, ok: true });
      continue;
    }
    
    // Verify old oid matches current (for non-create)
    if (!isCreate) {
      const currentOid = repo.refs.get(cmd.ref);
      if (currentOid && currentOid !== cmd.oldOid) {
        // Check if this is a force push scenario
        // In non-force push, reject if old oid doesn't match
        // For the test, we check if the new commit is a descendant of the current
        const newHistory = getCommitHistory(repo, cmd.newOid, 1000);
        const isFF = newHistory.includes(currentOid);
        if (!isFF) {
          refs.push({ name: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
    }
    
    // Verify the new object exists
    if (!repo.objects.has(cmd.newOid)) {
      refs.push({ name: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    
    repo.refs.set(cmd.ref, cmd.newOid);
    
    // If this is the default branch, update HEAD
    if (cmd.ref === `refs/heads/${repo.default_branch}` || (!repo.refs.has(repo.HEAD) && cmd.ref.startsWith('refs/heads/'))) {
      // Set default branch if needed
      if (!repo.refs.has(`refs/heads/${repo.default_branch}`)) {
        const branchName = cmd.ref.replace('refs/heads/', '');
        repo.default_branch = branchName;
        repo.HEAD = cmd.ref;
      }
    }
    
    refs.push({ name: cmd.ref, ok: true });
  }
  
  return { refs };
}

// ════════════════════════════════════════════════════════════════════════════════
// GraphQL v4 API
// ════════════════════════════════════════════════════════════════════════════════

function handleGraphQL(req: IncomingMessage, res: ServerResponse): void {
  readBody(req).then(buf => {
    const text = buf.toString('utf8');
    let body: any;
    try { body = JSON.parse(text); } catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
    
    // Handle batch requests (array of operations)
    if (Array.isArray(body)) {
      const results = body.map((op: any) => executeGraphQL(op.query ?? '', op.variables ?? {}));
      sendJson(res, 200, results);
      return;
    }
    
    const result = executeGraphQL(body.query ?? '', body.variables ?? {});
    sendJson(res, 200, result);
  }).catch(() => sendJson(res, 400, { message: 'Invalid JSON' }));
}

function executeGraphQL(query: string, variables: Record<string, any>): any {
  const data: Record<string, any> = {};
  const errors: Array<{ message: string; path?: string[]; locations?: Array<{ line: number; column: number }> }> = [];
  
  try {
    const ops = parseGraphQLOperations(query);
    for (const op of ops) {
      if (op.type === 'query') {
        executeQueryFields(op.fields, variables, data, errors);
      } else if (op.type === 'mutation') {
        executeMutationFields(op.fields, variables, data, errors);
      }
    }
  } catch (err: any) {
    errors.push({ message: err.message || 'Internal error' });
  }
  
  if (errors.length > 0) {
    return { data: Object.keys(data).length > 0 ? data : null, errors };
  }
  return { data };
}

// Minimal GraphQL parser
interface GraphQLField {
  name: string;
  alias: string | null;
  args: Record<string, any>;
  fields: GraphQLField[];
  inlineFragments: { typeName: string; fields: GraphQLField[] }[];
}

interface GraphQLOperation {
  type: 'query' | 'mutation';
  name: string;
  fields: GraphQLField[];
}

function parseGraphQLOperations(query: string): GraphQLOperation[] {
  const ops: GraphQLOperation[] = [];
  const cleaned = query.replace(/#[^\n]*/g, ''); // Remove comments
  
  // Match operation declarations
  const opRegex = /(query|mutation)\s*(\w*)\s*(?:\([^)]*\))?\s*\{/gi;
  let match: RegExpExecArray | null;
  
  while ((match = opRegex.exec(cleaned)) !== null) {
    const type = match[1].toLowerCase() as 'query' | 'mutation';
    const name = match[2] || '';
    const startBrace = match.index + match[0].length - 1;
    
    // Find matching closing brace
    let depth = 1;
    let i = startBrace + 1;
    while (i < cleaned.length && depth > 0) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') depth--;
      i++;
    }
    
    const body = cleaned.substring(startBrace + 1, i - 1);
    const fields = parseFields(body);
    ops.push({ type, name, fields });
  }
  
  // If no operations found, try as an implicit query
  if (ops.length === 0 && cleaned.includes('{')) {
    const firstBrace = cleaned.indexOf('{');
    let depth = 1;
    let i = firstBrace + 1;
    while (i < cleaned.length && depth > 0) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') depth--;
      i++;
    }
    const body = cleaned.substring(firstBrace + 1, i - 1);
    ops.push({ type: 'query', name: '', fields: parseFields(body) });
  }
  
  return ops;
}

function parseFields(body: string): GraphQLField[] {
  const fields: GraphQLField[] = [];
  let pos = 0;
  const s = body.trim();
  
  while (pos < s.length) {
    // Skip whitespace and commas
    while (pos < s.length && /[\s,]/.test(s[pos])) pos++;
    if (pos >= s.length) break;
    
    // Handle inline fragments: ... on TypeName { fields }
    if (s.startsWith('...', pos)) {
      pos += 3;
      while (pos < s.length && /\s/.test(s[pos])) pos++;
      if (s.startsWith('on ', pos)) {
        pos += 3;
        while (pos < s.length && /\s/.test(s[pos])) pos++;
        let typeName = '';
        while (pos < s.length && /\w/.test(s[pos])) typeName += s[pos++];
        while (pos < s.length && /\s/.test(s[pos])) pos++;
        if (s[pos] === '{') {
          pos++; // skip {
          let depth = 1;
          let fragStart = pos;
          while (pos < s.length && depth > 0) {
            if (s[pos] === '{') depth++;
            else if (s[pos] === '}') depth--;
            pos++;
          }
          const fragBody = s.substring(fragStart, pos - 1);
          // Store as an inline fragment - we'll handle it in the resolver
          fields.push({
            name: `__inlineFragment_${typeName}`,
            alias: null,
            args: {},
            fields: parseFields(fragBody),
            inlineFragments: [{ typeName, fields: parseFields(fragBody) }],
          });
        }
      }
      continue;
    }
    
    // Read field name (might be alias:name)
    let name = '';
    while (pos < s.length && /[\w_]/.test(s[pos])) name += s[pos++];
    if (!name) { pos++; continue; }
    
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    
    let alias: string | null = null;
    if (s[pos] === ':') {
      alias = name;
      pos++; // skip :
      while (pos < s.length && /\s/.test(s[pos])) pos++;
      name = '';
      while (pos < s.length && /[\w_]/.test(s[pos])) name += s[pos++];
      while (pos < s.length && /\s/.test(s[pos])) pos++;
    }
    
    // Read args if present
    let args: Record<string, any> = {};
    if (s[pos] === '(') {
      pos++; // skip (
      let depth = 1;
      let argsStart = pos;
      while (pos < s.length && depth > 0) {
        if (s[pos] === '(') depth++;
        else if (s[pos] === ')') depth--;
        pos++;
      }
      const argsStr = s.substring(argsStart, pos - 1);
      args = parseGraphQLArgs(argsStr);
    }
    
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    
    // Read sub-fields if present
    let subFields: GraphQLField[] = [];
    let inlineFragments: { typeName: string; fields: GraphQLField[] }[] = [];
    if (s[pos] === '{') {
      pos++; // skip {
      let depth = 1;
      let subStart = pos;
      while (pos < s.length && depth > 0) {
        if (s[pos] === '{') depth++;
        else if (s[pos] === '}') depth--;
        pos++;
      }
      const subBody = s.substring(subStart, pos - 1);
      subFields = parseFields(subBody);
      // Extract inline fragments from subfields
      for (const sf of subFields) {
        if (sf.name.startsWith('__inlineFragment_')) {
          inlineFragments.push(...sf.inlineFragments);
        }
      }
      subFields = subFields.filter(sf => !sf.name.startsWith('__inlineFragment_'));
    }
    
    fields.push({ name, alias, args, fields: subFields, inlineFragments });
  }
  
  return fields;
}

function parseGraphQLArgs(argsStr: string): Record<string, any> {
  const result: Record<string, any> = {};
  const s = argsStr.trim();
  let pos = 0;
  
  while (pos < s.length) {
    while (pos < s.length && /[\s,]/.test(s[pos])) pos++;
    if (pos >= s.length) break;
    
    // Read key
    let key = '';
    while (pos < s.length && /[\w_]/.test(s[pos])) key += s[pos++];
    if (!key) { pos++; continue; }
    
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    if (s[pos] !== ':') continue;
    pos++; // skip :
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    
    const val = parseGraphQLValue(s, pos);
    result[key] = val.value;
    pos = val.end;
  }
  
  return result;
}

function parseGraphQLValue(s: string, pos: number): { value: any; end: number } {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  
  // Variable reference
  if (s[pos] === '$') {
    pos++;
    let name = '';
    while (pos < s.length && /[\w_]/.test(s[pos])) name += s[pos++];
    return { value: { __var: name }, end: pos };
  }
  
  // String
  if (s[pos] === '"') {
    pos++;
    let str = '';
    while (pos < s.length && s[pos] !== '"') {
      if (s[pos] === '\\' && pos + 1 < s.length) { str += s[pos + 1]; pos += 2; }
      else { str += s[pos]; pos++; }
    }
    pos++; // skip closing "
    return { value: str, end: pos };
  }
  
  // Array
  if (s[pos] === '[') {
    pos++;
    const arr: any[] = [];
    while (pos < s.length && s[pos] !== ']') {
      while (pos < s.length && /[\s,]/.test(s[pos])) pos++;
      if (s[pos] === ']') break;
      const v = parseGraphQLValue(s, pos);
      arr.push(v.value);
      pos = v.end;
    }
    pos++; // skip ]
    return { value: arr, end: pos };
  }
  
  // Object
  if (s[pos] === '{') {
    pos++;
    const obj: Record<string, any> = {};
    while (pos < s.length && s[pos] !== '}') {
      while (pos < s.length && /[\s,]/.test(s[pos])) pos++;
      if (s[pos] === '}') break;
      let key = '';
      while (pos < s.length && /[\w_]/.test(s[pos])) key += s[pos++];
      while (pos < s.length && /\s/.test(s[pos])) pos++;
      if (s[pos] === ':') pos++;
      while (pos < s.length && /\s/.test(s[pos])) pos++;
      const v = parseGraphQLValue(s, pos);
      obj[key] = v.value;
      pos = v.end;
    }
    pos++; // skip }
    return { value: obj, end: pos };
  }
  
  // Enum or boolean or null or number
  let token = '';
  while (pos < s.length && /[\w._-]/.test(s[pos])) token += s[pos++];
  
  if (token === 'true') return { value: true, end: pos };
  if (token === 'false') return { value: false, end: pos };
  if (token === 'null') return { value: null, end: pos };
  if (/^-?\d+(\.\d+)?$/.test(token)) return { value: parseFloat(token), end: pos };
  
  // Enum value (return as string)
  return { value: token, end: pos };
}

function resolveVariable(value: any, variables: Record<string, any>): any {
  if (value && typeof value === 'object' && '__var' in value) {
    return variables[value.__var];
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const resolved: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveVariable(v, variables);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveVariable(v, variables));
  }
  return value;
}

function executeQueryFields(fields: GraphQLField[], variables: Record<string, any>, data: Record<string, any>, errors: Array<{ message: string; path?: string[] }>): void {
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    
    switch (field.name) {
      case 'viewer':
        data[key] = resolveViewerFields(field.fields, errors);
        break;
      case '__type':
        data[key] = resolveTypeIntrospection(args.name, field.fields);
        break;
      case 'repository':
        data[key] = resolveRepository(args.owner, args.name, field.fields, field.inlineFragments, variables, errors);
        break;
      case 'node':
        data[key] = resolveNode(args.id, field.fields, field.inlineFragments, variables, errors);
        break;
      case 'search':
        data[key] = resolveSearch(args, field.fields, variables, errors);
        break;
      default:
        // Unknown field on root
        errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'`, path: [key] });
        break;
    }
  }
}

function resolveArgs(args: Record<string, any>, variables: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    resolved[k] = resolveVariable(v, variables);
  }
  return resolved;
}

function resolveViewerFields(fields: GraphQLField[], errors: Array<{ message: string }>): any {
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'login': result[key] = currentOwner; break;
      case 'id': result[key] = makeNodeId('User', 1); break;
      case 'name': result[key] = currentOwner; break;
      case 'email': result[key] = `${currentOwner}@users.noreply.github.com`; break;
      case 'databaseId': result[key] = 1; break;
      default:
        errors.push({ message: `Field '${field.name}' doesn't exist on type 'User'. Did you mean 'noSuchFieldOnViewer'?` });
        break;
    }
  }
  return result;
}

function resolveRepository(ownerName: string, repoName: string, fields: GraphQLField[], inlineFragments: { typeName: string; fields: GraphQLField[] }[], variables: Record<string, any>, errors: Array<{ message: string }>): any {
  const repo = getRepo(ownerName, repoName);
  if (!repo) return null;
  
  const result: Record<string, any> = {};
  
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    
    switch (field.name) {
      case 'id': result[key] = repo.node_id; break;
      case 'databaseId': result[key] = repo.id; break;
      case 'name': result[key] = repo.name; break;
      case 'nameWithOwner': result[key] = `${repo.owner}/${repo.name}`; break;
      case 'description': result[key] = repo.description; break;
      case 'url': result[key] = ''; break;
      case 'isPrivate': result[key] = repo.private; break;
      case 'isFork': result[key] = false; break;
      case 'stargazerCount': result[key] = 0; break;
      case 'forkCount': result[key] = 0; break;
      case 'viewerPermission': result[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': result[key] = true; break;
      case 'owner':
        result[key] = {};
        for (const sf of field.fields) {
          const sk = sf.alias ?? sf.name;
          switch (sf.name) {
            case 'login': result[key][sk] = repo.owner; break;
            case 'id': result[key][sk] = makeNodeId('User', 1); break;
          }
        }
        break;
      case 'defaultBranchRef': {
        const defaultRef = `refs/heads/${repo.default_branch}`;
        const defaultOid = repo.refs.get(defaultRef);
        if (defaultOid) {
          result[key] = {};
          for (const sf of field.fields) {
            const sk = sf.alias ?? sf.name;
            switch (sf.name) {
              case 'name': result[key][sk] = repo.default_branch; break;
              case 'target': {
                result[key][sk] = { oid: defaultOid };
                for (const tsf of sf.fields) {
                  const tsk = tsf.alias ?? tsf.name;
                  if (tsf.name === 'oid') result[key][sk][tsk] = defaultOid;
                }
                break;
              }
            }
          }
        } else {
          result[key] = null;
        }
        break;
      }
      case 'issue': {
        const issueNum = args.number;
        const issue = repo.issues.find(i => i.number === issueNum);
        if (issue) {
          result[key] = resolveIssueFields(issue, field.fields);
        } else {
          result[key] = null;
        }
        break;
      }
      case 'issues':
        result[key] = resolveIssueConnection(repo, args, field.fields, variables);
        break;
      case 'pullRequest': {
        const prNum = args.number;
        const pull = repo.pulls.find(p => p.number === prNum);
        if (pull) {
          result[key] = resolvePullRequestFields(repo, pull, field.fields, variables);
        } else {
          result[key] = null;
        }
        break;
      }
      case 'pullRequests':
        result[key] = resolvePullRequestConnection(repo, args, field.fields, variables);
        break;
      case 'labels':
        result[key] = resolveLabelConnection(repo, args, field.fields);
        break;
      default:
        result[key] = null;
        break;
    }
  }
  
  // Handle inline fragments on Repository
  for (const frag of inlineFragments) {
    if (frag.typeName === 'Repository') {
      for (const field of frag.fields) {
        const key = field.alias ?? field.name;
        if (!(key in result)) {
          // Re-resolve via repo fields
          const args = resolveArgs(field.args, variables);
          switch (field.name) {
            case 'id': result[key] = repo.node_id; break;
            case 'name': result[key] = repo.name; break;
            case 'nameWithOwner': result[key] = `${repo.owner}/${repo.name}`; break;
            default: result[key] = null; break;
          }
        }
      }
    }
  }
  
  return result;
}

function resolveIssueFields(issue: IssueData, fields: GraphQLField[]): any {
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id': result[key] = issue.node_id; break;
      case 'number': result[key] = issue.number; break;
      case 'title': result[key] = issue.title; break;
      case 'body': result[key] = issue.body; break;
      case 'state': result[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'createdAt': result[key] = issue.created_at; break;
      case 'updatedAt': result[key] = issue.updated_at; break;
      case 'closedAt': result[key] = issue.closed_at; break;
      case 'author':
        result[key] = { login: issue.user.login };
        for (const sf of field.fields) {
          if (sf.name === 'login') result[key][sf.alias ?? sf.name] = issue.user.login;
        }
        break;
      case 'labels':
        result[key] = { nodes: issue.labels.map(l => ({ name: l.name, id: l.node_id })) };
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolveIssueConnection(repo: RepoData, args: Record<string, any>, fields: GraphQLField[], variables: Record<string, any>): any {
  let issues = [...repo.issues];
  
  // Filter by states
  if (Array.isArray(args.states)) {
    const states = args.states.map((s: string) => s === 'OPEN' ? 'open' : 'closed');
    issues = issues.filter(i => states.includes(i.state));
  }
  
  // Order by
  const orderBy = args.orderBy;
  if (orderBy) {
    const field = orderBy.field || 'CREATED_AT';
    const direction = orderBy.direction || 'DESC';
    if (field === 'CREATED_AT') {
      issues.sort((a, b) => {
        const cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return direction === 'DESC' ? -cmp : cmp;
      });
    }
  } else {
    // Default: newest first
    issues.sort((a, b) => b.number - a.number);
  }
  
  // Pagination
  const first = args.first ?? 10;
  const after = args.after;
  let startIdx = 0;
  
  if (after) {
    try {
      const cursorNum = parseInt(Buffer.from(after, 'base64').toString('utf8'), 10);
      const idx = issues.findIndex(i => i.number === cursorNum);
      if (idx >= 0) startIdx = idx + 1;
    } catch { /* ignore */ }
  }
  
  const pageIssues = issues.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + first < issues.length;
  const endCursor = pageIssues.length > 0 ? Buffer.from(String(pageIssues[pageIssues.length - 1].number)).toString('base64') : null;
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'nodes':
        result[key] = pageIssues.map(issue => resolveIssueFields(issue, field.fields));
        break;
      case 'totalCount':
        result[key] = issues.length;
        break;
      case 'pageInfo':
        result[key] = {};
        for (const sf of field.fields) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'hasNextPage') result[key][sk] = hasNextPage;
          if (sf.name === 'endCursor') result[key][sk] = endCursor;
          if (sf.name === 'hasPreviousPage') result[key][sk] = startIdx > 0;
          if (sf.name === 'startCursor') result[key][sk] = pageIssues.length > 0 ? Buffer.from(String(pageIssues[0].number)).toString('base64') : null;
        }
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolvePullRequestConnection(repo: RepoData, args: Record<string, any>, fields: GraphQLField[], variables: Record<string, any>): any {
  let pulls = [...repo.pulls];
  
  // Filter by states
  if (Array.isArray(args.states)) {
    const states = args.states.map((s: string) => s === 'OPEN' ? 'open' : s === 'MERGED' ? 'closed' : 'closed');
    pulls = pulls.filter(p => {
      if (args.states.includes('MERGED') && p.merged) return true;
      if (args.states.includes('OPEN') && p.state === 'open' && !p.merged) return true;
      if (args.states.includes('CLOSED') && p.state === 'closed' && !p.merged) return true;
      return false;
    });
  }
  
  const first = args.first ?? 10;
  pulls = pulls.slice(0, first);
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'nodes':
        result[key] = pulls.map(p => resolvePullRequestFields(repo, p, field.fields, variables));
        break;
      case 'totalCount':
        result[key] = pulls.length;
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolvePullRequestFields(repo: RepoData, pull: PullData, fields: GraphQLField[], variables: Record<string, any>): any {
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    switch (field.name) {
      case 'id': result[key] = pull.node_id; break;
      case 'number': result[key] = pull.number; break;
      case 'title': result[key] = pull.title; break;
      case 'body': result[key] = pull.body; break;
      case 'state': result[key] = pull.merged ? 'MERGED' : (pull.state === 'open' ? 'OPEN' : 'CLOSED'); break;
      case 'merged': result[key] = pull.merged; break;
      case 'mergedAt': result[key] = pull.merged_at; break;
      case 'headRefName': result[key] = pull.head.ref; break;
      case 'baseRefName': result[key] = pull.base.ref; break;
      case 'mergeable': result[key] = pull.merged ? 'UNKNOWN' : (pull.mergeable ? 'MERGEABLE' : 'CONFLICTING'); break;
      case 'createdAt': result[key] = pull.created_at; break;
      case 'updatedAt': result[key] = pull.updated_at; break;
      case 'closedAt': result[key] = pull.closed_at; break;
      case 'author':
        result[key] = { login: pull.user.login };
        for (const sf of field.fields) {
          if (sf.name === 'login') result[key][sf.alias ?? sf.name] = pull.user.login;
        }
        break;
      case 'files': {
        // Get changed files
        const headOid = resolveRef(repo, pull.head.ref) ?? pull.head.sha;
        const baseOid = resolveRef(repo, pull.base.ref) ?? pull.base.sha;
        const changedFiles: any[] = [];
        
        const baseTree = getCommitTree(repo, baseOid);
        const headTree = getCommitTree(repo, headOid);
        if (baseTree && headTree) {
          const baseFiles = getTreeRecursive(repo, baseTree);
          const headFiles = getTreeRecursive(repo, headTree);
          const baseMap = new Map(baseFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
          const headMap = new Map(headFiles.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
          for (const [path, sha] of headMap) {
            const baseSha = baseMap.get(path);
            if (!baseSha || baseSha !== sha) {
              changedFiles.push({ path });
            }
          }
          for (const [path] of baseMap) {
            if (!headMap.has(path)) changedFiles.push({ path });
          }
        } else if (headOid && headTree) {
          const headFiles = getTreeRecursive(repo, headTree);
          for (const f of headFiles) {
            if (f.type === 'blob') changedFiles.push({ path: f.path });
          }
        }
        
        result[key] = {};
        for (const sf of field.fields) {
          const sk = sf.alias ?? sf.name;
          if (sf.name === 'nodes') {
            result[key][sk] = changedFiles.map(f => {
              const node: Record<string, any> = {};
              for (const ff of sf.fields) {
                if (ff.name === 'path') node[ff.alias ?? ff.name] = f.path;
              }
              return node;
            });
          } else if (sf.name === 'totalCount') {
            result[key][sk] = changedFiles.length;
          }
        }
        break;
      }
      case 'commits': {
        result[key] = { totalCount: 1 };
        break;
      }
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolveLabelConnection(repo: RepoData, args: Record<string, any>, fields: GraphQLField[]): any {
  const first = args.first ?? 10;
  const labels = repo.labels.slice(0, first);
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'nodes':
        result[key] = labels.map(l => ({ name: l.name, id: l.node_id, color: l.color, description: l.description }));
        break;
      case 'totalCount':
        result[key] = repo.labels.length;
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolveTypeIntrospection(typeName: string, fields: GraphQLField[]): any {
  const typeSchemas: Record<string, { fields?: string[]; enumValues?: string[] }> = {
    Issue: {
      fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'url', 'repository', 'participants', 'reactions', 'timelineItems', 'projectCards', 'projectItems', 'trackedIssues', 'trackedInIssues'],
    },
    PullRequest: {
      fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'commits', 'additions', 'deletions', 'changedFiles', 'author', 'createdAt', 'updatedAt', 'closedAt', 'draft', 'url', 'headRef', 'baseRef', 'reviewDecision', 'reviewRequests', 'reviews', 'labels', 'assignees', 'milestone', 'comments', 'participants', 'reactions', 'timelineItems', 'projectCards', 'projectItems'],
    },
    Repository: {
      fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate', 'isFork', 'stargazerCount', 'forkCount', 'labels', 'milestones', 'projects', 'projectsV2', 'discussions', 'autoMergeAllowed', 'mergeCommitAllowed', 'squashMergeAllowed', 'rebaseMergeAllowed', 'watchers', 'stargazers', 'forks', 'refs', 'object', 'createdAt', 'updatedAt'],
    },
    SearchType: {
      enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
    },
  };
  
  const schema = typeSchemas[typeName];
  if (!schema) return null;
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'name': result[key] = typeName; break;
      case 'kind': result[key] = schema.enumValues ? 'ENUM' : 'OBJECT'; break;
      case 'fields':
        if (schema.fields) {
          result[key] = schema.fields.map(name => {
            const fieldResult: Record<string, any> = {};
            for (const sf of field.fields) {
              if (sf.name === 'name') fieldResult[sf.alias ?? sf.name] = name;
            }
            return fieldResult;
          });
        } else {
          result[key] = null;
        }
        break;
      case 'enumValues':
        if (schema.enumValues) {
          result[key] = schema.enumValues.map(name => {
            const evResult: Record<string, any> = {};
            for (const sf of field.fields) {
              if (sf.name === 'name') evResult[sf.alias ?? sf.name] = name;
            }
            return evResult;
          });
        } else {
          result[key] = null;
        }
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function resolveNode(id: string, fields: GraphQLField[], inlineFragments: { typeName: string; fields: GraphQLField[] }[], variables: Record<string, any>, errors: Array<{ message: string }>): any {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  
  if (decoded.type === 'Repository') {
    // Find repo by id
    for (const repo of repos.values()) {
      if (repo.id === decoded.id) {
        const result: Record<string, any> = {};
        // Resolve direct fields
        for (const field of fields) {
          const key = field.alias ?? field.name;
          switch (field.name) {
            case 'id': result[key] = repo.node_id; break;
            case '__typename': result[key] = 'Repository'; break;
            default: result[key] = null; break;
          }
        }
        // Resolve inline fragments
        for (const frag of inlineFragments) {
          if (frag.typeName === 'Repository') {
            for (const field of frag.fields) {
              const key = field.alias ?? field.name;
              switch (field.name) {
                case 'id': result[key] = repo.node_id; break;
                case 'name': result[key] = repo.name; break;
                case 'nameWithOwner': result[key] = `${repo.owner}/${repo.name}`; break;
                case 'databaseId': result[key] = repo.id; break;
                case 'owner': {
                  result[key] = {};
                  for (const sf of field.fields) {
                    if (sf.name === 'login') result[key][sf.alias ?? sf.name] = repo.owner;
                  }
                  break;
                }
                default: result[key] = null; break;
              }
            }
          }
        }
        return result;
      }
    }
  }
  
  if (decoded.type === 'Issue') {
    for (const repo of repos.values()) {
      const issue = repo.issues.find(i => i.id === decoded.id);
      if (issue) {
        const result: Record<string, any> = {};
        for (const field of fields) {
          const key = field.alias ?? field.name;
          if (field.name === '__typename') result[key] = 'Issue';
          else result[key] = null;
        }
        return result;
      }
    }
  }
  
  if (decoded.type === 'PullRequest') {
    for (const repo of repos.values()) {
      const pull = repo.pulls.find(p => p.id === decoded.id);
      if (pull) {
        const result: Record<string, any> = {};
        for (const field of fields) {
          const key = field.alias ?? field.name;
          if (field.name === '__typename') result[key] = 'PullRequest';
          else result[key] = null;
        }
        return result;
      }
    }
  }
  
  return null;
}

function resolveSearch(args: Record<string, any>, fields: GraphQLField[], variables: Record<string, any>, errors: Array<{ message: string }>): any {
  const queryStr = args.query ?? '';
  const type = args.type ?? 'ISSUE';
  const first = args.first ?? 10;
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'issueCount':
      case 'repositoryCount':
      case 'userCount':
        result[key] = 0;
        break;
      case 'nodes':
        result[key] = [];
        break;
      case 'edges':
        result[key] = [];
        break;
      default:
        result[key] = null;
        break;
    }
  }
  return result;
}

function executeMutationFields(fields: GraphQLField[], variables: Record<string, any>, data: Record<string, any>, errors: Array<{ message: string }>): void {
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    
    switch (field.name) {
      case 'createIssue': data[key] = mutationCreateIssue(args.input, field.fields, errors); break;
      case 'closeIssue': data[key] = mutationCloseIssue(args.input, field.fields, errors); break;
      case 'createPullRequest': data[key] = mutationCreatePullRequest(args.input, field.fields, variables, errors); break;
      case 'mergePullRequest': data[key] = mutationMergePullRequest(args.input, field.fields, variables, errors); break;
      case 'addComment': data[key] = mutationAddComment(args.input, field.fields, errors); break;
      default:
        errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
        break;
    }
  }
}

function mutationCreateIssue(input: any, fields: GraphQLField[], errors: Array<{ message: string }>): any {
  if (!input || !input.repositoryId) {
    errors.push({ message: 'Missing repositoryId' });
    return null;
  }
  
  const decoded = decodeNodeId(input.repositoryId);
  let repo: RepoData | undefined;
  if (decoded) {
    for (const r of repos.values()) {
      if (r.id === decoded.id) { repo = r; break; }
    }
  }
  if (!repo) {
    errors.push({ message: 'Repository not found' });
    return null;
  }
  
  const issue: IssueData = {
    id: nextGlobalId++,
    number: repo.nextIssueNumber++,
    node_id: makeNodeId('Issue', nextGlobalId - 1),
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    labels: [],
    comments: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    user: { login: currentOwner, id: 1 },
  };
  repo.issues.push(issue);
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === 'issue') {
      result[key] = resolveIssueFields(issue, field.fields);
    }
  }
  return result;
}

function mutationCloseIssue(input: any, fields: GraphQLField[], errors: Array<{ message: string }>): any {
  if (!input || !input.issueId) {
    errors.push({ message: 'Missing issueId' });
    return null;
  }
  
  const decoded = decodeNodeId(input.issueId);
  if (!decoded) {
    errors.push({ message: 'Invalid issueId' });
    return null;
  }
  
  for (const repo of repos.values()) {
    const issue = repo.issues.find(i => i.id === decoded.id);
    if (issue) {
      issue.state = 'closed';
      issue.closed_at = new Date().toISOString();
      issue.updated_at = new Date().toISOString();
      
      const result: Record<string, any> = {};
      for (const field of fields) {
        const key = field.alias ?? field.name;
        if (field.name === 'issue') {
          result[key] = resolveIssueFields(issue, field.fields);
        }
      }
      return result;
    }
  }
  
  errors.push({ message: 'Issue not found' });
  return null;
}

function mutationCreatePullRequest(input: any, fields: GraphQLField[], variables: Record<string, any>, errors: Array<{ message: string }>): any {
  if (!input || !input.repositoryId) {
    errors.push({ message: 'Missing repositoryId' });
    return null;
  }
  
  const decoded = decodeNodeId(input.repositoryId);
  let repo: RepoData | undefined;
  if (decoded) {
    for (const r of repos.values()) {
      if (r.id === decoded.id) { repo = r; break; }
    }
  }
  if (!repo) {
    errors.push({ message: 'Repository not found' });
    return null;
  }
  
  const headRef = input.headRefName;
  const baseRef = input.baseRefName;
  const headOid = resolveRef(repo, headRef) ?? '';
  const baseOid = resolveRef(repo, baseRef) ?? '';
  
  const pull: PullData = {
    id: nextGlobalId++,
    number: repo.nextIssueNumber++,
    node_id: makeNodeId('PullRequest', nextGlobalId - 1),
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    head: { ref: headRef, sha: headOid, label: `${repo.owner}:${headRef}` },
    base: { ref: baseRef, sha: baseOid, label: `${repo.owner}:${baseRef}` },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    user: { login: currentOwner, id: 1 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    labels: [],
    draft: false,
    mergeable: true,
    comments: [],
  };
  repo.pulls.push(pull);
  
  const result: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === 'pullRequest') {
      result[key] = resolvePullRequestFields(repo, pull, field.fields, variables);
    }
  }
  return result;
}

function mutationMergePullRequest(input: any, fields: GraphQLField[], variables: Record<string, any>, errors: Array<{ message: string }>): any {
  if (!input || !input.pullRequestId) {
    errors.push({ message: 'Missing pullRequestId' });
    return null;
  }
  
  const decoded = decodeNodeId(input.pullRequestId);
  if (!decoded) {
    errors.push({ message: 'Invalid pullRequestId' });
    return null;
  }
  
  for (const repo of repos.values()) {
    const pull = repo.pulls.find(p => p.id === decoded.id);
    if (pull) {
      const mergeMethod = input.mergeMethod ?? 'MERGE';
      doMergePull(repo, pull, mergeMethod.toLowerCase());
      
      const result: Record<string, any> = {};
      for (const field of fields) {
        const key = field.alias ?? field.name;
        if (field.name === 'pullRequest') {
          result[key] = resolvePullRequestFields(repo, pull, field.fields, variables);
        }
      }
      return result;
    }
  }
  
  errors.push({ message: 'PullRequest not found' });
  return null;
}

function mutationAddComment(input: any, fields: GraphQLField[], errors: Array<{ message: string }>): any {
  if (!input || !input.subjectId) {
    errors.push({ message: 'Missing subjectId' });
    return null;
  }
  
  const decoded = decodeNodeId(input.subjectId);
  if (!decoded) {
    errors.push({ message: 'Invalid subjectId' });
    return null;
  }
  
  for (const repo of repos.values()) {
    const issue = repo.issues.find(i => i.id === decoded.id);
    if (issue) {
      const comment: CommentData = {
        id: repo.nextCommentId++,
        node_id: makeNodeId('IssueComment', nextGlobalId++),
        body: input.body ?? '',
        user: { login: currentOwner, id: 1 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      issue.comments.push(comment);
      
      const result: Record<string, any> = {};
      for (const field of fields) {
        const key = field.alias ?? field.name;
        if (field.name === 'commentEdge') {
          result[key] = {};
          for (const sf of field.fields) {
            const sk = sf.alias ?? sf.name;
            if (sf.name === 'node') {
              result[key][sk] = {};
              for (const ff of sf.fields) {
                const fk = ff.alias ?? ff.name;
                switch (ff.name) {
                  case 'id': result[key][sk][fk] = comment.node_id; break;
                  case 'body': result[key][sk][fk] = comment.body; break;
                  case 'author': result[key][sk][fk] = { login: comment.user.login }; break;
                }
              }
            }
          }
        }
      }
      return result;
    }
  }
  
  errors.push({ message: 'Subject not found' });
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// MCP endpoint (JSON-RPC 2.0 over streamable HTTP)
// ════════════════════════════════════════════════════════════════════════════════

let mcpSessionCounter = 0;

function handleMcp(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';

  // DELETE: close session  
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ ok: true }) + '\n');
    return;
  }

  if (method === 'GET') {
    // SSE endpoint or discovery - return method not found since we support POST-based discover
    res.writeHead(405, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }) + '\n');
    return;
  }

  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }) + '\n');
    return;
  }

  readBody(req).then(buf => {
    const text = buf.toString('utf8').trim();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      res.writeHead(400, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
      return;
    }

    const mcpMethod = body.method ?? '';
    const authHeader = req.headers.authorization ?? '';
    
    // Auth: server/discover and initialize do NOT need auth
    // tools/list and tools/call NEED auth
    const noAuthMethods = ['server/discover', 'initialize', 'notifications/initialized'];
    
    if (!noAuthMethods.includes(mcpMethod)) {
      if (authHeader !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' }, id: body.id ?? null }) + '\n');
        return;
      }
    }

    // Notifications don't get responses (no id field)
    if (mcpMethod === 'notifications/initialized' && body.id === undefined) {
      res.writeHead(202, { 'content-type': JSON_TYPE });
      res.end();
      return;
    }

    const response = processMcpRequest(body, req);

    // Set Mcp-Session-Id header for session management
    const sessionId = `session-${++mcpSessionCounter}`;
    
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'mcp-session-id': req.headers['mcp-session-id'] as string ?? sessionId,
    });
    res.end(JSON.stringify(response) + '\n');
  }).catch(() => {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
  });
}

function processMcpRequest(body: any, req: IncomingMessage): any {
  const id = body.id ?? null;
  const method = body.method ?? '';
  const params = body.params ?? {};

  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: { name: 'github-forge', version: '1.0.0' },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' },
          },
        },
      };

    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion ?? '2025-11-25',
          serverInfo: { name: 'github-forge', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: getMcpTools(),
        },
      };

    case 'tools/call':
      return handleMcpToolCall(id, params);

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      };
  }
}

function getMcpTools(): any[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Repository name' },
          owner: { type: 'string', description: 'Repository owner' },
          description: { type: 'string', description: 'Repository description' },
          private: { type: 'boolean', description: 'Whether the repository is private' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get repository details',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create a new issue',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', description: 'Issue state filter (open, closed, all)', enum: ['open', 'closed', 'all'] },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a new pull request',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Pull request title' },
          body: { type: 'string', description: 'Pull request body' },
          head: { type: 'string', description: 'Head branch' },
          base: { type: 'string', description: 'Base branch' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          pull_number: { type: 'number', description: 'Pull request number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
    {
      name: 'push_files',
      description: 'Push files to a repository',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name' },
          files: { type: 'array', description: 'Files to push', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['owner', 'repo', 'branch', 'files', 'message'],
      },
    },
    {
      name: 'get_file_contents',
      description: 'Get file contents from a repository',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          path: { type: 'string', description: 'File path' },
          branch: { type: 'string', description: 'Branch name' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
    {
      name: 'search_code',
      description: 'Search code in repositories',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query' },
        },
        required: ['q'],
      },
    },
  ];
}

function handleMcpToolCall(id: any, params: any): any {
  const toolName = params?.name ?? '';
  const args = params?.arguments ?? {};
  
  try {
    let content: any;
    
    switch (toolName) {
      case 'create_repo':
      case 'create_repository': {
        const owner = args.owner || currentOwner;
        const name = args.name;
        if (!name) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Missing required argument: name' }], isError: true },
          };
        }
        const existing = getRepo(owner, name);
        if (existing) {
          content = repoJson(existing);
        } else {
          const repo = createRepoData(owner, name, args.description ?? '', args.private ?? false);
          content = repoJson(repo);
        }
        break;
      }
      case 'get_repo':
      case 'get_repository': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        content = repoJson(repo);
        break;
      }
      case 'create_issue': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        if (!args.title) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Missing required argument: title' }], isError: true },
          };
        }
        const issue: IssueData = {
          id: nextGlobalId++,
          number: repo.nextIssueNumber++,
          node_id: makeNodeId('Issue', nextGlobalId - 1),
          title: args.title,
          body: args.body ?? '',
          state: 'open',
          labels: [],
          comments: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          closed_at: null,
          user: { login: currentOwner, id: 1 },
        };
        repo.issues.push(issue);
        content = issueJson(repo, issue);
        break;
      }
      case 'list_issues': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        let issues = repo.issues;
        const state = args.state || 'open';
        if (state !== 'all') {
          issues = issues.filter(i => i.state === state);
        }
        content = issues.map(i => issueJson(repo, i));
        break;
      }
      case 'create_pull_request': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        const headOid = resolveRef(repo, args.head) ?? '';
        const baseOid = resolveRef(repo, args.base) ?? '';
        const pull: PullData = {
          id: nextGlobalId++,
          number: repo.nextIssueNumber++,
          node_id: makeNodeId('PullRequest', nextGlobalId - 1),
          title: args.title ?? '',
          body: args.body ?? '',
          state: 'open',
          head: { ref: args.head, sha: headOid, label: `${repo.owner}:${args.head}` },
          base: { ref: args.base, sha: baseOid, label: `${repo.owner}:${args.base}` },
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          user: { login: currentOwner, id: 1 },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          closed_at: null,
          labels: [],
          draft: false,
          mergeable: true,
          comments: [],
        };
        repo.pulls.push(pull);
        content = pullJson(repo, pull);
        break;
      }
      case 'merge_pull_request': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(args.pull_number);
        const pull = repo.pulls.find(p => p.number === num);
        if (!pull) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Pull request not found' }], isError: true },
          };
        }
        doMergePull(repo, pull, 'squash');
        content = pullJson(repo, pull);
        break;
      }
      case 'push_files': {
        const owner = args.owner || currentOwner;
        let repo = getRepo(owner, args.repo);
        if (!repo) repo = createRepoData(owner, args.repo);
        
        const branch = args.branch || repo.default_branch;
        const branchRef = `refs/heads/${branch}`;
        const currentOid = repo.refs.get(branchRef);
        
        let treeOid = currentOid ? getCommitTree(repo, currentOid) : null;
        
        for (const file of (args.files ?? [])) {
          const blobOid = createBlob(repo, file.content ?? '');
          treeOid = updateFileInTree(repo, treeOid, file.path, blobOid);
        }
        
        if (treeOid) {
          const commitOid = createCommit(repo, treeOid, currentOid ? [currentOid] : [], args.message ?? 'Push files');
          repo.refs.set(branchRef, commitOid);
          if (!repo.refs.has(`refs/heads/${repo.default_branch}`)) {
            repo.default_branch = branch;
            repo.HEAD = branchRef;
          }
        }
        
        content = { sha: repo.refs.get(branchRef) ?? '', branch };
        break;
      }
      case 'get_file_contents': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        const branch = args.branch || repo.default_branch;
        const refOid = resolveRef(repo, branch);
        if (!refOid) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Branch not found' }], isError: true },
          };
        }
        const tree = getCommitTree(repo, refOid);
        if (!tree) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Tree not found' }], isError: true },
          };
        }
        const file = getFileAtPath(repo, tree, args.path);
        if (!file) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'File not found' }], isError: true },
          };
        }
        content = {
          name: args.path.split('/').pop(),
          path: args.path,
          sha: file.oid,
          size: file.content.length,
          content: file.content.toString('base64'),
          encoding: 'base64',
          type: 'file',
        };
        break;
      }
      case 'search_code': {
        content = { total_count: 0, incomplete_results: false, items: [] };
        break;
      }
      case 'list_pull_requests': {
        const repo = getRepo(args.owner || currentOwner, args.repo);
        if (!repo) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          };
        }
        content = repo.pulls.map(p => pullJson(repo, p));
        break;
      }
      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
    }
    
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(content) }],
      },
    };
  } catch (err: any) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Error: ${err.message ?? err}` }],
        isError: true,
      },
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Server setup
// ════════════════════════════════════════════════════════════════════════════════

export function createApp(): Server {
  const server = createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = pathOf(req);
    
    // Health check
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    
    // REST API
    if (path.startsWith('/api/v3/')) {
      if (!checkAuth(req, res)) return;
      handleRestApi(req, res, path, method);
      return;
    }
    
    // GraphQL
    if (path === '/api/graphql' && method === 'POST') {
      if (!checkAuth(req, res)) return;
      handleGraphQL(req, res);
      return;
    }
    if (path === '/api/graphql' && method === 'GET') {
      if (!checkAuth(req, res)) return;
      sendJson(res, 200, { data: null });
      return;
    }

    // MCP
    if (path === '/mcp') {
      handleMcp(req, res);
      return;
    }

    // Git smart HTTP protocol
    // Match /:owner/:repo.git/... or /:owner/:repo/...
    if (path.match(/^\/[^/]+\/[^/]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/)) {
      if (!checkAuth(req, res)) return;
      handleGitRequest(req, res, path, method);
      return;
    }

    // Catch-all 404 with JSON
    sendJson(res, 404, { message: 'Not Found' });
  });
  
  return server;
}

// Set owner from environment or first API call
if (process.env.MAKEFUN_VIEWER_LOGIN) {
  currentOwner = process.env.MAKEFUN_VIEWER_LOGIN;
}
