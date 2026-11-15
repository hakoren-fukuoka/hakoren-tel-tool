/* ハコレン 電話受付ツール 本体（GitHubから自動読み込み）
 * Rensapo 新規予約画面で動作。登録ボタンは絶対に押さない（人が確認して押す）。
 * 流れ：① 見積もり（日時・車種・オプション）→ ② お客様情報（電話で会員検索・名前・メール）→ ③ Rensapoに入力
 */
(function () {
  if (window.__hkTelTool) return;
  window.__hkTelTool = true;
  const VERSION = '0.4.1';

  // ===== 設定 =====
  const CONFIG = {
    open: '09:00', close: '19:00', pickupLast: '18:30',
    manyHits: 5,                 // これより多くヒットしたら会社・店舗番号とみなす
    shopStart: '1_1',            // 福岡空港店（お客様画面側）
    shopName: '福岡空港',         // Rensapo の店舗選択で使う名前（自動で選ぶ）
    saleCatId: '1',              // 販売カテゴリ：一般
    saleTypeText: 'TEL',         // 販売種別
    classes: {
      W3:  { label: 'アルファード30系（W3）', plan: '1',   cls: '6',  rsvClass: '6',  shopE: '1_1_19'  },
      W4Z: { label: '新型アルファード（W4Z）', plan: '213', cls: '39', rsvClass: '39', shopE: '1_1_684' }
    },
    // key: 内部名, front: お客様画面のオプション名に含まれる語, rsv: Rensapoのオプション名に含まれる語, price: Rensapo料金欄, max: 最大個数
    options: [
      { key: 'menseki', label: '免責補償',         front: '免責補償オプション', rsv: '免責補償',   price: 'price2', max: 1, group: 'hosho' },
      { key: 'wide',    label: 'ワイド補償',       front: 'ワイド',             rsv: 'ワイド',     price: 'price3', max: 1, group: 'hosho' },
      { key: 'irekae',  label: '安心入替補償',     front: '入替',               rsv: '入替',       price: 'price9', max: 1, group: 'hosho' },
      { key: 'etc',     label: 'ETCカード',        front: 'ETCカード',          rsv: 'ETC',        price: 'price7', max: 1, group: 'opt' },
      { key: 'child',   label: 'チャイルドシート', front: 'チャイルド',         rsv: 'チャイルド', price: 'price7', max: 3, group: 'opt' },
      { key: 'baby',    label: 'ベビーシート',     front: 'ベビー',             rsv: 'ベビー',     price: 'price7', max: 3, group: 'opt' },
      { key: 'junior',  label: 'ジュニアシート',   front: 'ジュニア',           rsv: 'ジュニア',   price: 'price7', max: 3, group: 'opt' },
      { key: 'kep',     label: 'KEP',              front: 'KEP',                rsv: 'KEP',        price: 'price7', max: 1, group: 'opt' }
    ]
  };

  const $ = window.jQuery;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const yen = (n) => Number(n || 0).toLocaleString('ja-JP') + '円';
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hira2kata = (s) => String(s || '').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const isKana = (s) => /^[ぁ-ゖァ-ーー\s]+$/.test(s || '');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const TIMES = (() => { const a = []; for (let m = 9 * 60; m <= 19 * 60; m += 30) a.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`); return a; })();

  // ===== お客様画面と同じ見積もり =====
  async function quote(p) {
    const c = CONFIG.classes[p.cls];
    // 返却営業所は常に福岡空港店。番号が変わっていたら、サイトが返す一覧から福岡空港店を探して取り直す
    const ask = async (shopE) => {
      const q = new URLSearchParams({
        '_method': 'POST',
        'data[Quote][date]': p.start.date, 'data[Quote][time]': p.start.time, 'data[Quote][shop]': CONFIG.shopStart,
        'data[Quote][dateE]': p.end.date, 'data[Quote][timeE]': p.end.time, 'data[Quote][shopE]': shopE,
        'data[Quote][carnum]': '1', 'data[Quote][car_plan_id]': c.plan, 'data[Quote][car_class_id]': c.cls,
        'data[Flg][input]': '1'
      });
      const res = await fetch(`/booking/rentacars/ajaxQuote/${c.plan}/${c.cls}/?${q}`, {
        method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      return JSON.parse(await res.text());
    };
    const hasErr = (j) => j.error && Object.keys(j.error).length;
    const pickShopE = (j) => {
      const list = Object.assign({}, ...Object.values(j.listShopE || {}).map((v) => (v && typeof v === 'object' ? v : {})));
      return Object.keys(list).find((k) => String(list[k]).includes(CONFIG.shopName)) || Object.keys(list)[0] || '';
    };
    let shopE = store.get('hkShopE_' + p.cls) || c.shopE;
    let j = await ask(shopE);
    if (hasErr(j) || !j.car_plan) {
      const alt = pickShopE(j) || (j.shopE && j.shopE !== shopE ? j.shopE : '');
      if (alt && alt !== shopE) { shopE = alt; j = await ask(shopE); }
    }
    if (hasErr(j)) throw new Error(Object.values(j.error).join(' / '));
    store.set('hkShopE_' + p.cls, shopE);
    if (j.date !== p.start.date || j.dateE !== p.end.date || j.time !== p.start.time || j.timeE !== p.end.time) {
      throw new Error('この日時では見積もりが出せません（営業時間外・受付期間外の可能性）');
    }
    const base = Number(j.car_plan.CarVPlan.basic_price);
    const lines = [];
    for (const [k, n] of Object.entries(p.opts)) {
      if (!n) continue;
      const def = CONFIG.options.find((o) => o.key === k);
      const ent = Object.entries(j.car_stock_options || {}).find(([, v]) => v.car_option_name.includes(def.front));
      if (!ent) throw new Error(`「${def.label}」はこの車種では選べません`);
      const prices = j.car_plan_stock_options[ent[0]] || [];
      if (prices[n] == null) throw new Error(`「${def.label}」を ${n} 個は選べません`);
      lines.push({ key: k, label: def.label, n, price: Number(prices[n]), field: def.price, rsv: def.rsv });
    }
    const total = base + lines.reduce((a, l) => a + l.price, 0);
    return { base, lines, total, className: c.label };
  }

  // ===== 会員検索（電話番号が完全一致するものだけ） =====
  async function memberSearch(tel) {
    const res = await $.ajax({ type: 'post', url: '/rsv/bookings/ajaxMemberSearch/', data: { param1: tel }, dataType: 'json' });
    return (res || []).filter((x) => x && x.label && x.label.replace(/\D/g, '').endsWith(tel));
  }

  // ===== Rensapoへ入力 =====
  const setv = (sel, v, extra) => {
    const e = $(sel); if (!e.length) return false;
    e.val(v).trigger('input').trigger('change');
    (extra || []).forEach((ev) => e.trigger(ev));
    return true;
  };
  function selectByText(sel, test) {
    const o = [...document.querySelectorAll(sel + ' option')].find((x) => test(x.text.trim()));
    if (o) setv(sel, o.value);
    return !!o;
  }
  function rsvTotal() {
    const t = document.querySelector('form').innerText;
    const all = [...t.matchAll(/合計\s*([\d,]+)\s*円/g)];
    return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
  }
  const fmtTel = (t) => t.replace(/^(0\d0)(\d{4})(\d{4})$/, '$1-$2-$3');

  async function fillRensapo(p, qt, cust, staffId, log) {
    // 販売種別・受付
    setv('#BookingSaleTypeCatId', CONFIG.saleCatId); await sleep(1200);
    if (!selectByText('#BookingSaleTypeId', (t) => t === CONFIG.saleTypeText)) log('⚠ 販売種別「TEL」が見つかりません');
    if (staffId) setv('#BookingReserveUserId', staffId);

    // 店舗は常に福岡空港店
    ['#BookingReserveOfficeId', '#BookingOfficeStartId', '#BookingOfficeEndId'].forEach((sel) => {
      if ($(sel).length && !selectByText(sel, (t) => t.includes(CONFIG.shopName))) log('⚠ 店舗「福岡空港店」が選べませんでした');
    });

    // お客様
    if (cust.memberId) {
      window.ajax_member_set(cust.memberId); await sleep(1800);
      log('会員情報を読み込みました');
    } else {
      setv('#MemberName1', cust.name1); setv('#MemberName2', cust.name2);
      setv('#MemberKana1', cust.kana1); setv('#MemberKana2', cust.kana2);
      log('新規のお客様として入力しました');
    }
    if (cust.tel && !$('#MemberTel').val()) setv('#MemberTel', fmtTel(cust.tel));
    if (cust.email) {
      const now = ($('#MemberEmail').val() || '').trim();
      if (now && now !== cust.email) log(`メールアドレスを更新しました（前: ${now}）`);
      setv('#MemberEmail', cust.email);
    }

    // 日時
    setv('#BookingStartDay', p.start.date, ['changeDate', 'blur']);
    setv('#BookingStartTime', p.start.time, ['blur']); await sleep(700);
    setv('#BookingEndDay', p.end.date, ['changeDate', 'blur']);
    setv('#BookingEndTime', p.end.time, ['blur']); await sleep(700);

    // クラス（一度別クラスにしてから戻すと車両一覧が更新される）
    const cls = CONFIG.classes[p.cls].rsvClass;
    const other = [...document.querySelectorAll('#BookingCarClassId option')].map((o) => o.value).find((v) => v && v !== cls);
    if (other) { setv('#BookingCarClassId', other); await sleep(1200); }
    setv('#BookingCarClassId', cls); setv('#RentalCarClassId', cls); await sleep(2500);

    // オプション（車種変更で欄が作り直されることがあるので、毎回探し直して反映を確認）
    const labelOf = (s) => { let n = s, l = ''; for (let i = 0; i < 5 && !l; i++) { n = n.parentElement; l = (n.previousElementSibling?.innerText || '').trim(); } return l; };
    const optSelects = () => [...document.querySelectorAll('select[id^=BookingOption]')];
    const wantOpt = () => optSelects().map((s) => {
      const l = qt.lines.find((x) => labelOf(s).includes(x.rsv));
      return [s, l ? String(l.n) : ''];
    });
    for (let round = 0; round < 4; round++) {
      let changed = false;
      for (const [s, v] of wantOpt()) { if (s.value !== v) { $(s).val(v).trigger('change'); changed = true; } }
      await sleep(1500);
      if (!changed && wantOpt().every(([s, v]) => s.value === v)) break;
    }
    qt.lines.forEach((l) => {
      if (!optSelects().some((s) => labelOf(s).includes(l.rsv))) log(`⚠ Rensapoに「${l.label}」の欄が見つかりません`);
    });

    // 料金の振り分け（Rensapoの自動計算を上書き）
    const want = { price1: qt.base, price2: 0, price3: 0, price9: 0, price7: 0 };
    qt.lines.forEach((l) => { want[l.field] += l.price; });
    for (let round = 0; round < 3; round++) {
      for (const [k, v] of Object.entries(want)) {
        $(`[name="data[PriceLending][${k}]"]`).val(String(v)).trigger('keyup').trigger('change');
        await sleep(500);
      }
      await sleep(800);
      if (Object.entries(want).every(([k, v]) => Number($(`[name="data[PriceLending][${k}]"]`).val()) === v)) break;
    }
    return { want, got: rsvTotal() };
  }

  // ===== 画面（パネル） =====
  const css = `
  #hkTel{position:fixed;right:12px;bottom:12px;z-index:99999;width:380px;max-height:92vh;overflow:auto;background:#fff;border:2px solid #1e88e5;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:14px/1.5 sans-serif;color:#222}
  #hkTel header{position:sticky;top:0;background:#1e88e5;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between;cursor:pointer;z-index:1}
  #hkTel .bd{padding:8px 12px 12px}
  #hkTel h4{margin:10px 0 4px;font-size:14px;color:#1e88e5;border-bottom:1px solid #e3eefb;padding-bottom:2px}
  #hkTel .row{display:flex;gap:6px;align-items:center;margin:4px 0}
  #hkTel .row>label.k{width:40px;flex:none;color:#555}
  #hkTel input[type=date],#hkTel input[type=text],#hkTel input[type=tel],#hkTel input[type=email],#hkTel select{font-size:14px;padding:3px 4px;border:1px solid #bbb;border-radius:4px;min-width:0}
  #hkTel input[type=text],#hkTel input[type=tel],#hkTel input[type=email]{flex:1}
  #hkTel .chips{display:flex;flex-wrap:wrap;gap:4px 10px}
  #hkTel .chips label{white-space:nowrap;cursor:pointer}
  #hkTel .cnt select{width:auto}
  #hkTel button{padding:8px;font-size:14px;font-weight:bold;border:0;border-radius:6px;cursor:pointer}
  #hkTel .wide{width:100%;margin-top:8px;font-size:15px}
  #hkTel .b2{background:#fb8c00;color:#fff} #hkTel .bs{background:#e3eefb;color:#1e88e5;padding:4px 10px}
  #hkTel button:disabled{background:#bbb;color:#fff}
  #hkTel table{width:100%;border-collapse:collapse;margin-top:4px}
  #hkTel td{padding:2px 4px;border-bottom:1px solid #eee} #hkTel td:last-child{text-align:right}
  #hkTel .tot td{font-size:20px;font-weight:bold;color:#c62828;border-bottom:0}
  #hkTel .warn{color:#c62828;font-size:13px} #hkTel .ok{color:#2e7d32} #hkTel .hint{color:#777;font-size:12px}
  #hkTel .sec[hidden]{display:none}
  #hkTel .voice{display:flex;gap:4px;margin:4px 0}
  #hkTel .voice input{flex:1}
  #hkTel .mic{background:#e53935;color:#fff;padding:4px 10px;font-size:16px}
  #hkTel .mic.on{animation:hkBlink 1s infinite}
  @keyframes hkBlink{50%{opacity:.4}}
  #hkTel.min .bd{display:none}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const timeOpts = TIMES.map((t) => `<option>${t}</option>`).join('');
  const chk = (o) => o.max > 1
    ? `<label class="cnt">${o.label} <select data-opt="${o.key}">${[0, 1, 2, 3].slice(0, o.max + 1).map((n) => `<option value="${n}">${n || '-'}</option>`).join('')}</select></label>`
    : `<label><input type="checkbox" data-opt="${o.key}"> ${o.label}</label>`;

  const box = document.createElement('div');
  box.id = 'hkTel';
  box.innerHTML = `
    <header><span>📞 電話受付ツール <small>v${VERSION}</small></span><span id="hkMin">－</span></header>
    <div class="bd">
      <h4>① 見積もり</h4>
      <div class="voice"><input type="text" id="hkVoice" placeholder="🎤で話すか入力：11月30日9時から12月20日16時まで アルファード30 免責 ワイド"><button class="mic" id="hkMic" title="音声入力">🎤</button><button class="bs" id="hkApply">反映</button></div>
      <div id="hkVoiceMsg" class="hint"></div>
      <div class="row"><label class="k">出発</label><input type="date" id="hkSd"><select id="hkSt">${timeOpts}</select></div>
      <div class="row"><label class="k">返却</label><input type="date" id="hkEd"><select id="hkEt">${timeOpts}</select></div>
      <div class="row"><label class="k">車種</label><div class="chips">
        ${Object.entries(CONFIG.classes).map(([k, c], i) => `<label><input type="radio" name="hkCls" value="${k}" ${i ? '' : 'checked'}> ${c.label.replace(/（.*）/, '')}</label>`).join('')}
      </div></div>
      <div class="row"><label class="k">補償</label><div class="chips">${CONFIG.options.filter((o) => o.group === 'hosho').map(chk).join('')}</div></div>
      <div class="row"><label class="k">他</label><div class="chips">${CONFIG.options.filter((o) => o.group === 'opt').map(chk).join('')}</div></div>
      <div id="hkQuote"><div class="hint">日時と車種を選ぶと金額が出ます</div></div>

      <div class="sec" id="hkSec2" hidden>
        <h4>② お客様情報</h4>
        <div class="row"><label class="k">電話</label><input type="tel" id="hkTelNo" placeholder="090-1234-5678"><button class="bs" id="hkSearch">会員検索</button></div>
        <div id="hkMemOut"></div>
        <div id="hkNew">
          <div class="row"><label class="k">お名前</label><input type="text" id="hkN1" placeholder="姓"><input type="text" id="hkN2" placeholder="名"></div>
          <div class="row"><label class="k">フリガナ</label><input type="text" id="hkK1" placeholder="セイ"><input type="text" id="hkK2" placeholder="メイ"></div>
        </div>
        <div class="row"><label class="k">メール</label><input type="email" id="hkMail" placeholder="example@mail.com"></div>

        <h4>③ Rensapoに入力</h4>
        <div class="row"><label class="k">担当</label><select id="hkStaff" style="flex:1"></select></div>
        <button class="b2 wide" id="hkF">Rensapoに入力する</button>
        <div id="hkLog" style="margin-top:6px;font-size:13px"></div>
      </div>
    </div>`;
  document.body.appendChild(box);
  const q = (s) => box.querySelector(s);
  q('#hkMin').onclick = () => box.classList.toggle('min');

  // 初期値：明日 10:00 〜 明後日 10:00
  const d1 = new Date(); d1.setDate(d1.getDate() + 1);
  const d2 = new Date(); d2.setDate(d2.getDate() + 2);
  q('#hkSd').value = ymd(d1); q('#hkEd').value = ymd(d2);
  q('#hkSt').value = '10:00'; q('#hkEt').value = '10:00';
  q('#hkSd').min = ymd(new Date());

  // 受付担当：Rensapo側のリストは後から読み込まれることがあるので、開くたびに作り直す
  const staffSel = q('#hkStaff');
  function refreshStaff() {
    const keep = staffSel.value || store.get('hkStaff') || '';
    const src = [...document.querySelectorAll('#BookingReserveUserId option')];
    staffSel.innerHTML = '';
    if (!src.length) { staffSel.innerHTML = '<option value="">（Rensapoの受付配車担当を使う）</option>'; return; }
    src.forEach((o) => { const x = document.createElement('option'); x.value = o.value; x.textContent = o.text.trim(); staffSel.appendChild(x); });
    if ([...staffSel.options].some((o) => o.value === keep)) staffSel.value = keep;
  }
  refreshStaff();
  ['mousedown', 'focus'].forEach((ev) => staffSel.addEventListener(ev, refreshStaff));
  setTimeout(refreshStaff, 1500); setTimeout(refreshStaff, 4000);
  staffSel.onchange = () => store.set('hkStaff', staffSel.value);

  // ===== ① 見積もり（選ぶたびに自動計算） =====
  let current = null; // { p, qt }
  let seq = 0, timer = null;
  function readForm() {
    const opts = {};
    box.querySelectorAll('[data-opt]').forEach((e) => { opts[e.dataset.opt] = e.type === 'checkbox' ? (e.checked ? 1 : 0) : Number(e.value); });
    return {
      start: { date: q('#hkSd').value, time: q('#hkSt').value },
      end: { date: q('#hkEd').value, time: q('#hkEt').value },
      cls: (box.querySelector('input[name=hkCls]:checked') || {}).value,
      opts
    };
  }
  async function runQuote() {
    const my = ++seq;
    const p = readForm();
    const out = q('#hkQuote');
    const warn = [];
    if (!p.start.date || !p.end.date) { out.innerHTML = '<div class="hint">日付を選んでください</div>'; return; }
    if (p.start.date + p.start.time >= p.end.date + p.end.time) { out.innerHTML = '<div class="warn">⚠ 返却日時が出発日時より前です</div>'; current = null; q('#hkSec2').hidden = true; return; }
    [['出発', p.start.time], ['返却', p.end.time]].forEach(([lb, t]) => { if (t > CONFIG.pickupLast) warn.push(`${lb} ${t} は送迎最終（${CONFIG.pickupLast}）より後です`); });
    out.innerHTML = '<div class="hint">計算中…</div>';
    try {
      const qt = await quote(p);
      if (my !== seq) return;
      current = { p, qt };
      out.innerHTML = `
        <table>
          <tr><td>基本料金（${esc(qt.className)}）</td><td>${yen(qt.base)}</td></tr>
          ${qt.lines.map((l) => `<tr><td>${esc(l.label)}${l.n > 1 ? ' ×' + l.n : ''}</td><td>${yen(l.price)}</td></tr>`).join('')}
          <tr class="tot"><td>合計（税込）</td><td>${yen(qt.total)}</td></tr>
        </table>
        ${warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
        <div class="hint">お客様にこの金額をお伝えください。ご予約になる場合は ② へ</div>`;
      q('#hkSec2').hidden = false;
    } catch (e) {
      if (my !== seq) return;
      current = null;
      out.innerHTML = `<div class="warn">⚠ ${esc(e.message)}</div>`;
      q('#hkSec2').hidden = true;
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(runQuote, 300); };
  q('#hkSd').addEventListener('change', () => { if (q('#hkEd').value < q('#hkSd').value) q('#hkEd').value = q('#hkSd').value; q('#hkEd').min = q('#hkSd').value; schedule(); });
  ['#hkSt', '#hkEd', '#hkEt'].forEach((s) => q(s).addEventListener('change', schedule));
  box.querySelectorAll('input[name=hkCls],[data-opt]').forEach((e) => e.addEventListener('change', schedule));
  schedule();

  // ===== 音声・文章から ① の欄を埋める =====
  // 漢数字（〜九十九）を数字に
  function kanji2num(str) {
    const d = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    return str.replace(/[〇零一二三四五六七八九十]+/g, (m) => {
      if (!m.includes('十')) return m.split('').map((c) => d[c]).join('');
      const [a, b] = m.split('十');
      return String((a ? d[a] : 1) * 10 + (b ? d[b] : 0));
    });
  }
  function parseVoice(text) {
    const warn = [];
    let s = kanji2num(String(text).normalize('NFKC')).replace(/\s+/g, ' ');
    const r = { warn, opts: {} };
    // 日付＋時刻：11月30日9時 / 11/30 9:30 / 11月30日 午後4時半
    const re = /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*(?:の)?\s*(午前|午後|夕方|朝)?\s*(?:(\d{1,2})\s*(?::\s*(\d{2})|時\s*(半|\d{1,2}(?=\s*分))?\s*分?))?/g;
    const found = []; let m;
    while ((m = re.exec(s)) && found.length < 2) {
      let h = m[4] != null ? Number(m[4]) : null, min = 0;
      if (m[5]) min = Number(m[5]); else if (m[6] === '半') min = 30; else if (m[6]) min = Number(m[6]);
      if (h != null && (m[3] === '午後' || m[3] === '夕方') && h < 12) h += 12;
      else if (h != null && !m[3] && h < 8) { warn.push(`${h}時 → ${h + 12}時 と解釈しました`); h += 12; }
      found.push({ mo: Number(m[1]), d: Number(m[2]), h, min, raw: m[0] });
    }
    found.forEach((f) => { s = s.replace(f.raw, ' '); });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let y = today.getFullYear();
    found.forEach((f, i) => {
      if (i === 0 && new Date(y, f.mo - 1, f.d) < today) y += 1;           // 過ぎた日付は来年
      if (i === 1 && f.mo < found[0].mo) y += 1;                           // 年をまたぐ返却
      f.date = `${y}-${pad(f.mo)}-${pad(f.d)}`;
      f.time = f.h != null ? `${pad(f.h)}:${pad(f.min)}` : '';
    });
    if (found[0]) r.start = found[0];
    if (found[1]) r.end = found[1];
    // 車種
    if (/W4Z|新型|40系|アルファード\s*Z|アルファード\s*40|40\s*アルファード/i.test(s)) r.cls = 'W4Z';
    else if (/W3|30系|アルファード\s*30|30\s*アルファード/i.test(s)) r.cls = 'W3';
    else if (/アルファード/.test(s)) { r.cls = 'W3'; warn.push('型式がないので 30系 にしました'); }
    // 補償・オプション（「ワイド免責」はワイドだけ）
    const t = s.replace(/ワイド\s*(免責|面積)/g, 'ワイド');
    if (/ワイド/.test(t)) r.opts.wide = 1;
    if (/免責|面積|めんせき/.test(t)) r.opts.menseki = 1;
    if (/入替|入れ替え|入れ替|いれかえ|安心/.test(t)) r.opts.irekae = 1;
    if (/ETC|イーティーシー/i.test(t)) r.opts.etc = 1;
    if (/KEP|ケップ/i.test(t)) r.opts.kep = 1;
    [['child', 'チャイルド'], ['baby', 'ベビー'], ['junior', 'ジュニア']].forEach(([k, w]) => {
      const mm = t.match(new RegExp(w + '[^\\d\\s]*\\s*(\\d)?'));
      if (mm) r.opts[k] = Math.min(3, Number(mm[1] || 1));
    });
    return r;
  }
  function applyVoice(text) {
    const msg = q('#hkVoiceMsg');
    if (!text.trim()) return;
    const r = parseVoice(text);
    const done = [];
    const setTime = (sel, t, lb) => {
      if (!t) return;
      if (TIMES.includes(t)) { q(sel).value = t; } else r.warn.push(`${lb}時刻 ${t} は選べません（9:00〜19:00の30分刻み）`);
    };
    if (r.start) { q('#hkSd').value = r.start.date; setTime('#hkSt', r.start.time, '出発'); done.push('出発'); }
    if (r.end) { q('#hkEd').value = r.end.date; setTime('#hkEt', r.end.time, '返却'); done.push('返却'); }
    if (r.cls) { const e = box.querySelector(`input[name=hkCls][value=${r.cls}]`); if (e) e.checked = true; done.push('車種'); }
    // 新しく日付を言ったときは別のお客様とみなし、言わなかった補償・オプションは外す
    if (Object.keys(r.opts).length || r.start) {
      box.querySelectorAll('[data-opt]').forEach((e) => {
        const v = r.opts[e.dataset.opt] || 0;
        if (e.type === 'checkbox') e.checked = !!v; else e.value = String(v);
      });
      if (Object.keys(r.opts).length) done.push('補償・オプション');
    }
    if (!done.length) r.warn.push('日付・車種などが読み取れませんでした');
    msg.innerHTML = (done.length ? `<span class="ok">✔ ${done.join('・')} を反映しました</span>` : '') +
      r.warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    if (q('#hkEd').value < q('#hkSd').value) q('#hkEd').value = q('#hkSd').value;
    schedule();
  }
  q('#hkApply').onclick = () => applyVoice(q('#hkVoice').value);
  q('#hkVoice').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyVoice(q('#hkVoice').value); } });

  // 音声入力（Chromeの音声認識）
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = q('#hkMic');
  if (!SR) { mic.disabled = true; mic.title = 'このブラウザは音声入力に対応していません'; }
  else {
    let rec = null;
    mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'ja-JP'; rec.interimResults = true; rec.continuous = false;
      let finalText = '';
      mic.classList.add('on'); q('#hkVoiceMsg').textContent = '話してください…（もう一度🎤で終了）';
      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript; else interim += ev.results[i][0].transcript;
        }
        q('#hkVoice').value = finalText + interim;
      };
      rec.onerror = (ev) => {
        q('#hkVoiceMsg').innerHTML = `<div class="warn">⚠ 音声入力エラー: ${esc(ev.error === 'not-allowed' ? 'マイクの使用が許可されていません（アドレス欄の左のアイコンから許可してください）' : ev.error)}</div>`;
      };
      rec.onend = () => {
        mic.classList.remove('on'); rec = null;
        if (q('#hkVoice').value.trim()) applyVoice(q('#hkVoice').value);
      };
      rec.start();
    };
  }

  // ===== ② お客様情報 =====
  let memberId = '';
  const memOut = q('#hkMemOut');
  async function doSearch() {
    const tel = q('#hkTelNo').value.normalize('NFKC').replace(/\D/g, '');
    memberId = ''; q('#hkNew').hidden = false;
    if (tel.length < 10) { memOut.innerHTML = '<div class="warn">⚠ 電話番号を10桁以上で入れてください</div>'; return; }
    memOut.innerHTML = '<div class="hint">検索中…</div>';
    try {
      const members = await memberSearch(tel);
      if (members.length > CONFIG.manyHits) {
        memOut.innerHTML = `<div class="warn">⚠ この番号は ${members.length} 件の会員に登録されています（会社・店舗の番号の可能性）。新規として入力します。リピーター様なら携帯番号で検索し直してください。</div>`;
      } else if (members.length) {
        const opts = members.slice().sort((a, b) => b.id - a.id).map((m) => `<option value="${m.id}">${esc(m.label)}（ID ${m.id}）</option>`).join('');
        memOut.innerHTML = `<div class="ok">✔ リピーター様です${members.length > 1 ? `（${members.length}件。正しい方を選んでください）` : ''}</div>
          <select id="hkMem" style="width:100%">${opts}<option value="">→ 新規として入力する</option></select>
          <div class="hint">会員情報（名前など）は自動で入ります。メールが変わっていれば下に入れてください。</div>`;
        const sel = q('#hkMem');
        const apply = () => { memberId = sel.value; q('#hkNew').hidden = !!memberId; };
        sel.onchange = apply; apply();
      } else {
        memOut.innerHTML = '<div>新規のお客様です（会員ヒットなし）。お名前とフリガナを入れてください。</div>';
      }
    } catch (e) {
      memOut.innerHTML = `<div class="warn">⚠ 会員検索でエラー: ${esc(e.message)}</div>`;
    }
  }
  q('#hkSearch').onclick = doSearch;
  q('#hkTelNo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  q('#hkTelNo').addEventListener('blur', () => { const t = q('#hkTelNo').value.replace(/\D/g, ''); if (t.length >= 10 && !memOut.innerHTML) doSearch(); });
  q('#hkTelNo').addEventListener('input', () => { memOut.innerHTML = ''; memberId = ''; q('#hkNew').hidden = false; });
  // 名前がカナならフリガナにも入れる／フリガナはカタカナにそろえる
  [['#hkN1', '#hkK1'], ['#hkN2', '#hkK2']].forEach(([n, k]) => {
    q(n).addEventListener('change', () => { const v = q(n).value.trim(); if (isKana(v) && !q(k).value) q(k).value = hira2kata(v); });
    q(k).addEventListener('change', () => { q(k).value = hira2kata(q(k).value.trim()); });
  });

  // ===== ③ Rensapoに入力 =====
  const logEl = q('#hkLog');
  const log = (t) => { logEl.innerHTML += `<div>${esc(t)}</div>`; };
  q('#hkF').onclick = async () => {
    if (!current) { alert('先に ① の見積もりを出してください'); return; }
    const tel = q('#hkTelNo').value.normalize('NFKC').replace(/\D/g, '');
    const email = q('#hkMail').value.normalize('NFKC').trim();
    const cust = {
      memberId, tel, email,
      name1: q('#hkN1').value.trim(), name2: q('#hkN2').value.trim(),
      kana1: hira2kata(q('#hkK1').value.trim()), kana2: hira2kata(q('#hkK2').value.trim())
    };
    const errs = [];
    if (tel.length < 10) errs.push('電話番号');
    if (!memberId) {
      if (!cust.name1) errs.push('お名前（姓）');
      if (!cust.kana1) errs.push('フリガナ（セイ）');
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.push('メールアドレスの形');
    if (errs.length) { alert('次を確認してください：\n・' + errs.join('\n・')); return; }
    const staffId = staffSel.value || $('#BookingReserveUserId').val() || '';
    if (!staffId) { alert('受付担当を選んでください'); return; }

    // 入力直前に見積もりを取り直して、最新の金額で入れる
    const btn = q('#hkF'); btn.disabled = true; logEl.innerHTML = '入力中…（20秒ほど触らずにお待ちください）';
    try {
      const qt = await quote(current.p);
      logEl.innerHTML = '';
      const r = await fillRensapo(current.p, qt, cust, staffId, log);
      if (r.got === qt.total) log(`✔ Rensapoの合計 ${yen(r.got)} がお客様画面と一致しました`);
      else log(`⚠ Rensapoの合計が ${yen(r.got)} です（見積もり ${yen(qt.total)}）。料金欄を確認してください`);
      log('内容（特に貸渡車両）を確認し、問題なければ画面下の「登録する」を押してください。');
    } catch (e) {
      log('⚠ エラー: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };
})();
