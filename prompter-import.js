/* Script import for the video prompter.
   Reads a Word (.docx), PDF, or plain-text script on the iPad itself (nothing is uploaded),
   strips the title block and section headings, and turns every written pause
   ([SILENCE: ~20 seconds], (pause), BEAT, "long pause", "1 minute silence"…) into a
   prompter pause the pace model understands. */
(() => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  // ---------- .docx: a zip holding word/document.xml ----------
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t open Word files. Update the iPad, or paste the script in.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function zipEntry(buf, name) {
    const v = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That Word file looks damaged. Try saving it again, or export it as a PDF.');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const fname = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      if (fname === name) {
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = u8.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('That Word file uses a compression the iPad can’t read. Export it as a PDF instead.');
      }
      p += 46 + nlen + xlen + clen;
    }
    throw new Error('That doesn’t look like a Word document (.docx). Older .doc files need saving as .docx or PDF first.');
  }
  async function docxLines(buf) {
    const xml = new TextDecoder().decode(await zipEntry(buf, 'word/document.xml'));
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const lines = [];
    for (const para of doc.getElementsByTagNameNS(W, 'p')) {
      if (para.parentNode && para.parentNode.closest && para.parentNode.closest('p')) continue; // text boxes inside a paragraph
      let s = '';
      const walk = el => {
        for (const c of el.children) {
          if (c.namespaceURI === W && c.localName === 't') s += c.textContent;
          else if (c.namespaceURI === W && c.localName === 'tab') s += ' ';
          else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) s += '\n';
          else if (c.namespaceURI === W && (c.localName === 'p' || c.localName === 'del' || c.localName === 'instrText')) continue;
          else walk(c);
        }
      };
      walk(para);
      lines.push(...s.split('\n'), '');
    }
    return lines;
  }

  // ---------- PDF: rebuild lines and paragraphs from positioned text ----------
  let pdfjs;
  async function pdfLines(buf) {
    if (!pdfjs) {
      pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    }
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const rows = []; // { text, y, h, page }
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      let cur = null;
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
        if (!cur || Math.abs(y - cur.y) > h * 0.5) {
          if (cur && cur.text.trim()) rows.push(cur);
          cur = { text: '', y, h, page: n, x0: it.transform[4], x1: it.transform[4] };
        }
        cur.text += it.str;
        if (it.str.trim()) { cur.x0 = Math.min(cur.x0, it.transform[4]); cur.x1 = Math.max(cur.x1, it.transform[4] + (it.width || 0)); }
        if (it.hasEOL) { if (cur.text.trim()) rows.push(cur); cur = null; }
      }
      if (cur && cur.text.trim()) rows.push(cur);
    }
    // Drop page numbers and running footers.
    const body = rows.filter(r => !/^\s*(page\s*)?\d+(\s*(of|\/)\s*\d+)?\s*$/i.test(r.text));
    const gaps = [];
    for (let i = 1; i < body.length; i++) if (body[i].page === body[i - 1].page) gaps.push(body[i - 1].y - body[i].y);
    const pos = gaps.filter(g => g > 0).sort((a, b) => a - b);
    const lineGap = pos.length ? pos[Math.floor(pos.length * 0.3)] : 14;
    // Text that wraps fills the line; a line that stops well short of the right edge ends its paragraph.
    const widths = body.map(r => r.x1 - r.x0).sort((a, b) => a - b);
    const full = widths.length ? widths[Math.floor(widths.length * 0.9)] : 0;
    const out = [];
    let para = '';
    const flush = () => { if (para.trim()) out.push(para.trim(), ''); para = ''; };
    body.forEach((r, i) => {
      const t = r.text.replace(/\s+/g, ' ').trim();
      if (i > 0) {
        const prev = body[i - 1];
        const newPage = r.page !== prev.page;
        const gap = prev.y - r.y;
        const ended = /[.!?…:"”’)\]]$/.test(prev.text.trim());
        const short = full > 0 && (prev.x1 - prev.x0) < full * 0.72 && !/-$/.test(prev.text.trim());
        const breakHere = newPage ? (ended || short) : (gap > lineGap * 1.45 || gap < 0 || short);
        if (breakHere || isCue(t) || isCue(prev.text.trim())) flush();
      }
      if (para && /[A-Za-z]-$/.test(para) && /^[a-z]/.test(t)) para = para.slice(0, -1) + t;
      else para += (para ? ' ' : '') + t;
    });
    flush();
    return out;
  }

  // ---------- pauses ----------
  const NUM = String.raw`(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?`;
  const UNIT = String.raw`(?:\s*(s|secs?|seconds?|m|mins?|minutes?))?`;
  function seconds(text, fallback) {
    const m = text.match(new RegExp(NUM + UNIT, 'i'));
    if (!m) return fallback;
    let n = m[2] ? (Number(m[1]) + Number(m[2])) / 2 : Number(m[1]);
    if (m[3] && /^m/i.test(m[3])) n *= 60;
    return Math.max(1, Math.min(600, Math.round(n * 10) / 10));
  }
  function cueFor(word, rest) {
    const w = word.toLowerCase(), long = /long/i.test(rest), short = /short|brief/i.test(rest);
    if (/^breath/.test(w) && !/\d/.test(rest)) return '[Breath]';
    if (w === 'beat') return `[Pause ${seconds(rest, long ? 3 : 1)}]`;
    if (w === 'silence') return `[Silence ${seconds(rest, long ? 10 : short ? 2 : 3)}]`;
    return `[Pause ${seconds(rest, long ? 5 : short ? 1 : 2)}]`;
  }
  const BRACKET = /[\[\(]\s*((?:long|short|brief)\s+)?(silence|pause|beat|breath|breathe)\b([^\]\)]*)[\]\)]/gi;
  // A line that is nothing but a direction, e.g. "PAUSE", "— Pause for 10 seconds —", "*beat*", "Long silence (1 min)".
  const BARE = /^[\s*_~—–-]*((?:long|short|brief)\s+)?(silence|pause|beat|breath|breathe)\b(.{0,40}?)[\s*_~—–.-]*$/i;
  // What may follow the word on a bare direction line: only a length ("for about 10 seconds", ": 1 min", "(5s)").
  const BARE_REST = /^[\s:(~\[]*(?:for\s+)?(?:about\s+|around\s+|approx\.?\s+|roughly\s+)?~?(?:\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*(?:s|secs?|seconds?|m|mins?|minutes?)?)?[\s)\]?.]*$/i;
  function isCue(t) { return /^\s*\[(silence|pause|breath)[^\]]*\]\s*$/i.test(t); }
  function normalisePauses(line) {
    let count = 0;
    let s = line.replace(BRACKET, (_, mod, word, rest) => { count++; return ` ${cueFor(word, (mod || '') + rest)} `; });
    const bare = s.trim().match(BARE);
    if (bare && !isCue(s) && BARE_REST.test(bare[3])) {
      s = cueFor(bare[2], (bare[1] || '') + bare[3]); count++;
    }
    return { s: s.replace(/\s{2,}/g, ' ').trim(), count };
  }

  // ---------- clean-up ----------
  const words = t => t.split(/\s+/).filter(Boolean).length;
  const ends = t => /[.!?…]["”’)]*$/.test(t);
  function isTitleLine(t) {
    return /^last\s+updated\b/i.test(t) || /^(core\s+)?(video|audio)(\s+script)?$/i.test(t)
      || /^(week|wk|w)\s*\d+\b.*\b(day|d)\s*\d+\b/i.test(t) || /^day\s*\d+\b/i.test(t)
      || (words(t) <= 8 && !ends(t));
  }
  function isTitle(t) { return words(t) <= 10 && isTitleLine(t);
  }
  function isHeading(t) {
    if (isCue(t)) return false;
    if (/^(part|section|segment|scene|module)\s+[A-Za-z0-9]+\b/i.test(t) && words(t) <= 8 && !ends(t)) return true;
    const letters = t.replace(/[^A-Za-z]/g, '');
    return letters.length >= 3 && letters === letters.toUpperCase() && words(t) <= 8 && !/[a-z]/.test(t);
  }
  function clean(rawLines) {
    const lines = rawLines.map(l => l.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim());
    const removed = [];
    let pauses = 0, pauseSecs = 0;
    // Title block: leading lines until the first real sentence.
    let i = 0, seen = 0;
    // A "Last updated …" line near the top closes the title block, whatever sits above it.
    const nonEmpty = lines.map((t, k) => (t ? k : -1)).filter(k => k >= 0).slice(0, 8);
    const stamp = nonEmpty.find(k => /^(last\s+)?(updated|revised|draft)\b/i.test(lines[k]) && words(lines[k]) <= 10);
    if (stamp !== undefined) { for (; i <= stamp; i++) if (lines[i]) removed.push(lines[i]); }
    while (i < lines.length && seen < 6) {
      const t = lines[i];
      if (!t) { i++; continue; }
      if (isCue(normalisePauses(t).s) || !isTitle(t)) break;
      removed.push(t); i++; seen++;
    }
    const out = [];
    for (; i < lines.length; i++) {
      const t = lines[i];
      if (!t) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      const { s, count } = normalisePauses(t);
      if (!count && isHeading(s)) { removed.push(t); if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      // Other bracketed stage directions ([MUSIC IN], [B-ROLL]) are not read aloud.
      const kept = s.replace(/\[([^\]]*)\]/g, (m, inner) => (/^(silence|pause|breath)\b/i.test(inner) ? m : (removed.push(m), ''))).trim();
      if (!kept) continue;
      pauses += count;
      // Put each pause on its own line so it shows as its own block on the prompter.
      const parts = kept.split(/(\[(?:silence|pause|breath)[^\]]*\])/i).map(x => x.trim()).filter(Boolean);
      for (const part of parts) {
        if (isCue(part)) { pauseSecs += /breath/i.test(part) ? 1 : seconds(part, 2); if (out.length && out[out.length - 1] !== '') out.push(''); out.push(part, ''); }
        else out.push(part);
      }
    }
    // Lines inside one paragraph stay separate paragraphs (Word soft returns), blank lines between them.
    const text = out.join('\n').replace(/\n(?!\n)/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, removed, pauses, pauseSecs };
  }

  async function fromFile(file) {
    const name = file.name || 'script';
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const buf = await file.arrayBuffer();
    let lines;
    if (ext === 'docx' || file.type.includes('wordprocessingml')) lines = await docxLines(buf);
    else if (ext === 'pdf' || file.type === 'application/pdf') lines = await pdfLines(buf);
    else if (ext === 'txt' || ext === 'md' || file.type.startsWith('text/')) lines = new TextDecoder().decode(buf).replace(/\r/g, '').split('\n');
    else if (ext === 'doc' || ext === 'pages') throw new Error(`.${ext} files can’t be read here. Save it as .docx or PDF and drop that in.`);
    else throw new Error('Drop a Word (.docx), PDF, or text file.');
    const res = clean(lines);
    if (!res.text) throw new Error('No script text found in that file. If it’s a scanned PDF, export the original document instead.');
    return { title: name.replace(/(\.(docx|pdf|txt|md))+$/i, '').replace(/[_]+/g, ' ').trim(), ...res };
  }

  window.PrompterImport = { fromFile, clean, normalisePauses };
})();
