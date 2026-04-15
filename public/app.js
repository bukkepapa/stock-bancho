'use strict';

/* ============================================================
   ストック番長 — app.js
   要件定義書 v3 準拠
   ============================================================ */

// ── アイテム定義 ──────────────────────────────────────────
// decimal: true のアイテムは小数点1桁で管理（±0.1刻み）
const ITEMS = {
  egg:    { name: '卵',            emoji: '🥚', inputUnit: '個', purchaseUnitLabel: 'ケース',  decimal: false },
  cheese: { name: 'プロセスチーズ', emoji: '🧀', inputUnit: '個', purchaseUnitLabel: 'スリーブ', decimal: false },
  coffee: { name: 'アイスコーヒー', emoji: '☕', inputUnit: '本', purchaseUnitLabel: '本',      decimal: true  }
};

const ITEM_KEYS = ['egg', 'cheese', 'coffee'];
const DAY_NAMES  = ['日', '月', '火', '水', '木', '金', '土'];

// ── デフォルト値 ──────────────────────────────────────────
const DEFAULT_SETTINGS = {
  dailyConsumption: {
    egg:    { amount: 4,   unit: '個' },
    cheese: { amount: 3,   unit: '個' },
    coffee: { amount: 300, unit: 'ml' }
  },
  purchaseUnit: {
    egg:    { amount: 10,  unit: '個', label: '1ケース' },
    cheese: { amount: 4,   unit: '個', label: '1スリーブ' },
    coffee: { amount: 900, unit: 'ml', label: '1本(900ml)' }
  },
  shoppingDays: [1, 4],   // 0=日…6=土
  notifyHour:   20,
  notifyMinute: 0
};

const DEFAULT_INVENTORY = {
  egg:    { count: 0, unit: '個', updatedAt: null },
  cheese: { count: 0, unit: '個', updatedAt: null },
  coffee: { count: 0, unit: '本', updatedAt: null }
};

// ── ストレージキー ────────────────────────────────────────
const STORAGE_KEY = 'stockBancho_v1';

// ── アプリ状態 ────────────────────────────────────────────
let state = {
  settings:     null,
  inventory:    null,
  purchaseLogs: []
};

// 更新画面の一時状態
let updateCounts    = {};
let updatePurchased = {};

// サジェストの計算結果（LINEに送るボタンで参照）
let lastSuggestion = null;

// ── ストレージ読み書き ────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.settings     = deepCopy(DEFAULT_SETTINGS);
      state.inventory    = deepCopy(DEFAULT_INVENTORY);
      state.purchaseLogs = [];
      return;
    }
    const data         = JSON.parse(raw);
    state.settings     = data.settings     || deepCopy(DEFAULT_SETTINGS);
    state.inventory    = data.inventory    || deepCopy(DEFAULT_INVENTORY);
    state.purchaseLogs = data.purchaseLogs || [];
  } catch (e) {
    console.error('loadState error:', e);
    state.settings     = deepCopy(DEFAULT_SETTINGS);
    state.inventory    = deepCopy(DEFAULT_INVENTORY);
    state.purchaseLogs = [];
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    settings:     state.settings,
    inventory:    state.inventory,
    purchaseLogs: state.purchaseLogs
  }));
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── コアロジック：在庫日数計算 ───────────────────────────
/**
 * 在庫日数を返す
 * coffee は「本 → ml換算」してから計算
 */
function getStockDays(item, count, settings) {
  if (item === 'coffee') {
    const totalMl = count * settings.purchaseUnit.coffee.amount;  // 本 × 900ml
    return totalMl / settings.dailyConsumption.coffee.amount;     // ÷ 300ml/日
  }
  return count / settings.dailyConsumption[item].amount;
}

// ── コアロジック：次の買い物日 ───────────────────────────
/**
 * 今日を除いた「次の買い物日」までの日数と曜日名を返す
 * ポイント: 曜日番号順ではなく「今日から最も近い将来日」を正しく選ぶ
 */
