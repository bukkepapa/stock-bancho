/**
 * ストック番長 — サーバー (Step 3: LINE通知バックエンド)
 *
 * 機能:
 *   1. public/ の静的ファイルを配信
 *   2. LINE Channel Access Token を起動時に自動取得・キャッシュ
 *   3. POST /api/webhook — LINE Webhook（User ID を自動キャプチャして .env に案内）
 *   4. POST /api/sync    — フロントから在庫データを受け取り保存
 *   5. GET  /api/notify  — 手動テスト用 LINE 通知
 *   6. node-cron で設定時刻に毎日 LINE 通知を自動送信
 *
 * 必要な環境変数 (.env):
 *   LINE_CHANNEL_ID      — 2009799007
 *   LINE_CHANNEL_SECRET  — 3174407f51c78cf1449334a2aff4811d
 *   LINE_USER_ID         — ボットにメッセージを送ると取得できます
 *   PORT                 — 3000（デフォルト）
 *   APP_URL              — 通知内リンクに使用する公開URL
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── データ保存先 ──────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'inventory.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return null;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  // Supabase にも非同期で同期（Vercel Cron が最新データを使えるように）
  syncToSupabase(data).catch(e => console.warn('[Supabase] 同期失敗:', e.message));
}

async function syncToSupabase(data) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return; // 未設定なら何もしない
  await axios.post(
    `${url}/rest/v1/stock_bancho_data`,
    { id: 1, data, updated_at: new Date().toISOString() },
    {
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      }
    }
  );
  console.log('[Supabase] ✅ 同期完了');
}

// ── LINE アクセストークン管理 ─────────────────────────────
let cachedToken     = process.env.LINE_CHANNEL_ACCESS_TOKEN || null;
let tokenExpiresAt  = 0;  // UNIX timestamp (ms)

/**
 * LINE OAuth v3 でチャンネルアクセストークンを取得する
 * Channel ID + Channel Secret だけで自動取得できる
 * 有効期限30日、期限が近づいたら自動更新
 */
async function getAccessToken() {
  const now = Date.now();

  // キャッシュが有効（期限まで1時間以上ある）なら再利用
  if (cachedToken && now < tokenExpiresAt - 3_600_000) return cachedToken;

  const channelId     = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelId || !channelSecret) {
    throw new Error('LINE_CHANNEL_ID と LINE_CHANNEL_SECRET が .env に設定されていません');
  }

  console.log('[LINE] チャンネルアクセストークンを取得中...');

  const params = new URLSearchParams();
  params.append('grant_type',    'client_credentials');
  params.append('client_id',     channelId);
  params.append('client_secret', channelSecret);

  const res = await axios.post(
    'https://api.line.me/oauth2/v3/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken    = res.data.access_token;
  tokenExpiresAt = now + res.data.expires_in * 1000;

  console.log(`[LINE] トークン取得完了（有効期限: ${Math.floor(res.data.expires_in / 86400)}日）`);
  return cachedToken;
}

// ── LINE メッセージ送信 ───────────────────────────────────
async function sendLineMessage(text) {
  const userId = process.env.LINE_USER_ID;

  if (!userId) {
    console.warn('[LINE] LINE_USER_ID が未設定です。');
    console.warn('       手順: LINEアプリでボット（友だち追加済み）にメッセージを送ると');
    console.warn('             このコンソールに User ID が表示されます。');
    return false;
  }

  try {
    const token = await getAccessToken();
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('[LINE] ✅ メッセージ送信完了');
    return true;
  } catch (err) {
    const errData = err.response?.data;
    console.error('[LINE] 送信エラー:', errData || err.message);
    return false;
  }
}

// ── 在庫計算ロジック ──────────────────────────────────────
const ITEMS = {
  egg:    { name: '卵',            emoji: '🥚', inputUnit: '個' },
  cheese: { name: 'プロセスチーズ', emoji: '🧀', inputUnit: '個' },
  coffee: { name: 'アイスコーヒー', emoji: '☕', inputUnit: '本' }
};
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function getStockDays(item, count, settings) {
  if (item === 'coffee') {
    return (count * settings.purchaseUnit.coffee.amount) / settings.dailyConsumption.coffee.amount;
  }
  return count / settings.dailyConsumption[item].amount;
}

function getNextShoppingInfo(shoppingDays) {
  const today      = new Date().getDay();
  const candidates = shoppingDays
    .map(day => ({ day, diff: (day - today + 7) % 7 }))
    .filter(x => x.diff > 0)
    .sort((a, b) => a.diff - b.diff);
  if (candidates.length > 0) {
    return { daysUntil: candidates[0].diff, dayName: DAY_NAMES[candidates[0].day] };
  }
  const firstDay = [...shoppingDays].sort((a, b) => a - b)[0];
  return { daysUntil: 7, dayName: DAY_NAMES[firstDay] };
}

function isShoppingDay(shoppingDays) { return shoppingDays.includes(new Date().getDay()); }

function getStockStatus(stockDays, daysUntil) {
  if (stockDays < daysUntil)        return 'ALERT';
  if (stockDays < daysUntil * 1.5) return 'WARNING';
  return 'OK';
}

const STATUS_EMOJI = { ALERT: '🔴', WARNING: '🟡', OK: '🟢' };

