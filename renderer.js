/* DotSense window logic: live braille preview, OCR import, voice typing and live printing. */
const D = window.DotSense;
const desk = window.desktop || null;
const $ = id => document.getElementById(id);
const FIELDS = D.SETTING_KEYS;
const STORE_KEY = 'dotsense:v1';
const DEFAULT_TEXT = 'HELLO WORLD 123!';

const fmtNum = n => Number(n).toLocaleString('en-US');
const round = n => Math.round(n * 100) / 100;
function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const state = {
  result: null,
  error: '',
  page: 0,
  dotByKey: new Map(),  // reading-side "line:cell:dot" -> { dot, cell } elements
  progEls: [],          // punching order -> { dot, cell } (mirrored order when inverting)
  progEls2: [],         // machine side (Invert view), in punching order
  sideView: false,      // Invert view: show the machine side next to the reading side
  shownDone: 0,
  shownNow: -1,
  printing: null,
  printed: null,      // punched dots per page after a print, shown until the text changes
  pageError: '',
  scale: 100,         // braille size in % (page scaling, only with "Use paper size")
  sheet: null,        // with "Use paper size": the paper inside its margins; no dot may go outside it
  paper: null,        // with "Use paper size": { w, h, orientation, label } of the sheet, for the preview
  ocrBusy: false
};
const machine = { connected: false, busy: false, state: 'Disconnected', info: null, status: null };
const voice = { model: 'accurate', phase: 'off', ctx: null, stream: null, node: null, src: null };
const ocr = { sources: [], busy: false, stop: false, run: null, prefix: '', runs: 0 };   // runs: since the Scan dialog opened
const invertOn = () => $('invertPrint').checked;
// Language for voice typing and scanning (OCR), and which Bangla braille Bangla text is punched in.
const inputLang = () => ((document.querySelector('input[name=inputLang]:checked') || {}).value === 'bn' ? 'bn' : 'en');
const brailleOpts = () => ({ bangla: (document.querySelector('input[name=bnStd]:checked') || {}).value === 'in' ? 'in' : 'bd' });
let invertWinOpen = false;

// ------------------------------------------------------------------ page (paper size)
const AREA_KEYS = ['originX', 'originY', 'width', 'height'];
const TYPICAL_REACH = { x: 300, y: 180 };   // a typical 3018 (used until the machine reports $130/$131)
let manualArea = null;                        // the user's own start/print area, restored when paper size is off
const pageOn = () => $('pageMode').checked;
const orientation = () => document.querySelector('input[name=orientation]:checked').value;
// The margin field shows cm or mm; the margin itself is always kept in mm.
const MM_PER = { cm: 10, mm: 1 };
const marginUnit = () => { const r = document.querySelector('input[name=marginUnit]:checked'); return r && r.value === 'cm' ? 'cm' : 'mm'; };
let shownUnit = 'mm';   // the unit the margin field shows right now
function marginMm() {
  return Math.round(Number.parseFloat($('paperMargin').value) * MM_PER[shownUnit] * 1000) / 1000;
}
function showMargin(mm) {
  shownUnit = marginUnit();
  $('paperMargin').step = shownUnit === 'cm' ? '0.1' : '1';
  if (Number.isFinite(mm)) $('paperMargin').value = String(Math.round(mm / MM_PER[shownUnit] * 1000) / 1000);
}
function paperSpec() {
  const id = $('paperSize').value;
  const p = D.PAPER_SIZES.find(x => x.id === id) || D.PAPER_SIZES[0];
  const custom = p.id === 'custom';
  return {
    id: p.id, label: p.label, orientation: orientation(), margin: marginMm(),
    w: custom ? Number.parseFloat($('paperW').value) : p.w, h: custom ? Number.parseFloat($('paperH').value) : p.h
  };
}
function readArea() { const a = {}; for (const k of AREA_KEYS) a[k] = $(k).value; return a; }
// Page scaling, like a print dialog: the braille size in % of the dot, cell and line pitch.
const SCALE_MODES = ['fit', 'reduce', 'custom'];   // Fit to printer margins is the standard
const scaleMode = () => { const r = document.querySelector('input[name=pageScale]:checked'); return r ? r.value : 'fit'; };
function customPct() {
  const n = Math.round(Number.parseFloat($('scalePct').value));
  return Math.min(D.SCALE_MAX, Math.max(D.SCALE_MIN, Number.isFinite(n) ? n : 100));
}
// Settings for the braille layout: the fields, with the pitches scaled when page scaling is on.
function layoutSettings() {
  const s = readSettings();
  return pageOn() && state.scale !== 100 ? D.scalePitches(s, state.scale) : s;
}
function applyPage() {
  const on = pageOn();
  $('pageFields').hidden = !on;
  $('customSize').hidden = !on || $('paperSize').value !== 'custom';
  $('autoNote1').hidden = $('autoNote2').hidden = !on;
  for (const k of AREA_KEYS) $(k).readOnly = on;
  state.pageError = '';
  state.scale = 100;
  state.sheet = null;
  state.paper = null;
  $('pageWarn').hidden = true;
  $('scaleWarn').hidden = true;
  $('scaleInfo').textContent = '';
  if (!on) return;
  try {
    const spec = paperSpec();
    const base = readSettings();
    const mode = scaleMode();
    const text = $('sentence').value;
    let pct = 100, fit = null;
    if (mode === 'custom') pct = customPct();
    else if (mode === 'fit' || mode === 'reduce') { fit = D.fitScale(text, base, spec, mode, brailleOpts()); pct = fit.pct; }
    const scaled = D.scalePitches(base, pct);
    let a;
    try { a = D.paperArea(spec, scaled); } catch (e) {
      let fullSizeFits = false;
      if (pct > 100) try { D.paperArea(spec, base); fullSizeFits = true; } catch (_) { /* the paper itself is the problem */ }
      throw fullSizeFits ? new Error(`At ${pct} % the braille is too big for this paper. Use a smaller scale.`) : e;
    }
    if (AREA_KEYS.some(k => Number.parseFloat($(k).value) !== a[k])) $('confirmed').checked = false;   // the start position moved
    $('originX').value = a.originX;
    $('originY').value = a.originY;
    $('width').value = a.width;
    $('height').value = a.height;
    state.scale = pct;
    state.sheet = a.sheet;
    const nice = n => String(Math.round(n * 10) / 10);
    state.paper = {
      w: a.paperW, h: a.paperH, orientation: spec.orientation,
      label: spec.id === 'custom' ? `User-Defined ${nice(Math.min(a.paperW, a.paperH))} × ${nice(Math.max(a.paperW, a.paperH))} mm` : spec.label
    };
    const mm = n => String(Math.round(n * 100) / 100);
    let info = `Braille size: ${pct} % · dots ${mm(scaled.dotPitch)} · cells ${mm(scaled.cellPitch)} · lines ${mm(scaled.linePitch)} mm`;
    if (fit && text.trim()) {
      const several = /\[\[PAGE\]\]|\f/.test(text);
      info += fit.fits ? (several ? ' · each page fits on one sheet' : ' · the text fits on one sheet')
        : ` · too long for one sheet even at ${D.SCALE_MIN} %, so it goes on to the next sheets`;
    }
    $('scaleInfo').textContent = info;
    if (pct < 100 && scaled.dotPitch < D.STANDARD_DOT) {
      $('scaleWarn').textContent = `Dots are closer than standard braille (${D.STANDARD_DOT} mm). Check that your punch can make dots this close.`;
      $('scaleWarn').hidden = false;
    }
    const travel = machine.info && machine.info.travel;
    const reach = travel && travel[0] > 0 && travel[1] > 0 ? { x: travel[0], y: travel[1], who: 'your machine reaches' } : { x: TYPICAL_REACH.x, y: TYPICAL_REACH.y, who: 'a typical 3018 reaches about' };
    const needX = a.originX + a.width, needY = a.originY;
    if (needX > reach.x + 0.01 || needY > reach.y + 0.01) {
      $('pageWarn').textContent = `This sheet needs X up to ${round(needX)} mm and Y up to ${round(needY)} mm, but ${reach.who} ${reach.x} × ${reach.y} mm. ` +
        (spec.orientation === 'portrait' && a.paperW < a.paperH ? 'Try Landscape or a smaller size. ' : 'Try a smaller size. ') + 'Check with Go to start position before printing.';
      $('pageWarn').hidden = false;
    }
  } catch (e) {
    state.pageError = e.message;
    $('pageWarn').textContent = e.message;
    $('pageWarn').hidden = false;
  }
}
function autoSeconds() {
  if (!$('autoNext').checked) return null;
  const n = Math.round(Number.parseFloat($('autoNextSec').value));
  return Math.min(3600, Math.max(5, Number.isFinite(n) ? n : 30));
}

// ---- show / hide the Paper & Machine panel
function applyShowSettings() {
  const show = $('showSettings').checked;
  $('setBody').hidden = !show;
  $('resetBtn').hidden = !show;
}
$('showSettings').addEventListener('change', () => { applyShowSettings(); saveStore(); });
// ---- show / hide the machine settings (start position, print area, pitches, Z, feed, dwell)
function applyShowMachine() { $('machineFields').hidden = !$('showMachine').checked; }
$('showMachine').addEventListener('change', () => { applyShowMachine(); saveStore(); });
// ---- show / hide the page settings (paper size, scaling, time between pages)
function applyShowPage() { $('pageBody').hidden = !$('showPage').checked; }
$('showPage').addEventListener('change', () => { applyShowPage(); saveStore(); });

let beepCtx = null;
function beep(freq, seconds) {
  try {
    if (!beepCtx) beepCtx = new AudioContext();
    if (beepCtx.state === 'suspended') beepCtx.resume();
    const t = beepCtx.currentTime, o = beepCtx.createOscillator(), g = beepCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(g).connect(beepCtx.destination);
    o.start(t);
    o.stop(t + seconds + 0.02);
  } catch (_) { /* no audio device */ }
}

// ------------------------------------------------------------------ storage
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
}
const stored = loadStore();
let storeTimer = 0;
function saveStore() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(writeStore, 400);
}
// a change made just before the window closes is still kept
window.addEventListener('beforeunload', () => { if (storeTimer) writeStore(); });
function writeStore() {
  clearTimeout(storeTimer);
  storeTimer = 0;
  try {
    const margin = marginMm();
    localStorage.setItem(STORE_KEY, JSON.stringify({
      text: $('sentence').value,
      settings: readSettings(),
      voiceModel: voice.model,
      inputLang: inputLang(),
      bnStd: brailleOpts().bangla,
      invert: invertOn(),
      page: {
        on: pageOn(), size: $('paperSize').value, orientation: orientation(), margin: Number.isFinite(margin) ? margin : '', marginUnit: marginUnit(), w: $('paperW').value, h: $('paperH').value,
        scale: scaleMode(), scalePct: $('scalePct').value, pdfPaper: $('pdfPaper').checked
      },
      manualArea,
      sheet: { auto: $('autoNext').checked, seconds: $('autoNextSec').value },
      showSettings: $('showSettings').checked,
      showGcode: $('showGcode').checked,
      showMachine: $('showMachine').checked,
      showPage: $('showPage').checked,
      sideView: state.sideView,
      jogUnit: jogUnit(),
      baud: $('baudSelect').value,
      port: $('portSelect').value || stored.port || '',
      ocr: { forceOcr: $('forceOcr').checked, sourceBreak: $('sourceBreak').checked },
      wifi: { ssid: wifi.ssid, password: wifi.password },
      phone: { on: phone.on }
    }));
  } catch (_) { /* storage unavailable or full */ }
}

function readSettings() {
  const s = {};
  for (const k of FIELDS) s[k] = $(k).value;
  return s;
}
function writeSettings(s) {
  for (const k of FIELDS) $(k).value = s[k] != null && s[k] !== '' ? s[k] : D.DEFAULTS[k];
}

// ------------------------------------------------------------------ live layout
let rebuildTimer = 0;
function scheduleRebuild(followCaret) {
  clearTimeout(rebuildTimer);
  const len = $('sentence').value.length;
  rebuildTimer = setTimeout(() => rebuild(followCaret), len > 15000 ? 200 : 0);
}

function rebuild(followCaret) {
  if (state.printing) return;
  const text = $('sentence').value;
  if (pageOn() && (scaleMode() === 'fit' || scaleMode() === 'reduce')) applyPage();   // the braille size follows the text
  try {
    const settings = layoutSettings();
    if (pageOn() && state.pageError) throw new Error(state.pageError);
    const r = D.layout(text, settings, brailleOpts());
    r.sheet = pageOn() ? state.sheet : null;
    r.paper = pageOn() ? state.paper : null;
    checkOnSheet(r);
    state.result = r;
    state.error = '';
    const n = state.result.pages.length;
    if (followCaret && n > 1 && text.length <= 60000) {
      const upto = text.slice(0, $('sentence').selectionEnd);
      try { state.page = D.layout(upto + 'x', settings, brailleOpts()).pages.length - 1; } catch (_) { /* keep page */ }
    }
    state.page = Math.max(0, Math.min(state.page, n - 1));
  } catch (e) {
    state.result = null;
    state.error = e.message;
  }
  render();
  saveStore();
}

