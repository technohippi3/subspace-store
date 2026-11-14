/** RFC 8785 encoding for I-JSON data. No toJSON hooks or Unicode normalization. */
export const CANONICAL_MAX_BYTES = 16 * 1024 * 1024;
function quote(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i); let scalar = c;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error("invalid JSON Unicode");
      scalar = 0x10000 + ((c - 0xd800) << 10) + next - 0xdc00;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw Error("invalid JSON Unicode");
    if (scalar >= 0xfdd0 && scalar <= 0xfdef || (scalar & 0xffff) >= 0xfffe)
      throw Error("invalid I-JSON Unicode");
  }
  return JSON.stringify(value);
}
interface Frame { value: unknown[] | Record<string, unknown>; keys: string[] | null; at: number }
/** Iterative traversal avoids adding a new nesting-depth limit to the format. */
export function canonicalJson(value: unknown): string {
  const output: string[] = [], stack: Frame[] = [], active = new Set<object>(); let size = 0;
  const append = (text: string) => {
    size += Buffer.byteLength(text);
    if (size > CANONICAL_MAX_BYTES) throw Error("canonical JSON exceeds bounds");
    output.push(text);
  };
  const enter = (item: unknown) => {
    if (item === null || typeof item === "boolean") { append(JSON.stringify(item)); return; }
    if (typeof item === "string") { append(quote(item)); return; }
    if (typeof item === "number" && Number.isFinite(item)) { append(JSON.stringify(item)); return; }
    if (!item || typeof item !== "object" || active.has(item)) throw Error("invalid or cyclic JSON data");
    const array = Array.isArray(item), keys = Object.keys(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) ||
        Object.getOwnPropertySymbols(item).length ||
        (array ? keys.length !== (item as unknown[]).length || Reflect.ownKeys(item).length !== keys.length + 1 :
          Reflect.ownKeys(item).length !== keys.length))
      throw Error("plain JSON data required");
    for (const key of keys) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, "value"))
      throw Error("JSON accessors are unsupported");
    active.add(item); append(array ? "[" : "{");
    stack.push({ value: item as Frame["value"], keys: array ? null : keys.sort(), at: 0 });
  };
  enter(value);
  while (stack.length) {
    const frame = stack.at(-1)!, length = frame.keys?.length ?? (frame.value as unknown[]).length;
    if (frame.at === length) { append(frame.keys ? "}" : "]"); active.delete(frame.value); stack.pop(); continue; }
    if (frame.at) append(",");
    const index = frame.at++;
    if (frame.keys) {
      const key = frame.keys[index]!; append(quote(key) + ":"); enter((frame.value as Record<string, unknown>)[key]);
    } else enter((frame.value as unknown[])[index]);
  }
  return output.join("");
}
