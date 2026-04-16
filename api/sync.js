/**
 * Vercel Serverless Function: POST /api/sync
 * フロントエンドから在庫データを受け取り Supabase に保存する
 * body: { user_id, settings, inventory, purchaseLogs }
 */

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { user_id, ...rest } = req.body;
    if (!rest || !rest.inventory || !rest.settings) {
      return res.status(400).json({ error: 'invalid payload' });
    }

    const userId = user_id || 'anonymous';
    const data   = { inventory: rest.inventory, settings: rest.settings, purchaseLogs: rest.purchaseLogs };

    // UPSERT（user_id をキーに上書き）
    await axios.post(
      `${SUPABASE_URL}/rest/v1/stock_bancho_users`,
      { user_id: userId, data, updated_at: new Date().toISOString() },
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates'
        }
      }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('/api/sync error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
};
