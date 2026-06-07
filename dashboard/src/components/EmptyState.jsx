import { useState, useRef, useCallback } from 'react';

/**
 * First-run / empty-state primitive.
 *
 * Fleet's onboarding surface is the empty state itself: there is no signup or
 * wizard, so the blank dashboard a fresh operator lands on has to do the
 * teaching. This renders like a terminal prompt waiting for input — a status
 * line that reports the true state ("0 features registered"), one line on why,
 * and the exact command that changes that state, copyable in one click.
 *
 * Honours "The Status Line" north star: status before chrome, color+label
 * together, zero-radius, one mono face, no illustration or hero. Contrast is
 * pinned to legible ink (the old #333 stubs failed AA on near-black).
 *
 * @param {object}   props
 * @param {string}   props.status      Status-line text, e.g. "0 FEATURES REGISTERED".
 * @param {string}   [props.statusColor]  Lifecycle color for the dot+label. Default ink-dim.
 * @param {string}   props.lead        One short sentence: what goes here / why it matters.
 * @param {string}   [props.command]   Shell command to register first value, e.g. "fleet add <name> <branch>".
 * @param {string}   [props.hint]      Optional sub-hint under the command (where it appears next).
 * @param {'panel'|'sidebar'} [props.variant='panel']  Layout density. sidebar = narrow drawer column.
 */
export default function EmptyState({
  status,
  statusColor = 'var(--color-ink-dim)',
  lead,
  command,
  hint,
  variant = 'panel',
}) {
  const isSidebar = variant === 'sidebar';

  return (
    <div
      style={{
        flex: isSidebar ? undefined : 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: isSidebar ? 'stretch' : 'center',
        justifyContent: isSidebar ? 'flex-start' : 'center',
        gap: 'var(--space-3)',
        padding: isSidebar ? 'var(--space-4) var(--space-3)' : 'var(--space-6) var(--space-4)',
        textAlign: 'left',
        fontFamily: 'var(--font-mono)',
        color: 'var(--color-ink)',
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          width: '100%',
          minWidth: 0,
          maxWidth: isSidebar ? undefined : '34rem',
        }}
      >
        {/* Status line: the true state, color + label together. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-15)',
            color: statusColor,
            fontSize: isSidebar ? '0.62rem' : '0.75rem',
            fontWeight: 700,
            letterSpacing: '0.06em',
          }}
        >
          <span aria-hidden="true">●</span>
          <span>{status}</span>
        </div>

        {/* One line on why / what appears here. Legible muted, never the #333 floor. */}
        <p
          style={{
            margin: 0,
            color: 'var(--color-muted)',
            fontSize: isSidebar ? '0.62rem' : '0.72rem',
            lineHeight: 1.5,
            maxWidth: isSidebar ? undefined : 'min(60ch, 100%)',
            textWrap: 'pretty',
          }}
        >
          {lead}
        </p>

        {command && <CommandLine command={command} compact={isSidebar} />}

        {hint && (
          <p
            style={{
              margin: 0,
              color: 'var(--color-ink-dim)',
              fontSize: isSidebar ? '0.58rem' : '0.65rem',
              lineHeight: 1.5,
            }}
          >
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A copyable shell command rendered as a terminal prompt line.
 * The `$` is decorative chrome; the command text is the payload. Copy writes
 * the command (without the `$`) and confirms in place via the bracket grammar.
 */
function CommandLine({ command, compact }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const copy = useCallback(async () => {
    // Modern path first; fall back to execCommand for insecure contexts where
    // navigator.clipboard is unavailable. Either way the command stays visible
    // to type by hand, so a hard failure is a no-op, not a dead end.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        flashCopied();
        return;
      }
    } catch {
      /* fall through to execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = command;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) flashCopied();
    } catch {
      /* clipboard fully unavailable — command remains on screen to copy manually */
    }
  }, [command, flashCopied]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-black)',
      }}
    >
      <code
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-15)',
          padding: compact ? 'var(--space-15) var(--space-2)' : 'var(--space-2) var(--space-3)',
          fontFamily: 'var(--font-mono)',
          fontSize: compact ? '0.6rem' : '0.72rem',
          color: 'var(--color-ink)',
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden="true" style={{ color: 'var(--color-accent)', flexShrink: 0 }}>$</span>
        <span>{command}</span>
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy command: ${command}`}
        className="empty-state-copy"
        style={{
          flexShrink: 0,
          background: 'transparent',
          border: 'none',
          borderLeft: '1px solid var(--color-border)',
          color: copied ? 'var(--color-accent)' : 'var(--color-ink-dim)',
          fontFamily: 'var(--font-mono)',
          fontSize: compact ? '0.55rem' : '0.62rem',
          letterSpacing: '0.06em',
          padding: compact ? '0 var(--space-2)' : '0 var(--space-3)',
          cursor: 'pointer',
        }}
      >
        {copied ? '[COPIED]' : '[COPY]'}
      </button>
    </div>
  );
}
