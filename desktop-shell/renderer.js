let state = null;
let camera = { x: 0, y: 0, zoom: 1 };
let dragStart = null;
let devtoolsResizeStart = null;
let theme = localStorage.getItem('account-preview-canvas-theme') || 'dark';
let editingAccountName = '';
let editingAccountDraft = '';
let addingAccount = false;
let addingAccountDraft = '';
let addingAccountSaving = false;

const suiteList = document.querySelector('#suiteList');
const accountList = document.querySelector('#accountList');
const addAccountButton = document.querySelector('#addAccount');
const addEnvButton = document.querySelector('#addEnv');
const pageList = document.querySelector('#pageList');
const currentTitle = document.querySelector('#currentTitle');
const currentMode = document.querySelector('#currentMode');
const configFile = document.querySelector('#configFile');
const canvasSurface = document.querySelector('#canvasSurface');
const previewFrames = document.querySelector('#previewFrames');
const devtoolsResizer = document.querySelector('#devtoolsResizer');
const codeHelper = document.querySelector('#codeHelper');
const zoomLevel = document.querySelector('#zoomLevel');
const zoomPicker = document.querySelector('#zoomPicker');
const zoomMenuToggle = document.querySelector('#zoomMenuToggle');
const toggleSidebar = document.querySelector('#toggleSidebar');
const previewFullscreenButton = document.querySelector('#previewFullscreen');
const themeToggle = document.querySelector('#themeToggle');
const envSettings = document.querySelector('#envSettings');
const envSettingsForm = document.querySelector('#envSettingsForm');
const envNameInput = document.querySelector('#envNameInput');
const envPageRows = document.querySelector('#envPageRows');
const addEnvPageButton = document.querySelector('#addEnvPage');
const closeEnvSettings = document.querySelector('#closeEnvSettings');
const cancelEnvSettings = document.querySelector('#cancelEnvSettings');
const deleteEnvButton = document.querySelector('#deleteEnv');

applyTheme();

window.accountPreviewShell.onState((nextState) => {
  state = nextState;
  camera = nextState.camera || camera;
  render();
});

window.accountPreviewShell.getState();

window.accountPreviewShell.onEnvSettingsRequest((envName) => {
  if (envName && state?.selectedEnv !== envName) {
    window.accountPreviewShell.selectEnv(envName).then(() => window.setTimeout(() => openEnvSettings(), 80));
    return;
  }
  openEnvSettings();
});

window.accountPreviewShell.onAccountEditRequest((accountName) => {
  if (accountName) startRenameAccount(accountName);
});

