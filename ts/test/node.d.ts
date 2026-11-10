// The few Node APIs the tests use, declared here so that `tsc` checks the
// tests with no dependency installed. Replace with @types/node once the
// package takes dependencies.

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
  };
  export default assert;
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: readonly string[],
    options: { cwd?: string; encoding: "utf8"; maxBuffer?: number }): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

interface ImportMeta {
  readonly url: string;
}

declare const process: { readonly env: Record<string, string | undefined> };
declare const console: { log(...args: unknown[]): void };
