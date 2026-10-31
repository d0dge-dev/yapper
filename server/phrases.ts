// Everything the call says on its own (not agent text), plus voice command matching.

import type { Lang } from "./speech.ts";
import type { Question } from "./t3adapter.ts";
import { words } from "./speakable.ts";

const toolName = (raw: string) =>
  raw
    .replace(/^mcp__.*?__/, "")
    .replace(/[_-]+/g, " ")
    .trim();

const commandName = (input: string) => {
  const first = input.trim().replace(/^(sudo|cd \S+ &&|env \S+=\S+)\s+/, "").split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "");
};

export const say = {
  ready: (lang: Lang, title: string) => (lang === "de" ? `Verbunden mit ${title}. Ich höre zu.` : `Connected to ${title}. I'm listening.`),
  newThread: (lang: Lang, project: string) =>
    lang === "de" ? `Neuer Thread in ${project}. Worum geht's?` : `New thread in ${project}. What's it about?`,
  launchFailed: (lang: Lang) => (lang === "de" ? "Der Thread liess sich nicht starten." : "Couldn't start the thread."),
  activity(lang: Lang, kind: string, label: string): string {
    const de = lang === "de";
    switch (kind) {
      case "command": {
        const name = commandName(label);
        return name ? (de ? `Führt ${name} aus.` : `Running ${name}.`) : de ? "Führt einen Befehl aus." : "Running a command.";
      }
      case "file":
        return label ? (de ? `Bearbeitet ${label.slice(label.lastIndexOf("/") + 1)}.` : `Editing ${label.slice(label.lastIndexOf("/") + 1)}.`) : de ? "Bearbeitet Dateien." : "Editing files.";
      case "search":
        return label ? (de ? `Sucht im Web nach ${label}.` : `Searching the web for ${label}.`) : de ? "Sucht im Web." : "Searching the web.";
      case "search-files":
        return de ? "Durchsucht Dateien." : "Searching files.";
      case "thinking":
        return de ? "Denkt nach." : "Thinking.";
      case "tool":
        return label ? (de ? `Benutzt ${toolName(label)}.` : `Using ${toolName(label)}.`) : de ? "Benutzt ein Tool." : "Using a tool.";
      case "subagent":
        return de ? "Hat einen Subagenten losgeschickt." : "Started a subagent.";
      default:
        return de ? "Arbeitet noch." : "Still working.";
    }
  },
  stillWorking: (lang: Lang) => (lang === "de" ? "Arbeitet noch." : "Still working."),
  approval: (lang: Lang, prompt: string) =>
    lang === "de" ? `Braucht deine Freigabe: ${prompt}. Ja oder nein?` : `Needs your approval: ${prompt}. Yes or no?`,
  question(lang: Lang, q: Question): string {
    const opts = q.options.map((o) => o.label);
    const list = opts.length > 1 ? `${opts.slice(0, -1).join(", ")} ${lang === "de" ? "oder" : "or"} ${opts.at(-1)}` : opts[0];
    return list ? `${q.question} ${list}?` : q.question;
  },
  manyQuestions: (lang: Lang, n: number) =>
    lang === "de" ? `Hat ${n} Fragen an dich. Die beantwortest du am besten im Thread.` : `It has ${n} questions for you. Best answer those in the thread.`,
  approved: (lang: Lang, ok: boolean) => (lang === "de" ? (ok ? "Freigegeben." : "Abgelehnt.") : ok ? "Approved." : "Declined."),
  answered: (lang: Lang) => (lang === "de" ? "Antwort geschickt." : "Answer sent."),
  interrupted: (lang: Lang) => (lang === "de" ? "Abgebrochen." : "Stopped."),
  failed: (lang: Lang) => (lang === "de" ? "Da ist etwas schiefgelaufen, schau im Thread." : "Something went wrong, check the thread."),
  restInThread: (lang: Lang) => (lang === "de" ? "Den Rest findest du im Thread." : "The rest is in the thread."),
  codeInThread: (lang: Lang) => (lang === "de" ? "Code steht im Thread." : "Code is in the thread."),
  nothingToRepeat: (lang: Lang) => (lang === "de" ? "Ich habe noch nichts gesagt." : "I haven't said anything yet."),
  idle: (lang: Lang) => (lang === "de" ? "Der Agent ist gerade nicht beschäftigt." : "The agent isn't working right now."),
  sendFailed: (lang: Lang) => (lang === "de" ? "Senden hat nicht geklappt." : "Sending failed."),
  callbackSet: (lang: Lang) =>
    lang === "de" ? "Alles klar, ich ruf dich an, sobald ich fertig bin. Bis gleich." : "Got it, I'll call you back when I'm done. Talk soon.",
  callbackNoDevice: (lang: Lang) =>
    lang === "de"
      ? "Zurückrufen geht nur mit der App auf dem Handy, und die hat sich noch nicht angemeldet. Ich bleibe dran."
      : "I can only call you back through the phone app, and it hasn't registered yet. I'll stay on the line.",
  callbackFailed: (lang: Lang) => (lang === "de" ? "Den Rückruf konnte ich nicht einrichten." : "Couldn't set up the callback."),
  callbackGreeting: (lang: Lang, reason: string, kind?: string) => {
    const de = lang === "de";
    if (kind === "assistance" && reason !== "approval" && reason !== "question")
      return de ? "Hey, ich brauche kurz deine Hilfe." : "Hey, I need your help for a moment.";
    if (kind === "info") return de ? "Hey, ich habe eine wichtige Info für dich." : "Hey, I have something important for you.";
    if (reason === "approval") return de ? "Hey, ich brauche kurz deine Freigabe." : "Hey, I need your approval.";
    if (reason === "question") return de ? "Hey, ich habe eine Frage an dich." : "Hey, I have a question for you.";
    if (reason === "failed") return de ? "Hey, da ist leider etwas schiefgegangen." : "Hey, something went wrong.";
    return de ? "Hey, ich bin fertig." : "Hey, I'm done.";
  },
};