// Never outside the page: with a paper size, the furthest dots the layout can place
// (first dot, and the last dot of a full line on a full page) must lie on the paper inside the margins.
function checkOnSheet(r) {
  if (!r.sheet) return;
  const s = r.settings;
  const far = [
    { x: s.originX, y: s.originY },
    { x: s.originX + (r.cols - 1) * s.cellPitch + s.dotPitch, y: s.originY - (r.rows - 1) * s.linePitch - 2 * s.dotPitch }
  ];
  if (D.offSheet(far, r.sheet)) throw new Error('The braille would go outside the paper. Check the paper size and margin.');
}

function estimateAll(r) {
  const rates = machine.info && machine.info.rates;
  const limit = Math.min(r.pages.length, 40);
  let t = 0, dots = 0;
  for (let i = 0; i < limit; i++) {
    const pts = D.pagePoints(r.pages[i], r.settings, { invert: invertOn() });
    t += D.estimate(pts, r.settings, rates);
    dots += pts.length;
  }
  return limit < r.pages.length && dots ? t * r.stats.dots / dots : t;
}

function render() {
  const r = state.result;
  $('charCount').textContent = fmtNum($('sentence').value.length) + ' chars';
  $('error').hidden = !state.error;
  $('error').textContent = state.error ? 'Fix the settings: ' + state.error : '';
  if (r) {
    $('statLetters').textContent = fmtNum(r.stats.letters);
    $('statDots').textContent = fmtNum(r.stats.dots);
    $('statLines').textContent = fmtNum(r.stats.lines);
    $('statPages').textContent = fmtNum(r.stats.pages);
    $('fitInfo').textContent = `${r.cols} cells × ${r.rows} lines fit on each sheet`;
  } else {
    for (const id of ['statLetters', 'statDots', 'statLines', 'statPages']) $(id).textContent = '–';
    $('fitInfo').textContent = '';
  }
  updateTimeStat();
  if (r && r.unsupported.length) {
    const list = r.unsupported.slice(0, 12).map(u => `${u.ch} ×${u.count}`).join('   ');
    $('warn').textContent = `Not in the braille table (left as blank cells): ${list}${r.unsupported.length > 12 ? '   …' : ''}. Edit or replace them.`;
    $('warn').hidden = false;
  } else $('warn').hidden = true;
  // one control: green "Invert view" when invert print is on, red "Invert off" when it is off
  $('invertViewBtn').hidden = !invertOn();
  $('invertViewBtn').setAttribute('aria-pressed', String(state.sideView));
  $('invertOffTag').hidden = invertOn();
  $('invertState').textContent = invertOn() ? 'On' : 'Off';
  renderPager();
  renderPreview();
  renderGcode();
  updateControls();
  sendInvertState();
}

// Est. time: the whole estimate; while printing, a countdown of the time left for the job.
let timeTicker = 0;
function updateTimeStat() {
  const P = state.printing, cd = P && P.countdown;
  if (cd) {
    const left = cd.running ? cd.left - (Date.now() - cd.at) / 1000 : cd.left;
    $('statTime').textContent = fmtTime(Math.max(0, left));
    return;
  }
  const r = P ? P.result : state.result;
  $('statTime').textContent = !r ? '–' : r.stats.dots ? fmtTime(estimateAll(r)) : '0:00';
}
// Called on every progress report while printing: time left on this page (measured by the
// machine link) plus the estimate for the pages still to come, corrected by the real speed.
function updateCountdown(p) {
  const P = state.printing;
  if (!P || !P.pageEst) return;
  const est = P.pageEst[p.page] || 0;
  const measured = p.eta != null && p.dotsDone >= Math.max(5, Math.ceil(p.dots * 0.1));   // enough dots for a steady speed
  // real speed vs. the estimate, learned on this page and kept for the next ones
  if (measured && est > 0) P.speed = Math.min(4, Math.max(0.25, (p.elapsed + p.eta) / est));
  const speed = P.speed || 1;
  const pageLeft = measured ? p.eta : p.dotsDone >= p.dots ? 0 : Math.max(0, est * speed - p.elapsed);
  let rest = 0;
  for (let k = p.page + 1; k <= P.to; k++) rest += P.pageEst[k] || 0;
  const left = pageLeft + rest * speed;
  const running = p.state === 'running' && p.dotsDone < p.dots;
  const cd = P.countdown;
  if (cd && cd.running && running) {
    const shown = cd.left - (Date.now() - cd.at) / 1000;
    if (Math.abs(left - shown) < Math.max(3, shown * 0.03)) return;   // keep ticking smoothly
  }
  P.countdown = { left: Math.max(0, left), at: Date.now(), running };
  updateTimeStat();
}

function renderPager() {
  const n = state.result ? state.result.pages.length : 0;
  $('pageLabel').textContent = n ? `Page ${state.page + 1} of ${n}` : 'No pages';
  $('prevPage').disabled = !n || state.page === 0 || !!state.printing;
  $('nextPage').disabled = !n || state.page >= n - 1 || !!state.printing;
}

