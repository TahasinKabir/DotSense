'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, clipboard, nativeTheme, systemPreferences, utilityProcess, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { GrblLink } = require('./grbl');

let win = null;
let quitting = false;
const machine = new GrblLink();
let port = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// Footer links open in the normal web browser; nothing else may leave the app.
const EXTERNAL_LINKS = new Set(['https://github.com/TahasinKabir', 'https://www.linkedin.com/in/tahasin-kabir']);
function openExternalLink(url) {
  const clean = String(url || '').replace(/\/+$/, '');
  if (EXTERNAL_LINKS.has(clean)) shell.openExternal(clean);
}

// ---------------------------------------------------------------- theme
// Dark (the original look) or Light. The choice is kept in the user data folder and applied
// before any window opens; Electron's native theme drives prefers-color-scheme in every window.
const THEME_BG = { dark: '#14181c', light: '#f3f5f9' };
const themeFile = () => path.join(app.getPath('userData'), 'theme.json');
const themeNow = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
const themeBg = () => THEME_BG[themeNow()];
function broadcastTheme() {
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(themeBg());
    if (!w.webContents.isDestroyed()) w.webContents.send('theme:changed', themeNow());
  }
}
// with no saved choice the app follows the system, also when it changes
nativeTheme.on('updated', () => { if (nativeTheme.themeSource === 'system') broadcastTheme(); });
function loadTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(themeFile(), 'utf8')).theme;
    if (t === 'dark' || t === 'light') nativeTheme.themeSource = t;
  } catch (_) { /* first start: follow the system */ }
}
ipcMain.handle('theme:set', (_event, theme) => {
  if (theme !== 'dark' && theme !== 'light') return { ok: false };
  nativeTheme.themeSource = theme;   // also the window frame and native controls
  try { fs.writeFileSync(themeFile(), JSON.stringify({ theme })); } catch (_) { /* not saved: still applied */ }
  broadcastTheme();
  return { ok: true, theme };
});

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 780,
    minHeight: 580,
    title: 'DotSense',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: themeBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'), { query: { theme: themeNow() } });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalLink(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternalLink(url); });
  win.on('closed', () => {
    if (invertWin && !invertWin.isDestroyed()) invertWin.close();
  });
  win.on('close', async e => {
    if (quitting || !machine.job) return;
    e.preventDefault();
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Keep printing', 'Stop machine and quit'], defaultId: 0, cancelId: 0,
      message: 'A print is running.',
      detail: 'Quitting stops the machine safely first (feed hold, reset, lift punch).'
    });
    if (r.response !== 1) return;
    quitting = true;
    try { await machine.stopJob(); } catch (_) { /* closing anyway */ }
    await closePort();
    win.close();
  });
}

// ---------------------------------------------------------------- invert view window
let invertWin = null;

function openInvertWindow() {
  if (invertWin && !invertWin.isDestroyed()) {
    if (invertWin.isMinimized()) invertWin.restore();
    invertWin.show();
    invertWin.focus();
    return;
  }
  invertWin = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 560,
    minHeight: 360,
    title: 'DotSense - Invert view',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: themeBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  invertWin.setMenuBarVisibility(false);
  invertWin.loadFile(path.join(__dirname, 'invert.html'), { query: { theme: themeNow() } });
  invertWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  invertWin.webContents.on('will-navigate', e => e.preventDefault());
  invertWin.on('closed', () => {
    invertWin = null;
    send('invert:event', { type: 'closed' });
  });
  send('invert:event', { type: 'opened' });
}

const fromMain = event => win && !win.isDestroyed() && event.sender === win.webContents;
const fromInvert = event => invertWin && !invertWin.isDestroyed() && event.sender === invertWin.webContents;

