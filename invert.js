/* DotSense Invert view: the mirrored, machine-side page, kept in sync with the main window. */
(function () {
  'use strict';
  const D = window.DotSense;
  const desk = window.desktop;
  const $ = id => document.getElementById(id);
  const round = n => Math.round(n * 100) / 100;
  const short = t => (t.length > 48 ? t.slice(0, 47) + '…' : t);

  let data = null;          // last state from the main window
  let byKey = new Map();    // reading-side key -> { dot, cell }
  let progEls = [];         // punching order -> { dot, cell }
  let shownDone = 0;
  let shownNow = -1;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function sizeDots(cols) {
    const wrap = $('preview');
    const avail = wrap.clientWidth - 26;
    const cellW = Math.max(22, Math.min(46, Math.floor(avail / cols)));
    const dot = Math.max(6, Math.min(14, Math.floor((cellW - 12) / 2.3)));
    wrap.style.setProperty('--cell-w', cellW + 'px');
    wrap.style.setProperty('--dot', dot + 'px');
    wrap.style.setProperty('--dot-gap', Math.max(2, Math.round(dot / 4)) + 'px');
  }

  function nav() {
    const d = data;
    const n = d && d.page ? d.pageCount : 0;
    $('prevPage').disabled = !n || d.pageIndex === 0 || d.printing;
    $('nextPage').disabled = !n || d.pageIndex >= n - 1 || d.printing;
  }

  function jobNote() {
    const j = data && data.job;
    if (!j || !j.active) { $('printNote').hidden = true; return; }
    const pct = j.dots ? Math.floor(1000 * j.dotsDone / j.dots) / 10 : 0;
    $('printNote').textContent = `Printing page ${data.pageIndex + 1}: ${j.dotsDone} of ${j.dots} dots (${pct}%).`;
    $('printNote').hidden = false;
  }

  function applyProgress(p) {
    const done = Math.min(p.dotsDone, progEls.length);
    for (let k = done; k < shownDone; k++) if (progEls[k]) progEls[k].dot.classList.remove('done');
    for (let k = shownDone; k < done; k++) if (progEls[k]) progEls[k].dot.classList.add('done');
    shownDone = done;
    if (shownNow >= 0 && progEls[shownNow]) {
      progEls[shownNow].dot.classList.remove('now');
      progEls[shownNow].cell.classList.remove('now');
    }
    const cur = p.current >= 0 && p.current < progEls.length ? p.current : -1;
    if (cur >= 0 && progEls[cur]) {
      progEls[cur].dot.classList.add('now');
      progEls[cur].cell.classList.add('now');
      const box = $('preview'), b = box.getBoundingClientRect(), c = progEls[cur].cell.getBoundingClientRect();
      if (c.top < b.top || c.bottom > b.bottom) box.scrollTop += c.top - b.top - b.height / 2;
    }
    shownNow = cur;
    jobNote();
  }

  function render() {
    const wrap = $('preview');
    wrap.replaceChildren();
    byKey = new Map();
    progEls = [];
    shownDone = 0;
    shownNow = -1;
    const d = data;
    const on = !!(d && d.invert);
    $('invertPill').dataset.tone = on ? 'ok' : 'hold';
    $('invertPillText').textContent = on ? 'Invert print ON' : 'Invert print OFF';
    $('offNotice').hidden = !d || on;
    if (!d || !d.page) {
      wrap.classList.remove('printing');
      wrap.append(el('p', 'empty', d && d.error ? 'Fix the settings in the main window to see the page.' : 'Type, speak or scan text in the main window.'));
      $('pageLabel').textContent = 'No pages';
      $('readText').textContent = '';
      $('punchText').textContent = '';
      $('bounds').textContent = '';
      jobNote();
      nav();
      return;
    }
    $('pageLabel').textContent = `Page ${d.pageIndex + 1} of ${d.pageCount}`;
    const first = d.page.find(l => D.lineText(l).trim());
    const read = first ? D.lineText(first).trim() : '';
    $('readText').textContent = short(read);
    $('punchText').textContent = short([...read].reverse().join(' '));

    const mirrored = D.mirrorPage(d.page, d.cols);
    sizeDots(d.cols);
    const frag = document.createDocumentFragment();
    mirrored.forEach((line, r) => {
      const row = el('div', 'bline');
      row.style.gridTemplateColumns = `repeat(${d.cols}, var(--cell-w))`;
      line.forEach((cell, c) => {
        const kind = cell.kind === 'space' ? ' space' : cell.kind === 'sign' ? ' sign' : cell.kind === 'unknown' ? ' unknown' : '';
        const ce = el('div', 'cell' + kind);
        const label = cell.kind === 'space' ? '' : cell.ch;
        const grid = el('div', 'dotgrid');
        const dots = [];
        for (let n = 1; n <= 6; n++) {
          const dot = el('i', cell.dots.includes(n) ? 'dot on' : 'dot');
          grid.append(dot);
          dots.push(dot);
        }
        for (const n of cell.dots) byKey.set(r + ':' + (d.cols - 1 - c) + ':' + D.MIRROR_DOT[n], { dot: dots[n - 1], cell: ce });
        ce.append(el('div', 'letter', label), grid);
        row.append(ce);
      });
      frag.append(row);
      const text = D.lineText(d.page[r]).trim();
      if (text) {
        const cap = el('div', 'bcaption', 'reads: ' + text);
        cap.style.width = `calc(var(--cell-w) * ${d.cols})`;
        frag.append(cap);
      }
    });
    wrap.append(frag);
    wrap.setAttribute('aria-label', `Mirrored braille, page ${d.pageIndex + 1}. Reads: ${D.pageText(d.page).replace(/\n/g, ' / ')}`);

    const pts = D.points(mirrored, d.settings);
    const b = D.bounds(pts);
    $('bounds').textContent = b
      ? `Punched on this side: ${pts.length} dots · X ${round(b.minX)} to ${round(b.maxX)} · Y ${round(b.minY)} to ${round(b.maxY)} mm`
      : 'This page has no dots.';

    if (d.job) {
      progEls = d.job.keys.map(k => byKey.get(k));
      wrap.classList.add('printing');
      applyProgress(d.job);
    } else {
      wrap.classList.remove('printing');
      jobNote();
    }
    nav();
  }

  desk.invert.onData(msg => {
    if (!msg) return;
    if (msg.type === 'state') { data = msg; render(); }
    else if (msg.type === 'progress' && data && data.job && data.pageIndex === msg.pageIndex) {
      data.job.dotsDone = msg.dotsDone;
      data.job.current = msg.current;
      applyProgress(msg);
    }
  });
  $('prevPage').onclick = () => { if (data && data.page) desk.invert.goto(data.pageIndex - 1); };
  $('nextPage').onclick = () => { if (data && data.page) desk.invert.goto(data.pageIndex + 1); };
  $('turnOn').onclick = () => desk.invert.setInvert(true);
  new ResizeObserver(() => { if (data && data.page) sizeDots(data.cols); }).observe($('preview'));
  render();
  desk.invert.ready();
})();
