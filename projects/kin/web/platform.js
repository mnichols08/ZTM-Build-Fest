// What device and browser Kin is running in, for two onboarding needs:
//   - an automatic device name ("Chrome on iPhone"), so nobody has to type one
//     when creating or joining a household (#163; full encrypted names and
//     nicknames are issue #71);
//   - how to install Kin to the Home Screen on iPhone and iPad, where no
//     browser offers an install prompt.
// Pure functions over plain values, so they're unit-tested without a browser;
// currentPlatform() reads the live browser.

const IOS_BROWSERS = [
  [/CriOS\//, "Chrome"],
  [/FxiOS\//, "Firefox"],
  [/EdgiOS\//, "Edge"],
  [/OPiOS\/|OPT\//, "Opera"],
];
const BROWSERS = [
  [/Edg(?:e|A)?\//, "Edge"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrom(?:e|ium)\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function describePlatform({ userAgent = "", maxTouchPoints = 0, standalone = false } = {}) {
  let os = null;
  if (/iPhone|iPod/.test(userAgent)) os = "iPhone";
  else if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) os = "iPad";
  else if (/Android/.test(userAgent)) os = "Android";
  else if (/Windows/.test(userAgent)) os = "Windows";
  else if (/CrOS/.test(userAgent)) os = "ChromeOS";
  else if (/Macintosh/.test(userAgent)) os = "Mac";
  else if (/Linux/.test(userAgent)) os = "Linux";
  const ios = os === "iPhone" || os === "iPad";
  // Every iOS browser is WebKit; only its own token says which app it is.
  const table = ios ? IOS_BROWSERS : BROWSERS;
  const browser = table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? (ios ? "Safari" : null);
  return { os, browser, ios, standalone: Boolean(standalone) };
}

// "Chrome on iPhone"; just "iPhone" inside the installed Home Screen app,
// where the browser it was added from no longer matters.
export function automaticDeviceName({ os, browser, ios, standalone }) {
  if (ios && standalone) return os;
  if (os && browser) return `${browser} on ${os}`;
  return os ?? browser ?? "This device";
}

// Home Screen install steps for iPhone and iPad browsers, or null when Kin is
// already installed or the browser has its own install prompt.
export function installHelp({ os, browser, ios, standalone }) {
  if (!ios || standalone) return null;
  const device = os ?? "iPhone";
  const steps =
    browser === "Safari"
      ? ["Tap the Share button (the square with an arrow).", "Choose Add to Home Screen, then Add."]
      : browser === "Chrome"
        ? ["Tap the Share button in the address bar.", "Choose Add to Home Screen, then Add. (Needs iOS 16.4 or later.)"]
        : [`Open ${browser ?? "this browser"}'s Share menu.`, "Choose Add to Home Screen. If it isn't there, open this page in Safari and add it from there."];
  return {
    title: `Install Kin on your ${device}`,
    steps: [...steps, "Open Kin from your Home Screen and set it up there."],
    note: `On ${device}, the Home Screen app keeps its own data, separate from this browser. Set up in the app you'll use every day.`,
  };
}

export function currentPlatform() {
  return describePlatform({
    userAgent: globalThis.navigator?.userAgent ?? "",
    maxTouchPoints: globalThis.navigator?.maxTouchPoints ?? 0,
    standalone:
      globalThis.navigator?.standalone === true ||
      Boolean(globalThis.matchMedia?.("(display-mode: standalone)").matches),
  });
}
