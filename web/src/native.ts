// Native hooks for the Android app (mobile/, Capacitor). In a browser every function here is a no-op.
//
// The app loads this web app from your server (YAPPER_SERVER_URL at build time), and Capacitor injects its bridge
// (window.Capacitor) into that page, so no @capacitor/* package is bundled: the plugin is called by name.
// Native side: mobile/android/app/src/main/java/io/github/d0dge_dev/yapper/call/YapCallPlugin.kt (API listed there).
//
// What this module does by itself on load (in the app only):
//  - ends a native call left over from before a reload,
//  - YapCall.setup(): notification permission, Telecom account, UnifiedPush registration,
//  - POSTs the UnifiedPush endpoint to api/push/register (now, and whenever it changes),
//  - queues callback answers until someone subscribes with onNativeAnswer().

type Listener = { remove(): Promise<void> };
type CapacitorBridge = {
  isNativePlatform(): boolean;
  isPluginAvailable(name: string): boolean;
  nativePromise<T = unknown>(plugin: string, method: string, options?: object): Promise<T>;
  addListener(plugin: string, event: string, callback: (data: unknown) => void): Listener;
};

const cap = (window as { Capacitor?: CapacitorBridge }).Capacitor;
const PLUGIN = "YapCall";

/** Running inside the Android app (as opposed to Chrome/PWA). */
export const isNative = !!cap?.isNativePlatform?.() && !!cap?.isPluginAvailable?.(PLUGIN);

const native = <T = unknown>(method: string, options?: object): Promise<T> =>
  isNative && cap ? cap.nativePromise<T>(PLUGIN, method, options) : Promise.reject(new Error("not in the app"));

// ------------------------------------------------------------------ ongoing call

let onHangup: (() => void) | null = null;

/**
 * Call started (mic already open): the app turns it into a phone call (Telecom: Bluetooth/headset buttons,
 * a GSM call ends it), keeps it alive with the screen locked, shows the call notification with hang-up,
 * and makes the volume keys work. `hangup` runs when the call is ended natively.
 * Debug switches (localStorage, "off" disables): `yap.native.audioRouting` (speaker-by-default routing),
 * `yap.native.telecom` (Telecom; without it AudioManager does the routing), `yap.native.volumeMirror`.
 */
export function nativeCallStarted(title: string, hangup: () => void) {
  if (!isNative) return;
  onHangup = hangup;
  const on = (key: string) => localStorage.getItem(`yap.native.${key}`) !== "off";
  native("startCall", { title, audioRouting: on("audioRouting"), telecom: on("telecom"), volumeMirror: on("volumeMirror") }).catch((e) =>
    console.warn("YapCall.startCall", e),
  );
}

/** Call ended (any reason): end the native call and remove the notification. */
export function nativeCallEnded() {
  if (!isNative) return;
  onHangup = null;
  native("endCall").catch(() => {});
}

// ------------------------------------------------------------------ callback answers

export type NativeAnswer = { callId: string; threadId: string };

const answerListeners = new Set<(a: NativeAnswer) => void>();
const answerQueue: NativeAnswer[] = [];
const answered = new Set<string>();

function gotAnswer(data: unknown) {
  const a = data as Partial<NativeAnswer> | null;
  if (!a || typeof a.callId !== "string" || typeof a.threadId !== "string" || answered.has(a.callId)) return;
  answered.add(a.callId); // the event and setup() may both carry it
  const answer = { callId: a.callId, threadId: a.threadId };
  if (answerListeners.size) answerListeners.forEach((l) => l(answer));
  else answerQueue.push(answer);
}

/**
 * A callback ring was answered on the phone: open `threadId` and start a call with `{ callback: callId }`.
 * Answers that arrived before anyone subscribed (the page was still loading) are delivered right away.
 * Returns an unsubscribe function.
 */
export function onNativeAnswer(cb: (a: NativeAnswer) => void): () => void {
  answerListeners.add(cb);
  for (const a of answerQueue.splice(0)) cb(a);
  return () => answerListeners.delete(cb);
}

// ------------------------------------------------------------------ audio routes

export type AudioRoute = "speaker" | "earpiece" | "bluetooth" | "wired";
export type AudioRoutes = {
  /** null while there is no native call (or it isn't routed yet). */
  current: AudioRoute | null;
  /** In display/cycle order: speaker, earpiece, bluetooth, wired. */
  available: AudioRoute[];
  /** Device names where known, e.g. the Bluetooth headset's. */
  names: Partial<Record<AudioRoute, string>>;
};

