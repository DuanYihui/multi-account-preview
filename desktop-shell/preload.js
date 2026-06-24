const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountPreviewShell', {
  getState: () => ipcRenderer.invoke('state'),
  onState: (callback) => {
    ipcRenderer.on('shell-state', (_event, state) => callback(state));
  },
  selectEnv: (env) => ipcRenderer.invoke('select-env', env),
  addEnv: (name) => ipcRenderer.invoke('add-env', name),
  updateEnv: (payload) => ipcRenderer.invoke('update-env', payload),
  deleteEnv: (name) => ipcRenderer.invoke('delete-env', name),
  setSettingsOpen: (open) => ipcRenderer.invoke('settings-open', open),
  showEnvMenu: (envName) => ipcRenderer.invoke('show-env-menu', envName),
  onEnvSettingsRequest: (callback) => {
    ipcRenderer.on('env-settings-request', (_event, envName) => callback(envName));
  },
  selectAccount: (account) => ipcRenderer.invoke('select-account', account),
  addAccount: (name) => ipcRenderer.invoke('add-account', name),
  renameAccount: (oldName, newName) => ipcRenderer.invoke('rename-account', oldName, newName),
  showAccountMenu: (accountName) => ipcRenderer.invoke('show-account-menu', accountName),
  onAccountEditRequest: (callback) => {
    ipcRenderer.on('account-edit-request', (_event, accountName) => callback(accountName));
  },
  focusPage: (page) => ipcRenderer.invoke('focus-page', page),
  setMobileMetrics: (page, metrics) => ipcRenderer.invoke('mobile-metrics', page, metrics),
  closePopupPage: (page) => ipcRenderer.invoke('close-popup-page', page),
  overview: () => ipcRenderer.invoke('overview'),
  toggleSidebar: () => ipcRenderer.invoke('toggle-sidebar'),
  setCamera: (camera) => ipcRenderer.invoke('canvas-camera', camera),
  setDevtoolsWidth: (width) => ipcRenderer.invoke('devtools-width', width),
  showZoomMenu: () => ipcRenderer.invoke('show-zoom-menu'),
  nav: (action) => ipcRenderer.invoke('nav', action)
});
