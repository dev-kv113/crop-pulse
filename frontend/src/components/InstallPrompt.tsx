/**
 * "Install app" — a single quiet row on the login screen.
 *
 * Android fires `beforeinstallprompt`, which we keep hold of and replay when the
 * user taps our button; its own banner is easy to miss. iOS never fires it and
 * offers no programmatic install, so there the only honest thing is to name the
 * two steps.
 *
 * It disappears for good once the app is installed or the user declines — see
 * `shouldHide` for how that is decided.
 */

import { useEffect, useState } from "react";

/** The Chrome-only event that lets us defer and re-trigger the install. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const HIDDEN_KEY = "crop-analytics.install-hidden";

/** True when the page is running as an installed app rather than a browser tab. */
function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari reports it here instead of through the media query.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(
    () => localStorage.getItem(HIDDEN_KEY) === "1",
  );

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Suppress Chrome's own banner; ours is clearer and better placed.
      event.preventDefault();
      setDeferred(event as InstallPromptEvent);
    };

    // Fires the moment the install completes. Recording it here is what stops
    // the row coming back when someone later opens the site in a normal tab:
    // `isStandalone()` is false there, and on iOS no event would tell us either.
    const onInstalled = () => {
      localStorage.setItem(HIDDEN_KEY, "1");
      setHidden(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    localStorage.setItem(HIDDEN_KEY, "1");
    setHidden(true);
  };

  if (hidden || isStandalone()) return null;

  if (isIos()) {
    return (
      <div className="install-row">
        <span className="install-text">
          Install app: <strong>Share</strong> → <strong>Add to Home Screen</strong>
        </span>
        <button className="install-dismiss" onClick={dismiss}>
          Not now
        </button>
      </div>
    );
  }

  // No deferred event means the browser cannot install this page - already
  // installed, or Firefox/desktop Safari. Showing a dead button would be worse
  // than showing nothing.
  if (!deferred) return null;

  return (
    <div className="install-row">
      <span className="install-text">Install app</span>
      <div className="install-actions">
        <button
          className="button button-small"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            // The event is single-use, whatever the user chose.
            setDeferred(null);
          }}
        >
          Install
        </button>
        <button className="install-dismiss" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
