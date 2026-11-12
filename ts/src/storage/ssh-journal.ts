export interface RecoveryBackendReference { readonly version:1; readonly node:string; readonly client:string; readonly config:string }
export function backendReference(value:unknown):RecoveryBackendReference {
  const invalid=()=>{throw Error("invalid recovery backend reference");};
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join()!=="client,config,node,version")return invalid();
  const v=value as Record<string,unknown>;
  if(v.version!==1)return invalid();
  for(const key of ["node","client","config"])if(typeof v[key]!=="string"||!isAbsolute(v[key])||v[key].includes("\0")||v[key].length>4096)return invalid();
  if(new Set([v.node,v.client,v.config]).size!==3)return invalid();
  return {version:1,node:v.node as string,client:v.client as string,config:v.config as string};
}
export function sameBackend(a:RecoveryBackendReference|undefined,b:RecoveryBackendReference|undefined):boolean {
  return a===undefined||b===undefined?a===b:["version","node","client","config"].every(key=>a[key as keyof RecoveryBackendReference]===b[key as keyof RecoveryBackendReference]);
}
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
// These two imports are the owning runtime's existing storage contract.
import { decode, type Entry } from './codec.ts';
import type { Journal } from './journal.ts';

export class RecoveryCommand {
  readonly node: string; readonly client: string; readonly config: string;
  constructor(node: string, client: string, config: string) { this.node = node; this.client = client; this.config = config; }
  request<T>(request: object): T {
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 24 * 1024 * 1024) throw Error('recovery request exceeds bounds');
    const result = spawnSync(this.node, [this.client, '--config', this.config], {
      input, timeout: 30_000, maxBuffer: 24 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) throw Error('off-host recovery unavailable');
    try {
      const value = JSON.parse(result.stdout.toString()) as { ok?: unknown };
      if (value.ok !== true) throw Error();
      return value as T;
    } catch { throw Error('off-host recovery response invalid'); }
  }
}
export class SshJournal implements Journal {
  private entries: Entry[] | undefined;
  readonly command: RecoveryCommand;
  constructor(command: RecoveryCommand) { this.command = command; }
  read(): readonly Entry[] {
    const entries: Entry[] = []; let after = 0, bytes = 0, head:number|undefined;
    while (true) {
      const page = this.command.request<{ entries: { sequence: number; sha256: string; data: string }[]; head: number }>({ op: 'journal-read', stream: 'store', after, limit: 1024 });
      if (!Array.isArray(page.entries) || page.entries.length>1024 || !Number.isSafeInteger(page.head) || page.head < after || page.head > 1_000_000 || head!==undefined&&page.head!==head) throw Error('journal prefix invalid');
      head=page.head;
      for (const item of page.entries) {
        const raw = Buffer.from(item.data, 'base64'); bytes += raw.length;
        if (raw.toString('base64')!==item.data || bytes > 512 * 1024 * 1024 || entries.length >= 1_000_000 || item.sequence !== after + 1 ||
          typeof item.sha256 !== 'string' || createHash('sha256').update(raw).digest('hex') !== item.sha256) throw Error('journal replay bounds or digest invalid');
        const entry = decode(raw.toString()); const previous = entries.at(-1);
        if (entry.seq !== after + 1 || entry.previous !== (previous?.hash ?? null) || previous && entry.store !== previous.store) throw Error('journal lineage invalid');
        entries.push(entry); after++;
      }
      if (after === page.head) { this.entries = entries; return entries; }
      if (!page.entries.length || after > page.head) throw Error('journal prefix changed');
    }
  }
  append(value: Entry): undefined {
    const raw = JSON.stringify(value); decode(raw);
    if (!this.entries) this.read();
    const entries = this.entries!;
    const previous = entries.at(-1);
    if (value.seq > entries.length && (value.seq !== entries.length + 1 || value.previous !== (previous?.hash ?? null) || previous && value.store !== previous.store)) throw Error('journal append lineage invalid');
    const ack = this.command.request<{ sequence: number; sha256: string }>({ op: 'journal-append', stream: 'store', sequence: value.seq,
      sha256: createHash('sha256').update(raw).digest('hex'), data: Buffer.from(raw).toString('base64') });
    if (ack.sequence !== value.seq || ack.sha256 !== createHash('sha256').update(raw).digest('hex')) throw Error('journal acknowledgment invalid');
    if (value.seq === entries.length + 1) entries.push(value);
    return undefined;
  }
}

/** Created lazily inside DurableStore ownership; an error never selects FileJournal. */
export function backendStorage(reference:RecoveryBackendReference|undefined) {
  return reference?{makeJournal:()=>new SshJournal(new RecoveryCommand(reference.node,reference.client,reference.config))}:{};
}
