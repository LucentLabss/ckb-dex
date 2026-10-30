import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describeError, logError } from "../utils/errors.js";

const ToastContext = createContext(null);

const DURATION = { error: 8000, warning: 7000, success: 5000, info: 5000 };
const MAX_TOASTS = 4;
const ICONS = { error: "⛔", warning: "⚠", success: "✓", info: "ⓘ" };

/**
 * Top-right notifications. Each toast closes itself after a few seconds
 * (paused while hovered) or with its ✕ button. A `key` replaces any toast
 * already showing with the same key, so repeated failures don't stack.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const notify = useCallback(({ type = "info", title, message, key, duration }) => {
    const id = nextId.current++;
    const toast = { id, type, title, message, key, duration: duration ?? DURATION[type] };
    setToasts((t) => [...t.filter((x) => !key || x.key !== key), toast].slice(-MAX_TOASTS));
    return id;
  }, []);

  /**
   * Logs the technical error to the console and shows the user a plain
   * explanation of what went wrong with `action`.
   */
  const notifyError = useCallback(
    (action, error, { key, context } = {}) => {
      logError(action, error, context);
      const { title, message, type } = describeError(action, error);
      return notify({ type, title, message, key });
    },
    [notify]
  );

  const value = useMemo(() => ({ notify, notifyError, dismiss }), [notify, notifyError, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toasts" role="region" aria-label="Notifications">
          {toasts.map((t) => (
            <Toast key={t.id} toast={t} onClose={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

function Toast({ toast, onClose }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const id = setTimeout(onClose, remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, onClose]);

  return (
    <div
      className={`toast ${toast.type}`}
      role={toast.type === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="toast-ico" aria-hidden="true">
        {ICONS[toast.type]}
      </span>
      <div className="toast-body">
        <b>{toast.title}</b>
        {toast.message && <p>{toast.message}</p>}
      </div>
      <button className="toast-x" onClick={onClose} aria-label="Dismiss notification">
        ✕
      </button>
      <i
        className="toast-timer"
        style={{ animationDuration: `${toast.duration}ms`, animationPlayState: paused ? "paused" : "running" }}
      />
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
