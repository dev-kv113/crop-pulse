/**
 * Two-step login: enter a phone number, then the code that was sent to it.
 */

import { useState } from "react";

import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { InstallPrompt } from "../components/InstallPrompt";
import { Logo } from "../components/Logo";

export function LoginPage() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      const result = await api.requestOtp(phone);
      setDevOtp(result.dev_otp);
      setStep("code");
    });

  const verify = () =>
    run(async () => {
      signIn(await api.verifyOtp(phone, code));
    });

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-logo">
          <Logo height={34} />
        </div>
        <h1 className="login-title">Crop Analytics</h1>
        <p className="login-subtitle">
          See how your sugarcane is doing, plot by plot.
        </p>

        {step === "phone" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendCode();
            }}
          >
            <label className="field">
              <span>Mobile number</span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="98765 43210"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
              />
            </label>
            <button className="button" type="submit" disabled={busy || !phone}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <p className="login-sent">
              We sent a code to <strong>{phone}</strong>.
            </p>

            {/* Only ever present when the backend runs the console SMS provider,
                so local development needs no SMS gateway. */}
            {devOtp && (
              <p className="dev-otp">
                Development mode — your code is <strong>{devOtp}</strong>
              </p>
            )}

            <label className="field">
              <span>Verification code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </label>
            <button className="button" type="submit" disabled={busy || !code}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                setStep("phone");
                setCode("");
                setError(null);
              }}
            >
              Use a different number
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}

        <InstallPrompt />

        {/* Google Play requires an app behind a sign-in to reach both of these
            from inside the app, not only from the store listing. Plain <a>
            rather than a route: they are static files served alongside the app,
            so they still load if the app itself fails to start. */}
        <p className="legal-links">
          <a href="/privacy.html">Privacy policy</a>
          <span aria-hidden="true"> · </span>
          <a href="/delete-account.html">Delete my account</a>
        </p>
      </div>
    </main>
  );
}
