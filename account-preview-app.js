#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const toolDir = __dirname;
const stateDir = process.env.ACCOUNT_PREVIEW_HOME || path.join(process.env.HOME, '.account-preview-workbench');
const configFile = process.env.ACCOUNT_PREVIEW_CONFIG || path.join(stateDir, 'accounts.tsv');
const profileDir = path.join(stateDir, 'profiles');
const scriptFile = path.join(toolDir, 'preview-accounts.sh');
const appFile = path.join(toolDir, 'account-preview-app.html');
const port = Number(process.env.ACCOUNT_PREVIEW_PORT || 57123);

function ensureState() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
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

function samplePresetConfig() {
  return [
    '# enabled\tenv\taccount\tpage\turl\tx\ty\twidth\theight\tprofileKey\tuserAgent\tdeviceScaleFactor\tmobileEmulation',
    'yes\t生产示例\t默认账号\t移动端\thttps://m.example.com/easy/\t40\t80\t375\t812\t生产示例:默认账号\t\t\tyes',
    'yes\t生产示例\t默认账号\t后台\thttps://admin.example.com/manage/\t500\t80\t1440\t820\t生产示例:默认账号\t\t\tno',
    'yes\t生产示例\t默认账号\t收银台\thttps://cashier.example.com/\t1980\t80\t1440\t820\t生产示例:默认账号\t\t\tno',
    'yes\t测试示例\t默认账号\t移动端\thttps://test-m.example.com/easy/\t40\t940\t375\t812\t测试示例:默认账号\t\t\tyes',
    'yes\t测试示例\t默认账号\t后台\thttps://test-admin.example.com/manage/\t500\t940\t1440\t820\t测试示例:默认账号\t\t\tno',
    'yes\t本地示例\t默认账号\t移动端\thttp://localhost:3009/easy/\t40\t1800\t375\t812\t本地示例:默认账号\t\t\tyes',
    'yes\t本地示例\t默认账号\t后台\thttp://localhost:3000/manage/\t500\t1800\t1440\t820\t本地示例:默认账号\t\t\tno',
    ''
  ].join('\n');
}

function readConfigText() {
  ensureState();
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, defaultConfig(), 'utf8');
  }
  return fs.readFileSync(configFile, 'utf8');
}

function parseConfig(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length >= 9) {
        const [enabled, env, account, page, url, x, y, width, height, profileKey] = parts;
        return { enabled, env, account, suite: `${env}/${account}`, profileKey: profileKey || `${env}:${account}`, page, url, x, y, width, height };
      }
      const [enabled, suite, page, url, x, y, width, height] = parts;
      return { enabled, env: suite, account: '默认账号', suite: `${suite}/默认账号`, profileKey: `${suite}:默认账号`, page, url, x, y, width, height };
    })
    .filter((row) => row.suite && row.page && row.url);
}

function groupedSuites(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.suite)) {
      groups.set(row.suite, { suite: row.suite, profileKey: row.profileKey || row.suite, enabled: false, pages: [] });
    }
    const group = groups.get(row.suite);
    group.enabled = group.enabled || row.enabled === 'yes';
    group.pages.push(row);
  }
  return Array.from(groups.values());
}

function slugify(raw) {
  const ascii = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 8);
  return ascii ? `${ascii}-${hash}` : `suite-${hash}`;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    execFile(scriptFile, args, { cwd: path.dirname(toolDir), env: process.env }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extractUrls(text) {
  return Array.from(new Set(String(text).match(/https?:\/\/[^\s，。；,;]+/g) || []));
}

function detectSuiteCount(text) {
  const raw = String(text);
  const direct = raw.match(/(\d+)\s*套/);
  if (direct) return Math.max(1, Math.min(12, Number(direct[1])));
  if (/三套|三组|三个/.test(raw)) return 3;
  if (/两套|两组|两个|二套/.test(raw)) return 2;
  return 3;
}

function buildConfigFromPrompt(prompt) {
  const urls = extractUrls(prompt);
  const count = detectSuiteCount(prompt);
  const mobileUrl = urls.find((url) => /\/\/m\.|mobile|h5|wap/i.test(url)) || urls[0] || 'https://m.example.com';
  const webUrl = urls.find((url) => url !== mobileUrl) || urls[1] || 'https://example.com';
  const names = ['A套账号', 'B套账号', 'C套账号', 'D套账号', 'E套账号', 'F套账号', 'G套账号', 'H套账号', 'I套账号', 'J套账号', 'K套账号', 'L套账号'];
  const rows = ['# enabled\tenv\taccount\tpage\turl\tx\ty\twidth\theight\tprofileKey'];

  for (let index = 0; index < count; index += 1) {
    const y = 80 + index * 860;
    const account = names[index];
    const profileKey = `自定义环境:${account}`;
    rows.push(`yes\t自定义环境\t${account}\t移动端\t${mobileUrl}\t40\t${y}\t430\t820\t${profileKey}`);
    rows.push(`yes\t自定义环境\t${account}\tWeb端\t${webUrl}\t500\t${y}\t980\t820\t${profileKey}`);
  }

  rows.push('');
  return rows.join('\n');
}

async function handleApi(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/api/state') {
      const text = readConfigText();
      const rows = parseConfig(text);
      const suites = groupedSuites(rows).map((suite) => ({
        ...suite,
        profile: slugify(suite.profileKey || suite.suite),
        profilePath: path.join(profileDir, slugify(suite.profileKey || suite.suite)),
        profileExists: fs.existsSync(path.join(profileDir, slugify(suite.profileKey || suite.suite)))
      }));
      json(res, 200, { configFile, stateDir, text, suites });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/config') {
      const body = await readBody(req);
      if (typeof body.text !== 'string') {
        json(res, 400, { error: 'Missing config text' });
        return;
      }
      ensureState();
      fs.writeFileSync(configFile, body.text.endsWith('\n') ? body.text : `${body.text}\n`, 'utf8');
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/launch') {
      const body = await readBody(req);
      const args = body.suite ? ['start', body.suite] : ['start'];
      const result = await runScript(args);
      json(res, 200, { ok: true, output: result.stdout || result.stderr });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/reset') {
      const body = await readBody(req);
      if (!body.suite) {
        json(res, 400, { error: 'Missing suite' });
        return;
      }
      const result = await runScript(['reset', body.suite]);
      json(res, 200, { ok: true, output: result.stdout || result.stderr });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai-config') {
      const body = await readBody(req);
      const text = buildConfigFromPrompt(body.prompt || '');
      json(res, 200, { text });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/sample-preset') {
      const text = samplePresetConfig();
      ensureState();
      if (fs.existsSync(configFile)) {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
        fs.copyFileSync(configFile, `${configFile}.backup.${stamp}`);
      }
      fs.writeFileSync(configFile, text, 'utf8');
      json(res, 200, { ok: true, text });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 500, {
      error: error.message,
      output: [error.stdout, error.stderr].filter(Boolean).join('\n')
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/app')) {
    const html = fs.readFileSync(appFile, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Account Preview App: ${url}`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', url] : [url];
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  }
});
