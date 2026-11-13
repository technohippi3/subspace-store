import { refuse } from "./errors.ts";

/** JSON.parse discards duplicate keys. Protocol receipts and history must not. */
export function strictJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse("malformed controller JSON", "invalid"); }
  const stack: (Set<string> | null)[] = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(token.index + token[0].length))) {
      const keys = stack.at(-1), key = JSON.parse(token[0]) as string;
      if (!keys || keys.has(key)) refuse("duplicate or invalid JSON field", "invalid");
      keys.add(key);
    }
  }
  return value;
}
