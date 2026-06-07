import { useRef, useEffect, useCallback } from 'react';
import { Button } from './Button.jsx';

/**
 * ConfirmModal
 *
 * Reusable confirmation dialog built on the app's design-system modal pattern
 * (see FeatureConfigModal / LogPanel). Handles focus management (save + restore),
 * Escape key cancel, backdrop click cancel, and destructive button styling.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   message: string,
 *   confirmLabel: string,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 *   destructive?: boolean,
 * }} props
 */
export default function ConfirmModal({ open, title, message, confirmLabel, onConfirm, onCancel, destructive = false }) {
  const dialogRef    = useRef(null);
  const prevFocusRef = useRef(null);

  // Save the previously-focused element and move focus into the dialog.
  // When the modal closes (open → false or component unmounts), restore focus.
  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      prevFocusRef.current?.focus();
    };
  }, [open]);

  // Keyboard handler: Escape cancels; Tab cycles within focusable elements.
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(
      dialog.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea',
      ),
    );
    if (focusable.length === 0) return;

    const first  = focusable[0];
    const last   = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      // Shift+Tab from first (or dialog container itself) → wrap to last.
      if (active === first || active === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab from last → wrap to first.
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onCancel]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          background: '#1a1a1a',
          border: '1px solid #333',
          padding: 'var(--space-6)',
          minWidth: '280px',
          maxWidth: '400px',
          fontFamily: 'var(--font-mono)',
          outline: 'none',
        }}
      >
        <h2
          id="confirm-modal-title"
          style={{
            margin: '0 0 var(--space-3) 0',
            fontSize: '0.85rem',
            color: '#eee',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {title}
        </h2>
        {message && (
          <p
            style={{
              margin: '0 0 1.25rem 0', /* off-scale: 1.25rem between var(--space-4) and var(--space-6) */
              fontSize: '0.75rem',
              color: '#ccc',
              lineHeight: 1.5,
            }}
          >
            {message}
          </p>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <Button tone="primary" onClick={onCancel}>
            Cancel
          </Button>
          <Button tone={destructive ? 'destructive' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
