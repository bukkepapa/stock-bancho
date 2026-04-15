/**
 * Vercel 環境変数一括設定スクリプト
 */

'use strict';

const https = require('https');

const TOKEN      = 'vca_6CX8FZkr8hfpvEZ4x0tZ1b4xP34qLyf2JksboAKgsHhI9W0dxx3oI0Mu';
const TEAM_ID    = 'team_5ce93htHZrtUgRHn0vEIl52K';
const PROJECT_ID = 'prj_PyHVNmJrrUiFEgHnDIlFbVYEGee9';

// 設定する環境変数
const ENV_VARS = [
  { key: 'SUPABASE_URL',        value: 'https://spfdvwcgvaaqfwxfyicc.supabase.co',   target: ['production', 'preview'] },
  { key: 'SUPABASE_ANON_KEY',   value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNwZmR2d2NndmFhcWZ3eGZ5aWNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NTE0NDksImV4cCI6MjA5MTIyNzQ0OX0.aPDpCV0EBFCD-pARx0ECFJ32Uh1-nODdS0HZVcbqnp8', target: ['production', 'preview'] },
];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.vercel.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  console.log('=== Vercel 環境変数設定 ===\n');

  for (const v of ENV_VARS) {
    const res = await request(
      'POST',
      `/v10/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`,
      { key: v.key, value: v.value, type: 'plain', target: v.target }
    );

    if (res.status === 200 || res.status === 201) {
      console.log(`✅ ${v.key} = ${v.key.includes('SECRET') || v.key.includes('TOKEN') ? '***' : v.value}`);
    } else if (res.status === 409) {
      // 既存の変数を上書き
      const envId = res.body?.error?.extraInfo?.existingEnvId;
      if (envId) {
        const patch = await request(
          'PATCH',
          `/v10/projects/${PROJECT_ID}/env/${envId}?teamId=${TEAM_ID}`,
          { value: v.value, target: v.target }
        );
        if (patch.status === 200) {
          console.log(`🔄 ${v.key} (更新)`);
        } else {
          console.warn(`⚠️  ${v.key} 更新失敗: ${patch.status}`);
        }
      } else {
        console.warn(`⚠️  ${v.key} 重複: ${JSON.stringify(res.body?.error)}`);
      }
    } else {
      console.error(`❌ ${v.key}: ${res.status} ${JSON.stringify(res.body?.error)}`);
    }
  }

  console.log('\n完了! 変更を反映するには再デプロイが必要です。');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
