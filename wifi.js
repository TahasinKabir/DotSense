'use strict';
/*
 * WiFi of this computer: which network it is on, and joining the MKS DLC32's WiFi in one click.
 * Uses the tools built into the system: netsh (Windows), networksetup (macOS), nmcli (Linux).
 * Nothing is installed; joining a network is the same as picking it in the system WiFi list.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({ ssid: 'MKS_DLC', password: '12345678' });
const LOCATION_NOTE = 'Windows shows the WiFi name only when Location is on: Settings > Privacy & security > Location > Location services and "Let desktop apps access your location".';

function run(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, missing: !!(err && err.code === 'ENOENT'), out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- parsers (tested with sample outputs)
// Windows "netsh wlan show interfaces": the SSID line (not BSSID) of the connected interface.
function parseNetsh(out) {
  const m = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(out);
  const any = /^\s*(Name|Nom|Nombre|Name der)\s*:/m.test(out) || /Wi-?Fi|WLAN|Wireless/i.test(out);
  return { available: any || !!m, ssid: m ? m[1] : '' };
}
// Windows 11 24H2+ refuses WLAN details to programs while Location is off.
const netshNeedsLocation = out => /location/i.test(out) && !/^\s*SSID\s*:/m.test(out);
// Linux "nmcli -t -f active,ssid dev wifi list": "yes:NAME" for the network in use (\: and \\ escaped).
function parseNmcli(out) {
  for (const line of out.split(/\r?\n/)) {
    const m = /^yes:(.*)$/.exec(line);
    if (m) return { available: true, ssid: m[1].replace(/\\([:\\])/g, '$1') };
  }
  return { available: true, ssid: '' };
}
// Linux "nmcli -t -f TYPE,STATE dev": is there a WiFi adapter at all?
const nmcliHasWifi = out => out.split(/\r?\n/).some(l => /^wifi:/.test(l));
// macOS "networksetup -getairportnetwork en0": "Current Wi-Fi Network: NAME".
function parseAirport(out) {
  const m = /Current Wi-?Fi Network:\s*(.+?)\s*$/m.exec(out);
  return { available: !/is not a Wi-?Fi interface|Error/i.test(out), ssid: m ? m[1] : '' };
}
// macOS "networksetup -listallhardwareports": the device of the Wi-Fi port (usually en0).
function macWifiDevice(out) {
  const m = /Hardware Port:\s*(Wi-?Fi|AirPort)\s*\n\s*Device:\s*(\S+)/i.exec(out);
  return m ? m[2] : 'en0';
}
// Windows may call a network "MKS_DLC 2" in its network list.
const sameNetwork = (current, wanted) => !!current && !!wanted && (current === wanted || current.replace(/ \d+$/, '') === wanted);

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// Windows WLAN profile: WPA2-Personal, or open when there is no password. "manual" = Windows
// never joins it by itself, so the machine's WiFi does not take over the internet connection.
function windowsProfile(ssid, password) {
  const security = password
    ? `<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xml(password)}</keyMaterial></sharedKey>`
    : '<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>';
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xml(ssid)}</name>
  <SSIDConfig><SSID><name>${xml(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    ${security}
  </security></MSM>
</WLANProfile>
`;
}

// Windows without Location: the network name from the network list instead (PowerShell).
async function windowsNetworkName() {
  const ps = "$w=@(Get-NetAdapter | Where-Object { $_.NdisPhysicalMedium -eq 9 -and $_.Status -eq 'Up' } | ForEach-Object { $_.InterfaceAlias }); " +
    'Get-NetConnectionProfile | Where-Object { $w -contains $_.InterfaceAlias } | ForEach-Object { $_.Name }';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 12000);
  if (!r.ok) return null;
  return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
}

// Which network is this computer on? { available, ssid, hidden?, slow?, error? }
async function status() {
  if (process.platform === 'win32') {
    const r = await run('netsh', ['wlan', 'show', 'interfaces'], 8000);
    const text = r.out + '\n' + r.err;
    if (/no wireless interface/i.test(text)) return { available: false, ssid: '', error: 'This computer has no WiFi adapter.' };
    if (/wlansvc|AutoConfig/i.test(text) && !/^\s*SSID\s*:/m.test(text)) return { available: false, ssid: '', error: 'The Windows WiFi service (WLAN AutoConfig) is not running.' };
    if (netshNeedsLocation(text)) {
      const name = await windowsNetworkName();
      if (name === null) return { available: true, ssid: '', hidden: true, slow: true, error: LOCATION_NOTE };
      return { available: true, ssid: name, slow: true };
    }
    if (!r.ok && !r.out) return { available: false, ssid: '', error: 'WiFi is not available on this computer.' };
    return parseNetsh(r.out);
  }
  if (process.platform === 'darwin') {
    const dev = macWifiDevice((await run('networksetup', ['-listallhardwareports'], 8000)).out);
    const r = await run('networksetup', ['-getairportnetwork', dev], 8000);
    const s = parseAirport(r.out + r.err);
    if (s.available && !s.ssid) {   // newer macOS may not say; ipconfig may (or shows <redacted>)
      const m = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec((await run('ipconfig', ['getsummary', dev], 8000)).out);
      if (m && !/redacted/i.test(m[1])) s.ssid = m[1];
      else if (m) Object.assign(s, { hidden: true, error: 'macOS hides the WiFi name from apps (Location Services).' });
    }
    return s;
  }
  const dev = await run('nmcli', ['-t', '-f', 'TYPE,STATE', 'dev'], 8000);
  if (dev.missing) return { available: false, ssid: '', error: 'nmcli (NetworkManager) is not installed.' };
  if (!dev.ok) return { available: false, ssid: '', error: dev.err.trim() || 'WiFi is not available on this computer.' };
  if (!nmcliHasWifi(dev.out)) return { available: false, ssid: '', error: 'This computer has no WiFi adapter.' };
  let r = await run('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi', 'list', '--rescan', 'no'], 8000);
  if (!r.ok && /rescan/i.test(r.err)) r = await run('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'], 8000);   // older nmcli
  if (!r.ok) return { available: false, ssid: '', error: r.err.trim() || 'WiFi is not available on this computer.' };
  return parseNmcli(r.out);
}

// Clear words for what the system said when joining failed.
function joinError(text, ssid) {
  const t = String(text || '').trim();
  if (/location/i.test(t)) return 'Windows blocked it: ' + LOCATION_NOTE + ' Or pick “' + ssid + '” in the WiFi menu of the taskbar.';
  if (/not available|no network with|not found|could not find/i.test(t)) return `“${ssid}” was not found. Is the machine switched on? Its WiFi needs about 10 seconds after power-on.`;
  if (/secrets were required|password|802-11-wireless-security|authentication/i.test(t)) return `Wrong password for “${ssid}”?`;
  return t || 'Could not connect.';
}

// Joins the network. Resolves when connected or throws with a clear message.
async function connect(ssid, password, onStep) {
  ssid = String(ssid || '').trim();
  password = String(password || '');
  if (!ssid) throw new Error('Enter the WiFi name.');
  if (ssid.length > 32) throw new Error('A WiFi name has at most 32 characters.');
  if (password && (password.length < 8 || password.length > 63)) throw new Error('A WiFi password has 8 to 63 characters.');
  const step = t => { if (onStep) onStep(t); };
  if (process.platform === 'win32') {
    const file = path.join(os.tmpdir(), `dotsense-wifi-${process.pid}-${Date.now()}.xml`);
    let add;
    fs.writeFileSync(file, windowsProfile(ssid, password), 'utf8');
    try {
      step('Saving the WiFi profile…');
      add = await run('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current']);
    } finally {
      fs.rmSync(file, { force: true });   // the file holds the password: never leave it behind
    }
    step('Connecting…');   // (if Windows kept its own profile for this network, that one is used)
    const args = ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`];
    let c = await run('netsh', args);
    if (!c.ok && /interface/i.test(c.out + c.err)) {   // several WiFi adapters: use the first one
      const names = [...(await run('netsh', ['wlan', 'show', 'interfaces'], 8000)).out.matchAll(/^\s*Name\s*:\s*(.+?)\s*$/gm)].map(m => m[1]);
      if (names.length) c = await run('netsh', [...args, `interface=${names[0]}`]);
    }
    if (!c.ok || /not available|location/i.test(c.out)) {
      const why = joinError(c.out || c.err, ssid);
      throw new Error(add && !add.ok ? `${why} (Windows did not take the WiFi profile: ${(add.out || add.err).trim()})` : why);
    }
  } else if (process.platform === 'darwin') {
    const dev = macWifiDevice((await run('networksetup', ['-listallhardwareports'], 8000)).out);
    step('Connecting…');
    const c = await run('networksetup', ['-setairportnetwork', dev, ssid, ...(password ? [password] : [])], 30000);
    if (!c.ok || /Could not|Error|Failed/i.test(c.out)) throw new Error(joinError(c.out || c.err, ssid));
  } else {
    step('Connecting…');
    const args = ['dev', 'wifi', 'connect', ssid, ...(password ? ['password', password] : [])];
    let c = await run('nmcli', args, 45000);
    if (c.missing) throw new Error('nmcli (NetworkManager) is not installed. Connect to the WiFi from the system menu.');
    if (!c.ok && /no network with/i.test(c.err + c.out)) {   // not in the last scan yet
      step('Looking for the network…');
      await run('nmcli', ['dev', 'wifi', 'rescan'], 15000);
      await sleep(2500);
      c = await run('nmcli', args, 45000);
    }
    if (!c.ok) throw new Error(joinError(c.err || c.out, ssid));
  }
  // wait until the system reports the network
  step('Waiting for the network…');
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await status();
    if (sameNetwork(last.ssid, ssid)) return last;
    if (last.hidden) return Object.assign({}, last, { ssid, assumed: true });   // the system hides the name
    await sleep(750);
  }
  throw new Error(`Not connected to “${ssid}” yet. Is the machine switched on and its WiFi on? Check the name and password.`);
}

// For tests (DOTSENSE_WIFI_FAKE=1): a pretend WiFi that starts on "HomeNet" and joins with the right password.
function fake() {
  const now = { ssid: process.env.DOTSENSE_WIFI_FAKE === 'on' ? DEFAULTS.ssid : 'HomeNet' };
  return {
    status: async () => ({ available: true, ssid: now.ssid }),
    connect: async (ssid, password, onStep) => {
      if (onStep) onStep('Connecting…');
      await sleep(700);
      if (String(ssid).trim() !== DEFAULTS.ssid) throw new Error(`“${ssid}” was not found. Is the machine switched on? Its WiFi needs about 10 seconds after power-on.`);
      if (password !== DEFAULTS.password) throw new Error(`Wrong password for “${ssid}”?`);
      now.ssid = DEFAULTS.ssid;
      return { available: true, ssid: now.ssid };
    }
  };
}
const impl = process.env.DOTSENSE_WIFI_FAKE ? fake() : { status, connect };

module.exports = {
  DEFAULTS, LOCATION_NOTE, status: impl.status, connect: impl.connect, sameNetwork,
  parseNetsh, parseNmcli, parseAirport, macWifiDevice, nmcliHasWifi, netshNeedsLocation, windowsProfile, joinError
};