export const AUDIO_ROUTE_LABELS: Record<AudioRoute, string> = {
  speaker: "Lautsprecher",
  earpiece: "Hörer",
  bluetooth: "Bluetooth",
  wired: "Kopfhörer",
};

const NO_ROUTES: AudioRoutes = { current: null, available: [], names: {} };
let routes: AudioRoutes = NO_ROUTES;
const routeListeners = new Set<(r: AudioRoutes) => void>();

function setRoutes(data: unknown) {
  const r = data as Partial<AudioRoutes> | null;
  routes = { current: r?.current ?? null, available: r?.available ?? [], names: r?.names ?? {} };
  routeListeners.forEach((l) => l(routes));
}

/** The call's audio routes right now (fresh from the app). */
export async function getAudioRoutes(): Promise<AudioRoutes> {
  if (!isNative) return NO_ROUTES;
  try {
    setRoutes(await native("getAudioRoutes"));
  } catch {}
  return routes;
}

/** Calls `cb` with the current routes and on every change. Returns an unsubscribe function. */
export function onAudioRoutes(cb: (r: AudioRoutes) => void): () => void {
  routeListeners.add(cb);
  cb(routes);
  getAudioRoutes();
  return () => routeListeners.delete(cb);
}

/** Switches the call audio to `route`; false if it isn't available. */
export async function setAudioRoute(route: AudioRoute): Promise<boolean> {
  if (!isNative) return false;
  try {
    setRoutes(await native("setAudioRoute", { route }));
    return true;
  } catch (e) {
    console.warn("YapCall.setAudioRoute", e);
    return false;
  }
}

/** The route a tap on the route button switches to (cycles through the available ones). */
export function nextAudioRoute(r: AudioRoutes): AudioRoute | null {
  if (!r.available.length) return null;
  return r.available[(r.available.indexOf(r.current as AudioRoute) + 1) % r.available.length];
}

// ------------------------------------------------------------------ status, push, settings

export type NativeStatus = {
  device: string;
  /** UnifiedPush endpoint, null until the distributor (ntfy) has registered the app. */
  endpoint: string | null;
  distributor: string | null;
  distributors: string[];
  notifications: boolean;
  /** Android 14+: rings may take over the locked screen (user setting). */
  fullScreenIntent: boolean;
  telecom: boolean;
};

export async function getNativeStatus(): Promise<NativeStatus | null> {
  if (!isNative) return null;
  return native<NativeStatus>("status").catch(() => null);
}

/** Opens the app's system settings page for full-screen rings or notifications, or the push distributor picker. */
export function openNativeSettings(what: "fullScreenIntent" | "notifications" | "distributor") {
  if (!isNative) return;
  native("openSettings", { what }).catch((e) => console.warn("YapCall.openSettings", e));
}

/** Tells the server where to ring this phone. Sent on every app start; the server de-duplicates. */
async function registerPush(endpoint: unknown, device: unknown) {
  if (typeof endpoint !== "string" || !endpoint) return;
  try {
    const res = await fetch("api/push/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      redirect: "manual", // logged out: the SSO proxy redirects; nothing to do then, the next start retries
      body: JSON.stringify({ endpoint, device: typeof device === "string" && device ? device : "Android" }),
    });
    if (!res.ok && res.type !== "opaqueredirect") console.warn(`push register: HTTP ${res.status}`);
  } catch (e) {
    console.warn("push register", e);
  }
}

// ------------------------------------------------------------------ boot

if (isNative && cap) {
  // Listeners first: setup() and a native answer may follow immediately.
  cap.addListener(PLUGIN, "hangup", () => onHangup?.());
  cap.addListener(PLUGIN, "answer", gotAnswer);
  cap.addListener(PLUGIN, "audioRoute", setRoutes);
  cap.addListener(PLUGIN, "pushEndpoint", (d) => {
    const e = d as { endpoint?: string; device?: string } | null;
    registerPush(e?.endpoint, e?.device);
  });
  // A fresh page has no call; end one left over from before a reload. (An answered callback waiting for
  // this page is not a call yet and survives.)
  native("endCall").catch(() => {});
  native<NativeStatus & { answer?: NativeAnswer }>("setup")
    .then((s) => {
      if (s.answer) gotAnswer(s.answer);
      registerPush(s.endpoint, s.device);
      if (!s.distributor) console.info("yap: no UnifiedPush distributor; install ntfy for callback rings");
    })
    .catch((e) => console.warn("YapCall.setup", e));
}