function render() {
  if (!state) return;
  const selectedEnv = state.environments.find((env) => env.env === state.selectedEnv) || state.environments[0];
  const selectedAccount = selectedEnv?.accounts?.find((account) => account.account === state.selectedAccount) || selectedEnv?.accounts?.[0];
  const zoomPercent = Math.round((camera.zoom || 1) * 100);
  document.body.classList.toggle('sidebar-collapsed', Boolean(state.sidebarCollapsed));
  document.body.classList.toggle('preview-fullscreen', Boolean(state.previewFullscreen));
  toggleSidebar.textContent = state.sidebarCollapsed ? '›' : '‹';
  toggleSidebar.title = state.sidebarCollapsed ? '展开侧栏' : '收起侧栏';
  previewFullscreenButton.textContent = state.previewFullscreen ? '退出' : '全屏';
  previewFullscreenButton.title = state.previewFullscreen ? '退出右侧画布全屏' : '当前预览铺满右侧画布';
  updateThemeButton();
  currentTitle.textContent = selectedEnv && selectedAccount ? `${selectedEnv.env} · ${selectedAccount.account}` : '未选择';
  currentMode.textContent = state.mode === 'focus' ? `大预览：${state.focusedPage || ''} · ${zoomPercent}%` : `总览 · ${zoomPercent}%`;
  if (document.activeElement !== zoomLevel) syncZoomInput();
  configFile.textContent = state.configFile || '';
  renderPreviewFrames();

  suiteList.innerHTML = state.environments.map((env) => `
    <button class="suite ${env.env === state.selectedEnv ? 'active' : ''}" data-env="${escapeHtml(env.env)}" title="${escapeHtml(env.env)}">
      <span class="rail-letter">${escapeHtml(firstGlyph(env.env))}</span>
      <strong>${escapeHtml(env.env)}</strong>
      <span>${env.accounts.filter((account) => account.enabled).length} 个账号</span>
    </button>
  `).join('');

  const editingBelongsToSelectedEnv = Boolean(selectedEnv?.accounts?.some((account) => account.account === editingAccountName));
  const accountListIsEditing = Boolean(
    (editingAccountName && editingBelongsToSelectedEnv && accountList.querySelector('.account-edit')) ||
    (addingAccount && accountList.querySelector('.account-add-edit'))
  );
  if (!accountListIsEditing) {
    if (editingAccountName && !editingBelongsToSelectedEnv) {
      editingAccountName = '';
      editingAccountDraft = '';
    }
    renderAccountList(selectedEnv);
  }

  pageList.innerHTML = (selectedAccount?.pages || [])
    .filter((page) => page.enabled)
    .map((page) => {
    const status = state.statuses[page.page] || {};
    const active = page.page === state.focusedPage;
    const disabledText = page.enabled ? '' : '未启用 · ';
    const autoTone = status.autoCodeTone ? ` auto-${escapeHtml(status.autoCodeTone)}` : '';
    const mobile = isMobilePage(page);
    if (mobile) return renderMobilePageCard(page, status, active, disabledText, autoTone);
    return `
      <div class="page ${active ? 'active' : ''} ${page.enabled ? '' : 'disabled'} ${page.popup ? 'popup-page' : ''}" data-page="${escapeHtml(page.page)}" title="${escapeHtml(page.page)}" role="button" tabindex="${page.enabled ? '0' : '-1'}" aria-disabled="${page.enabled ? 'false' : 'true'}">
        <span class="rail-letter">${escapeHtml(firstGlyph(page.page))}</span>
        <strong>${escapeHtml(page.popup ? (status.title || page.page) : page.page)}</strong>
        <span>${disabledText}${escapeHtml(status.title || page.url)}</span>
        <span>${escapeHtml(status.loading ? '加载中' : (status.url || page.url))}</span>
        ${page.popup ? `<button type="button" class="page-close" data-page="${escapeHtml(page.page)}" title="关闭弹出页">×</button>` : ''}
      </div>
    `;
  }).join('');

  renderCodeHelper(selectedEnv, selectedAccount);

  suiteList.querySelectorAll('.suite').forEach((button) => {
    button.addEventListener('click', () => {
      editingAccountName = '';
      editingAccountDraft = '';
      window.accountPreviewShell.selectEnv(button.dataset.env);
    });
    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      openEnvSettings();
    });
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      editingAccountName = '';
      editingAccountDraft = '';
      if (state.selectedEnv !== button.dataset.env) {
        await window.accountPreviewShell.selectEnv(button.dataset.env);
      }
      window.accountPreviewShell.showEnvMenu(button.dataset.env);
    });
  });

  if (!accountListIsEditing) bindAccountListEvents();

  pageList.querySelectorAll('.page').forEach((button) => {
    button.addEventListener('click', () => {
      if (!button.classList.contains('disabled')) window.accountPreviewShell.focusPage(button.dataset.page);
    });
    button.addEventListener('keydown', (event) => {
      if (button.classList.contains('disabled')) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      window.accountPreviewShell.focusPage(button.dataset.page);
    });
  });

  pageList.querySelectorAll('.page-close').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.accountPreviewShell.closePopupPage(button.dataset.page);
    });
  });

  pageList.querySelectorAll('.mobile-metric-input').forEach((input) => {
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commitMobileMetrics(input.closest('.mobile-metrics-control'));
      }
      if (event.key === 'Escape') input.blur();
    });
  });

  pageList.querySelectorAll('.mobile-metrics-apply').forEach((button) => {
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commitMobileMetrics(button.closest('.mobile-metrics-control'));
    });
  });

}

