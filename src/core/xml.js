import { unescapeXml } from './ir.js';

/**
 * Lightweight, Web-Worker-safe XML/HTML helpers (no DOMParser required).
 */

export function parseAttributes(attrStr = '') {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = unescapeXml(val);
  }
  return attrs;
}

/**
 * Find all elements matching a tag name (supports optional namespace prefix like dc:title).
 * Returns array of { tag, attrs, inner, full }.
 */
export function findElements(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escaped}(\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>)`,
    'gi'
  );
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push({
      tag: tagName,
      attrs: parseAttributes(m[1] || ''),
      inner: m[2] || '',
      full: m[0],
    });
  }
  return results;
}

export function findFirstText(xml, tagName) {
  const els = findElements(xml, tagName);
  if (!els.length) return '';
  return unescapeXml(els[0].inner.replace(/<[^>]+>/g, '')).trim();
}

export function extractBodyHtml(html = '') {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const raw = bodyMatch ? bodyMatch[1] : html;
  return raw
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();
}

export function extractTitle(html = '') {
  const t = findFirstText(html, 'title');
  if (t) return t;
  const h1 = findFirstText(html, 'h1') || findFirstText(html, 'h2');
  return h1;
}

/**
 * Resolve a relative path against a base directory path (POSIX-style, used in EPUBs).
 */
export function resolvePath(baseDir, relPath) {
  if (!relPath) return baseDir;
  const cleanRel = relPath.split('#')[0].split('?')[0];
  if (cleanRel.startsWith('/')) return cleanRel.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(cleanRel.split('/'));
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

export function dirname(path = '') {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}