ipcMain.handle('invert:open', event => { if (fromMain(event)) openInvertWindow(); return { ok: true }; });
ipcMain.on('invert:update', (event, data) => {
  if (fromMain(event) && invertWin && !invertWin.isDestroyed()) invertWin.webContents.send('invert:data', data);
});
ipcMain.on('invert:ready', event => { if (fromInvert(event)) send('invert:event', { type: 'request' }); });
ipcMain.on('invert:goto', (event, page) => { if (fromInvert(event) && Number.isInteger(page)) send('invert:event', { type: 'goto', page }); });
ipcMain.on('invert:set', (event, on) => { if (fromInvert(event)) send('invert:event', { type: 'set', on: !!on }); });

app.whenReady().then(() => {
  const ses = session.defaultSession;
  // Microphone only (voice typing). Everything else is refused.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      return callback(types.length > 0 && types.every(t => t === 'audio'));
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission === 'media') return !details || !details.mediaType || details.mediaType === 'audio';
    return false;
  });
  loadTheme();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', async () => {
  stopPhone();
  clearTimeout(wifiTimer);
  await closePort();
  if (voiceProc) { try { voiceProc.kill(); } catch (_) { /* gone */ } }
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch (_) { /* gone */ } }
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- files
function safeName(name, ext) {
  const base = String(name || 'dotsense').replace(/[^a-z0-9_\-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'dotsense';
  return base + '.' + ext;
}

ipcMain.handle('file:save', async (event, { kind, name, content, pages }) => {
  try {
    const ext = kind === 'zip' ? 'zip' : kind === 'project' ? 'json' : 'gcode';
    const filters = kind === 'gcode'
      ? [{ name: 'G-code', extensions: ['gcode', 'nc', 'txt'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: ext.toUpperCase(), extensions: [ext] }];
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: kind === 'project' ? 'Save DotSense project' : 'Save G-code', defaultPath: safeName(name, ext), filters
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    let data = content;
    if (kind === 'zip') {
      if (!Array.isArray(pages) || !pages.length || pages.length > 10000) throw new Error('Invalid pages.');
      const zip = new (require('jszip'))();
      pages.forEach(p => zip.file(String(p.name).replace(/[\\/]/g, '_'), String(p.content)));
      zip.file('PRINTING.txt', 'DotSense braille pages. Each .gcode file is one sheet.\r\nUse the same work zero (X0 Y0 Z0) for every sheet. Replace and clamp the paper before running the next file.\r\nNo homing or automatic paper feed is performed.\r\n');
      data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    } else if (typeof data !== 'string') throw new Error('Nothing to save.');
    await fsp.writeFile(r.filePath, data);
    return { ok: true, filePath: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('file:open-project', async event => {
  try {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Open DotSense project', properties: ['openFile'],
      filters: [{ name: 'DotSense / Braille project', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    if ((await fsp.stat(r.filePaths[0])).size > 10 * 1024 * 1024) throw new Error('Project file is larger than 10 MB.');
    return { ok: true, project: JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')), filePath: r.filePaths[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clipboard:write', (event, text) => { clipboard.writeText(String(text)); return true; });

// Optional official logo files for the footer links, added by the user to the brand folder.
ipcMain.handle('app:brand-logos', () => {
  const out = {};
  for (const name of ['github', 'linkedin']) {
    const ext = ['svg', 'png'].find(e => fs.existsSync(path.join(__dirname, 'brand', name + '.' + e)));
    out[name] = ext ? 'brand/' + name + '.' + ext : null;
  }
  return out;
});

// ---------------------------------------------------------------- OCR (images and scanned PDF pages)
// English, or Bangla (which also reads English words). The language data comes with the app;
// tesseract.js reads all languages from one folder, so the files are copied together once.
let ocrWorker = null;
let ocrWorkerLangs = '';
let ocrBusy = false;

function langData(lang) {
  try { return path.join(path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int', `${lang}.traineddata.gz`); }
  catch (_) { return null; }
}
async function localLangPath(langs) {
  const dir = path.join(app.getPath('userData'), 'ocr-lang');
  await fsp.mkdir(dir, { recursive: true });
  for (const lang of langs) {
    const src = langData(lang);
    if (!src || !fs.existsSync(src)) return null;
    const dst = path.join(dir, `${lang}.traineddata.gz`);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) await fsp.copyFile(src, dst);
  }
  return dir;
}

ipcMain.handle('ocr:recognize', async (event, arg) => {
  if (ocrBusy) return { ok: false, error: 'OCR is already running.' };
  ocrBusy = true;
  try {
    const bytes = arg && arg.bytes ? arg.bytes : arg;
    const langs = arg && arg.lang === 'bn' ? 'ben+eng' : 'eng';
    if (!bytes || !bytes.byteLength || bytes.byteLength > 40 * 1024 * 1024) throw new Error('Image is empty or larger than 40 MB.');
    if (ocrWorker && ocrWorkerLangs !== langs) { await ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
    if (!ocrWorker) {
      const cachePath = path.join(app.getPath('userData'), 'ocr-cache');
      await fsp.mkdir(cachePath, { recursive: true });
      const opts = {
        cachePath,
        logger: m => { if (!event.sender.isDestroyed()) event.sender.send('ocr:progress', { status: m.status, progress: m.progress || 0 }); }
      };
      const langPath = await localLangPath(langs.split('+'));
      if (langPath) { opts.langPath = langPath; opts.gzip = true; }
      ocrWorker = await require('tesseract.js').createWorker(langs, 1, opts);
      ocrWorkerLangs = langs;
    }
    const { data } = await ocrWorker.recognize(Buffer.from(bytes));
    return { ok: true, text: data.text, confidence: data.confidence };
  } catch (e) {
    if (ocrWorker) await ocrWorker.terminate().catch(() => {});
    ocrWorker = null;
    return { ok: false, error: e.message };
  } finally {
    ocrBusy = false;
  }
});

// ---------------------------------------------------------------- machine (GRBL over USB serial)
let logBatch = [];
let logTimer = null;
machine.on('log', entry => {
  logBatch.push(entry);
  if (logBatch.length > 400) logBatch = logBatch.slice(-400);
  if (!logTimer) logTimer = setTimeout(() => { send('machine:event', { type: 'log', entries: logBatch }); logBatch = []; logTimer = null; }, 200);
});
machine.on('status', status => send('machine:event', { type: 'status', status }));
machine.on('progress', progress => send('machine:event', { type: 'progress', progress }));
machine.on('job', job => send('machine:event', { type: 'job', job }));
machine.on('connection', connection => send('machine:event', { type: 'connection', connection }));
machine.on('alarm', alarm => send('machine:event', { type: 'alarm', alarm }));
machine.on('message', message => send('machine:event', { type: 'message', message }));

const LIKELY = /^(1a86|0403|2341|10c4|2a03|1eaf|0483|067b)$/i;

async function listSerialPorts() {
  let ports = [];
  try {
    ports = await require('serialport').SerialPort.list();
  } catch (e) {
    // Fallback when the OS port list is unavailable (e.g. Linux without udevadm).
    if (process.platform !== 'win32') {
      try {
        const names = await fsp.readdir('/dev');
        ports = names.filter(n => /^(ttyUSB|ttyACM|tty\.usb|cu\.usb|cu\.wch|tty\.wch|cu\.SLAB)/.test(n)).map(n => ({ path: '/dev/' + n }));
      } catch (_) { ports = []; }
    }
  }
  const out = ports.map(p => {
    let portPath = p.path;
    if (process.platform === 'darwin') portPath = portPath.replace(/^\/dev\/tty\./, '/dev/cu.');
    const name = (p.friendlyName || p.manufacturer || '').replace(/\s*\((COM\d+)\)\s*$/i, '');
    const likely = LIKELY.test(p.vendorId || '') || /ch34|usb|arduino|ftdi|cp210|wch|serial/i.test(name + ' ' + portPath);
    return { path: portPath, label: portPath + (name ? ' - ' + name : ''), likely };
  });
  const extra = String(process.env.DOTSENSE_EXTRA_PORTS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const p of extra) out.push({ path: p, label: p, likely: true });
  if (process.env.DOTSENSE_SIMULATOR === '1') out.unshift({ path: 'SIMULATOR', label: 'Simulator (no machine)', likely: true });
  const seen = new Set();
  return out.filter(p => !seen.has(p.path) && seen.add(p.path)).sort((a, b) => (b.likely - a.likely) || a.path.localeCompare(b.path));
}

function friendlyPortError(e, portPath) {
  const m = String((e && e.message) || e);
  if (/access denied|busy|locked/i.test(m)) return portPath + ' is busy. Close other CNC programs (Candle, UGS, Arduino IDE) and try again.';
  if (/permission denied/i.test(m)) return 'No permission for ' + portPath + '. On Linux run: sudo usermod -a -G dialout $USER, then log out and in.';
  if (/no such file|not found|cannot open/i.test(m)) return portPath + ' not found. Re-plug the USB cable and press Refresh.';
  return m;
}

async function closePort() {
  if (machine.transport || machine.connected) await machine.close();
  port = null;
}

ipcMain.handle('machine:list', async () => {
  try { return { ok: true, ports: await listSerialPorts() }; }
  catch (e) { return { ok: false, error: e.message, ports: [] }; }
});

ipcMain.handle('machine:connect', async (event, { path: portPath, baud }) => {
  try {
    if (machine.connected) await closePort();
    const baudRate = Number(baud) || 115200;
    if (portPath === 'SIMULATOR' && process.env.DOTSENSE_SIMULATOR === '1') {
      const { FakeGrbl } = require('./fake-grbl');
      port = new FakeGrbl({ timeScale: Number(process.env.DOTSENSE_SIMULATOR_SPEED) || 1, homing: process.env.DOTSENSE_SIM_HOMING === '1' });
    } else {
      const { SerialPort } = require('serialport');
      port = new SerialPort({ path: String(portPath), baudRate, autoOpen: false });
      await new Promise((resolve, reject) => port.open(err => (err ? reject(err) : resolve())));
      port.on('error', err => machine.emit('log', { dir: 'err', text: err.message }));
    }
    const info = await machine.open(port);
    return { ok: true, info, status: machine.status() };
  } catch (e) {
    const message = friendlyPortError(e, portPath);
    const p = port;
    await closePort().catch(() => {});
    if (p && p.isOpen) p.close(() => {});
    return { ok: false, error: message };
  }
});

ipcMain.handle('machine:disconnect', async () => { await closePort(); return { ok: true }; });

const wrap = fn => async (event, arg) => {
  try { const r = await fn(arg); return Object.assign({ ok: true }, r || {}); }
  catch (e) { return { ok: false, error: e.message }; }
};

ipcMain.handle('machine:info', wrap(() => ({ info: machine.info(), status: machine.status(), job: machine.progress() })));
ipcMain.handle('machine:command', wrap(async text => { await machine.command(text, { timeout: 30000 }); }));
ipcMain.handle('machine:unlock', wrap(() => machine.unlock()));
ipcMain.handle('machine:home', wrap(() => machine.command('$H', { timeout: 120000 })));
ipcMain.handle('machine:reset', wrap(() => machine.softReset()));
ipcMain.handle('machine:check-mode', wrap(async () => ({ check: await machine.toggleCheckMode() })));
ipcMain.handle('machine:zero', wrap(axes => {
  const words = String(axes || '').toUpperCase().split('').filter(a => 'XYZ'.includes(a)).map(a => a + '0');
  if (!words.length) throw new Error('Choose an axis.');
  return machine.command('G10 L20 P1 ' + words.join(' '), { timeout: 5000 });
}));
ipcMain.handle('machine:jog', wrap(({ axis, dist, feed }) => machine.jog(axis, Number(dist), Number(feed))));
ipcMain.handle('machine:jog-cancel', wrap(() => machine.realtime('jogCancel')));
ipcMain.handle('machine:goto', wrap(({ x, y, clearZ }) => {
  const f = n => String(Math.round(Number(n) * 1000) / 1000);
  if (![x, y, clearZ].every(Number.isFinite)) throw new Error('Invalid position.');
  return machine.command('G21 G90 G0 Z' + f(clearZ)).then(() => machine.command('G0 X' + f(x) + ' Y' + f(y)));
}));
ipcMain.handle('machine:start', wrap(job => ({ progress: machine.startJob(job) })));
ipcMain.handle('machine:pause', wrap(() => ({ changed: machine.pauseJob() })));
ipcMain.handle('machine:resume', wrap(() => ({ changed: machine.resumeJob() })));
ipcMain.handle('machine:stop', wrap(() => machine.stopJob()));

// ---------------------------------------------------------------- voice typing (offline)
let voiceProc = null;
const voiceDir = () => path.join(app.getPath('userData'), 'voice-models');

function ensureVoiceProc() {
  if (voiceProc) return voiceProc;
  voiceProc = utilityProcess.fork(path.join(__dirname, 'voice-worker.js'), [], { serviceName: 'DotSense Voice' });
  voiceProc.on('message', m => send('voice:event', m));
  voiceProc.on('exit', code => {
    voiceProc = null;
    send('voice:event', { type: 'exit', code });
  });
  voiceProc.postMessage({ type: 'config', modelsDir: voiceDir() });
  return voiceProc;
}

ipcMain.handle('voice:models', () => require('./voice-models').installed(voiceDir()));

ipcMain.handle('voice:start', async (event, { model }) => {
  if (!require('./voice-models').MODELS[model]) return { ok: false, error: 'Unknown voice model.' };
  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (!granted) return { ok: false, error: 'Microphone access is off. Allow DotSense (or Electron) in System Settings > Privacy & Security > Microphone.' };
    } catch (_) { /* older macOS */ }
  }
  ensureVoiceProc().postMessage({ type: 'init', model });
  return { ok: true };
});

ipcMain.on('voice:audio', (event, samples) => {
  if (voiceProc && samples && samples.length) voiceProc.postMessage({ type: 'audio', samples });
});
ipcMain.handle('voice:stop', () => { if (voiceProc) voiceProc.postMessage({ type: 'flush' }); return { ok: true }; });
ipcMain.handle('voice:cancel', () => { if (voiceProc) voiceProc.postMessage({ type: 'cancel' }); return { ok: true }; });

// ---------------------------------------------------------------- machine WiFi (MKS DLC32) + photo from phone
// The header button shows whether this computer is on the machine's WiFi and joins it in one click.
// "Photo from phone" is a small web page for a phone on the same WiFi; its photos come here for OCR.
const wifi = require('./wifi');
let wifiNow = null;
let wifiBusy = false;
let wifiTimer = null;

async function pollWifi() {
  wifiTimer = null;
  if (!win || win.isDestroyed()) return;
  if (!wifiBusy && !win.isMinimized()) {
    try {
      const s = await wifi.status();
      if (JSON.stringify(s) !== JSON.stringify(wifiNow)) {
        wifiNow = s;
        send('wifi:event', { type: 'status', status: s });
        pushPhone();
      }
    } catch (_) { /* try again next time */ }
  }
  wifiTimer = setTimeout(pollWifi, wifiNow && wifiNow.slow ? 15000 : 5000);
}

ipcMain.handle('wifi:status', async event => {
  if (!fromMain(event)) return { ok: false };
  try { wifiNow = await wifi.status(); }
  catch (e) { wifiNow = { available: false, ssid: '', error: e.message }; }
  if (!wifiTimer) wifiTimer = setTimeout(pollWifi, 5000);
  return { ok: true, status: wifiNow };
});

ipcMain.handle('wifi:connect', async (event, arg) => {
  if (!fromMain(event)) return { ok: false };
  if (wifiBusy) return { ok: false, error: 'Already connecting.' };
  wifiBusy = true;
  try {
    const s = await wifi.connect(arg && arg.ssid, arg && arg.password, text => send('wifi:event', { type: 'step', text }));
    wifiNow = s;
    send('wifi:event', { type: 'status', status: s });
    pushPhone();
    return { ok: true, status: s };
  } catch (e) {
    let s = null;
    try { s = await wifi.status(); wifiNow = s; } catch (_) { /* unknown */ }
    return { ok: false, error: e.message, status: s };
  } finally {
    wifiBusy = false;
  }
});

let phone = null;
let phoneTimer = null;
let phoneKey = '';
const phoneFile = () => path.join(app.getPath('userData'), 'phone.json');

function phoneServer() {
  if (phone) return phone;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(phoneFile(), 'utf8')) || {}; } catch (_) { /* first time */ }
  const { PhoneServer } = require('./phone-server');
  phone = new PhoneServer({ token: saved.token, port: saved.port });
  phone.on('visit', v => send('phone:event', { type: 'visit', device: v.device }));
  phone.on('receiving', r => send('phone:event', Object.assign({ type: 'receiving' }, r)));
  phone.on('rejected', r => send('phone:event', { type: 'rejected', error: r.error }));
  phone.on('photo', p => send('phone:event', { type: 'photo', n: p.n, name: p.name, mime: p.mime, bytes: p.bytes }));
  return phone;
}
function phoneInfo() {
  if (!phone) return { running: false, addresses: [], url: '' };
  const info = phone.info();
  info.qr = info.url ? require('./phone-server').qrDataUrl(info.url) : '';
  return info;
}
// the address changes when the computer changes WiFi: the link and QR code follow it
function pushPhone(force) {
  if (!phone || !phone.running) return;
  const info = phone.info();
  const key = info.url + '|' + info.addresses.map(a => a.ip + '@' + a.iface).join(',');
  if (!force && key === phoneKey) return;
  phoneKey = key;
  send('phone:event', { type: 'info', info: phoneInfo() });
}
function stopPhone() {
  if (phone) phone.stop();
  clearInterval(phoneTimer);
  phoneTimer = null;
  phoneKey = '';
}

ipcMain.handle('phone:start', async event => {
  if (!fromMain(event)) return { ok: false };
  try {
    const s = phoneServer();
    await s.start();
    try { fs.writeFileSync(phoneFile(), JSON.stringify({ token: s.token, port: s.port })); } catch (_) { /* a new link next time */ }
    if (!phoneTimer) phoneTimer = setInterval(() => pushPhone(), 3000);
    const info = phoneInfo();
    phoneKey = info.url + '|' + info.addresses.map(a => a.ip + '@' + a.iface).join(',');
    return { ok: true, info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('phone:stop', event => { if (fromMain(event)) stopPhone(); return { ok: true, info: phoneInfo() }; });
ipcMain.handle('phone:info', () => ({ ok: true, info: phoneInfo() }));
ipcMain.handle('phone:address', (event, ip) => {
  if (!fromMain(event) || !phone) return { ok: false };
  phone.preferred = String(ip || '');
  phoneKey = '';
  return { ok: true, info: phoneInfo() };
});
ipcMain.handle('phone:wifi-qr', (event, arg) => {
  const { qrDataUrl, wifiQrText } = require('./phone-server');
  const ssid = String((arg && arg.ssid) || '').slice(0, 32);
  if (!ssid) return { ok: false };
  return { ok: true, qr: qrDataUrl(wifiQrText(ssid, String((arg && arg.password) || '').slice(0, 63))) };
});