// ---- braille preview: the sheet at its real shape, every dot where it will be punched (mm)
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, cls) {
  const e = document.createElementNS(SVGNS, tag);
  if (cls) e.setAttribute('class', cls);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const n3 = v => String(Math.round(v * 1000) / 1000);

// What the preview shows, in machine mm: the paper (with a paper size) or else the print area.
function previewSheet(r) {
  const s = r.settings;
  if (r.paper && r.sheet) return { x0: 0, y0: 0, w: r.paper.w, h: r.paper.h, area: r.sheet, paper: true };
  const pad = Math.max(3, s.dotPitch);
  return {
    x0: s.originX - pad, y0: s.originY - s.height - pad, w: s.width + 2 * pad, h: s.height + 2 * pad,
    area: { minX: s.originX, maxX: s.originX + s.width, minY: s.originY - s.height, maxY: s.originY }, paper: false
  };
}

// Fits the sheets into the preview box, keeping their exact proportions (two side by side
// when the machine side is shown too).
function sizeSheet() {
  const wrap = $('preview'), sheets = [...wrap.querySelectorAll('svg.sheet')].filter(sv => sv.sheetInfo);
  if (!sheets.length) return;
  const n = sheets.length, gapPx = 24, capPx = n > 1 ? 24 : 0;
  const availW = Math.max(120, (wrap.clientWidth - 28 - gapPx * (n - 1)) / n);
  const maxH = Math.max(380, Math.min(860, window.innerHeight - 140)) - capPx;
  for (const sv of sheets) {
    const { w, h, fs } = sv.sheetInfo;
    const k = Math.min(availW / w, maxH / h);   // px per mm
    sv.style.width = Math.floor(w * k) + 'px';
    sv.style.height = Math.floor(h * k) + 'px';
    sv.classList.toggle('no-labels', fs * k < 6.5);   // letters only when they are readable
  }
}

// One sheet as SVG in machine mm. Returns the SVG, the dots by "line:cell:dot" and the dots in
// punching order (the order the machine punches this layout).
function buildSheet(page, r, sh, cls) {
  const s = r.settings;
  const rad = 0.3 * s.dotPitch;                                   // dot radius
  const gap = s.linePitch - 2 * s.dotPitch - 2 * rad;             // free space between lines
  const fs = Math.max(0.5, Math.min(4.2, gap * 0.8, s.cellPitch * 0.55));   // letter size (mm)
  const sv = svgEl('svg', { viewBox: `${n3(sh.x0)} ${n3(-(sh.y0 + sh.h))} ${n3(sh.w)} ${n3(sh.h)}`, 'aria-hidden': 'true' }, 'sheet' + (sh.paper ? ' is-paper' : ' is-area') + (cls ? ' ' + cls : ''));
  sv.sheetInfo = { w: sh.w, h: sh.h, fs };
  sv.append(svgEl('rect', { x: n3(sh.x0), y: n3(-(sh.y0 + sh.h)), width: n3(sh.w), height: n3(sh.h) }, 'paper'));
  const a = sh.area;
  sv.append(svgEl('rect', { x: n3(a.minX), y: n3(-a.maxY), width: n3(a.maxX - a.minX), height: n3(a.maxY - a.minY) }, 'margin-line'));
  const byKey = new Map(), order = [];
  const frag = document.createDocumentFragment();
  page.forEach((line, li) => line.forEach((cell, ci) => {
    if (cell.kind === 'space' || (!cell.dots.length && cell.kind !== 'unknown')) return;
    const x = s.originX + ci * s.cellPitch, y = s.originY - li * s.linePitch;   // dot 1 of this cell
    const g = svgEl('g', {}, 'bcell' + (cell.kind === 'sign' ? ' sign' : cell.kind === 'unknown' ? ' unknown' : ''));
    const tip = svgEl('title');
    tip.textContent = cell.kind === 'unknown' ? `“${cell.ch}” is not in the braille table` : cell.kind === 'sign' ? (cell.ch === '#' ? 'Number sign' : cell.ch === 'ltr' ? 'Letter sign' : 'অ (inherent vowel, written before a vowel letter)') : cell.kind === 'prefix' ? (cell.mark === 'halant' ? 'Halant (্)' : 'First cell of the next letter') : cell.ch;
    g.append(tip);
    const label = svgEl('text', { x: n3(x + s.dotPitch / 2), y: n3(-y - rad - 0.35), 'font-size': n3(cell.kind === 'sign' ? fs * 0.8 : fs) }, 'blabel');
    label.textContent = cell.ch;   // '#' number sign, 'ltr' letter sign, Bangla signs show their letter
    g.append(label);
    if (cell.kind === 'unknown') {
      g.append(svgEl('rect', { x: n3(x - rad - 0.5), y: n3(-y - rad - 0.5), width: n3(s.dotPitch + 2 * rad + 1), height: n3(2 * s.dotPitch + 2 * rad + 1), rx: 0.5 }, 'unknown-box'));
    }
    const dots = [];
    for (let d = 1; d <= 6; d++) {
      const c = svgEl('circle', { cx: n3(x + (d > 3 ? s.dotPitch : 0)), cy: n3(-(y - ((d - 1) % 3) * s.dotPitch)), r: n3(rad) }, cell.dots.includes(d) ? 'dot on' : 'dot');
      g.append(c);
      dots.push(c);
    }
    for (const d of cell.dots) {
      const ref = { dot: dots[d - 1], cell: g };
      byKey.set(li + ':' + ci + ':' + d, ref);
      order.push(ref);
    }
    frag.append(g);
  }));
  sv.append(frag);
  return { sv, byKey, order };
}

function renderPreview() {
  const wrap = $('preview');
  wrap.replaceChildren();
  state.dotByKey = new Map();
  state.progEls = [];
  state.progEls2 = [];
  state.shownDone = 0;
  state.shownNow = -1;
  const r = state.result;
  const printingHere = !!(state.printing && state.printing.page === state.page);
  const printedInfo = !printingHere && state.printed && state.printed.result === r ? state.printed.pages.get(state.page) : undefined;
  wrap.classList.toggle('printing', printingHere || !!printedInfo);
  if (!r || !r.pages.length) {
    wrap.classList.remove('sheet-mode', 'two-sheets');
    wrap.append(el('p', 'empty', state.error ? 'Fix the settings to see the braille.' : 'Type, speak or scan some text to see the braille.'));
    $('bounds').textContent = '';
    return;
  }
  const page = r.pages[state.page];
  const sh = previewSheet(r);
  const invert = invertOn();
  const both = state.sideView && invert;   // Invert view: the machine side next to the reading side
  wrap.classList.add('sheet-mode');
  wrap.classList.toggle('two-sheets', both);
  const reading = buildSheet(page, r, sh, '');
  state.dotByKey = reading.byKey;
  const col = (title, sv, extra) => {
    const c = el('div', 'sheet-col');
    if (both) {
      const cap = el('div', 'sheet-cap', title);
      if (extra) cap.append(extra);
      c.append(cap);
    }
    c.append(sv);
    return c;
  };
  wrap.append(col('Reading side', reading.sv));
  if (both) {
    const machineSide = buildSheet(D.machinePage(page, r.settings, { invert: true }), r, sh, 'mirrored');
    state.progEls2 = machineSide.order;   // same order as the machine punches
    const win = el('button', 'cap-btn', '↗');
    win.type = 'button';
    win.title = 'Open the machine side in its own window';
    win.setAttribute('aria-label', win.title);
    win.onclick = () => { if (desk) desk.invert.open(); };
    win.disabled = !desk;
    wrap.append(col('Machine side · mirrored', machineSide.sv, win));
  }
  sizeSheet();
  wrap.setAttribute('aria-label', `Braille preview, page ${state.page + 1}${r.paper ? ' on ' + r.paper.label : ''}: ${D.pageText(page).replace(/\n/g, ' / ') || 'blank'}`);
  const pts = D.pagePoints(page, r.settings, { invert });
  const b = D.bounds(pts);
  $('bounds').textContent = b
    ? `This page punches ${fmtNum(pts.length)} dots` + (b.minX < 0 || b.minY < 0 ? '   ⚠ below zero - check the start position' : '')
    : 'This page has no dots.';
  const keys = printingHere ? state.printing.keys : printedInfo ? printedInfo.keys : null;
  if (keys) state.progEls = keys.map(k => state.dotByKey.get(k));
  // the machine side only shows progress for a job that was punched mirrored
  const jobInverted = printingHere ? state.printing.invert : printedInfo ? state.printed.invert : false;
  if (!jobInverted) state.progEls2 = [];
  if (printingHere && state.printing.last) applyProgress(state.printing.last);
  else if (printedInfo) applyProgress({ dotsDone: printedInfo.dotsDone, current: -1 });
}

function currentGcode() {
  const r = state.result;
  if (!r || !r.pages.length) return '';
  return D.gcode(r.pages[state.page], r.settings, state.page, r.pages.length, { invert: invertOn() });
}

function renderGcode() {
  if ($('output').hidden) return;   // hidden: nothing to draw (Copy and Save make their own)
  const r = state.result;
  if (!r) { $('output').textContent = '; ' + (state.error || 'No output'); return; }
  if (!r.pages.length) { $('output').textContent = '; Type text to get G-code.'; return; }
  $('output').textContent = currentGcode();
}

// ---- show / hide the G-code output
function applyShowGcode() {
  const show = $('showGcode').checked;
  $('output').hidden = !show;
  if (show) renderGcode();
}
$('showGcode').addEventListener('change', () => { applyShowGcode(); saveStore(); });

function updateControls() {
  const P = state.printing;
  const printing = !!P;
  const r = state.result;
  const hasPages = !!(r && r.pages.length);
  const idle = machine.connected && /^Idle/.test(machine.state);
  const checking = machine.connected && /^Check/.test(machine.state);   // nothing moves: no safety tick needed
  const ready = ((idle && $('confirmed').checked) || checking) && hasPages && !printing && !state.ocrBusy;
  $('checkModeBtn').disabled = !machine.connected || printing || !(idle || checking);
  $('checkModeBtn').setAttribute('aria-pressed', String(checking));
  $('printPageBtn').disabled = !ready;
  $('printAllBtn').disabled = !ready || r.pages.length < 2;
  $('printPageBtn').textContent = hasPages ? `Print page ${state.page + 1}` : 'Print this page';
  $('printAllBtn').textContent = hasPages && r.pages.length > 1 ? `Print all ${r.pages.length} pages` : 'Print all pages';
  $('pauseBtn').disabled = !printing || !P.jobActive;
  $('pauseBtn').textContent = P && P.paused ? 'Resume' : 'Pause';
  $('pauseBtn').classList.toggle('primary', !!(P && P.paused));
  $('stopBtn').disabled = !printing;

  const lockText = printing || state.ocrBusy;
  $('sentence').disabled = lockText;
  for (const k of FIELDS) $(k).disabled = printing;
  $('invertPrint').disabled = printing;
  for (const id of ['pageMode', 'paperSize', 'paperMargin', 'paperW', 'paperH', 'pdfPaper']) $(id).disabled = printing;
  document.querySelectorAll('input[name=orientation], input[name=marginUnit], input[name=pageScale]').forEach(r => { r.disabled = printing; });
  $('scalePct').disabled = printing || scaleMode() !== 'custom';
  $('resetBtn').disabled = printing;
  $('pageBreakBtn').disabled = lockText;
  $('ocrBtn').disabled = printing || !desk;
  $('voiceBtn').disabled = !desk || (lockText && voice.phase === 'off');
  $('openProjectBtn').disabled = printing || state.ocrBusy || !desk;
  $('saveProjectBtn').disabled = !desk;
  $('copyBtn').disabled = !hasPages;
  $('saveBtn').disabled = !hasPages || !desk;
  $('saveAllBtn').disabled = !hasPages || !desk;

  $('connectBtn').textContent = machine.connected ? 'Disconnect' : 'Connect';
  $('connectBtn').classList.toggle('primary', !machine.connected);
  $('connectBtn').disabled = !desk || machine.busy || printing;
  $('portSelect').disabled = machine.connected || machine.busy || !desk;
  $('baudSelect').disabled = machine.connected || machine.busy;
  $('refreshPorts').disabled = machine.connected || machine.busy || !desk;
  const canMove = machine.connected && !printing && /^(Idle|Jog)/.test(machine.state);
  document.querySelectorAll('[data-jog]').forEach(b => { b.disabled = !canMove; });
  $('jogStop').disabled = !machine.connected || printing;
  $('zeroXY').disabled = $('zeroZ').disabled = !(idle && !printing);
  $('gotoStart').disabled = !(idle && !printing && r);
  $('unlockBtn').disabled = !machine.connected || printing;
  $('resetMachineBtn').disabled = !machine.connected;   // also while printing: it aborts the job
  $('homeBtn').hidden = !(machine.info && machine.info.homing);
  $('homeBtn').disabled = !machine.connected || printing;
  $('cmdInput').disabled = !machine.connected || printing;
  document.querySelector('#cmdForm button').disabled = !machine.connected || printing;
}

// ------------------------------------------------------------------ text + settings events
$('sentence').addEventListener('input', () => scheduleRebuild(true));
for (const k of FIELDS) {
  $(k).addEventListener('input', () => {
    $('confirmed').checked = false;
    if (pageOn() && (k === 'dotPitch' || k === 'cellPitch' || k === 'linePitch')) applyPage();
    scheduleRebuild(false);
  });
}
$('pageMode').addEventListener('change', () => {
  if (pageOn()) manualArea = readArea();
  else if (manualArea) { for (const k of AREA_KEYS) $(k).value = manualArea[k]; manualArea = null; }
  $('confirmed').checked = false;
  applyPage();
  rebuild(false);
});
for (const id of ['paperSize', 'paperMargin', 'paperW', 'paperH']) {
  $(id).addEventListener(id === 'paperSize' ? 'change' : 'input', () => { $('confirmed').checked = false; applyPage(); scheduleRebuild(false); });
}
document.querySelectorAll('input[name=orientation]').forEach(r => r.addEventListener('change', () => { $('confirmed').checked = false; applyPage(); rebuild(false); }));
// cm <-> mm only changes how the margin is shown, not the margin itself
document.querySelectorAll('input[name=marginUnit]').forEach(r => r.addEventListener('change', () => { showMargin(marginMm()); applyPage(); saveStore(); }));
document.querySelectorAll('input[name=pageScale]').forEach(r => r.addEventListener('change', () => {
  $('confirmed').checked = false;
  applyPage();
  rebuild(false);
  if (scaleMode() === 'custom') $('scalePct').focus();
}));
$('scalePct').addEventListener('input', () => { $('confirmed').checked = false; applyPage(); scheduleRebuild(false); });
$('scalePct').addEventListener('change', () => { $('scalePct').value = customPct(); applyPage(); rebuild(false); });
$('pdfPaper').addEventListener('change', saveStore);
for (const id of ['autoNext', 'autoNextSec']) $(id).addEventListener('change', () => {
  if (id === 'autoNextSec') $('autoNextSec').value = autoSeconds() || Math.min(3600, Math.max(5, Math.round(Number.parseFloat($('autoNextSec').value)) || 30));
  $('autoNextSec').disabled = !$('autoNext').checked;
  saveStore();
});
$('confirmed').addEventListener('change', updateControls);
$('invertPrint').addEventListener('change', () => { $('confirmed').checked = false; render(); saveStore(); });
$('resetBtn').onclick = () => {
  writeSettings(D.DEFAULTS);
  $('pageMode').checked = false;
  manualArea = null;
  $('paperSize').value = 'a4';
  document.querySelector('input[name=orientation][value=portrait]').checked = true;
  showMargin(10);   // 10 mm, in the unit the user picked
  $('paperW').value = 210;
  $('paperH').value = 297;
  document.querySelector('input[name=pageScale][value=fit]').checked = true;
  $('scalePct').value = 100;
  $('pdfPaper').checked = false;
  $('autoNext').checked = true;
  $('autoNextSec').value = 30;
  $('autoNextSec').disabled = false;
  $('confirmed').checked = false;
  applyPage();
  rebuild(false);
};
$('pageBreakBtn').onclick = () => {
  const t = $('sentence');
  const before = t.value.slice(0, t.selectionStart);
  t.setRangeText((before && !before.endsWith('\n') ? '\n' : '') + '[[PAGE]]\n', t.selectionStart, t.selectionEnd, 'end');
  t.focus();
  scheduleRebuild(true);
};
$('prevPage').onclick = () => { if (state.page > 0) { state.page--; render(); } };
$('nextPage').onclick = () => { if (state.result && state.page < state.result.pages.length - 1) { state.page++; render(); } };
new ResizeObserver(() => sizeSheet()).observe($('preview'));
window.addEventListener('resize', () => sizeSheet());

// ------------------------------------------------------------------ output buttons
let flashTimer = 0;
function flash(msg) {
  $('statusMsg').textContent = msg;
  $('statusMsg').title = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('statusMsg').textContent = ''; }, 4000);
}
function baseName() {
  const words = $('sentence').value.replace(/\[\[PAGE\]\]/g, ' ').trim().toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.slice(0, 4).join('_') || 'dotsense';
}
$('copyBtn').onclick = async () => {
  try {
    const text = currentGcode();
    if (desk) await desk.copyText(text); else await navigator.clipboard.writeText(text);
    flash('Copied');
  } catch (_) { flash('Copy failed'); }
};
$('saveBtn').onclick = async () => {
  const r = state.result;
  if (!r || !desk) return;
  const suffix = (r.pages.length > 1 ? '_page-' + String(state.page + 1).padStart(2, '0') : '') + (invertOn() ? '_invert' : '');
  const res = await desk.save({ kind: 'gcode', name: baseName() + suffix, content: currentGcode() });
  flash(res.ok ? 'Saved: ' + res.filePath : res.canceled ? '' : res.error);
};
$('saveAllBtn').onclick = async () => {
  const r = state.result;
  if (!r || !desk) return;
  const invert = invertOn();
  const pages = r.pages.map((p, i) => ({ name: 'page-' + String(i + 1).padStart(3, '0') + '.gcode', content: D.gcode(p, r.settings, i, r.pages.length, { invert }) }));
  const res = await desk.save({ kind: 'zip', name: baseName() + (invert ? '_invert' : '') + '_pages', pages });
  flash(res.ok ? 'Saved: ' + res.filePath : res.canceled ? '' : res.error);
};

// ------------------------------------------------------------------ dialogs
function confirmBox(title, text, okLabel) {
  return new Promise(resolve => {
    const dlg = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel || 'OK';
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('confirmCancel').focus();
  });
}

// ------------------------------------------------------------------ projects
function fromBrailleGcode2(s) {
  const m = Number(s.margin) || 0;
  return {
    originX: s.originX + m, originY: s.originY - m, width: s.width - 2 * m, height: s.height - 2 * m,
    dotPitch: s.dotPitch, cellPitch: s.cellPitch, linePitch: s.linePitch,
    clearZ: s.clearZ, punchZ: s.punchZ, feed: s.feed, dwell: s.dwell
  };
}
$('saveProjectBtn').onclick = async () => {
  if (!desk) return;
  let settings;
  try { settings = D.geometry(readSettings()).settings; } catch (e) { flash(e.message); return; }
  const page = {
    on: pageOn(), size: $('paperSize').value, orientation: orientation(), margin: marginMm(), marginUnit: marginUnit(), w: Number.parseFloat($('paperW').value), h: Number.parseFloat($('paperH').value),
    scale: scaleMode(), scalePct: customPct(), pdfPaper: $('pdfPaper').checked
  };
  const sheet = { auto: $('autoNext').checked, seconds: autoSeconds() || Number.parseFloat($('autoNextSec').value) };
  const content = JSON.stringify({ format: 'dotsense-project', version: 1, text: $('sentence').value, settings, invert: invertOn(), braille: brailleOpts(), page, sheet, sources: ocr.sources }, null, 2);
  const res = await desk.save({ kind: 'project', name: baseName(), content });
  flash(res.ok ? 'Project saved: ' + res.filePath : res.canceled ? '' : res.error);
};
$('openProjectBtn').onclick = async () => {
  if (!desk) return;
  const res = await desk.openProject();
  if (res.canceled) return;
  if (!res.ok) { flash(res.error); return; }
  const p = res.project || {};
  let settings;
  if (p.format === 'dotsense-project') settings = p.settings;
  else if (p.format === 'braille-project' && p.version === 2 && p.settings) settings = fromBrailleGcode2(p.settings);
  else { flash('This is not a DotSense or Braille Gcode project file.'); return; }
  if (typeof p.text !== 'string' || p.text.length > D.MAX_CHARS) { flash('The project text is missing or too long.'); return; }
  try { settings = D.geometry(settings).settings; } catch (e) { flash('Project settings: ' + e.message); return; }
  if ($('sentence').value.trim() && $('sentence').value !== p.text) {
    if (!(await confirmBox('Open project?', 'This replaces the current text and settings. Save them first if you need them.', 'Open project'))) return;
  }
  $('sentence').value = p.text;
  $('pageMode').checked = false;   // the project's own settings come first
  manualArea = null;
  writeSettings(settings);
  if (typeof p.invert === 'boolean') $('invertPrint').checked = p.invert;
  if (p.braille && (p.braille.bangla === 'bd' || p.braille.bangla === 'in')) document.querySelector(`input[name=bnStd][value=${p.braille.bangla}]`).checked = true;
  restorePage(p.page, p.sheet);
  ocr.sources = Array.isArray(p.sources) ? p.sources.filter(x => x && typeof x.label === 'string' && typeof x.status === 'string') : [];
  renderSources();
  $('confirmed').checked = false;
  state.page = 0;
  rebuild(false);
  flash('Project opened. Check the machine settings.');
};

