import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const EN_PATH = join(ROOT, "messages/en.json");
const DE_PATH = join(ROOT, "messages/de.json");

// JSON.parse silently keeps the last value when an object has duplicate keys,
// which lets shadowed keys hide bugs. Walk the source manually to surface them.
function findDuplicateKeys(src: string): { path: string; line: number; firstLine: number }[] {
  const dups: { path: string; line: number; firstLine: number }[] = [];
  const pathStack: string[] = [];
  let i = 0;
  let line = 1;

  function err(msg: string): never {
    throw new Error(`${msg} at line ${line}`);
  }

  function skipWs() {
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "\n") { i++; line++; }
      else break;
    }
  }

  function readString(): { value: string; line: number } {
    if (src[i] !== '"') err("expected string");
    const startLine = line;
    i++;
    let raw = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        raw += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return { value: JSON.parse(`"${raw}"`), line: startLine };
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
    err("unterminated string");
  }

  function parseValue() {
    skipWs();
    const c = src[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') { readString(); return; }
    while (i < src.length) {
      const ch = src[i];
      if (ch === "," || ch === "}" || ch === "]" || ch === " " || ch === "\n" || ch === "\t" || ch === "\r") break;
      if (ch === "\n") line++;
      i++;
    }
  }

  function parseArray() {
    i++; skipWs();
    if (src[i] === "]") { i++; return; }
    while (true) {
      parseValue();
      skipWs();
      if (src[i] === ",") { i++; skipWs(); continue; }
      if (src[i] === "]") { i++; return; }
      err("expected , or ] in array");
    }
  }

  function parseObject() {
    i++;
    const seen = new Map<string, number>();
    skipWs();
    if (src[i] === "}") { i++; return; }
    while (true) {
      skipWs();
      const { value: key, line: keyLine } = readString();
      const seenAt = seen.get(key);
      if (seenAt != null) {
        dups.push({ path: [...pathStack, key].join("."), line: keyLine, firstLine: seenAt });
      } else {
        seen.set(key, keyLine);
      }
      skipWs();
      if (src[i] !== ":") err("expected : after key");
      i++;
      pathStack.push(key);
      parseValue();
      pathStack.pop();
      skipWs();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") { i++; return; }
      err("expected , or } in object");
    }
  }

  parseValue();
  return dups;
}

describe("i18n locale file integrity", () => {
  it("messages/en.json has no duplicate keys", () => {
    const dups = findDuplicateKeys(readFileSync(EN_PATH, "utf8"));
    expect(
      dups,
      `Duplicate keys silently shadow earlier definitions:\n` +
        dups
          .map((d) => `  ${d.path} at line ${d.line} (first defined at line ${d.firstLine})`)
          .join("\n"),
    ).toEqual([]);
  });

  it("messages/de.json has no duplicate keys", () => {
    const dups = findDuplicateKeys(readFileSync(DE_PATH, "utf8"));
    expect(
      dups,
      `Duplicate keys silently shadow earlier definitions:\n` +
        dups
          .map((d) => `  ${d.path} at line ${d.line} (first defined at line ${d.firstLine})`)
          .join("\n"),
    ).toEqual([]);
  });

  it("en and de share the same key shape (locale parity)", () => {
    const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<string, unknown>;
    const de = JSON.parse(readFileSync(DE_PATH, "utf8")) as Record<string, unknown>;

    function flatten(obj: unknown, prefix: string, out: string[]) {
      if (obj == null || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "string") out.push(key);
        else if (typeof v === "object") flatten(v, key, out);
      }
    }

    const enKeys = new Set<string>();
    const deKeys = new Set<string>();
    const enArr: string[] = [];
    const deArr: string[] = [];
    flatten(en, "", enArr);
    flatten(de, "", deArr);
    enArr.forEach((k) => enKeys.add(k));
    deArr.forEach((k) => deKeys.add(k));

    const onlyInEn = [...enKeys].filter((k) => !deKeys.has(k)).sort();
    const onlyInDe = [...deKeys].filter((k) => !enKeys.has(k)).sort();

    expect(
      { onlyInEn, onlyInDe },
      "Locale files drifted apart — every key must exist in both locales.",
    ).toEqual({ onlyInEn: [], onlyInDe: [] });
  });
});
