/* ハコレン 電話受付ツール 本体（GitHubから自動読み込み）
 * Rensapo 新規予約画面で動作。登録ボタンは絶対に押さない（人が確認して押す）。
 */
(function () {
  if (window.__hkTelTool) return;
  window.__hkTelTool = true;
  const VERSION = '0.2.0';

  // ===== 設定 =====
  const CONFIG = {
    open: '09:00', close: '19:00', pickupLast: '18:30',
    manyHits: 5,                 // これより多くヒットしたら会社・店舗番号とみなす
    shopStart: '1_1',            // 福岡空港店（フロント側）
    saleCatId: '1',              // 販売カテゴリ：一般
    saleTypeText: 'TEL',         // 販売種別
    classes: {
      W3:  { label: 'アルファード30系（福岡W3）',  plan: '1',   cls: '6',  rsvClass: '6'  },
      W4Z: { label: '新型アルファード（福岡W4Z）', plan: '213', cls: '39', rsvClass: '39' }
    },
    // key: 内部名, front: フロントのオプション名に含まれる語, rsv: Rensapoのオプション名に含まれる語, price: Rensapo料金欄
    options: [
      { key: 'menseki', label: '免責補償',   front: '免責補償オプション', rsv: '免責補償', price: 'price2' },
      { key: 'wide',    label: 'ワイド補償', front: 'ワイド',             rsv: 'ワイド',   price: 'price3' },
      { key: 'irekae',  label: '入替補償',   front: '入替',               rsv: '入替',     price: 'price9' },
      { key: 'etc',     label: 'ETCカード',  front: 'ETCカード',          rsv: 'ETC',      price: 'price7' },
      { key: 'child',   label: 'チャイルドシート', front: 'チャイルド', rsv: 'チャイルド', price: 'price7' },
      { key: 'baby',    label: 'ベビーシート',     front: 'ベビー',     rsv: 'ベビー',     price: 'price7' },
      { key: 'junior',  label: 'ジュニアシート',   front: 'ジュニア',   rsv: 'ジュニア',   price: 'price7' },
      { key: 'kep',     label: 'KEP',              front: 'KEP',        rsv: 'KEP',        price: 'price7' }
    ]
  };

  const $ = window.jQuery;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const yen = (n) => Number(n || 0).toLocaleString('ja-JP') + '円';
  const pad = (n) => String(n).padStart(2, '0');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  // ===== 文章の読み取り =====
  function toHalf(s) {
    return s.normalize('NFKC').replace(/[‐－―ー−]/g, (m) => (m === 'ー' ? m : '-'));
  }
  function hira2kata(s) { return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); }

  function parse(text) {
    const warn = [];
    let s = toHalf(text).replace(/\s+/g, ' ');
    const r = { warn };

    // 日付＋時刻（例: 10/25 9時, 10月25日 9:30, 10/25 9時半）
    const re = /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*(?:(\d{1,2})\s*(?::\s*(\d{2})|時\s*(半|\d{1,2}(?=\s*分))?\s*分?))?/g;
    const found = [];
    let m;
    while ((m = re.exec(s)) && found.length < 2) {
      let h = m[3] != null ? Number(m[3]) : null;
      let min = 0;
      if (m[4]) min = Number(m[4]);
      else if (m[5] === '半') min = 30;
      else if (m[5]) min = Number(m[5]);
      found.push({ mo: Number(m[1]), d: Number(m[2]), h, min, raw: m[0] });
    }
    found.forEach((f) => { s = s.replace(f.raw, ' '); });
    if (found.length < 2) warn.push('出発日と返却日の2つの日付が読み取れません（例: 10/25 9時 10/26 15時）');

    const today = new Date();
    const mk = (f, label) => {
      if (!f) return null;
      let y = today.getFullYear();
      const dt = new Date(y, f.mo - 1, f.d);
      if (dt < new Date(today.getFullYear(), today.getMonth(), today.getDate()) - 1) y += 1;
      if (f.h == null) { warn.push(label + 'の時刻がありません'); return { date: `${y}-${pad(f.mo)}-${pad(f.d)}`, time: '' }; }
      let h = f.h;
      if (h < 8) { h += 12; warn.push(`${label}の時刻を ${f.h}時 → ${h}時 と解釈しました`); }
      return { date: `${y}-${pad(f.mo)}-${pad(f.d)}`, time: `${pad(h)}:${pad(f.min)}` };
    };
    r.start = mk(found[0], '出発');
    r.end = mk(found[1], '返却');
    [['出発', r.start], ['返却', r.end]].forEach(([lb, v]) => {
      if (v && v.time && (v.time < CONFIG.open || v.time > CONFIG.close)) warn.push(`${lb}時刻 ${v.time} は営業時間（${CONFIG.open}〜${CONFIG.close}）外です`);
      if (v && v.time && v.time > CONFIG.pickupLast) warn.push(`${lb}時刻 ${v.time} は送迎最終（${CONFIG.pickupLast}）より後です`);
    });
    if (r.start && r.end && (r.start.date + r.start.time) >= (r.end.date + r.end.time)) warn.push('返却日時が出発日時より前になっています');

    // 電話番号
    const tm = s.match(/0\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}/);
    if (tm && tm[0].replace(/\D/g, '').length >= 10) {
      r.tel = tm[0].replace(/\D/g, '');
      s = s.replace(tm[0], ' ');
    } else warn.push('電話番号が読み取れません');

    // 車種クラス
    if (/W4Z|新型|40系|アルファード\s*Z|アルファード\s*40|40\s*アルファード/i.test(s)) r.cls = 'W4Z';
    else if (/W3|30系|アルファード\s*30|30\s*アルファード/i.test(s)) r.cls = 'W3';
    else if (/アルファード/.test(s)) { r.cls = 'W3'; warn.push('型式の指定がないため 30系（W3）にしました'); }
    else warn.push('車種が読み取れません（例: アルファード30 / 新型アルファード）');
    s = s.replace(/W4Z|W3|新型|40系|30系|アルファード\s*(Z|30|40)?|(30|40)\s*アルファード/gi, ' ');

    // オプション
    r.opts = {};
    const cnt = (re2) => { const mm = s.match(re2); return mm ? Number(mm[2] || 1) : 0; };
    if (/ワイド/.test(s)) r.opts.wide = 1;
    if (/(^|[^ド])(免責|面積|めんせき)/.test(s.replace(/ワイド\s*(免責|面積)/g, 'ワイド'))) r.opts.menseki = 1;
    if (/入替|入れ替え|入れ替|いれかえ/.test(s)) r.opts.irekae = 1;
    if (/ETC/i.test(s)) r.opts.etc = 1;
    if (/KEP/i.test(s)) r.opts.kep = 1;
    const c = cnt(/(チャイルド\S*?)(\d)?(個|台)?/); if (c) r.opts.child = /チャイルド\S*?(\d)/.test(s) ? Number(s.match(/チャイルド\S*?(\d)/)[1]) : 1;
    const b = cnt(/(ベビー\S*?)(\d)?/); if (b) r.opts.baby = /ベビー\S*?(\d)/.test(s) ? Number(s.match(/ベビー\S*?(\d)/)[1]) : 1;
    const j = cnt(/(ジュニア\S*?)(\d)?/); if (j) r.opts.junior = /ジュニア\S*?(\d)/.test(s) ? Number(s.match(/ジュニア\S*?(\d)/)[1]) : 1;
    s = s.replace(/から|まで|より|〜|~|名前|お名前|電話番号|電話|様|さん|系|安心|ワイド|免責|面積|めんせき|入替|入れ替え|入れ替|いれかえ|ETC\S*|KEP|チャイルド\S*|ベビー\S*|ジュニア\S*|保証|補償|オプション|カード|シート|\d+個|\d+台|なし/gi, ' ');

    // 名前（残った文字）
    const name = s.replace(/[、,。．.・:：]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name) {
      const parts = name.split(' ');
      r.name1 = parts[0];
      r.name2 = parts.slice(1).join('');
      if (/^[ぁ-ゖァ-ーー\s]+$/.test(name)) { r.kana1 = hira2kata(r.name1); r.kana2 = hira2kata(r.name2); }
    }
    return r;
  }

  // ===== フロント（お客様画面）と同じ見積もり =====
  async function quote(p) {
    const c = CONFIG.classes[p.cls];
    const q = new URLSearchParams({
      '_method': 'POST',
      'data[Quote][date]': p.start.date, 'data[Quote][time]': p.start.time, 'data[Quote][shop]': CONFIG.shopStart,
      'data[Quote][dateE]': p.end.date, 'data[Quote][timeE]': p.end.time, 'data[Quote][shopE]': '',
      'data[Quote][carnum]': '1', 'data[Quote][car_plan_id]': c.plan, 'data[Quote][car_class_id]': c.cls,
      'data[Flg][input]': '1'
    });
    const res = await fetch(`/booking/rentacars/ajaxQuote/${c.plan}/${c.cls}/?${q}`, {
      method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    const j = JSON.parse(await res.text());
    if (j.error && Object.keys(j.error).length) throw new Error('お客様画面の見積もりでエラー: ' + Object.values(j.error).join(' / '));
    if (j.date !== p.start.date || j.dateE !== p.end.date || j.time !== p.start.time || j.timeE !== p.end.time) {
      throw new Error('見積もりの日時が入力と一致しません（営業時間外の可能性）');
    }
    const base = Number(j.car_plan.CarVPlan.basic_price);
    const lines = [];
    for (const [k, n] of Object.entries(p.opts)) {
      const def = CONFIG.options.find((o) => o.key === k);
      const ent = Object.entries(j.car_stock_options || {}).find(([, v]) => v.car_option_name.includes(def.front));
      if (!ent) throw new Error(`「${def.label}」がこの車種のオプションにありません`);
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
  function selectByText(sel, text) {
    const o = [...document.querySelectorAll(sel + ' option')].find((x) => x.text.trim() === text);
    if (o) setv(sel, o.value);
    return !!o;
  }
  function rsvTotal() {
    const t = document.querySelector('form').innerText;
    const all = [...t.matchAll(/合計\s*([\d,]+)\s*円/g)];
    return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
  }

  async function fillRensapo(p, qt, memberId, staffId, log) {
    // 販売種別
    setv('#BookingSaleTypeCatId', CONFIG.saleCatId); await sleep(1200);
    if (!selectByText('#BookingSaleTypeId', CONFIG.saleTypeText)) log('⚠ 販売種別「TEL」が見つかりません');
    if (staffId) setv('#BookingReserveUserId', staffId);

    // 会員
    if (memberId) { window.ajax_member_set(memberId); await sleep(1800); log('会員情報を読み込みました'); }
    else {
      setv('#MemberName1', p.name1 || ''); setv('#MemberName2', p.name2 || '');
      if (p.kana1) { setv('#MemberKana1', p.kana1); setv('#MemberKana2', p.kana2 || ''); }
      log('新規のお客様として名前を入力しました');
    }
    if (!$('#MemberTel').val()) setv('#MemberTel', p.tel.replace(/^(0\d0)(\d{4})(\d{4})$/, '$1-$2-$3'));

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

    // オプション（Rensapo側）
    // 車種変更の読み込みで欄が作り直されることがあるため、毎回探し直して反映を確認する
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
        const e = $(`[name="data[PriceLending][${k}]"]`);
        e.val(String(v)).trigger('keyup').trigger('change');
        await sleep(500);
      }
      await sleep(800);
      const ok = Object.entries(want).every(([k, v]) => Number($(`[name="data[PriceLending][${k}]"]`).val()) === v);
      if (ok) break;
    }
    const got = rsvTotal();
    return { want, got };
  }

  // ===== 画面（パネル） =====
  const css = `
  #hkTel{position:fixed;right:12px;bottom:12px;z-index:99999;width:360px;max-height:90vh;overflow:auto;background:#fff;border:2px solid #1e88e5;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:14px/1.5 sans-serif;color:#222}
  #hkTel header{background:#1e88e5;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between;cursor:pointer}
  #hkTel .bd{padding:10px 12px}
  #hkTel textarea{width:100%;height:70px;box-sizing:border-box;font-size:14px;padding:6px}
  #hkTel select{width:100%;margin:4px 0}
  #hkTel button{width:100%;padding:9px;margin-top:6px;font-size:15px;font-weight:bold;border:0;border-radius:6px;cursor:pointer}
  #hkTel .b1{background:#43a047;color:#fff} #hkTel .b2{background:#fb8c00;color:#fff}
  #hkTel button:disabled{background:#bbb}
  #hkTel .out{margin-top:8px;font-size:13px} #hkTel table{width:100%;border-collapse:collapse}
  #hkTel td{padding:2px 4px;border-bottom:1px solid #eee} #hkTel td:last-child{text-align:right}
  #hkTel .tot{font-size:18px;font-weight:bold;color:#c62828}
  #hkTel .warn{color:#c62828} #hkTel .ok{color:#2e7d32} #hkTel .hint{color:#777;font-size:12px}
  #hkTel.min .bd{display:none}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const box = document.createElement('div');
  box.id = 'hkTel';
  box.innerHTML = `
    <header><span>📞 電話受付ツール <small>v${VERSION}</small></span><span id="hkMin">－</span></header>
    <div class="bd">
      <div class="hint">例：10/25 9時 10/26 15時 アルファード30 ヤマダ タロウ 090-1234-5678 免責 ワイド 入替 ETC</div>
      <textarea id="hkIn" placeholder="ここに予約内容を入力"></textarea>
      <label>受付担当</label><select id="hkStaff"></select>
      <button class="b1" id="hkQ">① 見積もり・会員検索</button>
      <div class="out" id="hkOut"></div>
      <button class="b2" id="hkF" disabled>② Rensapoに入力する</button>
      <div class="out" id="hkLog"></div>
    </div>`;
  document.body.appendChild(box);

  // 受付担当：Rensapo側のリストは後から読み込まれることがあるので、開くたびに作り直す
  const staffSel = box.querySelector('#hkStaff');
  function refreshStaff() {
    const keep = staffSel.value || store.get('hkStaff') || '';
    const src = [...document.querySelectorAll('#BookingReserveUserId option')];
    staffSel.innerHTML = '';
    if (!src.length) { const x = document.createElement('option'); x.value = ''; x.textContent = '（Rensapoの受付配車担当を使う）'; staffSel.appendChild(x); return; }
    src.forEach((o) => { const x = document.createElement('option'); x.value = o.value; x.textContent = o.text.trim(); staffSel.appendChild(x); });
    if ([...staffSel.options].some((o) => o.value === keep)) staffSel.value = keep;
  }
  refreshStaff();
  ['mousedown', 'focus'].forEach((ev) => staffSel.addEventListener(ev, refreshStaff));
  setTimeout(refreshStaff, 1500); setTimeout(refreshStaff, 4000);
  staffSel.onchange = () => store.set('hkStaff', staffSel.value);
  box.querySelector('#hkMin').onclick = () => box.classList.toggle('min');

  let state = null;
  const out = box.querySelector('#hkOut'), logEl = box.querySelector('#hkLog'), fBtn = box.querySelector('#hkF');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const log = (t) => { logEl.innerHTML += `<div>${esc(t)}</div>`; };

  box.querySelector('#hkQ').onclick = async () => {
    state = null; fBtn.disabled = true; logEl.innerHTML = ''; out.innerHTML = '計算中…';
    try {
      const p = parse(box.querySelector('#hkIn').value);
      if (!p.start || !p.end || !p.start.time || !p.end.time || !p.cls || !p.tel) {
        out.innerHTML = p.warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
        return;
      }
      const [qt, members] = await Promise.all([quote(p), memberSearch(p.tel)]);
      let mHtml;
      if (members.length > CONFIG.manyHits) {
        mHtml = `<div class="warn">⚠ この電話番号は ${members.length} 件の会員に登録されています（会社・店舗の番号の可能性）。新規として入力します。リピーター様の場合は携帯番号で検索し直してください。</div>`;
      } else if (members.length) {
        // 名前（カナ）が一致する会員を優先して選ぶ
        const kana = hira2kata(((p.name1 || '') + (p.name2 || '')).replace(/\s/g, ''));
        const sorted = members.slice().sort((a, b) => {
          const ma = kana && a.label.replace(/\s/g, '').startsWith(kana) ? 1 : 0;
          const mb = kana && b.label.replace(/\s/g, '').startsWith(kana) ? 1 : 0;
          return mb - ma || b.id - a.id;
        });
        const opts = sorted.map((m) => `<option value="${m.id}">${esc(m.label)}（ID ${m.id}）</option>`).join('');
        mHtml = `<div class="ok">✔ リピーター様です${members.length > 1 ? `（${members.length}件ヒット・重複登録の可能性。正しい方を選んでください）` : ''}</div>
          <select id="hkMem">${opts}<option value="">→ 新規として入力する</option></select>`;
      } else {
        mHtml = `<div>新規のお客様（会員ヒットなし）</div>` + (p.name1 ? '' : `<div class="warn">⚠ お名前が読み取れません</div>`);
      }
      out.innerHTML = `
        <table>
          <tr><td>出発</td><td>${p.start.date} ${p.start.time}</td></tr>
          <tr><td>返却</td><td>${p.end.date} ${p.end.time}</td></tr>
          <tr><td>車種</td><td>${esc(qt.className)}</td></tr>
          <tr><td>お名前</td><td>${esc((p.name1 || '') + ' ' + (p.name2 || ''))}</td></tr>
          <tr><td>電話</td><td>${p.tel}</td></tr>
          <tr><td>基本料金</td><td>${yen(qt.base)}</td></tr>
          ${qt.lines.map((l) => `<tr><td>${esc(l.label)}${l.n > 1 ? '×' + l.n : ''}</td><td>${yen(l.price)}</td></tr>`).join('')}
          <tr><td class="tot">合計（税込）</td><td class="tot">${yen(qt.total)}</td></tr>
        </table>
        ${mHtml}
        ${p.warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
        <div class="hint">↑ お客様には「合計 ${yen(qt.total)}」とお伝えください</div>`;
      state = { p, qt };
      fBtn.disabled = false;
    } catch (e) {
      out.innerHTML = `<div class="warn">⚠ ${esc(e.message)}</div>`;
    }
  };

  fBtn.onclick = async () => {
    if (!state) return;
    // ツールで選んでいなければ、Rensapo画面の受付配車担当をそのまま使う
    const staffId = staffSel.value || $('#BookingReserveUserId').val() || '';
    if (!staffId) { alert('受付担当を選んでください（ツールまたはRensapoの「受付配車担当」で選べます）'); return; }
    fBtn.disabled = true; logEl.innerHTML = '入力中…（触らずにお待ちください）';
    try {
      const memSel = box.querySelector('#hkMem');
      const memberId = memSel ? memSel.value : '';
      logEl.innerHTML = '';
      const r = await fillRensapo(state.p, state.qt, memberId, staffId, log);
      if (r.got === state.qt.total) log(`✔ Rensapoの合計 ${yen(r.got)} がお客様画面と一致しました`);
      else log(`⚠ Rensapoの合計が ${yen(r.got)} です（見積もり ${yen(state.qt.total)}）。料金欄を確認してください`);
      log('内容を確認し、問題なければ画面下の「登録する」を押してください。');
    } catch (e) {
      log('⚠ エラー: ' + e.message);
    } finally {
      fBtn.disabled = false;
    }
  };
})();
