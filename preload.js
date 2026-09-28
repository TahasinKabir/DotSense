const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('desktop', {
  save: data => ipcRenderer.invoke('file:save', data),
  openProject: () => ipcRenderer.invoke('file:open-project'),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  brandLogos: () => ipcRenderer.invoke('app:brand-logos'),
  theme: {
    set: theme => ipcRenderer.invoke('theme:set', theme),
    onChange: callback => listen('theme:changed', callback)
  },

  ocr: (bytes, lang) => ipcRenderer.invoke('ocr:recognize', { bytes, lang }),
  onOcrProgress: callback => listen('ocr:progress', callback),

  machine: {
    list: () => ipcRenderer.invoke('machine:list'),
    connect: (path, baud) => ipcRenderer.invoke('machine:connect', { path, baud }),
    disconnect: () => ipcRenderer.invoke('machine:disconnect'),
    info: () => ipcRenderer.invoke('machine:info'),
    command: text => ipcRenderer.invoke('machine:command', text),
    unlock: () => ipcRenderer.invoke('machine:unlock'),
    home: () => ipcRenderer.invoke('machine:home'),
    reset: () => ipcRenderer.invoke('machine:reset'),
    checkMode: () => ipcRenderer.invoke('machine:check-mode'),
    zero: axes => ipcRenderer.invoke('machine:zero', axes),
    jog: (axis, dist, feed) => ipcRenderer.invoke('machine:jog', { axis, dist, feed }),
    jogCancel: () => ipcRenderer.invoke('machine:jog-cancel'),
    goto: (x, y, clearZ) => ipcRenderer.invoke('machine:goto', { x, y, clearZ }),
    start: job => ipcRenderer.invoke('machine:start', job),
    pause: () => ipcRenderer.invoke('machine:pause'),
    resume: () => ipcRenderer.invoke('machine:resume'),
    stop: () => ipcRenderer.invoke('machine:stop'),
    onEvent: callback => listen('machine:event', callback)
  },

  invert: {
    open: () => ipcRenderer.invoke('invert:open'),
    update: data => ipcRenderer.send('invert:update', data),
    onEvent: callback => listen('invert:event', callback),
    ready: () => ipcRenderer.send('invert:ready'),
    onData: callback => listen('invert:data', callback),
    goto: page => ipcRenderer.send('invert:goto', page),
    setInvert: on => ipcRenderer.send('invert:set', on)
  },

  wifi: {
    status: () => ipcRenderer.invoke('wifi:status'),
    connect: (ssid, password) => ipcRenderer.invoke('wifi:connect', { ssid, password }),
    onEvent: callback => listen('wifi:event', callback)
  },

  phone: {
    start: () => ipcRenderer.invoke('phone:start'),
    stop: () => ipcRenderer.invoke('phone:stop'),
    info: () => ipcRenderer.invoke('phone:info'),
    useAddress: ip => ipcRenderer.invoke('phone:address', ip),
    wifiQr: (ssid, password) => ipcRenderer.invoke('phone:wifi-qr', { ssid, password }),
    onEvent: callback => listen('phone:event', callback)
  },

  voice: {
    models: () => ipcRenderer.invoke('voice:models'),
    start: model => ipcRenderer.invoke('voice:start', { model }),
    audio: samples => ipcRenderer.send('voice:audio', samples),
    stop: () => ipcRenderer.invoke('voice:stop'),
    cancel: () => ipcRenderer.invoke('voice:cancel'),
    onEvent: callback => listen('voice:event', callback)
  }
});
