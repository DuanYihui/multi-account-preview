const { app, BrowserView, BrowserWindow, Menu, dialog, ipcMain, screen, shell, WebContentsView } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const stateDir = process.env.ACCOUNT_PREVIEW_HOME || path.join(app.getPath('home'), '.account-preview-workbench');
const configFile = process.env.ACCOUNT_PREVIEW_CONFIG || path.join(stateDir, 'accounts.tsv');
const uiStateFile = path.join(stateDir, 'ui-state.json');
const redisCodeConfigFile = path.join(app.getPath('home'), '.redis-code-menubar.json');
const userDataDir = path.join(stateDir, 'electron-shell');

app.setPath('userData', userDataDir);
app.setName('Multi Account Preview');

const shellState = {
  environments: [],
  selectedEnv: '',
  selectedAccount: '',
  focusedPage: '',
  mode: 'overview',
  camera: { x: 0, y: 0, zoom: 1 },
  pageZooms: {},
  viewStates: {},
  sidebarCollapsed: false,
  statuses: {},
  popupPages: {},
  viewFrames: [],
  settingsOpen: false,
  previewFullscreen: false
};

let mainWindow;
const views = new Map();
let embeddedDevtoolsView = null;
let embeddedDevtoolsTargetKey = '';
let embeddedDevtoolsWidth = 720;
let popupSeq = 0;
const autoFillTimers = new Map();
const metricsTimers = new Map();
const mobileRemTimers = new Map();
const MOBILE_VIEWPORT = { width: 375, height: 812, deviceScaleFactor: 2 };
const DESKTOP_VIEWPORT = { width: 1440, height: 820 };
const SIDEBAR_WIDTH = 280;
const SIDEBAR_COLLAPSED_WIDTH = 64;
const TOOLBAR_HEIGHT = 72;
const DEVTOOLS_GAP = 12;
const DEVTOOLS_MIN_WIDTH = 420;
const DEVTOOLS_MAX_WIDTH = 980;
const ZOOM_OPTIONS = [80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
const DEFAULT_AUTH_COOKIE_NAMES = ['*'];
const DEFAULT_SHARED_HOST_SUFFIXES = ['example.com'];
const AUTH_COOKIE_NAMES = new Set(readCsvEnv('ACCOUNT_PREVIEW_AUTH_COOKIES', DEFAULT_AUTH_COOKIE_NAMES));
const SHARED_HOST_SUFFIXES = readCsvEnv('ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES', DEFAULT_SHARED_HOST_SUFFIXES)
  .map((suffix) => suffix.replace(/^\./, '').toLowerCase())
  .filter(Boolean);
const MOBILE_USER_AGENT_BASE = [
  'Mozilla/5.0 (Linux; Android 12; Pixel 5)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/126.0.0.0 Mobile Safari/537.36'
].join(' ');

function readCsvEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return [...fallback];
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}

function sidebarWidth() {
  return shellState.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
}

function defaultConfig() {
  return [
    '# enabled\tenv\taccount\tpage\turl\tx\ty\twidth\theight\tprofileKey\tuserAgent\tdeviceScaleFactor\tmobileEmulation',
    'yes\t测试环境\t默认账号\t移动端\thttps://m.example.com\t40\t80\t375\t812\t测试环境:默认账号\t\t\tyes',
    'yes\t测试环境\t默认账号\t后台\thttps://admin.example.com\t500\t80\t1440\t820\t测试环境:默认账号\t\t\tno',
    'no\t测试环境\t默认账号\t收银台\thttps://cashier.example.com\t1980\t80\t1440\t820\t测试环境:默认账号\t\t\tno',
    ''
  ].join('\n');
}

function ensureConfig() {
  fs.mkdirSync(stateDir, { recursive: true });
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, defaultConfig(), 'utf8');
}

