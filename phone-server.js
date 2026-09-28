'use strict';
/*
 * Photo from phone: a small web page on this computer that a phone on the same WiFi opens
 * (from a QR code). Photos taken on the phone are sent here and read with OCR.
 * Only the secret link works, only images are accepted, and nothing is stored on disk.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_BYTES = 25 * 1024 * 1024;
const PORTS = [8123, 8124, 8125, 8126, 8127, 8128, 8129];
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o, 1/l/i: easy to type from the screen
const TOKEN_RE = /^[a-z2-9]{8,32}$/;

const newToken = (n = 10) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The image formats OCR reads, by their first bytes (the phone's own name or type is not trusted).
function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return null;
}
const isHeic = buf => buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(buf.toString('latin1', 8, 12));

// ---- this computer's addresses a phone can reach (the WiFi one first)
const VIRTUAL = /vethernet|virtualbox|vmware|vbox|hyper-v|docker|^br-|^veth|virbr|^tun|^tap|^utun|^awdl|^llw|bridge|zerotier|tailscale|wsl|loopback|bluetooth|npcap|hamachi|radmin|wireguard|^wg\d|^lo\d*$/i;
const WIFI = /wi-?fi|wlan|^wl|wireless|airport|^en0$/i;
function addresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal) continue;
      if (/^(127|169\.254)\./.test(a.address)) continue;   // loopback, or no address from the network yet
      out.push({ ip: a.address, iface: name, wifi: WIFI.test(name) });
    }
  }
  return out.sort((a, b) => (b.wifi - a.wifi) || a.iface.localeCompare(b.iface));
}

function deviceName(ua) {
  ua = String(ua || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'phone';
}

// ---- QR codes (drawn here, shown as an image in the app)
function qrSvg(text) {
  const qrcode = require('qrcode-generator');
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n;) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && qr.isDark(r, e)) e++;
      d += `M${c + q} ${r + q}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const qrDataUrl = text => 'data:image/svg+xml;base64,' + Buffer.from(qrSvg(text)).toString('base64');
// "Join this WiFi" code that phone cameras understand (WIFI:T:WPA;S:name;P:password;;)
const wifiEsc = s => String(s).replace(/([\\;,:"])/g, '\\$1');
const wifiQrText = (ssid, password) => password
  ? `WIFI:T:WPA;S:${wifiEsc(ssid)};P:${wifiEsc(password)};;`
  : `WIFI:T:nopass;S:${wifiEsc(ssid)};;`;

class PhoneServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.token = TOKEN_RE.test(opts.token || '') ? opts.token : newToken();
    const first = Number(opts.port);
    this.ports = Array.isArray(opts.ports) ? opts.ports.slice()
      : Number.isInteger(first) && first > 1023 && first < 65536 ? [first, ...PORTS.filter(p => p !== first)] : PORTS.slice();
    this.pagePath = opts.pagePath || path.join(__dirname, 'phone-page.html');
    this.maxBytes = opts.maxBytes || MAX_BYTES;
    this.server = null;
    this.port = 0;
    this.count = 0;       // photos received this session
    this.uploads = 0;     // uploads in progress
    this.preferred = '';  // the address the user picked, if several
  }

  get running() { return !!(this.server && this.server.listening); }

  async start() {
    if (this.running) return this.info();
    this.page = fs.readFileSync(this.pagePath, 'utf8');
    let lastError = null;
    for (const p of [...this.ports, 0]) {
      try { await this._listen(p); return this.info(); }
      catch (e) { lastError = e; if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break; }
    }
    throw new Error('Could not open the phone link: ' + (lastError ? lastError.message : 'no free port'));
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.requestTimeout = 180000;
      server.headersTimeout = 20000;
      server.keepAliveTimeout = 5000;
      server.maxConnections = 32;
      server.once('error', reject);
      server.listen({ port, host: '0.0.0.0' }, () => {
        server.removeListener('error', reject);
        server.on('error', e => this.emit('server-error', e));
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    if (s) {
      s.close();
      if (s.closeAllConnections) s.closeAllConnections();
    }
  }

  info() {
    const list = addresses();
    const chosen = list.find(a => a.ip === this.preferred) || list[0] || null;
    const running = this.running;
    return {
      running, port: this.port, token: this.token, addresses: list,
      address: chosen ? chosen.ip : '', iface: chosen ? chosen.iface : '',
      url: running && chosen ? `http://${chosen.ip}:${this.port}/${this.token}` : ''
    };
  }

  _headers(extra) {
    return Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }, extra);
  }
  _json(res, code, body, close) {
    const text = JSON.stringify(body);
    res.writeHead(code, this._headers(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) }, close ? { Connection: 'close' } : {})));
    res.end(text);
  }
  _text(res, code, text) {
    res.writeHead(code, this._headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(text);
  }

  _handle(req, res) {
    const pathname = String(req.url || '/').split(/[?#]/)[0];
    if (pathname === '/favicon.ico') { res.writeHead(204, this._headers()); return res.end(); }
    const parts = pathname.split('/').filter(Boolean);
    if (!parts.length || parts.length > 2 || !sameToken(parts[0], this.token)) {
      req.resume();
      return this._text(res, 404, 'Not found. Scan the QR code in DotSense (Scan text > Photo from phone) again.');
    }
    const route = parts[1] || '';
    if (route === '' && (req.method === 'GET' || req.method === 'HEAD')) {
      this.emit('visit', { device: deviceName(req.headers['user-agent']) });
      const nonce = crypto.randomBytes(16).toString('base64');
      const html = this.page.replace(/__NONCE__/g, nonce);
      res.writeHead(200, this._headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      }));
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (route === 'ping' && req.method === 'GET') {
      this.emit('visit', { device: deviceName(req.headers['user-agent']) });
      return this._json(res, 200, { ok: true, app: 'DotSense' });
    }
    if (route === 'photo' && req.method === 'POST') return this._upload(req, res);
    req.resume();
    return this._text(res, route === 'photo' || route === 'ping' || route === '' ? 405 : 404, 'Not found.');
  }

  _upload(req, res) {
    const total = Number(req.headers['content-length']) || 0;
    const refuse = (code, error) => {
      this.emit('rejected', { error });
      res.on('finish', () => req.destroy());
      this._json(res, code, { ok: false, error }, true);
    };
    const tooBig = `The photo is larger than ${Math.round(this.maxBytes / 1048576)} MB.`;
    if (total > this.maxBytes) return refuse(413, tooBig);
    if (this.uploads >= 2) return refuse(503, 'The computer is busy with other photos. Try again in a moment.');
    this.uploads++;
    this.emit('receiving', { received: 0, total });
    const chunks = [];
    let size = 0, done = false, last = 0;
    const finish = () => { if (!done) { done = true; this.uploads--; } };
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > this.maxBytes) { finish(); chunks.length = 0; return refuse(413, tooBig); }
      chunks.push(c);
      const now = Date.now();
      if (now - last > 200) { last = now; this.emit('receiving', { received: size, total }); }
    });
    req.on('end', () => {
      if (done) return;
      finish();
      const buf = Buffer.concat(chunks, size);
      const kind = imageType(buf);
      if (!kind) {
        return refuse(415, isHeic(buf)
          ? 'HEIC photos cannot be read. On the iPhone choose Settings > Camera > Formats > Most Compatible.'
          : 'This is not a photo DotSense can read (JPEG, PNG, WebP or BMP).');
      }
      const n = ++this.count;
      this.emit('photo', { n, name: `phone-photo-${n}.${kind.ext}`, mime: kind.mime, bytes: buf });
      this._json(res, 200, { ok: true, n });
    });
    req.on('error', () => {});
    req.on('close', () => { if (!done) { finish(); this.emit('receiving', { cancelled: true }); } });
  }
}

module.exports = { PhoneServer, addresses, imageType, isHeic, deviceName, qrSvg, qrDataUrl, wifiQrText, newToken, TOKEN_RE, MAX_BYTES, PORTS };