function renderMobilePageCard(page, status, active, disabledText, autoTone) {
  const url = status.loading ? '加载中' : (status.url || page.url);
  const viewport = compactViewportInfo(status.viewportInfo);
  const width = Math.round(Number(page.model?.width || 375));
  const height = Math.round(Number(page.model?.height || 812));
  return `
    <div class="page mobile-page ${active ? 'active' : ''} ${page.enabled ? '' : 'disabled'}" data-page="${escapeHtml(page.page)}" title="${escapeHtml(page.page)}" role="button" tabindex="${page.enabled ? '0' : '-1'}" aria-disabled="${page.enabled ? 'false' : 'true'}">
      <span class="rail-letter">${escapeHtml(firstGlyph(page.page))}</span>
      <div class="mobile-page-head">
        <strong>${escapeHtml(page.page)}</strong>
      </div>
      <div class="mobile-metrics-control" data-page="${escapeHtml(page.page)}" aria-label="移动端窗口大小">
        <input class="mobile-metric-input" data-field="width" value="${escapeHtml(String(width))}" inputmode="numeric" aria-label="移动端窗口宽度" title="移动端窗口宽度">
        <span class="mobile-metric-sep">×</span>
        <input class="mobile-metric-input" data-field="height" value="${escapeHtml(String(height))}" inputmode="numeric" aria-label="移动端窗口高度" title="移动端窗口高度">
        <button type="button" class="mobile-metrics-apply" title="应用移动端窗口大小">应用</button>
      </div>
      <div class="mobile-page-main">
        <span class="page-subtitle">${disabledText}${escapeHtml(status.title || page.url)}</span>
        <span class="page-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      </div>
      <div class="mobile-page-side">
        ${viewport ? `<span class="viewport-status">${escapeHtml(viewport)}</span>` : ''}
        ${status.autoCode ? `<span class="auto-status${autoTone}">${escapeHtml(shortAutoCode(status.autoCode))}</span>` : ''}
      </div>
    </div>
  `;
}

function compactViewportInfo(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const viewport = raw.match(/视口\s*([0-9]+x[0-9]+)/)?.[1] || '';
  return viewport;
}

function commitMobileMetrics(control) {
  if (!control) return;
  const page = control.dataset.page;
  const width = control.querySelector('[data-field="width"]')?.value;
  const height = control.querySelector('[data-field="height"]')?.value;
  window.accountPreviewShell.setMobileMetrics(page, { width, height })
    .catch((error) => alert(error.message || '保存移动端窗口设置失败'));
}

function shortAutoCode(text) {
  return String(text || '').replace(/^验证码助手：?/, '').trim() || text;
}

function isMobilePage(page) {
  return Boolean(page?.mobileEmulation);
}

function mobileRouteFromUrl(url) {
  const text = String(url || '');
  const candidates = [text];
  try {
    candidates.push(decodeURIComponent(text));
  } catch (_error) {
    // The URL may already be plain text.
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
        // Relative redirect values can still be matched as raw text.
      }
    }
  } catch (_error) {
    // Relative or empty URL; fall back to plain text matching.
  }

  if (candidates.some((candidate) => candidate.includes('/easy/private/salesman'))) return 'salesman';
  if (candidates.some((candidate) => candidate.includes('/easy/private/home'))) return 'home';
  return '';
}

