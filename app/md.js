// Небольшой рендерер Markdown под экспорт Google Документов: заголовки, списки (вложенные, чекбоксы),
// таблицы, цитаты, код, ссылки, картинки по ссылке-сноске, экранирование «\-» и «\.».
// Ссылки на Google Документы превращаются во внутренние (#doc/ID), чтобы страницы открывались в приложении.
(function () {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DOC_RE = /^https?:\/\/docs\.google\.com\/document\/d\/([\w-]+)/;

  function safeUrl(u, img) {
    u = String(u).trim();
    if (/^(https?:|mailto:|tel:|#)/i.test(u)) return u;
    if (img && /^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return u;
    return '';
  }

  function link(url, html) {
    const doc = url.match(DOC_RE);
    if (doc) return '<a href="#doc/' + doc[1] + '" data-doc="' + doc[1] + '">' + html + '</a>';
    const u = safeUrl(url);
    if (!u) return html;
    const ext = /^https?:/i.test(u);
    return '<a href="' + esc(u) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + html + '</a>';
  }

  function inline(s, refs) {
    const stash = [];
    const keep = html => '\u0000' + (stash.push(html) - 1) + '\u0000';
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~<>=])/g, (m, c) => keep(esc(c)));
    s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + esc(c) + '</code>'));
    s = s.replace(/!\[([^\]]*)\](?:\(<?([^)\s>]+)>?[^)]*\)|\[([^\]]*)\])/g, (m, alt, url, ref) => {
      const u = safeUrl(url || refs[(ref || alt).toLowerCase()] || '', true);
      return u ? keep('<img alt="' + esc(alt) + '" src="' + esc(u) + '" loading="lazy">') : '';
    });
    s = s.replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, t, u) => keep(link(u, inline(t, refs))));
    s = s.replace(/<?(https?:\/\/[^\s<>"«»]+[^\s<>"«».,;:!?)])>?/g, (m, u) => keep(link(u, esc(u.replace(/^https?:\/\/(www\.)?/, '')))));
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_(?=\S)([^_]*?\S)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    for (let i = 0; i < 3 && /\u0000\d+\u0000/.test(s); i++) {
      s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => stash[+n]);
    }
    return s;
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isBlockStart = l => /^(#{1,6}\s|```|>|\s*([-*_])(\s*\2){2,}\s*$)/.test(l) || LIST_RE.test(l) || /^\s*\|/.test(l);

  function cells(row) {
    row = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    return row.replace(/\\\|/g, '\u0001').split('|').map(c => c.replace(/\u0001/g, '\\|').trim());
  }

  function render(src) {
    src = String(src || '').replace(/\r\n?/g, '\n');
    const refs = {};
    src = src.replace(/^\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm, (m, k, u) => { refs[k.toLowerCase()] = u; return ''; });
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      let m;
      if (/^```/.test(l)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        const n = Math.min(m[1].length + 1, 6); // h1 страницы уже в шапке приложения
        out.push('<h' + n + '>' + inline(m[2], refs) + '</h' + n + '>');
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        const emptyHead = head.every(c => !c);
        let t = '<div class="table"><table>';
        if (!emptyHead) t += '<thead><tr>' + head.map(c => '<th>' + inline(c, refs) + '</th>').join('') + '</tr></thead>';
        t += '<tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c, refs) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
        out.push(t);
        continue;
      }
      if (/^>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }
      if (LIST_RE.test(l)) {
        const items = [];
        while (i < lines.length) {
          const x = lines[i];
          const lm = x.match(LIST_RE);
          if (lm) {
            items.push({ ind: lm[1].replace(/\t/g, '    ').length, ord: /\d/.test(lm[2]), text: lm[3] });
            i++;
            continue;
          }
          if (/^\s*$/.test(x)) {
            if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; continue; }
            break;
          }
          if (/^\s+\S/.test(x) && items.length) { items[items.length - 1].text += ' ' + x.trim(); i++; continue; }
          break;
        }
        let html = '';
        const stack = [];
        for (const it of items) {
          while (stack.length && it.ind < stack[stack.length - 1].ind) html += '</li></' + stack.pop().tag + '>';
          const top = stack[stack.length - 1];
          if (!top || it.ind > top.ind) {
            const tag = it.ord ? 'ol' : 'ul';
            stack.push({ ind: it.ind, tag });
            html += '<' + tag + '><li>';
          } else {
            html += '</li><li>';
          }
          const box = it.text.match(/^\[([ xX])\]\s+(.*)$/);
          html += box ? '<span class="check">' + (box[1] === ' ' ? '☐' : '☑') + '</span> ' + inline(box[2], refs) : inline(it.text, refs);
        }
        while (stack.length) html += '</li></' + stack.pop().tag + '>';
        out.push(html);
        continue;
      }
      const buf = [l.trim()];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
      out.push('<p>' + buf.map(b => inline(b, refs)).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  // Первый заголовок страницы дублирует название — его можно убрать перед показом.
  function stripTitle(md, title) {
    const m = String(md || '').match(/^\s*#\s+(.+)\n/);
    if (m && title && norm(m[1]) === norm(title)) return md.slice(m[0].length);
    return md;
  }
  const norm = s => String(s).replace(/[\\*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

  window.MD = { render, stripTitle, esc };
})();
