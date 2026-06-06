import { refractor } from 'refractor';
import jsx from 'refractor/lang/jsx.js';
import tsx from 'refractor/lang/tsx.js';

// javascript, typescript, css, json, and markdown are bundled in refractor's
// common export. jsx and tsx require explicit registration.
refractor.register(jsx);
refractor.register(tsx);

export { refractor };

const EXTENSION_MAP = {
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.css': 'css',
  '.json': 'json',
  '.md': 'markdown',
};

/**
 * Map a file path's extension to a Prism/refractor language name.
 * Returns null for unknown or missing extensions.
 * @param {string | null | undefined} filePath
 * @returns {string | null}
 */
export function langFromPath(filePath) {
  if (!filePath) return null;
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}
