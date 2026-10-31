// Context vocabulary for fixing misheard technical terms ("Yell Fin" -> "Jellyfin").
// Terms come from the thread's repo (file paths) and from the thread's messages, and grow
// during the call. Correction is phonetic and model-agnostic: a transcript word (or two
// adjacent words) is replaced when it sounds like a known term but is spelled differently.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_TERMS = 5000;

/** Rough sound key for German/English speech: spelling variants that sound alike collapse. */
export function soundKey(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/^y/, "j").replace(/^g(?=[ei])/, "j")
    .replace(/ph/g, "f").replace(/th/g, "t").replace(/sch|sh/g, "s").replace(/ch/g, "k")
    .replace(/ck|c|q/g, "k").replace(/v/g, "f").replace(/w/g, "v").replace(/tz|ts|z/g, "s")
    .replace(/ae|ai|ay|ei|ey/g, "e").replace(/ie|ee|ea|y/g, "i").replace(/oo|ou/g, "u")
    .replace(/(?<=[^aeiou])h/g, "")
    .replace(/(.)\1+/g, "$1");
}

function similarity(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length, 1);
}

// Words worth knowing: mixed case (Jellyfin is fine too), digits, dots/dashes inside.
const TERM = /[A-Za-zÄÖÜäöü][A-Za-z0-9ÄÖÜäöü]*(?:[.-][A-Za-z0-9]+)*/g;

export class Vocabulary {
  private terms = new Map<string, string>(); // lowercased -> preferred spelling
  private keys: { key: string; term: string; spoken: boolean }[] = [];

  /** `spoken` terms come from the conversation and win over repo-only terms. */
  add(term: string, spoken = false): void {
    const t = term.replace(/^[.-]+|[.-]+$/g, "");
    if (t.length < 4) return;
    const lower = t.toLowerCase();
    const known = this.keys.find((k) => k.term.toLowerCase() === lower);
    if (known) {
      // Prefer the spelling people write in chat ("Traefik" over the path "traefik").
      if (spoken && !known.spoken) Object.assign(known, { term: t, spoken });
      this.terms.set(lower, known.term);
      return;
    }
    if (this.terms.size >= MAX_TERMS) return;
    this.terms.set(lower, t);
    const key = soundKey(t);
    if (key.length >= 3) this.keys.push({ key, term: t, spoken });
  }

  /** Technical-looking words from chat text: inline code, mixed case, digits, or capitalised names. */
  addFromText(text: string): void {
    for (const m of text.matchAll(/`([^`]{3,40})`/g)) for (const w of m[1].match(TERM) ?? []) this.add(w, true);
    for (const w of text.match(TERM) ?? []) {
      if (/\d/.test(w) || /[a-z][A-Z]/.test(w) || /[.-]/.test(w) || /^[A-Z][a-z]+[A-Z]?/.test(w)) this.add(w, true);
    }
  }

  /** Path segments of the repo's tracked files: service names, hosts, app names. */
  async addFromRepo(dir: string): Promise<void> {
    try {
      const { stdout } = await run("git", ["-C", dir, "ls-files"], { maxBuffer: 32 << 20 });
      const seen = new Set<string>();
      for (const path of stdout.split("\n")) {
        for (const seg of path.split("/")) {
          const base = seg.replace(/\.[a-z0-9]+$/i, "");
          for (const part of [base, ...base.split(/[_-]/)]) if (!seen.has(part)) { seen.add(part); this.add(part); }
        }
      }
    } catch {
      // not a git repo or git missing: thread terms still apply
    }
  }

  get size(): number {
    return this.terms.size;
  }

  /** Replaces misheard words with known terms. Returns the corrected text. */
  correct(text: string): string {
    if (this.keys.length === 0) return text;
    const tokens = text.split(/(\s+)/); // keep whitespace
    const words = tokens.filter((_, i) => i % 2 === 0);
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const fix = (span: number) => {
        const parts = words.slice(i, i + span);
        // Never glue on short function words ("Client zu" is not "clients").
        if (span > 1 && parts.some((w) => /^\p{L}{1,2}[^\p{L}]*$/u.test(w))) return null;
        const raw = parts.join(" ");
        const m = raw.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)!;
        const core = m[2];
        if (!core || this.terms.has(core.toLowerCase().replace(/\s+/g, "")) && span === 1) return null;
        const key = soundKey(core);
        if (key.length < 4) return null;
        let best: { term: string; score: number; spoken: boolean } | null = null;
        for (const k of this.keys) {
          // Plain lowercase repo words ("starter") would eat ordinary speech ("starten").
          if (!k.spoken && !/[A-Z0-9]/.test(k.term) && span === 1) continue;
          if (Math.abs(k.key.length - key.length) > 2) continue;
          const score = similarity(key, k.key);
          const min = span > 1 ? 0.85 : key.length >= 6 ? 0.8 : 0.99;
          if (score >= min && (!best || score > best.score || (score === best.score && k.spoken && !best.spoken))) best = { ...k, score };
        }
        if (!best || best.term.toLowerCase() === core.toLowerCase()) return null;
        return m[1] + best.term + m[3];
      };
      const two = i + 1 < words.length ? fix(2) : null;
      if (two) { out.push(two); i++; continue; }
      out.push(fix(1) ?? words[i]);
    }
    return out.join(" ");
  }
}
