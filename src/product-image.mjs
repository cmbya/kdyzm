export function normalizeProductImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  const url = value.trim();
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return '';
  const match = /^(?:https?:)?\/\/((?:[a-z0-9]+(?:-[a-z0-9]+)*\.)*(?:alicdn\.com|360buyimg\.com|pddpic\.com)|img\.yangkeduo\.com)(?::443)?(\/[^#]*)?(?:#.*)?$/i.exec(url);
  return match ? 'https://' + match[1].toLowerCase() + (match[2] || '/') : '';
}
