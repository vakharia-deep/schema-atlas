import { readdir, realpath, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildModel } from './schema.mjs';

const parser = fileURLToPath(new URL('./parse.exs', import.meta.url));
const limits = { files: 2000, entries: 30000, bytes: 8_000_000, fileBytes: 1_000_000, depth: 24 };
const excluded = new Set(['.git', '_build', 'deps', 'node_modules', '.elixir_ls', '.hex', 'test', 'tests', 'assets']);

export async function collectFiles(root) {
  root = await realpath(root);
  let entries = 0, bytes = 0;
  const files = [], warnings = [];
  async function walk(dir, depth) {
    if (depth > limits.depth) throw new Error('Repository directory depth exceeds the scan limit.');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > limits.entries) throw new Error('Repository has too many entries to scan.');
      if (excluded.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { warnings.push({ message: 'Symbolic link excluded from scan.', file: path.relative(root, full), line: 1 }); continue; }
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !/\.exs?$/.test(entry.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const kind = /(?:^|\/)migrations\/[^/]+\.exs$/.test(rel) ? 'migration' : /(?:^|\/)lib\/.*\.ex$/.test(rel) ? 'schema' : null;
      if (!kind) continue;
      const resolved = await realpath(full);
      if (!resolved.startsWith(root + path.sep)) throw new Error('A source path escaped the repository.');
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > limits.fileBytes) throw new Error('Source file exceeds the scan limit.');
        const buffer = Buffer.alloc(limits.fileBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > limits.fileBytes) throw new Error('Source file exceeds the scan limit.');
        bytes += bytesRead;
        if (bytes > limits.bytes) throw new Error('Repository source exceeds the scan limit.');
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
      // Only Ecto schema/migration files are handed to the syntax parser, never config/secrets.
      if (kind === 'migration' || /\b(?:schema|embedded_schema)\b/.test(content)) files.push({ path: rel, kind, content });
      if (files.length > limits.files) throw new Error('Too many source files.');
    }
  }
  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, warnings, bytes };
}

export async function elixirRuntime() {
  const env = { ...process.env, ERL_FLAGS: '+S 2:2 +A 1 +t 200000' };
  // A host needs Elixir + OTP 27; browser clients need no runtime or dependencies.
  if (!env.ASDF_ELIXIR_VERSION) {
    try {
      const versions = (await readdir(path.join(os.homedir(), '.asdf/installs/elixir'))).filter(v => /^\d+\.\d+\.\d+(?:-otp-\d+)?$/.test(v)).sort();
      if (versions.length) env.ASDF_ELIXIR_VERSION = versions.at(-1);
      const otp = env.ASDF_ELIXIR_VERSION?.match(/otp-(\d+)/)?.[1];
      const erlangs = (await readdir(path.join(os.homedir(), '.asdf/installs/erlang'))).filter(v => /^\d+\.\d+(?:\.\d+)*$/.test(v) && (!otp || v.startsWith(otp + '.'))).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!env.ASDF_ERLANG_VERSION && erlangs.length) env.ASDF_ERLANG_VERSION = erlangs.at(-1);
    } catch { /* System Elixir is also supported. */ }
  }
  return { command: 'elixir', env };
}

export async function parseFiles(files) {
  const input = JSON.stringify(files);
  if (Buffer.byteLength(input) > 12_000_000) throw new Error('Parser input limit exceeded.');
  const { command, env } = await elixirRuntime();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [parser], { cwd: path.dirname(parser), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, done = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Schema parsing exceeded 20 seconds.')); }, 20_000);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 24_000_000) { child.kill('SIGKILL'); finish(new Error('Parser output limit exceeded.')); }
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {}); // Never expose repository literals from parser diagnostics.
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Elixir is unavailable. Install Elixir with Erlang/OTP 27 or newer.')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Parser could not complete. Check Elixir/OTP 27+ and source limits.'));
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('Invalid parser response.')); }
    });
    child.stdin.end(input);
  });
}

export function diffModels(previous, next) {
  if (!previous) return { baseline: true, added: [], removed: [], changed: [], total: 0 };
  const before = new Map(previous.tables.map(t => [t.id, t]));
  const after = new Map(next.tables.map(t => [t.id, t]));
  const added = [...after.keys()].filter(k => !before.has(k));
  const removed = [...before.keys()].filter(k => !after.has(k));
  const changed = [];
  for (const [id, table] of after) {
    if (!before.has(id)) continue;
    const old = before.get(id), details = [];
    for (const field of ['columns', 'indexes', 'constraints', 'partitions', 'associations', 'options', 'primaryKey', 'comment', 'kind', 'partitionOf', 'viewDefinition', 'triggers', 'policies', 'grants']) {
      const metadata=value=>JSON.stringify(value,(key,item)=>key==='source'||key==='statistics'?undefined:item);
      if (metadata(old[field]) !== metadata(table[field])) details.push(field);
    }
    if (details.length) {
      const cols = new Map(old.columns.map(c => [c.name, c]));
      changed.push({ id, details, addedColumns: table.columns.filter(c => !cols.has(c.name)).map(c => c.name), removedColumns: old.columns.filter(c => !table.columns.some(n => n.name === c.name)).map(c => c.name) });
    }
  }
  return { baseline: false, added, removed, changed, total: added.length + removed.length + changed.length };
}

// Provider boundary: future Postgres introspection returns this same schema model.
export class EctoRepositoryProvider {
  constructor(root, id, name) { this.root = root; this.id = id; this.name = name; this.snapshot = null; this.pending = null; }
  async inspect() {
    if (this.pending) return this.pending;
    this.pending = this.scan().finally(() => { this.pending = null; });
    return this.pending;
  }
  async scan() {
    const start = performance.now();
    const { files, warnings, bytes } = await collectFiles(this.root);
    const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
    let model;
    if (this.snapshot?.revision === revision) model = structuredClone(this.snapshot);
    else {
      const parsed=await parseFiles(files);
      const errors=parsed.filter(f=>f.error);
      if(errors.length){const error=new Error('Repository has syntax errors.');error.code='SOURCE_SYNTAX';error.sources=errors.map(f=>({file:f.path,line:f.line||1}));throw error;}
      model = buildModel(parsed);
    }
    model.warnings.push(...warnings.filter(w => !model.warnings.some(o => o.file === w.file && o.message === w.message)));
    model.repository = { id: this.id, name: this.name, path: this.root, provider: 'ecto-repository' };
    model.revision = revision;
    model.scannedAt = new Date().toISOString();
    model.scan = { files: files.length, bytes, milliseconds: Math.round(performance.now() - start) };
    model.changes = diffModels(this.snapshot, model);
    this.snapshot = model;
    return model;
  }
}