function getNextShoppingInfo(shoppingDays) {
  const today = new Date().getDay();

  // 各買い物曜日について「今日から何日後か」を計算し、最短の将来日を探す
  const candidates = shoppingDays
    .map(day => ({ day, diff: (day - today + 7) % 7 }))
    .filter(x => x.diff > 0)                           // 今日を除く将来のみ
    .sort((a, b) => a.diff - b.diff);                  // 近い順に並べる

  if (candidates.length > 0) {
    const { day, diff } = candidates[0];
    return { dayIndex: day, daysUntil: diff, dayName: DAY_NAMES[day] };
  }

  // 全ての買い物日が「今日」だった場合 → 翌週の最初の買い物曜日
  const firstDay = [...shoppingDays].sort((a, b) => a - b)[0];
  return { dayIndex: firstDay, daysUntil: 7, dayName: DAY_NAMES[firstDay] };
}

/** 今日が買い物日かどうか */
function isShoppingDay(shoppingDays) {
  return shoppingDays.includes(new Date().getDay());
}

// ── コアロジック：ステータス判定 ─────────────────────────
/**
 * @returns 'OK' | 'WARNING' | 'ALERT'
 */
function getStockStatus(stockDays, daysUntilShopping) {
  if (stockDays < daysUntilShopping)         return 'ALERT';    // 🔴
  if (stockDays < daysUntilShopping * 1.5)  return 'WARNING';  // 🟡
  return 'OK';                                                   // 🟢
}

// ── コアロジック：買い物サジェスト計算 ──────────────────
/**
 * 次の買い物日まで欠品しない購入推奨量を計算
 * @returns { needed: bool, unitCount: number, displayCount: number }
 */
function getSuggestedPurchase(item, currentCount, daysUntilNextShopping, settings) {
  const daily    = settings.dailyConsumption[item].amount;
  const unitSize = settings.purchaseUnit[item].amount;

  // アイスコーヒーは本→mlに換算
  const currentAmount = (item === 'coffee')
    ? currentCount * unitSize   // 本 × 900ml
    : currentCount;

  const needed   = daily * daysUntilNextShopping;
  const shortage = needed - currentAmount;

  if (shortage <= 0) {
    return { needed: false, unitCount: 0, displayCount: 0 };
  }

  const unitCount    = Math.ceil(shortage / unitSize);       // 何ケース/スリーブ/本
  const totalAmount  = unitCount * unitSize;                 // 合計量
  const displayCount = (item === 'coffee') ? unitCount : totalAmount;  // 表示用個数

  return { needed: true, unitCount, displayCount };
}

/**
 * サジェスト結果を表示文字列に変換
 * 例) "1ケース（10個）" / "2スリーブ（8個）" / "1本"
 */
function formatSuggestionAmount(item, suggestion) {
  if (!suggestion.needed) return '購入不要 ✅';
  const { unitCount, displayCount } = suggestion;
  if (item === 'coffee') return `${unitCount}本`;
  if (item === 'egg')    return `${unitCount}ケース（${displayCount}個）`;
  if (item === 'cheese') return `${unitCount}スリーブ（${displayCount}個）`;
  return `${displayCount}${ITEMS[item].inputUnit}`;
}

// ── 画面ナビゲーション ────────────────────────────────────
let currentScreen = 'home';

function showScreen(screenId) {
  // 全スクリーン非表示
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  // 対象スクリーン表示
  document.getElementById(`screen-${screenId}`).classList.add('active');
  // ナビボタン更新
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === screenId);
  });

  currentScreen = screenId;

  // スクリーン別レンダリング
  switch (screenId) {
    case 'home':     renderHome();     break;
    case 'update':   renderUpdate();   break;
    case 'history':  renderHistory();  break;
    case 'settings': renderSettings(); break;
  }

  // スクロールをトップに戻す
  const content = document.querySelector(`#screen-${screenId} .screen-content`);
  if (content) content.scrollTop = 0;
}

