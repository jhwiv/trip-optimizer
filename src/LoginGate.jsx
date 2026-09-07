import { useState, useEffect, useRef } from "react";
import { isGateUnlocked, unlockGate, readGateIdentity } from "./loginGate.js";
import { shouldShowMegHomescreen, markMegHomescreenDismissed } from "./megHomescreen.js";

// Full-screen household unlock. Mounts in front of BOTH SPA surfaces
// (`/` wizard and `/find`) so the planner never renders until a word
// matches. Styling uses the existing cream / navy / teal tokens — no
// new palette, no redesign of the rest of the app.
//
// After a Meg unlock, a one-time iPhone Home Screen coach may sit on
// top of the planner. Travel never sees it. See megHomescreen.js.

export default function LoginGate({ children }) {
  const [unlocked, setUnlocked] = useState(() => isGateUnlocked());
  const [showMegCoach, setShowMegCoach] = useState(() =>
    shouldShowMegHomescreen({ identity: readGateIdentity() }),
  );

  if (!unlocked) {
    return (
      <LoginGateScreen
        onUnlocked={(id) => {
          setUnlocked(true);
          setShowMegCoach(shouldShowMegHomescreen({ identity: id }));
        }}
      />
    );
  }

  return (
    <>
      {children}
      {showMegCoach ? (
        <MegHomescreenCoach
          onDismiss={() => {
            markMegHomescreenDismissed();
            setShowMegCoach(false);
          }}
        />
      ) : null}
    </>
  );
}

function MegHomescreenCoach({ onDismiss }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="meg-homescreen-title"
      data-testid="meg-homescreen-coach"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10001,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 18px",
        background: "rgba(16, 20, 29, 0.46)",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-secondary)",
          borderRadius: "var(--border-radius-lg)",
          padding: "32px 26px 24px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "18px" }}>
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
            <img src="/routesmith-compass.svg?v=3" alt="" style={{ height: "32px", width: "auto" }} />
            <img src="/rs3-wordmark.svg?v=3" alt="" style={{ height: "30px", width: "auto" }} />
          </span>
          <h2
            id="meg-homescreen-title"
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontWeight: 400,
              fontSize: "22px",
              color: "var(--color-text-primary)",
              margin: "14px 0 0",
              textAlign: "center",
              lineHeight: 1.25,
            }}
          >
            Put Route Smith on your Home Screen
          </h2>
          <p style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            color: "var(--color-text-secondary)",
            fontSize: "14px",
            margin: "8px 0 0",
            textAlign: "center",
            lineHeight: 1.4,
          }}>
            One tap next time — like any other app.
          </p>
        </div>

        <ol
          data-testid="meg-homescreen-steps"
          style={{
            margin: "0 0 8px",
            paddingLeft: "22px",
            color: "var(--color-text-primary)",
            fontSize: "15px",
            lineHeight: 1.55,
          }}
        >
          <li style={{ marginBottom: "8px" }}>Open this page in <strong>Safari</strong> (not Chrome).</li>
          <li style={{ marginBottom: "8px" }}>Tap the <strong>Share</strong> button at the bottom — the square with the arrow pointing up.</li>
          <li style={{ marginBottom: "8px" }}>Tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong>.</li>
        </ol>

        <button
          type="button"
          data-testid="meg-homescreen-dismiss"
          onClick={onDismiss}
          style={{
            width: "100%",
            marginTop: "18px",
            border: "none",
            borderRadius: "var(--border-radius-md)",
            padding: "14px 18px",
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            background: "var(--color-text-primary)",
            color: "var(--color-background-primary)",
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function LoginGateScreen({ onUnlocked }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const inputRef = useRef(null);
  const canUnlock = value.trim().length > 0;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    try { inputRef.current?.focus(); } catch { /* ignore */ }
    return () => { document.body.style.overflow = prev; };
  }, []);

  const submit = (e) => {
    if (e) e.preventDefault();
    if (!canUnlock) return;
    const id = unlockGate(value);
    if (!id) {
      setError("That word isn’t recognized. Try again.");
      return;
    }
    setError("");
    onUnlocked(id);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-gate-title"
      data-testid="login-gate"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 18px",
        background: "var(--color-background-secondary)",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: "400px",
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-secondary)",
          borderRadius: "var(--border-radius-lg)",
          padding: "36px 28px 28px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "28px" }}>
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
            <img src="/routesmith-compass.svg?v=3" alt="" style={{ height: "36px", width: "auto" }} />
            <img src="/rs3-wordmark.svg?v=3" alt="" style={{ height: "34px", width: "auto" }} />
          </span>
          <h1
            id="login-gate-title"
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontWeight: 400,
              fontSize: "22px",
              color: "var(--color-text-primary)",
              margin: "16px 0 0",
              letterSpacing: "0.01em",
              textAlign: "center",
            }}
          >
            Private planner
          </h1>
          <p style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            color: "var(--color-text-secondary)",
            fontSize: "14px",
            margin: "6px 0 0",
            textAlign: "center",
          }}>
            Enter the household word to continue.
          </p>
        </div>

        <label
          htmlFor="login-gate-input"
          style={{
            display: "block",
            fontSize: "10px",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fontWeight: 600,
            color: "var(--color-text-secondary)",
            marginBottom: "6px",
          }}
        >
          Passphrase
        </label>
        <div
          data-testid="login-gate-field"
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            boxSizing: "border-box",
            border: error
              ? "0.5px solid var(--color-text-danger)"
              : "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)",
            background: "var(--color-background-primary)",
          }}
        >
          <input
            id="login-gate-input"
            data-testid="login-gate-input"
            ref={inputRef}
            type={visible ? "text" : "password"}
            name="passphrase"
            placeholder="Household word"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "login-gate-error" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError("");
            }}
            style={{
              fontSize: "16px",
              padding: "11px 12px",
              border: "none",
              background: "transparent",
              color: "var(--color-text-primary)",
              flex: 1,
              minWidth: 0,
              width: "100%",
              boxSizing: "border-box",
              outline: "none",
              fontFamily: "inherit",
              lineHeight: "1.4",
            }}
          />
          <button
            type="button"
            data-testid="login-gate-visibility"
            aria-label={visible ? "Hide passphrase" : "Show passphrase"}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: "var(--color-text-secondary)",
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "inherit",
              padding: "11px 12px 11px 4px",
            }}
          >
            {visible ? "Hide" : "Show"}
          </button>
        </div>

        {error ? (
          <p
            id="login-gate-error"
            data-testid="login-gate-error"
            role="alert"
            style={{
              color: "var(--color-text-danger)",
              fontSize: "13px",
              margin: "10px 0 0",
              lineHeight: 1.4,
            }}
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          data-testid="login-gate-submit"
          disabled={!canUnlock}
          style={{
            width: "100%",
            marginTop: "22px",
            border: "none",
            borderRadius: "var(--border-radius-md)",
            padding: "14px 18px",
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: canUnlock ? "pointer" : "not-allowed",
            fontFamily: "inherit",
            background: "var(--color-text-primary)",
            color: "var(--color-background-primary)",
            opacity: canUnlock ? 1 : 0.45,
          }}
        >
          Unlock
        </button>

        <p style={{
          textAlign: "center",
          fontSize: "9.5px",
          color: "var(--color-text-tertiary)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginTop: "20px",
          marginBottom: 0,
          fontWeight: 500,
        }}>
          A travel companion crafted by Barrier Island Digital, LLC
        </p>
      </form>
    </div>
  );
}
