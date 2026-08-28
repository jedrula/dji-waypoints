// Minimal XML reader: enough for WPML, which is elements and text only -- no
// CDATA, no entities beyond the basic five, no mixed content that matters.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (m, e) =>
  e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ENT[e]);

export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/)?>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let m;
  let last = 0;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    const between = text.slice(last, m.index).trim();
    if (between) top.text += decode(between);
    last = re.lastIndex;
    if (m[2] === undefined) continue; // processing instruction or comment

    if (m[1]) {
      if (top.tag !== m[2]) throw new Error(`mismatched close: </${m[2]}> inside <${top.tag}>`);
      stack.pop();
      continue;
    }
    const node = { tag: m[2], attrs: {}, children: [], text: '' };
    if (m[3]) {
      for (const a of m[3].matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) node.attrs[a[1]] = decode(a[2]);
    }
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${stack[stack.length - 1].tag}>`);
  return root.children[0];
}

// Strip namespace prefixes so wpml:index and index both answer to "index".
const local = (t) => t.replace(/^.*:/, '');

export function find(node, path) {
  let cur = [node];
  for (const part of path.split('/')) {
    cur = cur.flatMap((n) => n.children.filter((c) => local(c.tag) === part));
  }
  return cur;
}
export const first = (node, path) => find(node, path)[0];
export const textOf = (node, path) => first(node, path)?.text;
export function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}
export const tagOf = local;