function renderPreviewFrames() {
  previewFrames.innerHTML = (state.viewFrames || []).map((frame) => {
    const bounds = frame.bounds || {};
    const pad = frame.mobile ? 9 : 7;
    const classes = [
      'preview-frame',
      frame.mobile ? 'mobile' : 'desktop',
      frame.focused ? 'focused' : ''
    ].filter(Boolean).join(' ');
    const style = [
      `left:${Number(bounds.x || 0) - pad}px`,
      `top:${Number(bounds.y || 0) - pad}px`,
      `width:${Number(bounds.width || 0) + pad * 2}px`,
      `height:${Number(bounds.height || 0) + pad * 2}px`
    ].join(';');
    return `<div class="${classes}" style="${style}" aria-hidden="true"></div>`;
  }).join('');
  renderDevtoolsResizer();
}

function renderDevtoolsResizer() {
  const frame = state.devtoolsFrame;
  if (!devtoolsResizer || !frame) {
    if (devtoolsResizer) devtoolsResizer.hidden = true;
    return;
  }
  const left = Number(frame.x || 0) - 5;
  devtoolsResizer.hidden = false;
  devtoolsResizer.style.left = `${left}px`;
  devtoolsResizer.style.top = `${Number(frame.y || 0)}px`;
  devtoolsResizer.style.height = `${Number(frame.height || 0)}px`;
}

function renderAccountList(selectedEnv) {
  const accountsHtml = (selectedEnv?.accounts || []).map((account) => {
    const editing = account.account === editingAccountName;
    return `
    <div class="account ${account.account === state.selectedAccount ? 'active' : ''}" data-account="${escapeHtml(account.account)}" title="${escapeHtml(account.account)}" role="button" tabindex="0">
      <span class="rail-letter">${escapeHtml(firstGlyph(account.account))}</span>
      ${editing
        ? `<input class="account-edit" value="${escapeHtml(editingAccountDraft || account.account)}" data-original="${escapeHtml(account.account)}" aria-label="账号名称">`
        : `<strong class="account-name" title="双击改名，回车保存">${escapeHtml(account.account)}</strong>`}
      <span>${account.pages.filter((page) => page.enabled && !page.popup).length} 个启用窗口</span>
    </div>
  `;
  }).join('');
  const addHtml = addingAccount ? `
    <div class="account account-add-row">
      <input class="account-add-edit" value="${escapeHtml(addingAccountDraft || nextAccountName(selectedEnv))}" aria-label="新账号名称" ${addingAccountSaving ? 'disabled' : ''}>
      <div class="account-add-actions">
        <button type="button" class="account-add-save" ${addingAccountSaving ? 'disabled' : ''}>${addingAccountSaving ? '保存中' : '保存'}</button>
        <button type="button" class="account-add-cancel" ${addingAccountSaving ? 'disabled' : ''}>取消</button>
      </div>
    </div>
  ` : '';
  accountList.innerHTML = accountsHtml + addHtml;
}

function bindAccountListEvents() {
  accountList.querySelectorAll('.account:not(.account-add-row)').forEach((button) => {
    button.addEventListener('click', () => {
      if (!editingAccountName && !addingAccount) window.accountPreviewShell.selectAccount(button.dataset.account);
    });
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (editingAccountName || addingAccount) return;
      if (state.selectedAccount !== button.dataset.account) {
        await window.accountPreviewShell.selectAccount(button.dataset.account);
      }
      window.accountPreviewShell.showAccountMenu(button.dataset.account);
    });
    button.addEventListener('keydown', (event) => {
      if (editingAccountName || addingAccount) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        window.accountPreviewShell.selectAccount(button.dataset.account);
      }
    });
  });

  accountList.querySelectorAll('.account-name').forEach((label) => {
    label.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const accountButton = label.closest('.account');
      if (accountButton) startRenameAccount(accountButton.dataset.account);
    });
  });

  accountList.querySelectorAll('.account-edit').forEach((input) => {
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('contextmenu', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
      editingAccountDraft = input.value;
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRenameAccount(input.dataset.original, input.value);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelRenameAccount();
      }
    });
  });

  const addInput = accountList.querySelector('.account-add-edit');
  if (addInput) {
    addInput.addEventListener('mousedown', (event) => event.stopPropagation());
    addInput.addEventListener('click', (event) => event.stopPropagation());
    addInput.addEventListener('contextmenu', (event) => event.stopPropagation());
    addInput.addEventListener('input', () => {
      addingAccountDraft = addInput.value;
    });
    addInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        saveNewAccount(addInput.value);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelAddAccount();
      }
    });
    accountList.querySelector('.account-add-save')?.addEventListener('click', (event) => {
      event.stopPropagation();
      saveNewAccount(addInput.value);
    });
    accountList.querySelector('.account-add-cancel')?.addEventListener('click', (event) => {
      event.stopPropagation();
      cancelAddAccount();
    });
  }
}

