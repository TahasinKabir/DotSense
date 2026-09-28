'use strict';
/*
 * DotSense machine link for GRBL controllers (3018 CNC and similar).
 *  - character-counting streaming: keeps GRBL's serial buffer full without overflowing it
 *  - status polling ('?') for GRBL 1.1 and 0.9 reports
 *  - live progress: which dot is being punched, % done, time left
 *  - pause (feed hold), resume, and safe stop (hold -> soft reset -> raise Z)
 */
const { EventEmitter } = require('events');

const GRBL_ERRORS = {
  1: 'Expected a command letter.', 2: 'Bad number format.', 3: "Unknown '$' command.", 4: 'Negative value.',
  5: 'Homing is not enabled.', 8: "'$' command only works when Idle.", 9: 'G-code locked (alarm or jog). Unlock first.',
  10: 'Soft limits need homing.', 11: 'Line too long.', 13: 'Safety door open.', 15: 'Jog would exceed machine travel.',
  16: 'Invalid jog command.', 20: 'Unsupported G-code command.', 21: 'Modal group conflict.', 22: 'Feed rate not set.',
  23: 'Command needs an integer.', 24: 'Two G-codes need axis words.', 25: 'Repeated word in line.', 26: 'No axis words.',
  27: 'Invalid line number.', 28: 'Missing value.', 33: 'Invalid target.', 36: 'Unused words in line.'
};
const GRBL_ALARMS = {
  1: 'Hard limit switch hit. Position lost - check the machine and set zero again.',
  2: 'Soft limit: the move is outside machine travel. Check start position and print area.',
  3: 'Reset while moving. Position may be lost - set zero again.',
  4: 'Probe fail.', 5: 'Probe fail.', 6: 'Homing failed (reset during homing).', 7: 'Homing failed (door opened).',
  8: 'Homing failed (could not clear limit switch).', 9: 'Homing failed (limit switch not found).', 10: 'Homing failed.'
};

const fmt = n => String(Math.round(n * 1000) / 1000);
const describeError = code => GRBL_ERRORS[code] || (/^\d+$/.test(String(code)) ? 'GRBL error ' + code + '.' : String(code));
const describeAlarm = code => GRBL_ALARMS[code] || 'Alarm ' + code + '.';

function parseStatus(line) {
  const body = line.replace(/^</, '').replace(/>$/, '');
  const out = { state: '', mpos: null, wpos: null, wco: null, feed: null, ln: null, bf: null, pins: '' };
  if (body.includes('|')) {
    const parts = body.split('|');
    out.state = parts[0];
    for (const p of parts.slice(1)) {
      const i = p.indexOf(':');
      if (i < 0) continue;
      const key = p.slice(0, i), val = p.slice(i + 1), nums = val.split(',').map(Number);
      if (key === 'MPos') out.mpos = nums.slice(0, 3);
      else if (key === 'WPos') out.wpos = nums.slice(0, 3);
      else if (key === 'WCO') out.wco = nums.slice(0, 3);
      else if (key === 'FS' || key === 'F') out.feed = nums[0];
      else if (key === 'Ln') out.ln = nums[0];
      else if (key === 'Bf') out.bf = nums;
      else if (key === 'Pn') out.pins = val;
    }
  } else {
    // Grbl 0.9: <Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>
    const m = /^([A-Za-z]+)/.exec(body);
    out.state = m ? m[1] : '';
    const grab = key => {
      const r = new RegExp(key + ':(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+)').exec(body);
      return r ? r.slice(1, 4).map(Number) : null;
    };
    out.mpos = grab('MPos');
    out.wpos = grab('WPos');
    const ln = /Ln:(\d+)/.exec(body);
    if (ln) out.ln = Number(ln[1]);
  }
  return out;
}

