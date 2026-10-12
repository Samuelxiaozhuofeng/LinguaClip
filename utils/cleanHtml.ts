// Flattens kept HTML (meanings, examples) to a safe whitelist before it is shown or sent to Anki.

// A kept meaning is HTML (dictionary text we escaped, but also raw AI text and
// glyph images from dictionary pages), so only <b> <i> <br> <ruby> <rt> <rp> and
// http(s) <img> get through; everything else is flattened to its text.
export const clean = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (n: Node): string => [...n.childNodes].map(c => {
    if (c.nodeType === Node.TEXT_NODE) return (c.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!(c instanceof Element)) return '';
    const tag = c.tagName.toLowerCase();
    if (tag === 'br') return '<br/>';
    if (tag === 'script' || tag === 'style') return '';
    if (tag === 'img') { const src = c.getAttribute('src') ?? ''; return /^https?:\/\//.test(src) ? `<img src="${src.replace(/"/g, '&quot;')}">` : ''; }
    return ['b', 'i', 'ruby', 'rt', 'rp'].includes(tag) ? `<${tag}>${walk(c)}</${tag}>` : walk(c);
  }).join('');
  return walk(doc.body);
};
