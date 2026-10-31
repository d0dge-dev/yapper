import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The app is a native shell around your deployed Yapper web app: it loads YAPPER_SERVER_URL, so web
 * deploys update the app without a new APK. Only native code changes need a rebuild.
 *
 * Build-time settings (read when `cap sync` runs, e.g. via scripts/android-build.sh):
 *   YAPPER_SERVER_URL        required, https, e.g. https://yapper.example.com/  (the URL you open in the browser)
 *   YAPPER_ALLOW_NAVIGATION  optional, comma-separated hosts that may open inside the app instead of the
 *                            system browser, typically your SSO login host, e.g. auth.example.com
 * See README → "Android app".
 */
const serverUrl = process.env.YAPPER_SERVER_URL?.trim();
if (!serverUrl || !/^https:\/\//.test(serverUrl)) {
  // https is required: the WebView only allows microphone access (getUserMedia) on secure origins.
  throw new Error("YAPPER_SERVER_URL must be set to the https URL of your Yapper server (e.g. https://yapper.example.com/) before `cap sync`.");
}
const allowNavigation = (process.env.YAPPER_ALLOW_NAVIGATION ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const config: CapacitorConfig = {
  appId: "io.github.d0dge_dev.yapper",
  appName: "Yapper",
  // Only the offline page ships in the APK.
  webDir: "www",
  backgroundColor: "#0a0a0a",
  server: {
    url: serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
    // e.g. your SSO's login page; any other host opens in the system browser.
    allowNavigation,
    // Shown (served locally, at <YAPPER_SERVER_URL>/offline.html) when the page can't load,
    // e.g. VPN off or the server down. Retries on its own.
    errorPath: "offline.html",
  },
  android: {
    appendUserAgent: "yap-android",
    allowMixedContent: false,
  },
  plugins: {
    SystemBars: { insetsHandling: "native", initialViewportFitValueHint: "cover" },
  },
};

export default config;