/** "Ruf mich zurück", "ruf mich an, wenn du fertig bist", "call me back": anywhere in what was said. */
export const CALLBACK_RE =
  /\b(ruf|rufe|rufst)\s+(mich|du\s+mich)\s+(bitte\s+)?(zurück|zurueck|wieder\s+an|an)\b|\bmelde?\s+dich\s+(per\s+anruf|telefonisch)\b|\bcall\s+me\s+(back|when)\b/i;

// The agent sees this note on every voice message, so it answers like it's on a call.
export const VOICE_HINT =
  "\n\n_(Sent from a voice call: I'm listening, not reading. Keep replies short and conversational, no tables or code unless I ask. Before longer work, say in one sentence what you're about to do.)_";

export type Intent =
  | { type: "interrupt" }
  | { type: "hush" }
  | { type: "repeat" }
  | { type: "status" }
  | { type: "approve"; accept: boolean }
  | { type: "callback" }
  | { type: "message" };

const set = (s: string) => new Set(s.split("|"));
const STOP = set("stopp|stop|abbrechen|abbruch|cancel|halt|stopp stopp|stop stop|hör auf|aufhören|brich ab|abbrechen bitte");
const HUSH = set("ruhe|still|sei still|pause|psst|pst|quiet|shut up|be quiet|klappe|leise");
const REPEAT = set("wiederhol das|wiederholen|nochmal|noch mal|was hast du gesagt|repeat|say that again|again|come again|wie bitte");
const STATUS = set("status|was machst du|was machst du gerade|wie weit bist du|wo stehst du|what are you doing|where are you at|status update|update");
const YES = set("ja|jawohl|jo|ja klar|ja mach|mach|mach das|okay|ok|o k|passt|genehmigt|erlaubt|freigeben|yes|yeah|yep|sure|do it|go|go ahead|approve|approved");
const NO = set("nein|nee|ne|nö|nicht|lieber nicht|ablehnen|abgelehnt|no|nope|don't|do not|deny|decline|stop it");

/** Only short utterances are treated as commands, so normal sentences always reach the agent. */
export function parseIntent(text: string, approvalPending: boolean): Intent {
  const w = words(text);
  if (w.length === 0 || w.length > 5) return { type: "message" };
  const phrase = w.join(" ").replace(/\b(bitte|please|mal|jetzt|now)\b/g, "").replace(/\s+/g, " ").trim();
  if (approvalPending && YES.has(phrase)) return { type: "approve", accept: true };
  if (approvalPending && NO.has(phrase)) return { type: "approve", accept: false };
  if (STOP.has(phrase)) return { type: "interrupt" };
  if (HUSH.has(phrase)) return { type: "hush" };
  if (REPEAT.has(phrase)) return { type: "repeat" };
  if (STATUS.has(phrase)) return { type: "status" };
  if (CALLBACK_RE.test(text) && w.length <= 5) return { type: "callback" };
  return { type: "message" };
}

const ORDINALS: Record<string, number> = {
  erste: 0, ersten: 0, eins: 0, first: 0, one: 0, "1": 0,
  zweite: 1, zweiten: 1, zwei: 1, second: 1, two: 1, "2": 1,
  dritte: 2, dritten: 2, drei: 2, third: 2, three: 2, "3": 2,
  vierte: 3, vier: 3, fourth: 3, four: 3, "4": 3,
};

/** Maps a spoken reply onto one of the question's options, or returns it as a custom answer. */
export function matchAnswer(text: string, q: Question): string | null {
  const heard = words(text).join(" ");
  const byLabel = q.options.find((o) => heard.includes(words(o.label).join(" ")));
  if (byLabel) return byLabel.value;
  for (const w of words(text)) if (w in ORDINALS && q.options[ORDINALS[w]]) return q.options[ORDINALS[w]].value;
  return q.allowCustomAnswer || q.options.length === 0 ? text : null;
}