// ── LINE 通知テキスト生成 ─────────────────────────────────
function buildNotifyText(data) {
  const { settings, inventory } = data;
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);
  const todayIsShopping = isShoppingDay(settings.shoppingDays);

  const lines = [];
  if (todayIsShopping) {
    lines.push('【ストック番長】🛒 今日は買い物の日です！');
  } else {
    lines.push('【ストック番長】在庫チェックの時間！');
  }
  lines.push('');
  lines.push(`📅 次の買い物日：${dayName}曜日（${daysUntil}日後）`);
  lines.push('');

  for (const [item, { name, inputUnit }] of Object.entries(ITEMS)) {
    const count     = inventory[item]?.count ?? 0;
    const stockDays = getStockDays(item, count, settings);
    const status    = getStockStatus(stockDays, daysUntil);
    let line = `${STATUS_EMOJI[status]} ${name}：残り${count}${inputUnit}（あと${stockDays.toFixed(1)}日）`;
    if (status === 'ALERT') line += '\n   ⚠️ 今すぐ補充が必要です！';
    lines.push(line);
  }

  lines.push('');
  lines.push(`▶ 在庫を更新する: ${appUrl}`);
  return lines.join('\n');
}

// ── ミドルウェア ──────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: LINE Webhook（User ID 自動キャプチャ） ──────────
app.post('/api/webhook', (req, res) => {
  // 署名検証（オプション）
  const sig     = req.headers['x-line-signature'];
  const secret  = process.env.LINE_CHANNEL_SECRET;
  if (sig && secret) {
    const body    = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('SHA256', secret)
      .update(body)
      .digest('base64');
    if (sig !== expected) {
      return res.status(401).send('Invalid signature');
    }
  }

  const events = req.body?.events || [];
  events.forEach(event => {
    const userId = event.source?.userId;
    if (userId) {
      console.log('\n' + '='.repeat(50));
      console.log('✅ LINE User ID を取得しました！');
      console.log(`   User ID: ${userId}`);
      console.log('');
      console.log('   .env ファイルに以下を追記してサーバーを再起動:');
      console.log(`   LINE_USER_ID=${userId}`);
      console.log('='.repeat(50) + '\n');
    }
  });

  res.status(200).json({ ok: true });
});

// ── API: 在庫データ取得（デバイス間共有用） ──────────────
app.get('/api/data', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'no data' });
  res.json(data);
});

// ── API: 在庫データ同期 ───────────────────────────────────
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data?.inventory || !data?.settings) {
      return res.status(400).json({ error: 'invalid data' });
    }
    saveData(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: 手動テスト通知（GET /api/notify） ───────────────
app.get('/api/notify', async (req, res) => {
  const data = loadData();
  if (!data) {
    return res.status(404).json({
      error: 'データなし。アプリで在庫を保存してから呼んでください。',
      hint:  'アプリの在庫更新画面で「保存」すると /api/sync にデータが送られます。'
    });
  }

  const text = buildNotifyText(data);
  console.log('\n[テスト通知]\n' + text + '\n');
  const ok = await sendLineMessage(text);
  res.json({ ok, text });
});

// ── API: アクセストークン確認（デバッグ用） ──────────────
app.get('/api/token-check', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ ok: true, tokenPreview: token.slice(0, 20) + '...', expiresIn: Math.floor((tokenExpiresAt - Date.now()) / 1000) + 's' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── cron: 毎分チェック → 設定時刻に通知 ─────────────────
cron.schedule('* * * * *', async () => {
  const data = loadData();
  if (!data) return;

  const { notifyHour = 20, notifyMinute = 0 } = data.settings || {};
  const now = new Date();
  if (now.getHours() !== notifyHour || now.getMinutes() !== notifyMinute) return;

  console.log(`[cron] ⏰ ${notifyHour}:${String(notifyMinute).padStart(2,'0')} — LINE通知を送信します`);
  await sendLineMessage(buildNotifyText(data));
});

// ── SPA フォールバック ────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 起動 ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(50));
  console.log('🏪 ストック番長 サーバー起動');
  console.log(`   URL: http://localhost:${PORT}`);
  console.log('='.repeat(50));

  // 起動時にアクセストークンを先取得（接続テスト）
  try {
    await getAccessToken();
    console.log('✅ LINE API 接続OK');
  } catch (e) {
    console.warn('⚠️  LINE API:', e.message);
  }

  const userId = process.env.LINE_USER_ID;
  if (!userId) {
    console.log('\n📋 次のステップ: LINE User ID を取得してください');
    console.log('   1. LINE Developers → チャンネル(2009799007) → Messaging API設定');
    console.log('   2. Webhook URL を設定: http://あなたのサーバー/api/webhook');
    console.log('      （ローカルは ngrok 等でトンネル: npx ngrok http 3000）');
    console.log('   3. LINEアプリでボットにメッセージを送る');
    console.log('   4. このコンソールに User ID が表示されるので .env に追記\n');

    // LINE Developersコンソールで確認する方法も案内
    console.log('   ★ または LINE Developers → チャンネル → 「あなたのユーザーID」欄を確認\n');
  } else {
    console.log(`✅ LINE User ID: ${userId.slice(0,5)}...（設定済み）`);
    console.log(`   テスト通知: http://localhost:${PORT}/api/notify\n`);
  }
});