function renderCodeHelper(selectedEnv, selectedAccount) {
  const mobilePage = selectedAccount?.pages?.find((page) => page.enabled && page.page.includes('移动'));
  const mobileStatus = mobilePage ? (state.statuses[mobilePage.page] || {}) : {};
  const enabled = mobilePage && isLocalPreviewUrl(mobilePage.url);
  const text = enabled
    ? (mobileStatus.autoCode || '验证码助手：等待移动端加载')
    : '验证码助手：仅本地移动端地址启用';
  const tone = enabled ? (mobileStatus.autoCodeTone || 'idle') : 'off';

  codeHelper.innerHTML = `
    <h2>验证码助手</h2>
    <div class="helper-card auto-${escapeHtml(tone)}">
      <strong>${enabled ? '本地 Redis 自动填码' : '未启用'}</strong>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function isLocalPreviewUrl(url) {
  try {
    const parsed = new URL(normalizeDisplayUrl(url));
    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '0.0.0.0'
      || Boolean(parsed.port);
  } catch (_error) {
    return false;
  }
}

function normalizeDisplayUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function firstGlyph(value) {
  return Array.from(String(value ?? '').trim())[0] || '?';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

document.querySelector('#back').addEventListener('click', () => window.accountPreviewShell.nav('back'));
document.querySelector('#forward').addEventListener('click', () => window.accountPreviewShell.nav('forward'));
document.querySelector('#reload').addEventListener('click', () => window.accountPreviewShell.nav('reload'));
document.querySelector('#home').addEventListener('click', () => window.accountPreviewShell.nav('home'));
document.querySelector('#overview').addEventListener('click', () => window.accountPreviewShell.overview());
document.querySelector('#devtools').addEventListener('click', () => window.accountPreviewShell.nav('devtools'));
toggleSidebar.addEventListener('click', () => window.accountPreviewShell.toggleSidebar());
previewFullscreenButton.addEventListener('click', () => setPreviewFullscreen(!state?.previewFullscreen));
addAccountButton.addEventListener('click', startAddAccount);
addEnvButton.addEventListener('click', addEnvironment);
closeEnvSettings.addEventListener('click', closeEnvironmentSettings);
cancelEnvSettings.addEventListener('click', closeEnvironmentSettings);
envSettings.addEventListener('mousedown', (event) => {
  if (event.target === envSettings) closeEnvironmentSettings();
});
envSettingsForm.addEventListener('submit', saveEnvironmentSettings);
addEnvPageButton.addEventListener('click', () => addEnvironmentPageRow());
deleteEnvButton.addEventListener('click', deleteCurrentEnvironment);
themeToggle.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('account-preview-canvas-theme', theme);
  applyTheme();
});

async function addEnvironment() {
  const defaultName = nextEnvironmentName();
  try {
    await window.accountPreviewShell.addEnv(defaultName);
    window.setTimeout(() => openEnvSettings(), 80);
  } catch (error) {
    alert(error.message || '新增环境失败');
  }
}

function nextEnvironmentName() {
  const names = new Set((state?.environments || []).map((env) => env.env));
  let index = names.size + 1;
  while (names.has(`环境${index}`)) index += 1;
  return `环境${index}`;
}

async function openEnvSettings() {
  const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
  const selectedAccount = selectedEnv?.accounts?.find((account) => account.account === state.selectedAccount) || selectedEnv?.accounts?.[0];
  if (!selectedEnv || !selectedAccount) return;
  envNameInput.value = selectedEnv.env;
  envPageRows.innerHTML = selectedAccount.pages
    .filter((page) => !page.popup)
    .map((page) => renderEnvironmentPageRow(page))
    .join('');
  bindEnvironmentPageRows();
  try {
    await window.accountPreviewShell.setSettingsOpen(true);
  } catch (_error) {
    // The modal can still be shown; this only affects BrowserView shielding.
  }
  envSettings.hidden = false;
  requestAnimationFrame(() => {
    envNameInput.focus();
    envNameInput.select();
  });
}

function renderEnvironmentPageRow(page = {}) {
  const mobile = Boolean(page.mobileEmulation);
  return `
    <div class="env-page-row ${mobile ? 'is-mobile' : ''}" data-original-page="${escapeHtml(page.originalPage ?? page.page ?? '')}">
      <input class="env-page-name" value="${escapeHtml(page.page || '')}" aria-label="窗口名称" placeholder="窗口名称">
      <input class="env-page-url" value="${escapeHtml(page.url || '')}" aria-label="窗口地址" placeholder="https://example.com/path">
      <label title="启用移动设备模拟">
        <input class="env-page-mobile" type="checkbox" ${mobile ? 'checked' : ''} aria-label="移动设备模拟">
      </label>
      <label title="启用窗口">
        <input class="env-page-enabled" type="checkbox" ${page.enabled === false ? '' : 'checked'} aria-label="启用窗口">
      </label>
      <button type="button" class="env-page-delete" title="删除窗口">×</button>
    </div>
  `;
}

function bindEnvironmentPageRows() {
  envPageRows.querySelectorAll('.env-page-delete').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      if (envPageRows.querySelectorAll('.env-page-row').length <= 1) {
        alert('环境至少需要保留 1 个窗口');
        return;
      }
      button.closest('.env-page-row')?.remove();
    });
  });
  envPageRows.querySelectorAll('.env-page-mobile').forEach((input) => {
    if (input.dataset.bound) return;
    input.dataset.bound = 'true';
    input.addEventListener('change', () => {
      input.closest('.env-page-row')?.classList.toggle('is-mobile', input.checked);
    });
  });
}

function addEnvironmentPageRow() {
  const names = new Set(Array.from(envPageRows.querySelectorAll('.env-page-name'))
    .map((input) => input.value.trim())
    .filter(Boolean));
  let index = names.size + 1;
  while (names.has(`窗口${index}`)) index += 1;
  envPageRows.insertAdjacentHTML('beforeend', renderEnvironmentPageRow({
    originalPage: '',
    page: `窗口${index}`,
    url: '',
    enabled: true,
    mobileEmulation: false
  }));
  bindEnvironmentPageRows();
  const lastRow = envPageRows.querySelector('.env-page-row:last-child');
  lastRow?.querySelector('.env-page-name')?.focus();
}

function closeEnvironmentSettings() {
  envSettings.hidden = true;
  window.accountPreviewShell.setSettingsOpen(false).catch(() => {});
}

async function saveEnvironmentSettings(event) {
  event.preventDefault();
  const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
  if (!selectedEnv) return;
  const pages = Array.from(envPageRows.querySelectorAll('.env-page-row')).map((row) => ({
    originalPage: row.dataset.originalPage,
    page: row.querySelector('.env-page-name').value.trim(),
    url: row.querySelector('.env-page-url').value.trim(),
    mobileEmulation: row.querySelector('.env-page-mobile').checked,
    enabled: row.querySelector('.env-page-enabled').checked
  }));
  try {
    await window.accountPreviewShell.updateEnv({
      oldName: selectedEnv.env,
      name: envNameInput.value.trim(),
      pages
    });
    closeEnvironmentSettings();
  } catch (error) {
    alert(error.message || '保存环境失败');
  }
}

async function deleteCurrentEnvironment() {
  const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
  if (!selectedEnv) return;
  if (!window.confirm(`删除环境「${selectedEnv.env}」？`)) return;
  try {
    await window.accountPreviewShell.deleteEnv(selectedEnv.env);
    closeEnvironmentSettings();
  } catch (error) {
    alert(error.message || '删除环境失败');
  }
}

function startAddAccount() {
  if (addingAccountSaving) return;
  const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
  editingAccountName = '';
  editingAccountDraft = '';
  addingAccount = true;
  addingAccountDraft = nextAccountName(selectedEnv);
  render();
  requestAnimationFrame(() => {
    const input = accountList.querySelector('.account-add-edit');
    input?.focus();
    input?.select();
  });
}

function cancelAddAccount() {
  if (addingAccountSaving) return;
  addingAccount = false;
  addingAccountDraft = '';
  render();
}

async function saveNewAccount(name) {
  if (addingAccountSaving) return;
  const cleanName = name.trim();
  if (!cleanName) return;
  addingAccountSaving = true;
  const addInput = accountList.querySelector('.account-add-edit');
  const saveButton = accountList.querySelector('.account-add-save');
  const cancelButton = accountList.querySelector('.account-add-cancel');
  if (addInput) addInput.disabled = true;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中';
  }
  if (cancelButton) cancelButton.disabled = true;
  try {
    await window.accountPreviewShell.addAccount(cleanName);
    addingAccount = false;
    addingAccountDraft = '';
    render();
  } catch (error) {
    const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
    const alreadyExists = selectedEnv?.accounts?.some((account) => account.account === cleanName);
    if (alreadyExists && String(error.message || '').includes('账号已存在')) {
      addingAccount = false;
      addingAccountDraft = '';
      await window.accountPreviewShell.selectAccount(cleanName);
      return;
    }
    alert(error.message || '新增账号失败');
  } finally {
    addingAccountSaving = false;
    render();
  }
}

function startRenameAccount(oldName) {
  editingAccountName = oldName;
  editingAccountDraft = oldName;
  render();
  requestAnimationFrame(() => {
    const input = accountList.querySelector('.account-edit');
    input?.focus();
    input?.select();
  });
}

function cancelRenameAccount() {
  editingAccountName = '';
  editingAccountDraft = '';
  render();
}

async function commitRenameAccount(oldName, nextName) {
  if (!editingAccountName) return;
  const cleanName = String(nextName || '').trim();
  editingAccountName = '';
  editingAccountDraft = '';
  if (!cleanName || cleanName === oldName) {
    render();
    return;
  }
  try {
    await window.accountPreviewShell.renameAccount(oldName, cleanName);
  } catch (error) {
    render();
    alert(error.message || '账号改名失败');
  }
}

function nextAccountName(env) {
  const names = new Set((env?.accounts || []).map((account) => account.account));
  let index = names.size + 1;
  while (names.has(`账号${index}`)) index += 1;
  return `账号${index}`;
}
document.querySelector('#zoomIn').addEventListener('click', () => setZoom((camera.zoom || 1) * 1.12));
document.querySelector('#zoomOut').addEventListener('click', () => setZoom((camera.zoom || 1) / 1.12));
zoomMenuToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  closeZoomMenu();
  window.accountPreviewShell.showZoomMenu();
});
zoomLevel.addEventListener('focus', () => zoomLevel.select());
zoomLevel.addEventListener('change', commitZoomInput);
zoomLevel.addEventListener('blur', commitZoomInput);
zoomLevel.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    commitZoomInput();
    zoomLevel.blur();
  }
  if (event.key === 'Escape') {
    closeZoomMenu();
    syncZoomInput();
    zoomLevel.blur();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!zoomPicker.contains(event.target)) closeZoomMenu();
});

if (devtoolsResizer) {
  devtoolsResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state?.devtoolsFrame) return;
    event.preventDefault();
    event.stopPropagation();
    devtoolsResizeStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: Number(state.devtoolsFrame.width || 0)
    };
    document.body.classList.add('devtools-resizing');
    devtoolsResizer.classList.add('active');
    devtoolsResizer.setPointerCapture(event.pointerId);
  });

  devtoolsResizer.addEventListener('pointermove', (event) => {
    if (!devtoolsResizeStart) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = devtoolsResizeStart.x - event.clientX;
    window.accountPreviewShell.setDevtoolsWidth(devtoolsResizeStart.width + delta);
  });

  const stopDevtoolsResize = (event) => {
    if (!devtoolsResizeStart) return;
    const pointerId = devtoolsResizeStart.pointerId;
    devtoolsResizeStart = null;
    document.body.classList.remove('devtools-resizing');
    devtoolsResizer.classList.remove('active');
    if (devtoolsResizer.hasPointerCapture(pointerId)) devtoolsResizer.releasePointerCapture(pointerId);
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  devtoolsResizer.addEventListener('pointerup', stopDevtoolsResize);
  devtoolsResizer.addEventListener('pointercancel', stopDevtoolsResize);
}

function setZoom(zoom) {
  camera.zoom = Math.max(0.35, Math.min(2.4, zoom));
  syncZoomInput();
  closeZoomMenu();
  window.accountPreviewShell.setCamera(camera);
}

function setPreviewFullscreen(fullscreen) {
  window.accountPreviewShell.setPreviewFullscreen(Boolean(fullscreen));
}

function commitZoomInput() {
  const zoom = parseZoomInput(zoomLevel.value);
  if (!zoom) {
    syncZoomInput();
    return;
  }
  setZoom(zoom);
}

function parseZoomInput(value) {
  const match = String(value ?? '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const percent = Number(match[0]);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return percent / 100;
}

function syncZoomInput() {
  zoomLevel.value = `${Math.round((camera.zoom || 1) * 100)}%`;
}

function closeZoomMenu() {
  zoomPicker.classList.remove('open');
  zoomMenuToggle.setAttribute('aria-expanded', 'false');
}

function applyTheme() {
  document.body.classList.toggle('theme-dark', theme === 'dark');
  updateThemeButton();
}

function updateThemeButton() {
  if (!themeToggle) return;
  const dark = theme === 'dark';
  themeToggle.textContent = dark ? '亮' : '暗';
  themeToggle.title = dark ? '切换到亮色模式' : '切换到暗黑模式';
}

canvasSurface.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest?.('#devtoolsResizer')) return;
  dragStart = { x: event.clientX, y: event.clientY, camera: { ...camera } };
  canvasSurface.classList.add('dragging');
  canvasSurface.setPointerCapture(event.pointerId);
});

canvasSurface.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  const zoom = camera.zoom || 1;
  camera = {
    ...camera,
    x: dragStart.camera.x - (event.clientX - dragStart.x) / zoom,
    y: dragStart.camera.y - (event.clientY - dragStart.y) / zoom
  };
  window.accountPreviewShell.setCamera(camera);
});

canvasSurface.addEventListener('pointerup', (event) => {
  dragStart = null;
  canvasSurface.classList.remove('dragging');
  canvasSurface.releasePointerCapture(event.pointerId);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state?.previewFullscreen) {
    setPreviewFullscreen(false);
    return;
  }
  if (event.key === 'Escape') window.accountPreviewShell.overview();
  if ((event.metaKey || event.ctrlKey) && ['1', '2', '3', '4'].includes(event.key)) {
    const index = Number(event.key) - 1;
    const selectedEnv = state?.environments.find((env) => env.env === state.selectedEnv);
    const selectedAccount = selectedEnv?.accounts.find((account) => account.account === state.selectedAccount);
    const page = selectedAccount?.pages.filter((item) => item.enabled)[index];
    if (page) window.accountPreviewShell.focusPage(page.page);
  }
});
