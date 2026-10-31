// Turns agent markdown into something worth hearing, and detects German vs English.

import type { Lang } from "./speech.ts";

const DE_WORDS = new Set(
  "der die das und ist nicht ich ein eine einen zu mit auf für von den dem des sich auch es wir du sie ihr wird sind hat habe noch nur aber oder wenn dann jetzt schon mal kann soll muss im ins am beim dass weil".split(" "),
);
const EN_WORDS = new Set(
  "the and is not a an to with on for of it we you they this that are have has was will be can should just now then if or but in at by from so".split(" "),
);

export function detectLang(text: string, fallback: Lang): Lang {
  let de = /[äöüß]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const word of text.toLowerCase().match(/[a-zäöüß']+/g) ?? []) {
    if (DE_WORDS.has(word)) de++;
    if (EN_WORDS.has(word)) en++;
  }
  if (de === en) return fallback;
  return de > en ? "de" : "en";
}

const PATH_RE = /(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?|\b[\w.-]+(?:\/[\w.@-]+)+\.\w{1,6}\b/g;

function basename(path: string): string {
  const clean = path.replace(/[:#]\d+(?::\d+)?$/, "").replace(/\/$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

export interface Speakable {
  text: string;
  truncated: boolean;
  hadCode: boolean;
}

/** Strips code, tables, links and paths; keeps prose. Truncates on a sentence boundary. */
export function toSpeakable(markdown: string, maxChars: number): Speakable {
  let hadCode = false;
  let text = markdown.replace(/```[\s\S]*?(```|$)/g, () => {
    hadCode = true;
    return "\n";
  });
  text = text
    .split("\n")
    .filter((line) => {
      if (/^\s*\|.*\|\s*$/.test(line)) {
        hadCode = true;
        return false;
      }
      return true;
    })
    .join("\n");
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`\n]+)`/g, (_, code: string) => {
      if (/\//.test(code)) return basename(code);
      return code.length <= 28 ? code : "";
    })
    .replace(PATH_RE, (m) => basename(m))
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm, (_, item: string) => (/[.!?:]$/.test(item.trim()) ? item : `${item}.`))
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?)\1/g, "$2")
    .replace(/[<>{}\[\]|]/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.{2,}(?!\.)/g, ".")
    .trim();

  if (text.length <= maxChars) return { text, truncated: false, hadCode };
  const cut = text.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return { text: end > maxChars * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))} …`, truncated: true, hadCode };
}

/** Splits prose into sentence-sized chunks so speech can start before the whole reply is synthesized. */
export function sentences(text: string): string[] {
  // Split only where punctuation is followed by whitespace, so "events2.jsonl" or "v1.2" stay whole.
  const parts = text.split(/(?<=[.!?…]["')\]]*)\s+/);
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    // Merge very short fragments ("Ok." "Ja.") into the previous chunk.
    if (out.length > 0 && (part.length < 12 || out[out.length - 1].length < 12)) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-zäöüß0-9']+/g) ?? [];
}

/** Share of `heard` words that also occur in `spoken`: high means the mic picked up our own voice. */
export function echoScore(heard: string, spoken: string): number {
  const h = words(heard);
  if (h.length === 0) return 0;
  const s = new Set(words(spoken));
  return h.filter((w) => s.has(w)).length / h.length;
}
