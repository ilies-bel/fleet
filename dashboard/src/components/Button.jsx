/**
 * Button primitive — enforces the three-tone colour contract:
 *   primary     → phosphor-green (#00ff88)  affirmative / primary actions
 *   caution     → amber (#ffb000)            use-with-care actions
 *   destructive → red (#ff4444)              permanent / irreversible actions
 *
 * Zero border-radius and JetBrains Mono are enforced via .btn in index.css.
 * All other props (onClick, disabled, style, aria-*, title …) are forwarded
 * to the underlying <button> via the rest spread.
 */
export function Button({ tone = 'primary', className, children, ...rest }) {
  const cls = className ? `btn btn-${tone} ${className}` : `btn btn-${tone}`;
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