function readUiState() {
  try {
    if (!fs.existsSync(uiStateFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(uiStateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeUiState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const data = {
    selectedEnv: shellState.selectedEnv,
    selectedAccount: shellState.selectedAccount,
    pageZooms: shellState.pageZooms,
    viewStates: shellState.viewStates,
    sidebarCollapsed: shellState.sidebarCollapsed
  };
  fs.writeFileSync(uiStateFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadUiState() {
  const saved = readUiState();
  shellState.pageZooms = saved.pageZooms && typeof saved.pageZooms === 'object' ? saved.pageZooms : {};
  shellState.viewStates = saved.viewStates && typeof saved.viewStates === 'object' ? saved.viewStates : {};
  shellState.sidebarCollapsed = Boolean(saved.sidebarCollapsed);
  return saved;
}

function slugify(value) {
  const hash = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
  const ascii = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii ? `${ascii}-${hash}` : `suite-${hash}`;
}

function parseConfigLine(line) {
  const parts = line.split('\t');
  const enabled = parts[0] === 'yes';
  if (parts.length >= 9) {
    const [_, env, account, page, url, x, y, width, height, profileKey, userAgent, deviceScaleFactor, mobileEmulation] = parts;
    return { enabled, env, account, page, url, x, y, width, height, profileKey, userAgent, deviceScaleFactor, mobileEmulation };
  }
  const [_, suite, page, url, x, y, width, height] = parts;
  return { enabled, env: suite, account: '默认账号', page, url, x, y, width, height, profileKey: '', userAgent: '', deviceScaleFactor: '', mobileEmulation: '' };
}

function readConfigRows() {
  ensureConfig();
  return fs.readFileSync(configFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(parseConfigLine)
    .filter((row) => row.env && row.account && row.page && row.url)
    .map((row) => ({
      ...row,
      profileKey: row.profileKey || `${row.env}:${row.account}`,
      mobileEmulation: normalizeMobileEmulation(row)
    }));
}

function writeConfigRows(rows) {
  const lines = ['# enabled\tenv\taccount\tpage\turl\tx\ty\twidth\theight\tprofileKey\tuserAgent\tdeviceScaleFactor\tmobileEmulation'];
  for (const row of rows) {
    const mobile = isMobilePage(row);
    lines.push([
      row.enabled ? 'yes' : 'no',
      row.env,
      row.account,
      row.page,
      row.url,
      row.x ?? row.model?.x ?? 0,
      row.y ?? row.model?.y ?? 0,
      mobile ? normalizeMobileDimension(row.width ?? row.model?.width, MOBILE_VIEWPORT.width) : (row.width ?? row.model?.width ?? 980),
      mobile ? normalizeMobileDimension(row.height ?? row.model?.height, MOBILE_VIEWPORT.height) : (row.height ?? row.model?.height ?? 820),
      row.profileKey || `${row.env}:${row.account}`,
      mobile ? normalizeUserAgent(row.userAgent) : '',
      mobile ? normalizeDeviceScaleFactor(row.deviceScaleFactor) : '',
      mobile ? 'yes' : 'no'
    ].join('\t'));
  }
  fs.writeFileSync(configFile, `${lines.join('\n')}\n`, 'utf8');
}

function readEnvironments() {
  const rows = readConfigRows().map((row) => ({
    enabled: row.enabled,
    env: row.env,
    account: row.account || '默认账号',
    profileKey: row.profileKey,
    page: row.page,
    url: row.url,
    mobileEmulation: Boolean(row.mobileEmulation),
    userAgent: isMobilePage(row) ? normalizeUserAgent(row.userAgent) : '',
    deviceScaleFactor: isMobilePage(row) ? normalizeDeviceScaleFactor(row.deviceScaleFactor) : 1,
    model: {
      x: Number(row.x || 0),
      y: Number(row.y || 0),
      width: isMobilePage(row) ? normalizeMobileDimension(row.width, MOBILE_VIEWPORT.width) : Number(row.width || 980),
      height: isMobilePage(row) ? normalizeMobileDimension(row.height, MOBILE_VIEWPORT.height) : Number(row.height || 820)
    }
  }));

  const envMap = new Map();
  const accountMap = new Map();
  for (const row of rows) {
    if (!envMap.has(row.env)) {
      envMap.set(row.env, {
        env: row.env,
        enabled: false,
        accounts: []
      });
    }
    const env = envMap.get(row.env);
    const accountKey = `${row.env}\t${row.account}`;
    if (!accountMap.has(accountKey)) {
      const account = {
        env: row.env,
        account: row.account,
        profileKey: row.profileKey,
        partition: `persist:${slugify(row.profileKey)}`,
        enabled: false,
        pages: []
      };
      accountMap.set(accountKey, account);
      env.accounts.push(account);
    }
    const account = accountMap.get(accountKey);
    env.enabled = env.enabled || row.enabled;
    account.enabled = account.enabled || row.enabled;
    account.pages.push(row);
  }

  return Array.from(envMap.values());
}

function currentEnv() {
  return shellState.environments.find((item) => item.env === shellState.selectedEnv) || shellState.environments[0];
}

function currentAccount() {
  const env = currentEnv();
  if (!env) return null;
  return env.accounts.find((item) => item.account === shellState.selectedAccount) || env.accounts[0];
}

function nextAccountName(env) {
  const names = new Set((env?.accounts || []).map((account) => account.account));
  let index = names.size + 1;
  while (names.has(`账号${index}`)) index += 1;
  return `账号${index}`;
}

function normalizeLabel(value) {
  return String(value || '').replace(/[\t\r\n/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeEditableUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return new URL(raw).toString();
  }
  const protocol = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-f:]+\]|[^/\s]+:\d+)([/?:#]|$)/i.test(raw)
    ? 'http://'
    : 'https://';
  return new URL(`${protocol}${raw}`).toString();
}

function normalizeUserAgent(value) {
  const text = String(value || '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[a-z]+app$/i.test(text) ? '' : text;
}

function normalizeDeviceScaleFactor(value) {
  const number = Number(value || MOBILE_VIEWPORT.deviceScaleFactor);
  if (!Number.isFinite(number) || number <= 0) return MOBILE_VIEWPORT.deviceScaleFactor;
  return Math.max(0.5, Math.min(4, number));
}

function normalizeMobileDimension(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(Math.max(240, Math.min(1200, number)));
}

function normalizeMobileEmulation(row) {
  const raw = row?.mobileEmulation;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return /^(yes|true|1|on)$/i.test(String(raw).trim());
  }
  return legacyMobileEmulation(row);
}

function legacyMobileEmulation(row) {
  const url = String(row?.url || '');
  const width = Number(row?.model?.width ?? row?.width ?? 0);
  const height = Number(row?.model?.height ?? row?.height ?? 0);
  if (/\/(mproducer|easy|mobile|h5)(\/|$)|(^https?:\/\/m\.)/i.test(url)) return true;
  return width > 0 && height > 0 && width <= 600 && height <= 1200;
}

function refreshEnvironments(selectedEnv = shellState.selectedEnv, selectedAccount = shellState.selectedAccount) {
  shellState.environments = readEnvironments();
  shellState.selectedEnv = shellState.environments.find((env) => env.env === selectedEnv)?.env || shellState.environments[0]?.env || '';
  const env = currentEnv();
  shellState.selectedAccount = env?.accounts.find((account) => account.account === selectedAccount)?.account || env?.accounts[0]?.account || '';
}

function deleteAccount(accountName) {
  const env = currentEnv();
  const cleanName = normalizeLabel(accountName || shellState.selectedAccount);
  if (!env || !cleanName) return false;
  if (env.accounts.length <= 1) {
    throw new Error('每个环境至少保留 1 个账号');
  }
  if (!env.accounts.some((account) => account.account === cleanName)) {
    throw new Error(`账号不存在：${cleanName}`);
  }
  const targetAccount = env.accounts.find((account) => account.account === cleanName);

  const rows = readConfigRows().filter((row) => !(row.env === env.env && row.account === cleanName));
  writeConfigRows(rows);
  destroyAccountViews(targetAccount);
  const nextAccount = cleanName === shellState.selectedAccount
    ? env.accounts.find((account) => account.account !== cleanName)?.account
    : shellState.selectedAccount;
  refreshEnvironments(env.env, nextAccount);
  shellState.focusedPage = '';
  shellState.mode = 'overview';
  ensureAccountViews();
  return true;
}

function addEnvironment(name) {
  const sourceEnv = currentEnv();
  const sourceAccount = currentAccount() || sourceEnv?.accounts?.[0];
  const cleanName = normalizeLabel(name);
  if (!cleanName) throw new Error('环境名称不能为空');
  if (shellState.environments.some((env) => env.env === cleanName)) {
    throw new Error(`环境已存在：${cleanName}`);
  }
  if (!sourceAccount?.pages?.length) {
    throw new Error('没有可复制的窗口配置');
  }

  saveCurrentViewState();
  const rows = readConfigRows();
  const accountName = '默认账号';
  const profileKey = `${cleanName}:${accountName}`;
  for (const page of sourceAccount.pages.filter((item) => !item.popup)) {
    rows.push({
      enabled: page.enabled,
      env: cleanName,
      account: accountName,
      page: page.page,
      url: page.url,
      x: page.model?.x ?? 0,
      y: page.model?.y ?? 0,
      width: page.model?.width ?? 980,
      height: page.model?.height ?? 820,
      profileKey,
      userAgent: page.userAgent,
      deviceScaleFactor: page.deviceScaleFactor,
      mobileEmulation: page.mobileEmulation
    });
  }
  writeConfigRows(rows);
  refreshEnvironments(cleanName, accountName);
  shellState.focusedPage = '';
  shellState.mode = 'overview';
  restoreAccountViewState(currentAccount());
  ensureAccountViews();
  return true;
}

function updateEnvironment(payload = {}) {
  const oldName = normalizeLabel(payload.oldName || shellState.selectedEnv);
  const cleanName = normalizeLabel(payload.name || oldName);
  if (!oldName || !cleanName) throw new Error('环境名称不能为空');
  const env = shellState.environments.find((item) => item.env === oldName);
  if (!env) throw new Error(`环境不存在：${oldName}`);
  if (cleanName !== oldName && shellState.environments.some((item) => item.env === cleanName)) {
    throw new Error(`环境已存在：${cleanName}`);
  }

  const pageUpdates = new Map();
  const submittedPages = Array.isArray(payload.pages) ? payload.pages : [];
  if (!submittedPages.length) throw new Error('环境至少需要保留 1 个窗口');
  for (const page of submittedPages) {
    const originalPage = normalizeLabel(page.originalPage);
    const nextPage = normalizeLabel(page.page);
    let nextUrl = '';
    if (!nextPage) throw new Error('窗口名称不能为空');
    try {
      nextUrl = normalizeEditableUrl(page.url);
    } catch (_error) {
      throw new Error(`窗口「${nextPage}」的 URL 格式不正确`);
    }
    if (!nextUrl) throw new Error(`窗口「${nextPage}」的 URL 不能为空`);
    const nextUpdate = {
      page: nextPage,
      url: nextUrl,
      enabled: Boolean(page.enabled),
      mobileEmulation: Boolean(page.mobileEmulation)
    };
    if (Object.prototype.hasOwnProperty.call(page, 'userAgent')) {
      nextUpdate.userAgent = normalizeUserAgent(page.userAgent);
    }
    if (Object.prototype.hasOwnProperty.call(page, 'deviceScaleFactor')) {
      nextUpdate.deviceScaleFactor = normalizeDeviceScaleFactor(page.deviceScaleFactor);
    }
    pageUpdates.set(originalPage || `__new_${pageUpdates.size}`, nextUpdate);
  }

  const nextPageNames = Array.from(pageUpdates.values()).map((page) => page.page);
  if (new Set(nextPageNames).size !== nextPageNames.length) {
    throw new Error('同一个环境下窗口名称不能重复');
  }

  saveCurrentViewState();
  for (const account of env.accounts) destroyAccountViews(account);

  const existingRows = readConfigRows();
  const untouchedRows = existingRows.filter((row) => row.env !== oldName);
  const envRows = existingRows.filter((row) => row.env === oldName);
  const accountNames = Array.from(new Set(envRows.map((row) => row.account || '默认账号')));
  const rows = [...untouchedRows];
  for (const accountName of accountNames) {
    const accountRows = envRows.filter((row) => (row.account || '默认账号') === accountName);
    const fallbackProfileKey = accountRows[0]?.profileKey || `${cleanName}:${accountName}`;
    Array.from(pageUpdates.entries()).forEach(([originalPage, update], index) => {
      const previous = accountRows.find((row) => row.page === originalPage);
      const mobile = update.mobileEmulation;
      rows.push({
        ...(previous || {}),
        enabled: update.enabled,
        env: cleanName,
        account: accountName,
        page: update.page,
        url: update.url,
        x: previous?.x ?? (mobile ? 0 : index * 40),
        y: previous?.y ?? (mobile ? 0 : index * 40),
        width: previous?.width ?? (mobile ? MOBILE_VIEWPORT.width : DESKTOP_VIEWPORT.width),
        height: previous?.height ?? (mobile ? MOBILE_VIEWPORT.height : DESKTOP_VIEWPORT.height),
        profileKey: previous?.profileKey || fallbackProfileKey,
        userAgent: mobile ? (update.userAgent !== undefined ? update.userAgent : previous?.userAgent) : '',
        deviceScaleFactor: mobile ? (update.deviceScaleFactor !== undefined ? update.deviceScaleFactor : previous?.deviceScaleFactor) : '',
        mobileEmulation: mobile
      });
    });
  }
  writeConfigRows(rows);
  refreshEnvironments(cleanName, shellState.selectedAccount);
  shellState.focusedPage = '';
  shellState.mode = 'overview';
  restoreAccountViewState(currentAccount());
  ensureAccountViews();
  return true;
}

function deleteEnvironment(name) {
  const cleanName = normalizeLabel(name || shellState.selectedEnv);
  if (!cleanName) return false;
  if (shellState.environments.length <= 1) {
    throw new Error('至少保留 1 个环境');
  }
  const env = shellState.environments.find((item) => item.env === cleanName);
  if (!env) throw new Error(`环境不存在：${cleanName}`);

  saveCurrentViewState();
  for (const account of env.accounts) destroyAccountViews(account);
  const rows = readConfigRows().filter((row) => row.env !== cleanName);
  writeConfigRows(rows);
  refreshEnvironments('', '');
  shellState.focusedPage = '';
  shellState.mode = 'overview';
  restoreAccountViewState(currentAccount());
  ensureAccountViews();
  return true;
}

function destroyAccountViews(account) {
  if (!account || !mainWindow) return;
  const prefix = `${accountCacheKey(account)}\t`;
  for (const [key, view] of views.entries()) {
    if (!key.startsWith(prefix)) continue;
    destroyView(key);
  }
  delete shellState.popupPages[accountCacheKey(account)];
}

function destroyView(key) {
  const timer = autoFillTimers.get(key);
  if (timer) {
    clearInterval(timer);
    autoFillTimers.delete(key);
  }
  const metricsTimer = metricsTimers.get(key);
  if (metricsTimer) {
    clearTimeout(metricsTimer);
    metricsTimers.delete(key);
  }
  const remTimer = mobileRemTimers.get(key);
  if (remTimer) {
    clearTimeout(remTimer);
    mobileRemTimers.delete(key);
  }
  delete shellState.statuses[key];
  const view = views.get(key);
  if (!view) return;
  if (embeddedDevtoolsTargetKey === key) closeEmbeddedDevtools({ skipLayout: true });
  detachView(view);
  if (!view.webContents.isDestroyed()) view.webContents.destroy();
  views.delete(key);
}

function attachView(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (view.usesContentView) {
    mainWindow.contentView.addChildView(view);
  } else {
    mainWindow.addBrowserView(view);
  }
}

function detachView(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (view.usesContentView) {
    mainWindow.contentView.removeChildView(view);
  } else {
    mainWindow.removeBrowserView(view);
  }
}

function accountPopupPages(account) {
  if (!account) return [];
  return shellState.popupPages[accountCacheKey(account)] || [];
}

function enabledPages(account) {
  return [
    ...(account?.pages || []).filter((page) => page.enabled),
    ...accountPopupPages(account).filter((page) => page.enabled)
  ];
}

function pageZoomKey(pageName) {
  const account = currentAccount();
  return `${shellState.selectedEnv}:${account?.profileKey || shellState.selectedAccount}:${pageName}`;
}

function accountCacheKey(account) {
  return `${account?.env || ''}\t${account?.profileKey || account?.account || ''}`;
}

function saveCurrentViewState() {
  const account = currentAccount();
  if (!account) return;
  shellState.viewStates[accountCacheKey(account)] = {
    mode: shellState.mode,
    focusedPage: shellState.focusedPage,
    camera: { ...shellState.camera }
  };
  writeUiState();
}

function restoreAccountViewState(account) {
  const pages = enabledPages(account);
  const fallbackPage = pages[0]?.page || '';
  const saved = shellState.viewStates[accountCacheKey(account)] || {};
  const savedPageExists = pages.some((page) => page.page === saved.focusedPage);
  shellState.mode = saved.mode === 'focus' && savedPageExists ? 'focus' : 'overview';
  shellState.focusedPage = savedPageExists ? saved.focusedPage : fallbackPage;
  shellState.camera = saved.camera
    ? { ...saved.camera, zoom: Number(saved.camera.zoom || 1) }
    : { x: 0, y: 0, zoom: shellState.camera.zoom || 1 };
}

function mobileUserAgent(page) {
  return normalizeUserAgent(page?.userAgent) || MOBILE_USER_AGENT_BASE;
}

function mobileViewport(page) {
  return {
    width: normalizeMobileDimension(page?.model?.width ?? page?.width, MOBILE_VIEWPORT.width),
    height: normalizeMobileDimension(page?.model?.height ?? page?.height, MOBILE_VIEWPORT.height)
  };
}

function applyMobileEmulation(view, page) {
  if (!view || view.webContents.isDestroyed()) return;
  // Keep this path side-effect free at startup. Electron 33 on macOS 26 can
  // SIGSEGV when device emulation APIs are applied to BrowserView during load.
  view.mobileViewport = mobileViewport(page);
  view.mobileDeviceScaleFactor = normalizeDeviceScaleFactor(page?.deviceScaleFactor);
}

function viewCacheKey(account, pageName) {
  return `${accountCacheKey(account)}\t${pageName}`;
}

function currentStatusMap() {
  const account = currentAccount();
  const statuses = {};
  for (const page of enabledPages(account)) {
    const status = shellState.statuses[viewCacheKey(account, page.page)] || {};
    statuses[page.page] = {
      ...status,
      zoom: getPageZoom(page.page),
      mobileRoute: isMobilePage(page) ? mobileRouteFromUrl(status.url || page.url) : ''
    };
  }
  return statuses;
}

function mobileRouteFromUrl(url) {
  const text = String(url || '');
  const candidates = [text];
  try {
    candidates.push(decodeURIComponent(text));
  } catch (_error) {
    // Keep the raw URL when it is not URI-encoded.
  }

  try {
    const parsed = new URL(text);
    candidates.push(parsed.pathname, `${parsed.pathname}${parsed.search}`);
    for (const key of ['redirectUrl', 'redirect_url', 'redirect', 'next']) {
      const redirect = parsed.searchParams.get(key);
      if (!redirect) continue;
      candidates.push(redirect);
      try {
        candidates.push(decodeURIComponent(redirect));
      } catch (_error) {
        // URLSearchParams normally decodes this already.
      }
      try {
        const redirectUrl = new URL(redirect, parsed.origin);
        candidates.push(redirectUrl.pathname, `${redirectUrl.pathname}${redirectUrl.search}`);
      } catch (_error) {
        // Some redirect values are relative paths; the raw candidate is enough.
      }
    }
  } catch (_error) {
    // Relative or empty URL; fall back to plain text matching.
  }

  if (candidates.some((candidate) => candidate.includes('/easy/private/salesman'))) return 'salesman';
  if (candidates.some((candidate) => candidate.includes('/easy/private/home'))) return 'home';
  return '';
}

function normalizePopupUrl(targetUrl, openerUrl) {
  try {
    return new URL(targetUrl, openerUrl || undefined).toString();
  } catch (_error) {
    return String(targetUrl || '');
  }
}

function isSharedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return SHARED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function hostFamily(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const secondLevelTlds = new Set(['com', 'net', 'org', 'gov', 'edu', 'co']);
  const suffixSize = secondLevelTlds.has(parts.at(-2)) && parts.length >= 3 ? 3 : 2;
  return parts.slice(-suffixSize).join('.');
}

function sameAccountHostFamily(sourceHostname, targetHostname) {
  const sourceHost = String(sourceHostname || '').toLowerCase();
  const targetHost = String(targetHostname || '').toLowerCase();
  if (!sourceHost || !targetHost) return false;
  if (sourceHost === targetHost) return true;
  if (isSharedHost(sourceHost) && isSharedHost(targetHost)) return true;
  const sourceFamily = hostFamily(sourceHost);
  const targetFamily = hostFamily(targetHost);
  return sourceFamily && sourceFamily === targetFamily;
}

function shouldOpenInWorkbench(targetUrl, openerUrl) {
  try {
    const target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    if (!openerUrl) return isSharedHost(target.hostname);
    const opener = new URL(openerUrl);
    return target.origin === opener.origin
      || target.hostname === opener.hostname
      || isSharedHost(target.hostname);
  } catch (_error) {
    return false;
  }
}

function sameCookieBridgeFamily(sourceUrl, targetUrl) {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(source.protocol) || !['http:', 'https:'].includes(target.protocol)) return false;
    return sameAccountHostFamily(source.hostname, target.hostname);
  } catch (_error) {
    return false;
  }
}

function cookieBridgeTargets(account, sourceUrl) {
  if (!account || !sourceUrl) return [];
  return (account.pages || [])
    .filter((page) => page.enabled && page.url && sameCookieBridgeFamily(sourceUrl, page.url))
    .map((page) => page.url);
}

function bridgeableCookies(cookies) {
  const names = AUTH_COOKIE_NAMES;
  const hasNameFilter = names.size > 0 && !names.has('*');
  return cookies.filter((cookie) => {
    if (hasNameFilter && !names.has(cookie.name)) return false;
    return cookie.value !== undefined && cookie.value !== null;
  });
}

async function setCookieForUrl(session, targetUrl, cookie) {
  const target = new URL(targetUrl);
  const nextCookie = {
    url: `${target.protocol}//${target.host}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: cookie.secure && target.protocol === 'https:',
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  };
  return session.cookies.set(nextCookie);
}

async function syncAccountCookies(account, page, view) {
  if (!account || !page || !view || view.webContents.isDestroyed()) return false;
  const sourceUrl = view.webContents.getURL() || page.url;
  if (!sourceUrl) return false;
  try {
    const session = view.webContents.session;
    const sourceCookies = bridgeableCookies(await session.cookies.get({ url: sourceUrl }));
    if (!sourceCookies.length) return false;
    const targets = cookieBridgeTargets(account, sourceUrl)
      .filter((targetUrl) => targetUrl !== page.url && targetUrl !== sourceUrl);
    if (!targets.length) return false;
    const results = await Promise.allSettled(
      targets.flatMap((targetUrl) => sourceCookies.map((cookie) => setCookieForUrl(session, targetUrl, cookie)))
    );
    return results.some((result) => result.status === 'fulfilled');
  } catch (error) {
    console.warn('[account-cookie-sync]', error.message || error);
    return false;
  }
}

function looksLikeLoginPage(view) {
  if (!view || view.webContents.isDestroyed()) return false;
  const currentUrl = view.webContents.getURL() || '';
  const title = view.webContents.getTitle() || '';
  return /\/login\b|\/login\?|\/login$|\/signin\b|\/auth\b/.test(currentUrl)
    || /登录|未登录|sign in|login/i.test(title);
}

function reloadPeerLoginViewsAfterCookieSync(account, sourceView) {
  if (!account || !sourceView) return;
  const sourceKey = sourceView.cacheKey;
  const now = Date.now();
  for (const page of enabledPages(account)) {
    const key = viewCacheKey(account, page.page);
    if (key === sourceKey) continue;
    const view = views.get(key);
    if (!view || view.webContents.isDestroyed() || !looksLikeLoginPage(view)) continue;
    if (now - Number(view.lastCookieSyncReloadAt || 0) < 3000) continue;
    view.lastCookieSyncReloadAt = now;
    view.webContents.reload();
  }
}

async function bridgePopupAuthCookies(account, page, view) {
  if (!account || !page?.popup || !page.openerUrl || !page.url || !view || view.webContents.isDestroyed()) return false;
  if (!sameCookieBridgeFamily(page.openerUrl, page.url)) return false;
  try {
    const sourceUrl = normalizePopupUrl(page.openerUrl);
    const targetUrl = normalizePopupUrl(page.url);
    const cookies = await view.webContents.session.cookies.get({ url: sourceUrl });
    const authCookies = bridgeableCookies(cookies);
    if (!authCookies.length) return false;
    const results = await Promise.allSettled(authCookies.map((cookie) => setCookieForUrl(view.webContents.session, targetUrl, cookie)));
    return results.some((result) => result.status === 'fulfilled');
  } catch (error) {
    console.warn('[popup-auth-cookie-bridge]', error.message || error);
    return false;
  }
}

function shouldRetryPopupAfterAuthBridge(page, view) {
  if (!page?.popup || view.authCookieBridgeRetried || view.webContents.isDestroyed()) return false;
  const currentUrl = view.webContents.getURL() || '';
  const title = view.webContents.getTitle() || '';
  return /\/login\b|\/login\?|\/login$/.test(currentUrl) || title.includes('系统登录');
}

function accountManageUrl(account) {
  const managePage = (account?.pages || []).find((item) => item.enabled && item.page.includes('后台'));
  return managePage?.url || '';
}

function rewriteLocalManageRedirect(account, targetUrl) {
  const manageUrl = accountManageUrl(account);
  if (!manageUrl) return '';
  try {
    const target = new URL(targetUrl);
    const manage = new URL(manageUrl);
    if (target.origin === manage.origin) return '';
    if (target.pathname !== '/manage' && !target.pathname.startsWith('/manage/')) return '';
    if (target.hostname !== manage.hostname && !(isSharedHost(target.hostname) && isSharedHost(manage.hostname))) return '';
    const rewritten = new URL(`${target.pathname}${target.search}${target.hash}`, manage.origin);
    return rewritten.toString();
  } catch (_error) {
    return '';
  }
}

function redirectIfNeeded(account, page, view, event, targetUrl) {
  if (!page?.popup || !targetUrl || view.webContents.isDestroyed()) return false;
  const rewritten = rewriteLocalManageRedirect(account, targetUrl);
  if (!rewritten || rewritten === targetUrl) return false;
  event.preventDefault();
  view.webContents.loadURL(rewritten);
  return true;
}

function nextPopupPageName(account) {
  const usedNames = new Set(enabledPages(account).map((page) => page.page));
  let index = accountPopupPages(account).length + 1;
  let name = `弹出页 ${index}`;
  while (usedNames.has(name)) {
    index += 1;
    name = `弹出页 ${index}`;
  }
  return name;
}

function buildPopupPage(account, openerPage, targetUrl, openerUrl) {
  if (!account || !openerPage || !targetUrl) return null;
  const openerViewport = pageViewport(openerPage);
  const name = nextPopupPageName(account);
  return {
    enabled: true,
    env: account.env,
    account: account.account,
    profileKey: account.profileKey,
    page: name,
    url: targetUrl,
    popup: true,
    popupId: `popup-${Date.now().toString(36)}-${popupSeq += 1}`,
    parentPage: openerPage.page,
    openerUrl,
    model: {
      x: Number(openerPage.model?.x || 0) + 90,
      y: Number(openerPage.model?.y || 0) + 70,
      width: Math.max(DESKTOP_VIEWPORT.width, Number(openerViewport.width || DESKTOP_VIEWPORT.width)),
      height: Math.max(DESKTOP_VIEWPORT.height, Number(openerViewport.height || DESKTOP_VIEWPORT.height))
    }
  };
}

function registerPopupPage(account, page) {
  const key = accountCacheKey(account);
  const pages = shellState.popupPages[key] || [];
  shellState.popupPages[key] = [...pages, page];
  shellState.focusedPage = page.page;
  shellState.mode = 'focus';
}

function closePopupPage(pageName) {
  const account = currentAccount();
  if (!account) return false;
  const key = accountCacheKey(account);
  const pages = shellState.popupPages[key] || [];
  const page = pages.find((item) => item.page === pageName && item.popup);
  if (!page) return false;
  destroyView(viewCacheKey(account, page.page));
  shellState.popupPages[key] = pages.filter((item) => item !== page);
  delete shellState.pageZooms[pageZoomKey(page.page)];
  const remainingPages = enabledPages(account);
  if (shellState.focusedPage === page.page) {
    shellState.focusedPage = remainingPages[0]?.page || '';
    shellState.mode = remainingPages.length ? 'overview' : 'overview';
  }
  layoutViews();
  emitState();
  return true;
}

function getPageZoom(pageName) {
  return Number(shellState.pageZooms[pageZoomKey(pageName)] || 1);
}

function activeZoom() {
  if (shellState.mode === 'focus' && shellState.focusedPage) return getPageZoom(shellState.focusedPage);
  return Number(shellState.camera.zoom || 1);
}

function setActiveZoom(zoom) {
  const safeZoom = Math.max(0.35, Math.min(2.4, Number(zoom || 1)));
  if (shellState.mode === 'focus' && shellState.focusedPage) {
    shellState.pageZooms[pageZoomKey(shellState.focusedPage)] = safeZoom;
  } else {
    shellState.camera = {
      ...shellState.camera,
      zoom: safeZoom
    };
  }
  writeUiState();
  layoutViews();
  emitState();
  return safeZoom;
}

function setMobileMetrics(pageName, metrics = {}) {
  const env = currentEnv();
  const account = currentAccount();
  const page = enabledPages(account).find((item) => item.page === pageName);
  if (!env || !account || !page || !isMobilePage(page)) return false;

  const width = normalizeMobileDimension(metrics.width, MOBILE_VIEWPORT.width);
  const height = normalizeMobileDimension(metrics.height, MOBILE_VIEWPORT.height);

  saveCurrentViewState();
  const key = viewCacheKey(account, page.page);
  const rows = readConfigRows().map((row) => {
    if (row.env !== env.env || row.account !== account.account || row.page !== page.page) return row;
    return {
      ...row,
      width,
      height
    };
  });
  writeConfigRows(rows);
  destroyView(key);
  refreshEnvironments(env.env, account.account);
  shellState.focusedPage = page.page;
  shellState.mode = 'focus';
  restoreAccountViewState(currentAccount());
  shellState.focusedPage = page.page;
  shellState.mode = 'focus';
  ensureAccountViews();
  return { width, height };
}

function isMobilePage(page) {
  return Boolean(page?.mobileEmulation);
}

function pageViewport(page) {
  if (isMobilePage(page)) return mobileViewport(page);
  return {
    width: Math.max(DESKTOP_VIEWPORT.width, Number(page?.model?.width || 0)),
    height: Math.max(DESKTOP_VIEWPORT.height, Number(page?.model?.height || 0))
  };
}

function aspectFit(inner, outer) {
  const scale = Math.min(outer.width / inner.width, outer.height / inner.height);
  const width = inner.width * scale;
  const height = inner.height * scale;
  return {
    x: outer.x + (outer.width - width) / 2,
    y: outer.y + (outer.height - height) / 2,
    width,
    height,
    scale
  };
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea || { x: 0, y: 0, width: 1520, height: 980 };
  mainWindow = new BrowserWindow({
    x: workArea.x + 40,
    y: workArea.y + 40,
    width: Math.min(1520, Math.max(1100, workArea.width - 80)),
    height: Math.min(980, Math.max(720, workArea.height - 80)),
    minWidth: 1100,
    minHeight: 720,
    title: 'Multi Account Preview',
    backgroundColor: '#f8f6ef',
    center: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  console.log('Main window created', {
    visible: mainWindow.isVisible(),
    focused: mainWindow.isFocused(),
    bounds: mainWindow.getBounds(),
    workArea
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
    }, 1200);
    app.focus({ steal: true });
    console.log('Main window ready-to-show', {
      visible: mainWindow.isVisible(),
      focused: mainWindow.isFocused(),
      bounds: mainWindow.getBounds()
    });
  });
  mainWindow.on('resize', () => {
    layoutViews();
    emitState();
  });
  mainWindow.on('closed', () => {
    closeEmbeddedDevtools({ skipLayout: true, skipCloseTarget: true });
    for (const timer of autoFillTimers.values()) clearInterval(timer);
    autoFillTimers.clear();
    for (const timer of metricsTimers.values()) clearTimeout(timer);
    metricsTimers.clear();
    for (const timer of mobileRemTimers.values()) clearTimeout(timer);
    mobileRemTimers.clear();
    for (const view of views.values()) view.webContents.destroy();
    views.clear();
    mainWindow = null;
  });
}

function hideAllViews() {
  for (const view of views.values()) hideView(view);
  hideEmbeddedDevtools();
  shellState.viewFrames = [];
}

function ensureAccountViews() {
  const account = currentAccount();
  if (!account || !mainWindow) return;

  stopAutoFillTimers();
  hideAllViews();
  const pages = enabledPages(account);
  shellState.focusedPage = shellState.focusedPage || pages[0]?.page || '';

  for (const page of pages) {
    const key = viewCacheKey(account, page.page);
    const cachedView = views.get(key);
    if (cachedView && !cachedView.webContents.isDestroyed()) {
      cachedView.pageInfo = page;
      startCodeAutoFill(account, page, cachedView);
      continue;
    }

    const view = new BrowserView({
      webPreferences: {
        partition: account.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    view.pageInfo = page;
    view.cacheKey = key;
    if (isMobilePage(page)) {
      view.mobileBootLocked = true;
      view.webContents.setUserAgent(mobileUserAgent(page));
      applyMobileEmulation(view, page);
      applyMobilePreviewMetrics(view, 1);
    }
    mainWindow.addBrowserView(view);
    if (isMobilePage(page)) primeMobileViewBounds(view);
    views.set(key, view);

    const initialUrl = page.url;
    shellState.statuses[key] = {
      title: page.page,
      url: initialUrl,
      loading: true
    };
    view.webContents.loadURL(initialUrl);
    bindPageViewEvents(account, page, view, key);

    startCodeAutoFill(account, page, view);
  }

  layoutViews();
  emitState();
}

function bindPageViewEvents(account, page, view, key) {
  view.webContents.on('focus', () => {
    if (shellState.focusedPage === page.page && shellState.mode === 'focus') return;
    shellState.focusedPage = page.page;
    shellState.mode = 'focus';
    saveCurrentViewState();
    layoutViews();
    emitState();
  });
  view.webContents.on('did-start-loading', () => {
    if (isMobilePage(page)) {
      view.mobileBootLocked = true;
      primeMobileViewBounds(view);
    }
    shellState.statuses[key] = {
      ...(shellState.statuses[key] || {}),
      loading: true
    };
    emitState();
  });
  view.webContents.on('will-redirect', (event, url) => {
    redirectIfNeeded(account, page, view, event, event.url || url);
  });
  view.webContents.on('will-navigate', (event, url) => {
    redirectIfNeeded(account, page, view, event, event.url || url);
  });
  view.webContents.on('did-stop-loading', () => {
    if (isMobilePage(page)) {
      view.mobileBootLocked = false;
      applyMobilePreviewMetrics(view);
      layoutViews();
    }
    shellState.statuses[key] = {
      ...(shellState.statuses[key] || {}),
      title: view.webContents.getTitle() || page.page,
      url: view.webContents.getURL() || page.url,
      loading: false
    };
    queueViewMetrics(account, page, view, key);
    emitState();
    syncAccountCookies(account, page, view).then((synced) => {
      if (synced) reloadPeerLoginViewsAfterCookieSync(account, view);
    });
    if (shouldRetryPopupAfterAuthBridge(page, view)) {
      view.authCookieBridgeRetried = true;
      bridgePopupAuthCookies(account, page, view).then((bridged) => {
        if (bridged && !view.webContents.isDestroyed()) view.webContents.reload();
      });
    }
  });
  view.webContents.on('page-title-updated', (_event, title) => {
    shellState.statuses[key] = {
      ...(shellState.statuses[key] || {}),
      title
    };
    emitState();
  });
  view.webContents.on('context-menu', () => {
    if (!page.popup || !mainWindow || mainWindow.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      {
        label: `删除「${page.page}」`,
        click: () => closePopupPage(page.page)
      },
      { type: 'separator' },
      {
        label: '刷新',
        click: () => {
          if (!view.webContents.isDestroyed()) view.webContents.reload();
        }
      }
    ]);
    menu.popup({ window: mainWindow });
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    const openerUrl = view.webContents.getURL() || page.url;
    const targetUrl = normalizePopupUrl(url, openerUrl);
    if (!shouldOpenInWorkbench(targetUrl, openerUrl)) {
      shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    const popupPage = buildPopupPage(account, page, targetUrl, openerUrl);
    if (!popupPage) return { action: 'deny' };
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: account.partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      },
      createWindow: (options) => createPopupBrowserView(account, popupPage, options)
    };
  });
}

function createPopupBrowserView(account, page, options = {}) {
  const key = viewCacheKey(account, page.page);
  registerPopupPage(account, page);
  const view = options.webContents
    ? new WebContentsView({ webContents: options.webContents })
    : new BrowserView({
      webPreferences: {
        ...((options && options.webPreferences) || {}),
        partition: account.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
  view.usesContentView = Boolean(options.webContents);
  view.pageInfo = page;
  view.cacheKey = key;
  attachView(view);
  views.set(key, view);
  shellState.statuses[key] = {
    title: page.page,
    url: page.url,
    loading: true
  };
  bindPageViewEvents(account, page, view, key);
  layoutViews();
  emitState();
  return view.webContents;
}

function isLocalPreviewUrl(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '0.0.0.0'
      || Boolean(parsed.port);
  } catch (_error) {
    return false;
  }
}

function shouldAutoFillCode(_account, page) {
  return isMobilePage(page) && isLocalPreviewUrl(page?.url);
}

function startCodeAutoFill(account, page, view) {
  if (!shouldAutoFillCode(account, page)) return;
  const key = viewCacheKey(account, page.page);
  if (autoFillTimers.has(key)) return;
  updatePageStatus(account, page.page, {
    autoCode: '验证码助手：等待手机号和验证码输入框',
    autoCodeTone: 'idle'
  });
  autoFillCodeOnce(account, page, view).catch((error) => {
    updatePageStatus(account, page.page, {
      autoCode: `验证码助手：${error.message}`,
      autoCodeTone: 'error'
    });
  });
  const timer = setInterval(() => {
    autoFillCodeOnce(account, page, view).catch((error) => {
      updatePageStatus(account, page.page, {
        autoCode: `验证码助手：${error.message}`,
        autoCodeTone: 'error'
      });
    });
  }, 2000);
  autoFillTimers.set(key, timer);
}

function stopAutoFillTimers() {
  for (const timer of autoFillTimers.values()) clearInterval(timer);
  autoFillTimers.clear();
}

function updatePageStatus(account, pageName, patch) {
  const key = viewCacheKey(account, pageName);
  shellState.statuses[key] = {
    ...(shellState.statuses[key] || {}),
    ...patch
  };
  emitState();
}

async function autoFillCodeOnce(_suite, page, view) {
  if (view.webContents.isDestroyed()) return;
  const form = await inspectCodeLoginForm(view);
  if (!form?.ready) {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：未识别到验证码输入框',
      autoCodeTone: 'idle'
    });
    return;
  }
  if (form.codeValue) {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：验证码已填写',
      autoCodeTone: 'done'
    });
    return;
  }
  if (!form.phone || form.phone.length < 11) {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：等待输入 11 位手机号',
      autoCodeTone: 'idle'
    });
    return;
  }

  const record = await fetchLatestRedisCode(form.phone);
  if (!record?.code) {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：已识别手机号，等待 Redis 验证码',
      autoCodeTone: 'idle'
    });
    return;
  }

  const filled = await fillCodeInput(view, record.code);
  if (filled) {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：已自动填入验证码',
      autoCodeTone: 'done'
    });
  } else {
    updatePageStatus(_suite, page.page, {
      autoCode: '验证码助手：找到验证码，但写入输入框失败',
      autoCodeTone: 'error'
    });
  }
}

async function inspectCodeLoginForm(view) {
  return view.webContents.executeJavaScript(`
    (() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const directTextOf = (el) => {
        const label = el.closest('label')?.innerText || '';
        const previous = el.previousElementSibling?.innerText || '';
        const next = el.nextElementSibling?.innerText || '';
        return [
          el.placeholder,
          el.name,
          el.id,
          el.type,
          el.getAttribute('aria-label'),
          el.getAttribute('autocomplete'),
          label,
          previous,
          next
        ].filter(Boolean).join(' ');
      };
      const isPhoneInput = (input) => {
        const text = directTextOf(input);
        const digits = String(input.value || '').replace(/\\D/g, '');
        return digits.length === 11 || input.type === 'tel' || /手机号|手机|phone|tel|mobile/i.test(text);
      };
      const isCodeInput = (input) => {
        const text = directTextOf(input);
        if (/验证码|校验码|短信码|verify|verification|captcha|code|otp/i.test(text)) return true;
        const maxLength = Number(input.maxLength || 0);
        return (maxLength >= 4 && maxLength <= 8) && !isPhoneInput(input);
      };
      const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      const phoneInput = inputs.find(isPhoneInput) || inputs.find((input) => String(input.value || '').replace(/\\D/g, '').length === 11);
      let codeInput = inputs.find((input) => !isPhoneInput(input) && isCodeInput(input));
      if (!codeInput && phoneInput) {
        const phoneIndex = inputs.indexOf(phoneInput);
        codeInput = inputs.slice(phoneIndex + 1).find((input) => !isPhoneInput(input) && input.type !== 'hidden');
      }
      if (!codeInput && inputs.length >= 2) {
        codeInput = inputs.find((input, index) => input !== phoneInput && index > 0);
      }
      const phone = (phoneInput?.value || '').replace(/\\D/g, '');
      return {
        ready: Boolean(codeInput),
        phone,
        codeValue: codeInput?.value || '',
        url: location.href
      };
    })()
  `, true);
}

async function fillCodeInput(view, code) {
  return view.webContents.executeJavaScript(`
    ((code) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const directTextOf = (el) => {
        const label = el.closest('label')?.innerText || '';
        const previous = el.previousElementSibling?.innerText || '';
        const next = el.nextElementSibling?.innerText || '';
        return [
          el.placeholder,
          el.name,
          el.id,
          el.type,
          el.getAttribute('aria-label'),
          el.getAttribute('autocomplete'),
          label,
          previous,
          next
        ].filter(Boolean).join(' ');
      };
      const isPhoneInput = (input) => {
        const text = directTextOf(input);
        const digits = String(input.value || '').replace(/\\D/g, '');
        return digits.length === 11 || input.type === 'tel' || /手机号|手机|phone|tel|mobile/i.test(text);
      };
      const isCodeInput = (input) => {
        const text = directTextOf(input);
        if (/验证码|校验码|短信码|verify|verification|captcha|code|otp/i.test(text)) return true;
        const maxLength = Number(input.maxLength || 0);
        return (maxLength >= 4 && maxLength <= 8) && !isPhoneInput(input);
      };
      const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      const phoneInput = inputs.find(isPhoneInput);
      let input = inputs.find((item) => !isPhoneInput(item) && isCodeInput(item));
      if (!input && phoneInput) {
        const phoneIndex = inputs.indexOf(phoneInput);
        input = inputs.slice(phoneIndex + 1).find((item) => !isPhoneInput(item) && item.type !== 'hidden');
      }
      if (!input && inputs.length >= 2) {
        input = inputs.find((item, index) => item !== phoneInput && index > 0);
      }
      if (!input) return false;

      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, code);
      else input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      input.blur();
      return true;
    })(${JSON.stringify(code)})
  `, true);
}

function readRedisCodeConfig() {
  const fallback = {
    host: '127.0.0.1',
    port: 6381,
    database: 0,
    password: '',
    patterns: ['pf_verify_code:login:*'],
    maxKeys: 20
  };
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(redisCodeConfigFile, 'utf8')) };
  } catch (_error) {
    return fallback;
  }
}

async function fetchLatestRedisCode(phone) {
  const config = readRedisCodeConfig();
  const client = new RedisClient(config.host, Number(config.port || 6381));
  await client.connect();
  try {
    if (config.password) await client.command(['AUTH', config.password]);
    if (config.database !== undefined) await client.command(['SELECT', String(config.database)]);

    const records = [];
    const patterns = config.patterns?.length ? config.patterns : ['pf_verify_code:login:*'];
    const maxKeys = Number(config.maxKeys || 20);
    for (const pattern of patterns) {
      let cursor = '0';
      let loops = 0;
      do {
        const scan = await client.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(maxKeys)]);
        cursor = String(scan?.[0] || '0');
        const keys = Array.isArray(scan?.[1]) ? scan[1] : [];
        for (const key of keys) {
          const rawValue = await client.command(['GET', key]);
          const ttl = await client.command(['TTL', key]);
          const value = rawValue == null ? '' : String(rawValue);
          const code = extractCode(value);
          if (!code) continue;
          records.push({
            key,
            code,
            value,
            ttl: Number(ttl),
            source: key.split(':').pop() || 'Redis'
          });
          if (records.length >= maxKeys) break;
        }
        loops += 1;
      } while (cursor !== '0' && records.length < maxKeys && loops < 100);
    }

    const phoneDigits = String(phone || '').replace(/\\D/g, '');
    const candidates = phoneDigits
      ? records.filter((record) => record.key.includes(phoneDigits) || record.value.includes(phoneDigits))
      : records;
    candidates.sort((a, b) => {
      const ttlDiff = (b.ttl || 0) - (a.ttl || 0);
      if (ttlDiff !== 0) return ttlDiff;
      return b.key.localeCompare(a.key);
    });
    return candidates[0] || null;
  } finally {
    client.close();
  }
}

function extractCode(value) {
  const text = String(value || '');
  const jsonMatch = text.match(/"code"\\s*:\\s*"?([0-9]{4,8})"?/i);
  if (jsonMatch) return jsonMatch[1];
  const plainMatch = text.match(/(^|\\D)([0-9]{4,8})(\\D|$)/);
  return plainMatch?.[2] || '';
}

class RedisClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        resolve();
      });
      socket.setTimeout(1800);
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
      });
      socket.on('error', reject);
      socket.on('timeout', () => reject(new Error(`Redis 连接超时 ${this.host}:${this.port}`)));
    });
  }

  close() {
    this.socket?.destroy();
  }

  command(args) {
    return new Promise((resolve, reject) => {
      const encoded = encodeRedisCommand(args);
      const startedAt = Date.now();
      const tick = () => {
        try {
          const parsed = parseRedisReply(this.buffer, 0);
          if (parsed) {
            this.buffer = this.buffer.slice(parsed.nextIndex);
            if (parsed.value instanceof Error) reject(parsed.value);
            else resolve(parsed.value);
            return;
          }
          if (Date.now() - startedAt > 2000) {
            reject(new Error('Redis 响应超时'));
            return;
          }
          setTimeout(tick, 20);
        } catch (error) {
          reject(error);
        }
      };
      this.socket.write(encoded, (error) => {
        if (error) reject(error);
        else tick();
      });
    });
  }
}

function encodeRedisCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const text = String(arg);
    parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
  }
  return parts.join('');
}

function parseRedisReply(buffer, index) {
  if (index >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[index]);
  const lineEnd = buffer.indexOf('\r\n', index + 1, 'utf8');
  if (lineEnd < 0) return null;
  const line = buffer.slice(index + 1, lineEnd).toString('utf8');
  let nextIndex = lineEnd + 2;

  if (prefix === '+') return { value: line, nextIndex };
  if (prefix === '-') return { value: new Error(line), nextIndex };
  if (prefix === ':') return { value: Number(line), nextIndex };
  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, nextIndex };
    if (buffer.length < nextIndex + length + 2) return null;
    const value = buffer.slice(nextIndex, nextIndex + length).toString('utf8');
    return { value, nextIndex: nextIndex + length + 2 };
  }
  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, nextIndex };
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const parsed = parseRedisReply(buffer, nextIndex);
      if (!parsed) return null;
      items.push(parsed.value);
      nextIndex = parsed.nextIndex;
    }
    return { value: items, nextIndex };
  }
  throw new Error('Redis 响应格式异常');
}

function baseCanvasRect() {
  const side = sidebarWidth();
  if (!mainWindow) return { x: side + 20, y: TOOLBAR_HEIGHT + 10, width: 1000, height: 760 };
  const [width, height] = mainWindow.getContentSize();
  return {
    x: side + 20,
    y: TOOLBAR_HEIGHT + 10,
    width: Math.max(360, width - side - 44),
    height: Math.max(320, height - TOOLBAR_HEIGHT - 34)
  };
}

function devtoolsPanelWidth(rect) {
  if (!embeddedDevtoolsView) return 0;
  const maxWidth = Math.min(DEVTOOLS_MAX_WIDTH, Math.max(260, rect.width - 360));
  const minWidth = Math.min(DEVTOOLS_MIN_WIDTH, maxWidth);
  return Math.max(minWidth, Math.min(maxWidth, embeddedDevtoolsWidth));
}

function devtoolsRect() {
  const rect = baseCanvasRect();
  const width = devtoolsPanelWidth(rect);
  return {
    x: rect.x + rect.width - width,
    y: rect.y,
    width,
    height: rect.height
  };
}

function canvasRect() {
  const rect = baseCanvasRect();
  if (!embeddedDevtoolsView) return rect;
  const devtoolsWidth = devtoolsPanelWidth(rect);
  return {
    ...rect,
    width: Math.max(320, rect.width - devtoolsWidth - DEVTOOLS_GAP)
  };
}

function hideEmbeddedDevtools() {
  if (!embeddedDevtoolsView || embeddedDevtoolsView.webContents.isDestroyed()) return;
  embeddedDevtoolsView.setBounds({ x: -10000, y: -10000, width: 320, height: 240 });
}

function layoutEmbeddedDevtools() {
  if (!embeddedDevtoolsView || !embeddedDevtoolsTargetKey) return;
  const target = views.get(embeddedDevtoolsTargetKey);
  if (!target || target.webContents.isDestroyed()) {
    closeEmbeddedDevtools({ skipLayout: true });
    return;
  }
  embeddedDevtoolsView.setBounds(roundBounds(devtoolsRect()));
  if (typeof mainWindow.setTopBrowserView === 'function') {
    mainWindow.setTopBrowserView(embeddedDevtoolsView);
  }
}

function ensureEmbeddedDevtoolsView() {
  if (embeddedDevtoolsView && !embeddedDevtoolsView.webContents.isDestroyed()) return embeddedDevtoolsView;
  embeddedDevtoolsView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.addBrowserView(embeddedDevtoolsView);
  return embeddedDevtoolsView;
}

function closeEmbeddedDevtools(options = {}) {
  const target = views.get(embeddedDevtoolsTargetKey);
  if (target && !target.webContents.isDestroyed() && !options.skipCloseTarget && target.webContents.isDevToolsOpened()) {
    target.webContents.closeDevTools();
  }
  if (embeddedDevtoolsView && !embeddedDevtoolsView.webContents.isDestroyed()) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(embeddedDevtoolsView);
    embeddedDevtoolsView.webContents.destroy();
  }
  embeddedDevtoolsView = null;
  embeddedDevtoolsTargetKey = '';
  if (!options.skipLayout) {
    layoutViews();
    emitState();
  }
}

function toggleEmbeddedDevtools() {
  const view = activeView();
  if (!view || !mainWindow) return false;
  const key = view.cacheKey;
  if (embeddedDevtoolsView && embeddedDevtoolsTargetKey === key && view.webContents.isDevToolsOpened()) {
    closeEmbeddedDevtools();
    return true;
  }
  if (embeddedDevtoolsView) closeEmbeddedDevtools({ skipLayout: true });
  const devtoolsView = ensureEmbeddedDevtoolsView();
  embeddedDevtoolsTargetKey = key;
  view.webContents.setDevToolsWebContents(devtoolsView.webContents);
  view.webContents.once('devtools-closed', () => {
    if (embeddedDevtoolsTargetKey === key) closeEmbeddedDevtools({ skipCloseTarget: true });
  });
  view.webContents.openDevTools({ mode: 'detach', activate: false });
  layoutViews();
  emitState();
  return true;
}

function setEmbeddedDevtoolsWidth(width) {
  const rect = baseCanvasRect();
  const maxWidth = Math.min(DEVTOOLS_MAX_WIDTH, Math.max(260, rect.width - 360));
  const minWidth = Math.min(DEVTOOLS_MIN_WIDTH, maxWidth);
  const nextWidth = Number(width);
  if (!Number.isFinite(nextWidth)) return embeddedDevtoolsWidth;
  embeddedDevtoolsWidth = Math.max(minWidth, Math.min(maxWidth, nextWidth));
  layoutViews();
  emitState();
  return embeddedDevtoolsWidth;
}

function overviewModels(pages) {
  const hasMobile = pages.find((page) => page.page.includes('移动'));
  const desktopPages = pages.filter((page) => page !== hasMobile);
  const models = new Map();

  if (hasMobile) {
    models.set(hasMobile.page, { x: 0, y: 0, ...pageViewport(hasMobile) });
  }

  desktopPages.forEach((page, index) => {
    const viewport = pageViewport(page);
    models.set(page.page, {
      x: hasMobile ? 470 : 0,
      y: index * (viewport.height + 44),
      ...viewport
    });
  });

  if (!hasMobile) {
    pages.forEach((page, index) => {
      const viewport = pageViewport(page);
      models.set(page.page, {
        x: (index % 2) * (viewport.width + 44),
        y: Math.floor(index / 2) * (viewport.height + 44),
        ...viewport
      });
    });
  }

  return models;
}

function layoutViews() {
  if (!mainWindow) return;
  if (shellState.settingsOpen) {
    hideAllViews();
    emitState();
    return;
  }
  const account = currentAccount();
  const pages = enabledPages(account);
  const rect = canvasRect();
  const gap = 18;

  shellState.viewFrames = [];
  layoutEmbeddedDevtools();

  if (!pages.length) return;

  if (shellState.mode === 'focus' && shellState.focusedPage && views.has(viewCacheKey(account, shellState.focusedPage))) {
    const focusedPage = pages.find((page) => page.page === shellState.focusedPage);
    const focusIsMobile = isMobilePage(focusedPage);
    const focusedPageZoom = getPageZoom(focusedPage.page);
    const sideWidth = !shellState.previewFullscreen && focusIsMobile && pages.length > 1 ? 300 : 0;
    const focusArea = {
      x: rect.x,
      y: rect.y,
      width: rect.width - sideWidth - (sideWidth ? gap : 0),
      height: rect.height
    };
    const focusedViewport = pageViewport(focusedPage);
    const focusedFit = aspectFit(focusedViewport, focusArea);
    const mobileFitZoom = Math.max(0.25, Math.min(3.2, focusedFit.scale));
    const focusedZoom = shellState.previewFullscreen && !focusIsMobile
      ? Math.max(0.25, Math.min(1.8, focusedPageZoom))
      : focusIsMobile
      ? Math.max(0.25, Math.min(mobileFitZoom, focusedFit.scale * focusedPageZoom))
      : Math.max(0.25, Math.min(1.8, focusedFit.scale * focusedPageZoom));
    const focusedBounds = shellState.previewFullscreen && !focusIsMobile
      ? { ...focusArea, scale: focusedZoom }
      : clampBoundsToArea({
        ...focusedFit,
        width: focusedViewport.width * focusedZoom,
        height: focusedViewport.height * focusedZoom,
        x: focusArea.x + (focusArea.width - focusedViewport.width * focusedZoom) / 2,
        y: focusArea.y + (focusArea.height - focusedViewport.height * focusedZoom) / 2
      }, focusArea);

    for (const page of pages) {
      const view = views.get(viewCacheKey(account, page.page));
      if (!view) continue;
      if (page.page === shellState.focusedPage) {
        setVisibleViewBounds(page, view, focusedBounds, focusedZoom);
      } else {
        if (!sideWidth) {
          hideView(view);
          continue;
        }
        const others = pages.filter((item) => item.page !== shellState.focusedPage);
        const index = others.findIndex((item) => item.page === page.page);
        const itemHeight = Math.floor((rect.height - gap * (others.length - 1)) / Math.max(1, others.length));
        const thumbnailArea = {
          x: rect.x + rect.width - sideWidth,
          y: rect.y + index * (itemHeight + gap),
          width: sideWidth,
          height: itemHeight
        };
        const thumbnailBounds = clampBoundsToArea(aspectFit(pageViewport(page), thumbnailArea), thumbnailArea);
        setVisibleViewBounds(page, view, thumbnailBounds, thumbnailBounds.scale);
      }
    }
    return;
  }

  const models = overviewModels(pages);
  const bounds = Array.from(models.values()).reduce((acc, item) => ({
    minX: Math.min(acc.minX, item.x),
    minY: Math.min(acc.minY, item.y),
    maxX: Math.max(acc.maxX, item.x + item.width),
    maxY: Math.max(acc.maxY, item.y + item.height)
  }), { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  const fitScale = Math.min(rect.width / (bounds.maxX - bounds.minX), rect.height / (bounds.maxY - bounds.minY), 1);
  const scale = Math.max(0.35, Math.min(1.2, fitScale * shellState.camera.zoom));
  const groupWidth = (bounds.maxX - bounds.minX) * scale;
  const groupHeight = (bounds.maxY - bounds.minY) * scale;
  const rawOffsetX = rect.x + (rect.width - groupWidth) / 2 - shellState.camera.x * scale;
  const rawOffsetY = rect.y + (rect.height - groupHeight) / 2 - shellState.camera.y * scale;
  const offsetX = clampGroupOffset(rawOffsetX, groupWidth, rect.x, rect.width);
  const offsetY = clampGroupOffset(rawOffsetY, groupHeight, rect.y, rect.height);

  for (const page of pages) {
    const view = views.get(viewCacheKey(account, page.page));
    const model = models.get(page.page);
    if (!view || !model) continue;
    setVisibleViewBounds(page, view, {
      x: offsetX + model.x * scale,
      y: offsetY + model.y * scale,
      width: model.width * scale,
      height: model.height * scale
    }, scale);
  }
}

function setVisibleViewBounds(page, view, bounds, zoom) {
  const rounded = roundBounds(bounds);
  if (isMobilePage(page)) {
    const viewport = mobileViewport(page);
    const emulationKey = `${viewport.width}x${viewport.height}@${normalizeDeviceScaleFactor(page.deviceScaleFactor)}`;
    if (view.lastMobileEmulationKey !== emulationKey) {
      applyMobileEmulation(view, page);
      view.lastMobileEmulationKey = emulationKey;
    }
    if (view.mobileBootLocked) {
      primeMobileViewBounds(view);
    } else if (!sameBounds(view.lastBounds, rounded)) {
      view.setBounds(rounded);
      view.lastBounds = rounded;
      queueMobileRemSync(view, view.cacheKey);
    }
    if (!sameBounds(view.lastMetricBounds, rounded) || view.lastMobileScale !== zoom) {
      applyMobilePreviewMetrics(view, zoom);
      queueViewMetrics(currentAccount(), page, view, view.cacheKey);
      view.lastMetricBounds = rounded;
      view.lastMobileScale = zoom;
    }
  } else {
    if (!sameBounds(view.lastBounds, rounded)) {
      view.setBounds(rounded);
      view.lastBounds = rounded;
    }
    if (view.lastZoom !== zoom) {
      applyPreviewZoom(view, zoom);
      view.lastZoom = zoom;
    }
  }
  shellState.viewFrames.push({
    page: page.page,
    bounds: rounded,
    mobile: isMobilePage(page),
    focused: page.page === shellState.focusedPage
  });
}

function hideView(view) {
  view.setBounds({ x: -10000, y: -10000, width: 120, height: 100 });
  view.lastBounds = null;
  view.lastMetricBounds = null;
  applyPreviewZoom(view, 1);
}

function activeView() {
  const account = currentAccount();
  if (!account) return null;
  if (shellState.focusedPage) {
    const focused = views.get(viewCacheKey(account, shellState.focusedPage));
    if (focused) return focused;
  }
  for (const page of enabledPages(account)) {
    const view = views.get(viewCacheKey(account, page.page));
    if (view) return view;
  }
  return null;
}

function applyPreviewZoom(view, zoom) {
  const safeZoom = Math.max(0.25, Math.min(1.6, Number(zoom || 1)));
  view.webContents.setZoomFactor(safeZoom);
}

function applyMobilePreviewMetrics(view) {
  if (!view || view.webContents.isDestroyed()) return;
}

function primeMobileViewBounds(view) {
  view.setBounds({
    x: -10000,
    y: -10000,
    width: MOBILE_VIEWPORT.width,
    height: MOBILE_VIEWPORT.height
  });
  view.lastBounds = null;
  view.lastMetricBounds = null;
  view.lastMobileScale = null;
  view.lastMobileEmulationKey = null;
  applyMobilePreviewMetrics(view, 1);
}

function sameBounds(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function queueMobileRemSync(view, cacheKey) {
  if (!view || view.webContents.isDestroyed()) return;
  const key = cacheKey || view.cacheKey;
  if (!key) return;
  const existing = mobileRemTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    mobileRemTimers.delete(key);
    syncMobileRem(view);
  }, 80);
  mobileRemTimers.set(key, timer);
}

function syncMobileRem(view) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(`(() => {
    const html = document.documentElement;
    const width = html.clientWidth || window.innerWidth || 0;
    const height = html.clientHeight || window.innerHeight || 0;
    const baseScaleMap = { 1: 0.759, 2: 0.8795, 3: 1 };
    let viewportSizeSetting = '';
    try {
      viewportSizeSetting = window.localStorage ? window.localStorage.getItem('_producer_viewport_size_setting_') : '';
    } catch (_error) {
      viewportSizeSetting = '';
    }
    const settingKey = ['1', '2', '3'].includes(String(viewportSizeSetting)) ? String(viewportSizeSetting) : '';
    const viewScale = baseScaleMap[settingKey] || 1;
    const designRate = 750 / 1334;
    let remFontSize = 0;
    if (width && height) {
      remFontSize = width / height < designRate ? 100 * (width / 750) : 100 * (height / 1334);
    }
    window.__ORIGIN_REM_FONT_SIZE__ = remFontSize;
    if (remFontSize > 60) remFontSize = viewScale * remFontSize;
    window.__REM_FONT_SIZE__ = remFontSize || 50;
    html.style.fontSize = (remFontSize || 50) + 'px';
    return {
      width: Math.round(width),
      height: Math.round(height),
      rem: Number((remFontSize || 50).toFixed(2))
    };
  })()`, true).catch(() => {});
}

function queueViewMetrics(account, page, view, cacheKey) {
  if (!account || !isMobilePage(page) || !view || view.webContents.isDestroyed()) return;
  const key = cacheKey || viewCacheKey(account, page.page);
  const existing = metricsTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    metricsTimers.delete(key);
    collectViewMetrics(account, page, view, key);
  }, 180);
  metricsTimers.set(key, timer);
}

function collectViewMetrics(account, page, view, cacheKey) {
  if (!account || !isMobilePage(page) || !view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(`(() => ({
    innerWidth: Math.round(window.innerWidth || 0),
    innerHeight: Math.round(window.innerHeight || 0),
    dpr: Number((window.devicePixelRatio || 0).toFixed(2)),
    visualWidth: Math.round(window.visualViewport?.width || 0),
    visualHeight: Math.round(window.visualViewport?.height || 0),
    visualScale: Number((window.visualViewport?.scale || 1).toFixed(2))
  }))()`, true).then((metrics) => {
    const zoom = Number(view.webContents.getZoomFactor() || 1).toFixed(2);
    const visual = metrics.visualWidth && metrics.visualHeight
      ? ` · 可视 ${metrics.visualWidth}x${metrics.visualHeight}`
      : '';
    const key = cacheKey || viewCacheKey(account, page.page);
    shellState.statuses[key] = {
      ...(shellState.statuses[key] || {}),
      viewportInfo: `视口 ${metrics.innerWidth}x${metrics.innerHeight}${visual} · DPR ${metrics.dpr} · zoom ${zoom}`
    };
    emitState();
  }).catch(() => {});
}

function clampGroupOffset(offset, size, areaStart, areaSize) {
  const padding = 16;
  const min = areaStart + padding;
  const max = areaStart + areaSize - size - padding;
  if (size <= areaSize - padding * 2) {
    return Math.min(Math.max(offset, min), max);
  }
  return Math.max(offset, min);
}

function clampBoundsToArea(bounds, area) {
  const padding = 0;
  const maxX = area.x + area.width - padding;
  const maxY = area.y + area.height - padding;
  return {
    ...bounds,
    x: Math.max(area.x + padding, Math.min(bounds.x, maxX - Math.min(bounds.width, area.width))),
    y: Math.max(area.y + padding, Math.min(bounds.y, maxY - Math.min(bounds.height, area.height)))
  };
}

function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(120, Math.round(bounds.width)),
    height: Math.max(100, Math.round(bounds.height))
  };
}

function environmentsForClient() {
  return shellState.environments.map((env) => ({
    ...env,
    accounts: env.accounts.map((account) => ({
      ...account,
      pages: [
        ...account.pages,
        ...accountPopupPages(account).filter((page) => page.enabled)
      ]
    }))
  }));
}

function emitState() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('shell-state', {
    environments: environmentsForClient(),
    selectedEnv: shellState.selectedEnv,
    selectedAccount: shellState.selectedAccount,
    focusedPage: shellState.focusedPage,
    mode: shellState.mode,
    camera: { ...shellState.camera, zoom: activeZoom() },
    pageZooms: shellState.pageZooms,
    sidebarCollapsed: shellState.sidebarCollapsed,
    statuses: currentStatusMap(),
    viewFrames: shellState.viewFrames,
    devtoolsFrame: embeddedDevtoolsView ? roundBounds(devtoolsRect()) : null,
    settingsOpen: shellState.settingsOpen,
    previewFullscreen: shellState.previewFullscreen,
    configFile
  });
}

ipcMain.handle('state', () => {
  emitState();
  return true;
});

ipcMain.handle('select-env', (_event, envName) => {
  saveCurrentViewState();
  shellState.selectedEnv = envName;
  const env = currentEnv();
  shellState.selectedAccount = env?.accounts[0]?.account || '';
  restoreAccountViewState(currentAccount());
  writeUiState();
  ensureAccountViews();
});

ipcMain.handle('add-env', (_event, name) => addEnvironment(name));

ipcMain.handle('update-env', (_event, payload) => updateEnvironment(payload));

ipcMain.handle('delete-env', (_event, name) => deleteEnvironment(name));

ipcMain.handle('settings-open', (_event, open) => {
  shellState.settingsOpen = Boolean(open);
  layoutViews();
  emitState();
  return shellState.settingsOpen;
});

ipcMain.handle('show-env-menu', (_event, envName) => {
  const cleanName = normalizeLabel(envName || shellState.selectedEnv);
  const env = shellState.environments.find((item) => item.env === cleanName);
  if (!mainWindow || !env) return false;

  const menu = Menu.buildFromTemplate([
    {
      label: `编辑「${cleanName}」`,
      click: () => {
        mainWindow.webContents.send('env-settings-request', cleanName);
      }
    },
    {
      label: `删除「${cleanName}」`,
      enabled: shellState.environments.length > 1,
      click: () => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          buttons: ['删除', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '删除环境',
          message: `删除环境「${cleanName}」？`,
          detail: '会从左侧环境列表移除这个环境下的窗口配置。其他环境不受影响。'
        });
        if (choice !== 0) return;
        try {
          deleteEnvironment(cleanName);
        } catch (error) {
          dialog.showErrorBox('删除环境失败', error.message || String(error));
        }
      }
    }
  ]);
  menu.popup({ window: mainWindow });
  return true;
});

ipcMain.handle('select-account', (_event, accountName) => {
  saveCurrentViewState();
  shellState.selectedAccount = accountName;
  restoreAccountViewState(currentAccount());
  writeUiState();
  ensureAccountViews();
});

ipcMain.handle('add-account', (_event, name) => {
  const env = currentEnv();
  const source = currentAccount();
  if (!env || !source) return false;
  const rows = readConfigRows();
  const cleanName = normalizeLabel(name) || nextAccountName(env);
  if (env.accounts.some((account) => account.account === cleanName)) {
    throw new Error(`账号已存在：${cleanName}`);
  }
  const profileKey = `${env.env}:${cleanName}:${Date.now().toString(36)}`;
  for (const page of source.pages) {
    rows.push({
      enabled: page.enabled,
      env: env.env,
      account: cleanName,
      page: page.page,
      url: page.url,
      x: page.model.x,
      y: page.model.y,
      width: page.model.width,
      height: page.model.height,
      profileKey,
      userAgent: page.userAgent,
      deviceScaleFactor: page.deviceScaleFactor,
      mobileEmulation: page.mobileEmulation
    });
  }
  writeConfigRows(rows);
  refreshEnvironments(env.env, cleanName);
  shellState.focusedPage = '';
  shellState.mode = 'overview';
  ensureAccountViews();
  return true;
});

ipcMain.handle('rename-account', (_event, oldName, newName) => {
  const env = currentEnv();
  const cleanOldName = normalizeLabel(oldName || shellState.selectedAccount);
  const cleanNewName = normalizeLabel(newName);
  if (!env || !cleanOldName || !cleanNewName) return false;
  if (cleanOldName === cleanNewName) return true;
  if (env.accounts.some((account) => account.account === cleanNewName)) {
    throw new Error(`账号已存在：${cleanNewName}`);
  }
  saveCurrentViewState();
  const rows = readConfigRows().map((row) => {
    if (row.env !== env.env || row.account !== cleanOldName) return row;
    return {
      ...row,
      account: cleanNewName,
      profileKey: row.profileKey || `${env.env}:${cleanOldName}`
    };
  });
  writeConfigRows(rows);
  refreshEnvironments(env.env, cleanNewName);
  restoreAccountViewState(currentAccount());
  ensureAccountViews();
  return true;
});

ipcMain.handle('show-account-menu', (_event, accountName) => {
  const env = currentEnv();
  const cleanName = normalizeLabel(accountName);
  if (!mainWindow || !env || !cleanName) return false;

  const menu = Menu.buildFromTemplate([
    {
      label: `编辑「${cleanName}」`,
      click: () => {
        mainWindow.webContents.send('account-edit-request', cleanName);
      }
    },
    {
      label: `删除「${cleanName}」`,
      enabled: env.accounts.length > 1,
      click: () => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          buttons: ['删除', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '删除账号',
          message: `删除「${env.env} / ${cleanName}」？`,
          detail: '会从左侧账号列表移除这套窗口配置。其他账号不受影响。'
        });
        if (choice !== 0) return;
        try {
          deleteAccount(cleanName);
        } catch (error) {
          dialog.showErrorBox('删除账号失败', error.message || String(error));
        }
      }
    }
  ]);
  menu.popup({ window: mainWindow });
  return true;
});

ipcMain.handle('focus-page', (_event, pageName) => {
  shellState.focusedPage = pageName;
  shellState.mode = 'focus';
  saveCurrentViewState();
  layoutViews();
  emitState();
});

ipcMain.handle('mobile-metrics', (_event, pageName, metrics) => setMobileMetrics(pageName, metrics));

ipcMain.handle('overview', () => {
  shellState.mode = 'overview';
  saveCurrentViewState();
  layoutViews();
  emitState();
});

ipcMain.handle('close-popup-page', (_event, pageName) => closePopupPage(pageName));

ipcMain.handle('toggle-sidebar', () => {
  shellState.sidebarCollapsed = !shellState.sidebarCollapsed;
  writeUiState();
  layoutViews();
  emitState();
  return shellState.sidebarCollapsed;
});

ipcMain.handle('preview-fullscreen', (_event, fullscreen) => {
  shellState.previewFullscreen = Boolean(fullscreen);
  layoutViews();
  emitState();
  return shellState.previewFullscreen;
});

ipcMain.handle('canvas-camera', (_event, camera) => {
  const zoom = Number(camera.zoom || 1);
  if (shellState.mode === 'focus' && shellState.focusedPage) {
    shellState.pageZooms[pageZoomKey(shellState.focusedPage)] = zoom;
  } else {
    shellState.camera = {
      x: Number(camera.x || 0),
      y: Number(camera.y || 0),
      zoom
    };
  }
  saveCurrentViewState();
  layoutViews();
  emitState();
});

ipcMain.handle('devtools-width', (_event, width) => setEmbeddedDevtoolsWidth(width));

ipcMain.handle('show-zoom-menu', () => {
  if (!mainWindow) return false;
  const currentPercent = Math.round(activeZoom() * 100);
  const menu = Menu.buildFromTemplate(ZOOM_OPTIONS.map((percent) => ({
    label: `${percent}%`,
    type: 'radio',
    checked: percent === currentPercent,
    click: () => setActiveZoom(percent / 100)
  })));
  menu.popup({ window: mainWindow });
  return true;
});

ipcMain.handle('nav', (_event, action) => {
  const view = activeView();
  if (!view) return false;
  if (action === 'back' && view.webContents.canGoBack()) view.webContents.goBack();
  if (action === 'forward' && view.webContents.canGoForward()) view.webContents.goForward();
  if (action === 'reload') view.webContents.reload();
  if (action === 'home') view.webContents.loadURL(view.pageInfo.url);
  if (action === 'devtools') return toggleEmbeddedDevtools();
  return true;
});

app.whenReady().then(() => {
  const savedUiState = loadUiState();
  shellState.environments = readEnvironments();
  shellState.selectedEnv = shellState.environments.find((env) => env.env === savedUiState.selectedEnv)?.env
    || shellState.environments[0]?.env
    || '';
  const env = currentEnv();
  shellState.selectedAccount = env?.accounts.find((account) => account.account === savedUiState.selectedAccount)?.account
    || env?.accounts[0]?.account
    || '';
  restoreAccountViewState(currentAccount());
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => ensureAccountViews());
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
