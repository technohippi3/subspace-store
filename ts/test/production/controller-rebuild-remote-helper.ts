/** Filesystem-backed recording recovery protocol, run as a separate process. */
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
const file = process.argv[3]; if (process.argv[2] !== "--config" || !file) throw Error("invalid fake recovery command");
interface ObjectRow { sequence: number; sha256: string; data: string }
interface State { loss: "before" | "after" | null; objects: ObjectRow[] }
const value = JSON.parse(readFileSync(file, "utf8")) as State;
const save = () => { writeFileSync(file, JSON.stringify(value)); const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const parts: Buffer[] = []; for await (const part of process.stdin) parts.push(Buffer.from(part));
const request = JSON.parse(Buffer.concat(parts).toString()) as { op: string; stream: string; after: number; sequence: number; sha256: string; data: string };
if (request.stream !== "controller") throw Error("unexpected fake stream");
if (request.op === "journal-read") console.log(JSON.stringify({ ok: true, head: value.objects.length, entries: value.objects.slice(request.after) }));
else if (request.op === "journal-append") {
  if (value.loss === "before") { value.loss = null; save(); process.exit(9); }
  const row = { sequence: request.sequence, sha256: request.sha256, data: request.data }, previous = value.objects[request.sequence - 1];
  if (previous ? JSON.stringify(previous) !== JSON.stringify(row) : request.sequence !== value.objects.length + 1) throw Error("fake sequence conflict");
  if (!previous) value.objects.push(row);
  const lost = value.loss === "after"; value.loss = null; save(); if (lost) process.exit(9);
  console.log(JSON.stringify({ ok: true, sequence: row.sequence, sha256: row.sha256 }));
} else throw Error("unknown fake recovery operation");
