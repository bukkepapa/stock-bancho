/**
 * Vercel Serverless Function: GET /api/data
 * Supabase から在庫データを取得する（デバイス間同期用）
 */

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/stock_bancho_data?id=eq.1&select=data`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = response.data;
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'no data' });
    }

    return res.json(rows[0].data);
  } catch (err) {
    console.error('/api/data error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
};