// ------------------------------------------------------------------ OCR (images + PDF)
function renderSources() {
  $('sources').replaceChildren(...ocr.sources.map(s => el('li', null, s.label + ' - ' + s.status)));
}
function listFiles() {
  const files = [...$('files').files];
  const size = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  $('fileList').replaceChildren(...files.map(f => el('li', null, `${f.name} · ${size(f.size)}`)));
  $('ocrStatus').textContent = files.length ? `${files.length} file(s) selected. They are read in this order.` : '';
  $('ocrProgress').value = 0;
}
function showFiles(fileList) {
  try {
    const dt = new DataTransfer();
    for (const f of fileList) dt.items.add(f);
    $('files').files = dt.files;
  } catch (_) { /* keep previous selection */ }
  listFiles();
}
function setFiles(fileList) {
  document.querySelector('input[name=importMode][value=replace]').checked = true;
  showFiles(fileList);
}
function openOcr(files) {
  syncLang();
  const dlg = $('ocrDialog');
  if (!dlg.open) { ocr.runs = 0; dlg.showModal(); }
  if (files && files.length) setFiles(files);
  setTimeout(pumpPhone, 0);   // photos from the phone that came while it could not be shown
}
function ocrControls() {
  const busy = ocr.busy;
  $('extractBtn').disabled = busy;
  $('stopOcrBtn').disabled = !busy;
  $('ocrClose').disabled = busy;
  for (const id of ['files', 'pdfStart', 'pdfEnd', 'forceOcr', 'sourceBreak']) $(id).disabled = busy;
  document.querySelectorAll('input[name=importMode]').forEach(i => { i.disabled = busy; });
  $('dropzone').style.pointerEvents = busy ? 'none' : '';
}
$('ocrBtn').onclick = () => openOcr();
$('ocrClose').onclick = () => { if (!ocr.busy) $('ocrDialog').close(); };
$('ocrDialog').addEventListener('cancel', e => { if (ocr.busy) e.preventDefault(); });
$('files').onchange = () => { document.querySelector('input[name=importMode][value=replace]').checked = true; listFiles(); };
const dz = $('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  dz.classList.remove('over');
  if (!ocr.busy && e.dataTransfer && e.dataTransfer.files.length) setFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter(f => /\.(png|jpe?g|bmp|webp|pdf)$/i.test(f.name));
  if (files.length && !state.printing && !ocr.busy && desk) openOcr(files);
});
for (const id of ['forceOcr', 'sourceBreak']) $(id).addEventListener('change', saveStore);

function addText(text, label, method) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (clean) {
    const run = ocr.run;
    const replacing = run && !run.received && run.mode === 'replace';
    const separator = $('sourceBreak').checked ? '\n[[PAGE]]\n' : '\n\n';
    const base = replacing ? '' : $('sentence').value;
    const next = base + (base.trim() ? separator : '') + clean;
    if (next.length > D.MAX_CHARS) throw new Error('1,000,000 character limit reached. Save this project and start a new one.');
    if (replacing) { ocr.sources = []; state.page = 0; }
    $('sentence').value = next;
    if (run) run.received = true;
    scheduleRebuild(false);
  }
  ocr.sources.push({ label, status: clean ? method : 'No text found - check this source' });
  renderSources();
}

// "Choose paper size by PDF page size": the listed size that matches the PDF page (within 2 mm),
// otherwise User-Defined with the page's own size; the orientation follows the page.
function paperFromPdf(size) {
  const r1 = n => Math.round(n * 10) / 10;
  const short = Math.min(size.w, size.h), long = Math.max(size.w, size.h);
  const landscape = size.w > size.h + 0.5;
  const match = D.PAPER_SIZES.find(p => p.id !== 'custom' && Math.abs(Math.min(p.w, p.h) - short) <= 2 && Math.abs(Math.max(p.w, p.h) - long) <= 2);
  if (match) $('paperSize').value = match.id;
  else { $('paperSize').value = 'custom'; $('paperW').value = r1(short); $('paperH').value = r1(long); }
  document.querySelector(`input[name=orientation][value=${landscape ? 'landscape' : 'portrait'}]`).checked = true;
  $('confirmed').checked = false;
  applyPage();
  return `Paper size from the PDF: ${match ? match.label : `User-Defined ${r1(short)} × ${r1(long)} mm`}, ${landscape ? 'landscape' : 'portrait'}.`;
}

