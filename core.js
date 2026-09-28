/*
 * DotSense core: Grade-1 braille translation, page layout (auto-wrap) and G-code.
 * Runs in the app window (window.DotSense) and in Node for tests (module.exports).
 *
 * Coordinates follow the original Braille Gcode app:
 *   Start position X/Y = dot 1 (top-left dot) of the first cell on the page.
 *   Cells advance toward +X, dots 2/3 and following lines advance toward -Y.
 */
(function (root) {
  'use strict';

  const LETTERS = {
    a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5],
    f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
    k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5],
    p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5], s: [2, 3, 4], t: [2, 3, 4, 5],
    u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6], y: [1, 3, 4, 5, 6],
    z: [1, 3, 5, 6]
  };
  // Digits reuse the a-j shapes, preceded by the number sign.
  const DIGITS = {
    '1': [1], '2': [1, 2], '3': [1, 4], '4': [1, 4, 5], '5': [1, 5],
    '6': [1, 2, 4], '7': [1, 2, 4, 5], '8': [1, 2, 5], '9': [2, 4], '0': [2, 4, 5]
  };
  const PUNCT = {
    ',': [2], ';': [2, 3], ':': [2, 5], '.': [2, 5, 6],
    '!': [2, 3, 5], '?': [2, 3, 6], "'": [3], '-': [3, 6]
  };
  const NUMBER_SIGN = [3, 4, 5, 6];
  const LETTER_SIGN = [5, 6];

  // Bangla (Bengali) braille - Bharati braille as used in Bangladesh ('bd', default) or India ('in').
  // Sources: Wikipedia "Bengali Braille" (Bangladesh / India tables), liblouis bengali.cti (Braille
  // Council of India) and the Standard Bharati Braille Codes. A value is one cell (dot list) or a
  // list of cells. Vowel signs use the same cells as the vowels.
  const BN_VOWELS = {
    'অ': [1], 'আ': [3, 4, 5], 'ই': [2, 4], 'ঈ': [3, 5], 'উ': [1, 3, 6], 'ঊ': [1, 2, 5, 6],
    'ঋ': [[5], [1, 2, 3, 5]], 'ঌ': [[5], [1, 2, 3]], 'এ': [1, 5], 'ঐ': [3, 4], 'ও': [1, 3, 5], 'ঔ': [2, 4, 6],
    'ৠ': [[6], [1, 2, 3, 5]], 'ৡ': [[6], [1, 2, 3]]
  };
  const BN_SIGNS = {   // vowel signs (matras), written after the consonant like in Unicode
    'া': [3, 4, 5], 'ি': [2, 4], 'ী': [3, 5], 'ু': [1, 3, 6], 'ূ': [1, 2, 5, 6], 'ৃ': [[5], [1, 2, 3, 5]],
    'ৄ': [[6], [1, 2, 3, 5]], 'ৢ': [[5], [1, 2, 3]], 'ৣ': [[6], [1, 2, 3]], 'ে': [1, 5], 'ৈ': [3, 4], 'ো': [1, 3, 5], 'ৌ': [2, 4, 6],
    'ং': [5, 6], 'ঃ': [6], 'ঁ': [3], 'ঽ': [2]
  };
  const BN_CONSONANTS = {
    'ক': [1, 3], 'খ': [1, 3, 4, 6], 'গ': [1, 2, 4, 5], 'ঘ': [1, 2, 6], 'ঙ': [3, 4, 6],
    'চ': [1, 4], 'ছ': [1, 6], 'জ': [2, 4, 5], 'ঝ': [1, 3, 5, 6], 'ঞ': [2, 5],
    'ট': [2, 3, 4, 5, 6], 'ঠ': [2, 4, 5, 6], 'ড': [1, 2, 4, 6], 'ঢ': [1, 2, 3, 4, 5, 6], 'ণ': [3, 4, 5, 6],
    'ত': [2, 3, 4, 5], 'থ': [1, 4, 5, 6], 'দ': [1, 4, 5], 'ধ': [2, 3, 4, 6], 'ন': [1, 3, 4, 5],
    'প': [1, 2, 3, 4], 'ফ': [2, 3, 5], 'ব': [1, 2], 'ভ': [1, 2, 3, 6], 'ম': [1, 3, 4],
    'য': [1, 3, 4, 5, 6], 'র': [1, 2, 3, 5], 'ল': [1, 2, 3], 'শ': [1, 4, 6], 'ষ': [1, 2, 3, 4, 6], 'স': [2, 3, 4], 'হ': [1, 2, 5],
    'ড়': [1, 2, 4, 5, 6], 'ঢ়': [1, 2, 3, 5, 6], 'য়': [2, 6], 'ৎ': [[5], [2, 3, 4, 5]],
    'ক্ষ': [1, 2, 3, 4, 5], 'জ্ঞ': [1, 5, 6]
  };
  // India (Bharati) differs in a few letters.
  const BN_INDIA = { 'খ': [4, 6], 'ঝ': [3, 5, 6], 'ভ': [4, 5], 'ঢ়': [[5], [1, 2, 4, 5, 6]], 'ৎ': [[4], [2, 3, 4, 5]] };
  const BN_NUKTA = '়', BN_HALANT = '্', BN_DANDA = '।';
  const BN_NUKTA_FORMS = { 'ড': 'ড়', 'ঢ': 'ঢ়', 'য': 'য়' };   // decomposed forms stay decomposed in NFC
  const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
  const BN_BLOCK = /[ঀ-৿]/;

  const DEFAULTS = Object.freeze({
    originX: 10, originY: 135,   // start position = first dot (mm)
    width: 160, height: 120,     // print area measured from the start position (mm)
    dotPitch: 4, cellPitch: 9, linePitch: 14,
    clearZ: 5, punchZ: -5, feed: 1000, dwell: 0.2
  });
  const SETTING_KEYS = Object.keys(DEFAULTS);
  const LABELS = {
    originX: 'Start X', originY: 'Start Y', width: 'Print width', height: 'Print height',
    dotPitch: 'Dot pitch', cellPitch: 'Cell pitch', linePitch: 'Line pitch',
    clearZ: 'Clearance Z', punchZ: 'Punch depth Z', feed: 'Plunge feed', dwell: 'Settle dwell'
  };
  // Paper sizes (portrait, width x height in mm), as in the printer dialog.
  const PAPER_SIZES = [
    { id: 'a4', label: 'A4 210 × 297 mm', w: 210, h: 297 },
    { id: 'photo4x6', label: '10 × 15 cm (4 × 6 in)', w: 101.6, h: 152.4 },
    { id: 'photo5x7', label: '13 × 18 cm (5 × 7 in)', w: 127, h: 177.8 },
    { id: 'a6', label: 'A6 105 × 148 mm', w: 105, h: 148 },
    { id: 'a5', label: 'A5 148 × 210 mm', w: 148, h: 210 },
    { id: 'b5', label: 'B5 182 × 257 mm', w: 182, h: 257 },
    { id: 'photo35x5', label: '9 × 13 cm (3.5 × 5 in)', w: 88.9, h: 127 },
    { id: 'photo5x8', label: '13 × 20 cm (5 × 8 in)', w: 127, h: 203.2 },
    { id: 'photo8x10', label: '20 × 25 cm (8 × 10 in)', w: 203.2, h: 254 },
    { id: 'wide169', label: '16:9 wide size (102 × 181 mm)', w: 102, h: 181 },
    { id: 'card100x148', label: '100 × 148 mm', w: 100, h: 148 },
    { id: 'env10', label: 'Envelope #10 4 1/8 × 9 1/2 in', w: 104.8, h: 241.3 },
    { id: 'envdl', label: 'Envelope DL 110 × 220 mm', w: 110, h: 220 },
    { id: 'envc6', label: 'Envelope C6 114 × 162 mm', w: 114, h: 162 },
    { id: 'letter', label: 'Letter 8 1/2 × 11 in', w: 215.9, h: 279.4 },
    { id: 'legal', label: 'Legal 8 1/2 × 14 in', w: 215.9, h: 355.6 },
    { id: 'a3', label: 'A3 297 × 420 mm', w: 297, h: 420 },
    { id: 'a3plus', label: 'A3+ 329 × 483 mm', w: 329, h: 483 },
    { id: 'a2', label: 'A2 420 × 594 mm', w: 420, h: 594 },
    { id: 'b4', label: 'B4 257 × 364 mm', w: 257, h: 364 },
    { id: 'b3', label: 'B3 364 × 515 mm', w: 364, h: 515 },
    { id: 'custom', label: 'User-Defined', w: 0, h: 0 }
  ];

  const MAX_CHARS = 1000000;
  const MAX_PAGES = 10000;
  const PAGE_BREAK = '[[PAGE]]';

  const fmt = n => String(Math.round(n * 1000) / 1000);

  function normalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFC')                     // e.g. Bangla ে + া = ো
      .replace(/\r\n?/g, '\n')
      .replace(/[‘’‚‛′´`]/g, "'")
      .replace(/[“”„‟″"]/g, "'")
      .replace(/[‐‑‒–—―−]/g, '-')
      .replace(/…/g, '...')
      .replace(/[­​‌‍⁠﻿]/g, '')
      .replace(/[\t  -   　]/g, ' ');
  }

  function isSupported(ch) {
    const low = ch.toLowerCase();
    return (low >= 'a' && low <= 'z' && !!LETTERS[low]) || !!DIGITS[ch] || !!PUNCT[ch] || ch === ' ' || ch === '\n' || ch === '\f' ||
      !!BN_VOWELS[ch] || !!BN_SIGNS[ch] || !!BN_CONSONANTS[ch] || !!BN_DIGITS[ch] || ch === BN_HALANT || ch === BN_NUKTA || ch === BN_DANDA;
  }

  // Cells of a table value: one cell [1, 2] or several [[5], [1, 2, 3, 5]].
  const cellList = v => (Array.isArray(v[0]) ? v : [v]);

  // Bangla text from position i: pushes the cells of one letter (with its halant, nukta or
  // conjunct) and returns the next position.
  function bnCells(chars, i, out, india) {
    const ch = chars[i];
    const look = (v, k) => cellList(v).forEach((dots, n, all) => out.push({ ch: n === all.length - 1 ? k : '', dots, kind: n === all.length - 1 ? 'letter' : 'prefix' }));
    const letter = (k, v) => look(india && BN_INDIA[k] ? BN_INDIA[k] : v, k);
    if (BN_VOWELS[ch]) { letter(ch, BN_VOWELS[ch]); return i + 1; }
    if (BN_SIGNS[ch]) { letter(ch, BN_SIGNS[ch]); return i + 1; }
    if (ch === BN_DANDA) { out.push({ ch, dots: [2, 5, 6], kind: 'punct' }); return i + 1; }
    if (ch === BN_NUKTA) return i + 1;                       // a nukta that forms nothing: no cell
    if (ch === BN_HALANT) { out.push({ ch, dots: [4], kind: 'letter' }); return i + 1; }
    if (!BN_CONSONANTS[ch]) { out.push({ ch, dots: [], kind: 'unknown' }); return i + 1; }
    // one consonant: the ksha / jña conjuncts have their own cells; ড ঢ য with a nukta are ড় ঢ় য়
    let key = ch, j = i + 1;
    if (ch === 'ক' && chars[j] === BN_HALANT && chars[j + 1] === 'ষ') { key = 'ক্ষ'; j += 2; }
    else if (ch === 'জ' && chars[j] === BN_HALANT && chars[j + 1] === 'ঞ') { key = 'জ্ঞ'; j += 2; }
    else if (BN_NUKTA_FORMS[ch] && chars[j] === BN_NUKTA) { key = BN_NUKTA_FORMS[ch]; j += 1; }
    const v = india && BN_INDIA[key] ? BN_INDIA[key] : BN_CONSONANTS[key];
    if (chars[j] === BN_HALANT) {
      // a dead consonant (conjuncts, reph, ya-phala...): the halant sign comes BEFORE the consonant
      out.push({ ch: '', dots: [4], kind: 'prefix', mark: 'halant' });
      look(v, key + BN_HALANT);
      return j + 1;
    }
    look(v, key);
    // a vowel letter right after a consonant: write the inherent a (dot 1), or it reads as a vowel sign
    if (BN_VOWELS[chars[j]]) out.push({ ch: 'অ', dots: [1], kind: 'sign' });
    return j;
  }

  // Braille cells for one word (no spaces inside). opts.bangla: 'bd' (Bangladesh, default) or 'in' (India).
  function cellsFor(word, opts) {
    const india = !!(opts && opts.bangla === 'in');
    const chars = [...word];
    const out = [];
    let inNumber = false;
    for (let i = 0; i < chars.length;) {
      const ch = chars[i];
      const digit = DIGITS[ch] ? ch : BN_DIGITS[ch];
      if (digit) {
        if (!inNumber) out.push({ ch: '#', dots: NUMBER_SIGN, kind: 'sign' });
        out.push({ ch, dots: DIGITS[digit], kind: 'digit' });
        inNumber = true;
        i++;
        continue;
      }
      if (BN_BLOCK.test(ch) && ch !== BN_DANDA) {
        // Bharati braille: a letter right after a number takes the letter sign
        if (inNumber && ch !== BN_NUKTA) out.push({ ch: 'ltr', dots: LETTER_SIGN, kind: 'sign' });
        inNumber = false;
        i = bnCells(chars, i, out, india);
        continue;
      }
      const low = ch.toLowerCase();
      const isLetter = low >= 'a' && low <= 'z' && !!LETTERS[low];
      // a-j straight after digits would read as digits: add the letter sign.
      if (inNumber && isLetter && low <= 'j') out.push({ ch: 'ltr', dots: LETTER_SIGN, kind: 'sign' });
      inNumber = false;
      if (isLetter) out.push({ ch: low.toUpperCase(), dots: LETTERS[low], kind: 'letter' });
      else if (ch === BN_DANDA) out.push({ ch, dots: [2, 5, 6], kind: 'punct' });
      else if (PUNCT[ch]) out.push({ ch, dots: PUNCT[ch], kind: 'punct' });
      else out.push({ ch, dots: [], kind: 'unknown' });
      i++;
    }
    return out;
  }

  function readSettings(s) {
    const out = {};
    for (const key of SETTING_KEYS) {
      const v = typeof s[key] === 'string' ? Number.parseFloat(s[key]) : s[key];
      if (!Number.isFinite(v)) throw new Error('Enter a number for ' + LABELS[key] + '.');
      out[key] = v;
    }
    return out;
  }

  // Checks that do not depend on the print area or the braille size.
  function validate(s) {
    if (s.dotPitch <= 0) throw new Error('Dot pitch must be more than 0.');
    if (s.cellPitch <= s.dotPitch) throw new Error('Cell pitch must be larger than dot pitch, or cells overlap.');
    if (s.linePitch <= 2 * s.dotPitch) throw new Error('Line pitch must be larger than 2 x dot pitch, or lines overlap.');
    if (s.clearZ <= s.punchZ) throw new Error('Clearance Z must be higher than punch depth Z.');
    if (s.feed <= 0) throw new Error('Plunge feed must be more than 0.');
    if (s.dwell < 0) throw new Error('Settle dwell cannot be negative.');
    return s;
  }

  // Validates settings and returns how many cells per line and lines per page fit.
  function geometry(input) {
    const s = validate(readSettings(input));
    if (s.width <= 0 || s.height <= 0) throw new Error('Print width and height must be more than 0.');
    const cols = Math.floor((s.width - s.dotPitch) / s.cellPitch + 1 + 1e-9);
    const rows = Math.floor((s.height - 2 * s.dotPitch) / s.linePitch + 1 + 1e-9);
    if (cols < 2) throw new Error('Print width must fit at least 2 braille cells.');
    if (rows < 1) throw new Error('Print height must fit at least 1 braille line.');
    if (cols * rows > 100000) throw new Error('Print area is too large. Check that values are in millimetres.');
    return { cols, rows, settings: s };
  }

  // Start position and print area for a sheet of paper.
  // X/Y zero sits on the paper's front-left corner (bottom-left of the page, top edge toward the
  // back of the machine). Margins on all sides; the text block is centred left-right, so an
  // inverted print is an exact left-right flip of the sheet.
  function paperArea(paper, input) {
    const num = k => {
      const v = typeof input[k] === 'string' ? Number.parseFloat(input[k]) : input[k];
      if (!Number.isFinite(v) || v <= 0) throw new Error('Enter a number for ' + LABELS[k] + '.');
      return v;
    };
    const dotPitch = num('dotPitch'), cellPitch = num('cellPitch'), linePitch = num('linePitch');
    let w = Number(paper && paper.w), h = Number(paper && paper.h);
    if (!(w > 0) || !(h > 0)) throw new Error('Enter the paper width and height.');
    if (paper.orientation === 'landscape' ? w < h : w > h) { const t = w; w = h; h = t; }
    const m = Number(paper.margin);
    if (!Number.isFinite(m) || m < 0) throw new Error('Enter a paper margin of 0 or more.');
    const uw = w - 2 * m, uh = h - 2 * m;
    if (uw < dotPitch + cellPitch || uh < 2 * dotPitch) throw new Error('The margin is too big for this paper.');
    const cols = Math.floor((uw - dotPitch) / cellPitch + 1 + 1e-9);
    const rows = Math.floor((uh - 2 * dotPitch) / linePitch + 1 + 1e-9);
    const span = (cols - 1) * cellPitch + dotPitch;
    const r = n => Math.round(n * 1000) / 1000;
    return {
      paperW: w, paperH: h, originX: r(m + (uw - span) / 2), originY: r(h - m), width: r(span), height: r(uh), cols, rows,
      sheet: { minX: m, maxX: w - m, minY: m, maxY: h - m }   // where dots may go: the paper inside its margins
    };
  }

  // How many dots would land outside the sheet area (they must never be punched).
  function offSheet(pts, sheet) {
    const e = 0.002;   // positions are rounded to 0.001 mm
    let n = 0;
    for (const p of pts) if (p.x < sheet.minX - e || p.x > sheet.maxX + e || p.y < sheet.minY - e || p.y > sheet.maxY + e) n++;
    return n;
  }

  // Wraps normalized text into lines of `cols` cells and pages of `rows` lines.
  // With rows = Infinity, pages only end at page breaks.
  function wrapText(norm, cols, rows, unsupported, opts) {
    const pages = [];
    let page = [];
    const addLine = line => {
      if (page.length === rows) { pages.push(page); page = []; }
      page.push(line);
      if (pages.length > MAX_PAGES) throw new Error('More than 10,000 braille pages. Split the document.');
    };
    const sections = norm.split(/\[\[PAGE\]\]|\f/);
    sections.forEach((section, si) => {
      if (si) {
        if (page.length) pages.push(page);
        else if (!pages.length) pages.push([]);
        page = [];
      }
      section.replace(/^\n|\n$/g, '').split('\n').forEach(raw => {
        let line = [];
        for (const word of raw.trim().split(/ +/).filter(Boolean)) {
          if (unsupported) for (const ch of word) if (!isSupported(ch)) unsupported.set(ch, (unsupported.get(ch) || 0) + 1);
          const token = cellsFor(word, opts);
          if (token.length <= cols) {
            if (line.length && line.length + 1 + token.length > cols) { addLine(line); line = []; }
            if (line.length) line.push({ ch: ' ', dots: [], kind: 'space' });
            line.push(...token);
          } else {
            // Word longer than a line: split it, re-encoding each part so digit runs keep a number sign.
            if (line.length) { addLine(line); line = []; }
            let part = '';
            for (const ch of word) {
              if (part && cellsFor(part + ch, opts).length > cols) { addLine(cellsFor(part, opts)); part = ''; }
              part += ch;
            }
            line = cellsFor(part, opts);
          }
        }
        addLine(line);
      });
    });
    if (page.length) pages.push(page);
    // A trailing page break should not produce an empty sheet.
    while (pages.length && pages[pages.length - 1].every(l => l.every(c => !c.dots.length))) pages.pop();
    return pages;
  }

  // Wraps text into lines of cells and lines into pages.
  function layout(text, input, opts) {
    const g = geometry(input);
    const norm = normalize(text);
    if (norm.length > MAX_CHARS) throw new Error('Use at most 1,000,000 characters. Split larger documents.');
    const unsupported = new Map();
    const pages = wrapText(norm, g.cols, g.rows, unsupported, opts);

    let letters = 0, dots = 0, lines = 0;
    for (const p of pages) {
      lines += p.length;
      for (const l of p) for (const c of l) {
        if (c.kind === 'letter' || c.kind === 'digit' || c.kind === 'punct') letters++;
        dots += c.dots.length;
      }
    }
    return {
      pages, cols: g.cols, rows: g.rows, settings: g.settings,
      unsupported: [...unsupported.entries()].map(([ch, count]) => ({ ch, count })),
      stats: { letters, dots, lines, pages: pages.length }
    };
  }

  // Page scaling, like a print dialog: the braille size in percent of the dot, cell and line pitch.
  const SCALE_MIN = 50, SCALE_MAX = 200;
  const STANDARD_DOT = 2.5;   // dot spacing of standard braille (mm)

  function scalePitches(input, pct) {
    const f = pct / 100;
    const r = n => Math.round(n * 1000) / 1000;
    const v = k => (typeof input[k] === 'string' ? Number.parseFloat(input[k]) : input[k]) * f;
    return Object.assign({}, input, { dotPitch: r(v('dotPitch')), cellPitch: r(v('cellPitch')), linePitch: r(v('linePitch')) });
  }

  // Settings for a sheet of paper at a braille size: start position and print area come from the paper.
  function pageSettings(paper, input, pct) {
    const s = scalePitches(input, pct == null ? 100 : pct);
    const a = paperArea(paper, s);
    return Object.assign(s, { originX: a.originX, originY: a.originY, width: a.width, height: a.height });
  }

  // Braille size for "Fit to printer margins" (grow or shrink) and "Reduce to printer margins"
  // (shrink only): the largest whole percent at which every page of the text fits on one sheet
  // (pages end only at page breaks). Never below SCALE_MIN; `fits` is false if even that is too big.
  function fitScale(text, input, paper, mode, opts) {
    validate(readSettings(input));
    const norm = normalize(text);
    if (norm.length > MAX_CHARS) throw new Error('Use at most 1,000,000 characters. Split larger documents.');
    const hi = mode === 'reduce' ? 100 : SCALE_MAX;
    if (!/\S/.test(norm.replace(/\[\[PAGE\]\]/g, ''))) return { pct: 100, fits: true };   // nothing to fit
    // Quick check first: every non-space character needs a cell, and a sheet has cols x rows cells.
    // (a Bangla nukta needs no cell and ক্ষ / জ্ঞ are one cell for three characters, so those count less)
    const lowerBound = sec => { const t = sec.replace(/\s+/g, ''); return t.length - (t.split(BN_NUKTA).length - 1) - 2 * (t.split(BN_HALANT).length - 1); };
    const mostChars = norm.split(/\[\[PAGE\]\]|\f/).reduce((m, sec) => Math.max(m, lowerBound(sec)), 0);
    const longest = new Map();   // cells per line -> lines on the longest page
    const fits = pct => {
      let g;
      try { g = geometry(pageSettings(paper, input, pct)); } catch (_) { return false; }
      if (mostChars > g.cols * g.rows) return false;
      if (!longest.has(g.cols)) longest.set(g.cols, wrapText(norm, g.cols, Infinity, null, opts).reduce((m, p) => Math.max(m, p.length), 0));
      return longest.get(g.cols) <= g.rows;
    };
    if (fits(hi)) return { pct: hi, fits: true };
    if (!fits(SCALE_MIN)) return { pct: SCALE_MIN, fits: false };
    let lo = SCALE_MIN, top = hi;   // fits(lo) is true, fits(top) is false
    while (top - lo > 1) {
      const mid = Math.floor((lo + top) / 2);
      if (fits(mid)) lo = mid; else top = mid;
    }
    return { pct: lo, fits: true };
  }

  // Dot centres for one page, in punching order.
  function points(page, s) {
    const out = [];
    page.forEach((line, r) => line.forEach((cell, c) => cell.dots.forEach(d => out.push({
      x: s.originX + c * s.cellPitch + (d > 3 ? s.dotPitch : 0),
      y: s.originY - r * s.linePitch - ((d - 1) % 3) * s.dotPitch,
      line: r, col: c, dot: d, ch: cell.ch
    }))));
    return out;
  }

  // Invert print: the sheet is punched from the top and read from the back, so the
  // whole page is flipped left-right. Cells swap sides across the full print width
  // and the dot columns swap inside each cell (1<->4, 2<->5, 3<->6).
  // "HELLO" is punched as O L L E H, each cell mirrored.
  const MIRROR_DOT = { 1: 4, 2: 5, 3: 6, 4: 1, 5: 2, 6: 3 };
  const BLANK = Object.freeze({ ch: ' ', dots: Object.freeze([]), kind: 'space' });

  function mirrorPage(page, cols) {
    return page.map(line => {
      if (!line.length) return [];
      const out = new Array(cols).fill(BLANK);
      line.forEach((cell, c) => {
        out[cols - 1 - c] = Object.assign({}, cell, { dots: cell.dots.map(d => MIRROR_DOT[d]).sort((a, b) => a - b), srcCol: c });
      });
      return out;
    });
  }

  // The page as the machine punches it.
  function machinePage(page, input, opts) {
    if (!(opts && opts.invert)) return page;
    return mirrorPage(page, geometry(input).cols);
  }

  // Dot centres in punching order for the machine (mirrored when inverting).
  function pagePoints(page, input, opts) {
    return points(machinePage(page, input, opts), readSettings(input));
  }

  // Reading-side identity of a punched dot: "line:cell:dot" on the page as it is read.
  function readingKey(p, cols, invert) {
    return invert ? p.line + ':' + (cols - 1 - p.col) + ':' + MIRROR_DOT[p.dot] : p.line + ':' + p.col + ':' + p.dot;
  }

  function bounds(pts) {
    if (!pts.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  }

  function lineText(line) {
    return line.filter(c => c.kind !== 'sign').map(c => c.ch).join('');
  }

  function pageText(page) {
    return page.map(lineText).join('\n');
  }

  // G-code comments are plain ASCII: Bangla is written in Latin letters there (ISO 15919-like).
  const BN_ROMAN_V = { 'অ': 'a', 'আ': 'aa', 'ই': 'i', 'ঈ': 'ii', 'উ': 'u', 'ঊ': 'uu', 'ঋ': 'ri', 'ঌ': 'li', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou', 'ৠ': 'rii', 'ৡ': 'lii' };
  const BN_ROMAN_S = { 'া': 'aa', 'ি': 'i', 'ী': 'ii', 'ু': 'u', 'ূ': 'uu', 'ৃ': 'ri', 'ৄ': 'rii', 'ৢ': 'li', 'ৣ': 'lii', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou' };
  const BN_ROMAN_MARK = { 'ং': 'ng', 'ঃ': 'h', 'ঁ': '~', 'ঽ': "'", '।': '.' };
  const BN_ROMAN_C = {
    'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng', 'চ': 'c', 'ছ': 'ch', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'ny',
    'ট': 'T', 'ঠ': 'Th', 'ড': 'D', 'ঢ': 'Dh', 'ণ': 'N', 'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
    'প': 'p', 'ফ': 'ph', 'ব': 'b', 'ভ': 'bh', 'ম': 'm', 'য': 'y', 'র': 'r', 'ল': 'l', 'শ': 'sh', 'ষ': 'Sh', 'স': 's', 'হ': 'h',
    'ড়': 'R', 'ঢ়': 'Rh', 'য়': 'y'
  };
  function romanize(text) {
    const chars = [...String(text)];
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      let ch = chars[i];
      if (BN_NUKTA_FORMS[ch] && chars[i + 1] === BN_NUKTA) { ch = BN_NUKTA_FORMS[ch]; i++; }
      if (BN_ROMAN_C[ch]) {
        out += BN_ROMAN_C[ch];
        const next = chars[i + 1];
        if (next === BN_HALANT) i++;                       // dead consonant: no vowel
        else if (BN_ROMAN_S[next]) { out += BN_ROMAN_S[next]; i++; }
        else out += 'a';                                   // inherent vowel
      } else if (ch === 'ৎ') out += 't';
      else if (BN_ROMAN_V[ch]) out += BN_ROMAN_V[ch];
      else if (BN_ROMAN_S[ch]) out += BN_ROMAN_S[ch];
      else if (BN_ROMAN_MARK[ch]) out += BN_ROMAN_MARK[ch];
      else if (BN_DIGITS[ch]) out += BN_DIGITS[ch];
      else if (ch === BN_HALANT || ch === BN_NUKTA) { /* nothing */ }
      else out += ch;
    }
    return out;
  }
  const asciiComment = t => romanize(t).replace(/[^\x20-\x7e]/g, '?');

  // Builds one page as program entries. Entries with `code` are sent to the machine;
  // `dot`/`phase` let the live view know which dot a line belongs to.
  function program(page, input, pageIndex, pageCount, opts) {
    const s = readSettings(input);
    pageIndex = pageIndex || 0;
    pageCount = pageCount || 1;
    const invert = !!(opts && opts.invert);
    const cols = geometry(s).cols;
    const reading = page;
    page = invert ? mirrorPage(reading, cols) : reading;
    const pts = points(page, s);
    const E = [];
    const code = (c, dot, phase) => E.push({ code: c, dot: dot == null ? -1 : dot, phase: phase || '' });
    const note = t => E.push({ comment: asciiComment(t) });
    const blank = () => E.push({ blank: true });
    const firstText = (reading.map(lineText).find(t => t.trim()) || '').trim();
    const summary = firstText.length > 60 ? firstText.slice(0, 57) + '...' : firstText;

    code('%'); code('G21'); code('G90'); code('G94'); blank();
    note('=====================================');
    note('DOTSENSE BRAILLE PRINT - PAGE ' + (pageIndex + 1) + ' OF ' + pageCount);
    note('TEXT: ' + romanize(summary).toUpperCase());
    if (invert) note('INVERT PRINT: MIRRORED - PUNCH FROM THE TOP, READ FROM THE BACK');
    note('3018 CNC - Z STEPPER');
    note('Spindle OFF');
    note('Clearance = Z' + fmt(s.clearZ) + 'mm');
    note('Punch Depth = Z' + fmt(s.punchZ) + 'mm');
    note('Z DOWN SPEED = ' + fmt(s.feed) + ' mm/min');
    note('Dots = ' + pts.length);
    note('=====================================');
    blank();
    code('M5'); blank();
    code('G0 Z' + fmt(s.clearZ));
    code('G0 X' + fmt(s.originX) + ' Y' + fmt(s.originY));

    let k = 0;
    page.forEach((line, r) => {
      if (!line.some(c => c.dots.length)) return;
      blank(); note('----- LINE ' + (r + 1) + ' -----');
      for (const cell of line) {
        if (cell.kind === 'unknown') {
          blank(); note('===== ' + cell.ch.toUpperCase() + ' =====');
          note("(no braille mapping for '" + cell.ch + "', skipped)");
          continue;
        }
        if (!cell.dots.length) continue;
        const label = cell.kind === 'sign'
          ? (cell.ch === '#' ? '# (number sign)' : cell.ch === 'ltr' ? 'letter sign' : 'A (inherent vowel)')
          : cell.kind === 'prefix' ? (cell.mark === 'halant' ? 'HALANT' : 'PREFIX')
            : romanize(cell.ch).toUpperCase();
        blank(); note('===== ' + label + ' =====');
        for (let i = 0; i < cell.dots.length; i++) {
          const p = pts[k];
          code('G0 X' + fmt(p.x) + ' Y' + fmt(p.y), k, 'move');
          code('G1 Z' + fmt(s.punchZ) + ' F' + fmt(s.feed), k, 'plunge');
          code('G0 Z' + fmt(s.clearZ), k, 'retract');
          if (s.dwell > 0) code('G4 P' + fmt(s.dwell), k, 'dwell');
          blank();
          k++;
        }
      }
    });
    note('===== END =====');
    code('G0 Z' + fmt(s.clearZ));
    code('G0 X0 Y0');
    blank();
    code('M5'); code('M30'); code('%');
    return { entries: E, points: pts, settings: s, invert, cols };
  }

  function gcode(page, input, pageIndex, pageCount, opts) {
    return program(page, input, pageIndex, pageCount, opts).entries
      .map(e => e.code != null ? e.code : e.comment != null ? '; ' + e.comment : '')
      .join('\n');
  }

  // Lines for streaming to the machine: comments, blanks and '%' removed.
  // `keys` tells, for each punched dot, which dot of the reading-side page it is.
  function jobLines(page, input, pageIndex, pageCount, opts) {
    const p = program(page, input, pageIndex, pageCount, opts);
    return {
      lines: p.entries.filter(e => e.code != null && e.code !== '%').map(e => ({ code: e.code, dot: e.dot, phase: e.phase })),
      points: p.points,
      keys: p.points.map(pt => readingKey(pt, p.cols, p.invert)),
      settings: p.settings,
      invert: p.invert
    };
  }

  // Trapezoid move time (s) for distance d (mm), speed v (mm/min), acceleration a (mm/s^2).
  function moveTime(d, v, a) {
    if (d <= 0) return 0;
    const vs = v / 60;
    if (!(a > 0)) return d / vs;
    const dAccel = vs * vs / a;
    return d < dAccel ? 2 * Math.sqrt(d / a) : d / vs + vs / a;
  }

  // Rough print time in seconds. Machine values come from GRBL $110-$112 / $120-$122 when connected.
  function estimate(pts, input, machine) {
    const s = readSettings(input);
    const m = Object.assign({ rateXY: 1000, rateZ: 500, accelXY: 50, accelZ: 50 }, machine || {});
    const z = Math.abs(s.clearZ - s.punchZ);
    const plunge = moveTime(z, Math.min(s.feed, m.rateZ), m.accelZ);
    const retract = moveTime(z, m.rateZ, m.accelZ);
    let t = 0, x = s.originX, y = s.originY;
    for (const p of pts) {
      t += moveTime(Math.hypot(p.x - x, p.y - y), m.rateXY, m.accelXY) + plunge + retract + s.dwell;
      x = p.x; y = p.y;
    }
    t += moveTime(Math.hypot(x, y), m.rateXY, m.accelXY);
    return t;
  }

  // Camera photos are often stored sideways with a note (EXIF Orientation 1-8) saying how to turn
  // them for viewing. OCR ignores that note, so the app turns such photos upright first.
  // Returns the orientation from the start of a JPEG file (1 = upright or unknown).
  function jpegOrientation(b) {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return 1;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }                    // fill byte
      if (marker === 0xd9 || marker === 0xda) return 1;           // image data starts: no EXIF
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return 1;
      const end = Math.min(b.length, i + 2 + len);
      if (marker === 0xe1 && len >= 16 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
        const t = i + 10;                                         // TIFF header: II (little) or MM (big endian)
        const le = b[t] === 0x49 && b[t + 1] === 0x49;
        if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 1;
        const u16 = o => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = o => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
        const ifd = t + u32(t + 4);
        if (ifd + 2 > end) return 1;
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > end) break;
          if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      i += 2 + len;
    }
    return 1;
  }

  const api = {
    jpegOrientation,
    DEFAULTS, SETTING_KEYS, LABELS, PAGE_BREAK, MAX_CHARS, PAPER_SIZES, paperArea,
    SCALE_MIN, SCALE_MAX, STANDARD_DOT, scalePitches, pageSettings, fitScale, offSheet,
    LETTERS, DIGITS, PUNCT, NUMBER_SIGN, LETTER_SIGN,
    MIRROR_DOT, normalize, isSupported, cellsFor, romanize, geometry, layout, points, bounds,
    mirrorPage, machinePage, pagePoints, readingKey,
    lineText, pageText, program, gcode, jobLines, estimate, moveTime, fmt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DotSense = api;
})(typeof window !== 'undefined' ? window : globalThis);