// ── トースト通知 ──────────────────────────────────────────
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show${type === 'error' ? ' error' : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ── 画面①：ホーム レンダリング ──────────────────────────
function renderHome() {
  const { settings, inventory } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);
  const todayIsShopping = isShoppingDay(settings.shoppingDays);

  // バッジ
  const badge = document.getElementById('shopping-day-badge');
  if (todayIsShopping) {
    badge.textContent  = '🛒 今日が買い物日！';
    badge.className    = 'badge badge-today';
  } else {
    badge.textContent  = `次：${dayName}曜（${daysUntil}日後）`;
    badge.className    = 'badge';
  }

  // カード生成
  const alertNames = [];
  const cardsHTML  = ITEM_KEYS.map(item => {
    const { name, emoji, inputUnit } = ITEMS[item];
    const count     = inventory[item].count;
    const stockDays = getStockDays(item, count, settings);
    const status    = getStockStatus(stockDays, daysUntil);

    if (status === 'ALERT') alertNames.push(name);

    const statusConfig = {
      OK:      { cssClass: 'card-ok',      badgeText: '🟢 余裕あり' },
      WARNING: { cssClass: 'card-warning', badgeText: '🟡 要注意' },
      ALERT:   { cssClass: 'card-alert',   badgeText: '🔴 補充必要' }
    }[status];

    return `
      <div class="card ${statusConfig.cssClass}">
        <div class="card-header">
          <span class="card-emoji">${emoji}</span>
          <span class="card-name">${name}</span>
          <span class="card-status-badge">${statusConfig.badgeText}</span>
        </div>
        <div class="card-body">
          <span class="card-count">${ITEMS[item].decimal ? Number(count).toFixed(1) : count} ${inputUnit}</span>
          <span class="card-days">あと <strong>${stockDays.toFixed(1)}</strong> 日分</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('cards-container').innerHTML = cardsHTML;

  // アラートバナー
  const banner = document.getElementById('alert-banner');
  if (alertNames.length > 0) {
    const prefix = todayIsShopping
      ? '🛒 今日の買い物日！補充が必要：'
      : '⚠️ 次の買い物日前に切れます：';
    banner.textContent = `${prefix}${alertNames.join('、')}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // 最終更新日時
  const latestUpdate = ITEM_KEYS
    .map(k => inventory[k].updatedAt)
    .filter(Boolean)
    .map(s => new Date(s))
    .sort((a, b) => b - a)[0];

  document.getElementById('last-updated').textContent = latestUpdate
    ? `最終更新：${formatDateTime(latestUpdate)}`
    : '在庫を更新してください';
}

function formatDateTime(date) {
  const d = new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

// ── 画面②：在庫更新 レンダリング ────────────────────────
function renderUpdate() {
  const { settings, inventory } = state;
  const { daysUntil } = getNextShoppingInfo(settings.shoppingDays);

  // 現在の在庫をデフォルトとして設定
  ITEM_KEYS.forEach(item => {
    updateCounts[item]    = inventory[item].count;
    updatePurchased[item] = 0;
  });

  const html = ITEM_KEYS.map(item => {
    const { name, emoji, inputUnit } = ITEMS[item];
    const isDecimal  = ITEMS[item].decimal;
    const count      = updateCounts[item];
    const stockDays  = getStockDays(item, count, settings);
    const status     = getStockStatus(stockDays, daysUntil);
    const statusCls  = `status-${status.toLowerCase()}`;
    const countDisp  = isDecimal ? Number(count).toFixed(1) : count;
    const stepAttr   = isDecimal ? '0.1' : '1';
    const modeAttr   = isDecimal ? 'decimal' : 'numeric';

    return `
      <div class="update-item">
        <div class="update-item-header">
          <span class="update-item-name">${emoji} ${name}</span>
          <span class="update-days-display ${statusCls}" id="days-${item}">
            あと ${stockDays.toFixed(1)} 日分
          </span>
        </div>

        <div class="update-row">
          <span class="update-row-label">現在の在庫</span>
          <div class="counter">
            <button class="counter-btn" onclick="changeCount('${item}', -1)" aria-label="減らす">−</button>
            <input type="number" id="count-${item}" value="${countDisp}" min="0"
                   step="${stepAttr}" inputmode="${modeAttr}" class="counter-input"
                   oninput="onCountInput('${item}')">
            <button class="counter-btn" onclick="changeCount('${item}', 1)" aria-label="増やす">＋</button>
          </div>
          <span class="counter-unit">${inputUnit}</span>
        </div>

        <div class="update-row">
          <span class="update-row-label">今日購入した数<br><small class="text-muted text-sm">（任意）</small></span>
          <div class="counter">
            <button class="counter-btn" onclick="changePurchased('${item}', -1)" aria-label="減らす">−</button>
            <input type="number" id="purchased-${item}" value="${isDecimal ? '0.0' : '0'}" min="0"
                   step="${stepAttr}" inputmode="${modeAttr}" class="counter-input"
                   oninput="onPurchasedInput('${item}')">
            <button class="counter-btn" onclick="changePurchased('${item}', 1)" aria-label="増やす">＋</button>
          </div>
          <span class="counter-unit">${inputUnit}</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('update-items-container').innerHTML = html;

  // メモ欄：今日分がすでに保存されていれば復元する
  const todayStr  = new Date().toISOString().split('T')[0];
  const todayLog  = state.purchaseLogs.find(l => l.date === todayStr);
  const savedMemo = (todayLog && todayLog.memo) ? todayLog.memo : '';
  document.getElementById('update-memo-container').innerHTML = `
    <div class="memo-card">
      <label class="memo-label" for="update-memo">📝 メモ（任意）</label>
      <textarea id="update-memo" class="memo-textarea" rows="5"
        placeholder="今日の気づきや買い物メモなど自由に入力">${savedMemo}</textarea>
    </div>`;
}

function changeCount(item, delta) {
  const input   = document.getElementById(`count-${item}`);
  const step    = ITEMS[item].decimal ? 0.1 : 1;
  const raw     = (updateCounts[item] || 0) + delta * step;
  const newVal  = Math.max(0, Math.round(raw * 10) / 10);
  updateCounts[item] = newVal;
  input.value = ITEMS[item].decimal ? newVal.toFixed(1) : newVal;
  refreshDaysDisplay(item);
}

function onCountInput(item) {
  const input = document.getElementById(`count-${item}`);
  if (ITEMS[item].decimal) {
    const raw = parseFloat(input.value);
    const val = Math.max(0, isNaN(raw) ? 0 : Math.round(raw * 10) / 10);
    updateCounts[item] = val;
    if (isNaN(raw) || raw < 0) input.value = val.toFixed(1);
  } else {
    const val = Math.max(0, parseInt(input.value) || 0);
    updateCounts[item] = val;
    input.value = val;
  }
  refreshDaysDisplay(item);
}

function changePurchased(item, delta) {
  const input  = document.getElementById(`purchased-${item}`);
  const step   = ITEMS[item].decimal ? 0.1 : 1;
  const raw    = (updatePurchased[item] || 0) + delta * step;
  const newVal = Math.max(0, Math.round(raw * 10) / 10);
  updatePurchased[item] = newVal;
  input.value = ITEMS[item].decimal ? newVal.toFixed(1) : newVal;
}

function onPurchasedInput(item) {
  const input = document.getElementById(`purchased-${item}`);
  if (ITEMS[item].decimal) {
    const raw = parseFloat(input.value);
    const val = Math.max(0, isNaN(raw) ? 0 : Math.round(raw * 10) / 10);
    updatePurchased[item] = val;
    if (isNaN(raw) || raw < 0) input.value = val.toFixed(1);
  } else {
    const val = Math.max(0, parseInt(input.value) || 0);
    updatePurchased[item] = val;
    input.value = val;
  }
}

function refreshDaysDisplay(item) {
  const el = document.getElementById(`days-${item}`);
  if (!el) return;
  const count     = updateCounts[item];
  const stockDays = getStockDays(item, count, state.settings);
  const { daysUntil } = getNextShoppingInfo(state.settings.shoppingDays);
  const status    = getStockStatus(stockDays, daysUntil);
  el.textContent  = `あと ${stockDays.toFixed(1)} 日分`;
  el.className    = `update-days-display status-${status.toLowerCase()}`;
}

// ── 保存処理 ─────────────────────────────────────────────
function handleSave() {
  const now  = new Date().toISOString();
  const today = now.split('T')[0];
  const todayIsShopping = isShoppingDay(state.settings.shoppingDays);

  // 在庫を更新
  ITEM_KEYS.forEach(item => {
    state.inventory[item].count     = updateCounts[item];
    state.inventory[item].updatedAt = now;
  });

  // 購入ログを記録（今日分を上書き）
  const wentShopping = ITEM_KEYS.some(item => updatePurchased[item] > 0);
  state.purchaseLogs = state.purchaseLogs.filter(log => log.date !== today);

  // メモを取得
  const memoEl = document.getElementById('update-memo');
  const memo   = memoEl ? memoEl.value.trim() : '';

  const logEntry = {
    date: today,
    wentShopping,
    purchased: {},
    memo
  };
  ITEM_KEYS.forEach(item => {
    logEntry.purchased[item] = { count: updatePurchased[item], unit: ITEMS[item].inputUnit };
  });

  state.purchaseLogs.unshift(logEntry);
  state.purchaseLogs = state.purchaseLogs.slice(0, 30);  // 最大30日保持

  saveState();
  showToast('✅ 在庫を保存しました');

  // サーバーへ在庫データを同期（LINE通知用。失敗しても無視）
  syncToServer();

  // 買い物日ならサジェストポップアップを表示
  if (todayIsShopping) {
    setTimeout(() => showSuggestionModal(), 600);
  } else {
    setTimeout(() => showScreen('home'), 800);
  }
}

// ── 画面⑤：買い物サジェストモーダル ─────────────────────
function showSuggestionModal() {
  const { settings, inventory } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);

  // サジェスト計算
  lastSuggestion = {};
  ITEM_KEYS.forEach(item => {
    lastSuggestion[item] = getSuggestedPurchase(item, inventory[item].count, daysUntil, settings);
  });

  const allNotNeeded = ITEM_KEYS.every(item => !lastSuggestion[item].needed);

  // サブタイトル
  document.getElementById('suggestion-subtitle').textContent =
    `${dayName}曜まで（${daysUntil}日分）`;

  // アイテム一覧
  let itemsHTML;
  if (allNotNeeded) {
    itemsHTML = `<div class="suggestion-all-ok">🎉 今日は全アイテム購入不要です！</div>`;
  } else {
    itemsHTML = ITEM_KEYS.map(item => {
      const s      = lastSuggestion[item];
      const { name, emoji } = ITEMS[item];
      const amount = formatSuggestionAmount(item, s);
      const rowCls = s.needed ? 'suggestion-needed' : 'suggestion-ok';

      return `
        <div class="suggestion-row ${rowCls}">
          <div class="suggestion-row-left">
            <span class="suggestion-row-emoji">${emoji}</span>
            <span class="suggestion-row-name">${name}</span>
          </div>
          <span class="suggestion-row-amount">${amount}</span>
        </div>`;
    }).join('');
  }

  document.getElementById('suggestion-items-container').innerHTML = itemsHTML;
  document.getElementById('modal-suggestion').classList.remove('hidden');
}

function closeSuggestion() {
  document.getElementById('modal-suggestion').classList.add('hidden');
  showScreen('home');
}

// LINE シェアボタン（LINE Share API でテキスト共有）
function sendSuggestionToLINE() {
  if (!lastSuggestion) return;

  const { settings } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);

  const lines = [
    '【ストック番長】今日の買い物メモ 🛒',
    `${dayName}曜まで（${daysUntil}日分）`,
    ''
  ];

  ITEM_KEYS.forEach(item => {
    const s      = lastSuggestion[item];
    const { name, emoji } = ITEMS[item];
    lines.push(`${emoji} ${name}：${formatSuggestionAmount(item, s)}`);
  });

  lines.push('', '忘れずに！');

  // メモがあれば末尾に追記
  const today    = new Date().toISOString().split('T')[0];
  const todayLog = state.purchaseLogs.find(l => l.date === today);
  if (todayLog && todayLog.memo) {
    lines.push('', `📝 メモ：${todayLog.memo}`);
  }

  const text = lines.join('\n');
  const url  = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}

// ── 画面③：購入履歴 レンダリング ────────────────────────
function renderHistory() {
  const today = new Date();
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return d.toISOString().split('T')[0];
  });

  // 今週の買い物回数（直近7日）
  const shoppingCount = last7.filter(date => {
    const log = state.purchaseLogs.find(l => l.date === date);
    return log && log.wentShopping;
  }).length;

  const pct   = Math.min(100, (shoppingCount / 2) * 100);
  const color = shoppingCount <= 2 ? 'var(--color-ok)' : 'var(--color-alert)';

  const summaryHTML = `
    <div class="weekly-card">
      <h3>今週のスーパー訪問（直近7日）</h3>
      <div class="weekly-stat">${shoppingCount} 回 <span class="text-muted text-sm">/ 目標 2 回</span></div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      ${shoppingCount <= 2
        ? `<p class="weekly-comment ok">✅ 目標達成中！すばらしい</p>`
        : `<p class="weekly-comment ng">⚠️ 目標より ${shoppingCount - 2} 回多いです</p>`
      }
    </div>`;

  document.getElementById('weekly-summary-container').innerHTML = summaryHTML;

  // 履歴リスト
  const historyHTML = `
    <p class="history-section-title">直近 7 日間</p>
    <div class="history-list">
      ${last7.map(date => {
        const log = state.purchaseLogs.find(l => l.date === date);
        const d   = new Date(date + 'T00:00:00');
        const label = `${d.getMonth()+1}/${d.getDate()}（${DAY_NAMES[d.getDay()]}）`;

        if (!log) {
          return `
            <div class="history-item no-data">
              <div class="history-item-header">
                <span class="history-date">${label}</span>
                <span class="text-muted text-sm">記録なし</span>
              </div>
            </div>`;
        }

        const purchasedItems = ITEM_KEYS
          .filter(item => log.purchased[item] && log.purchased[item].count > 0)
          .map(item => {
            const cnt = log.purchased[item].count;
            const disp = ITEMS[item].decimal ? Number(cnt).toFixed(1) : cnt;
            return `<span>${ITEMS[item].emoji} ${disp}${ITEMS[item].inputUnit}</span>`;
          })
          .join('');

        return `
          <div class="history-item ${log.wentShopping ? 'went-shopping' : ''}">
            <div class="history-item-header">
              <span class="history-date">${label}</span>
              ${log.wentShopping ? '<span class="history-shopping-badge">🛒 買い物</span>' : ''}
            </div>
            ${purchasedItems ? `<div class="history-purchased">${purchasedItems}</div>` : ''}
            ${log.memo ? `<div class="history-memo">📝 ${escapeHtml(log.memo)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>`;

  document.getElementById('history-list-container').innerHTML = historyHTML;
}

// ── 画面④：設定 レンダリング ─────────────────────────────
function renderSettings() {
  const s = state.settings;
  const sliderVal = s.notifyHour * 4 + Math.floor(s.notifyMinute / 15);
  const notifyDisp = `${String(s.notifyHour).padStart(2,'0')}:${String(s.notifyMinute).padStart(2,'0')}`;

  const html = `
    <!-- 1日消費量 -->
    <div class="settings-section">
      <h3>1日の消費量</h3>
      ${ITEM_KEYS.map(item => {
        const { name, emoji } = ITEMS[item];
        const isML = item === 'coffee';
        return `
          <div class="settings-row">
            <span class="settings-label">${emoji} ${name}</span>
            <div class="settings-control">
              <input type="number" id="daily-${item}"
                     value="${s.dailyConsumption[item].amount}"
                     min="1" inputmode="numeric" class="settings-input">
              <span class="settings-unit">${isML ? 'ml' : s.dailyConsumption[item].unit}/日</span>
            </div>
          </div>`;
      }).join('')}
    </div>

    <!-- 購入単位 -->
    <div class="settings-section">
      <h3>購入単位（1回の購入量）</h3>
      ${ITEM_KEYS.map(item => {
        const { name, emoji, purchaseUnitLabel } = ITEMS[item];
        const isML = item === 'coffee';
        return `
          <div class="settings-row">
            <span class="settings-label">${emoji} ${name}</span>
            <div class="settings-control">
              <input type="number" id="unit-${item}"
                     value="${s.purchaseUnit[item].amount}"
                     min="1" inputmode="numeric" class="settings-input">
              <span class="settings-unit">${isML ? 'ml/本' : `${ITEMS[item].inputUnit}/${purchaseUnitLabel}`}</span>
            </div>
          </div>`;
      }).join('')}
    </div>

    <!-- 買い物曜日 -->
    <div class="settings-section">
      <h3>買い物曜日</h3>
      <div class="day-selector">
        ${DAY_NAMES.map((day, i) => `
          <button class="day-btn ${s.shoppingDays.includes(i) ? 'active' : ''}"
                  data-day="${i}" onclick="toggleShoppingDay(${i})">${day}</button>
        `).join('')}
      </div>
    </div>

    <!-- LINE通知時刻 -->
    <div class="settings-section">
      <h3>LINE 通知時刻（サーバー側で使用）</h3>
      <div class="settings-row">
        <span class="settings-label">通知時刻</span>
        <div class="settings-control" style="gap:10px">
          <input type="range" id="notify-slider"
                 min="0" max="95" step="1" value="${sliderVal}"
                 class="notify-slider" oninput="updateNotifyDisplay()">
          <span class="notify-display" id="notify-display">${notifyDisp}</span>
        </div>
      </div>
    </div>

    <!-- ボタン -->
    <div class="settings-buttons">
      <button class="btn btn-primary btn-large" onclick="handleSettingsSave()">
        ✅ 設定を保存する
      </button>
      <button onclick="handleSettingsReset()">
        デフォルトに戻す
      </button>
    </div>`;

  document.getElementById('settings-content').innerHTML = html;
}

function toggleShoppingDay(day) {
  const days = [...state.settings.shoppingDays];
  const idx  = days.indexOf(day);

  if (idx >= 0) {
    if (days.length <= 1) {
      showToast('⚠️ 最低1日は選択してください', 'error');
      return;
    }
    days.splice(idx, 1);
  } else {
    days.push(day);
  }

  state.settings.shoppingDays = days;

  // ボタン表示を即時更新
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('active', days.includes(parseInt(btn.dataset.day)));
  });
}

function updateNotifyDisplay() {
  const val    = parseInt(document.getElementById('notify-slider').value);
  const hour   = Math.floor(val / 4);
  const minute = (val % 4) * 15;
  document.getElementById('notify-display').textContent =
    `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

function handleSettingsSave() {
  const s = state.settings;

  ITEM_KEYS.forEach(item => {
    const dailyVal = parseInt(document.getElementById(`daily-${item}`).value);
    const unitVal  = parseInt(document.getElementById(`unit-${item}`).value);
    if (dailyVal > 0) s.dailyConsumption[item].amount = dailyVal;
    if (unitVal  > 0) s.purchaseUnit[item].amount     = unitVal;
  });

  const sliderVal    = parseInt(document.getElementById('notify-slider').value);
  s.notifyHour       = Math.floor(sliderVal / 4);
  s.notifyMinute     = (sliderVal % 4) * 15;

  // shoppingDays は toggleShoppingDay() でリアルタイム更新済み

  saveState();
  showToast('✅ 設定を保存しました');

  setTimeout(() => showScreen('home'), 900);
}

function handleSettingsReset() {
  if (!confirm('すべての設定をデフォルト値に戻しますか？')) return;
  state.settings = deepCopy(DEFAULT_SETTINGS);
  saveState();
  renderSettings();
  showToast('✅ デフォルト値に戻しました');
}

// ── サーバー同期（LINE通知用） ────────────────────────────
/**
 * 在庫データをサーバーの /api/sync へ送信する。
 * ローカル開発（server.js）でも Vercel でも同じエンドポイントを使う。
 * ネットワークエラーは無視してフロントの動作には影響させない。
 */
function syncToServer() {
  fetch('/api/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      settings:     state.settings,
      inventory:    state.inventory,
      purchaseLogs: state.purchaseLogs
    })
  }).catch(() => { /* サーバー未起動時は無視 */ });
}

// ── サーバーからデータ取得してローカルに反映 ─────────────
/**
 * 起動時に /api/data を呼び、サーバー側の最新データがあれば
 * localStorageを上書きして全デバイスでデータを共有する。
 * サーバーが落ちているときは localStorage のデータをそのまま使う。
 */
async function syncFromServer() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) return;  // サーバーにデータなし → ローカルのまま

    const serverData = await res.json();
    if (!serverData.inventory || !serverData.settings) return;

    // サーバーとローカルの最終更新日時を比較
    const serverLatest = Object.values(serverData.inventory)
      .map(v => v.updatedAt ? new Date(v.updatedAt).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);

    const localLatest = Object.values(state.inventory)
      .map(v => v.updatedAt ? new Date(v.updatedAt).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);

    // サーバーの方が新しければ上書き
    if (serverLatest > localLatest) {
      state.settings     = serverData.settings;
      state.inventory    = serverData.inventory;
      state.purchaseLogs = serverData.purchaseLogs || [];
      saveState();  // ローカルにも保存（オフライン対応）
      renderHome(); // 画面を更新
    }
  } catch (e) {
    // ネットワークエラーは無視（ローカルデータで動作継続）
  }
}

// ── ユーティリティ ────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 初期化 ────────────────────────────────────────────────
function init() {
  loadState();

  // Service Worker 登録（PWA）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => {
      console.warn('SW registration failed:', e);
    });
  }

  renderHome();

  // サーバーから最新データを取得（デバイス間同期）
  syncFromServer();
}

init();
