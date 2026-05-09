import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const EN_PATH = join(ROOT, "messages/en.json");
const DE_PATH = join(ROOT, "messages/de.json");

// JSON.parse silently keeps the last value when an object has duplicate keys,
// which lets shadowed keys hide bugs. Walk the source manually to surface them.
function findDuplicateKeys(
  src: string,
): { path: string; line: number; firstLine: number }[] {
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
      else if (c === "\n") {
        i++;
        line++;
      } else break;
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
    if (c === '"') {
      readString();
      return;
    }
    while (i < src.length) {
      const ch = src[i];
      if (
        ch === "," ||
        ch === "}" ||
        ch === "]" ||
        ch === " " ||
        ch === "\n" ||
        ch === "\t" ||
        ch === "\r"
      )
        break;
      if (ch === "\n") line++;
      i++;
    }
  }

  function parseArray() {
    i++;
    skipWs();
    if (src[i] === "]") {
      i++;
      return;
    }
    while (true) {
      parseValue();
      skipWs();
      if (src[i] === ",") {
        i++;
        skipWs();
        continue;
      }
      if (src[i] === "]") {
        i++;
        return;
      }
      err("expected , or ] in array");
    }
  }

  function parseObject() {
    i++;
    const seen = new Map<string, number>();
    skipWs();
    if (src[i] === "}") {
      i++;
      return;
    }
    while (true) {
      skipWs();
      const { value: key, line: keyLine } = readString();
      const seenAt = seen.get(key);
      if (seenAt != null) {
        dups.push({
          path: [...pathStack, key].join("."),
          line: keyLine,
          firstLine: seenAt,
        });
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
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        return;
      }
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
          .map(
            (d) =>
              `  ${d.path} at line ${d.line} (first defined at line ${d.firstLine})`,
          )
          .join("\n"),
    ).toEqual([]);
  });

  it("messages/de.json has no duplicate keys", () => {
    const dups = findDuplicateKeys(readFileSync(DE_PATH, "utf8"));
    expect(
      dups,
      `Duplicate keys silently shadow earlier definitions:\n` +
        dups
          .map(
            (d) =>
              `  ${d.path} at line ${d.line} (first defined at line ${d.firstLine})`,
          )
          .join("\n"),
    ).toEqual([]);
  });

  it("en and de share the same key shape (locale parity)", () => {
    const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const de = JSON.parse(readFileSync(DE_PATH, "utf8")) as Record<
      string,
      unknown
    >;

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

  // Flat helper used by the value-quality checks below.
  function flattenValues(obj: unknown, prefix: string, out: [string, string][]) {
    if (obj == null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push([key, v]);
      else if (typeof v === "object") flattenValues(v, key, out);
    }
  }

  // Translations whose last-segment legitimately equals the value in BOTH
  // locales — brand names, anglicisms, identical EN/DE technical terms.
  // See `docs/audit/v1415-i18n-coverage.md` §Legitimate EN==DE==key cases.
  const PLACEHOLDER_ALLOWLIST = new Set<string>([
    "settings.ntfy",
    "classifications.bp.Optimal",
    "classifications.bp.Normal",
    "classifications.pulse.Normal",
    "classifications.bodyFat.Fitness",
  ]);

  it.each([
    ["en", EN_PATH],
    ["de", DE_PATH],
  ])("%s locale has no empty values", (_locale, path) => {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const flat: [string, string][] = [];
    flattenValues(data, "", flat);
    const empties = flat.filter(([, v]) => v === "").map(([k]) => k);
    expect(
      empties,
      `Empty translations are forbidden — every key needs a real string:\n` +
        empties.map((k) => `  ${k}`).join("\n"),
    ).toEqual([]);
  });

  it("has no placeholder values (value === key last segment in BOTH locales)", () => {
    // We only fail when the same key has value == last-segment in BOTH locales.
    // EN-only matches are usually legitimate (the key is named after the EN word
    // so naturally `"of": "of"` looks like a match — but DE has `"of": "von"`,
    // which is a real translation). EN+DE both equalling the key is a strong
    // signal of a forgotten placeholder like `"bugReport": "bugReport"`.
    const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const de = JSON.parse(readFileSync(DE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const enFlat: [string, string][] = [];
    const deFlat: [string, string][] = [];
    flattenValues(en, "", enFlat);
    flattenValues(de, "", deFlat);
    const deMap = new Map(deFlat);
    const placeholders = enFlat
      .filter(([k, enV]) => {
        if (PLACEHOLDER_ALLOWLIST.has(k)) return false;
        const last = k.split(".").pop();
        if (last === undefined) return false;
        if (enV !== last) return false;
        const deV = deMap.get(k);
        return deV !== undefined && deV === last;
      })
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    expect(
      placeholders,
      `Found keys whose value equals the key's last segment in BOTH locales —\n` +
        `usually a forgotten placeholder (e.g. \`"bugReport": "bugReport"\`).\n` +
        `Either replace with real translations or add to PLACEHOLDER_ALLOWLIST\n` +
        `in this test if the match is genuinely intentional (brand names,\n` +
        `identical EN/DE terms):\n` +
        placeholders.map((s) => `  ${s}`).join("\n"),
    ).toEqual([]);
  });

  it.each([
    ["en", EN_PATH],
    ["de", DE_PATH],
  ])(
    "%s locale has no TODO/FIXME placeholders in values",
    (_locale, path) => {
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const flat: [string, string][] = [];
      flattenValues(data, "", flat);
      const todoRe = /\b(TODO|FIXME|XXX|TBD)\b/;
      const todos = flat
        .filter(([, v]) => todoRe.test(v))
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      expect(
        todos,
        `Found TODO/FIXME/XXX/TBD placeholders in translation values:\n` +
          todos.map((s) => `  ${s}`).join("\n"),
      ).toEqual([]);
    },
  );
});
