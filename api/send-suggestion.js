/**
 * Vercel Serverless Function: POST /api/send-suggestion
 * フロントの「LINEに送る」ボタンから呼ばれ、買い物メモを LINE Push で送信する
 * （フロントは LINE Share URL を直接使うため、このエンドポイントは任意）
 */

const axios = require('axios');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'no text provided' });

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const uid   = process.env.LINE_USER_ID;

    if (!token || !uid) {
      return res.status(500).json({ error: 'LINE credentials not configured' });
    }

    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: uid, messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('/api/send-suggestion error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
};
