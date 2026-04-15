/**
 * Vercel Serverless Function: GET /api/notify
 * Vercel Cron Jobs から呼び出され LINE 通知を送信する
 *
 * vercel.json の crons 設定でスケジュール実行:
 *   { "path": "/api/notify", "schedule": "0 11 * * *" }  ← 20:00 JST (UTC+9)
 */

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ── 定数 ────────────────────────────────────────────────────
const ITEMS = {
  egg:    { name: '卵',            inputUnit: '個' },
  cheese: { name: 'プロセスチーズ', inputUnit: '個' },
  coffee: { name: 'アイスコーヒー', inputUnit: '本' }
};
const DAY_NAMES    = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS_EMOJI = { ALERT: '🔴', WARNING: '🟡', OK: '🟢' };

// ── LINE アクセストークン自動取得 ───────────────────────────
async function getAccessToken() {
  const staticToken   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (staticToken) return staticToken;

  const channelId     = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelId || !channelSecret) {
    throw new Error('LINE_CHANNEL_ID と LINE_CHANNEL_SECRET が未設定です');
  }

  const params = new URLSearchParams();
  params.append('grant_type',    'client_credentials');
  params.append('client_id',     channelId);
  params.append('client_secret', channelSecret);

  const res = await axios.post(
    'https://api.line.me/oauth2/v3/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

// ── 在庫計算ロジック ─────────────────────────────────────────
function getStockDays(item, count, settings) {
  if (item === 'coffee') {
    return (count * settings.purchaseUnit.coffee.amount) / settings.dailyConsumption.coffee.amount;
  }
  return count / settings.dailyConsumption[item].amount;
}

function getNextShoppingInfo(shoppingDays) {
  const today = new Date().getDay();
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

function isShoppingDay(shoppingDays) {
  return shoppingDays.includes(new Date().getDay());
}

function getStockStatus(stockDays, daysUntil) {
  if (stockDays < daysUntil)        return 'ALERT';
  if (stockDays < daysUntil * 1.5) return 'WARNING';
  return 'OK';
}

function buildNotifyText(data) {
  const { settings, inventory } = data;
  const appUrl = process.env.APP_URL || 'https://stock-bancho.vercel.app';
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

// ── ハンドラ ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付与する
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Supabase からデータ取得
    const sbRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/stock_bancho_data?id=eq.1&select=data`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = sbRes.data;
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        error: 'データなし。アプリの在庫更新画面で一度「保存」してください。'
      });
    }

    const data = rows[0].data;
    const text = buildNotifyText(data);
    console.log('[notify] 通知テキスト:\n' + text);

    const userId = process.env.LINE_USER_ID;
    if (!userId) {
      return res.status(500).json({ error: 'LINE_USER_ID が未設定です', text });
    }

    const token = await getAccessToken();

    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('[notify] LINE送信成功');
    return res.status(200).json({ ok: true, text });

  } catch (err) {
    const errData = err.response?.data;
    console.error('[notify] エラー:', errData || err.message);
    return res.status(500).json({ error: err.message, detail: errData });
  }
};
