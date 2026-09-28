'use strict';
/*
 * Small GRBL 1.1 simulator. Used by the tests, and by `DOTSENSE_SIMULATOR=1 npm start`
 * to try live printing without a machine. It behaves like a serial port:
 * write(), close(cb), and 'data' / 'close' events.
 */
const { EventEmitter } = require('events');

const SETTINGS = {
  0: 10, 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 10: 1, 11: 0.01, 12: 0.002, 13: 0, 20: 0, 21: 0, 22: 0,
  23: 0, 24: 25, 25: 500, 26: 250, 27: 1, 30: 1000, 31: 0, 32: 0, 100: 800, 101: 800, 102: 800,
  110: 1000, 111: 1000, 112: 500, 120: 50, 121: 50, 122: 50, 130: 300, 131: 180, 132: 45
};

class FakeGrbl extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.o = Object.assign({
      version: '1.1h', rxSize: 127, plannerSize: 15, timeScale: 1, reportLn: true, homing: false,
      tick: 4, rapid: 1000, zRapid: 500, bootDelay: 30, banner: true, failLine: 0, alarmAfterLines: 0
    }, opts);
    this.mpos = [0, 0, 0];
    this.wco = [0, 0, 0];
    this.rx = '';
    this.maxRx = 0;
    this.overflow = false;
    this.planner = [];
    this.block = null;
    this.dwell = null;
    this.holdT = 0;
    this.state = this.o.homing ? 'Alarm' : 'Idle';
    this.check = false;   // $C check mode: G-code is read and checked, nothing moves
    this.abs = true;
    this.motion = 0;
    this.feed = 0;
    this.received = [];
    this.punches = [];
    this.statusCount = 0;
    this.gcodeLines = 0;
    this.closed = false;
    this.timer = setInterval(() => this.step(this.o.tick / 1000 * this.o.timeScale), this.o.tick);
    if (this.o.banner) setTimeout(() => this.banner(), this.o.bootDelay);
  }

  out(s) {
    if (this.closed) return;
    const buf = Buffer.from(s, 'latin1');
    setImmediate(() => { if (!this.closed) this.emit('data', buf); });
  }

  banner() {
    this.out("\r\nGrbl " + this.o.version + " ['$' for help]\r\n");
    if (this.state === 'Alarm') this.out("[MSG:'$H'|'$X' to unlock]\r\n");
  }

  write(data) {
    const s = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
    for (const ch of s) this.onChar(ch);
    return true;
  }

  close(cb) {
    if (this.closed) { if (cb) cb(); return; }
    this.closed = true;
    clearInterval(this.timer);
    setImmediate(() => { this.emit('close'); if (cb) cb(); });
  }

  onChar(ch) {
    if (ch === '?') return this.out(this.statusLine() + '\r\n');
    if (ch === '!') return this.feedHold();
    if (ch === '~') return this.cycleStart();
    if (ch === '\x18') return this.softReset();
    if (ch === '\x85') return this.jogCancel();
    this.rx += ch;
    if (this.rx.length > this.o.rxSize) this.overflow = true;
    if (this.rx.length > this.maxRx) this.maxRx = this.rx.length;
  }

  held() { return this.state === 'Hold:0' || this.state === 'Hold:1'; }

  plannedEnd() {
    if (this.planner.length) return this.planner[this.planner.length - 1].to.slice();
    if (this.block) return this.block.to.slice();
    return this.mpos.slice();
  }

  step(dt) {
    if (this.closed) return;
    for (let guard = 0; guard < 40 && this.tryLine(); guard++) { /* parse available lines */ }
    this.advance(dt);
  }

  tryLine() {
    if (this.dwell || this.blocked) return false;
    const i = this.rx.indexOf('\n');
    if (i < 0) return false;
    const raw = this.rx.slice(0, i).replace(/\r$/, '');
    const line = raw.replace(/\([^)]*\)|;.*$/g, '').replace(/\s+/g, '').toUpperCase();
    const isDwell = /G4(?!\d)/.test(line.replace(/^N\d+/, ''));
    const isSync = /M(30|2|5|3)(?!\d)/.test(line);
    const isMotion = !line.startsWith('$') && /[XYZ]-?[\d.]/.test(line) && !/G10/.test(line);
    const busy = this.planner.length || this.block;
    if ((isDwell || isSync) && busy) return false;
    if (isMotion && this.planner.length >= this.o.plannerSize) return false;
    this.rx = this.rx.slice(i + 1);
    this.received.push(raw);
    this.execute(line);
    return true;
  }

  ok() { this.out('ok\r\n'); }
  error(n) { this.out('error:' + n + '\r\n'); }

  execute(line) {
    if (line === '') return this.ok();
    if (line[0] === '$') return this.system(line);
    if (this.state === 'Alarm') return this.error(9);
    const words = {}, gs = [], ms = [];
    const re = /([A-Z])(-?\d*\.?\d+)/g;
    let m, consumed = 0;
    while ((m = re.exec(line))) {
      consumed += m[0].length;
      const L = m[1], v = parseFloat(m[2]);
      if (L === 'G') gs.push(v); else if (L === 'M') ms.push(v); else words[L] = v;
    }
    if (consumed !== line.length) return this.error(1);
    this.gcodeLines++;
    if (this.o.failLine && this.gcodeLines === this.o.failLine) return this.error(20);
    if (this.o.alarmAfterLines && this.gcodeLines === this.o.alarmAfterLines) {
      this.planner = []; this.block = null; this.rx = '';
      this.state = 'Alarm';
      this.blocked = true;   // critical alarm: nothing is processed until a soft reset
      this.out('ALARM:2\r\n[MSG:Reset to continue]\r\n');
      return;
    }
    for (const g of gs) {
      if (g === 90) this.abs = true;
      else if (g === 91) this.abs = false;
      else if (g === 0 || g === 1) this.motion = g;
      else if (![4, 10, 17, 21, 54, 94].includes(g)) return this.error(20);
    }
    for (const mm of ms) if (![2, 3, 5, 30].includes(mm)) return this.error(20);
    if (words.F != null) this.feed = words.F;
    if (gs.includes(10)) {
      if (words.L !== 20) return this.error(20);
      ['X', 'Y', 'Z'].forEach((a, i) => { if (words[a] != null) this.wco[i] = this.mpos[i] - words[a]; });
      return this.ok();
    }
    if (this.check) return this.ok();                                   // check mode: no dwell, no motion
    if (gs.includes(4)) { this.dwell = { left: words.P || 0 }; return; } // ok after the dwell
    if (ms.includes(30) || ms.includes(2)) { this.abs = true; this.motion = 0; }
    if (['X', 'Y', 'Z'].some(a => words[a] != null)) this.queueMove(words, this.motion, false);
    this.ok();
  }

  queueMove(words, mode, jog) {
    if (mode === 1 && !(this.feed > 0)) return this.error(22);
    const from = this.plannedEnd();
    const to = from.slice();
    ['X', 'Y', 'Z'].forEach((a, i) => {
      if (words[a] != null) to[i] = (this.abs && !jog) ? words[a] + this.wco[i] : from[i] + words[a];
    });
    const zOnly = to[0] === from[0] && to[1] === from[1];
    const rate = jog ? words.F : mode === 0 ? (zOnly ? this.o.zRapid : this.o.rapid) : this.feed;
    this.planner.push({ from, to, rate, ln: words.N || 0, jog });
  }

  system(line) {
    if (line === '$$') {
      for (const [k, v] of Object.entries(SETTINGS)) this.out('$' + k + '=' + (k === '22' ? (this.o.homing ? 1 : 0) : v) + '\r\n');
      return this.ok();
    }
    if (line === '$X') {
      if (this.state === 'Alarm') { this.state = 'Idle'; this.out('[MSG:Caution: Unlocked]\r\n'); }
      return this.ok();
    }
    if (line === '$H') { this.mpos = [0, 0, 0]; this.state = 'Idle'; return this.ok(); }
    if (line === '$C') {
      if (this.check) {   // off: GRBL resets itself
        this.check = false; this.state = 'Idle';
        this.out('[MSG:Disabled]\r\n'); this.ok();
        setTimeout(() => this.softReset(), 2);
        return;
      }
      if (this.state !== 'Idle') return this.error(8);
      this.check = true; this.state = 'Check';
      this.out('[MSG:Enabled]\r\n');
      return this.ok();
    }
    if (line.startsWith('$J=')) {
      if (this.state === 'Alarm') return this.error(9);
      if (this.check) return this.error(8);
      const words = {};
      const re = /([A-Z])(-?\d*\.?\d+)/g;
      let m;
      while ((m = re.exec(line.slice(3)))) if (m[1] !== 'G') words[m[1]] = parseFloat(m[2]);
      if (!(words.F > 0)) return this.error(16);
      this.queueMove(words, 0, true);
      return this.ok();
    }
    if (line === '$I') { this.out('[VER:' + this.o.version + '.20190825:]\r\n[OPT:V,15,128]\r\n'); return this.ok(); }
    if (line === '$G') { this.out('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n'); return this.ok(); }
    return this.ok();
  }

  advance(dt) {
    if (this.held()) {
      if (this.state === 'Hold:1') { this.holdT -= dt; if (this.holdT <= 0) this.state = 'Hold:0'; }
      return;
    }
    if (this.dwell) {
      this.dwell.left -= dt;
      if (this.dwell.left <= 0) { this.dwell = null; this.ok(); }
      return;
    }
    let t = dt;
    while (t > 0) {
      if (!this.block) {
        this.block = this.planner.shift() || null;
        if (!this.block) break;
        const b = this.block;
        b.len = Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1], b.to[2] - b.from[2]);
        b.done = 0;
      }
      const b = this.block;
      const speed = Math.max(b.rate, 1) / 60;
      const remain = b.len - b.done;
      if (speed * t >= remain) {
        t -= remain / speed;
        this.mpos = b.to.slice();
        this.blockDone(b);
        this.block = null;
      } else {
        b.done += speed * t;
        const f = b.done / b.len;
        this.mpos = b.from.map((v, i) => v + (b.to[i] - v) * f);
        t = 0;
      }
    }
    if (this.state !== 'Alarm' && !this.check) {
      const moving = this.block || this.planner.length;
      this.state = moving ? ((this.block || this.planner[0]).jog ? 'Jog' : 'Run') : 'Idle';
    }
  }

  blockDone(b) {
    const w = i => Math.round((b.to[i] - this.wco[i]) * 1000) / 1000;
    if (b.to[2] < b.from[2] && w(2) < 0) this.punches.push({ x: w(0), y: w(1), z: w(2) });
  }

  feedHold() {
    if (this.state === 'Alarm' || this.check) return;
    if (this.state === 'Jog') return this.jogCancel();
    if (this.block || this.planner.length) { this.state = 'Hold:1'; this.holdT = 0.05; }
    else this.state = 'Hold:0';
  }

  cycleStart() {
    if (!this.held()) return;
    this.state = (this.block || this.planner.length) ? 'Run' : 'Idle';
  }

  jogCancel() {
    if (this.state !== 'Jog') return;
    this.planner = []; this.block = null; this.state = 'Idle';
  }

  softReset() {
    const moving = (this.block || this.planner.length) && this.state !== 'Hold:0';
    this.rx = ''; this.planner = []; this.block = null; this.dwell = null;
    this.abs = true; this.motion = 0; this.blocked = false; this.check = false;
    if (this.state === 'Check') this.state = 'Idle';
    if (moving) { this.out('ALARM:3\r\n'); this.state = 'Alarm'; }
    else if (this.state !== 'Alarm') this.state = this.o.homing ? 'Alarm' : 'Idle';
    setTimeout(() => this.banner(), 5);
  }

  statusLine() {
    this.statusCount++;
    const f = n => (Math.round(n * 1000) / 1000).toFixed(3);
    if (/^0\./.test(this.o.version)) {
      const st = this.state.split(':')[0];
      return '<' + st + ',MPos:' + this.mpos.map(f).join(',') + ',WPos:' + this.mpos.map((v, i) => f(v - this.wco[i])).join(',') + '>';
    }
    let s = '<' + this.state + '|MPos:' + this.mpos.map(f).join(',') + '|FS:' + (this.block ? this.block.rate : 0) + ',0';
    if (this.o.reportLn && this.block && this.block.ln) s += '|Ln:' + this.block.ln;
    if (this.statusCount % 10 === 1) s += '|WCO:' + this.wco.map(f).join(',');
    return s + '>';
  }

  workPos() { return this.mpos.map((v, i) => Math.round((v - this.wco[i]) * 1000) / 1000); }
}

module.exports = { FakeGrbl };