class GrblLink extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bufferSize = options.bufferSize || 127;   // GRBL serial RX buffer is 128 bytes
    this.pollMs = options.pollMs || 200;
    this.bannerTimeout = options.bannerTimeout || 2500;
    this.plannerGuess = 16;                         // lines GRBL may hold ahead of the tool
    this.jobSeq = 0;
    this.transport = null;
    this.pollTimer = null;
    this.waiters = [];
    this.reset();
  }

  reset() {
    this.stopPolling();
    this.connected = false;
    this.version = '';
    this.bannerSeen = false;
    this.alarmPending = false;   // critical alarm: GRBL ignores everything until a soft reset
    this.state = 'Disconnected';
    this.wpos = [0, 0, 0]; this.mpos = [0, 0, 0]; this.wco = [0, 0, 0];
    this.feedRate = 0; this.ln = null; this.statusSeq = 0; this.lastStatusAt = 0;
    this.settings = {};
    this.rxText = '';
    this.inflight = []; this.inflightBytes = 0;
    this.queue = [];
    this.job = null;
  }

  // ---------- connection ----------
  async open(transport) {
    if (this.transport) throw new Error('Already connected.');
    this.reset();
    this.transport = transport;
    this.state = 'Connecting';
    this._onData = d => this.receive(d);
    this._onClose = () => this.onClose();
    transport.on('data', this._onData);
    transport.on('close', this._onClose);
    // Arduino-based boards reset when the port opens and print "Grbl 1.1x ['$' for help]".
    if (!(await this.waitFor(() => this.bannerSeen, this.bannerTimeout))) {
      this.writeRaw('\x18');
      if (!(await this.waitFor(() => this.bannerSeen, this.bannerTimeout))) {
        throw new Error('No reply from GRBL. Check the port and baud rate (usually 115200), and close other CNC programs such as Candle or UGS.');
      }
    }
    this.connected = true;
    this.lastStatusAt = Date.now();
    this.startPolling();
    this.writeRaw('?');
    try { await this.command('$$', { timeout: 3000 }); } catch (_) { /* some firmwares refuse $$ while in alarm */ }
    this.emit('connection', this.info());
    return this.info();
  }

  async close() {
    const t = this.transport;
    this.stopPolling();
    if (t) {
      await new Promise(resolve => {
        try { t.close(() => resolve()); } catch (_) { resolve(); }
        setTimeout(resolve, 1500);
      });
    }
    this.onClose();
  }

  onClose() {
    if (!this.transport && !this.connected) return;
    const t = this.transport;
    this.transport = null;
    if (t && this._onData) { t.removeListener('data', this._onData); t.removeListener('close', this._onClose); }
    this.stopPolling();
    if (this.job) this.finishJob('disconnected', { message: 'USB connection lost. Check the machine before printing again.' });
    this.dropInflight('Disconnected');
    this.connected = false;
    this.state = 'Disconnected';
    this.emit('connection', { connected: false });
    this.emit('status', this.status());
  }

  info() {
    const s = this.settings;
    return {
      connected: this.connected, version: this.version, homing: s[22] === 1,
      rates: {
        rateXY: Math.min(s[110] || 1000, s[111] || 1000), rateZ: s[112] || 500,
        accelXY: Math.min(s[120] || 50, s[121] || 50), accelZ: s[122] || 50
      },
      travel: s[130] ? [s[130], s[131], s[132]] : null
    };
  }

  status() {
    return { state: this.state, wpos: this.wpos, mpos: this.mpos, feed: this.feedRate, ln: this.ln, version: this.version, connected: this.connected };
  }

  // ---------- receiving ----------
  receive(data) {
    this.rxText += typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
    let i;
    while ((i = this.rxText.indexOf('\n')) >= 0) {
      const line = this.rxText.slice(0, i).trim();
      this.rxText = this.rxText.slice(i + 1);
      if (line) this.handleLine(line);
    }
    if (this.rxText.length > 4096) this.rxText = '';
  }

  handleLine(line) {
    if (line[0] === '<' && line.endsWith('>')) { this.onStatus(parseStatus(line)); this.checkWaiters(); return; }
    this.emit('log', { dir: 'in', text: line });
    let m;
    if (line === 'ok') this.onAck(null);
    else if ((m = /^error:\s*(.*)$/i.exec(line))) this.onAck(m[1] || '?');
    else if ((m = /^ALARM:\s*(.*)$/i.exec(line))) this.onAlarm(m[1]);
    else if ((m = /^Grbl(?:HAL)?\s+v?([\w.]+)/i.exec(line))) this.onBanner(m[1]);
    else if ((m = /^\$(\d+)\s*=\s*(-?[\d.]+)/.exec(line))) this.settings[m[1]] = Number(m[2]);
    else if (/^\[MSG:/i.test(line)) this.emit('message', line.replace(/^\[MSG:\s*|\]$/gi, ''));
    this.checkWaiters();
  }

  onAck(err) {
    const item = this.inflight.shift();
    if (!item) return;
    this.inflightBytes -= item.len;
    if (item.kind === 'job') this.onJobAck(item, err);
    else if (item.done) item.done(err);
    this.pump();
  }

  onJobAck(item, err) {
    const j = this.job;
    if (!j || item.jobId !== j.id) return;
    j.acked++;
    if (err != null) {
      const message = describeError(err);
      j.errors.push({ line: item.text, code: String(err), message });
      if (j.state === 'running' || j.state === 'paused') {
        this.writeRaw('!');                  // hold so the user can decide
        if (!j.pausedAt) j.pausedAt = Date.now();
        j.state = 'error';
        this.emit('job', Object.assign({ type: 'error', line: item.text, code: String(err), message }, this.progress()));
      }
    } else if (item.phase === 'dwell' && item.dot > j.syncDot) {
      j.syncDot = item.dot;                  // G4 waits for all motion, so its ok means the dot is punched
    }
    if (j.acked === j.lines.length) j.allAcked = true;
    this.updateProgress();
  }

  onAlarm(code) {
    this.state = 'Alarm';
    this.alarmPending = true;
    const message = describeAlarm(code);
    this.dropInflight('Machine alarm');     // GRBL discards its buffers on alarm
    if (this.job && this.job.state !== 'stopping') this.finishJob('alarm', { code: String(code), message });
    this.emit('alarm', { code: String(code), message });
    this.emit('status', this.status());
  }

  onBanner(version) {
    this.version = version;
    this.bannerSeen = true;
    this.alarmPending = false;
    this.ln = null;
    this.dropInflight('Machine reset');     // GRBL just reset: its buffers are empty
    if (this.job && this.job.state !== 'stopping') this.finishJob('reset', { message: 'The machine reset during printing. Check it before printing again.' });
    this.emit('banner', version);
  }

  onStatus(st) {
    this.statusSeq++;
    this.lastStatusAt = Date.now();
    if (st.state) this.state = st.state;
    if (st.wco) this.wco = st.wco;
    if (st.mpos) { this.mpos = st.mpos; this.wpos = st.wpos || st.mpos.map((v, i) => v - this.wco[i]); }
    else if (st.wpos) { this.wpos = st.wpos; this.mpos = st.wpos.map((v, i) => v + this.wco[i]); }
    if (st.feed != null) this.feedRate = st.feed;
    this.ln = st.ln;
    this.emit('status', this.status());
    const j = this.job;
    if (j) {
      this.updateProgress(true);
      if (j.allAcked && j.state !== 'stopping' && j.state !== 'error' && /^(Idle|Check)/.test(this.state)) this.finishJob('done');
    }
  }

  dropInflight(reason) {
    const items = this.inflight.concat(this.queue);
    this.inflight = []; this.inflightBytes = 0; this.queue = [];
    for (const it of items) if (it.done) it.done(reason);
  }

  // ---------- sending ----------
  writeRaw(s) {
    if (!this.transport) return;
    try { this.transport.write(s); } catch (e) { this.emit('log', { dir: 'err', text: e.message }); }
  }

  sendLine(item) {
    this.inflight.push(item);
    this.inflightBytes += item.len;
    this.writeRaw(item.text + '\n');
    this.emit('log', { dir: 'out', text: item.text });
  }

  pump() {
    if (!this.transport) return;
    while (this.queue.length) {
      const c = this.queue[0];
      if (this.inflightBytes + c.len > this.bufferSize) return;
      this.queue.shift();
      this.sendLine(c);
    }
    const j = this.job;
    if (!j || (j.state !== 'running' && j.state !== 'paused')) return;
    while (j.next < j.lines.length) {
      const L = j.lines[j.next];
      if (this.inflightBytes + L.len > this.bufferSize) return;
      this.sendLine({ kind: 'job', jobId: j.id, text: L.text, len: L.len, index: j.next, dot: L.dot, phase: L.phase });
      j.next++;
    }
  }

  command(text, opts = {}) {
    text = String(text == null ? '' : text).trim();
    if (!this.connected) return Promise.reject(new Error('Machine not connected.'));
    if (this.job) return Promise.reject(new Error('Printing in progress.'));
    if (this.alarmPending) return Promise.reject(new Error('Machine alarm. Press Unlock first.'));
    if (!text || text.length > 70 || /[\r\n?!~\x18\x85]/.test(text)) return Promise.reject(new Error('Invalid command.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = opts.timeout ? setTimeout(() => { settled = true; reject(new Error('No reply to ' + text)); }, opts.timeout) : null;
      const done = err => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err == null) resolve();
        else reject(new Error(/^\d+$/.test(String(err)) ? 'error:' + err + ' ' + describeError(err) : String(err)));
      };
      this.queue.push({ kind: 'cmd', text, len: text.length + 1, done });
      this.pump();
    });
  }

  // Clears an alarm. After a critical alarm GRBL needs a soft reset before $X is accepted.
  async unlock() {
    if (!this.connected) throw new Error('Machine not connected.');
    if (this.job) throw new Error('Printing in progress.');
    if (this.alarmPending) await this.softReset();
    await this.command('$X', { timeout: 3000 });
  }

  // Soft reset (Ctrl-X, 0x18): resets GRBL without switching the machine power off. Use it when
  // GRBL is stuck, to abort a job, or to reset the controller. A running print is aborted at once
  // (no feed hold first, so a move in progress can lose position and GRBL may raise an alarm).
  async softReset() {
    if (!this.connected) throw new Error('Machine not connected.');
    const j = this.job;
    if (j) {
      j.state = 'stopping';                  // an abort we asked for, not an unexpected reset
      if (!j.pausedAt) j.pausedAt = Date.now();
    }
    this.bannerSeen = false;
    this.writeRaw('\x18');
    const answered = await this.waitFor(() => this.bannerSeen || !this.transport, 3000);   // the banner empties the queues
    if (j && this.job === j) this.finishJob('aborted', { reset: answered });
    if (!answered) throw new Error('Machine did not answer the reset. Check the USB cable, or switch the machine off and on.');
  }

  // Check mode ($C): GRBL reads and checks every G-code line but moves nothing. Switching it
  // off makes GRBL reset itself. Returns whether check mode is on afterwards.
  async toggleCheckMode() {
    if (!this.connected) throw new Error('Machine not connected.');
    if (this.job) throw new Error('Printing in progress.');
    const turningOff = /^Check/.test(this.state);
    if (!turningOff && !/^Idle/.test(this.state)) throw new Error('Check mode can only be switched on while the machine is Idle.');
    if (turningOff) this.bannerSeen = false;
    await this.command('$C', { timeout: 3000 });
    if (turningOff) await this.waitFor(() => this.bannerSeen, 3000);
    const seq = this.statusSeq;
    this.writeRaw('?');
    await this.waitFor(() => this.statusSeq > seq, 1500);
    return /^Check/.test(this.state);
  }

  realtime(kind) {
    const map = { status: '?', jogCancel: '\x85' };
    if (!map[kind]) throw new Error('Unknown realtime command.');
    this.writeRaw(map[kind]);
  }

  jog(axis, dist, feed) {
    axis = String(axis).toUpperCase();
    if (!/^[XYZ]$/.test(axis) || !Number.isFinite(dist) || Math.abs(dist) > 500 || !(feed > 0)) return Promise.reject(new Error('Invalid jog.'));
    if (/^0\./.test(this.version)) {
      return this.command('G91 G0 ' + axis + fmt(dist)).then(() => this.command('G90'));
    }
    return this.command('$J=G91 G21 ' + axis + fmt(dist) + ' F' + fmt(feed));
  }

  // ---------- printing ----------
  startJob(job) {
    if (!this.connected) throw new Error('Connect the machine first.');
    if (this.job) throw new Error('Already printing.');
    if (/^Alarm/.test(this.state)) throw new Error('Machine is in ALARM. Check it, then press Unlock.');
    if (!/^(Idle|Check)/.test(this.state)) throw new Error('Machine is ' + this.state + '. Wait until it is Idle.');
    const lines = job && job.lines;
    if (!Array.isArray(lines) || !lines.length) throw new Error('Nothing to print.');
    const prepared = lines.map((l, i) => {
      const code = String(l.code).trim().toUpperCase();
      if (!/^[GMXYZFP0-9 .\-]+$/.test(code)) throw new Error('Refusing unexpected G-code: ' + code);
      const text = 'N' + (i + 1) + ' ' + code;
      if (text.length > 70) throw new Error('G-code line too long.');
      return { text, len: text.length + 1, dot: Number.isInteger(l.dot) ? l.dot : -1, phase: String(l.phase || '') };
    });
    let dots = 0, lastDotLine = -1;
    prepared.forEach((l, i) => { if (l.dot >= 0) { dots = Math.max(dots, l.dot + 1); lastDotLine = i; } });
    this.ln = null;
    this.job = {
      id: ++this.jobSeq, lines: prepared, dots, lastDotLine, next: 0, acked: 0, allAcked: false,
      syncDot: -1, dotsDone: 0, current: dots ? 0 : -1, phase: '', lnSeen: false, approx: false,
      hasDwell: prepared.some(l => l.phase === 'dwell'), state: 'running', check: /^Check/.test(this.state),
      startedAt: Date.now(), pausedAt: 0, pausedTotal: 0, errors: [],
      clearZ: Number(job.clearZ), estimate: Number(job.estimate) || 0,
      page: job.page == null ? 0 : job.page, pages: job.pages || 1, label: String(job.label || '')
    };
    this.emit('job', Object.assign({ type: 'start' }, this.progress()));
    this.pump();
    return this.progress();
  }

  pauseJob() {
    const j = this.job;
    if (!j || j.state !== 'running') return false;
    this.writeRaw('!');
    j.state = 'paused';
    j.pausedAt = Date.now();
    this.emit('job', Object.assign({ type: 'paused' }, this.progress()));
    return true;
  }

  resumeJob() {
    const j = this.job;
    if (!j || (j.state !== 'paused' && j.state !== 'error')) return false;
    this.writeRaw('~');
    if (j.pausedAt) { j.pausedTotal += Date.now() - j.pausedAt; j.pausedAt = 0; }
    j.state = 'running';
    this.emit('job', Object.assign({ type: 'resumed' }, this.progress()));
    this.pump();
    return true;
  }

  async stopJob() {
    const j = this.job;
    if (!j || j.state === 'stopping') return false;
    j.state = 'stopping';
    if (!j.pausedAt) j.pausedAt = Date.now();
    this.emit('job', Object.assign({ type: 'stopping' }, this.progress()));
    // 1) feed hold and wait until motion has stopped, so the reset keeps the position
    this.writeRaw('!');
    const seq = this.statusSeq;
    this.writeRaw('?');
    const held = await this.waitFor(() => this.statusSeq > seq && /^(Hold:0|Hold$|Idle|Alarm|Door|Check)/.test(this.state), 6000);
    // 2) soft reset clears GRBL's buffers
    this.bannerSeen = false;
    this.writeRaw('\x18');
    const reset = await this.waitFor(() => this.bannerSeen || !this.transport, 3000);
    this.dropInflight('Stopped');
    this.finishJob('stopped', { held, reset });
    // 3) lift the punch clear of the paper
    if (reset && this.transport && !j.check) {   // a check-mode run never moves the machine
      const seq2 = this.statusSeq;
      await this.waitFor(() => this.statusSeq > seq2, 1500);
      if (!/^Alarm/.test(this.state) && Number.isFinite(j.clearZ)) {
        try { await this.command('G21 G90 G0 Z' + fmt(j.clearZ), { timeout: 20000 }); } catch (_) { /* reported in log */ }
      }
    }
    return true;
  }

  finishJob(type, extra) {
    const j = this.job;
    if (!j) return;
    if (j.pausedAt) { j.pausedTotal += Date.now() - j.pausedAt; j.pausedAt = 0; }
    if (type === 'done') { j.dotsDone = j.dots; j.current = -1; j.phase = ''; }
    const p = this.progress();
    p.state = type;
    this.job = null;
    this.emit('job', Object.assign({ type }, p, extra || {}));
  }

  updateProgress(force) {
    const j = this.job;
    if (!j) return;
    let done = j.dotsDone;
    if (j.syncDot + 1 > done) done = j.syncDot + 1;
    let lnLine = null;
    if (this.ln != null) {
      const idx = this.ln - 1;
      if (idx >= 0 && idx < j.next) {          // only lines already sent can be executing
        j.lnSeen = true;
        lnLine = j.lines[idx];
        if (lnLine.dot >= 0) {
          const d = (lnLine.phase === 'retract' || lnLine.phase === 'dwell') ? lnLine.dot + 1 : lnLine.dot;
          if (d > done) done = d;
        } else if (idx > j.lastDotLine) done = j.dots;
      }
    }
    if (!j.lnSeen && !j.hasDwell && j.acked > this.plannerGuess) {
      // Firmware without line numbers and no dwell: estimate from acknowledged lines.
      const idx = j.acked - 1 - this.plannerGuess;
      const L = j.lines[idx];
      const d = L.dot >= 0 ? L.dot : (idx > j.lastDotLine ? j.dots : 0);
      if (d > done) { done = d; j.approx = true; }
    }
    if (j.allAcked && /^(Idle|Check)/.test(this.state)) done = j.dots;
    done = Math.min(done, j.dots);
    let phase = '';
    if (done < j.dots) {
      const z = this.wpos && this.wpos[2];
      if (lnLine && lnLine.dot === done) phase = lnLine.phase === 'plunge' ? 'punch' : lnLine.phase === 'move' ? 'move' : 'lift';
      else if (Number.isFinite(z) && Number.isFinite(j.clearZ) && z < j.clearZ - 0.3) phase = 'punch';
      else phase = /^Run/.test(this.state) ? 'move' : '';
    }
    const changed = done !== j.dotsDone || phase !== j.phase;
    j.dotsDone = done;
    j.current = done < j.dots ? done : -1;
    j.phase = phase;
    if (changed || force) this.emit('progress', this.progress());
  }

  progress() {
    const j = this.job;
    if (!j) return null;
    const now = Date.now();
    const active = Math.max(0, now - j.startedAt - j.pausedTotal - (j.pausedAt ? now - j.pausedAt : 0)) / 1000;
    let eta = null;
    if (j.dotsDone >= j.dots) eta = 0;
    else if (j.dotsDone >= 3) eta = (j.dots - j.dotsDone) * active / j.dotsDone;
    else if (j.estimate) eta = Math.max(0, j.estimate - active);
    return {
      page: j.page, pages: j.pages, label: j.label, state: j.state, machine: this.state,
      dotsDone: j.dotsDone, dots: j.dots, current: j.current, phase: j.phase,
      percent: j.dots ? Math.floor(1000 * j.dotsDone / j.dots) / 10 : 100,
      elapsed: active, eta, lines: j.lines.length, linesSent: j.next, linesAcked: j.acked,
      approx: j.approx, errors: j.errors.length, wpos: this.wpos
    };
  }

  // ---------- helpers ----------
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.transport) return;
      this.writeRaw('?');
      if (this.connected && Date.now() - this.lastStatusAt > 4000 && this.state !== 'Not responding') {
        this.state = 'Not responding';
        this.emit('status', this.status());
      }
    }, this.pollMs);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  waitFor(pred, ms) {
    if (pred()) return Promise.resolve(true);
    return new Promise(resolve => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(false); }, ms);
      this.waiters.push(w);
    });
  }

  checkWaiters() {
    for (const w of this.waiters.slice()) {
      if (w.pred()) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter(x => x !== w);
        w.resolve(true);
      }
    }
  }
}

module.exports = { GrblLink, parseStatus, describeError, describeAlarm, GRBL_ERRORS, GRBL_ALARMS };
