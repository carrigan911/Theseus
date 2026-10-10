// Small Markdown renderer for Claude's replies in the Session Console (Docs/Specs/SessionConsole_Stage4_Spec.md, Q4).
// Every piece of text is HTML-escaped before any markup is added, so a reply can never inject HTML. Handles headings,
// paragraphs, - / * / 1. lists (one level of nesting), > quotes, --- rules, ``` code blocks, | tables |, and inline `code`,
// **bold**, *italic*, ~~strike~~ and [links](https://…). Links carry data-href (http / https only) and open through the host.
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// inline markup on one line of raw text: code spans are cut out first so nothing inside them is touched
function inline(raw) {
  const parts = String(raw).split(/(`[^`\n]+`)/g);
  return parts.map((p, i) => {
    if (i % 2) return '<code>' + esc(p.slice(1, -1)) + '</code>';
    // links wait as placeholders while the emphasis passes run, so a URL's _ or * never turns into markup
    const links = [], keep = (u, t) => { links.push(`<a data-href="${u}" title="${u}">${t}</a>`); return `\u0000${links.length - 1}\u0000`; };
    let s = esc(p).replace(/\u0000/g, '');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => keep(u, t));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, u) => pre + keep(u, u));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, k) => links[+k]);
  }).join('');
}
const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

const flat = q => '<p>' + q.map(inline).join('<br>') + '</p>';
export function md(text, depth = 0) {   // depth: quotes and lists nested in each other (capped, so deep nesting cannot overflow)
  const L = String(text).replace(/\r\n?/g, '\n').split('\n'), out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  while (i < L.length) {
    const l = L[i];
    let m;
    if ((m = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(l))) {             // fenced code block (unclosed: to the end)
      flush(); const fence = m[1][0], code = []; i++;
      while (i < L.length && !new RegExp('^\\s*\\' + fence + '{3,}\\s*$').test(L[i])) code.push(L[i++]);
      i++; out.push(`<pre class="mdc"${m[2] ? ` data-lang="${esc(m[2])}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { flush(); const n = Math.min(6, m[1].length + 2); out.push(`<h${n} class="mdh">${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < L.length && isSep(L[i + 1])) {         // table: header, separator, rows
      flush(); const head = cells(l), al = cells(L[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : '');
      const td = (c, k, t) => `<${t}${al[k] ? ` style="text-align:${al[k]}"` : ''}>${inline(c)}</${t}>`;
      let h = '<div class="mdt"><table><thead><tr>' + head.map((c, k) => td(c, k, 'th')).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < L.length && L[i].includes('|') && L[i].trim()) { h += '<tr>' + cells(L[i]).map((c, k) => td(c, k, 'td')).join('') + '</tr>'; i++; }
      out.push(h + '</tbody></table></div>'); continue;
    }
    if (/^\s*>/.test(l)) {                                                  // quote
      flush(); const q = [];
      while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + (depth < 8 ? md(q.join('\n'), depth + 1) : flat(q)) + '</blockquote>'); continue;
    }
    if (LI.test(l)) {                                                       // list (items indented deeper nest one level)
      flush(); const top = LI.exec(l), ind = top[1].length, ord = /\d/.test(top[2]);
      let h = ord ? `<ol${+top[2].replace(/\D/g, '') !== 1 ? ` start="${+top[2].replace(/\D/g, '')}"` : ''}>` : '<ul>', item = null, sub = [];
      const close = () => { if (item !== null) { h += '<li>' + inline(item) + (sub.length ? depth < 8 ? md(sub.join('\n'), depth + 1) : flat(sub) : '') + '</li>'; item = null; sub = []; } };
      while (i < L.length) {
        const x = L[i], mm = LI.exec(x);
        if (mm && mm[1].length <= ind) { if (/\d/.test(mm[2]) !== ord) break; close(); item = mm[3]; i++; continue; }
        if (item !== null && (mm || (/^\s+\S/.test(x) && x.search(/\S/) > ind))) { sub.push(x.slice(Math.min(x.search(/\S/), ind + 2))); i++; continue; }
        if (item !== null && x.trim() && !LI.test(x) && /^\s{2,}/.test(x)) { item += ' ' + x.trim(); i++; continue; }
        break;
      }
      close(); out.push(h + (ord ? '</ol>' : '</ul>')); continue;
    }
    para.push(l); i++;
  }
  flush();
  return out.join('');
}
