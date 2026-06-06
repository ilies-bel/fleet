/**
 * Build a plain-text prompt from review notes ready to paste into a chat.
 *
 * Format:
 *
 *   Worktree: <worktree-name>
 *
 *   ## <route>
 *   - <selector> — <text>
 *   - <selector> — <text>
 *
 *   ## General
 *   - <text>
 *
 * Notes are grouped by route (named routes sorted alphabetically, then
 * 'General' last). Within a group notes appear in their original order.
 * Element notes (with a selector) render as `- <selector> — <text>`;
 * general notes (selector-less) render as `- <text>`.
 *
 * @param {string} worktree
 * @param {Array<{selector?: string|null, route?: string|null, text: string}>} notes
 * @returns {string}
 */
export function buildReviewPrompt(worktree, notes) {
  // Group notes by route; notes without a route go under 'General'.
  const groups = {};
  for (const note of notes) {
    const key = note.route || 'General';
    if (!groups[key]) groups[key] = [];
    groups[key].push(note);
  }

  // Stable order: named routes sorted alphabetically, then 'General' last.
  const routeKeys = Object.keys(groups)
    .filter(k => k !== 'General')
    .sort();
  if (groups['General']) routeKeys.push('General');

  const body = routeKeys
    .map(route => {
      const lines = groups[route].map(note =>
        note.selector ? `- ${note.selector} — ${note.text}` : `- ${note.text}`
      );
      return `## ${route}\n${lines.join('\n')}`;
    })
    .join('\n\n');

  return `Worktree: ${worktree}\n\n${body}`;
}
