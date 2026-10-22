import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./StartupGate.css";

interface StartupGateProps {
  /** Resolves when the app can start; a rejection shows the error screen with a retry button. */
  verify: () => Promise<void>;
  children: ReactNode;
}

type GateState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "failed"; message: string };

/** The check is a few sequential RPC calls; without a cap a stalled request would hang the page. */
const VERIFY_TIMEOUT_MS = 20_000;
/** Reassure the user that a slow public RPC is not a frozen page. */
const SLOW_HINT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("The CKB node took too long to respond.")),
      ms,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function Logo({ className }: { className?: string }) {
  return <img className={className} src="/logo.png" alt="" width={96} height={96} draggable={false} />;
}

export default function StartupGate({ verify, children }: StartupGateProps) {
  const [state, setState] = useState<GateState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_HINT_MS);

    withTimeout(verify(), VERIFY_TIMEOUT_MS).then(
      () => {
        if (!cancelled) setState({ status: "ready" });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error && error.message
          ? error.message
          : "Unable to verify the CKB deployment.";
        setState({ status: "failed", message });
      },
    );

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [verify, attempt]);

  const retry = useCallback(() => {
    setState({ status: "checking" });
    setSlow(false);
    setAttempt((count) => count + 1);
  }, []);

  if (state.status === "ready") return <>{children}</>;

  const failed = state.status === "failed";

  return (
    <main className="startup" aria-busy={!failed}>
      <div className="startup-card">
        <div className={failed ? "startup-mark is-failed" : "startup-mark"}>
          <span className="startup-glow" aria-hidden="true" />
          <svg className="startup-ring" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="startup-ring-gradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ea2690" />
                <stop offset="100%" stopColor="#0098dc" />
              </linearGradient>
            </defs>
            <circle className="startup-ring-track" cx="60" cy="60" r="56" />
            <circle className="startup-ring-arc" cx="60" cy="60" r="56" stroke="url(#startup-ring-gradient)" />
          </svg>
          <Logo className="startup-logo" />
        </div>

        <h1 className="startup-title">LucentDex</h1>

        {failed ? (
          <div role="alert" className="startup-status">
            <p className="startup-error-title">Couldn&apos;t connect to CKB</p>
            <p className="startup-error-detail">{state.message}</p>
            <button type="button" className="startup-retry" onClick={retry}>
              Try again
            </button>
          </div>
        ) : (
          <div role="status" className="startup-status">
            <p className="startup-message">Checking CKB deployment…</p>
            <div className="startup-bar" aria-hidden="true">
              <span />
            </div>
            <p className={slow ? "startup-hint is-visible" : "startup-hint"}>
              Still working. The CKB node is responding slowly.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
