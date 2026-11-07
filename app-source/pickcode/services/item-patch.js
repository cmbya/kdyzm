// Do not resend unchanged form fields: a widget may have changed pickup status while editing.
export function itemPatch(original, edited) {
  const patch = {};
  for (const key of ['code', 'company', 'tags', 'remark', 'isPicked']) {
    if (JSON.stringify(original[key]) !== JSON.stringify(edited[key])) patch[key] = edited[key];
  }
  return patch;
}
