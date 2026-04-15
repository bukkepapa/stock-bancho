/**
 * Vercel REST API デプロイスクリプト
 * CLIプラグインの干渉を避けるため、APIを直接呼ぶ
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');

const TOKEN   = 'vca_6CX8FZkr8hfpvEZ4x0tZ1b4xP34qLyf2JksboAKgsHhI9W0dxx3oI0Mu';
const TEAM_ID = 'team_5ce93htHZrtUgRHn0vEIl52K';
const PROJECT = 'stock-bancho';
const ROOT    = __dirname;

// ── ファイル収集 ──────────────────────────────────────────────
const INCLUDE_DIRS  = ['public', 'api'];
const INCLUDE_FILES = ['vercel.json', 'package.json'];
const EXCLUDE       = ['node_modules', '.env', 'data', 'save_log.py', '.vercel', 'deploy-vercel.js'];

function collectFiles() {
  const files = [];

  function walk(dir, base = '') {
    for (const entry of fs.readdirSync(dir)) {
      if (EXCLUDE.includes(entry)) continue;
      const full    = path.join(dir, entry);
      const relPath = base ? `${base}/${entry}` : entry;
      const stat    = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, relPath);
      } else {
        files.push({ relPath, full, size: stat.size });
      }
    }
  }

  for (const d of INCLUDE_DIRS) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) walk(full, d);
  }
  for (const f of INCLUDE_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push({ relPath: f, full, size: fs.statSync(full).size });
  }

  return files;
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

// ── HTTP ヘルパー ─────────────────────────────────────────────
function request(method, endpoint, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.vercel.com',
      path:     endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type':  'application/json',
        ...extraHeaders,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, body: text });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function uploadFile(data, sha) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.vercel.com',
      path:     `/v2/files?teamId=${TEAM_ID}`,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${TOKEN}`,
        'Content-Type':   'application/octet-stream',
        'Content-Length': data.length,
        'x-vercel-digest': sha
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── メイン ────────────────────────────────────────────────────
async function deploy() {
  console.log('=== Vercel デプロイ開始 ===\n');

  // 1. ファイル収集
  const rawFiles = collectFiles();
  console.log(`📁 デプロイ対象ファイル: ${rawFiles.length}件`);
  rawFiles.forEach(f => console.log(`   ${f.relPath}`));

  const fileMap = {};
  const fileList = rawFiles.map(({ relPath, full, size }) => {
    const data = fs.readFileSync(full);
    const hash = sha1(data);
    fileMap[hash] = { data, relPath };
    return { file: relPath, sha: hash, size };
  });

  // 2. デプロイメント作成
  console.log('\n🚀 デプロイメント作成中...');
  const deployBody = {
    name:    PROJECT,
    files:   fileList,
    target:  'production',
    projectSettings: {
      outputDirectory: 'public',
      framework:       null
    }
  };

  let res = await request('POST', `/v13/deployments?teamId=${TEAM_ID}`, deployBody);

  // 3. ファイルアップロードが必要な場合
  if (res.status === 400 && res.body?.error?.code === 'missing_files') {
    const missing = res.body.error.missing || [];
    console.log(`\n📤 不足ファイルをアップロード中: ${missing.length}件`);

    for (const sha of missing) {
      const entry = fileMap[sha];
      if (!entry) {
        console.warn(`   ⚠️  SHA ${sha} のファイルが見つかりません`);
        continue;
      }
      const up = await uploadFile(entry.data, sha);
      if (up.status === 200 || up.status === 201) {
        console.log(`   ✅ ${entry.relPath}`);
      } else {
        console.warn(`   ❌ ${entry.relPath} (${up.status})`);
      }
    }

    // 再試行
    console.log('\n🔄 デプロイメント再作成中...');
    res = await request('POST', `/v13/deployments?teamId=${TEAM_ID}`, deployBody);
  }

  if (res.status !== 200 && res.status !== 201) {
    console.error('\n❌ デプロイ失敗:');
    console.error(JSON.stringify(res.body, null, 2));
    process.exit(1);
  }

  const { id, url, readyState } = res.body;
  console.log('\n✅ デプロイメント作成完了!');
  console.log(`   ID:    ${id}`);
  console.log(`   URL:   https://${url}`);
  console.log(`   状態:  ${readyState}`);
  console.log('\n⏳ ビルド完了まで数十秒お待ちください...');
  console.log(`   ダッシュボード: https://vercel.com/bukkepapa-9194s-projects/${PROJECT}`);

  // 4. 完了を待機
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await request('GET', `/v13/deployments/${id}?teamId=${TEAM_ID}`);
    const state = statusRes.body?.readyState;
    process.stdout.write(`\r   状態: ${state} (${++attempts * 5}秒経過)`);
    if (state === 'READY') {
      console.log(`\n\n🎉 デプロイ完了!`);
      console.log(`   本番URL: https://${url}`);
      return url;
    }
    if (state === 'ERROR') {
      console.log('\n❌ ビルドエラー');
      break;
    }
  }
}

deploy().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