// Camera photos are often stored sideways with a note (EXIF) saying how to turn them. OCR does
// not read that note, so such photos are turned upright here first (the picture shows them upright).
async function imageBytes(file) {
  const bytes = await file.arrayBuffer();
  if (D.jpegOrientation(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 262144))) <= 1) return bytes;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.95));
    c.width = c.height = 0;
    return blob ? await blob.arrayBuffer() : bytes;
  } catch (_) {
    return bytes;   // read it as it is
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ocrBytes(bytes) {
  const r = await desk.ocr(bytes, inputLang());
  if (!r.ok) throw new Error(r.error);
  return r.text;
}

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('./node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  }
  return pdfjs;
}

async function readPdf(file) {
  const lib = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let task;
  try {
    task = lib.getDocument({
      data: bytes, isEvalSupported: false,
      cMapUrl: new URL('./node_modules/pdfjs-dist/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url).href
    });
    const doc = await task.promise;
    const start = Number($('pdfStart').value || 1);
    const end = $('pdfEnd').value ? Number($('pdfEnd').value) : doc.numPages;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || start > doc.numPages || end > doc.numPages) {
      throw new Error(`Page range ${start}-${end} is not valid: this PDF has ${doc.numPages} page(s).`);
    }
    for (let n = start; n <= end && !ocr.stop; n++) {
      const page = await doc.getPage(n);
      if (ocr.run && !ocr.run.pdfPage) {
        const v = page.getViewport({ scale: 1 });   // PDF points, page rotation included
        ocr.run.pdfPage = { w: v.width * 25.4 / 72, h: v.height * 25.4 / 72 };
      }
      ocr.prefix = `${file.name} · page ${n} of ${doc.numPages}`;
      $('ocrStatus').textContent = ocr.prefix;
      let text = '';
      let method = 'PDF text';
      // The text stored in Bangla PDFs comes out scrambled (vowel signs, conjuncts, old fonts),
      // so in Bangla every PDF page is read with OCR.
      if (!$('forceOcr').checked && inputLang() !== 'bn') {
        const content = await page.getTextContent();
        text = content.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join('');
      }
      if (!text.trim()) {
        method = 'OCR';
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, Math.sqrt(16000000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        if (!blob) throw new Error('Could not render PDF page ' + n);
        text = await ocrBytes(await blob.arrayBuffer());
        canvas.width = canvas.height = 0;
      }
      addText(text, `${file.name} / page ${n}`, method);
      page.cleanup();
      $('ocrProgress').value = 100 * (n - start + 1) / (end - start + 1);
      await new Promise(res => setTimeout(res, 0));
    }
  } finally {
    if (task) await task.destroy();
  }
}

async function runExtract() {
  if (!desk || ocr.busy) return;
  const files = [...$('files').files];
  if (!files.length) { $('ocrStatus').textContent = 'Choose images or PDF files first.'; return; }
  if (voice.phase !== 'off') await stopVoice();
  const mode = document.querySelector('input[name=importMode]:checked').value;
  ocr.run = { mode, received: false, previousText: $('sentence').value };
  ocr.busy = true;
  ocr.stop = false;
  state.ocrBusy = true;
  $('ocrProgress').value = 0;
  ocrControls();
  updateControls();
  let errors = 0;
  try {
    for (const file of files) {
      if (ocr.stop) break;
      ocr.prefix = file.name;
      $('ocrStatus').textContent = file.name;
      try {
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        if (file.size > (isPdf ? 100 : 20) * 1024 * 1024) throw new Error(`File is larger than ${isPdf ? 100 : 20} MB.`);
        if (isPdf) await readPdf(file);
        else addText(await ocrBytes(await imageBytes(file)), file.name, 'OCR');
      } catch (e) {
        errors++;
        ocr.sources.push({ label: file.name, status: 'FAILED: ' + e.message });
        renderSources();
      }
    }
    const outcome = ocr.run.received
      ? (mode === 'replace' ? 'The text box now has the scanned text (old text replaced).' : 'The scanned text was added at the end.')
      : 'No text was found. Your text was kept.';
    const paperNote = ocr.run.received && ocr.run.pdfPage && pageOn() && $('pdfPaper').checked ? ' ' + paperFromPdf(ocr.run.pdfPage) : '';
    $('ocrStatus').textContent = (ocr.stop ? 'Stopped. ' : 'Done. ') + outcome + (errors ? ` ${errors} file(s) failed - see the list.` : '') + paperNote;
    $('ocrProgress').value = 100;
    if (ocr.run.received) { const t = $('sentence'); t.scrollTop = mode === 'replace' ? 0 : t.scrollHeight; }
  } finally {
    if (ocr.run && !ocr.run.received) $('sentence').value = ocr.run.previousText;
    ocr.run = null;
    ocr.busy = false;
    ocr.runs++;
    state.ocrBusy = false;
    ocrControls();
    updateControls();
    scheduleRebuild(false);
    setTimeout(pumpPhone, 0);   // photos that came while this was reading
  }
}
$('extractBtn').onclick = () => runExtract();
$('stopOcrBtn').onclick = () => { ocr.stop = true; $('ocrStatus').textContent = 'Stopping after the current page. Finished text is kept.'; };
if (desk) desk.onOcrProgress(({ status, progress }) => {
  if (!ocr.busy) return;
  $('ocrStatus').textContent = ocr.prefix + ' · ' + status + (progress ? ' ' + Math.round(progress * 100) + '%' : '');
});

// ------------------------------------------------------------------ language (voice typing + OCR)
// One choice for both, in the Text panel and in the Scan dialog.
function syncLang() {
  const lang = inputLang();
  document.querySelector(`input[name=ocrLang][value=${lang}]`).checked = true;
  $('ocrLangText').textContent = lang === 'bn' ? 'Bangla and English printed text' : 'English printed text';
  $('ocrBnNote').hidden = lang !== 'bn';
  $('voiceHint').textContent = lang === 'bn'
    ? 'Voice commands: “নতুন লাইন”, “নতুন অনুচ্ছেদ”, “নতুন পাতা”.'
    : 'Voice commands: “new line”, “new paragraph”, “new page”.';
}
function setLang(lang) {
  document.querySelector(`input[name=inputLang][value=${lang === 'bn' ? 'bn' : 'en'}]`).checked = true;
  syncLang();
}
async function onLangChange() {
  syncLang();
  saveStore();
  // voice typing on: carry on with the other language's model
  if (voice.phase === 'listening' || voice.phase === 'preparing') {
    closeMic();
    await desk.voice.cancel();
    startVoice();
  } else if (voice.phase === 'choose') startVoice();
}
document.querySelectorAll('input[name=inputLang]').forEach(r => r.addEventListener('change', onLangChange));
document.querySelectorAll('input[name=ocrLang]').forEach(r => r.addEventListener('change', () => { setLang(r.value); onLangChange(); }));
document.querySelectorAll('input[name=bnStd]').forEach(r => r.addEventListener('change', () => { applyPage(); rebuild(false); }));

// ------------------------------------------------------------------ voice typing
function setVoice(phase, status) {
  voice.phase = phase;
  const bar = $('voiceBar');
  bar.hidden = phase === 'off';
  bar.dataset.state = phase;
  if (phase !== 'listening') bar.dataset.speech = '0';
  if (status != null) $('voiceStatus').textContent = status;
  $('voiceChoice').hidden = phase !== 'choose';
  if (phase === 'choose') {
    const bn = inputLang() === 'bn';
    $('voiceChoiceText').textContent = bn
      ? 'Bangla voice typing works offline. It needs a one-time download of the Bangla speech model:'
      : 'Voice typing works offline. It needs a one-time download of a speech model:';
    $('dlAccurate').hidden = $('dlFast').hidden = bn;
    $('dlBangla').hidden = !bn;
  }
  if (phase !== 'preparing') $('voiceProgress').hidden = true;
  if (phase !== 'listening') $('voicePartial').textContent = '';
  const on = phase === 'preparing' || phase === 'listening' || phase === 'finishing';
  $('voiceBtn').setAttribute('aria-pressed', String(on));
  $('voiceBtnText').textContent = on ? 'Stop voice' : 'Voice typing';
  updateControls();
}
function setVoiceProgress(f) {
  $('voiceProgress').hidden = false;
  $('voiceProgressFill').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
}
function voiceError(msg) {
  closeMic();
  setVoice('error', msg);
}

// The voice model for the chosen language: Bangla, or the English model the person picked.
const activeVoiceModel = () => (inputLang() === 'bn' ? 'bangla' : voice.model);
async function startVoice(model) {
  if (!desk) return;
  const chosen = !!model;
  model = model || activeVoiceModel();
  setVoice('preparing', 'Starting…');
  let models;
  try { models = await desk.voice.models(); } catch (e) { voiceError(e.message); return; }
  if (!chosen && !(models[model] && models[model].installed)) {
    const other = model === 'accurate' ? 'fast' : model === 'fast' ? 'accurate' : '';
    if (other && models[other] && models[other].installed) model = other;
    else { setVoice('choose', inputLang() === 'bn' ? 'বাংলা voice typing' : 'Voice typing'); return; }
  }
  if (model !== 'bangla') voice.model = model;
  $('voiceModel').value = model;
  saveStore();
  setVoice('preparing', models[model] && models[model].installed ? 'Loading voice model…' : 'Downloading voice model…');
  const r = await desk.voice.start(model);
  if (!r.ok) voiceError(r.error);
}

async function openMic() {
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    voice.ctx = new AudioContext({ sampleRate: 16000 });
    await voice.ctx.audioWorklet.addModule('capture-worklet.js');
    voice.src = voice.ctx.createMediaStreamSource(voice.stream);
    voice.node = new AudioWorkletNode(voice.ctx, 'dotsense-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = voice.ctx.createGain();
    mute.gain.value = 0;
    voice.src.connect(voice.node);
    voice.node.connect(mute);
    mute.connect(voice.ctx.destination);
    voice.node.port.onmessage = e => {
      if (voice.phase !== 'listening') return;
      const samples = e.data;
      desk.voice.audio(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / (samples.length / 4));
      $('voiceLevel').style.width = Math.min(100, Math.round(rms * 400)) + '%';
    };
    if (voice.ctx.state === 'suspended') await voice.ctx.resume();
    setVoice('listening', 'Listening… speak now');
  } catch (e) {
    const msg = e && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow the microphone for DotSense in your system privacy settings.'
      : e && e.name === 'NotFoundError' ? 'No microphone found. Plug one in and try again.'
      : 'Microphone error: ' + ((e && e.message) || e);
    voiceError(msg);
    desk.voice.cancel();
  }
}

function closeMic() {
  try { if (voice.node) { voice.node.port.onmessage = null; voice.node.disconnect(); } } catch (_) { /* closed */ }
  try { if (voice.src) voice.src.disconnect(); } catch (_) { /* closed */ }
  if (voice.stream) voice.stream.getTracks().forEach(t => t.stop());
  if (voice.ctx) voice.ctx.close().catch(() => {});
  voice.ctx = voice.stream = voice.node = voice.src = null;
  $('voiceLevel').style.width = '0';
}

async function stopVoice() {
  if (voice.phase === 'listening') {
    closeMic();
    setVoice('finishing', 'Finishing the last words…');
    await desk.voice.stop();
    setTimeout(() => { if (voice.phase === 'finishing') setVoice('off'); }, 10000);
  } else {
    closeMic();
    if (desk && (voice.phase === 'preparing' || voice.phase === 'finishing')) desk.voice.cancel();
    setVoice('off');
  }
}

function insertVoiceText(raw) {
  const t = $('sentence');
  if (t.disabled) return;
  const text = String(raw || '').trim();
  if (!text) return;
  const cmd = text.toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
  const start = t.selectionStart, end = t.selectionEnd;
  const before = t.value.slice(0, start);
  const atEnd = end >= t.value.length;
  let insert;
  const bn = text.replace(/[।,.!?]/g, '').replace(/\s+/g, ' ').trim();   // Bangla voice commands
  const BN_LINE = ['নতুন লাইন', 'নতুন লাইনে', 'পরের লাইন', 'নিউ লাইন'];
  const BN_PARAGRAPH = ['নতুন অনুচ্ছেদ', 'নতুন প্যারা', 'নতুন প্যারাগ্রাফ', 'নিউ প্যারাগ্রাফ'];
  const BN_PAGE = ['নতুন পাতা', 'নতুন পৃষ্ঠা', 'নতুন পেজ', 'পরের পাতা', 'নিউ পেজ'];
  if (cmd === 'new line' || cmd === 'next line' || BN_LINE.includes(bn)) insert = '\n';
  else if (cmd === 'new paragraph' || BN_PARAGRAPH.includes(bn)) insert = '\n\n';
  else if (cmd === 'new page' || cmd === 'page break' || cmd === 'next page' || BN_PAGE.includes(bn)) insert = (before && !before.endsWith('\n') ? '\n' : '') + '[[PAGE]]\n';
  else insert = (before && !/\s$/.test(before) ? ' ' : '') + text;
  t.setRangeText(insert, start, end, 'end');
  if (atEnd) t.scrollTop = t.scrollHeight;
  scheduleRebuild(true);
}

$('voiceBtn').onclick = () => {
  if (voice.phase === 'off' || voice.phase === 'error') startVoice();
  else stopVoice();
};
$('dlAccurate').onclick = () => startVoice('accurate');
$('dlFast').onclick = () => startVoice('fast');
$('dlBangla').onclick = () => startVoice('bangla');
$('dlCancel').onclick = () => setVoice('off');
$('voiceModel').onchange = async () => {
  const m = $('voiceModel').value;
  if (m === 'bangla') setLang('bn');
  else { voice.model = m; setLang('en'); }
  saveStore();
  if (voice.phase === 'listening' || voice.phase === 'preparing') {
    closeMic();
    await desk.voice.cancel();
    startVoice(activeVoiceModel());
  }
};
if (desk) desk.voice.onEvent(ev => {
  const mb = x => (x / 1048576).toFixed(1);
  switch (ev.type) {
    case 'download':
      if (voice.phase !== 'preparing') break;
      if (ev.part === 'model') {
        $('voiceStatus').textContent = `Downloading ${ev.model === 'fast' ? 'Fast' : ev.model === 'bangla' ? 'Bangla' : 'Accurate'} voice model… ${mb(ev.received)} of ${mb(ev.total)} MB (one time only)`;
        setVoiceProgress(ev.total ? ev.received / ev.total : 0);
      } else $('voiceStatus').textContent = 'Downloading voice detector…';
      break;
    case 'unpacking': if (voice.phase === 'preparing') { $('voiceStatus').textContent = 'Unpacking voice model…'; setVoiceProgress(1); } break;
    case 'loading': if (voice.phase === 'preparing') { $('voiceStatus').textContent = 'Loading voice model…'; $('voiceProgress').hidden = true; } break;
    case 'ready': if (voice.phase === 'preparing') openMic(); break;
    case 'speech': if (voice.phase === 'listening') $('voiceBar').dataset.speech = ev.active ? '1' : '0'; break;
    case 'partial': if (voice.phase === 'listening') $('voicePartial').textContent = ev.text; break;
    case 'final': insertVoiceText(ev.text); $('voicePartial').textContent = ''; break;
    case 'flushed': if (voice.phase === 'finishing') setVoice('off'); break;
    case 'error': voiceError('Voice typing: ' + ev.message); break;
    case 'exit': if (voice.phase !== 'off' && voice.phase !== 'error') voiceError('The voice engine stopped. Press Voice typing to try again.'); break;
  }
});

// ------------------------------------------------------------------ machine
function stateLabel(s) {
  if (!machine.connected) return 'Not connected';
  if (/^Hold:0|^Hold$/.test(s)) return 'Paused (hold)';
  if (/^Hold/.test(s)) return 'Pausing…';
  if (/^Door/.test(s)) return 'Door open';
  if (/^Alarm/.test(s)) return 'ALARM';
  if (/^Run/.test(s)) return 'Running';
  if (/^Check/.test(s)) return 'Check mode';
  return s;
}
function setStateUi(text, tone) {
  $('stateText').textContent = text;
  $('stateBadge').dataset.tone = tone;
}
function updatePill() {
  const P = state.printing;
  let text, tone;
  if (P && P.last && P.jobActive) {
    text = P.paused ? 'Paused' : `Printing ${Math.floor(P.last.percent)}%`;
    tone = P.paused ? 'hold' : 'busy';
  } else if (P) { text = P.sheetText || 'Change sheet'; tone = 'hold'; }
  else if (!machine.connected) { text = 'Not connected'; tone = 'off'; }
  else if (/^Alarm/.test(machine.state)) { text = 'DotSense connected · ALARM'; tone = 'bad'; }
  else if (/^Check/.test(machine.state)) { text = 'DotSense connected · CHECK MODE'; tone = 'hold'; }
  else { text = 'DotSense connected'; tone = 'ok'; }
  $('machinePillText').textContent = text;
  $('machinePill').dataset.tone = tone;
}
function applyStatus(s) {
  if (!s) return;
  machine.status = s;
  machine.state = s.state;
  const st = s.state || '';
  const tone = !machine.connected ? 'off' : /^(Alarm|Not responding)/.test(st) ? 'bad' : /^(Run|Jog|Home)/.test(st) ? 'busy' : /^(Hold|Door|Check)/.test(st) ? 'hold' : /^Idle/.test(st) ? 'ok' : 'off';
  setStateUi(stateLabel(st), tone);
  if (machine.connected && s.wpos) $('posReadout').textContent = `X ${s.wpos[0].toFixed(2)}   Y ${s.wpos[1].toFixed(2)}   Z ${s.wpos[2].toFixed(2)}`;
  updatePill();
  updateControls();
}
function setDisconnected() {
  machine.connected = false;
  machine.state = 'Disconnected';
  machine.info = null;
  applyPage();
  $('machineVersion').textContent = '';
  $('posReadout').textContent = 'X –   Y –   Z –';
  setStateUi('Not connected', 'off');
  updatePill();
  updateControls();
}
function showMachineMsg(text, tone, actions) {
  $('machineMsg').className = 'notice' + (tone ? ' ' + tone : '');
  $('machineMsgText').textContent = text;
  $('machineMsgActions').replaceChildren(...(actions || []).map(([label, fn, primary]) => {
    const b = el('button', 'btn small' + (primary ? ' primary' : ''), label);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }));
  $('machineMsg').hidden = false;
}
function hideMachineMsg() { $('machineMsg').hidden = true; }

async function refreshPorts() {
  if (!desk) return;
  const sel = $('portSelect');
  const prev = sel.value || stored.port || '';
  const r = await desk.machine.list();
  sel.replaceChildren();
  if (!r.ports.length) sel.append(new Option('No USB serial port found - plug in the machine', ''));
  for (const p of r.ports) sel.append(new Option(p.label, p.path));
  if (prev && r.ports.some(p => p.path === prev)) sel.value = prev;
  updateControls();
}
$('refreshPorts').onclick = refreshPorts;
$('baudSelect').onchange = saveStore;
$('portSelect').onchange = saveStore;

$('connectBtn').onclick = async () => {
  if (!desk) return;
  if (machine.connected) {
    machine.busy = true;
    updateControls();
    await desk.machine.disconnect();
    machine.busy = false;
    setDisconnected();
    return;
  }
  const portPath = $('portSelect').value;
  if (!portPath) { showMachineMsg('Choose the machine port first: plug in the USB cable and press ⟳.', 'bad'); return; }
  hideMachineMsg();
  machine.busy = true;
  setStateUi('Connecting…', 'busy');
  updateControls();
  const r = await desk.machine.connect(portPath, Number($('baudSelect').value));
  machine.busy = false;
  if (!r.ok) { setDisconnected(); showMachineMsg(r.error, 'bad'); return; }
  machine.connected = true;
  machine.info = r.info;
  $('machineVersion').textContent = 'Grbl ' + r.info.version;
  applyPage();
  stored.port = portPath;
  saveStore();
  applyStatus(r.status);
  if (/^Alarm/.test(r.status.state)) {
    const actions = [['Unlock', unlock, true]];
    if (r.info.homing) actions.unshift(['Home ($H)', () => machineAction(desk.machine.home(), 'Homing done.'), true]);
    showMachineMsg(r.info.homing ? 'The machine is locked until it is homed. Home it, or Unlock if you know the position is right.' : 'The machine is locked (ALARM). Check it, then press Unlock.', 'bad', actions);
  }
  render();
};

const logLines = [];
function renderLog() {
  const box = $('log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  box.textContent = logLines.join('\n');
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function appendLog(entries) {
  for (const e of entries) logLines.push((e.dir === 'out' ? '› ' : e.dir === 'in' ? '‹ ' : '! ') + e.text);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  if ($('logDetails').open) renderLog();
}
$('logDetails').addEventListener('toggle', () => { if ($('logDetails').open) renderLog(); });
$('cmdForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('cmdInput').value.trim();
  if (!text || !desk) return;
  const r = await desk.machine.command(text);
  if (r.ok) $('cmdInput').value = '';
  else appendLog([{ dir: 'err', text: r.error }]);
};

async function machineAction(promise, okText) {
  const r = await promise;
  if (!r.ok) showMachineMsg(r.error, 'bad');
  else if (okText) showMachineMsg(okText, 'good');
  return r;
}
async function unlock() { const r = await machineAction(desk.machine.unlock()); if (r.ok) hideMachineMsg(); }
// Jog step: 0.1 / 1 / 10 in mm or cm. Z moves at most 10 mm per click so the punch can't crash;
// X/Y never more than the machine's travel ($130/$131) when it is known.
const jogUnit = () => (document.querySelector('input[name=jogUnit]:checked') || {}).value === 'cm' ? 'cm' : 'mm';
function jogDistance(axis) {
  const step = Number(document.querySelector('input[name=jogStep]:checked').value);
  let mm = step * (jogUnit() === 'cm' ? 10 : 1);
  if (axis === 'Z') mm = Math.min(mm, 10);
  const travel = machine.info && machine.info.travel;
  const limit = travel && travel['XYZ'.indexOf(axis)];
  if (limit > 0) mm = Math.min(mm, limit);
  return mm;
}
document.querySelectorAll('[data-jog]').forEach(b => {
  b.onclick = () => {
    const axis = b.dataset.jog[0];
    const dir = b.dataset.jog[1] === '+' ? 1 : -1;
    machineAction(desk.machine.jog(axis, dir * jogDistance(axis), axis === 'Z' ? 300 : 1000));
  };
});
document.querySelectorAll('input[name=jogUnit]').forEach(r => r.addEventListener('change', saveStore));
$('jogStop').onclick = () => desk.machine.jogCancel();
$('zeroXY').onclick = () => machineAction(desk.machine.zero('XY'), 'X/Y zero is now at the current position.');
$('zeroZ').onclick = () => machineAction(desk.machine.zero('Z'), 'Z zero is now at the current height. Punch depth and clearance are measured from here.');
$('gotoStart').onclick = () => {
  const r = state.result;
  if (r) machineAction(desk.machine.goto(r.settings.originX, r.settings.originY, r.settings.clearZ), 'Moved above the first dot at clearance height.');
};
$('unlockBtn').onclick = unlock;
$('homeBtn').onclick = () => machineAction(desk.machine.home(), 'Homing done.');
// Check Mode ($C): GRBL checks the G-code without moving the CNC. Off again = GRBL resets.
$('checkModeBtn').onclick = async () => {
  $('checkModeBtn').disabled = true;
  const r = await desk.machine.checkMode();
  if (!r.ok) showMachineMsg(r.error, 'bad');
  else if (r.check) showMachineMsg('Check Mode is ON: GRBL reads and checks the G-code but does not move the machine. Print a page to test its G-code.', '');
  else showMachineMsg('Check Mode is OFF: GRBL was reset and the machine moves normally again.', 'good');
  updateControls();
};

// Soft Reset (Ctrl-X): resets GRBL without switching the machine off - when GRBL is stuck,
// to abort a job, or to reset the controller.
$('resetMachineBtn').onclick = async () => {
  const P = state.printing;
  if (P) {
    P.aborted = true;
    P.abortedBetween = !P.jobActive;
    if (!P.jobActive && P.sheetCancel) P.sheetCancel();   // waiting for the next sheet: end the print here
  }
  const r = await desk.machine.reset();
  if (!r.ok) showMachineMsg(r.error, 'bad');
  else if (!P) showMachineMsg('Soft reset done: GRBL was reset without switching the machine off.', 'good');
};

// ---- invert view window
function invertState() {
  const r = state.result;
  const P = state.printing;
  const base = { type: 'state', invert: invertOn(), error: state.error, printing: !!P };
  if (!r || !r.pages.length) return Object.assign(base, { page: null });
  const printedInfo = !P && state.printed && state.printed.result === r ? state.printed.pages.get(state.page) : null;
  let job = null;
  if (P && P.page === state.page && P.keys) {
    job = { keys: P.keys, dots: P.keys.length, dotsDone: P.last ? P.last.dotsDone : 0, current: P.last ? P.last.current : -1, active: P.jobActive };
  } else if (printedInfo) {
    job = { keys: printedInfo.keys, dots: printedInfo.keys.length, dotsDone: printedInfo.dotsDone, current: -1, active: false };
  }
  return Object.assign(base, {
    page: r.pages[state.page], pageIndex: state.page, pageCount: r.pages.length,
    cols: r.cols, rows: r.rows, settings: r.settings, job
  });
}
function sendInvertState() {
  if (desk && invertWinOpen) desk.invert.update(invertState());
}
// Invert view: the mirrored machine side next to the reading side, both live
$('invertViewBtn').onclick = () => {
  state.sideView = !state.sideView;
  $('invertViewBtn').setAttribute('aria-pressed', String(state.sideView));
  renderPreview();
  saveStore();
};
if (desk) desk.invert.onEvent(ev => {
  if (ev.type === 'opened') invertWinOpen = true;
  else if (ev.type === 'closed') invertWinOpen = false;
  else if (ev.type === 'request') { invertWinOpen = true; sendInvertState(); }
  else if (ev.type === 'goto') {
    if (!state.printing && state.result && ev.page >= 0 && ev.page < state.result.pages.length) { state.page = ev.page; render(); }
  } else if (ev.type === 'set') {
    if (!state.printing) { $('invertPrint').checked = ev.on; $('confirmed').checked = false; render(); saveStore(); }
  }
});

// ---- live printing
async function printPages(from, to) {
  const r = state.result;
  if (!r || !r.pages.length || state.printing) return;
  const rates = machine.info && machine.info.rates;
  const invert = invertOn();
  let dots = 0, est = 0;
  const pageEst = [];
  for (let i = from; i <= to; i++) {
    const pts = D.pagePoints(r.pages[i], r.settings, { invert });
    // last check before the machine moves: no dot outside the paper
    if (r.sheet && D.offSheet(pts, r.sheet)) {
      showMachineMsg(`Page ${i + 1} has dots outside the paper, so nothing was printed. Check the paper size and margin.`, 'bad');
      return;
    }
    dots += pts.length;
    pageEst[i] = D.estimate(pts, r.settings, rates);
    est += pageEst[i];
  }
  const check = /^Check/.test(machine.state);   // GRBL check mode: the G-code is checked, nothing moves
  const what = from === to ? `page ${from + 1}` : check ? `pages ${from + 1} to ${to + 1}` : `pages ${from + 1} to ${to + 1} (${to - from + 1} sheets, you change the paper in between)`;
  const ok = check
    ? await confirmBox('Check the G-code?', `Check mode is ON: GRBL reads and checks every G-code line of ${what} (${fmtNum(dots)} dots), but the machine does not move and nothing is punched.`, 'Start check')
    : await confirmBox('Start punching?',
      `DotSense will punch ${what}: ${fmtNum(dots)} dots, about ${fmtTime(est)}. ` +
      (invert ? 'Invert print is ON: the page is punched mirrored (read it from the back). ' : 'Invert print is OFF: the page is punched as it reads. ') +
      'Check that the paper is clamped and work zero is set (X0 Y0 at your reference corner, Z0 on the paper surface). Keep a hand near the machine power switch.',
      'Start printing');
  if (!ok) return;
  if (voice.phase !== 'off' && voice.phase !== 'error') await stopVoice();
  hideMachineMsg();
  state.printed = { result: r, pages: new Map(), invert };
  state.printing = {
    result: r, from, to, page: from, invert, check, jobActive: false, paused: false, last: null, points: null, keys: null, resolve: null, sheetCancel: null, started: Date.now(),
    pageEst, countdown: { left: est, at: Date.now(), running: false }
  };
  clearInterval(timeTicker);
  timeTicker = setInterval(updateTimeStat, 250);
  updateTimeStat();
  $('progressBox').hidden = false;
  let outcome = 'done';
  let finished = 0;
  for (let p = from; p <= to; p++) {
    if (p > from && !check) {   // a check run needs no paper: no sheet change in between
      const go = await sheetPrompt(p);
      if (!go) { outcome = state.printing.aborted ? 'aborted' : 'cancelled'; break; }
    }
    const P = state.printing;
    P.page = p;
    P.last = null;
    P.lastJob = null;
    state.page = p;
    const job = D.jobLines(r.pages[p], r.settings, p, r.pages.length, { invert });
    P.points = job.points;
    P.keys = job.keys;
    renderPager();
    renderPreview();
    renderGcode();
    updateControls();
    sendInvertState();
    outcome = await runJob({
      lines: job.lines, clearZ: r.settings.clearZ, estimate: D.estimate(job.points, r.settings, rates),
      page: p, pages: r.pages.length, label: D.lineText(r.pages[p][0] || [])
    });
    const lastJob = state.printing.lastJob;
    if (lastJob) state.printed.pages.set(p, { dotsDone: lastJob.dotsDone, keys: P.keys });
    if (outcome !== 'done') break;
    finished++;
  }
  const P = state.printing;
  state.printing = null;
  clearInterval(timeTicker);
  if (check) state.printed = null;   // nothing was punched
  finishNotice(outcome, P, finished);
  render();
  updatePill();
}

function runJob(job) {
  return new Promise(resolve => {
    const P = state.printing;
    P.resolve = resolve;
    P.jobActive = true;
    P.paused = false;
    updateControls();
    sendInvertState();
    desk.machine.start(job).then(r => {
      if (!r.ok && P.resolve) {
        P.resolve = null;
        P.jobActive = false;
        showMachineMsg(r.error, 'bad');
        resolve('failed');
      }
    });
  });
}

function sheetPrompt(p) {
  return new Promise(resolve => {
    const P = state.printing;
    const total = autoSeconds();
    let left = total;
    let held = total == null;
    let timer = 0;
    const ready = () => machine.connected && /^Idle/.test(machine.state);
    const show = () => {
      $('sheetPromptText').textContent = held
        ? `Page ${p} is done. Put in sheet ${p + 1} at the same place (same work zero), clamp it, then press Continue.`
        : `Page ${p} is done. Put in sheet ${p + 1} at the same place (same work zero). Page ${p + 1} starts by itself in ${left} s.`;
      $('sheetContinue').textContent = held ? 'Continue' : 'Continue now';
      $('sheetWait').hidden = held;
      $('sheetBar').hidden = held;
      if (!held) $('sheetBarFill').style.width = (100 * left / total) + '%';
      P.sheetText = held ? 'Change sheet' : `Next sheet in ${left} s`;
      updatePill();
    };
    const done = go => {
      clearInterval(timer);
      $('sheetPrompt').hidden = true;
      $('sheetContinue').onclick = $('sheetCancel').onclick = $('sheetWait').onclick = null;
      P.sheetCancel = null;
      P.sheetText = null;
      resolve(go);
    };
    const hold = () => { held = true; clearInterval(timer); show(); };
    P.sheetCancel = () => done(false);
    $('sheetContinue').onclick = () => {
      if (!ready()) { showMachineMsg('The machine must be connected and Idle to continue.', 'bad'); return; }
      hideMachineMsg();
      done(true);
    };
    $('sheetWait').onclick = hold;
    $('sheetCancel').onclick = () => done(false);
    $('sheetPrompt').hidden = false;
    show();
    beep(880, 0.15);
    setTimeout(() => beep(880, 0.15), 220);
    if (!held) {
      timer = setInterval(() => {
        left--;
        if (left > 0) {
          if (left <= 5) beep(660, 0.12);
          show();
          return;
        }
        if (!ready()) {
          hold();
          showMachineMsg('The next page did not start: the machine is not connected or not Idle. Press Continue when it is ready.', 'bad');
          return;
        }
        beep(990, 0.4);
        hideMachineMsg();
        done(true);
      }, 1000);
    }
    $('sheetContinue').focus();
  });
}

function finishNotice(outcome, P, finished) {
  const last = P && P.lastJob;
  const pageNo = P ? P.page + 1 : 0;
  if (outcome === 'done' && P.check) {
    const total = P.to - P.from + 1;
    const errs = last && last.errors ? last.errors : 0;
    showMachineMsg(`Check mode: ${total > 1 ? `all ${total} pages` : `page ${pageNo}`} checked${errs ? ` with ${errs} G-code error(s) - see the machine log` : ': GRBL accepted every line'}. The machine did not move. Switch Check Mode off to print for real.`, errs ? 'bad' : 'good');
  } else if (outcome === 'done') {
    const total = P.to - P.from + 1;
    showMachineMsg(total > 1 ? `All ${total} pages punched in ${fmtTime((Date.now() - P.started) / 1000)}.` : `Page ${pageNo} punched: ${fmtNum(last ? last.dots : 0)} dots in ${fmtTime(last ? last.elapsed : 0)}.`, 'good');
  } else if (outcome === 'stopped') {
    showMachineMsg(`Stopped on page ${pageNo} after ${fmtNum(last ? last.dotsDone : 0)} of ${fmtNum(last ? last.dots : 0)} dots. The punch was lifted to clearance.`, '');
  } else if (outcome === 'aborted') {
    const text = P && P.abortedBetween
      ? `Print aborted with Soft Reset after page ${pageNo}. Page ${pageNo + 1} and later were not punched. GRBL was reset.`
      : `Print aborted with Soft Reset on page ${pageNo} after ${fmtNum(last ? last.dotsDone : 0)} of ${fmtNum(last ? last.dots : 0)} dots. GRBL was reset. Lift the punch with Z+ and check the position before printing again.`;
    // a reset while moving usually leaves GRBL in ALARM (position may be lost): offer Unlock
    showMachineMsg(text, 'bad', P && P.abortedBetween ? undefined : [['Unlock', unlock, true]]);
  } else if (outcome === 'cancelled') {
    showMachineMsg(`Stopped after ${finished} page(s). Page ${pageNo + 1} and later were not punched.`, '');
  } else if (outcome === 'alarm') {
    showMachineMsg(`ALARM on page ${pageNo}: ${(last && last.message) || ''} Check the machine, then press Unlock.`, 'bad', [['Unlock', unlock, true]]);
  } else if (outcome === 'reset' || outcome === 'disconnected') {
    showMachineMsg(((last && last.message) || 'Printing was interrupted.') + ` Page ${pageNo} is incomplete.`, 'bad');
  }
}

function keepVisible(child, box) {
  const b = box.getBoundingClientRect(), c = child.getBoundingClientRect();
  if (c.top < b.top + 6) box.scrollTop -= b.top - c.top + 12;
  else if (c.bottom > b.bottom - 6) box.scrollTop += c.bottom - b.bottom + 12;
  if (c.left < b.left + 6) box.scrollLeft -= b.left - c.left + 12;
  else if (c.right > b.right - 6) box.scrollLeft += c.right - b.right + 12;
}

function applyProgress(p) {
  const lists = [state.progEls, state.progEls2].filter(l => l && l.length);
  if (!p || !lists.length) return;
  const n = Math.max(...lists.map(l => l.length));
  const done = Math.min(p.dotsDone, n);
  const cur = p.current >= 0 && p.current < n ? p.current : -1;
  for (const els of lists) {
    for (let k = done; k < state.shownDone; k++) if (els[k]) els[k].dot.classList.remove('done');
    for (let k = state.shownDone; k < done; k++) if (els[k]) els[k].dot.classList.add('done');
    if (state.shownNow >= 0 && els[state.shownNow]) {
      els[state.shownNow].dot.classList.remove('now');
      els[state.shownNow].cell.classList.remove('now');
    }
    if (cur >= 0 && els[cur]) {
      els[cur].dot.classList.add('now');
      els[cur].cell.classList.add('now');
    }
  }
  const first = state.progEls[cur] || state.progEls2[cur];
  if (cur >= 0 && first && cur !== state.shownNow) keepVisible(first.cell, $('preview'));
  state.shownDone = done;
  state.shownNow = cur;
}

function onProgress(p) {
  const P = state.printing;
  if (!P || !p || p.page !== P.page) return;
  P.last = p;
  updateCountdown(p);
  $('progressBox').hidden = false;
  $('progressFill').style.width = p.percent + '%';
  $('progressBar').setAttribute('aria-valuenow', String(Math.round(p.percent)));
  const pageInfo = p.pages > 1 ? `Page ${p.page + 1} of ${p.pages} · ` : '';
  $('progressMain').textContent = `${pageInfo}${fmtNum(p.dotsDone)} of ${fmtNum(p.dots)} dots · ${p.percent < 10 ? p.percent.toFixed(1) : Math.floor(p.percent)}%`;
  const pt = P.points && p.current >= 0 ? P.points[p.current] : null;
  let sub;
  if (p.state === 'paused' || p.state === 'error') sub = 'Paused.';
  else if (p.state === 'stopping') sub = 'Stopping: feed hold, reset, lifting the punch…';
  else if (pt) sub = `${p.phase === 'punch' ? 'Punching' : 'Next'} ${pt.ch === 'ltr' ? 'letter sign' : '“' + pt.ch + '”'} · line ${pt.line + 1}, cell ${pt.col + 1}, dot ${pt.dot}.`;
  else if (p.state === 'done') sub = 'Page finished.';
  else sub = p.dotsDone >= p.dots ? 'Last dot done, returning to X0 Y0.' : '';
  sub += ` ${fmtTime(p.elapsed)} ${p.state === 'done' ? 'total' : 'elapsed'}`;
  if (p.eta != null && p.dotsDone < p.dots) sub += ` · about ${fmtTime(p.eta)} left${p.approx ? ' (approx.)' : ''}`;
  $('progressSub').textContent = sub;
  if (state.page === P.page) applyProgress(p);
  if (desk && invertWinOpen && state.page === P.page) desk.invert.update({ type: 'progress', pageIndex: P.page, dotsDone: p.dotsDone, current: p.current });
  updatePill();
}

function onJob(j) {
  const P = state.printing;
  if (j.type === 'start' || j.type === 'resumed') { if (P) P.paused = false; if (j.type === 'resumed') hideMachineMsg(); }
  if (j.type === 'paused' && P) P.paused = true;
  if (j.type === 'error' && P) {
    P.paused = true;
    showMachineMsg(`The machine rejected a line: ${j.line} (error ${j.code}: ${j.message}). The machine is on hold.`, 'bad', [
      ['Continue anyway', () => desk.machine.resume()], ['Stop', () => desk.machine.stop(), true]
    ]);
  }
  onProgress(j);
  if (['done', 'stopped', 'aborted', 'alarm', 'reset', 'disconnected'].includes(j.type) && P && P.resolve) {
    const res = P.resolve;
    P.resolve = null;
    P.jobActive = false;
    P.lastJob = j;
    res(j.type);
  }
  updateControls();
  updatePill();
}

$('printPageBtn').onclick = () => printPages(state.page, state.page);
$('printAllBtn').onclick = () => { if (state.result) printPages(0, state.result.pages.length - 1); };
$('pauseBtn').onclick = async () => {
  const P = state.printing;
  if (!P || !P.jobActive) return;
  const r = P.paused ? await desk.machine.resume() : await desk.machine.pause();
  if (!r.ok) showMachineMsg(r.error, 'bad');
};
$('stopBtn').onclick = async () => {
  const P = state.printing;
  if (!P) return;
  if (!P.jobActive && P.sheetCancel) { P.sheetCancel(); return; }
  $('stopBtn').disabled = true;
  const r = await desk.machine.stop();
  if (!r.ok) showMachineMsg(r.error, 'bad');
};

if (desk) desk.machine.onEvent(ev => {
  if (ev.type === 'status') applyStatus(ev.status);
  else if (ev.type === 'connection') { if (!ev.connection.connected) setDisconnected(); }
  else if (ev.type === 'progress') onProgress(ev.progress);
  else if (ev.type === 'job') onJob(ev.job);
  else if (ev.type === 'alarm') { if (!state.printing) showMachineMsg(`ALARM ${ev.alarm.code}: ${ev.alarm.message}`, 'bad', [['Unlock', unlock, true]]); }
  else if (ev.type === 'message') appendLog([{ dir: 'msg', text: ev.message }]);
  else if (ev.type === 'log') appendLog(ev.entries);
});

// ------------------------------------------------------------------ theme (dark / light)
// theme.js sets data-theme on <html> before the page is drawn; the app keeps the choice
// and tells every window when it changes.
const themeNow = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function updateThemeBtn() {
  const label = themeNow() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  $('themeBtn').setAttribute('aria-label', label);
  $('themeBtn').title = label;
}
if (desk && desk.theme) {
  $('themeBtn').hidden = false;
  updateThemeBtn();
  desk.theme.onChange(() => requestAnimationFrame(updateThemeBtn));
  $('themeBtn').onclick = () => {
    const next = themeNow() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    updateThemeBtn();
    desk.theme.set(next);
  };
}

// ------------------------------------------------------------------ machine WiFi (header, right corner)
// Shows whether this computer is on the machine's WiFi (MKS DLC32) and joins it in one click.
const WIFI_DEFAULTS = Object.freeze({ ssid: 'MKS_DLC', password: '12345678' });
const wifi = { status: null, busy: false, step: '', error: '', assumed: '', ssid: WIFI_DEFAULTS.ssid, password: WIFI_DEFAULTS.password };
// Windows may list the network as "MKS_DLC 2"
const sameNet = (current, wanted) => !!current && !!wanted && (current === wanted || current.replace(/ \d+$/, '') === wanted);
const wifiOn = () => {
  const s = wifi.status;
  return !!(s && s.available && (sameNet(s.ssid, wifi.ssid) || (s.hidden && wifi.assumed === wifi.ssid)));
};

function renderWifi() {
  const s = wifi.status;
  let st, text, title, now, tone = '';
  if (wifi.busy) {
    st = 'busy'; text = 'Connecting…'; title = now = wifi.step || `Connecting to ${wifi.ssid}…`; tone = 'busy';
  } else if (!s) {
    st = 'check'; text = 'WiFi'; title = now = 'Checking the WiFi…';
  } else if (!s.available) {
    st = 'na'; text = 'No WiFi'; title = now = s.error || 'WiFi is not available on this computer.'; tone = 'bad';
  } else if (wifiOn()) {
    st = 'on'; text = 'Connected'; tone = 'ok';
    title = `Connected to ${wifi.ssid}, the machine's WiFi. Click for details.`;
    now = `✓ This computer is connected to “${wifi.ssid}”, the machine's WiFi.`;
  } else if (s.hidden) {
    st = 'na'; text = 'WiFi ?'; title = now = s.error || 'The system does not tell which WiFi this computer is on.';
  } else {
    st = 'off'; text = 'Not connected'; tone = 'bad';
    now = s.ssid ? `This computer is on “${s.ssid}”, not on the machine's WiFi.` : 'This computer is not connected to any WiFi.';
    title = `${now} Click to connect to ${wifi.ssid}.`;
  }
  const b = $('wifiBtn');
  b.dataset.state = st;
  b.title = title;
  b.setAttribute('aria-label', `Machine WiFi ${wifi.ssid}: ${text}`);
  $('wifiText').textContent = text;
  $('wifiNow').textContent = now;
  $('wifiNow').dataset.tone = tone;
  $('wifiConnectBtn').disabled = wifi.busy || (s && !s.available);
  $('wifiConnectBtn').textContent = wifi.busy ? 'Connecting…' : wifiOn() ? 'Connect again' : 'Connect';
  $('wifiError').hidden = !wifi.error;
  $('wifiError').textContent = wifi.error;
  renderPhone();
}
function openWifiPop(open) {
  $('wifiPop').hidden = !open;
  $('wifiBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('wifiSsid').value = wifi.ssid;
    $('wifiPass').value = wifi.password;
  }
}
function readWifiFields() {
  wifi.ssid = $('wifiSsid').value.trim() || WIFI_DEFAULTS.ssid;
  wifi.password = $('wifiPass').value;
}
async function connectWifi() {
  if (!desk || wifi.busy) return;
  if (wifi.password && (wifi.password.length < 8 || wifi.password.length > 63)) {
    wifi.error = 'A WiFi password has 8 to 63 characters.';
    openWifiPop(true);
    renderWifi();
    return;
  }
  wifi.busy = true;
  wifi.error = '';
  wifi.step = `Connecting to ${wifi.ssid}…`;
  renderWifi();
  let r;
  try { r = await desk.wifi.connect(wifi.ssid, wifi.password); }
  catch (e) { r = { ok: false, error: e.message }; }
  wifi.busy = false;
  if (r.status) wifi.status = r.status;
  if (r.ok) {
    wifi.assumed = r.status && r.status.assumed ? wifi.ssid : '';
    flash(`Connected to ${wifi.ssid}, the machine's WiFi.`);
  } else {
    wifi.error = r.error || 'Could not connect.';
    openWifiPop(true);
  }
  renderWifi();
}
$('wifiBtn').onclick = () => {
  // one click: not on the machine's WiFi -> join it; otherwise show the details
  if ($('wifiBtn').dataset.state === 'off') { wifi.error = ''; connectWifi(); return; }
  openWifiPop($('wifiPop').hidden);
};
$('wifiPopClose').onclick = () => { openWifiPop(false); $('wifiBtn').focus(); };
$('wifiConnectBtn').onclick = () => { readWifiFields(); saveStore(); connectWifi(); };
$('wifiDefaultsBtn').onclick = () => {
  $('wifiSsid').value = WIFI_DEFAULTS.ssid;
  $('wifiPass').value = WIFI_DEFAULTS.password;
  readWifiFields();
  wifi.error = '';
  saveStore();
  renderWifi();
};
for (const id of ['wifiSsid', 'wifiPass']) $(id).addEventListener('change', () => { readWifiFields(); saveStore(); renderWifi(); });
$('wifiShowPass').addEventListener('change', () => { $('wifiPass').type = $('wifiShowPass').checked ? 'text' : 'password'; });
document.addEventListener('mousedown', e => { if (!$('wifiPop').hidden && !e.target.closest('.wifi-wrap')) openWifiPop(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('wifiPop').hidden) { openWifiPop(false); $('wifiBtn').focus(); } });
if (desk && desk.wifi) {
  desk.wifi.onEvent(e => {
    if (e.type === 'status' && e.status) {
      wifi.status = e.status;
      if (!e.status.hidden) wifi.assumed = '';
    } else if (e.type === 'step') wifi.step = e.text;
    renderWifi();
  });
}

// ------------------------------------------------------------------ photo from phone (Scan text)
// A phone on the same WiFi opens a small camera page (QR code); its photos come here and are read.
const phone = { on: false, starting: false, info: null, seen: 0, device: '', recv: null, note: null, queue: [], pumping: false, told: false, wifiQr: '', wifiQrKey: '', ticker: 0 };
const qrKind = () => ((document.querySelector('input[name=phoneQrKind]:checked') || {}).value === 'wifi' ? 'wifi' : 'page');
function phoneNote(text, tone, ms = 6000) {
  phone.note = { text, tone, until: Date.now() + ms };
  renderPhone();
}
function phoneStatus() {
  const info = phone.info;
  if (!info.url) return ['bad', 'This computer has no network address yet. Connect it to the WiFi first (WiFi button at the top right).'];
  if (phone.recv) return ['busy', phone.recv.total ? `Receiving a photo… ${Math.min(100, Math.round(100 * phone.recv.received / phone.recv.total))}%` : 'Receiving a photo…'];
  if (phone.note && Date.now() < phone.note.until) return [phone.note.tone, phone.note.text];
  if (Date.now() - phone.seen < 12000) return ['ok', `${phone.device || 'Phone'} connected ✓ Tap Take photo on the phone.`];
  return ['wait', 'Waiting for the phone… Scan the code with the phone camera.'];
}
async function updateWifiQr() {
  const key = wifi.ssid + '\n' + wifi.password;
  if (phone.wifiQrKey === key || !desk) return;
  phone.wifiQrKey = key;
  const r = await desk.phone.wifiQr(wifi.ssid, wifi.password);
  phone.wifiQr = r && r.ok ? r.qr : '';
  renderPhone();
}
function phoneStep(parts) {
  // parts: strings, [bold text], or a node
  const li = el('li');
  for (const p of parts) li.append(Array.isArray(p) ? el('b', null, p[0]) : p);
  return li;
}
function renderPhone() {
  const on = !!(phone.on && phone.info && phone.info.running);
  $('phoneCard').dataset.state = on ? 'on' : 'off';
  $('phoneBtn').textContent = phone.starting ? 'Starting…' : on ? 'Stop' : 'Use phone camera';
  $('phoneBtn').classList.toggle('primary', !on);
  $('phoneBtn').disabled = phone.starting || !desk;
  $('phoneBody').hidden = !on;
  $('phoneShots').hidden = !$('phoneShots').children.length;
  if (!on) {
    $('phoneSub').textContent = phone.note && Date.now() < phone.note.until && phone.note.tone === 'bad'
      ? phone.note.text : 'Take a photo with your phone: it comes straight here and its text is read.';
    return;
  }
  const info = phone.info;
  const s = wifi.status;
  const onMachine = wifiOn();
  const net = s && s.available && s.ssid ? s.ssid : '';
  $('phoneSub').textContent = on && info.url ? 'On. Photos from the phone are read into the text box.' : 'On.';
  const kind = qrKind();
  const steps = [];
  if (kind === 'wifi') {
    updateWifiQr();   // (again only when the name or password changed)
    $('phoneQr').src = phone.wifiQr || '';
    $('phoneQr').alt = `QR code: join the WiFi ${wifi.ssid}`;
    steps.push(phoneStep(['Scan this code with the phone camera to join ', [wifi.ssid], ` (password ${wifi.password || 'none'}).`]));
    steps.push(phoneStep(['Then choose ', ['Camera page'], ' here and scan that code.']));
    if (!onMachine && s && s.available) {
      const b = el('button', 'btn small', `Connect this computer to ${wifi.ssid}`);
      b.type = 'button';
      b.disabled = wifi.busy;
      b.onclick = () => connectWifi();
      steps.push(phoneStep(['This computer must be on it too: ', b]));
    }
  } else {
    $('phoneQr').src = info.qr || '';
    $('phoneQr').alt = 'QR code: camera page for the phone';
    if (onMachine) steps.push(phoneStep(['Phone on the machine WiFi ', [wifi.ssid], ' (this computer is on it).']));
    else if (net) {
      const li = phoneStep(['Phone on the same WiFi as this computer: ', [net], '. ']);
      if (!wifi.busy) {
        const b = el('button', 'btn small', `Use ${wifi.ssid} instead`);
        b.type = 'button';
        b.onclick = () => connectWifi();
        li.append(b);
      }
      steps.push(li);
    } else steps.push(phoneStep(['Phone and this computer on the same WiFi, e.g. the machine WiFi ', [wifi.ssid], '.']));
    steps.push(phoneStep(['Scan this code with the phone camera and open the link.']));
    steps.push(phoneStep(['Tap ', ['Take photo'], '. The photo shows here and its text goes into the text box.']));
  }
  $('phoneSteps').replaceChildren(...steps);
  $('phoneUrl').textContent = info.url || '-';
  const list = info.addresses || [];
  $('phoneAddr').hidden = list.length < 2;
  if (list.length >= 2) {
    $('phoneAddr').replaceChildren(...list.map(a => new Option(`${a.ip} (${a.iface})`, a.ip, false, a.ip === info.address)));
  }
  const [tone, text] = phoneStatus();
  $('phoneStatus').dataset.tone = tone;
  $('phoneStatus').textContent = text;
  $('phoneHelp').hidden = tone === 'ok' || tone === 'busy';
}
function phoneTick() {
  clearInterval(phone.ticker);
  phone.ticker = phone.on ? setInterval(() => { if ($('ocrDialog').open) renderPhone(); }, 1000) : 0;
}
async function startPhone() {
  if (!desk || phone.starting) return;
  phone.starting = true;
  renderPhone();
  let r;
  try { r = await desk.phone.start(); } catch (e) { r = { ok: false, error: e.message }; }
  phone.starting = false;
  if (r.ok) {
    phone.on = true;
    phone.info = r.info;
    phone.note = null;
  } else {
    phone.on = false;
    phoneNote(r.error || 'The phone link could not start.', 'bad', 15000);
  }
  phoneTick();
  saveStore();
  renderPhone();
}
async function stopPhone() {
  phone.on = false;
  phone.info = null;
  phone.seen = 0;
  phone.recv = null;
  phoneTick();
  saveStore();
  renderPhone();
  if (desk) await desk.phone.stop();
}
$('phoneBtn').onclick = () => (phone.on ? stopPhone() : startPhone());
document.querySelectorAll('input[name=phoneQrKind]').forEach(r => r.addEventListener('change', () => { if (qrKind() === 'wifi') updateWifiQr(); renderPhone(); }));
$('phoneAddr').addEventListener('change', async () => {
  const r = await desk.phone.useAddress($('phoneAddr').value);
  if (r && r.ok) { phone.info = r.info; renderPhone(); }
});

// the photos: small pictures in the Scan dialog; click one to see it large
function addShot(file, n) {
  const b = el('button', 'shot');
  b.type = 'button';
  b.dataset.state = 'new';
  b.title = `Photo ${n} from the phone. Click to see it large.`;
  const img = el('img');
  img.alt = `Photo ${n} from the phone`;
  img.src = URL.createObjectURL(file);
  const badge = el('span', 'shot-badge', `#${n}`);
  b.append(img, badge);
  b.onclick = () => {
    $('photoBig').src = img.src;
    $('photoBig').alt = img.alt;
    $('photoDialog').showModal();
  };
  const box = $('phoneShots');
  box.prepend(b);
  while (box.children.length > 12) {
    const old = box.lastElementChild;
    URL.revokeObjectURL(old.querySelector('img').src);
    old.remove();
  }
  box.hidden = false;
  return b;
}
function setShot(b, st, n) {
  b.dataset.state = st;
  b.querySelector('.shot-badge').textContent = st === 'reading' ? `#${n} reading…` : st === 'done' ? `#${n} ✓` : st === 'empty' ? `#${n} no text` : `#${n}`;
}
$('photoClose').onclick = () => $('photoDialog').close();
$('photoDialog').addEventListener('click', e => { if (e.target === $('photoDialog') || e.target === $('photoBig')) $('photoDialog').close(); });

// A photo came: show it and read it. With Scan open, the first photo follows "Put the text" and the
// next ones are added after it. When the photo opens Scan itself, it is always added after the text:
// text is never replaced without the choice being on the screen.
async function pumpPhone() {
  if (phone.pumping || !phone.queue.length || ocr.busy) return;
  if (state.printing || document.querySelector('dialog[open]:not(#ocrDialog)')) {
    if (!phone.told) { flash('Photo from the phone received. It is read when you open Scan text.'); phone.told = true; }
    return;
  }
  phone.told = false;
  phone.pumping = true;
  try {
    const wasOpen = $('ocrDialog').open;
    if (!wasOpen) openOcr();
    while (phone.queue.length && !ocr.busy) {
      const items = phone.queue.splice(0);
      if (ocr.runs > 0 || !wasOpen) document.querySelector('input[name=importMode][value=append]').checked = true;
      showFiles(items.map(i => i.file));
      for (const i of items) setShot(i.shot, 'reading', i.n);
      await runExtract();
      for (const i of items) {
        const src = [...ocr.sources].reverse().find(x => x.label === i.file.name);
        setShot(i.shot, src && src.status === 'OCR' ? 'done' : 'empty', i.n);
      }
      document.querySelector('input[name=importMode][value=append]').checked = true;   // later photos add after
    }
  } finally {
    phone.pumping = false;
  }
}
if (desk && desk.phone) {
  desk.phone.onEvent(e => {
    if (e.type === 'visit') { phone.seen = Date.now(); phone.device = e.device || ''; }
    else if (e.type === 'receiving') phone.recv = e.cancelled ? null : { received: e.received || 0, total: e.total || 0 };
    else if (e.type === 'rejected') { phone.recv = null; phoneNote('Photo not taken: ' + e.error, 'bad'); }
    else if (e.type === 'info') { if (phone.on) phone.info = e.info; }
    else if (e.type === 'photo') {
      phone.recv = null;
      phone.seen = Date.now();
      const file = new File([e.bytes], e.name, { type: e.mime, lastModified: Date.now() });
      phone.queue.push({ file, n: e.n, shot: addShot(file, e.n) });
      phoneNote(`Photo ${e.n} received ✓ Reading the text…`, 'ok', 4000);
      pumpPhone();
    }
    renderPhone();
  });
}

// ------------------------------------------------------------------ footer logos
// Official GitHub / LinkedIn logo files, if the user put them in the brand folder.
if (desk && desk.brandLogos) desk.brandLogos().then(logos => {
  for (const a of document.querySelectorAll('a.social[data-brand]')) {
    const src = logos && logos[a.dataset.brand];
    if (!src) continue;
    const img = new Image();
    img.className = 'brand-logo';
    img.alt = '';
    img.onload = () => { const icon = a.querySelector('svg'); if (icon) icon.replaceWith(img); };
    img.src = src;
  }
}).catch(() => {});

// ------------------------------------------------------------------ start
$('sentence').value = typeof stored.text === 'string' ? stored.text : DEFAULT_TEXT;
writeSettings(Object.assign({}, D.DEFAULTS, stored.settings || {}));
voice.model = stored.voiceModel === 'fast' ? 'fast' : 'accurate';
if (stored.inputLang === 'bn') setLang('bn'); else syncLang();
if (stored.bnStd === 'in') document.querySelector('input[name=bnStd][value=in]').checked = true;
$('voiceModel').value = activeVoiceModel();
if (stored.baud) $('baudSelect').value = String(stored.baud);
$('forceOcr').checked = !!(stored.ocr && stored.ocr.forceOcr);
$('invertPrint').checked = stored.invert !== false;
$('paperSize').replaceChildren(...D.PAPER_SIZES.map(p => new Option(p.label, p.id)));
function restorePage(page, sheet) {
  if (page && typeof page === 'object') {
    if (D.PAPER_SIZES.some(x => x.id === page.size)) $('paperSize').value = page.size;
    const o = document.querySelector(`input[name=orientation][value=${page.orientation === 'landscape' ? 'landscape' : 'portrait'}]`);
    o.checked = true;
    for (const [id, key] of [['paperW', 'w'], ['paperH', 'h']]) {
      if (page[key] !== undefined && page[key] !== '' && Number.isFinite(Number(page[key]))) $(id).value = page[key];
    }
    const oldMm = marginMm();   // margins are saved in mm; older files have no unit
    if (page.marginUnit === 'cm' || page.marginUnit === 'mm') document.querySelector(`input[name=marginUnit][value=${page.marginUnit}]`).checked = true;
    const m = page.margin == null || page.margin === '' ? NaN : Number(page.margin);
    showMargin(Number.isFinite(m) ? m : oldMm);
    // page scaling: anything else (older files, the removed "None") gets the standard, Fit to printer margins
    const scale = SCALE_MODES.includes(page.scale) ? page.scale : 'fit';
    document.querySelector(`input[name=pageScale][value=${scale}]`).checked = true;
    if (page.scalePct != null && page.scalePct !== '' && Number.isFinite(Number(page.scalePct))) {
      $('scalePct').value = Math.min(D.SCALE_MAX, Math.max(D.SCALE_MIN, Math.round(Number(page.scalePct))));
    }
    if (typeof page.pdfPaper === 'boolean') $('pdfPaper').checked = page.pdfPaper;
    const want = !!page.on;
    if (want && !pageOn()) manualArea = manualArea || readArea();
    if (!want && pageOn() && manualArea) { for (const k of AREA_KEYS) $(k).value = manualArea[k]; manualArea = null; }
    $('pageMode').checked = want;
  }
  if (sheet && typeof sheet === 'object') {
    $('autoNext').checked = sheet.auto !== false;
    if (Number.isFinite(Number(sheet.seconds))) $('autoNextSec').value = Math.min(3600, Math.max(5, Math.round(Number(sheet.seconds))));
  }
  $('autoNextSec').disabled = !$('autoNext').checked;
  applyPage();
}
if (stored.manualArea && typeof stored.manualArea === 'object') manualArea = stored.manualArea;
restorePage(stored.page, stored.sheet);
$('showSettings').checked = stored.showSettings !== false;
$('showGcode').checked = stored.showGcode !== false;
applyShowGcode();
$('showMachine').checked = stored.showMachine !== false;
applyShowMachine();
$('showPage').checked = stored.showPage !== false;
applyShowPage();
state.sideView = stored.sideView === true;
if (stored.jogUnit === 'cm') document.querySelector('input[name=jogUnit][value=cm]').checked = true;
applyShowSettings();
$('sourceBreak').checked = !!(stored.ocr && stored.ocr.sourceBreak);
if (stored.wifi && typeof stored.wifi === 'object') {
  if (typeof stored.wifi.ssid === 'string' && stored.wifi.ssid.trim()) wifi.ssid = stored.wifi.ssid.trim().slice(0, 32);
  if (typeof stored.wifi.password === 'string') wifi.password = stored.wifi.password.slice(0, 63);
}
if (desk && desk.wifi) {
  $('wifiBtn').hidden = false;
  renderWifi();
  desk.wifi.status().then(r => { if (r && r.ok) { wifi.status = r.status; renderWifi(); } }).catch(() => {});
}
if (desk && desk.phone) {
  // the phone link stays on until it is stopped (also after a restart)
  desk.phone.info().then(r => {
    if (r && r.ok && r.info && r.info.running) { phone.on = true; phone.info = r.info; phoneTick(); renderPhone(); }
    else if (stored.phone && stored.phone.on) startPhone();
    else renderPhone();
  }).catch(() => {});
} else renderPhone();
if (!desk) {
  showMachineMsg('Open DotSense with "npm start" to use the machine, voice typing, OCR and file saving.', 'bad');
} else {
  refreshPorts();
  desk.machine.info().then(r => {
    if (r.ok && r.status && r.status.connected) {
      machine.connected = true;
      machine.info = r.info;
      $('machineVersion').textContent = 'Grbl ' + r.info.version;
      applyStatus(r.status);
    }
  });
}
rebuild(false);
