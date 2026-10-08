(() => {
  'use strict';

  const PATH = location.pathname;
  const IS_LIST = /\/admin\/goods\.php$/.test(PATH);
  const IS_EDIT = /\/admin\/goods_input\.php$/.test(PATH);
  if (!IS_LIST && !IS_EDIT) return;

  // ====================================================================
  // 공통
  // ====================================================================
  const STATE_KEY = 'tncLgState';      // 실행 중 상태 (이 탭의 sessionStorage)
  const PLAN_KEY = 'tncLgPlan';        // 분석 결과 (이 탭)
  const ALERT_KEY = 'tncLgAlerts';     // main-world.js가 기록한 alert/confirm 내용
  const CFG_KEY = 'tncLgCfg';          // 설정 (localStorage)
  const EXCEL_KEY = 'tncLgExcel';      // 엑셀에서 읽은 모델 목록 (chrome.storage.local)
  const ACTIVE_KEY = 'tncLgProfile';   // 마지막으로 연 렌탈사 탭
  const SLOTS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
  const MAX_AUTO_SKIP = 5;                // 응답 없음으로 자동 건너뛰기를 연속 몇 번까지 허용할지
  const AUTO_SKIP_TAG = '[자동 건너뜀]';
  const STAGE_TIMEOUT_MS = 15000;        // 저장 클릭 후 이 시간 안에 페이지가 바뀌지 않으면 멈춤(자동 건너뜀)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const won = (v) => (v === '' || v == null ? '(없음)' : Number(v).toLocaleString('ko-KR'));
  const digits = (s) => { const m = String(s || '').match(/\d+/); return m ? Number(m[0]) : null; };
  // 비교용 정규화: 렌탈사는 공백 무시·'젼'='전'(사이트는 LG헬로비젼), 모델명은 영문 숫자 한글만 남김
  const normCo = (s) => String(s || '').replace(/[\s ]/g, '').replace(/젼/g, '전').toUpperCase();
  const normModel = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z가-힣]/g, '');
  // 스마트렌탈: 엑셀은 FH25GAGX_D·SQ06EZ1WBS_KB처럼 끝에 _영문(색상 등)을 붙이지만 사이트에는 FH25GAGX·SQ06EZ1WBS로 등록하므로, 끝의 _영문을 떼고 비교·검색한다
  const fixModelName = (m) => (PROFILES[PROFILE_ID] && PROFILES[PROFILE_ID].stripSuffix ? String(m).replace(/_[A-Za-z]+$/, '').trim() : m);
  const colIndex = (L) => {
    const t = String(L || '').trim().toUpperCase();
    return /^[A-Z]{1,3}$/.test(t) ? [...t].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : -1;
  };

  const ssGet = (k, d = null) => { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* 용량 초과 등 */ } };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch { /* 무시 */ } };
  const lsGet = (k, d = {}) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 무시 */ } };

  const storeOk = () => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch { return false; } };
  const storeGet = (k) => new Promise((res) => {
    if (!storeOk()) return res(null);
    try { chrome.storage.local.get(k, (o) => res((o && o[k]) || null)); } catch { res(null); }
  });
  const storeSet = (k, v) => new Promise((res) => {
    if (!storeOk()) return res(false);
    try { chrome.storage.local.set({ [k]: v }, () => res(!chrome.runtime.lastError)); } catch { res(false); }
  });

  // 입력칸 값 바꾸기 (사이트의 change 처리도 돌도록 이벤트 발생)
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ====================================================================
  // 렌탈사 폼 읽기·비교 (실제 화면과 fetch로 받은 문서 모두에서 동일하게 동작)
  // ====================================================================
  const fld = (form, name, s) => form.elements[`${name}_${s}`];
  const fval = (form, name, s) => (fld(form, name, s)?.value || '').trim();
  const companyOfForm = (form) => {
    const sel = form.elements.goods_brand;
    return sel ? (sel.options[sel.selectedIndex]?.text || '').trim() : '';
  };
  // 이미 등록된 렌탈사 폼들 (신규 등록용 빈 폼 'PriceInputForm'은 제외)
  const companyForms = (root, company) => [...root.querySelectorAll('form[id^="PriceInputForm_"]')]
    .filter((f) => f.elements.goods_brand && normCo(companyOfForm(f)) === normCo(company));

  // byPeriod: { 36: { price: '129900', fix: '149900' | '' | null } }  (fix: null=정가 그대로, ''=비움)
  function planForm(form, byPeriod, opts) {
    const info = SLOTS.filter((s) => fld(form, 'goods_price', s)).map((s) => ({
      s, raw: fval(form, 'goods_period', s), period: digits(fval(form, 'goods_period', s)),
      con: fval(form, 'goods_con', s), price: fval(form, 'goods_price', s), fix: fval(form, 'goods_fixprice', s),
    }));
    const sample = info.find((x) => x.period && x.raw && x.con);
    const swap = (txt, p, fb) => (txt ? txt.replace(/\d+/, String(p)) : fb);
    const taken = new Set();
    const changes = [], warnings = [], missing = [];
    for (const p of Object.keys(byPeriod).map(Number).sort((a, b) => a - b)) {
      const v = byPeriod[p];
      let c = info.filter((x) => x.period === p);
      if (c.length > 1) { const plain = c.filter((x) => /개월$/.test(x.con)); if (plain.length === 1) c = plain; }
      if (!c.length) {
        if (opts.addMissing) {
          const empty = info.find((x) => !x.raw && !x.con && !x.price && !x.fix && !taken.has(x.s));
          if (!empty) { warnings.push(`${p}개월을 넣을 빈 칸이 없습니다`); continue; }
          taken.add(empty.s);
          changes.push({
            s: empty.s, period: p, add: true,
            labels: { period: swap(sample?.raw, p, `의무${p}`), con: swap(sample?.con, p, `계약${p}개월`) },
            price: ['', v.price], fix: ['', v.fix === null ? '' : v.fix],
          });
        } else missing.push(p);
        continue;
      }
      if (c.length > 1) {
        if (!opts.applyDup) { warnings.push(`${p}개월 칸이 ${c.length}개(${c.map((x) => x.con).join(' / ')})라 건너뜀`); continue; }
        warnings.push(`${p}개월 칸 ${c.length}개(${c.map((x) => x.con).join(' / ')})에 같은 값 적용`);
      }
      for (const x of c) {
        const nf = v.fix === null ? x.fix : v.fix;
        if (x.price !== v.price || x.fix !== nf) changes.push({ s: x.s, period: p, price: [x.price, v.price], fix: [x.fix, nf], con: c.length > 1 ? x.con : '' });
      }
    }
    return { changes, warnings, missing };
  }

  // 렌탈사가 아직 없는 상품의 '신규 등록' 폼(맨 위 빈 폼, 보통 의무36/48/60 칸이 미리 적혀 있음)에 넣을 계획
  function planNewForm(form, byPeriod) {
    const info = SLOTS.filter((s) => fld(form, 'goods_price', s)).map((s) => ({
      s, raw: fval(form, 'goods_period', s), period: digits(fval(form, 'goods_period', s)),
      con: fval(form, 'goods_con', s), price: fval(form, 'goods_price', s), fix: fval(form, 'goods_fixprice', s),
    }));
    const sample = info.find((x) => x.period && x.raw && x.con);
    const swap = (txt, p, fb) => (txt ? txt.replace(/\d+/, String(p)) : fb);
    const used = new Set(), changes = [], warnings = [];
    for (const p of Object.keys(byPeriod).map(Number).sort((a, b) => a - b)) {
      const v = byPeriod[p];
      let x = info.find((i) => i.period === p && !used.has(i.s));
      if (!x) x = info.find((i) => !i.raw && !i.con && !i.price && !i.fix && !used.has(i.s));
      if (!x) { warnings.push(`${p}개월을 넣을 빈 칸이 없습니다`); continue; }
      used.add(x.s);
      const same = x.period === p;
      changes.push({
        s: x.s, period: p, add: !same,
        labels: { period: same ? x.raw : swap(sample?.raw, p, `의무${p}`), con: same ? x.con : swap(sample?.con, p, `계약${p}개월`) },
        price: [x.price, v.price], fix: [x.fix, v.fix === null ? '' : v.fix],
      });
    }
    // 미리 적혀 있던 칸 중 엑셀에 없는 기간(가격 없는 빈 틀)은 비워서, 가격 없는 칸이 같이 등록되지 않게 한다
    const clears = info.filter((x) => !used.has(x.s) && (x.raw || x.con) && !x.price && !x.fix).map((x) => x.s);
    return { changes, clears, warnings };
  }
  function applyNewForm(form, plan) {
    for (const c of plan.changes) {
      if (c.add) {
        setVal(fld(form, 'goods_period', c.s), c.labels.period);
        const con = fld(form, 'goods_con', c.s);
        if (con) setVal(con, c.labels.con);
      }
      setVal(fld(form, 'goods_price', c.s), c.price[1]);
      if (c.fix[1] !== c.fix[0]) setVal(fld(form, 'goods_fixprice', c.s), c.fix[1]);
    }
    for (const s of plan.clears) {
      setVal(fld(form, 'goods_period', s), '');
      const con = fld(form, 'goods_con', s);
      if (con) setVal(con, '');
    }
  }

  function applyPlan(form, changes) {
    for (const c of changes) {
      if (c.add) {
        setVal(fld(form, 'goods_period', c.s), c.labels.period);
        const con = fld(form, 'goods_con', c.s);
        if (con) setVal(con, c.labels.con);
      }
      setVal(fld(form, 'goods_price', c.s), c.price[1]);
      if (c.fix[1] !== c.fix[0]) setVal(fld(form, 'goods_fixprice', c.s), c.fix[1]);
    }
  }

  const doneText = (st, job) => (st.mode === 'lg' ? (job.summary || 'LG전자 렌탈료 수정') : st.mode === 'disable' ? `이 모델을 사이트에서 단종처리 하였습니다 (${st.company} 상태값 삭제)` : [changeText(job.changes || []), job.statusNote].filter(Boolean).join(' · '));
  // 렌탈사 폼의 상태값(goods_status: a 승인 / i 대기 / d 삭제): 렌탈료를 넣은 폼이 '대기'면 사이트에 노출되지 않으므로 '승인'으로 바꾼다 (삭제 상태는 건드리지 않음)
  const formStatusVal = (form) => { const x = form && form.elements && form.elements.goods_status; return x && x.type === 'select-one' ? x.value : ''; };
  function approveForm(form) {
    const x = form && form.elements && form.elements.goods_status;
    if (!x || x.type !== 'select-one' || x.value === 'a' || x.value === 'd') return '';
    const o = [...x.options].find((op) => op.value === 'a');
    if (!o) return '';
    setVal(x, 'a');
    return '렌탈사 상태 대기→승인';
  }
  // 상품 전체의 상태(수정 페이지 아래 라디오): 상태값이 '대기'면 승인으로, 거기에 진열상태가 '숨김'이면 진열로 바꿔서 사이트에 노출되게 한다
  function fixProductStatus() {
    const mf = document.getElementById('modifyForm') || (document.forms && document.forms.modifyForm);
    if (!mf) return '';
    const radios = (n) => [...mf.querySelectorAll('input[name="' + n + '"]')];
    const cur = (n) => (radios(n).find((r) => r.checked) || {}).value;
    const pick = (n, v) => { const r = radios(n).find((x) => x.value === v); if (r && !r.checked) { r.click(); return true; } return false; };
    if (cur('goods_status') !== 'i') return '';
    const parts = [];
    if (pick('goods_status', 'a')) parts.push('상품 상태 대기→승인');
    if (cur('goods_status_open') === 'n' && pick('goods_status_open', 'y')) parts.push('진열상태 숨김→진열');
    return parts.join(' · ');
  }
  const changeText = (changes) => changes.map((c) => {
    const parts = [`${c.period}개월${c.con ? '(' + c.con.replace(/^계약\d+개월_?/, '') + ')' : ''} ${won(c.price[0])}→${won(c.price[1])}`];
    if (c.fix[1] !== c.fix[0]) parts.push(`정가 ${won(c.fix[0])}→${won(c.fix[1])}`);
    return (c.add ? '[추가] ' : '') + parts.join(' · ');
  }).join(' / ');

  // ====================================================================
  // 엑셀 → 모델별 목표 렌탈료
  // ====================================================================
  const DEFAULT_CFG = {
    sheetCfg: {},
    standalone: 'SK매직,코웨이,쿠쿠,웰스,LG전자,소노아임레디,보람상조피플',
    addMissing: false, clearFix: false, applyDup: false, addCompany: true, limit: '', pressList: true, practice: false,
  };
  // 렌탈사별 탭: 탭마다 설정(렌탈사·규칙·시트 선택·행 범위), 불러온 엑셀, 분석 결과를 따로 기억해서 서로 영향을 주지 않는다.
  //  multiRule  lowhigh = 같은 모델 여러 줄이면 싼 값→금액(할인)·비싼 값→정가 / skip = 값이 서로 다르면 건너뛰고 보고
  //  filterHeader/filterVal = 제목이 filterHeader인 열의 값이 filterVal인 줄만 분석 (예: 스마트렌탈은 '상태'가 '운영'인 줄만)
  const PROFILES = {
    lgel: { label: 'LG전자', company: 'LG전자', multiRule: 'skip', filterHeader: '', filterVal: '' },
  };
  let PROFILE_ID = 'lgel';
  const cfg = {};
  const cfgKey = (id) => `${CFG_KEY}:${id}`;
  function loadProfile(id) {
    PROFILE_ID = id;
    lsSet(ACTIVE_KEY, id);
    const p = PROFILES[id];
    Object.keys(cfg).forEach((k) => delete cfg[k]);
    Object.assign(cfg, DEFAULT_CFG, { company: p.company, multiRule: p.multiRule }, lsGet(cfgKey(id), {}));
    if (!cfg.sheetCfg || typeof cfg.sheetCfg !== 'object') cfg.sheetCfg = {};
  }
  loadProfile(PROFILE_ID);
  { const st0 = ssGet(STATE_KEY); if (st0 && st0.running && PROFILES[st0.profile] && st0.profile !== PROFILE_ID) loadProfile(st0.profile); }   // 실행 중인 탭은 시작한 렌탈사 설정을 따른다
  const saveCfg = () => lsSet(cfgKey(PROFILE_ID), cfg);
  const planKey = () => `${PLAN_KEY}:${PROFILE_ID}`;
  const excelKey = () => `${EXCEL_KEY}:${PROFILE_ID}`;

  const tagOf = (name) => (/^\s*\[특가\]/.test(name) ? '특가' : /^\s*\[현장\]/.test(name) ? '현장' : '일반');
  const colLetter = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  // 가로형 제목에서 기간(개월)을 읽는다: "36" / "36개월" / "36개월 월렌탈료" / "36개월 총액 (월 할부금)" → 36
  const periodOfHeader = (h) => {
    const t = String(h).replace(/\s+/g, ' ').trim();
    let m = t.match(/^(\d{1,3})(?:\s*개월.*)?$/);
    // "월 렌탈료 (36개월)"처럼 기간이 뒤에 오는 제목은 '월 렌탈료'만 인정하고 '총 렌탈료'는 제외한다 (총액은 절대 쓰지 않음)
    if (!m && /월\s*렌탈료/.test(t) && !/총/.test(t)) m = t.match(/(\d{1,3})\s*개월/);
    const n = m ? Number(m[1]) : 0;
    return n >= 6 && n <= 120 ? n : 0;
  };
  // 렌탈료 칸 읽기: "59400" / "59,400원" / "2,199,600 (월 61,100)" (괄호 속 월 금액을 렌탈료로)
  function parsePriceCell(c) {
    const s = String(c == null ? '' : c).trim();
    if (s === '') return { empty: true };
    const m = s.match(/월\s*([\d,]+)/);
    const t = (m ? m[1] : s).replace(/[,\s원]/g, '');
    return /^\d+$/.test(t) ? { n: Number(t) } : { bad: true, raw: s.replace(/\s+/g, ' ') };
  }

  // 시트 한 장의 열 배치를 제목줄 이름으로 알아낸다.
  //  세로형(현대UBUS 시트들): 제목줄에 '모델명', '렌탈기간', '렌탈료'가 모두 있고, 한 줄에 기간 하나
  //  가로형(LG헬로): 제목줄에 '모델명'과 기간 숫자(24·36·…)가 있고, 한 줄에 기간 여러 개
  function detectSheet(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = rows[i].map((c) => String(c).replace(/\s+/g, ' ').trim());
      const mi = r.indexOf('모델명'), pi = r.indexOf('렌탈기간'), ci = r.indexOf('렌탈료');
      if (mi >= 0 && pi >= 0 && ci >= 0) {
        const ni = r.indexOf('규정명'), ii = r.indexOf('품목');
        return { mode: 'long', headerRow: i + 1, startRow: i + 2, model: colLetter(mi), period: colLetter(pi), price: colLetter(ci), name: ni >= 0 ? colLetter(ni) : '', item: ii >= 0 ? colLetter(ii) : '' };
      }
    }
    // 비에스온형 세로형: 제목줄에 '월렌탈료'와 '기간'이 있고 모델명 열은 '모델명' 또는 '상품명/모델명' (시트마다 위치가 다름)
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = rows[i].map((c) => String(c).replace(/\s+/g, ' ').trim());
      const pi = r.indexOf('기간'), ci = r.indexOf('월렌탈료');
      let mi = r.indexOf('모델명'); if (mi < 0) mi = r.indexOf('상품명/모델명');
      if (pi >= 0 && ci >= 0 && mi >= 0) {
        const ni = r.indexOf('상품명/모델명(전산)'), ii = r.indexOf('구분');
        return { mode: 'long', headerRow: i + 1, startRow: i + 2, model: colLetter(mi), period: colLetter(pi), price: colLetter(ci), name: ni >= 0 ? colLetter(ni) : '', item: ii >= 0 ? colLetter(ii) : '' };
      }
    }
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const r = rows[i].map((c) => String(c).replace(/\s+/g, ' ').trim());
      const mi = r.findIndex((c) => c === '모델명' || c === '모델코드');
      const nums = r.filter((c) => periodOfHeader(c)).length;
      if (mi >= 0 && nums >= 2) {
        let ni = r.findIndex((c) => /약정|규정명|상품명/.test(c)); if (ni < 0) { const k = r.indexOf('모델명'); if (k >= 0 && k !== mi) ni = k; }
        const ii = r.indexOf('품목');
        return { mode: 'wide', headerRow: i + 1, startRow: i + 2, model: colLetter(mi), period: '', price: '', name: ni >= 0 ? colLetter(ni) : '', item: ii >= 0 ? colLetter(ii) : '' };
      }
    }
    return null;
  }
  // 자동 인식 결과 + 사용자가 고쳐 둔 값(시트별로 기억)
  function sheetMap(name) {
    const det = detectSheet(excel.sheets[name] || []);
    const sc = cfg.sheetCfg[name] || {};
    const base = det || { mode: 'long', headerRow: 5, startRow: 6, model: 'G', period: 'H', price: 'I', name: 'F', item: 'E' };
    const ov = {};
    ['mode', 'headerRow', 'startRow', 'model', 'period', 'price', 'name'].forEach((k) => { if (sc[k] !== undefined && sc[k] !== '' && sc[k] !== null) ov[k] = sc[k]; });
    const merged = { ...base, ...ov, detected: !!det, filterCol: '', filterVal: '', rowFrom: 0, rowTo: 0 };
    // 탭의 기본 행 필터 (예: 스마트렌탈은 '상태' 열이 '운영'인 줄만)
    const pf = PROFILES[PROFILE_ID];
    if (det && pf.filterHeader) {
      const hdr = (excel.sheets[name][merged.headerRow - 1] || []).map((c) => String(c).replace(/\s+/g, ' ').trim());
      const fi = hdr.indexOf(pf.filterHeader);
      if (fi >= 0) { merged.filterCol = colLetter(fi); merged.filterVal = pf.filterVal; }
    }
    merged.policyCol = '';
    if (det && pf.policyHeader) {
      const hdr2 = (excel.sheets[name][merged.headerRow - 1] || []).concat(excel.sheets[name][merged.headerRow - 2] || []);
      const pcI = (excel.sheets[name][merged.headerRow - 1] || []).map((c) => String(c).replace(/\s+/g, ' ').trim()).indexOf(pf.policyHeader);
      if (pcI >= 0) merged.policyCol = colLetter(pcI);
    }
    merged.onlineCol = ''; merged.detailCol = '';
    if (det && (pf.onlineHeader || pf.detailHeader)) {
      const hh = (excel.sheets[name][merged.headerRow - 1] || []).map((c) => String(c).replace(/\s+/g, ''));
      const oi = pf.onlineHeader ? hh.indexOf(pf.onlineHeader) : -1, di = pf.detailHeader ? hh.indexOf(pf.detailHeader) : -1;
      if (oi >= 0) merged.onlineCol = colLetter(oi);
      if (di >= 0) merged.detailCol = colLetter(di);
    }
    if (sc.policyCol !== undefined) merged.policyCol = sc.policyCol;
    if (sc.filterCol !== undefined) merged.filterCol = sc.filterCol;           // 직접 고친 값(비워서 필터를 끌 수도 있음)
    if (sc.filterVal !== undefined) merged.filterVal = sc.filterVal;
    merged.rowFrom = Number(sc.rowFrom) || Number(cfg.rowFrom) || 0;           // 시트에 따로 넣은 값이 우선, 없으면 전체 공통 값
    merged.rowTo = Number(sc.rowTo) || Number(cfg.rowTo) || 0;
    return merged;
  }
  // 분석에 쓸 시트인가: 직접 체크한 값이 있으면 그대로, 없으면 "제목줄을 찾았고 숨김 시트가 아니면" 사용
  function sheetOn(name) {
    const sc = cfg.sheetCfg[name];
    if (sc && typeof sc.on === 'boolean') return sc.on;
    const hidden = !!(excel.meta && excel.meta[name] && excel.meta[name].hidden);
    if (PROFILES[PROFILE_ID].offSheets && PROFILES[PROFILE_ID].offSheets.test(name)) return false;   // 이 렌탈사에서 기본으로 뺄 시트 (체크하면 사용 가능)
    return !!detectSheet(excel.sheets[name] || []) && !hidden;
  }

  // 선택한 모든 시트를 읽어 모델별로 묶는다
  function buildModels() {
    const groups = new Map(), emptyModel = [], skippedPeriod = [], perSheet = {};
    const periodsSeen = new Set();
    const offP = new Set((cfg.periodOff || []).map(Number));          // 체크 해제한 개월 수는 분석·반영에서 뺀다
    let lines = 0;
    for (const name of Object.keys(excel.sheets)) {
      if (!sheetOn(name)) continue;
      const map = sheetMap(name);
      const rows = excel.sheets[name];
      const mi = colIndex(map.model), ni = map.name ? colIndex(map.name) : -1, ii = map.item ? colIndex(map.item) : -1;
      const fi = map.filterCol ? colIndex(map.filterCol) : -1;
      const pci = map.policyCol ? colIndex(map.policyCol) : -1;
      const oci = map.onlineCol ? colIndex(map.onlineCol) : -1, dci = map.detailCol ? colIndex(map.detailCol) : -1;
      const skipFixed = !!PROFILES[PROFILE_ID].skipFixed;
      if (mi < 0) continue;
      perSheet[name] = { rows: 0, models: new Set(), mode: map.mode, filtered: 0, outOfRange: 0, fixedOut: 0, onlineOut: 0, detailOut: 0 };
      // 분석에서 뺄 줄: 지정한 행 범위 밖이거나, 상태 필터(예: E열이 '운영')에 맞지 않는 줄
      const skipRow = (r, rowNo) => {
        if ((map.rowFrom && rowNo < map.rowFrom) || (map.rowTo && rowNo > map.rowTo)) { perSheet[name].outOfRange++; return true; }
        if (fi >= 0 && String(r[fi] ?? '').trim() !== String(map.filterVal || '').trim()) { perSheet[name].filtered++; return true; }
        // LG헬로: 정액 줄·온라인 노출 불가 줄·상세(단종/일시중단/판매중단) 줄은 검수·반영하지 않는다 (정률 + 노출 가능한 줄만 사이트에 반영)
        const modelHere = String(r[mi] ?? '').trim();
        if (modelHere) {
          if (skipFixed && pci >= 0 && /정액/.test(String(r[pci] ?? ''))) { perSheet[name].fixedOut++; return true; }
          if (oci >= 0) { const on = String(r[oci] ?? '').replace(/\s+/g, ' ').trim(); if (/^불가/.test(on) || !/가능/.test(on)) { perSheet[name].onlineOut++; return true; } }
          if (dci >= 0 && /단종|일시\s*중단|(판매|운영)\s*중단/.test(String(r[dci] ?? ''))) { perSheet[name].detailOut++; return true; }
        }
        return false;
      };
      let curRaw = '';
      const addRow = (model, rowNo, prices, rule, item, bad) => {
        const key = normModel(model);
        let g = groups.get(key);
        if (!g) { g = { key, model, rows: [], tags: [], bad: [], sheets: new Set(), fixed: [] }; groups.set(key, g); }
        if (curRaw && curRaw !== model) (g.origs = g.origs || new Set()).add(curRaw);
        g.rows.push({ sheet: name, row: rowNo, item, name: rule, prices });
        if (pci >= 0 && /정액/.test(String(rows[rowNo - 1][pci] ?? '')) && Object.keys(prices).length) g.fixed.push(`${name} ${rowNo}행`);   // 수수료정책이 정액인 줄 (렌탈료가 있는 줄만)
        g.tags.push(tagOf(rule)); g.sheets.add(name);
        bad.forEach((b) => g.bad.push(`${name} ${rowNo}행 ${b}`));
        perSheet[name].rows++; perSheet[name].models.add(key); lines++;
      };
      if (map.mode === 'long') {
        const pi = colIndex(map.period), ci = colIndex(map.price);
        if (pi < 0 || ci < 0) continue;
        for (let i = map.startRow - 1; i < rows.length; i++) {
          const r = rows[i];
          if (skipRow(r, i + 1)) continue;
          const modelRaw = String(r[mi] ?? '').trim(), model = fixModelName(modelRaw);
          curRaw = modelRaw;
          const periodRaw = String(r[pi] ?? '').trim();
          const priceRaw = String(r[ci] ?? '').replace(/[,\s원]/g, '');
          const rule = ni >= 0 ? String(r[ni] ?? '').trim() : '', item = ii >= 0 ? String(r[ii] ?? '').trim() : '';
          if (!model && !priceRaw) continue;                                      // 완전히 빈 줄
          if (!model) { emptyModel.push({ sheet: name, row: i + 1, item, rule, period: periodRaw, price: priceRaw }); continue; }
          const pm = periodRaw.match(/^(\d{1,3})\s*(개월)?$/);
          const p = pm ? Number(pm[1]) : NaN;
          if (!(p >= 6 && p <= 120)) { skippedPeriod.push({ sheet: name, row: i + 1, model, item, period: periodRaw || '(비어 있음)', price: priceRaw, reason: '개월 수가 아닌 기간(일시불 등)이라 제외' }); continue; }
          periodsSeen.add(p);
          if (offP.has(p)) continue;
          if (priceRaw === '' || Number(priceRaw) === 0) continue;                 // 0은 "그 기간 없음" 표시라 빈 칸처럼 처리
          const n = Number(priceRaw);
          const prices = {}, bad = [];
          if (!Number.isFinite(n) || n < 1000) bad.push(`${p}개월 ${priceRaw}`); else prices[p] = n;
          periodsSeen.add(p);
          addRow(model, i + 1, prices, rule, item, bad);
        }
      } else {
        const hdr = rows[map.headerRow - 1] || [];
        const priceCols = [];
        hdr.forEach((h, j) => {
          const n = periodOfHeader(h);
          if (j !== mi && j !== ni && n && !priceCols.some((x) => x.p === n)) { periodsSeen.add(n); if (!offP.has(n)) priceCols.push({ p: n, ci: j }); }
        });
        for (let i = map.startRow - 1; i < rows.length; i++) {
          const r = rows[i];
          if (skipRow(r, i + 1)) continue;
          const modelRaw = String(r[mi] ?? '').trim(), model = fixModelName(modelRaw);
          curRaw = modelRaw;
          if (!model) continue;
          const prices = {}, bad = [];
          for (const { p, ci } of priceCols) {
            const pc = parsePriceCell(r[ci]);
            if (pc.empty || pc.n === 0) continue;                                  // 0은 "그 기간 없음" 표시라 빈 칸처럼 처리
            if (pc.bad || pc.n < 1000) { bad.push(`${p}개월 ${pc.bad ? pc.raw : pc.n}`); continue; }
            prices[p] = pc.n;
          }
          addRow(model, i + 1, prices, ni >= 0 ? String(r[ni] ?? '').trim() : '', ii >= 0 ? String(r[ii] ?? '').trim() : String(r[0] ?? '').trim(), bad);
        }
      }
    }
    const models = [...groups.values()].map((g) => {
      const periods = {};
      g.rows.forEach((r) => Object.entries(r.prices).forEach(([p, v]) => { (periods[p] = periods[p] || []).push({ v, sheet: r.sheet, row: r.row }); }));
      return { key: g.key, model: g.model, origs: [...(g.origs || [])], count: g.rows.length, tags: g.tags, bad: g.bad, sheets: [...g.sheets], rowsData: g.rows, periods, fixed: g.fixed };
    });
    return { models, emptyModel, skippedPeriod, perSheet, lines, periods: [...periodsSeen].sort((a, b) => a - b) };
  }

  // 모델 하나의 기간별 목표값.
  //  lowhigh(LG헬로): 같은 모델 여러 줄이면 가장 싼 값 → 금액(할인), 가장 비싼 값 → 정가
  //  skip(현대UBUS): 한 기간에 한 값. 같은 기간에 값이 서로 다르면 충돌로 보고 건너뜀
  //  last: 값이 여러 개면 아래쪽(나중) 줄 값을 사용
  function targetsOf(m, opts) {
    const byPeriod = {}, conflicts = [], notes = [];
    for (const [p, ents] of Object.entries(m.periods)) {
      const uniq = [...new Set(ents.map((e) => e.v))].sort((a, b) => a - b);
      if (opts.multiRule === 'lowhigh') {
        byPeriod[p] = { price: String(uniq[0]), fix: uniq.length >= 2 ? String(uniq[uniq.length - 1]) : (opts.clearFix ? '' : null) };
      } else if (uniq.length === 1) {
        byPeriod[p] = { price: String(uniq[0]), fix: opts.clearFix ? '' : null };
      } else if (opts.multiRule === 'last') {
        const last = ents[ents.length - 1];
        byPeriod[p] = { price: String(last.v), fix: opts.clearFix ? '' : null };
        notes.push(`${p}개월 값이 여러 개(${uniq.map(won).join(' / ')}) → 아래쪽 줄(${last.sheet} ${last.row}행) 값 사용`);
      } else {
        conflicts.push({ p, ents });
      }
    }
    return { byPeriod, conflicts, notes };
  }
  const srcText = (m) => m.sheets.map((s) => `${s} ${m.rowsData.filter((r) => r.sheet === s).map((r) => r.row).join('·')}행`).join(' / ');

  // ====================================================================
  // 사이트 조회 (읽기 전용: 목록 검색 / 수정 페이지 가져오기)
  // ====================================================================
  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    return new DOMParser().parseFromString(new TextDecoder(document.characterSet || 'utf-8').decode(buf), 'text/html');
  }

  async function searchList(model) {
    const doc = await fetchDoc(`/admin/goods.php?search_item=all&search_keyword=${encodeURIComponent(model)}&search_keyword2=`);
    const lf = doc.getElementById('ListForm');
    if (!lf) throw new Error('상품 목록 표를 찾지 못함 (로그인 만료?)');
    const headRow = [...lf.querySelectorAll('tr')].find((tr) => tr.querySelector('th') && /상품코드/.test(tr.textContent));
    const heads = headRow ? [...headRow.children].map((h) => h.textContent.replace(/\s+/g, ' ').trim()) : [];
    const ix = (label) => heads.findIndex((h) => h.includes(label));
    const ci = ix('상품코드'), ri = ix('렌탈사명'), mi = ix('모델명'), ni = ix('상품명');
    if (ci < 0 || ri < 0 || mi < 0) throw new Error('목록 표 구조가 달라졌습니다');
    const items = [...lf.querySelectorAll('tr')].filter((tr) => tr.querySelector('input[name="idx[]"]')).map((tr) => {
      const t = (i) => (i >= 0 && tr.children[i] ? tr.children[i].textContent.replace(/\s+/g, ' ').trim() : '');
      return { code: t(ci), rentals: t(ri).split(',').map((x) => x.trim()).filter(Boolean), model: t(mi), name: t(ni) };
    });
    const m = doc.body.textContent.match(/검색결과\s*([\d,]+)\s*건/);
    return { total: m ? Number(m[1].replace(/,/g, '')) : items.length, items };
  }

  const editUrl = (code) => `/admin/goods_input.php?mode=mod&code=${encodeURIComponent(code)}`;
  const fetchEdit = (code) => fetchDoc(editUrl(code));

  // 모델 하나를 분석: 어떤 상품인지 찾고, 현재 렌탈료와 엑셀 값을 비교 (사이트에는 아무것도 쓰지 않음)
  async function analyzeModel(m, company, opts) {
    // warnings = 사람이 확인해야 하는 것, notes = 참고만 하면 되는 것
    const res = { key: m.key, model: m.model, origs: m.origs || [], count: m.count, tags: m.tags, sheets: m.sheets, srcRows: srcText(m), code: '', status: '', msg: '', changes: [], warnings: [], notes: [], byPeriod: null };
    if (m.bad.length) res.warnings.push(`엑셀 이상값 제외: ${m.bad.join(', ')}`);
    if (m.fixed && m.fixed.length) { res.fixedFee = true; res.warnings.push(`정액 수수료 상품 (${m.fixed.join(', ')}) → 정률만 반영하는 것이 원칙이라 기본 선택에서 제외`); }
    if (normModel(m.model).length < 3) { res.status = 'badmodel'; res.msg = `모델명이 너무 짧아 사이트에서 찾을 수 없음 ("${m.model}") → 엑셀 확인 필요`; return res; }

    const tg = targetsOf(m, opts);
    const byPeriod = tg.byPeriod;
    tg.notes.forEach((n) => res.notes.push(n));
    if (tg.conflicts.length) {
      const txt = tg.conflicts.map((c) => `${c.p}개월 ` + [...new Set(c.ents.map((e) => `${won(e.v)}(${e.sheet} ${e.row}행)`))].join(' vs ')).join(' / ');
      if (!Object.keys(byPeriod).length) { res.status = 'conflict'; res.msg = `같은 모델·기간에 값이 서로 다름 → ${txt}`; return res; }
      res.warnings.push(`값이 서로 달라 제외한 기간: ${txt}`);
    }
    if (!Object.keys(byPeriod).length) { res.status = 'nodata'; res.msg = '엑셀에 렌탈료 값이 없음'; return res; }
    res.byPeriod = byPeriod;
    if (opts.multiRule === 'lowhigh' && m.count >= 3) res.notes.push(`엑셀 ${m.count}줄 (${m.tags.join('/')}): 가장 싼 값 → 금액(할인), 가장 비싼 값 → 정가`);

    // 모델명 끝의 괄호 표기 "(B)" 등은 빼고도 찾는다
    const searchKey = m.model.replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '').trim() || m.model;
    const cands = [...new Set([normModel(m.model), normModel(searchKey)])].filter((x) => x.length >= 3);
    const list = await searchList(searchKey);
    if (list.total > list.items.length) res.warnings.push(`검색결과 ${list.total}건 중 ${list.items.length}건만 확인`);
    const same = list.items.filter((it) => cands.includes(normModel(it.model)));
    if (!same.length) { res.status = 'nomodel'; res.msg = `사이트에 이 모델이 없음 → 신규 등록 필요 (검색 ${list.total}건 중 모델명 일치 0건)`; return res; }

    // 단독몰 상품(렌탈사명이 SK매직·코웨이·LG전자 등 하나뿐인 상품)은 가전종합몰 상품과 별개 → 대상 렌탈사를 등록하면 안 됨
    const stdSet = new Set((opts.standalone || []).map(normCo));
    const isStd = (it) => it.rentals.length === 1 && stdSet.has(normCo(it.rentals[0])) && normCo(it.rentals[0]) !== normCo(company);
    const sameStd = same.filter(isStd), sameMain = same.filter((it) => !isStd(it));
    if (!sameMain.length) {
      res.status = 'standalone'; res.sameCodes = sameStd.map((x) => x.code); res.rentals = sameStd[0].rentals;
      res.msg = `단독몰 상품만 있음 (${sameStd.map((x) => `${x.code}: ${x.rentals[0]}`).join(', ')}) → 가전종합몰 상품은 복사 등록으로 새로 등록해야 함`;
      return res;
    }
    if (sameStd.length) res.notes.push(`단독몰 상품은 제외함 (${sameStd.map((x) => `${x.code}: ${x.rentals[0]}`).join(', ')})`);

    const hit = sameMain.filter((it) => it.rentals.some((r) => normCo(r) === normCo(company)));
    let forms = [];
    if (hit.length > 1) { res.status = 'ambiguous'; res.msg = `${company} 상품이 ${hit.length}개: ${hit.map((x) => x.code).join(', ')}`; return res; }
    if (hit.length === 1) {
      res.code = hit[0].code;
      res.rentals = hit[0].rentals;           // 이 상품에 등록된 렌탈사들 (대상 렌탈사가 들어 있는 상품임을 보여 주기 위함)
      const doc = await fetchEdit(res.code);
      forms = companyForms(doc, company);
      if (!forms.length) { res.status = 'noform'; res.msg = `${res.code} 페이지에 ${company} 렌탈사 폼이 없음`; return res; }
      if (forms.length > 1) { res.status = 'ambiguous'; res.msg = `${res.code} 페이지에 ${company} 폼이 ${forms.length}개`; return res; }
    } else {
      // 목록의 렌탈사명에 없어도(렌탈료 값을 지운 경우 등) 수정 페이지에는 렌탈사 폼이 남아 있을 수 있어, 같은 모델 상품을 직접 열어 확인한다
      const found = [], without = [];
      for (const it of sameMain) {
        const d = await fetchEdit(it.code);
        const fs = companyForms(d, company);
        (fs.length ? found : without).push({ it, doc: d, forms: fs });
      }
      if (found.length > 1 || (found.length === 1 && found[0].forms.length > 1)) {
        res.status = 'ambiguous'; res.msg = `${company} 폼이 있는 상품이 여러 개: ${found.map((x) => x.it.code).join(', ')}`; return res;
      }
      if (found.length === 1) {
        res.code = found[0].it.code; res.rentals = found[0].it.rentals; forms = found[0].forms;
        res.notes.push('목록의 렌탈사명에는 없지만 상품 페이지에 렌탈사 폼이 있음 (값이 비어 있는 경우 등)');
      } else {
        res.sameCodes = sameMain.map((x) => x.code);
        if (opts.addCompany && without.length === 1) {
          // 이 상품에 렌탈사가 아예 없음 → 상품 맨 위의 신규 등록 폼으로 렌탈사를 새로 등록
          const nf = without[0].doc.getElementById('PriceInputForm');
          const sel = nf && nf.elements.goods_brand;
          const opt = sel && [...sel.options].find((o) => normCo(o.text) === normCo(company));
          res.code = without[0].it.code; res.rentals = without[0].it.rentals;
          if (!opt) { res.status = 'noform'; res.msg = `${res.code}의 신규 등록 폼에 ${company} 항목이 없음`; return res; }
          const np = planNewForm(nf, byPeriod);
          np.warnings.forEach((w) => res.warnings.push(w));
          res.addCompany = true; res.changes = np.changes; res.status = 'addcompany';
          res.periodText = `신규 등록 (${np.changes.map((c) => c.period).join('·')}개월)`; res.periodOk = true;
          res.msg = `[${company} 새로 등록] ${changeText(np.changes)}`;
          return res;
        }
        res.status = 'nocompany';
        res.msg = `모델은 사이트에 있으나 ${company}가 없음 (같은 모델 상품: ${res.sameCodes.join(', ')})${without.length > 1 ? ' - 상품이 여러 개라 자동 등록 안 함' : ''}`;
        return res;
      }
    }
    const plan = planForm(forms[0], byPeriod, opts);
    // 렌탈기간 일치 여부: 엑셀의 기간들 vs 사이트 렌탈사 폼의 기간들
    const sitePeriods = [...new Set(SLOTS.map((s) => digits(fval(forms[0], 'goods_period', s))).filter(Boolean))].sort((a, b) => a - b);
    const excelPeriods = Object.keys(byPeriod).map(Number).sort((a, b) => a - b);
    const onlyExcel = excelPeriods.filter((p) => !sitePeriods.includes(p)), onlySite = sitePeriods.filter((p) => !excelPeriods.includes(p));
    res.periodOk = !onlyExcel.length && !onlySite.length;
    res.periodText = res.periodOk ? `일치 (${excelPeriods.join('·')}개월)`
      : [onlyExcel.length ? `엑셀에만 ${onlyExcel.join('·')}개월` : '', onlySite.length ? `사이트에만 ${onlySite.join('·')}개월` : ''].filter(Boolean).join(' / ');
    res.changes = plan.changes;
    res.statusFix = formStatusVal(forms[0]) === 'i';                // 이미 있는 렌탈사 폼의 상태가 '대기'면 승인으로 바꿔야 노출됨
    plan.warnings.forEach((w) => res.warnings.push(w));
    if (plan.missing.length && !opts.addMissing) res.notes.push(`사이트에 없는 기간 ${plan.missing.join('·')}개월은 건너뜀`);
    if (!plan.changes.length && plan.warnings.length) {          // 칸이 여러 개라 건너뛴 것이지 "이미 같은 값"이 아님
      res.status = 'ambiguous'; res.msg = '같은 기간 칸이 여러 개라 자동 처리하지 못함';
    } else {
      res.status = plan.changes.length || res.statusFix ? 'ok' : 'nochange';
      res.msg = (plan.changes.length ? changeText(plan.changes) : res.statusFix ? '렌탈료는 같지만 렌탈사 상태가 대기' : '이미 같은 값') + (res.statusFix ? ' · 상태 대기→승인' : '');
    }
    return res;
  }

  // ====================================================================
  // 실행 (여러 페이지를 오가는 상태 머신)
  //   stage: nav(수정 페이지로 이동 필요) → edit(도착, 값 입력 후 렌탈사 수정 클릭) → rental-saving(저장 후 새로고침 대기)
  //          → main-saving('저장 후 목록' 클릭, 목록 도착 대기) → 다음 건
  // ====================================================================
  const getState = () => ssGet(STATE_KEY);
  const putState = (st) => ssSet(STATE_KEY, st);
  const popAlerts = () => { const a = ssGet(ALERT_KEY, []); ssDel(ALERT_KEY); return a; };

  function record(st, status, msg) {
    const job = st.jobs[st.idx];
    st.results.push({ model: job.model, code: job.code, status, msg, at: new Date().toISOString() });
  }
  function pause(st, reason, status = 'fail') {
    const job = st.jobs[st.idx];
    if (job) record(st, status, reason);
    st.running = false; st.paused = reason; st.stage = 'paused';
    putState(st);
    ui.refreshRun();
  }
  const alertProblem = (alerts) => alerts.find((a) => /오류|실패|필수|입력해|확인해|불가/.test(a));

  function gotoJob(st) {
    st.stage = 'edit'; st.stageAt = Date.now();
    putState(st);
    location.href = editUrl(st.jobs[st.idx].code);
  }
  function nextJob(st) {
    st.idx++;
    if (st.idx >= st.jobs.length) { finishRun(st); return; }
    gotoJob(st);
  }
  function finishRun(st) {
    st.running = false; st.stage = 'done'; st.finishedAt = Date.now();
    putState(st);
    ui.refreshRun();
    if (!IS_LIST) location.href = '/admin/goods.php';
  }
  function armWatchdog(stageName) {
    const at = getState()?.stageAt;
    setTimeout(() => {
      const st = getState();
      if (st && st.running && st.stage === stageName && st.stageAt === at) {
        const al = popAlerts();
        const reason = `응답 없음 (${STAGE_TIMEOUT_MS / 1000}초)${al.length ? ' · 사이트 알림: ' + al.join(' / ') : ''}`;
        // 응답 없음이 연속으로 MAX_AUTO_SKIP번 쌓이면(사이트 장애 등) 멈추고, 아니면 이 건은 실패로 기록하고 자동으로 다음 건으로 넘어간다
        let streak = 0;
        for (let i = st.results.length - 1; i >= 0 && String(st.results[i].msg).startsWith(AUTO_SKIP_TAG); i--) streak++;
        if (streak >= MAX_AUTO_SKIP) { pause(st, `${reason} · 연속 ${streak + 1}건 응답 없음으로 자동 중단`); return; }
        record(st, 'fail', `${AUTO_SKIP_TAG} ${reason}`);
        nextJob(st);
      }
    }, STAGE_TIMEOUT_MS);
  }

  // 렌탈사 저장이 확인된 뒤: [저장 후 목록]을 누르거나(기본) 바로 다음 건으로
  function afterRentalSaved(st, job) {
    job.changes = job.changes || [];
    if (!st.opts.pressList) { record(st, 'ok', doneText(st, job)); nextJob(st); return; }
    const btn = [...document.querySelectorAll('button')].find((b) => /ActionCheck\(\s*'mod'\s*,\s*'list'\s*\)/.test(b.getAttribute('onclick') || ''));
    if (!btn) { pause(st, '[저장 후 목록] 버튼을 찾지 못함'); return; }
    if (!st.mode) { const pn = fixProductStatus(); if (pn) { job.statusNote = [job.statusNote, pn].filter(Boolean).join(' · '); st.jobs[st.idx] = job; } }
    st.stage = 'main-saving'; st.stageAt = Date.now(); putState(st);
    ui.refreshRun();
    btn.click();
    armWatchdog('main-saving');
  }

  // 렌탈사 [수정]/[등록]을 누른 뒤 서버의 수정 페이지를 직접 받아서 값이 반영됐는지 확인한다.
  // (수정은 저장 후 새로고침되지만 신규 [등록]은 새로고침이 없어서, 이 확인이 있어야 다음 단계로 넘어갈 수 있다)
  async function pollRentalSaved(st0, job) {
    const at = st0.stageAt, t0 = Date.now();
    while (Date.now() - t0 < STAGE_TIMEOUT_MS - 3000) {
      await sleep(1000);
      const cur = getState();
      if (!cur || !cur.running || cur.stage !== 'rental-saving' || cur.stageAt !== at) return;   // 새로고침 등으로 이미 다른 단계로 넘어감
      let ok = false;
      try {
        const doc = await fetchEdit(job.code);
        const fs = companyForms(doc, cur.company);
        if (fs.length === 1) {
          const remain = planForm(fs[0], job.byPeriod, cur.opts);
          ok = !remain.changes.length && !(job.addCompany && remain.missing.length) && formStatusVal(fs[0]) !== 'i';
        }
      } catch { /* 다음 주기에 다시 */ }
      if (!ok) continue;
      await sleep(2000);                                                                         // 늦게 새로고침될 수도 있어 잠시 대기
      const c2 = getState();
      if (!c2 || !c2.running || c2.stage !== 'rental-saving' || c2.stageAt !== at) return;
      const al = popAlerts();
      const bad = alertProblem(al);
      if (bad) { pause(c2, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(c2, c2.jobs[c2.idx]);
      return;
    }
  }

  // ====================================================================
  // 사이트 단종 정리 실행: 상품 수정 페이지에서 BS렌탈 폼의 상태값만 '삭제'로 바꾸고 [수정] → [저장 후 목록]
  // (다른 렌탈사 폼은 건드리지 않는다)
  // ====================================================================
  const statusSelect = (form) => {
    const sels = [...form.querySelectorAll('select')].filter((x) => x.name !== 'goods_brand' && [...x.options].some((o) => /삭제/.test(o.text)));
    return sels.find((x) => /state|status|stat|use|display|view/i.test(x.name)) || sels[0] || null;
  };
  const isDeletedForm = (form) => { const x = statusSelect(form); return !!x && /삭제/.test((x.options[x.selectedIndex] || {}).text || ''); };

  function tickDisable(st, job, forms) {
    if (st.stage === 'edit') {
      popAlerts();
      if (forms.length !== 1) { pause(st, `${st.company} 렌탈사 폼 ${forms.length}개 (1개여야 함)`); return; }
      const form = forms[0], sel = statusSelect(form);
      if (!sel) { pause(st, '렌탈사 폼에서 상태값(삭제) 선택칸을 찾지 못함 → 렌탈사 폼 화면을 캡처해서 알려 주세요'); return; }
      if (isDeletedForm(form)) { record(st, 'skip', '이미 삭제 상태'); nextJob(st); return; }
      const before = (sel.options[sel.selectedIndex] || {}).text || '';
      setVal(sel, [...sel.options].find((o) => /삭제/.test(o.text)).value);
      job.changes = []; st.jobs[st.idx] = job; job.before = before;
      if (st.opts.practice) {
        pause(st, `연습 모드: 상태값을 [${before}] → [삭제]로만 바꿨습니다. 저장은 하지 않았습니다 → 화면에서 확인하세요. 맞으면 [이 건 실제로 저장하기]를 누르세요`, 'practice');
        return;
      }
      const btn = [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === '수정');
      if (!btn) { pause(st, '렌탈사 [수정] 버튼을 찾지 못함'); return; }
      st.stage = 'rental-saving'; st.stageAt = Date.now(); putState(st);
      ui.refreshRun();
      btn.click();
      armWatchdog('rental-saving');
      pollDisabled(getState(), job);
      return;
    }
    if (st.stage === 'rental-saving') {                      // 저장 후 새로고침됨 → 상태값이 삭제로 반영됐는지 확인
      const al = popAlerts(), bad = alertProblem(al);
      if (forms.length === 1 && !isDeletedForm(forms[0])) { pause(st, `저장 후에도 상태값이 삭제가 아님${al.length ? ' · 알림: ' + al.join(' / ') : ''}`); return; }
      if (bad) { pause(st, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(st, job);
      return;
    }
    if (st.stage === 'main-saving') {
      const al = popAlerts();
      pause(st, `[저장 후 목록] 후에도 수정 페이지에 남아 있음${al.length ? ' · 알림: ' + al.join(' / ') : ''}`);
    }
  }
  async function pollDisabled(st0, job) {
    const at = st0.stageAt, t0 = Date.now();
    while (Date.now() - t0 < STAGE_TIMEOUT_MS - 3000) {
      await sleep(1000);
      const cur = getState();
      if (!cur || !cur.running || cur.stage !== 'rental-saving' || cur.stageAt !== at) return;
      let ok = false;
      try { const fs = companyForms(await fetchEdit(job.code), cur.company); ok = fs.length === 0 || (fs.length === 1 && isDeletedForm(fs[0])); } catch { /* 다음 주기에 다시 */ }
      if (!ok) continue;
      await sleep(2000);
      const c2 = getState();
      if (!c2 || !c2.running || c2.stage !== 'rental-saving' || c2.stageAt !== at) return;
      const al = popAlerts(), bad = alertProblem(al);
      if (bad) { pause(c2, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(c2, c2.jobs[c2.idx]);
      return;
    }
  }

  // 페이지가 열릴 때마다 현재 단계에 맞는 일을 한다
  async function tick() {
    const st = getState();
    if (!st || !st.running) return;
    const job = st.jobs[st.idx];
    if (!job) { finishRun(st); return; }

    if (IS_LIST) {
      if (st.stage === 'main-saving') {                       // '저장 후 목록'을 눌러 목록으로 돌아옴 → 이 건 완료
        const al = popAlerts();
        record(st, 'ok', `${doneText(st, job)}${al.length ? ' · 알림: ' + al.join(' / ') : ''}`);
        nextJob(st); return;
      }
      if (st.stage === 'nav') { gotoJob(st); return; }
      pause(st, `예상하지 못한 페이지(목록) - 단계 ${st.stage}`); return;
    }

    // ---- 수정 페이지 ----
    const code = new URLSearchParams(location.search).get('code');
    if (code !== job.code) { pause(st, `예상과 다른 상품 페이지 (${code} ≠ ${job.code})`); return; }
    const form = companyForms(document, st.company)[0];
    const forms = companyForms(document, st.company);

    if (st.mode === 'lg') { tickLg(st, job, forms); return; }              // LG전자 렌탈료·추가안내정보·상품명 수정
    if (st.mode === 'disable') { tickDisable(st, job, forms); return; }   // 사이트 단종 정리(BS렌탈 폼 상태값 삭제)

    if (st.stage === 'edit') {
      let saveForm = form, saveLabel = '수정', plan = null;
      popAlerts();
      if (forms.length === 0 && st.opts.addCompany && job.addCompany) {
        // 이 상품에 렌탈사가 아직 없음 → 맨 위 신규 등록 폼에서 렌탈사를 고르고 값을 채운 뒤 [등록]
        const nf = document.getElementById('PriceInputForm');
        const sel = nf && nf.elements.goods_brand;
        const opt = sel && [...sel.options].find((o) => normCo(o.text) === normCo(st.company));
        if (!nf || !opt) { pause(st, `신규 등록 폼에서 ${st.company} 항목을 찾지 못함`); return; }
        setVal(sel, opt.value);
        plan = planNewForm(nf, job.byPeriod);
        if (!plan.changes.length) { pause(st, '신규 등록 폼에 넣을 칸이 없음'); return; }
        applyNewForm(nf, plan);
        job.statusNote = approveForm(nf);
        saveForm = nf; saveLabel = '등록';
        job.changes = plan.changes; st.jobs[st.idx] = job;
      } else {
        if (forms.length !== 1) { pause(st, `${st.company} 렌탈사 폼 ${forms.length}개 (1개여야 함)`); return; }
        const p2 = planForm(form, job.byPeriod, st.opts);
        const needApprove = formStatusVal(form) === 'i';
        if (!p2.changes.length && !needApprove) { record(st, 'skip', '이미 같은 값 (변경 없음)'); nextJob(st); return; }
        job.changes = p2.changes; st.jobs[st.idx] = job;
        applyPlan(form, p2.changes);
        job.statusNote = approveForm(form);
      }
      if (st.opts.practice) {
        pause(st, '연습 모드: 값만 채웠습니다. 저장은 하지 않았습니다 → 화면에서 확인하세요. 맞으면 [이 건 실제로 저장하기]를 누르세요', 'practice');
        return;
      }
      const btn = [...saveForm.querySelectorAll('button')].find((b) => b.textContent.trim() === saveLabel);
      if (!btn) { pause(st, `렌탈사 [${saveLabel}] 버튼을 찾지 못함`); return; }
      st.stage = 'rental-saving'; st.stageAt = Date.now(); putState(st);
      ui.refreshRun();
      btn.click();
      armWatchdog('rental-saving');
      pollRentalSaved(getState(), job);       // 새로고침이 일어나지 않아도 서버 값을 직접 확인해서 다음 단계로
      return;
    }

    if (st.stage === 'rental-saving') {                      // 렌탈사 저장 후 새로고침됨 → 값이 반영됐는지 확인
      if (forms.length !== 1) { pause(st, `저장 후 ${st.company} 폼 ${forms.length}개`); return; }
      const al = popAlerts();
      const bad = alertProblem(al);
      const remain = planForm(form, job.byPeriod, st.opts);
      if (formStatusVal(form) === 'i') { pause(st, '저장 후에도 렌탈사 상태가 [대기]입니다 (승인으로 바뀌지 않음)'); return; }
      if (remain.changes.length) { pause(st, `저장 후에도 값이 달라요: ${changeText(remain.changes)}${al.length ? ' · 알림: ' + al.join(' / ') : ''}`); return; }
      if (job.addCompany && remain.missing.length) { pause(st, `신규 등록 후 ${remain.missing.join('·')}개월이 렌탈사 폼에 없음${al.length ? ' · 알림: ' + al.join(' / ') : ''}`); return; }
      if (bad) { pause(st, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(st, job);
      return;
    }

    if (st.stage === 'main-saving') {                        // 목록으로 가야 하는데 수정 페이지에 남음
      const al = popAlerts();
      pause(st, `[저장 후 목록] 후에도 수정 페이지에 남아 있음${al.length ? ' · 알림: ' + al.join(' / ') : ''}`);
    }
  }

  // ====================================================================
  // 화면
  // ====================================================================
  const host = document.createElement('div');
  host.style.cssText = IS_LIST ? 'position:fixed;top:70px;right:16px;z-index:2147483647;' : 'position:fixed;left:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const $ = (s) => root.querySelector(s);
  const setProg = (sel, v, max) => { const el = root.querySelector(sel); if (!el) return; if (max !== undefined) el.max = max; if (v === null) el.removeAttribute('value'); else if (v !== undefined) el.value = v; };

  const CO_LIST = ['LG헬로비젼', 'BS렌탈', '현대UBUS', '스마트렌탈', 'LG전자', 'SK매직', '코웨이', '쿠쿠', '청호나이스', '웰스', '세스코', '현대큐밍', '교원라이프', '이니렌탈'];

  const LOGO_IMG = 'data:image/png;base64,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';
  const ICON = (d, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    logo: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2.2"/>',
    file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 13h5M10 17h5"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M9.5 10v9"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    min: '<path d="M5 19h14"/>',
    expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    shrink: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
    down: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    flash: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  };
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .box{--pri:#a85d00;--pri2:#f59e0b;--soft:#fff4d6;--line:#eee3c8;--bg:#fbf7ee;--txt:#2a2112;--mut:#7a6a48;
        position:relative;font:14px/1.5 'Pretendard','Malgun Gothic','Segoe UI',sans-serif;width:${IS_LIST ? 640 : 360}px;background:#fff;border:1px solid #c7d2f0;border-radius:16px;
        box-shadow:0 18px 50px rgba(180,110,0,.30),0 3px 10px rgba(0,0,0,.12);color:var(--txt);display:flex;flex-direction:column;max-height:calc(100vh - 16px)}
      .head{flex:none;background:linear-gradient(135deg,#f59e0b 0%,#fbbf24 55%,#fde68a 100%);color:#3d2600;padding:12px 14px;display:flex;align-items:center;gap:10px;cursor:move;user-select:none;border-radius:15px 15px 0 0;touch-action:none}
      .logo{width:38px;height:38px;flex:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}
      .logo img{width:100%;height:100%;display:block}
      .ttl{flex:1;min-width:0;line-height:1.25}
      .ttl b{display:block;font-size:15.5px;letter-spacing:-.2px}
      .ttl small{font-size:11.5px;opacity:.85}
      .hbtn{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.55);color:#5a3500;padding:0;display:grid;place-items:center;border:0;cursor:pointer}
      .hbtn:hover{background:rgba(255,255,255,.32)}
      .body{padding:14px;overflow:auto;flex:1 1 auto;min-height:0;background:var(--bg);border-radius:0 0 15px 15px}
      .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 2px rgba(180,110,0,.05)}
      .card-h{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;margin-bottom:10px;color:var(--txt)}
      .card-h .step{width:24px;height:24px;border-radius:50%;background:var(--pri);color:#fff;display:grid;place-items:center;font-size:12.5px;flex:none}
      .card-h .sp{flex:1}
      .card-h svg{color:var(--pri)}
      .hint{color:var(--mut);font-size:12px;margin-top:4px;line-height:1.45}
      button{font:inherit;border:0;border-radius:9px;padding:8px 14px;font-weight:600;cursor:pointer;background:var(--pri);color:#fff;display:inline-flex;align-items:center;gap:6px;transition:background .15s,box-shadow .15s}
      button:hover{background:#7c4a03}
      button:disabled{background:#c5cbdc;cursor:default}
      button.sub{background:#fff;color:var(--pri);border:1px solid #e7c97d;font-weight:600;padding:6px 11px;font-size:13px}
      button.sub:hover{background:var(--soft)}
      button.warn{background:#d92d3a}
      button.warn:hover{background:#b3202c}
      button.hbtn{padding:0;border-radius:9px}
      input[type=text],input[type=number],select{font:inherit;padding:7px 10px;border:1px solid #e3d3ae;border-radius:9px;background:#fff;color:var(--txt);min-width:0}
      input[type=text]:focus,input[type=number]:focus,select:focus{outline:3px solid #cfdcff;border-color:var(--pri2)}
      input[type=checkbox]{width:16px;height:16px;accent-color:var(--pri);margin:0;flex:none}
      input[type=file]{width:100%;font-size:13px;padding:10px;border:2px dashed #b7c5ee;border-radius:12px;background:#f7f9ff;color:var(--mut);cursor:pointer}
      input[type=file]::file-selector-button{font:inherit;font-weight:600;border:0;background:var(--pri);color:#fff;border-radius:8px;padding:6px 12px;margin-right:10px;cursor:pointer}
      label{cursor:pointer}
      progress{width:100%;height:8px;accent-color:var(--pri)}
      .ptabs{display:flex;gap:4px;background:#f6ead0;padding:4px;border-radius:13px;margin-bottom:12px}
      .ptabs button{flex:1;justify-content:center;padding:9px 4px;background:transparent;color:#4a5578;border-radius:10px;font-size:13.5px;font-weight:600}
      .ptabs button:hover{background:rgba(255,255,255,.6)}
      .ptabs button.on{background:#fff;color:var(--pri);box-shadow:0 2px 6px rgba(180,110,0,.18)}
      .fld{display:grid;grid-template-columns:104px 1fr;gap:6px 10px;align-items:center;margin-top:10px}
      .fld>span{font-weight:600;font-size:13px;color:#39435f}
      .fld input,.fld select{width:100%}
      .fld .hint{grid-column:2;margin:-2px 0 0}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
      .row.gap{margin-top:14px}
      .grp{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
      .grp-t{font-size:12px;font-weight:700;color:var(--pri);letter-spacing:.3px;margin-bottom:2px}
      .opt{display:flex;gap:9px;align-items:flex-start;padding:7px 9px;border-radius:9px;margin-top:4px;font-size:13px;background:#f7f9fe}
      .opt:hover{background:var(--soft)}
      .opt input{margin-top:2px}
      .opt b{color:var(--pri)}
      .rng input,.shedit input{width:68px}
      .inl{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .inl input{width:84px}
      .go{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}
      .go #analyze{flex:1;justify-content:center;padding:11px 16px;font-size:14.5px}
      .chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
      .chip{background:#fff;color:#39435f;border:1px solid #d3dbef;border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:600}
      .chip:hover{background:var(--soft)}
      .chip.on{background:var(--pri);color:#fff;border-color:var(--pri)}
      .chip i{font-style:normal;margin-left:5px;padding:0 6px;border-radius:9px;background:rgba(180,110,0,.1);font-size:11.5px}
      .chip.on i{background:rgba(255,255,255,.25)}
      .tblwrap{max-height:430px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
      table{border-collapse:collapse;width:100%;font-size:13.5px}
      #tbl{table-layout:fixed;min-width:100%}
      #tbl td{overflow-wrap:anywhere}
      th .cr{position:absolute;right:-4px;top:0;width:10px;height:100%;cursor:col-resize;z-index:2;touch-action:none}
      th .cr::after{content:'';position:absolute;left:4px;top:25%;width:2px;height:50%;border-radius:1px;background:#9fb0e0}
      th .cr:hover::after,th .cr.on::after{background:var(--pri2);width:3px;left:3px}
      th{position:sticky;top:0;background:#eef2fc;z-index:1;color:#34406a;font-size:12.5px;font-weight:700;padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
      td{padding:11px 12px;border-bottom:1px solid #edf0f8;text-align:left;vertical-align:top;line-height:1.5}
      tbody tr:hover td{background:#f7f9ff}
      tr.chg td{background:#f3f7ff}
      tr.chg td:first-child{box-shadow:inset 4px 0 0 var(--pri2)}
      tr.rvw td:first-child{box-shadow:inset 4px 0 0 #f5a524}
      .mdl{font-weight:700;font-size:14px;word-break:break-all}
      .code{font-weight:700;color:var(--pri)}
      .co{margin-top:3px;font-size:12.5px;color:#4a5578}
      .co .me{display:inline-block;background:var(--pri);color:#fff;border-radius:6px;padding:0 7px;font-weight:700;font-size:12px}
      .ln{margin:2px 0}
      .old{color:#8a93ad;text-decoration:line-through}.old.none{text-decoration:none;font-style:italic}.arr{color:#8a93ad;margin:0 4px}.new{color:var(--pri);font-weight:800}
      .st{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12.5px;font-weight:700;white-space:nowrap}
      .st::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
      .st-ok{background:#ffe9ae;color:#a85d00}.st-addcompany{background:#d8f1ff;color:#006a9e}
      .st-nochange{background:#eceff6;color:#5b6480}.st-done{background:#d9f4e3;color:#13703a}.st-runfail{background:#ffe0e0;color:#b42318}
      .st-nomodel,.st-nocompany,.st-nodata,.st-noform,.st-standalone{background:#fff1d6;color:#9a5b00}
      .st-ambiguous,.st-error,.st-conflict,.st-badmodel{background:#ffe3e1;color:#b42318}
      .rv{color:#b42318;font-weight:700}
      div.rv{background:#fff1f0;border-radius:8px;padding:5px 9px;margin-top:6px;font-size:12.5px}
      .rv2{color:var(--pri);font-weight:700}
      .pok{color:#d92d3a;font-weight:700}.pbad{color:#8a4b00;font-weight:700;background:#fff1d6;border-radius:6px;padding:0 6px}
      .pbox{margin:10px 0 0;padding:9px 12px;background:var(--soft);border:1px solid #f2dba6;border-radius:10px;display:none;font-size:13px}
      .pbox label{display:inline-flex;align-items:center;gap:5px;margin:0 14px 0 0;font-weight:700;color:var(--pri);white-space:nowrap}
      .sheetbox{margin-top:10px}
      .shrow{padding:9px 10px;border:1px solid var(--line);border-radius:10px;margin-top:6px;background:#fbfcff}
      .shrow>label{display:inline-flex;align-items:center;gap:7px;font-size:13.5px}
      .shrow .hint{margin:4px 0 0 23px}
      .shrow .rng{margin-left:6px;font-size:12.5px;color:var(--mut)}
      .shedit{grid-template-columns:repeat(3,1fr);gap:8px 10px;margin:8px 0 2px;font-size:12px;padding:10px;background:#fff;border:1px solid var(--line);border-radius:10px}
      .shedit label{display:flex;flex-direction:column;gap:3px;font-weight:600;color:#39435f}
      .shedit input,.shedit select{width:100%}
      .newbanner{background:#fff6e0;border:1px solid #f5d38a;color:#7a4b00;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px}
      .newbanner button{margin-left:8px}
      .runbox{border:1px solid #f1d49a;border-left:5px solid var(--pri2);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:#fff}
      .runbox b{color:var(--pri)}
      .runbox .row{margin-top:8px}
      #log:empty{display:none}
      #log{padding-top:4px;white-space:pre-wrap;font-size:12.5px;color:#39435f;max-height:130px;overflow:auto;margin-top:6px}
      .tiny{font-size:12px;color:var(--mut)}
      .empty{display:none;text-align:center;padding:34px 18px;color:var(--mut);background:#fff;border:2px dashed #cdd8f3;border-radius:14px}
      .empty .ill{width:62px;height:62px;margin:0 auto 10px;border-radius:50%;background:var(--soft);color:var(--pri);display:grid;place-items:center}
      .empty b{display:block;color:var(--txt);font-size:15px;margin-bottom:6px}
      .empty ol{display:inline-block;text-align:left;margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.9}
      .rz{position:absolute;top:0;width:12px;height:100%;cursor:ew-resize;touch-action:none;z-index:3}
      .rz.r{right:-6px}.rz.l{left:-6px}
      .rz::after{content:'';position:absolute;top:50%;left:4px;width:4px;height:44px;margin-top:-22px;border-radius:2px;background:var(--pri2);opacity:.3;transition:opacity .15s}
      .rz:hover::after,.rz.on::after{opacity:1}
      .fab{display:none;position:fixed;left:18px;bottom:96px;width:64px;height:64px;border-radius:50%;padding:0;justify-content:center;align-items:center;background:transparent;box-shadow:0 8px 22px rgba(180,110,0,.5);z-index:5}
      .fab img{width:100%;height:100%;display:block;border-radius:50%}
      .fab:hover{background:transparent;transform:translateY(-2px) scale(1.04)}
      .fab.run::after{content:'';position:absolute;top:4px;right:4px;width:13px;height:13px;border-radius:50%;background:#ff5a5f;border:2px solid #fff;animation:pl 1.2s infinite}
      @keyframes pl{50%{transform:scale(1.35);opacity:.6}}
      .cols{display:block}
      .box.full{width:100%!important;height:100%;max-height:none!important;border-radius:14px}
      .box.full .rz{display:none}
      .box.full .body{display:flex;flex-direction:column;overflow:hidden}
      .box.full .cols{display:grid;grid-template-columns:minmax(380px,460px) 1fr;gap:16px;flex:1;min-height:0}
      .box.full .col-l,.box.full .col-r{overflow:auto;min-height:0;padding-right:4px}
      .box.full .tblwrap{max-height:calc(100vh - 360px);min-height:240px}
      .box.full .empty{display:block;padding:70px 20px}
      .box.full table{font-size:14px}
      .box.full .mdl{font-size:15px}
      .box:not(.full) .empty.show{display:block}
    </style>
    <div class="box" id="box">
      <div class="rz l" id="lz" title="좌우로 끌어서 너비 조절 (더블클릭: 원래대로)"></div><div class="rz r" id="rz" title="좌우로 끌어서 너비 조절 (더블클릭: 원래대로)"></div>
      <div class="head" id="head">
        <div class="logo"><img src="${LOGO_IMG}" alt=""></div>
        <div class="ttl"><b>LG전자 렌탈료 검수</b><small>TNC 관리자 · <span id="ver"></span></small></div>
        ${IS_LIST ? `<button class="hbtn" id="fullBtn" title="전체 화면으로 보기">${ICON(IC.expand, 17)}</button>` : ''}
        <button class="hbtn" id="hideBtn" title="숨기기 (왼쪽 아래 아이콘으로 다시 열기)">${ICON(IC.min, 17)}</button>
      </div>
      <div class="body" id="body">
        <div class="runbox" id="runBox" style="display:none"></div>
        ${IS_LIST ? `
        <div class="cols">
        <div class="col-l">
        <div class="ptabs" id="ptabs">${Object.keys(PROFILES).map((id) => `<button data-p="${id}" class="${id === PROFILE_ID ? 'on' : ''}">${PROFILES[id].label}</button>`).join('')}</div>
        <div class="card">
          <div class="card-h"><span class="step">1</span>${ICON(IC.file)} 엑셀 불러오기</div>
          <input type="file" id="file" accept=".xlsx,.xlsm,.xls,.csv">
          <div id="xlInfo" class="hint">불러온 엑셀 없음</div>
          <div id="periodBox" class="pbox"></div>
          <div id="sheetBox" class="sheetbox"></div>
        </div>
        <div class="card">
          <div class="card-h"><span class="step">2</span>${ICON(IC.sliders)} 규칙 설정</div>
          <div class="grp-t" style="margin-top:0">대상</div>
          <div class="fld"><span>렌탈사</span><input id="company" type="text" list="coList"><datalist id="coList">${CO_LIST.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
            <div class="hint">사이트 표기 그대로 (예: LG헬로비젼)</div></div>
          <div class="fld"><span>단독몰 렌탈사</span><input id="standalone" type="text">
            <div class="hint">이 이름 하나만 있는 상품에는 위 렌탈사를 연결하지 않고 "신규 등록 필요"로 보고</div></div>
          <div class="grp"><div class="grp-t">값 넣는 방식</div>
          <div class="fld"><span>값이 여러 개일 때</span><select id="multiRule">
            <option value="lowhigh">가장 싼 값 → 금액(할인), 가장 비싼 값 → 정가</option>
            <option value="skip">값이 서로 다르면 건너뛰고 확인 필요로 보고</option>
            <option value="last">아래쪽(나중) 줄의 값 사용</option></select>
            <div class="hint">같은 모델·기간에 엑셀 값이 여러 줄일 때 적용 · 엑셀의 빈 칸은 무시</div></div>
          <label class="opt"><input type="checkbox" id="addCompany"><span>상품에 이 렌탈사가 없으면 <b>새로 등록</b>하고 렌탈료 입력</span></label>
          <label class="opt"><input type="checkbox" id="addMissing"><span>사이트에 없는 기간은 새 칸으로 추가</span></label>
          <label class="opt"><input type="checkbox" id="clearFix"><span>값이 한 줄뿐인 기간은 정가를 비움 (끄면 정가는 그대로)</span></label>
          <label class="opt"><input type="checkbox" id="applyDup"><span>같은 기간 칸이 여러 개면(예: _스탠드/_벽걸이) 모두 같은 값으로</span></label>
          </div>
          <div class="grp"><div class="grp-t">분석 범위</div>
          <div class="fld"><span>엑셀 행 범위</span><div class="inl"><input id="gFrom" type="number" min="1" placeholder="처음"> 행부터 <input id="gTo" type="number" min="1" placeholder="끝"> 행까지</div>
            <div class="hint">선택한 모든 시트에 적용 · 시트 줄에 따로 넣으면 그 시트는 그 값 우선</div></div>
          <div class="fld"><span>모델 수 제한</span><div class="inl">앞에서부터 <input id="limit" type="number" min="1" placeholder="전체"> 개 모델만</div></div>
          </div>
          <div class="go"><button id="analyze">${ICON(IC.flash, 17)} 분석 시작 (사이트 수정 없음)</button><button id="analyzeRun" class="warn">분석 후 바로 수정까지</button><button id="analyzeStop" class="sub" style="display:none">${ICON(IC.stop, 15)} 중지</button></div>
          <progress id="prog" value="0" max="1" style="display:none;margin-top:10px"></progress>
          <div id="progText" class="hint"></div>
        </div>
        </div>
        <div class="col-r">
        <div class="empty" id="emptyBox"><div class="ill">${ICON(IC.table, 30)}</div><b>분석 결과가 여기에 표로 정리됩니다</b>
          <ol><li>위쪽에서 렌탈사 탭을 고르고 엑셀을 불러옵니다</li><li>분석할 시트와 개월 수를 체크합니다</li><li>[분석 시작]을 누르면 사이트와 비교한 결과가 표시됩니다</li></ol></div>
        <div class="card" id="resBox" style="display:none">
          <div class="card-h"><span class="step">3</span>${ICON(IC.table)} 분석 결과 <span class="sp"></span><span id="resSum" class="hint" style="margin:0;font-weight:400"></span></div>
          <div id="newBanner" class="newbanner" style="display:none"></div>
          <div class="chips" id="chips"></div>
          <div class="row" style="margin-top:0"><button class="sub" id="selOk">${ICON(IC.check, 15)} 정상 건만 선택</button><button class="sub" id="selNone">선택 해제</button><span style="flex:1"></span><button class="sub" id="xlsxReport">${ICON(IC.down, 15)} 보고용 엑셀 저장</button><button class="sub" id="csv">CSV</button></div>
          <div class="tblwrap" style="margin-top:10px"><table id="tbl"><colgroup id="cg"></colgroup><thead><tr><th>선택<i class="cr" data-c="0"></i></th><th>상태<i class="cr" data-c="1"></i></th><th>모델<i class="cr" data-c="2"></i></th><th>상품코드 / 렌탈사<i class="cr" data-c="3"></i></th><th>렌탈기간<i class="cr" data-c="4"></i></th><th>변경 내용 / 사유<i class="cr" data-c="5"></i></th></tr></thead><tbody id="rows"></tbody></table></div>
        </div>
        <div class="card" id="execBox" style="display:none">
          <div class="card-h"><span class="step">4</span>${ICON(IC.play)} 실행 <span class="sp"></span><span id="selCount" class="hint" style="margin:0;font-weight:700;color:var(--pri)"></span></div>
          <div class="fld"><span>처리할 개수</span><input id="execLimit" type="number" min="1" placeholder="선택한 전부" style="max-width:160px"></div>
          <label class="opt"><input type="checkbox" id="pressList"><span>렌탈사 [수정] 후 상품 [저장 후 목록]도 누르기</span></label>
          <label class="opt"><input type="checkbox" id="practice"><span>연습: 첫 건의 값만 채우고 저장은 하지 않음</span></label>
          <div class="go"><button id="start" class="warn">${ICON(IC.play, 16)} 선택한 건 실제로 수정 시작</button></div>
          <div class="hint">실행 대상은 <b>체크했고 위 결과 표(상태 칩)에 지금 보이는 건</b>만입니다. 진행 중에는 이 탭을 닫거나 다른 작업을 하지 마세요. 오류가 나면 자동으로 멈춥니다.</div>
        </div>
        </div>
        </div>` : ''}
        <div id="log"></div>
      </div>
    </div>
    <button class="fab" id="fab" title="LG전자 검수 열기"><img src="${LOGO_IMG}" alt=""></button>`;
  document.documentElement.appendChild(host);
  try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch { /* 무시 */ }
  const log = (m) => { const el = $('#log'); if (!el) return; el.textContent += (el.textContent ? '\n' : '') + m; el.scrollTop = el.scrollHeight; };

  // 접기 / 드래그
  let full = false, dragMoved = false;
  const POS_KEY = 'tncLgPos';
  const place = (x, y) => {
    host.style.left = Math.min(Math.max(0, x), Math.max(0, innerWidth - 80)) + 'px';
    host.style.top = Math.min(Math.max(0, y), Math.max(0, innerHeight - 40)) + 'px';
    host.style.right = 'auto'; host.style.bottom = 'auto';
    $('.box').style.maxHeight = Math.max(260, innerHeight - host.getBoundingClientRect().top - 8) + 'px';
  };
  try { const p = lsGet(POS_KEY, null); if (p && Number.isFinite(p.x)) place(p.x, p.y); } catch { /* 무시 */ }
  $('#head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || full) return;
    const r = host.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
    dragMoved = false;
    try { $('#head').setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    const mv = (ev) => { if (!dragMoved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; dragMoved = true; place(ev.clientX - ox, ev.clientY - oy); };
    const up = () => {
      $('#head').removeEventListener('pointermove', mv); $('#head').removeEventListener('pointerup', up);
      if (dragMoved) { const b = host.getBoundingClientRect(); lsSet(POS_KEY, { x: b.left, y: b.top }); }
    };
    $('#head').addEventListener('pointermove', mv); $('#head').addEventListener('pointerup', up);
  });
  // 패널 너비 조절: 양쪽 가장자리 손잡이를 좌우로 끌기 (더블클릭하면 원래 너비)
  const WIDTH_KEY = 'tncLgWidth', MIN_W = 340;
  const boxEl = $('.box');
  const clampW = (w) => Math.max(MIN_W, Math.min(w, 1600, innerWidth - 16));
  try { const sw = Number(localStorage.getItem(WIDTH_KEY)); if (sw >= MIN_W) boxEl.style.width = clampW(sw) + 'px'; } catch { /* 저장된 너비 없음 */ }
  function attachResize(sel, side) {
    const h = $(sel);
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r0 = host.getBoundingClientRect();
      place(r0.left, r0.top);
      const top = host.getBoundingClientRect().top, startX = e.clientX;
      const startW = boxEl.getBoundingClientRect().width, startLeft = host.getBoundingClientRect().left, startRight = startLeft + startW;
      try { h.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      h.classList.add('on');
      const mv = (ev) => {
        const dx = ev.clientX - startX;
        if (side === 'right') boxEl.style.width = Math.max(MIN_W, Math.min(startW + dx, innerWidth - startLeft - 8, 1600)) + 'px';
        else { const w = Math.max(MIN_W, Math.min(startW - dx, startRight - 8, 1600)); boxEl.style.width = w + 'px'; place(startRight - w, top); }
      };
      const up = () => {
        h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
        h.classList.remove('on');
        try { localStorage.setItem(WIDTH_KEY, String(Math.round(boxEl.getBoundingClientRect().width))); const b = host.getBoundingClientRect(); lsSet(POS_KEY, { x: b.left, y: b.top }); } catch { /* 무시 */ }
      };
      h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', () => { boxEl.style.width = ''; try { localStorage.removeItem(WIDTH_KEY); } catch { /* 무시 */ } });
  }
  attachResize('#lz', 'left');
  attachResize('#rz', 'right');
  // 전체 화면 / 숨기기(왼쪽 아래 아이콘으로 다시 열기)
  const HIDE_KEY = 'tncLgHidden';
  let normalCss = '';
  function setFull(on) {
    if (on === full) return;
    full = on;
    const bx = $('#box');
    bx.classList.toggle('full', on);
    if (on) { normalCss = host.style.cssText; host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;padding:14px;z-index:2147483647;background:rgba(10,20,70,.5);'; }
    else host.style.cssText = normalCss;
    const fb = $('#fullBtn');
    if (fb) { fb.innerHTML = ICON(on ? IC.shrink : IC.expand, 17); fb.title = on ? '전체 화면 닫기 (Esc)' : '전체 화면으로 보기'; }
  }
  function setHidden(h) {
    if (h && full) setFull(false);
    $('#box').style.display = h ? 'none' : '';
    $('#fab').style.display = h ? 'inline-flex' : 'none';
    lsSet(HIDE_KEY, h);
  }
  $('#hideBtn').addEventListener('click', () => setHidden(true));
  $('#fab').addEventListener('click', () => setHidden(false));
  if ($('#fullBtn')) $('#fullBtn').addEventListener('click', () => setFull(!full));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && full) setFull(false); });
  setHidden(true);   // 페이지를 열면 항상 축소(왼쪽 아래 아이콘)로 시작

  // ---- 실행 상태 표시 (목록·수정 페이지 공통) ----
  const STAGE_LABEL = { nav: '수정 페이지로 이동', edit: '값 입력', 'rental-saving': '렌탈사 저장 확인 중', 'main-saving': '저장 후 목록 처리 중', paused: '멈춤', done: '완료' };
  function refreshRun() {
    const st = getState();
    const box = $('#runBox');
    const fab = $('#fab');
    if (fab) fab.classList.toggle('run', !!(st && st.running));
    // 작업이 멈췄을 때 '처음 한 번만' 패널을 열어 알려 준다 (이후 페이지를 열 때마다 자동으로 펼쳐지지 않게)
    if (st && !st.running && st.stage === 'paused' && !st.notified) { st.notified = true; putState(st); setHidden(false); }
    if (!st || (!st.running && st.stage !== 'paused' && st.stage !== 'done')) { box.style.display = 'none'; return; }
    box.style.display = '';
    const total = st.jobs.length, done = st.results.length;
    const job = st.jobs[Math.min(st.idx, total - 1)];
    const okN = st.results.filter((r) => r.status === 'ok').length, failN = st.results.filter((r) => r.status === 'fail').length;
    const pracN = st.results.filter((r) => r.status === 'practice').length;
    const isPractice = !st.running && st.stage === 'paused' && pracN > 0 && st.results[st.results.length - 1].status === 'practice';
    let html = `<b>${st.running ? '일괄 수정 진행 중' : st.stage === 'done' ? '일괄 수정 완료' : isPractice ? '연습 모드로 멈춤 (사이트에 저장하지 않음)' : '일괄 수정 멈춤'}</b> · ${done}/${total} (성공 ${okN} · 건너뜀 ${st.results.filter((r) => r.status === 'skip').length} · 실패 ${failN}${pracN ? ` · 연습 ${pracN}` : ''})`;
    if (st.running && job) html += `<div class="tiny">현재: ${esc(job.model)} (${esc(job.code)}) · ${STAGE_LABEL[st.stage] || st.stage}</div>`;
    if (st.paused) html += `<div class="tiny rv">${esc(st.paused)}</div>`;
    html += `<div class="row">`;
    if (st.running) html += `<button class="warn" id="runStop">중지</button>`;
    else if (isPractice) html += `<button class="warn" id="runReal">이 건 실제로 저장하기</button><button class="sub" id="runResume">이 건 건너뛰고 이어서(연습)</button>`;
    else if (st.stage === 'paused') html += `<button id="runResume">이 건 건너뛰고 이어서</button><button class="sub" id="runRetry">이 건 다시 시도</button>`;
    if (!st.running) html += `<button class="sub" id="runCsv">실행 결과 저장(CSV)</button>${IS_LIST ? '<button class="sub" id="runClear">닫기</button>' : '<button class="sub" id="runList">목록으로</button>'}`;
    html += `</div>`;
    box.innerHTML = html;
    const on = (id, fn) => { const el = box.querySelector('#' + id); if (el) el.addEventListener('click', fn); };
    on('runStop', () => { const s = getState(); if (s) { s.running = false; s.stage = 'paused'; s.paused = '사용자가 중지함 (현재 건은 어디까지 처리됐는지 확인하세요)'; putState(s); refreshRun(); } });
    on('runResume', () => { const s = getState(); if (!s) return; s.paused = ''; s.running = true; s.idx++; if (s.idx >= s.jobs.length) { finishRun(s); return; } gotoJob(s); });
    on('runReal', () => { const s = getState(); if (!s) return; s.opts.practice = false; s.results.pop(); s.paused = ''; s.running = true; gotoJob(s); });
    on('runRetry', () => { const s = getState(); if (!s) return; s.results.pop(); s.paused = ''; s.running = true; gotoJob(s); });
    on('runCsv', () => downloadCsv('실행결과', ['모델', '상품코드', '결과', '내용', '시각'], (getState()?.results || []).map((r) => [r.model, r.code, r.status, r.msg, r.at])));
    on('runClear', () => { ssDel(STATE_KEY); refreshRun(); });
    on('runList', () => { location.href = '/admin/goods.php'; });
  }
  const ui = { refreshRun };

  function downloadCsv(name, head, rows) {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const text = '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ====================================================================
  // 목록 페이지 화면 동작
  // ====================================================================
  let excel = null;         // { fileName, sheets: {시트명: 행[][]}, meta: {시트명: {hidden}} }
  let parsed = null;        // buildModels 결과
  let plan = null;          // { company, items:[분석 결과], selected:[key], ... }
  let filter = 'all';
  let analyzing = false, stopAnalyze = false;
  const openEdits = new Set();

  const STATUS_LABEL = {
    ok: '변경 있음', nochange: '변경 없음(일치)', nomodel: '신규 등록 필요', standalone: '단독몰만 있음(신규 등록 필요)',
    nocompany: '렌탈사 추가 필요', addcompany: '렌탈사 신규 등록', ambiguous: '후보 여러 개', conflict: '값 충돌',
    badmodel: '모델명 확인 필요', noform: '폼 없음', nodata: '값 없음', error: '오류',
    done: '변경완료', runfail: '변경 실패(확인 필요)',
  };
  const CHIP_ORDER = ['all', 'ok', 'done', 'runfail', 'addcompany', 'nochange', 'nomodel', 'standalone', 'nocompany', 'ambiguous', 'conflict', 'badmodel', 'noform', 'nodata', 'error', 'review'];
  const standaloneList = () => String(cfg.standalone || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  function readCfgFromUi() {
    cfg.company = $('#company').value.trim();
    cfg.multiRule = $('#multiRule').value;
    cfg.standalone = $('#standalone').value;
    cfg.addMissing = $('#addMissing').checked;
    cfg.clearFix = $('#clearFix').checked;
    cfg.applyDup = $('#applyDup').checked;
    cfg.addCompany = $('#addCompany').checked;
    cfg.limit = $('#limit').value;
    cfg.rowFrom = Number($('#gFrom').value) || 0; cfg.rowTo = Number($('#gTo').value) || 0;
    cfg.pressList = $('#pressList').checked;
    cfg.practice = $('#practice').checked;
    saveCfg();
  }
  function writeCfgToUi() {
    $('#company').value = cfg.company; $('#multiRule').value = cfg.multiRule || 'lowhigh';
    $('#standalone').value = cfg.standalone;
    $('#addMissing').checked = cfg.addMissing; $('#clearFix').checked = cfg.clearFix; $('#limit').value = cfg.limit; $('#gFrom').value = cfg.rowFrom || ''; $('#gTo').value = cfg.rowTo || '';
    $('#applyDup').checked = cfg.applyDup; $('#addCompany').checked = cfg.addCompany;
    $('#pressList').checked = cfg.pressList; $('#practice').checked = cfg.practice;
  }

  // ---- 시트 선택표 ----
  function sheetInfoText(name) {
    const map = sheetMap(name);
    if (!map.detected) return '제목줄을 찾지 못함 (이 시트는 분석하지 않는 것이 보통입니다)';
    return `${map.mode === 'long' ? '세로형' : '가로형'} · 모델 ${map.model}열`
      + (map.mode === 'long' ? ` · 기간 ${map.period}열 · 렌탈료 ${map.price}열` : ' · 기간별 월 렌탈료 열(총 렌탈료는 사용 안 함)') + ` · ${map.startRow}행부터`
      + (map.policyCol ? ` · 수수료정책 ${map.policyCol}열(${PROFILES[PROFILE_ID].skipFixed ? '정액 줄은 제외' : '정액이면 경고'})` : '')
      + (map.onlineCol ? ` · 온라인노출 ${map.onlineCol}열(불가 줄 제외)` : '') + (map.detailCol ? ` · 상세 ${map.detailCol}열(단종·중단 줄 제외)` : '')
      + (map.filterCol ? ` · ${map.filterCol}열이 "${map.filterVal}"인 줄만` : '')
      + (map.rowFrom || map.rowTo ? ` · ${map.rowFrom || '처음'}~${map.rowTo || '끝'}행만` : '');
  }
  function renderSheetBox() {
    const box = $('#sheetBox');
    if (!excel) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="hint">분석할 시트를 체크하세요. 제목줄을 찾지 못한 시트와 숨김 시트는 기본으로 꺼져 있습니다.</div>'
      + Object.keys(excel.sheets).map((name) => {
        const map = sheetMap(name), hidden = !!(excel.meta && excel.meta[name] && excel.meta[name].hidden);
        const n = esc(name);
        const opt = (v, t, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${t}</option>`;
        return `<div class="shrow"><label><input type="checkbox" data-sh="${n}"${sheetOn(name) ? ' checked' : ''}> <b>${n}</b>${hidden ? ' <span class="rv2">(숨김)</span>' : ''}</label>`
          + ` <span class="rng">행 <input type="number" min="1" data-k="rowFrom" data-sh="${n}" value="${map.rowFrom || ''}" placeholder="처음"> ~ <input type="number" min="1" data-k="rowTo" data-sh="${n}" value="${map.rowTo || ''}" placeholder="끝">만 적용</span>`
          + ` <button class="sub" data-edit="${n}">설정</button><div class="hint" data-info="${n}">${esc(sheetInfoText(name))}</div>`
          + `<div class="shedit" data-for="${n}" style="display:${openEdits.has(name) ? 'grid' : 'none'}">`
          + `<label>형식 <select data-k="mode" data-sh="${n}">${opt('long', '세로형', map.mode)}${opt('wide', '가로형', map.mode)}</select></label>`
          + `<label>제목줄 행 <input type="number" min="1" data-k="headerRow" data-sh="${n}" value="${map.headerRow}"></label>`
          + `<label>데이터 시작 행 <input type="number" min="1" data-k="startRow" data-sh="${n}" value="${map.startRow}"></label>`
          + `<label>모델명 열 <input type="text" maxlength="3" data-k="model" data-sh="${n}" value="${esc(map.model)}"></label>`
          + `<label>기간 열(세로형) <input type="text" maxlength="3" data-k="period" data-sh="${n}" value="${esc(map.period || '')}"></label>`
          + `<label>렌탈료 열(세로형) <input type="text" maxlength="3" data-k="price" data-sh="${n}" value="${esc(map.price || '')}"></label>`
          + `<label>제품명 열 <input type="text" maxlength="3" data-k="name" data-sh="${n}" value="${esc(map.name || '')}"></label>`
          + `<label>수수료정책 열(정액 경고) <input type="text" maxlength="3" data-k="policyCol" data-sh="${n}" value="${esc(map.policyCol || '')}" placeholder="예: N"></label>`
          + `<label>행 필터 열 <input type="text" maxlength="3" data-k="filterCol" data-sh="${n}" value="${esc(map.filterCol || '')}" placeholder="예: E"></label>`
          + `<label>필터 값 <input type="text" data-k="filterVal" data-sh="${n}" value="${esc(map.filterVal || '')}" placeholder="예: 운영"></label>`
          + `</div></div>`;
      }).join('');
  }

  function reparse() {
    if (typeof lgReparse === 'function') { lgReparse(); return; }
    parsed = null;
    if (!excel) { $('#xlInfo').textContent = '불러온 엑셀 없음'; renderSheetBox(); return; }
    parsed = buildModels();
    const used = Object.keys(parsed.perSheet);
    const per = used.map((n) => `${esc(n)} ${parsed.perSheet[n].models.size}개`).join(' · ');
    const multi = parsed.models.filter((m) => m.count >= 2).length;
    $('#xlInfo').innerHTML = `${esc(excel.fileName)} · 분석할 시트 <b>${used.length}</b>개 · 모델 <b>${parsed.models.length}</b>개 / ${parsed.lines}줄`
      + (used.length ? `<br>${per}` : '<br><span class="rv">분석할 시트가 없습니다. 아래에서 시트를 체크하세요.</span>')
      + `<br>기간: ${parsed.periods.map((p) => p + '개월').join(', ') || '(못 찾음 - 시트 설정 확인)'} · 2줄 이상인 모델 ${multi}개`
      + (parsed.emptyModel.length ? `<br><span class="rv">모델명이 비어 있는 줄 ${parsed.emptyModel.length}개 → 분석하지 않고 결과 엑셀에 '확인 필요'로 정리</span>` : '')
      + (parsed.skippedPeriod.length ? `<br><span class="hint">개월이 아닌 기간(일시불 등) ${parsed.skippedPeriod.length}줄 제외</span>` : '');
    renderPeriods();
    renderSheetBox();
  }
  // 사이트에 반영할 개월 수 선택 (엑셀에서 찾은 기간만 표시)
  function renderPeriods() {
    const box = $('#periodBox');
    if (!parsed || !parsed.periods.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const off = new Set((cfg.periodOff || []).map(Number));
    box.style.display = 'block';
    box.innerHTML = '사이트에 반영할 개월 수: ' + parsed.periods.map((p) => `<label><input type="checkbox" data-pp="${p}"${off.has(p) ? '' : ' checked'}> ${p}개월</label>`).join('')
      + '<div class="hint">체크한 개월의 렌탈료만 분석·반영합니다 (총 렌탈료는 쓰지 않음).</div>';
  }

  // 시트의 사용 범위(!ref)를 실제로 값이 들어 있는 마지막 행·열까지로 줄인다
  function trimSheetRange(ws) {
    if (!ws || !ws['!ref']) return;
    let maxR = -1, maxC = -1;
    for (const k in ws) {
      if (k[0] === '!') continue;
      const c = ws[k];
      if (c && c.v !== undefined && c.v !== '') {
        const a = XLSX.utils.decode_cell(k);
        if (a.r > maxR) maxR = a.r;
        if (a.c > maxC) maxC = a.c;
      }
    }
    if (maxR < 0) return;
    const r = XLSX.utils.decode_range(ws['!ref']);
    r.e.r = Math.min(r.e.r, maxR); r.e.c = Math.min(r.e.c, maxC);
    ws['!ref'] = XLSX.utils.encode_range(r);
  }

  async function loadExcelFile(file) {
    if (typeof XLSX === 'undefined') { log('엑셀 읽기 라이브러리를 불러오지 못했습니다.'); return; }
    $('#xlInfo').textContent = `읽는 중… ${file.name}`;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
      const sheets = {}, meta = {};
      const hiddenFlags = (wb.Workbook && wb.Workbook.Sheets) || [];
      for (const name of wb.SheetNames) {
        trimSheetRange(wb.Sheets[name]);                       // 서식만 늘어난 100만 행짜리 시트도 값이 있는 범위까지만 읽는다
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        sheets[name] = rows.map((r) => Array.from(r, (c) => (c === undefined || c === null ? '' : c)));
        const hf = hiddenFlags.find((s) => s.name === name);
        meta[name] = { hidden: !!(hf && hf.Hidden) };
      }
      excel = { fileName: file.name, sheets, meta };
      reparse();
      const ok = await storeSet(excelKey(), excel);
      log(`엑셀 불러옴: ${file.name} (시트 ${wb.SheetNames.length}개)${ok ? '' : ' (기억 불가: 페이지를 닫으면 다시 선택해야 합니다)'}`);
    } catch (err) {
      $('#xlInfo').textContent = '엑셀을 읽지 못했습니다.';
      log('엑셀 읽기 실패: ' + (err && err.message ? err.message : err));
    }
  }

  // ---- 분석 ----
  async function runAnalysis() {
    readCfgFromUi();
    reparse();
    if (!parsed || !parsed.models.length) { log('분석할 모델이 없습니다. 엑셀과 시트 선택을 확인하세요.'); return; }
    if (!cfg.company) { log('렌탈사를 입력하세요.'); return; }
    const limit = Number(cfg.limit) || 0;
    const models = limit ? parsed.models.slice(0, limit) : parsed.models;
    analyzing = true; stopAnalyze = false;
    $('#analyze').disabled = true; $('#analyzeRun').disabled = true; $('#analyzeStop').style.display = '';
    { const pg = $('#prog'); if (pg) pg.style.display = ''; setProg('#prog', 0, models.length); }
    const items = [];
    let cursor = 0, doneN = 0;
    const opts = {
      addMissing: cfg.addMissing, clearFix: cfg.clearFix, applyDup: cfg.applyDup, addCompany: cfg.addCompany,
      multiRule: cfg.multiRule, standalone: standaloneList(),
    };
    const worker = async () => {
      while (!stopAnalyze) {
        const i = cursor++;
        if (i >= models.length) return;
        const m = models[i];
        let res;
        try { res = await analyzeModel(m, cfg.company, opts); }
        catch (err) { res = { key: m.key, model: m.model, count: m.count, tags: m.tags, sheets: m.sheets, srcRows: srcText(m), code: '', status: 'error', msg: String(err && err.message || err), changes: [], warnings: [], notes: [] }; }
        items[i] = res;
        doneN++;
        setProg('#prog', doneN);
        $('#progText').textContent = `분석 중 ${doneN}/${models.length} · ${m.model}`;
        await sleep(80);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    analyzing = false;
    $('#analyze').disabled = false; $('#analyzeRun').disabled = false; $('#analyzeStop').style.display = 'none';
    const done = items.filter(Boolean);
    $('#progText').textContent = stopAnalyze ? `중지됨 (${done.length}/${models.length}건 분석)` : `분석 완료 (${done.length}건)`;
    plan = {
      company: cfg.company, fileName: excel.fileName, items: done, opts,
      selected: done.filter((r) => (r.status === 'ok' || r.status === 'addcompany') && !isReview(r)).map((r) => r.key),
      emptyModel: parsed.emptyModel, skippedPeriod: parsed.skippedPeriod, periods: parsed.periods, sheetsUsed: Object.keys(parsed.perSheet),
    };
    ssSet(planKey(), plan);
    filter = 'all';
    renderResults();
  }

  const isReview = (r) => r.warnings.length > 0;
  // 이 상품에 등록된 렌탈사들을 보여 주고, 대상 렌탈사를 강조
  const rentalsHtml = (r) => (r.rentals && r.rentals.length
    ? `<div class="co">렌탈사: ${r.rentals.map((x) => (normCo(x) === normCo(plan.company) ? `<span class="me">${esc(x)}</span>` : esc(x))).join(', ')}</div>` : '');

  // ---- 결과를 엑셀 파일로 (보고용) ----
  function downloadXlsx(name, sheetsDef) {
    if (typeof XLSX === 'undefined') { log('엑셀 쓰기 라이브러리를 불러오지 못했습니다.'); return; }
    const wb = XLSX.utils.book_new();
    for (const s of sheetsDef) {
      const ws = XLSX.utils.aoa_to_sheet([s.head, ...s.rows]);
      ws['!cols'] = s.head.map((h, i) => ({ wch: Math.min(60, Math.max(8, ...[h, ...s.rows.slice(0, 200).map((r) => r[i])].map((x) => String(x == null ? '' : x).length * 1.6))) }));
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `${name}_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function exportReport() {
    if (!plan) return;
    const periods = plan.periods && plan.periods.length ? plan.periods : [36, 48, 60];
    const modelByKey = new Map(((parsed && parsed.models) || []).map((m) => [m.key, m]));
    const cell = (v) => (v == null ? '' : v);
    const sheetsDef = [];
    sheetsDef.push({
      name: '분석결과', head: ['엑셀 시트', '엑셀 행', '모델명', '상태', '상품코드', '렌탈사 목록', '렌탈기간', '변경 내용 / 사유', '확인사항'],
      rows: plan.items.map((r) => [(r.sheets || []).join(', '), r.srcRows || '', r.model, STATUS_LABEL[r.status] || r.status, r.code, (r.rentals || []).join(', '), r.periodText || '', r.msg, [...r.warnings, ...(r.notes || [])].join(' | ')]),
    });
    if ((plan.emptyModel || []).length) {
      sheetsDef.push({
        name: '모델명없음_확인필요', head: ['엑셀 시트', '엑셀 행', '품목', '제품명(규정명)', '렌탈기간', '렌탈료', '안내'],
        rows: plan.emptyModel.map((e) => [e.sheet, e.row, e.item, e.rule, e.period, e.price, '모델명이 존재하지 않으니 확인이 필요합니다']),
      });
    }
    const excelRows = (r, extra) => {
      const m = modelByKey.get(r.key);
      if (!m) return [[STATUS_LABEL[r.status], '', '', r.model, '', ...periods.map(() => ''), extra]];
      return m.rowsData.map((rd) => [STATUS_LABEL[r.status], rd.sheet, rd.row, rd.item, m.model, rd.name, ...periods.map((p) => cell(rd.prices[p])), extra]);
    };
    const periodHead = periods.map((p) => p + '개월');
    const needNew = plan.items.filter((r) => r.status === 'nomodel' || r.status === 'standalone');
    if (needNew.length) {
      sheetsDef.push({
        name: '신규등록필요', head: ['구분', '엑셀 시트', '엑셀 행', '품목', '모델명', '제품명(규정명/약정)', ...periodHead, '비고(사이트의 같은 모델 상품)'],
        rows: needNew.flatMap((r) => excelRows(r, r.status === 'standalone' ? `단독몰 상품만 있음: ${(r.sameCodes || []).join(' ')} → 가전종합몰은 복사 등록 필요` : '사이트에 모델 없음')),
      });
    }
    const needCo = plan.items.filter((r) => r.status === 'nocompany');
    if (needCo.length) {
      sheetsDef.push({
        name: '렌탈사추가필요', head: ['구분', '엑셀 시트', '엑셀 행', '품목', '모델명', '제품명(규정명/약정)', ...periodHead, '비고(사이트의 같은 모델 상품)'],
        rows: needCo.flatMap((r) => excelRows(r, `${(r.sameCodes || []).join(' ')} (${plan.company} 없음)`)),
      });
    }
    const other = plan.items.filter((r) => ['conflict', 'badmodel', 'ambiguous', 'noform', 'nodata', 'error'].includes(r.status));
    const skipped = plan.skippedPeriod || [];
    if (other.length || skipped.length) {
      sheetsDef.push({
        name: '확인필요_기타', head: ['구분', '엑셀 시트', '엑셀 행', '모델명', '내용'],
        rows: [...other.map((r) => [STATUS_LABEL[r.status], (r.sheets || []).join(', '), r.srcRows || '', r.model, r.msg]),
          ...skipped.map((s) => ['제외된 기간', s.sheet, s.row, s.model, `${s.period} ${s.price} - ${s.reason}`])],
      });
    }
    downloadXlsx(`${plan.company}_분석결과`, sheetsDef);
    log(`결과 엑셀을 저장했습니다 (시트 ${sheetsDef.length}개: ${sheetsDef.map((s) => s.name).join(', ')})`);
  }

  // 변경 내용을 기간별로 줄을 나누고, 이전 값 → 새 값을 한눈에 보이게 꾸민다
  function fmtMsg(msg) {
    return String(msg || '').split(' / ').map((ln) => `<div class="ln">${esc(ln).replace(/(\(없음\)|[\d,]+)\s*→\s*([\d,]+)/g, (m, o, n) => `<span class="old${o[0] === '(' ? ' none' : ''}">${o}</span><span class="arr">→</span><span class="new">${n}</span>`)}</div>`).join('');
  }
  // 일괄 수정을 실행한 결과를 분석 결과 표에 반영: 성공한 건은 '변경완료', 실패한 건은 '변경 실패'로 바꾸고 선택에서 뺀다
  function applyRunToPlan() {
    const st = getState();
    if (!plan || !st || st.mode === 'disable' || !st.results || (st.profile && st.profile !== PROFILE_ID)) return;
    let changed = false;
    for (const r of st.results) {
      if (r.status !== 'ok' && r.status !== 'skip' && r.status !== 'fail') continue;
      const it = plan.items.find((x) => x.code === r.code && x.model === r.model && (x.status === 'ok' || x.status === 'addcompany' || x.status === 'runfail'));
      if (!it) continue;
      it.status = r.status === 'ok' ? 'done' : r.status === 'skip' ? 'nochange' : 'runfail';
      it.runMsg = r.msg || ''; it.runAt = r.at || '';
      plan.selected = plan.selected.filter((k) => k !== it.key);
      changed = true;
    }
    if (changed) ssSet(planKey(), plan);
  }
  function renderResults() {
    applyRunToPlan();
    if (!plan) return;
    $('#resBox').style.display = ''; $('#execBox').style.display = ''; $('#emptyBox').style.display = 'none';
    const counts = { all: plan.items.length };
    plan.items.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; if (isReview(r)) counts.review = (counts.review || 0) + 1; });
    $('#chips').innerHTML = CHIP_ORDER.filter((k) => counts[k]).map((k) =>
      `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${k === 'all' ? '전체' : k === 'review' ? '확인 필요' : STATUS_LABEL[k]}<i>${counts[k]}</i></button>`).join('');
    $('#resSum').textContent = `검수 대상 렌탈사: ${plan.company}${plan.fileName ? ' · ' + plan.fileName : ''}`;
    const nNew = counts.nomodel || 0, nStd = counts.standalone || 0, nAdd = counts.nocompany || 0, nEmpty = (plan.emptyModel || []).length;
    const parts = [];
    if (nNew || nStd) parts.push(`<b>신규 등록이 필요한 모델 ${nNew + nStd}개</b> (사이트에 모델 없음 ${nNew}${nStd ? ` · 단독몰 상품만 있음 ${nStd}` : ''})`);
    if (nAdd) parts.push(`모델은 있으나 <b>${esc(plan.company)} 추가가 필요한 모델 ${nAdd}개</b>`);
    if (nEmpty) parts.push(`<b>모델명이 비어 있는 줄 ${nEmpty}개</b>`);
    $('#newBanner').style.display = parts.length ? '' : 'none';
    $('#newBanner').innerHTML = parts.length ? `⚠ ${parts.join(' · ')} <button class="sub" id="newXlsx">보고용 엑셀 저장</button>` : '';
    const list = plan.items.filter((r) => filter === 'all' || (filter === 'review' ? isReview(r) : r.status === filter));
    $('#rows').innerHTML = list.slice(0, 1500).map((r) => {
      const sel = plan.selected.includes(r.key);
      const can = r.status === 'ok' || r.status === 'addcompany';
      const warn = (r.warnings.length ? `<div class="rv">${r.warnings.map(esc).join('<br>')}</div>` : '')
        + ((r.notes || []).length ? `<div class="hint">${r.notes.map(esc).join('<br>')}</div>` : '');
      return `<tr class="${can ? 'chg' : ''}${isReview(r) ? ' rvw' : ''}"><td>${can ? `<input type="checkbox" data-k="${esc(r.key)}"${sel ? ' checked' : ''}>` : ''}</td>`
        + `<td><span class="st st-${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>`
        + `<td><div class="mdl">${esc(r.model)}${r.count > 1 ? ` <small>(${r.count}줄)</small>` : ''}</div><div class="hint">${esc(r.srcRows || '')}</div>${(r.origs || []).length ? `<div class="hint">엑셀 표기: ${esc(r.origs.join(', '))} → 끝의 _영문 뗌</div>` : ''}</td>`
        + `<td>${r.code ? `<div class="code">${esc(r.code)}</div>` : ''}${rentalsHtml(r)}</td>`
        + `<td>${r.periodText ? `<span class="${r.periodOk ? 'pok' : 'pbad'}">${esc(r.periodText)}</span>` : ''}</td>`
        + `<td>${r.status === 'done' ? `<div class="hint" style="color:#13703a;font-weight:700">✔ 사이트에 반영됨${r.runAt ? ' · ' + esc(new Date(r.runAt).toLocaleString('ko-KR')) : ''}</div>` : ''}${r.status === 'runfail' ? `<div class="rv">✖ 반영 실패: ${esc(r.runMsg || '')}</div>` : ''}${fmtMsg(r.msg)}${warn}</td></tr>`;
    }).join('') + (list.length > 1500 ? `<tr><td colspan="6" class="hint">… 외 ${list.length - 1500}건 (엑셀 보고서에서 전체 확인)</td></tr>` : '');
    updSel();
  }

  // 실행 대상 = 체크했고 + 지금 화면(상태 칩)에 보이는 건만. 다른 칩에 숨어 있는 체크 건은 실행하지 않는다
  const inView = (r) => filter === 'all' || (filter === 'review' ? isReview(r) : r.status === filter);
  const viewChosen = () => (plan ? plan.items.filter((r) => plan.selected.includes(r.key) && (r.status === 'ok' || r.status === 'addcompany') && inView(r)) : []);
  function updSel() {
    const n = viewChosen().length, all = plan ? plan.selected.length : 0;
    $('#selCount').textContent = all === n ? `선택 ${n}건` : `전체 선택 ${all}건 중 지금 화면 ${n}건만 실행`;
    $('#start').disabled = !n;
    $('#start').lastChild.textContent = ` 지금 화면에서 선택한 ${n}건 실제로 수정 시작`;
  }

  function startRun() {
    readCfgFromUi();
    if (!plan || !plan.selected.length) { log('실행할 건을 선택하세요.'); return; }
    const limit = Number($('#execLimit').value) || 0;
    const chosen = viewChosen();
    const jobs = (limit ? chosen.slice(0, limit) : chosen).map((r) => ({ key: r.key, model: r.model, code: r.code, byPeriod: r.byPeriod, changes: r.changes, addCompany: !!r.addCompany, statusFix: !!r.statusFix }));
    if (!jobs.length) { log('실행할 건이 없습니다.'); return; }
    const practice = $('#practice').checked;
    const nFixed = chosen.filter((r) => r.fixedFee).length;
    if (nFixed && !confirm(`정액 렌탈료가 포함되어 있습니다. (선택한 ${chosen.length}건 중 ${nFixed}건)\n\n반영하시겠습니까?\n\n[확인] 반영하고 진행   [취소] 진행하지 않음`)) { log('정액 렌탈료가 포함되어 있어 진행하지 않았습니다.'); return; }
    const msg = practice
      ? `연습 모드: 첫 건(${jobs[0].model} / ${jobs[0].code})의 수정 페이지를 열어 값만 채우고 멈춥니다. 저장은 하지 않습니다.`
      : `[${plan.company}] ${jobs.length}건을 실제로 수정합니다.\n\n각 건마다 ① 상품 수정 페이지 열기 → ② 렌탈료·정가 입력 → ③ 렌탈사 [수정]/[등록] 저장 → ${$('#pressList').checked ? '④ 상품 [저장 후 목록] → 다음 건\n' : '다음 건\n'}\n- 오류가 나면 자동으로 멈춥니다.\n- 진행 중에는 이 탭을 닫지 마세요.\n\n시작할까요?`;
    if (!confirm(msg)) return;
    ssDel(ALERT_KEY);
    const st = {
      running: true, profile: PROFILE_ID, stage: 'nav', stageAt: Date.now(), company: plan.company, idx: 0, jobs, results: [], startedAt: Date.now(),
      opts: { addMissing: cfg.addMissing, clearFix: cfg.clearFix, applyDup: cfg.applyDup, addCompany: cfg.addCompany, pressList: $('#pressList').checked, practice },
    };
    putState(st);
    // main-world.js(alert 자동 처리)는 페이지가 새로 열릴 때 적용되므로, 첫 건도 수정 페이지로 이동하며 시작
    gotoJob(st);
  }

  // 결과 표 열 너비: 제목 칸 사이의 경계선을 좌우로 끌어 조절 (더블클릭: 원래대로), 표가 넓어지면 가로 스크롤
  const COLS_KEY = 'tncLgCols';
  const COL_DEFAULT = [58, 150, 190, 230, 120, 440], COL_MIN = 44;
  function initColumns() {
    let w = lsGet(COLS_KEY, null);
    if (!Array.isArray(w) || w.length !== COL_DEFAULT.length) w = COL_DEFAULT.slice();
    const apply = () => {
      $('#cg').innerHTML = w.map((x) => `<col style="width:${x}px">`).join('');
      $('#tbl').style.width = w.reduce((a, b) => a + b, 0) + 'px';
    };
    apply();
    root.querySelectorAll('#tbl th .cr').forEach((h) => {
      const c = Number(h.dataset.c);
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startW = w[c];
        try { h.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
        h.classList.add('on');
        const mv = (ev) => { w[c] = Math.max(COL_MIN, Math.min(1200, Math.round(startW + ev.clientX - startX))); apply(); };
        const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); h.classList.remove('on'); lsSet(COLS_KEY, w); };
        h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
      h.addEventListener('dblclick', () => { w[c] = COL_DEFAULT[c]; apply(); lsSet(COLS_KEY, w); });
    });
  }

  function initListUi() {
    writeCfgToUi();
    initColumns();
    $('#ptabs').addEventListener('click', (e) => {
      const id = e.target.dataset && e.target.dataset.p;
      if (!id || id === PROFILE_ID) return;
      const st = ssGet(STATE_KEY);
      if (st && st.running) { alert('일괄 수정이 진행 중입니다. 끝나거나 멈춘 뒤에 탭을 바꿔 주세요.'); return; }
      lsSet(ACTIVE_KEY, id); location.reload();      // 탭마다 설정·엑셀·분석 결과가 따로 저장되어 있어 다시 열면 그 탭 상태로 복원됨
    });
    $('#file').addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; if (f) await loadExcelFile(f); e.target.value = ''; });
    ['#company', '#multiRule', '#standalone', '#addCompany', '#addMissing', '#clearFix', '#applyDup', '#limit', '#gFrom', '#gTo', '#pressList', '#practice'].forEach((id) => $(id).addEventListener('change', () => { readCfgFromUi(); if (id === '#gFrom' || id === '#gTo') reparse(); }));
    // 시트 선택표: 체크 / 설정 열기 / 설정 값 변경
    $('#periodBox').addEventListener('change', (e) => {
      const p = Number(e.target.dataset && e.target.dataset.pp);
      if (!p) return;
      const off = new Set((cfg.periodOff || []).map(Number));
      if (e.target.checked) off.delete(p); else off.add(p);
      cfg.periodOff = [...off]; saveCfg(); reparse();
    });
    $('#sheetBox').addEventListener('click', (e) => {
      const name = e.target.dataset && e.target.dataset.edit;
      if (!name) return;
      if (openEdits.has(name)) openEdits.delete(name); else openEdits.add(name);
      const panel = [...root.querySelectorAll('.shedit')].find((p) => p.dataset.for === name);
      if (panel) panel.style.display = openEdits.has(name) ? 'grid' : 'none';
    });
    $('#sheetBox').addEventListener('change', (e) => {
      const name = e.target.dataset && e.target.dataset.sh;
      if (!name) return;
      const sc = cfg.sheetCfg[name] = cfg.sheetCfg[name] || {};
      if (e.target.type === 'checkbox') sc.on = e.target.checked;
      else {
        const k = e.target.dataset.k;
        const v = e.target.value.trim();
        if (['headerRow', 'startRow', 'rowFrom', 'rowTo'].includes(k)) sc[k] = Number(v) || undefined;
        else if (k === 'mode' || k === 'filterVal') sc[k] = v;                  // 필터 값은 글자 그대로 (대문자로 바꾸지 않음)
        else sc[k] = v.toUpperCase();                                          // 열 글자
      }
      saveCfg(); reparse();
    });
    $('#analyze').addEventListener('click', runAnalysis);
    $('#analyzeRun').addEventListener('click', async () => { await runAnalysis(); if (plan && plan.selected.length && !stopAnalyze) startRun(); });
    $('#analyzeStop').addEventListener('click', () => { stopAnalyze = true; });
    $('#newBanner').addEventListener('click', (e) => { if (e.target.id === 'newXlsx') exportReport(); });
    $('#chips').addEventListener('click', (e) => { const f = e.target.dataset && e.target.dataset.f; if (f) { filter = f; renderResults(); } });
    $('#rows').addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k || !plan) return;
      plan.selected = e.target.checked ? [...new Set([...plan.selected, k])] : plan.selected.filter((x) => x !== k);
      ssSet(planKey(), plan); updSel();
    });
    $('#selOk').addEventListener('click', () => { plan.selected = plan.items.filter((r) => (r.status === 'ok' || r.status === 'addcompany') && !isReview(r)).map((r) => r.key); ssSet(planKey(), plan); renderResults(); });
    $('#selNone').addEventListener('click', () => { plan.selected = []; ssSet(planKey(), plan); renderResults(); });
    $('#xlsxReport').addEventListener('click', exportReport);
    $('#csv').addEventListener('click', () => downloadCsv('분석결과', ['엑셀 시트', '엑셀 행', '모델', '상태', '상품코드', '변경내용/사유', '확인사항'], plan.items.map((r) => [(r.sheets || []).join(', '), r.srcRows || '', r.model, STATUS_LABEL[r.status] || r.status, r.code, r.msg, [...r.warnings, ...(r.notes || [])].join(' | ')])));
    $('#start').addEventListener('click', startRun);
    // 이전 분석 결과·엑셀 복원
    const savedPlan = ssGet(planKey());
    if (savedPlan && savedPlan.items) { plan = savedPlan; renderResults(); }
    storeGet(excelKey()).then((x) => {
      if (!x || !x.sheets) return;
      excel = x;
      reparse();
    });
  }

  // ====================================================================
  // 사이트 단종 정리 (BS렌탈 탭 전용)
  //  1) 사이트 목록(현재 검색 조건 그대로)에서 BS렌탈 상품을 전부 읽는다
  //  2) 엑셀의 판매중·에어컨특가·삼성프로모션 등 '운영 시트'에 모델이 있으면 살아 있는 상품
  //  3) 운영 시트에 없으면 단종 후보 (엑셀 단종/일시중단 시트에 있으면 그 구분, 없으면 '엑셀에 없음=사이트 기준')
  //  4) 후보 상품의 검색문구(goods_keyword)에 운영 시트 모델명이 있으면 같은 모델이므로 후보에서 제외하고 따로 보고
  // ====================================================================
  const DIS_KEY_BASE = 'tncLgDis';
  const disKey = () => `${DIS_KEY_BASE}:${PROFILE_ID}`;
  const DIS_ACT = ['disc', 'pause', 'stop', 'unlist', 'fixed', 'noprice', 'none', 'similar', 'nomodel'];   // 체크박스가 있는 구분 (비슷한 모델·모델명 확인 필요 포함)
  const DIS_ORDER = ['disc', 'pause', 'stop', 'unlist', 'fixed', 'noprice', 'none', 'similar', 'kw', 'nomodel'];
  const DIS_LABEL = { disc: '단종', pause: '일시중단', stop: '판매중단', unlist: '온라인노출 불가', fixed: '정액만 있음(정률 없음)', noprice: '월렌탈료 없음(24·36·39·48·60개월)', none: '엑셀에 없음(사이트 기준)', similar: '엑셀에 비슷한 모델 있음(확인 필요)', kw: '검색문구 일치(제외)', nomodel: '모델명 확인 필요' };
  const modelKeys = (m) => [...new Set([normModel(m), normModel(String(m || '').replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '')), normModel(fixModelName(m))])].filter((k) => k.length >= 3);
  let dis = null, stopDis = false, disBusy = false, disFilter = 'all', disType = 'all', disQuery = '';   // disType: all / only(A타입: BS렌탈만) / multi(B타입: 다른 렌탈사도 연결)

  // ====================================================================
  // 렌탈사별 엑셀 규칙: 어떤 모델이 '운영 중'이고, 어떤 모델이 단종/중단인지 엑셀에서 가려낸다
  //  반환: { active: 운영 모델 키 모음, disc: Map(키 → {cls, note}), used: 읽은 시트 요약, list: 비슷한 모델 비교용 이름 목록 }
  // ====================================================================
  const hNorm = (c) => String(c == null ? '' : c).replace(/\s+/g, '').trim();
  const cellStr = (v) => String(v == null ? '' : v).trim();
  const sheetHidden = (name) => !!(excel.meta && excel.meta[name] && excel.meta[name].hidden);
  const DIS_PRI = ['disc', 'pause', 'stop', 'unlist', 'fixed', 'noprice'];   // 같은 모델에 이유가 여러 개면 앞쪽이 우선
  function findHeaderRow(rows, needs, maxScan = 40) {
    for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
      const h = (rows[i] || []).map(hNorm);
      const idx = needs.map((n) => h.findIndex((c) => (n instanceof RegExp ? n.test(c) : c === n)));
      if (idx.every((x) => x >= 0)) return { row: i, h, idx };
    }
    return null;
  }
  const newSets = () => ({ active: new Set(), disc: new Map(), used: [], list: [], seen: new Set() });
  function addActive(S, model, name) {
    modelKeys(model).forEach((k) => S.active.add(k));
    [model, name].forEach((t) => { const k = normModel(t); if (k.length >= 3 && !S.seen.has(k)) { S.seen.add(k); S.list.push({ k, text: cellStr(t) }); } });
  }
  function addDisc(S, model, cls, note) {
    modelKeys(model).forEach((k) => { const cur = S.disc.get(k); if (!cur || DIS_PRI.indexOf(cls) < DIS_PRI.indexOf(cur.cls)) S.disc.set(k, { cls, note }); });
  }

  // 세로형 시트(모델명·기간·렌탈료)를 쓰는 렌탈사 (비에스온·현대UBUS)
  //  cfg.skip: 아예 읽지 않을 시트 / cfg.disc: 단종·중단 목록 시트 / cfg.kindOf(시트명, 줄의 안내 글): 'disc'|'pause'|'alive'|null
  function excelSetsLong(cfg) {
    const S = newSets();
    for (const name of Object.keys(excel.sheets)) {
      if (sheetHidden(name) || cfg.skip.test(name)) continue;
      const rows = excel.sheets[name];
      if (cfg.disc.test(name)) {
        const H = findHeaderRow(rows, [/^(상품명\/)?모델명$/]);
        if (!H) continue;
        const mi = H.idx[0], ki = H.h.findIndex((c) => /^(안내사항|상세)$/.test(c));
        let n = 0;
        for (let i = H.row + 1; i < rows.length; i++) {
          const model = cellStr((rows[i] || [])[mi]);
          if (!model) continue;
          const tag = ki >= 0 ? cellStr(rows[i][ki]) : '';
          const kind = cfg.kindOf(name, tag);
          if (!kind) continue;
          if (kind === 'alive') addActive(S, model, ''); else addDisc(S, model, kind, `엑셀 ${name} 시트${tag ? ': ' + tag : ''}`);
          n++;
        }
        S.used.push(`${name}(중단목록) ${n}줄`);
        continue;
      }
      if (!detectSheet(rows)) continue;
      const map = sheetMap(name), mi = colIndex(map.model), ni = map.name ? colIndex(map.name) : -1;
      if (mi < 0) continue;
      let n = 0;
      for (let i = map.startRow - 1; i < rows.length; i++) {
        const v = cellStr((rows[i] || [])[mi]);
        if (!v) continue;
        addActive(S, v, ni >= 0 ? cellStr(rows[i][ni]) : '');
        n++;
      }
      S.used.push(`${name}(운영) ${n}줄`);
    }
    return S;
  }

  // 스마트렌탈: 운영(렌탈) 시트의 상태가 운영·배송지연이면 운영, 일시중단이면 일시중단, 미운영 시트에 있으면 단종(미운영)
  function excelSetsSmart() {
    const S = newSets();
    for (const name of Object.keys(excel.sheets)) {
      if (sheetHidden(name)) continue;
      const isOff = /미운영/.test(name), isOn = !isOff && /^운영/.test(name.trim());
      if (!isOn && !isOff) continue;
      const rows = excel.sheets[name];
      const H = findHeaderRow(rows, ['상태', '모델명']);
      if (!H) continue;
      const si = H.idx[0], mi = H.idx[1], ni = H.h.indexOf('상품명'), bi = H.h.indexOf('비고');
      let n = 0;
      for (let i = H.row + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const model = cellStr(r[mi]);
        if (!model) continue;
        const st = cellStr(r[si]);
        if (isOff) { addDisc(S, model, 'disc', `엑셀 미운영 시트에 있음${bi >= 0 && cellStr(r[bi]) ? ' · ' + cellStr(r[bi]) : ''}`); n++; }
        else if (/^(운영|배송지연)/.test(st)) { addActive(S, model, ni >= 0 ? cellStr(r[ni]) : ''); n++; }
        else if (/일시\s*중단|판매\s*중단|운영\s*중단/.test(st)) { addDisc(S, model, 'pause', `엑셀 운영 시트 상태: ${st}`); n++; }
      }
      S.used.push(`${name}(${isOff ? '미운영' : '운영'}) ${n}줄`);
    }
    return S;
  }

  // KT가전구독: '가전구독 정책'·'구독형' 시트의 모델코드는 운영, 정책 안내 시트의 '운영 중단' 목록은 단종 (표에 없는 모델은 미운영)
  function excelSetsKt() {
    const S = newSets();
    for (const name of Object.keys(excel.sheets)) {
      if (sheetHidden(name)) continue;
      const rows = excel.sheets[name];
      let H = null, n = 0;
      if (/가전구독\s*정책/.test(name) && (H = findHeaderRow(rows, ['운영상태', '모델코드']))) {
        const si = H.idx[0], mi = H.idx[1], ni = H.h.indexOf('상품명');
        for (let i = H.row + 1; i < rows.length; i++) {
          const r = rows[i] || [], model = cellStr(r[mi]);
          if (!model) continue;
          const st = cellStr(r[si]);
          if (/중단|종료|단종/.test(st)) addDisc(S, model, 'disc', `엑셀 정책 시트 운영상태: ${st}`); else addActive(S, model, ni >= 0 ? cellStr(r[ni]) : '');
          n++;
        }
        S.used.push(`${name}(운영) ${n}줄`);
      } else if (/구독형/.test(name) && (H = findHeaderRow(rows, ['모델코드']))) {
        const mi = H.idx[0], ni = H.h.indexOf('상품명');
        for (let i = H.row + 1; i < rows.length; i++) {
          const r = rows[i] || [], model = cellStr(r[mi]);
          if (!model) continue;
          addActive(S, model, ni >= 0 ? cellStr(r[ni]) : '');
          n++;
        }
        S.used.push(`${name}(운영) ${n}줄`);
      } else if (/정책\s*안내|월간/.test(name)) {
        let sec = '';
        for (const r0 of rows) {
          const r = r0 || [], a = cellStr(r[0]);
          if (/^\d+\.\s/.test(a) && !cellStr(r[1])) { sec = a; continue; }
          if (!a && !cellStr(r[1]) && !cellStr(r[2])) { sec = ''; continue; }
          if (/기타\s*정책/.test(a)) { sec = ''; continue; }
          if (!sec || !a || !cellStr(r[2]) || /^[•▶※]/.test(a)) continue;
          if (/운영\s*중단|단종/.test(sec)) { addDisc(S, cellStr(r[2]), 'disc', `엑셀 정책 안내 [${sec.replace(/\s*\(.*$/, '')}] 목록`); n++; }
        }
        S.used.push(`${name}(운영중단 안내) ${n}줄`);
      }
    }
    return S;
  }

  // LG헬로비전: 온라인 노출 '불가' 줄과 상세(B열)의 단종·일시중단·판매중단 줄은 검수에서 제외 (운영 아님),
  //            수수료정책이 정액인 줄은 사이트가 정률 기준이라 제외, 24·36·39·48·60개월 월렌탈료가 하나도 없어도 제외
  function excelSetsLg() {
    const S = newSets();
    for (const name of Object.keys(excel.sheets)) {
      if (sheetHidden(name)) continue;
      const rows = excel.sheets[name];
      const H = findHeaderRow(rows, ['모델코드', '수수료정책', /온라인노출/]);
      if (!H) continue;
      const [mi, pi, oi] = H.idx;
      const di = H.h.indexOf('상세'), oldi = H.h.indexOf('변경전모델코드'), ni = H.h.indexOf('모델명');
      // 제목줄이 두 줄(위: 일반가/직영몰가, 아래: 24개월·36개월…)인 양식이라 두 줄을 모두 보고, 데이터는 두 번째 제목줄 아래부터 읽는다
      const nextH = (rows[H.row + 1] || []).map(hNorm), second = nextH.includes('모델코드');
      const months = [];
      for (const hh of second ? [H.h, nextH] : [H.h]) hh.forEach((c, j) => { if (/^(24|36|39|48|60)개월/.test(c) && !months.includes(j)) months.push(j); });
      let nOk = 0, nOut = 0;
      for (let i = H.row + (second ? 2 : 1); i < rows.length; i++) {
        const r = rows[i] || [], model = cellStr(r[mi]);
        if (!model) continue;
        const detail = di >= 0 ? cellStr(r[di]) : '', online = cellStr(r[oi]).replace(/\s+/g, ' '), policy = cellStr(r[pi]);
        const hasPrice = months.some((j) => { const p = parsePriceCell(r[j]); return p.n >= 1000; });
        let cls = '', note = '';
        if (/단종/.test(detail)) { cls = 'disc'; note = `엑셀 상세: ${detail}`; }
        else if (/일시\s*중단/.test(detail)) { cls = 'pause'; note = `엑셀 상세: ${detail}`; }
        else if (/(판매|운영)\s*중단/.test(detail)) { cls = 'stop'; note = `엑셀 상세: ${detail}`; }
        else if (/^불가/.test(online) || !/가능/.test(online)) { cls = 'unlist'; note = `엑셀 온라인 노출: ${online || '비어 있음'} → 검수 제외`; }
        else if (!/정률/.test(policy)) { cls = 'fixed'; note = '엑셀 수수료정책이 정액뿐 (사이트는 정률 기준)'; }
        else if (!hasPrice) { cls = 'noprice'; note = '엑셀에 24·36·39·48·60개월 월렌탈료가 없음'; }
        if (!cls) {
          addActive(S, model, ni >= 0 ? cellStr(r[ni]) : '');
          if (oldi >= 0 && cellStr(r[oldi])) modelKeys(cellStr(r[oldi])).forEach((k) => S.active.add(k));   // 변경 전 모델코드도 운영으로 본다 (모델코드만 바뀐 상품)
          nOk++;
        } else { addDisc(S, model, cls, note); nOut++; }
      }
      S.used.push(`${name}(운영 ${nOk}줄 · 제외 ${nOut}줄)`);
    }
    return S;
  }

  const ubusKind = (name, tag) => (/운영\s*재개/.test(tag) ? 'alive' : /단종/.test(tag) ? 'disc' : /중단|일시품절/.test(tag) ? 'pause' : null);
  function excelSetsLgel() {
    const S = newSets();
    const p = lgParseWorkbook(excel.sheets);
    p.recs.forEach((r) => {
      [r.model1, r.model2].filter(Boolean).forEach((m) => {
        addActive(S, m, '');
        lgKeys(m).forEach((k) => { S.active.add(k); if (r.cat === 'ac') { S.active.add(k + 'M'); if (/M$/.test(k) && k.length >= 8) S.active.add(k.slice(0, -1)); } });
      });
    });
    S.used = Object.entries(p.perCat).map(([id, v]) => `${(LG_CATS.find((c) => c.id === id) || {}).label} ${v.n}줄(운영)`);
    return S;
  }
  function excelModelSets() {
    if (PROFILE_ID === 'lgel') return excelSetsLgel();
    if (PROFILE_ID === 'smart') return excelSetsSmart();
    if (PROFILE_ID === 'kt') return excelSetsKt();
    if (PROFILE_ID === 'lg') return excelSetsLg();
    if (PROFILE_ID === 'ubus') return excelSetsLong({ skip: /운영기준|PB/, disc: /운영중단/, kindOf: ubusKind });
    return excelSetsLong({ skip: /필독/, disc: /단종|일시\s*중단/, kindOf: (name) => (/단종/.test(name) ? 'disc' : 'pause') });
  }

  function parseListDoc(doc) {
    const lf = doc.getElementById('ListForm');
    if (!lf) throw new Error('상품 목록 표를 찾지 못함 (로그인 만료?)');
    const headRow = [...lf.querySelectorAll('tr')].find((tr) => tr.querySelector('th') && /상품코드/.test(tr.textContent));
    const heads = headRow ? [...headRow.children].map((h) => h.textContent.replace(/\s+/g, ' ').trim()) : [];
    const ix = (label) => heads.findIndex((h) => h.includes(label));
    const ci = ix('상품코드'), ri = ix('렌탈사명'), mi = ix('모델명'), ni = ix('상품명');
    if (ci < 0 || ri < 0 || mi < 0) throw new Error('목록 표 구조가 달라졌습니다');
    const items = [...lf.querySelectorAll('tr')].filter((tr) => tr.querySelector('input[name="idx[]"]')).map((tr) => {
      const t = (i) => (i >= 0 && tr.children[i] ? tr.children[i].textContent.replace(/\s+/g, ' ').trim() : '');
      return { code: t(ci), rentals: t(ri).split(',').map((x) => x.trim()).filter(Boolean), model: t(mi), name: t(ni) };
    });
    const m = doc.body.textContent.match(/검색결과\s*([\d,]+)\s*건/);
    return { total: m ? Number(m[1].replace(/,/g, '')) : items.length, items };
  }

  // 지금 화면의 검색 조건(렌탈사명 brand, 진열상태 status_open 등)을 그대로 써서 모든 페이지를 읽는다
  function searchBase() {
    const sf = [...document.forms].find((f) => f.id !== 'ListForm' && f.elements && f.elements.search_keyword);
    const params = new URLSearchParams(sf ? new FormData(sf) : location.search);
    const keys = {};
    document.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]([A-Za-z_]*(?:page|pg)[A-Za-z_]*)=(\d+)/i);
      if (m) keys[m[1]] = (keys[m[1]] || 0) + 1;
    });
    const pk = Object.keys(keys).sort((a, b) => keys[b] - keys[a])[0] || 'page';
    params.delete(pk);
    return { params, pk };
  }
  async function readSiteList(onProg) {
    const { params, pk } = searchBase();
    const all = [], seen = new Set();
    let total = 0;
    for (let p = 1; p <= 400 && !stopDis; p++) {
      const q = new URLSearchParams(params); q.set(pk, String(p));
      const r = parseListDoc(await fetchDoc('/admin/goods.php?' + q.toString()));
      if (p === 1) total = r.total;
      const fresh = r.items.filter((it) => !seen.has(it.code));
      if (!fresh.length) break;
      fresh.forEach((it) => { seen.add(it.code); it.page = p; all.push(it); });
      onProg(p, all.length, total);
      if (total && all.length >= total) break;
      await sleep(60);
    }
    return { items: all, total, pageKey: pk };
  }

  // 사이트 모델명이 엑셀의 모델명/상품명 안에 들어 있거나(예: 사이트 '뉴허브미' ⊂ 엑셀 '[뉴젠] 뉴젠 사우나 반신욕기 뉴허브미'), 그 반대면 같은 제품일 수 있음
  function similarInExcel(ks, list) {
    for (const sk of ks) {
      for (const e of list) {
        if ((sk.length >= 4 && e.k.includes(sk)) || (e.k.length >= 5 && sk.includes(e.k))) return e.text;
      }
    }
    return '';
  }

  async function runDisAnalysis(preselect = true) {
    if (disBusy) return false;
    if (!excel) { log('먼저 1번 엑셀 불러오기에서 엑셀을 선택하세요.'); return false; }
    const sets = excelModelSets();
    if (!sets.active.size) { log('엑셀에서 운영 중인 모델을 찾지 못했습니다. 이 렌탈사 탭에 맞는 엑셀을 불러왔는지, 시트 구성이 바뀌지 않았는지 확인하세요.'); return false; }
    const co = PROFILES[PROFILE_ID].company;
    const totalNow = (document.body.textContent.match(/검색결과\s*([\d,]+)\s*건/) || [])[1];
    if (totalNow && Number(totalNow.replace(/,/g, '')) > 1500 &&
      !confirm(`현재 목록 검색결과가 ${totalNow}건입니다.\n렌탈사명을 [${co}]로, 진열상태를 [진열]로 고르고 검색한 뒤 실행하는 것이 빠릅니다.\n\n그래도 지금 조건으로 모두 읽을까요?`)) return false;
    disBusy = true; stopDis = false;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    $('#disAnalyze').disabled = true; $('#disRun').disabled = true; $('#disStop').style.display = '';
    $('#disProg').style.display = ''; $('#disProg').removeAttribute('value');
    try {
      const site = await readSiteList((p, n, t) => set('#disText', `사이트 목록 읽는 중 ${p}페이지 · ${n}/${t}건`));
      const bs = site.items.filter((it) => it.rentals.some((r) => normCo(r) === normCo(co)));
      const out = [], aliveN = { n: 0 };
      const cand = [];
      for (const it of bs) {
        const ks = modelKeys(it.model);
        const row = { code: it.code, model: it.model, name: it.name, rentals: it.rentals, page: it.page, handle: it.rentals.every((r) => normCo(r) === normCo(co)) ? 'only' : 'multi', cls: '', note: '' };
        if (!ks.length) { row.cls = 'nomodel'; row.note = '사이트 모델명이 비었거나 너무 짧음'; out.push(row); continue; }
        if (ks.some((k) => sets.active.has(k))) { aliveN.n++; continue; }
        const dk = ks.find((k) => sets.disc.has(k));
        const dinfo = dk ? sets.disc.get(dk) : null;
        if (!dk) {
          const sim = similarInExcel(ks, sets.list);
          if (sim) { row.cls = 'similar'; row.note = `엑셀 운영 시트에 비슷한 이름이 있음 → 같은 제품일 수 있어 후보에서 제외: ${sim.slice(0, 90)}`; out.push(row); continue; }
        }
        row.cls = dinfo ? dinfo.cls : 'none';
        row.note = dinfo ? dinfo.note : '엑셀 어느 시트에도 없음 → 사이트 관리 기준';
        out.push(row); cand.push(row);
      }
      // 후보의 검색문구에 운영 시트 모델명이 있으면 같은 모델 → 후보에서 제외
      setProg('#disProg', 0, Math.max(1, cand.length));
      let cursor = 0, doneN = 0, fail = 0;
      const worker = async () => {
        while (!stopDis) {
          const i = cursor++;
          if (i >= cand.length) return;
          const row = cand[i];
          try {
            const doc = await fetchEdit(row.code);
            const kwEl = doc.querySelector('[name="goods_keyword"]');
            row.kw = kwEl ? String(kwEl.value || '').trim() : '';
            const hit = row.kw.split(/[,\s/|]+/).filter(Boolean).find((tk) => modelKeys(tk).some((k) => sets.active.has(k)));
            if (hit) { row.cls = 'kw'; row.note = `검색문구에 운영 중인 모델 [${hit}] 있음 → 같은 모델로 보고 후보에서 제외`; }
            else if (!kwEl) row.note += ' · 검색문구 칸을 찾지 못해 확인 못함';
          } catch (err) { fail++; row.note += ` · 검색문구 확인 실패(${String(err && err.message || err)})`; }
          doneN++; setProg('#disProg', doneN);
          set('#disText', `검색문구 확인 중 ${doneN}/${cand.length}`);
          await sleep(80);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      out.sort((a, b) => DIS_ORDER.indexOf(a.cls) - DIS_ORDER.indexOf(b.cls));
      dis = {
        at: Date.now(), co, fileName: excel.fileName, siteTotal: site.total, siteRead: site.items.length, bsN: bs.length, aliveN: aliveN.n,
        sheets: sets.used, pageKey: site.pageKey, rows: out, partial: site.items.length < site.total || stopDis, kwFail: fail,
        selected: preselect ? out.filter((r) => ['disc', 'pause', 'stop'].includes(r.cls)).map((r) => r.code) : [],   // [분석 시작]은 아무것도 미리 체크하지 않음
      };
      ssSet(disKey(), dis);
      set('#disText', stopDis ? '중지됨 (일부만 분석)' : `분석 완료 · 후보 ${out.filter((r) => DIS_ACT.includes(r.cls) && r.cls !== 'similar' && r.cls !== 'nomodel').length}건`);
      disFilter = 'all'; renderDis();
      return !stopDis;
    } catch (err) {
      set('#disText', '오류: ' + String(err && err.message || err)); return false;
    } finally {
      disBusy = false;
      $('#disAnalyze').disabled = false; $('#disRun').disabled = false; $('#disStop').style.display = 'none'; $('#disProg').style.display = 'none';
    }
  }

  const bulkOk = (r) => ['disc', 'pause', 'stop', 'none'].includes(r.cls) || disFilter === r.cls;   // 확인이 필요한 구분은 그 칩을 보고 있을 때만 일괄 선택
  const disCands = () => (dis ? dis.rows.filter((r) => DIS_ACT.includes(r.cls)) : []);
  // 검색어: 띄어쓰기로 나눈 단어가 모델명·상품명·상품코드·검색문구·비고에 모두 들어 있는 줄만 (예: '침대', '블룸 SK')
  const disMatch = (r) => {
    if (!disQuery) return true;
    const hay = [r.model, r.name, r.code, r.note, r.kw, (r.rentals || []).join(' ')].join(' ').toLowerCase();
    return disQuery.toLowerCase().split(/s+/).filter(Boolean).every((t) => hay.includes(t));
  };
  const disVisible = () => (dis ? dis.rows.filter((r) => (disFilter === 'all' || r.cls === disFilter) && (disType === 'all' || r.handle === disType) && disMatch(r)) : []);
  const disSelectedAll = () => disCands().filter((r) => dis.selected.includes(r.code));
  // 실행 대상 = 체크했고 + 지금 화면(필터 칩)에 보이는 것만. 다른 칩에 숨어 있는 체크 건은 실행하지 않는다
  const disChosen = () => disSelectedAll().filter((r) => (disFilter === 'all' || r.cls === disFilter) && (disType === 'all' || r.handle === disType) && disMatch(r));

  function renderDis() {
    if (!dis) return;
    const box = $('#disBox'); box.style.display = '';
    const cnt = {}; dis.rows.forEach((r) => { cnt[r.cls] = (cnt[r.cls] || 0) + 1; });
    const ch = disChosen(), nOnly = ch.filter((r) => r.handle === 'only').length, nMulti = ch.length - nOnly;
    $('#disSum').innerHTML = `사이트 ${dis.siteRead}/${dis.siteTotal}건 읽음 → ${esc(dis.co)} 포함 <b>${dis.bsN}</b>건 · 엑셀 운영 시트에 있음(유지) ${dis.aliveN}건<br>`
      + DIS_ORDER.filter((k) => cnt[k]).map((k) => (['disc', 'pause', 'stop', 'similar'].includes(k) ? `<b>${DIS_LABEL[k]} ${cnt[k]}</b>` : `${DIS_LABEL[k]} ${cnt[k]}`)).join(' · ')
      + (dis.partial ? `<div class="rv">⚠ 사이트 목록을 끝까지 읽지 못했습니다 (${dis.siteRead}/${dis.siteTotal}건, 페이지 변수 ${esc(dis.pageKey)}). 결과가 일부일 수 있습니다.</div>` : '')
      + `<div class="hint">기준 시트: ${esc(dis.sheets.join(' / '))}</div>`;
    $('#disChips').innerHTML = `<button class="chip ${disFilter === 'all' ? 'on' : ''}" data-f="all">전체<i>${dis.rows.length}</i></button>`
      + DIS_ORDER.filter((k) => cnt[k]).map((k) => `<button class="chip ${disFilter === k ? 'on' : ''}" data-f="${k}">${DIS_LABEL[k]}<i>${cnt[k]}</i></button>`).join('');
    const cands = disCands(), nA = cands.filter((r) => r.handle === 'only').length, nB = cands.length - nA;
    $('#disTypes').innerHTML = [['all', '타입 전체', cands.length], ['only', `A타입 · ${dis.co}만 연결`, nA], ['multi', `B타입 · 다른 렌탈사도 연결 (${dis.co}+다른 렌탈사)`, nB]]
      .map(([k, t, n]) => `<button class="chip ${disType === k ? 'on' : ''}" data-t="${k}">${t}<i>${n}</i></button>`).join('');
    const list = disVisible();
    const qi = $('#disQInfo'); if (qi) qi.innerHTML = disQuery ? `<b>‘${esc(disQuery)}’</b> 검색 결과 <b>${list.length}</b>건 · 지우려면 ✕` : `전체 <b>${list.length}</b>건 표시`;
    const cb0 = $('#disAllChk'); if (cb0) { const cc = list.filter(bulkOk); const n = cc.filter((r) => dis.selected.includes(r.code)).length; cb0.checked = !!cc.length && n === cc.length; cb0.indeterminate = n > 0 && n < cc.length; cb0.disabled = !cc.length; }
    $('#disRows').innerHTML = list.slice(0, 1500).map((r) => {
      const can = DIS_ACT.includes(r.cls);
      return `<tr class="${r.cls === 'kw' || r.cls === 'nomodel' || r.cls === 'similar' ? 'rvw' : ''}"><td>${can ? `<input type="checkbox" data-c="${esc(r.code)}"${dis.selected.includes(r.code) ? ' checked' : ''}>` : ''}</td>`
        + `<td><span class="st dst-${r.cls}">${DIS_LABEL[r.cls]}</span></td>`
        + `<td><div class="mdl">${esc(r.model)}</div><div class="hint">${esc(r.code)}</div></td>`
        + `<td>${esc(r.name)}<div class="co">렌탈사: ${r.rentals.map((x) => (normCo(x) === normCo(dis.co) ? `<span class="me">${esc(x)}</span>` : esc(x))).join(', ')}</div></td>`
        + `<td>${can ? (r.handle === 'only' ? 'A타입 · 목록에서 진열→삭제' : `B타입 · 수정 페이지에서 ${esc(dis.co)}만 삭제`) : ''}<div class="hint">${esc(r.note)}${r.kw ? ' · 검색문구: ' + esc(r.kw.slice(0, 60)) : ''}</div></td></tr>`;
    }).join('');
    const nAll = disSelectedAll().length;
    $('#disSel').textContent = (disFilter === 'all' && disType === 'all' && !disQuery) ? `선택 ${nAll}건 (목록 삭제 ${nOnly} · 수정 페이지 삭제 ${nMulti})` : `전체 선택 ${nAll}건 중 지금 화면(필터) ${ch.length}건 (목록 삭제 ${nOnly} · 수정 페이지 삭제 ${nMulti})`;
    $('#disAuto').disabled = !ch.length; $('#disAuto').textContent = `선택한 ${ch.length}건 단종 처리`;
  }

  function exportDis() {
    if (!dis) return;
    const head = ['구분', '상품코드', '모델명', '상품명', '렌탈사명', '처리 방식', '비고', '검색문구', '선택'];
    const rows = dis.rows.map((r) => [DIS_LABEL[r.cls], r.code, r.model, r.name, r.rentals.join(', '), DIS_ACT.includes(r.cls) ? (r.handle === 'only' ? '목록 삭제' : `${dis.co}만 삭제`) : '', r.note, r.kw || '', dis.selected.includes(r.code) ? 'O' : '']);
    downloadXlsx('사이트단종분석', [{ name: '후보및확인', head, rows }]);
  }

  // ====================================================================
  // 목록 삭제 자동 진행 (상품 하나씩): 1차 검색어에 모델명을 넣어 검색 → 그 상품 한 줄만 체크 → 상태를 삭제로 → 적용 → 다음 상품
  //  - 검색은 지금 목록의 조건(렌탈사명 BS렌탈·진열상태 진열 등)을 그대로 쓰고 검색어만 바꾼다. 모델명으로 못 찾으면 상품코드로 한 번 더 찾는다
  //  - 적용 후에는 같은 검색을 다시 조회해서 그 상품이 목록에서 사라졌는지 확인한다
  //  - 다른 렌탈사도 있는 상품은 이 뒤에 수정 페이지 방식(BS렌탈 폼 상태값 삭제)으로 이어서 처리한다
  // ====================================================================
  const LD_KEY = 'tncLgLD';
  const ldGet = () => ssGet(LD_KEY);
  const ldPut = (v) => ssSet(LD_KEY, v);
  const searchKeyOf = (model) => String(model || '').replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '').trim() || String(model || '').trim();
  // [A타입 2단계] ld.ph === 'hide': 진열 목록에서 그 줄을 체크 → 진열상태 [숨김] → 상태 변경
  //              ld.ph === 'trash': 같은 상품을 (진열상태 조건 없이) 다시 검색 → 체크 → 상태값 [삭제] → 상태 변경하기 → 휴지통으로 이동
  const ldUrl = (ld) => {
    const it = ld.queue[ld.i];
    const q = new URLSearchParams(ld.base);
    q.delete(ld.pageKey);
    q.set('search_item', 'all'); q.set('search_keyword', ld.tryN === 0 && searchKeyOf(it.model).length >= 3 ? searchKeyOf(it.model) : it.code); q.set('search_keyword2', '');
    if (ld.ph === 'trash') q.set('status_open', '');                // 숨김 처리된 상품도 보이도록 진열상태 조건을 뺀다
    return '/admin/goods.php?' + q.toString();
  };
  // 이 상품이 (진열상태 조건을 status로 바꿔 검색한) 목록에 있는지. status: 'y' 진열 / 'n' 숨김 / '' 전체
  async function ldHas(ld, status, item) {
    const q = new URLSearchParams(ld.base);
    q.delete(ld.pageKey);
    q.set('search_item', 'all'); q.set('search_keyword', ld.tryN === 0 && searchKeyOf(item.model).length >= 3 ? searchKeyOf(item.model) : item.code); q.set('search_keyword2', ''); q.set('status_open', status);
    return parseListDoc(await fetchDoc('/admin/goods.php?' + q.toString())).items.some((it) => it.code === item.code);
  }
  const PH_RE = { hide: /숨김/, trash: /삭제|휴지통/ };
  const PH_LABEL = { hide: '1단계 진열상태→숨김', trash: '2단계 상태값→삭제(휴지통)' };
  const listCodeCol = (lf) => {
    const headRow = [...lf.querySelectorAll('tr')].find((tr) => tr.querySelector('th') && /상품코드/.test(tr.textContent));
    return headRow ? [...headRow.children].findIndex((h) => /상품코드/.test(h.textContent)) : -1;
  };
  // 목록 아래의 상태 변경 선택칸(원하는 옵션이 있는 select, 검색 영역은 제외)과 그 선택칸 바로 뒤에 있는 변경 버튼
  function findBulk(lf, re) {
    const sel = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => re.test(o.text))
      && (lf.contains(x) || (lf.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)));
    if (!sel) return {};
    const bt = (b) => (b.innerText || b.value || '').trim();
    let btn = null;
    for (let el = sel.parentElement, d = 0; el && !btn && d < 5; el = el.parentElement, d++) {
      const cands = [...el.querySelectorAll('button,input[type=button],input[type=submit],a')].filter((b) => /변경|적용|확인|저장/.test(bt(b)) && !/삭제|숨김|진열/.test(bt(b).replace(/상태\s*변경/g, '')));
      btn = cands.find((b) => sel.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) || cands[0] || null;
    }
    const exact = sel.id ? document.querySelector(`[onclick*="ActionModifyStatus('${sel.id}')"]`) : null;   // 이 사이트: 선택칸 id와 같은 이름을 부르는 [상태 변경] 버튼
    if (exact) btn = exact;
    return { sel, btn, label: btn ? bt(btn) : '', opt: [...sel.options].find((o) => re.test(o.text)) };
  }

  function ldStop(ld, msg, kind) {
    ld.running = false; ld.stage = kind || 'paused'; ld.msg = msg;
    ldPut(ld); renderLd();
  }
  function ldNext(ld) {
    ld.i++; ld.tryN = 0; ld.ph = ld.startPh || 'hide'; ld.hideSkipped = false; ld.stage = 'nav'; ld.pending = '';
    if (ld.i >= ld.queue.length) { ldFinish(ld); return; }
    ldPut(ld);
    location.href = ldUrl(ld);
  }
  function ldFinish(ld) {
    ld.running = false; ld.stage = 'done'; ld.finishedAt = Date.now();
    const okN = ld.results.filter((r) => r.ok).length, failN = ld.results.length - okN;
    ld.msg = `목록 삭제 완료 · 성공 ${okN} · 실패 ${failN}`;
    ldPut(ld);
    if (ld.multi && ld.multi.length) {                              // 이어서: 다른 렌탈사도 있는 상품은 수정 페이지에서 BS렌탈만 삭제
      ld.msg += ` · 이어서 수정 페이지 처리 ${ld.multi.length}건 시작`;
      ldPut(ld);
      startEditRun(ld.multi, ld.practice, ld.co);
      return;
    }
    renderLd();
  }

  // 상태 변경을 눌렀고 목록에서 사라졌거나(새로고침 없이 처리되는 경우 포함) 새로고침된 뒤: 같은 검색을 다시 조회해서 확인하고 다음 단계로
  async function ldAfterApply(ld) {
    const item = ld.queue[ld.i];
      const popped = popAlerts();
      let found = null, why = '';
      for (let k = 0; k < 4; k++) {                                 // 서버 반영이 늦을 수 있어 최대 4번(약 5초) 다시 조회
        // 1단계(숨김)는 '숨김 목록에 나타났는지'로, 2단계(삭제)는 '전체 목록에서 사라졌는지'로 확인 (found = 아직 처리 전 상태로 남아 있는가)
        try { found = ld.ph === 'hide' ? !(await ldHas(ld, 'n', item)) : await ldHas(ld, '', item); } catch (err) { why = String(err && err.message || err); found = null; break; }
        if (!found) break;
        await sleep(1500);
      }
      if (found === null) { ldStop(ld, `${item.code} 확인 실패 (${why})`); return; }
      const note = popped.length ? ' · 알림: ' + popped.join(' / ') : '';
      if (ld.ph === 'hide') {
        if (found) { ld.results.push({ at: new Date().toISOString(), code: item.code, model: item.model, ok: false, msg: '숨김 처리 후에도 숨김 목록에서 찾지 못함' + note }); ldNext(ld); return; }
        ld.ph = 'trash'; ld.tryN = 0; ld.stage = 'nav'; ld.pending = ''; ldPut(ld);   // 1단계 성공 → 2단계(삭제)로
        location.href = ldUrl(ld);
        return;
      }
      ld.results.push({ at: new Date().toISOString(), code: item.code, model: item.model, ok: !found, msg: (found ? '삭제 처리 후에도 목록에 남아 있음' : '이 모델을 사이트에서 단종처리 하였습니다 (숨김 → 삭제, 휴지통으로 이동)') + note });
      ldNext(ld); return;
  }

  async function tickListDel() {
    const ld = ldGet();
    if (!ld) return;
    renderLd();
    if (!ld.running) return;
    try { setHidden(false); } catch { /* 무시 */ }
    const item = ld.queue[ld.i];
    if (!item) { ldFinish(ld); return; }
    const lf = document.getElementById('ListForm');
    if (!lf) { ldStop(ld, '상품 목록이 없는 페이지로 이동했습니다 (로그인 만료?)'); return; }
    const ci = listCodeCol(lf);
    if (ci < 0) { ldStop(ld, '목록 표에서 상품코드 열을 찾지 못했습니다'); return; }
    const onPage = [...lf.querySelectorAll('tr')].filter((tr) => tr.querySelector('input[name="idx[]"]'))
      .map((tr) => ({ tr, cb: tr.querySelector('input[name="idx[]"]'), code: ((tr.children[ci] || {}).textContent || '').trim() }));

    if (ld.stage === 'applied') { await ldAfterApply(ld); return; }   // 상태 변경 후 새로고침됨

    if (ld.stage === 'nav') { ld.stage = 'scan'; ldPut(ld); }
    const mine = onPage.find((r) => r.code === item.code);
    if (!mine) {
      if (ld.tryN === 0) { ld.tryN = 1; ld.stage = 'nav'; ldPut(ld); location.href = ldUrl(ld); return; }   // 모델명으로 못 찾으면 상품코드로 다시 검색
      if (ld.ph === 'hide' && !ld.hideSkipped) {                      // 진열 목록에 없으면 이미 숨김 상태일 수 있음 → 1단계 건너뛰고 2단계(삭제)로
        ld.hideSkipped = true; ld.ph = 'trash'; ld.tryN = 0; ld.stage = 'nav'; ldPut(ld);
        location.href = ldUrl(ld); return;
      }
      ld.results.push({ at: new Date().toISOString(), code: item.code, model: item.model, ok: false, msg: `${PH_LABEL[ld.ph]}: 검색 결과에서 찾지 못함 (이미 처리됐거나 검색 조건이 달라짐)` });
      ldNext(ld); return;
    }
    onPage.forEach((r) => { if (r.cb.checked) r.cb.click(); });      // 다른 줄은 모두 해제
    if (!mine.cb.checked) mine.cb.click();
    mine.tr.scrollIntoView({ block: 'center' });
    const { sel, btn, label, opt } = findBulk(lf, PH_RE[ld.ph]);
    if (!sel) { ldStop(ld, `${item.code} 체크했지만 목록 아래에서 [${ld.ph === 'hide' ? '숨김' : '삭제'}] 선택칸을 찾지 못했습니다. 이 화면(목록 맨 아래)을 캡처해서 알려 주세요.`); return; }
    setVal(sel, opt.value);
    if (ld.practice) { ldStop(ld, `연습(${PH_LABEL[ld.ph]}): [${item.model}] (${item.code}) 한 줄만 체크하고 [${opt.text.trim()}]로 맞춘 상태에서 멈췄습니다 (변경 버튼${btn ? ` [${label}]` : ''}은 누르지 않음). 체크된 줄이 맞는지 눈으로 확인하고, 맞으면 [실제로 실행]을 누르세요.`, 'practice'); return; }
    if (ld.ph === 'trash' && ld.firstTrash) {                        // 첫 상품의 2단계(삭제)는 화면을 눈으로 확인한 뒤에 진행
      ld.firstTrash = false;
      ldStop(ld, `첫 상품의 2단계입니다: [${item.model}] (${item.code}) 숨김 처리된 줄을 체크하고 상태값을 [${opt.text.trim()}]로 맞춘 상태에서 멈췄습니다. 맞으면 [실제로 실행]을 누르면 변경 버튼을 눌러 휴지통으로 보냅니다.`, 'practice'); return;
    }
    if (!btn) { ldStop(ld, `${item.code} 체크하고 [${opt.text.trim()}]로 맞췄지만 상태 변경 버튼을 찾지 못했습니다. 직접 눌러 주세요.`); return; }
    ld.stage = 'applied'; ld.appliedAt = Date.now(); ldPut(ld); renderLd();
    await sleep(1000);                                              // 체크된 모습이 잠깐 보이도록
    const at = ld.appliedAt;
    btn.click();                                                    // 이 사이트는 숨은 프레임으로 전송하므로 새로고침이 없을 수 있다 → 목록을 직접 조회해서 반영을 확인
    for (const t0 = Date.now(); Date.now() - t0 < STAGE_TIMEOUT_MS - 3000;) {
      await sleep(1500);
      const cur = ldGet();
      if (!cur || !cur.running || cur.stage !== 'applied' || cur.appliedAt !== at) return;   // 새로고침 등으로 이미 다른 단계로 넘어감
      let gone = false;
      try { gone = !parseListDoc(await fetchDoc(ldUrl(cur))).items.some((it) => it.code === item.code); } catch { /* 다음 주기에 다시 */ }
      if (!gone) continue;
      await sleep(1500);
      const c2 = ldGet();
      if (!c2 || !c2.running || c2.stage !== 'applied' || c2.appliedAt !== at) return;
      await ldAfterApply(c2); return;
    }
    const c3 = ldGet();
    if (c3 && c3.running && c3.stage === 'applied' && c3.appliedAt === at) ldStop(c3, `변경 버튼을 눌렀지만 ${STAGE_TIMEOUT_MS / 1000}초 안에 목록에서 사라지지 않았습니다`);
  }

  function renderLd() {
    const box = $('#ldBox'); if (!box) return;
    const ld = ldGet();
    if (!ld) { box.innerHTML = ''; return; }
    const okN = ld.results.filter((r) => r.ok).length, failN = ld.results.length - okN;
    const title = ld.running ? '목록 삭제 진행 중' : ld.stage === 'practice' ? '연습 모드로 멈춤' : ld.stage === 'done' ? '목록 삭제 완료' : '목록 삭제 멈춤';
    const cur = ld.queue[ld.i];
    let html = `<div class="runbox2"><b>${title}</b> · ${Math.min(ld.i + (ld.running || ld.stage === 'practice' || ld.stage === 'paused' ? 0 : 0), ld.queue.length)}/${ld.queue.length} · 성공 ${okN} · 실패 ${failN}`;
    if (ld.running && cur) html += `<div class="tiny">지금: ${esc(cur.model)} (${esc(cur.code)}) · ${PH_LABEL[ld.ph] || ''}</div>`;
    if (ld.msg) html += `<div class="tiny rv">${esc(ld.msg)}</div>`;
    if (ld.results.length) html += `<div class="tiny">${ld.results.slice(-6).map((r) => `${r.ok ? '✔' : '✖'} ${esc(r.model || '')} ${esc(r.code)} ${esc(r.msg)}`).join('<br>')}</div>`;
    html += '<div class="row">';
    if (ld.running) html += '<button class="warn" id="ldStopBtn">중지</button>';
    if (ld.stage === 'practice') html += '<button class="warn" id="ldReal">실제로 실행</button>';
    if (!ld.running && ld.stage === 'paused' && ld.i < ld.queue.length) html += '<button id="ldResume">이 건부터 이어서</button><button class="sub" id="ldSkip">이 건 건너뛰고 이어서</button>';
    if (!ld.running) html += '<button class="sub" id="ldClose">닫기</button>';
    html += '</div></div>';
    box.innerHTML = html;
    const on = (id, fn) => { const el = box.querySelector('#' + id); if (el) el.addEventListener('click', fn); };
    const go = (c) => { c.running = true; c.stage = 'nav'; c.msg = ''; c.tryN = 0; ldPut(c); ssDel(ALERT_KEY); location.href = ldUrl(c); };
    on('ldStopBtn', () => { const c = ldGet(); if (c) ldStop(c, '사용자가 중지함'); });
    on('ldReal', () => { const c = ldGet(); if (!c) return; if (!confirm(`연습 화면을 확인하셨나요?\n이제 선택한 ${c.queue.length - c.i}건을 실제로 삭제 처리합니다.`)) return; c.practice = false; go(c); });
    on('ldResume', () => { const c = ldGet(); if (c) go(c); });
    on('ldSkip', () => { const c = ldGet(); if (!c) return; c.results.push({ at: new Date().toISOString(), code: c.queue[c.i].code, model: c.queue[c.i].model, ok: false, msg: '건너뜀' }); c.i++; c.ph = c.startPh || 'hide'; c.hideSkipped = false; if (c.i >= c.queue.length) { ldFinish(c); return; } go(c); });
    on('ldClose', () => { ssDel(LD_KEY); renderLd(); renderReport(); });
    renderReport();
  }

  // 수정 페이지 방식: BS렌탈 외 다른 렌탈사도 있는 상품은 수정 페이지에서 BS렌탈 폼 상태값만 삭제 (일괄 실행 엔진 사용)
  function startEditRun(items, practice, co) {
    ssDel(ALERT_KEY);
    const st = {
      mode: 'disable', running: true, profile: PROFILE_ID, stage: 'nav', stageAt: Date.now(), company: co, idx: 0, startedAt: Date.now(),
      jobs: items.map((r) => ({ key: r.code, model: r.model, code: r.code, changes: [] })), results: [],
      opts: { pressList: true, practice },
    };
    putState(st);
    gotoJob(st);
  }

  // 선택한 것을 한 번에 자동 처리: BS렌탈만 있는 상품은 검색 → 체크 → 삭제, 다른 렌탈사도 있는 상품은 수정 페이지에서 BS렌탈만 삭제
  function doAutoAll() {
    const chosen = disChosen();
    if (!chosen.length) { log('선택한 건이 없습니다. 결과 표에서 체크하세요.'); return; }
    const only = chosen.filter((r) => r.handle === 'only'), multi = chosen.filter((r) => r.handle === 'multi');
    const practice = false;
    const msg = (practice ? '연습 모드: 첫 건만 체크/값 입력까지 하고 멈춥니다. 저장·적용은 누르지 않습니다.\n\n' : `선택한 ${chosen.length}건을 실제로 삭제 처리합니다.\n\n`)
      + `${only.length ? `· ${dis.co}만 있는 ${only.length}건(A타입): 모델명으로 검색 → 그 줄만 체크 → 1단계 진열상태 [숨김] → 상태 변경 → 2단계 같은 상품의 상태값 [삭제] → 상태 변경하기 (휴지통으로 이동). 사이트 확인창은 자동 [확인]\n` : ''}`
      + `${multi.length ? `· 다른 렌탈사도 있는 ${multi.length}건: 수정 페이지에서 ${dis.co} 폼 상태값만 [삭제] → [수정] → [저장 후 목록]\n` : ''}`
      + `\n하나씩 처리하는 모습이 화면에 보입니다. 오류가 나면 자동으로 멈춥니다. 진행 중에는 이 탭을 닫지 마세요.\n\n시작할까요?`;
    const nSim = chosen.filter((r) => r.cls === 'similar').length, nNo = chosen.filter((r) => r.cls === 'nomodel').length;
    if ((nSim || nNo) && !confirm(`확인이 필요한 구분의 상품이 포함되어 있습니다.
${nSim ? `· 엑셀에 비슷한 모델 있음 ${nSim}건 (같은 제품일 수 있음)
` : ''}${nNo ? `· 모델명 확인 필요 ${nNo}건 (사이트 모델명이 비었거나 짧음, 상품코드로 찾아 처리)
` : ''}
단종해도 되는 상품이 맞는지 확인하셨나요?

[확인] 그대로 진행   [취소] 돌아가기`)) return;
    if (!confirm(msg)) return;
    ssDel(ALERT_KEY);
    if (!only.length) { startEditRun(multi, practice, dis.co); return; }
    const { params, pk } = searchBase();
    const startPh = params.getAll('status_open').pop() === 'n' ? 'trash' : 'hide';   // 진열상태를 숨김으로 검색한 화면이면 1단계(숨김)는 이미 끝난 상태
    const ld = {
      running: true, practice, ph: startPh, startPh, firstTrash: false, stage: 'nav', queue: only.map((r) => ({ code: r.code, model: r.model })), i: 0, tryN: 0,
      base: params.toString(), pageKey: pk, results: [], msg: '', co: dis.co, startedAt: Date.now(),
      multi: multi.map((r) => ({ code: r.code, model: r.model })),
    };
    ldPut(ld);
    location.href = ldUrl(ld);
  }
  const doListDelete = () => { const keep = disChosen(); if (!keep.some((r) => r.handle === 'only')) { log('목록에서 삭제할 건이 없습니다.'); return; } doAutoAllOnly(); };
  function doAutoAllOnly() {
    // 목록 삭제 버튼: BS렌탈만 있는 건만 처리 (수정 페이지 건은 따로)
    const saved = dis.selected;
    const only = disChosen().filter((r) => r.handle === 'only');
    dis.selected = only.map((r) => r.code);
    try { doAutoAll(); } finally { dis.selected = saved; }
  }

  // BS렌탈 외 다른 렌탈사도 있는 상품: 수정 페이지에서 BS렌탈 폼 상태값만 삭제 (일괄 실행 엔진 사용)
  function doEditDelete() {
    const chosen = disChosen().filter((r) => r.handle === 'multi');
    if (!chosen.length) { log('수정 페이지에서 처리할 건이 없습니다.'); return; }
    const practice = false;
    const msg = practice
      ? `연습 모드: 첫 건(${chosen[0].model} / ${chosen[0].code})의 수정 페이지를 열어 ${dis.co} 상태값만 [삭제]로 바꾸고 멈춥니다. 저장은 하지 않습니다.`
      : `[${dis.co}] 상태값 삭제 처리를 ${chosen.length}건 실제로 진행합니다.\n\n각 건마다 1) 수정 페이지 열기 → 2) ${dis.co} 폼 상태값 [삭제] → 3) ${dis.co} [수정] → 4) 상품 [저장 후 목록] → 다음 건\n(다른 렌탈사는 건드리지 않습니다. 오류가 나면 자동으로 멈추고, 응답이 없으면 자동으로 건너뜁니다.)\n\n시작할까요?`;
    if (!confirm(msg)) return;
    ssDel(ALERT_KEY);
    const st = {
      mode: 'disable', running: true, profile: PROFILE_ID, stage: 'nav', stageAt: Date.now(), company: dis.co, idx: 0, startedAt: Date.now(),
      jobs: chosen.map((r) => ({ key: r.code, model: r.model, code: r.code, changes: [] })), results: [],
      opts: { pressList: true, practice },
    };
    putState(st);
    gotoJob(st);
  }

  // ====================================================================
  // 단종 처리 결과 보고: 처리가 끝나면(또는 멈추면) 어떤 상품을 어떻게 처리했는지 표로 보여 주고, 엑셀 저장/복사할 수 있다
  // ====================================================================
  function collectReport() {
    const ld = ldGet(), st = getState();
    const rows = [];
    if (ld && ld.results) ld.results.forEach((r) => rows.push({ type: 'A', code: r.code, model: r.model || '', res: r.ok ? '완료' : '실패', msg: r.msg || '', at: r.at || '' }));
    if (st && st.mode === 'disable' && st.results) {
      st.results.filter((r) => r.status !== 'practice').forEach((r) => rows.push({ type: 'B', code: r.code, model: r.model || '', res: r.status === 'ok' ? '완료' : r.status === 'skip' ? '이미 처리됨' : '실패', msg: r.msg || '', at: r.at || '' }));
    }
    const running = !!((ld && ld.running) || (st && st.mode === 'disable' && st.running));
    return { rows, running };
  }
  const rptLabel = (code) => { const r = dis && dis.rows.find((x) => x.code === code); return r ? DIS_LABEL[r.cls] : ''; };
  const rptTime = (at) => { try { return at ? new Date(at).toLocaleString('ko-KR') : ''; } catch { return ''; } };
  function rptText(rows) {
    const done = rows.filter((r) => r.res === '완료'), bad = rows.filter((r) => r.res === '실패');
    const lines = [`[사이트 단종 처리 결과] 사이트에서 단종처리 하였습니다: ${done.length}건 (A타입 ${done.filter((r) => r.type === 'A').length} · B타입 ${done.filter((r) => r.type === 'B').length}) · 실패 ${bad.length}건`];
    done.forEach((r) => lines.push(`✔ [${r.type}] ${r.model} (${r.code}) ${rptLabel(r.code)} — 이 모델을 사이트에서 단종처리 하였습니다`));
    bad.forEach((r) => lines.push(`✖ [${r.type}] ${r.model} (${r.code}) ${r.msg}`));
    return lines.join('\n');
  }
  function renderReport() {
    const box = $('#rptBox'); if (!box) return;
    const { rows, running } = collectReport();
    if (!rows.length || running) { box.style.display = 'none'; return; }
    box.style.display = '';
    const rkey = `${(ldGet() || {}).startedAt || 0}-${(getState() || {}).startedAt || 0}-${rows.length}`;
    if (ssGet('tncLgRptAuto') !== rkey) { ssSet('tncLgRptAuto', rkey); exportReport2(true); }   // 처리가 끝나면 결과 엑셀을 자동으로 저장
    const done = rows.filter((r) => r.res === '완료').length, bad = rows.filter((r) => r.res === '실패').length, skip = rows.length - done - bad;
    $('#rptSum').textContent = `완료 ${done} · 실패 ${bad}${skip ? ` · 이미 처리됨 ${skip}` : ''}`;
    $('#rptText').innerHTML = `<b>${done}건의 모델을 사이트에서 단종처리 하였습니다.</b>${bad ? ` 실패한 ${bad}건은 아래에서 확인하세요.` : ' 실패한 건은 없습니다.'}`;
    $('#rptRows').innerHTML = rows.map((r) => `<tr class="${r.res === '실패' ? 'rvw' : ''}"><td>${r.res === '완료' ? '✔ 완료' : r.res === '실패' ? '✖ 실패' : esc(r.res)}</td><td>${r.type === 'A' ? 'A타입' : 'B타입'}</td>`
      + `<td><div class="mdl">${esc(r.model)}</div><div class="hint">${esc(r.code)}</div></td><td>${esc(rptLabel(r.code))}</td><td>${r.res === '완료' ? `<b>${esc(r.model)}</b> 모델을 사이트에서 단종처리 하였습니다.` : esc(r.msg)}</td><td>${esc(rptTime(r.at))}</td></tr>`).join('');
  }
  function exportReport2(auto) {
    const { rows } = collectReport();
    if (!rows.length) return;
    const info = (code) => (dis && dis.rows.find((x) => x.code === code)) || {};
    const done = rows.filter((r) => r.res === '완료');
    const sheets = [
      { name: '단종처리 결과', head: ['순번', '결과', '모델명', '상품명', '상품코드', '렌탈사명(처리 전)', '타입', '구분', '안내', '상세', '처리 시각'],
        rows: rows.map((r, i) => [i + 1, r.res, r.model, info(r.code).name || '', r.code, (info(r.code).rentals || []).join(', '), r.type === 'A' ? `A타입(${(dis && dis.co) || '해당 렌탈사'}만 → 휴지통)` : `B타입(다른 렌탈사 연결 → ${(dis && dis.co) || '해당 렌탈사'}만 삭제)`, rptLabel(r.code), r.res === '완료' ? `${r.model} 모델을 사이트에서 단종처리 하였습니다.` : '단종처리 실패', r.msg, rptTime(r.at)]) },
      { name: '완료 모델 목록', head: ['순번', '모델명', '상품명', '상품코드', '타입', '구분'],
        rows: done.map((r, i) => [i + 1, r.model, info(r.code).name || '', r.code, r.type === 'A' ? 'A타입' : 'B타입', rptLabel(r.code)]) },
    ];
    downloadXlsx(auto ? '단종처리결과_자동저장' : '단종처리결과', sheets);
  }

  function initDisUi() {
    if (!PROFILES[PROFILE_ID]) return;
    const COMP = PROFILES[PROFILE_ID].company;
    const stl = document.createElement('style');
    stl.textContent = '.sbar{display:flex;align-items:center;gap:6px;margin:4px 0 6px;padding:4px 4px 4px 14px;background:#fff;border:1.5px solid #c5d3f7;border-radius:999px;box-shadow:0 2px 8px rgba(180,110,0,.08);transition:border-color .15s,box-shadow .15s}.sbar:focus-within{border-color:#f59e0b;box-shadow:0 0 0 3px rgba(43,92,255,.16)}.sbar .sico{display:grid;place-items:center;color:#5b6aa0}.sbar input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:14px;padding:9px 2px;box-shadow:none}.sbar .sx{width:26px;height:26px;padding:0;border-radius:50%;background:#e8edfb;color:#5b6aa0;font-size:12px;display:grid;place-items:center}.sbar .sgo{border-radius:999px;padding:9px 22px;font-size:14px;letter-spacing:.5px}.qinfo{margin:0 4px 8px;font-size:12.5px;color:#5b6aa0}.qinfo b{color:#a85d00}.runbox2{margin-top:10px;padding:10px 12px;background:#fff7e6;border:1px solid #f1d49a;border-radius:10px;font-size:13px}.runbox2 .tiny{font-size:12px;margin-top:4px;line-height:1.6}.dst-stop{background:#fde8e8;color:#b42318}.dst-unlist{background:#efe9ff;color:#5a2fc2}.dst-fixed{background:#e6f4f7;color:#146b7a}.dst-noprice{background:#f3ecdd;color:#7a5a14}.dst-disc{background:#fde8e8;color:#b42318}.dst-pause{background:#fff3d6;color:#9a5b00}.dst-none{background:#e8eefc;color:#2a46a8}.dst-similar{background:#fff0d9;color:#a14a00}.dst-kw{background:#e7f6ec;color:#1b6b3a}.dst-nomodel{background:#eee;color:#555}';
    root.appendChild(stl);
    const left = root.querySelector('.col-l'), right = root.querySelector('.col-r');
    if (!left || !right) return;
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'disCard';
    card.innerHTML = `<div class="card-h"><span class="step">★</span>${ICON(IC.flash)} 사이트 단종 정리 (${COMP})</div>
      <div class="hint">상품관리 목록에서 <b>렌탈사명 ${COMP} · 진열상태 진열</b>로 검색한 뒤 누르세요. 그 검색 결과를 모두 읽어, 올린 엑셀에서 운영 중이 아닌 모델(단종·중단·미운영·엑셀에 없음 등)을 단종 후보로 보여 줍니다.</div>
      <div class="go"><button id="disAnalyze">${ICON(IC.flash, 17)} 사이트 단종 분석 시작 (사이트 수정 없음)</button><button id="disRun" class="warn">사이트 단종 제품 리스트 수정까지</button><button id="disStop" class="sub" style="display:none">${ICON(IC.stop, 15)} 중지</button></div>
      <progress id="disProg" value="0" max="1" style="display:none;margin-top:10px"></progress>
      <div id="disText" class="hint"></div>
      <div id="ldBox"></div>`;
    left.appendChild(card);
    const res = document.createElement('div');
    res.className = 'card'; res.id = 'disBox'; res.style.display = 'none';
    res.innerHTML = `<div class="card-h"><span class="step">★</span>${ICON(IC.table)} 사이트 단종 분석 결과 <span class="sp"></span><span id="disSel" class="hint" style="margin:0;font-weight:700;color:var(--pri)"></span></div>
      <div id="disSum" class="hint" style="color:var(--txt)"></div>
      <div class="sbar"><span class="sico">${ICON('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>', 18)}</span><input id="disQ" type="text" placeholder="모델명·상품명·검색문구로 찾기  (예: 비스포크, 침대, 블룸 SK)" autocomplete="off"><button class="sx" id="disQClear" title="검색 지우기" style="display:none">✕</button><button class="sgo" id="disQBtn">검색</button></div>
      <div class="qinfo" id="disQInfo"></div>
      <div class="chips" id="disTypes"></div>
      <div class="chips" id="disChips"></div>
      <div class="row" style="margin-top:0"><button class="sub" id="disSelDef">단종·일시중단 선택</button><button class="sub" id="disSelAll">표시된 후보 모두 선택</button><button class="sub" id="disSelNone">표시된 건 선택 해제</button><span style="flex:1"></span><button class="sub" id="disXlsx">${ICON(IC.down, 15)} 보고용 엑셀 저장</button></div>
      <div class="tblwrap" style="margin-top:10px"><table><thead><tr><th><input type="checkbox" id="disAllChk" title="표시된 후보 전체 선택/해제"></th><th>구분</th><th>모델 / 상품코드</th><th>상품명 / 렌탈사</th><th>처리 방식 / 비고</th></tr></thead><tbody id="disRows"></tbody></table></div>
      <div class="go"><button id="disAuto" class="warn">선택한 건 단종 처리</button></div>
      <div class="hint">체크한 상품만 단종 처리합니다. 연결된 렌탈사에 따라 방법은 알아서 선택됩니다 (${COMP}만 있으면 숨김 → 삭제로 휴지통 이동, 다른 렌탈사도 있으면 수정 페이지에서 ${COMP}만 삭제). 실행 대상은 체크하고 지금 화면(위 칩)에 보이는 건만입니다.</div</div>`;
    right.insertBefore(res, right.firstChild);
    const rpt = document.createElement('div');
    rpt.className = 'card'; rpt.id = 'rptBox'; rpt.style.display = 'none';
    rpt.innerHTML = `<div class="card-h"><span class="step">✔</span>${ICON(IC.check)} 단종 처리 결과 보고 <span class="sp"></span><span id="rptSum" class="hint" style="margin:0;font-weight:700;color:var(--pri)"></span></div>
      <div id="rptText" class="hint" style="color:var(--txt)"></div>
      <div class="row"><button class="sub" id="rptXlsx">${ICON(IC.down, 15)} 단종처리 결과 엑셀 저장</button><button class="sub" id="rptCopy">결과 복사</button><span style="flex:1"></span><button class="sub" id="rptClose">결과 닫기</button></div>
      <div class="tblwrap" style="margin-top:10px"><table><thead><tr><th>결과</th><th>타입</th><th>모델 / 상품코드</th><th>구분</th><th>내용</th><th>시각</th></tr></thead><tbody id="rptRows"></tbody></table></div>`;
    right.insertBefore(rpt, right.firstChild);
    $('#rptXlsx').addEventListener('click', () => exportReport2(false));
    $('#rptCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(rptText(collectReport().rows)); log('결과를 복사했습니다. 메신저나 메일에 붙여 넣으세요.'); } catch { log('복사하지 못했습니다. [보고용 엑셀 저장]을 이용하세요.'); } });
    $('#rptClose').addEventListener('click', () => { ssDel(LD_KEY); const st0 = getState(); if (st0 && st0.mode === 'disable' && !st0.running) ssDel(STATE_KEY); renderLd(); refreshRun(); renderReport(); });
    const save = () => ssSet(disKey(), dis);
    $('#disAnalyze').addEventListener('click', () => runDisAnalysis(false));
    $('#disStop').addEventListener('click', () => { stopDis = true; });
    $('#disRun').addEventListener('click', async () => {
      if (!(await runDisAnalysis(true))) return;
      const ch = disChosen();
      if (!ch.length) { log('단종·일시중단으로 선택된 후보가 없습니다. 결과를 확인하세요.'); return; }
      doAutoAll();
    });
    const doSearch = () => { disQuery = $('#disQ').value.trim(); $('#disQClear').style.display = disQuery ? '' : 'none'; renderDis(); };
    $('#disQBtn').addEventListener('click', doSearch);
    $('#disQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    $('#disQClear').addEventListener('click', () => { $('#disQ').value = ''; doSearch(); $('#disQ').focus(); });
    $('#disAllChk').addEventListener('change', (e) => {                // 표 머리의 체크: 지금 표시된 후보 전체 선택/해제
      if (!dis) return;
      const codes = disVisible().filter(bulkOk).map((r) => r.code);
      dis.selected = e.target.checked ? [...new Set([...dis.selected, ...codes])] : dis.selected.filter((c) => !codes.includes(c));
      ssSet(disKey(), dis); renderDis();
    });
    $('#disTypes').addEventListener('click', (e) => { const t = e.target.dataset && e.target.dataset.t; if (t) { disType = t; renderDis(); } });
    $('#disChips').addEventListener('click', (e) => { const f = e.target.dataset && e.target.dataset.f; if (f) { disFilter = f; renderDis(); } });
    $('#disRows').addEventListener('change', (e) => {
      const c = e.target.dataset && e.target.dataset.c;
      if (!c || !dis) return;
      dis.selected = e.target.checked ? [...new Set([...dis.selected, c])] : dis.selected.filter((x) => x !== c);
      save(); renderDis();
    });
    $('#disSelDef').addEventListener('click', () => { const add = disVisible().filter((r) => ['disc', 'pause', 'stop'].includes(r.cls)).map((r) => r.code); dis.selected = [...new Set([...dis.selected, ...add])]; save(); renderDis(); });
    $('#disSelAll').addEventListener('click', () => { const add = disVisible().filter(bulkOk).map((r) => r.code); dis.selected = [...new Set([...dis.selected, ...add])]; save(); renderDis(); });
    $('#disSelNone').addEventListener('click', () => { const del = new Set(disVisible().map((r) => r.code)); dis.selected = dis.selected.filter((c) => !del.has(c)); save(); renderDis(); });
    $('#disXlsx').addEventListener('click', exportDis);
    $('#disAuto').addEventListener('click', doAutoAll);
    const saved = ssGet(disKey());
    if (saved && saved.rows) { dis = saved; renderDis(); }
    renderReport();
  }

  // ====================================================================
  // LG전자 단독몰 검수 - 엑셀 해석 / 사이트 상품 매칭 / 차이 계산 (화면과 무관한 순수 함수)
  // ====================================================================
  const LG_CO = 'LG전자';
  const LG_CATS = [
    { id: 'fridge', label: '냉장고', sheet: /냉장고/, m1: /^구분1/, m2: /^모델명/, visit: /^방문주기/, svc: /^서비스타입/ },
    { id: 'cooking', label: '쿠킹', sheet: /쿠킹/, m1: /^구분1/, visit: /^방문주기/, svc: /^케어서비스타입/, extra: /^구분2/ },
    { id: 'tv', label: 'TV', sheet: /TV/i, m1: /^구분1/, m2: /^제품모델명/, variant: /^구분2/ },
    { id: 'air', label: '공청기', sheet: /공청기/, m2: /^제품모델명/, visit: /^방문주기/, svc: /^서비스타입/, extra: /^구분2/ },
    { id: 'ac', label: '에어컨', sheet: /에어컨/, m2: /^제품모델명/, visit: /^방문주기/, svc: /^서비스타입/, variant: /^구분2/, extra: /^구분1/ },
    { id: 'living', label: '리빙', sheet: /리빙/, m2: /^모델명/, visit: /^방문주기/, svc: /^케어십형태/ },
  ];
  let lgStdAsLight = true;                                         // 스탠다드를 라이트와 같은 서비스로 본다 (화면 옵션)
  const lgSetStd = (v) => { lgStdAsLight = !!v; };
  const lgText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const lgHn = (v) => String(v == null ? '' : v).replace(/\s+/g, '').trim();
  // 방문주기: '3개월방문' → 3, '06개월' → 6, '자가관리' → 0, 없으면 null
  function lgVisitOf(t) {
    const s = lgText(t);
    if (!s) return null;
    if (/자가/.test(s)) return 0;
    const m = s.match(/(\d+)\s*개월/);
    return m ? Number(m[1]) : null;
  }
  // 서비스 타입: 라이트 = 라이트플러스(같은 서비스), 베이직(자가)·자가관리 = 자가
  function lgSvcClass(t) {
    const s = lgHn(t);
    if (!s) return '';
    if (/라이트/.test(s)) return '라이트';
    if (/프리미엄/.test(s)) return '프리미엄';
    if (/베이직|자가/.test(s)) return '자가';
    if (/스탠다드/.test(s)) return lgStdAsLight ? '라이트' : '스탠다드';
    if (/플래티넘/.test(s)) return '플래티넘';
    return '';                                  // 15cm케이스 같은 설치타입 표기는 서비스타입으로 보지 않는다
  }
  // 모델명 뒤의 .AKOR / .CKOR / .AKRG 같은 구분 코드를 뗀다
  const lgBase = (m) => String(m == null ? '' : m).trim().replace(/\.[A-Za-z0-9]{2,8}$/, '').trim();
  function lgKeys(...vals) {
    const out = new Set();
    vals.forEach((v) => { [normModel(v), normModel(lgBase(v))].forEach((k) => { if (k.length >= 3) out.add(k); }); });
    return [...out];
  }
  const lgVariantOf = (t) => {                                  // TV 구분2: 스탠드 / 벽걸이 / 밀착벽걸이 (스탠드/벽걸이는 둘 다)
    const s = lgHn(t);
    if (!s) return [];
    const out = [];
    if (/밀착/.test(s)) out.push('밀착형벽걸이');
    else if (/벽걸이/.test(s)) out.push('벽걸이');
    if (/스탠드/.test(s)) out.push('스탠드');
    return out;
  };

  const LG_VL = { '스탠드': 'S', '벽걸이': 'W', '밀착형벽걸이': 'L' };
  function lgTvBase(r) {
    const d = normModel(lgBase(r.model2 || r.model1));
    const vs = lgVariantOf(r.variantRaw);
    return vs.length === 1 && d.endsWith(LG_VL[vs[0]]) ? d.slice(0, -1) : d;
  }
  // ---- 엑셀 시트 한 장 → 줄 목록 ----
  function lgParseSheet(cat, rows) {
    const H = rows.slice(0, 5);
    const maxC = Math.max(0, ...H.map((r) => (r || []).length));
    const cellsOf = (c) => H.map((r) => lgHn((r || [])[c])).filter(Boolean);
    const findCol = (re) => { if (!re) return -1; for (let c = 0; c < maxC; c++) if (cellsOf(c).some((t) => re.test(t))) return c; return -1; };
    const pc = {};
    [36, 48, 60, 72].forEach((p) => { pc[p] = findCol(new RegExp('^' + p + '개월')); });
    const col = { fam: findCol(/^제품군/), m1: findCol(cat.m1), m2: findCol(cat.m2), visit: findCol(cat.visit), svc: findCol(cat.svc), variant: findCol(cat.variant), extra: findCol(cat.extra) };
    const recs = [];
    if (pc[36] < 0) return { recs, problem: '36개월 구독료 열을 찾지 못함' };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const p36 = Number(r[pc[36]]);
      if (!(p36 >= 1000)) continue;
      const model1 = col.m1 >= 0 ? lgText(r[col.m1]) : '', model2 = col.m2 >= 0 ? lgText(r[col.m2]) : '';
      if (!model1 && !model2) continue;
      const prices = {};
      [36, 48, 60, 72].forEach((p) => { const n = pc[p] >= 0 ? Number(r[pc[p]]) : NaN; if (n >= 1000) prices[p] = n; });
      const svcRaw = col.svc >= 0 ? lgText(r[col.svc]) : '';
      const visitRaw = col.visit >= 0 ? lgText(r[col.visit]) : '';
      recs.push({
        cat: cat.id, catLabel: cat.label, row: i + 1, model1, model2, prices,
        svcRaw, svcClass: lgSvcClass(svcRaw), svcLabel: lgHn(svcRaw).replace(/^베이직\(자가\)$/, '베이직'),
        visitRaw, visit: lgVisitOf(visitRaw),
        family: col.fam >= 0 ? lgText(r[col.fam]) : '', variantRaw: col.variant >= 0 ? lgText(r[col.variant]) : '', extra: col.extra >= 0 ? lgText(r[col.extra]) : '',
        keys: lgKeys(model1, model2),
      });
      if (cat.id === 'tv') { const rr = recs[recs.length - 1]; const tb = lgTvBase(rr); if (tb.length >= 3 && !rr.keys.includes(tb)) rr.keys.push(tb); }
    }
    return { recs, cols: col, pc };
  }
  // 엑셀 전체(시트 이름 → 행 목록)에서 6개 카테고리 줄을 모두 읽는다
  function lgParseWorkbook(sheets) {
    const perCat = {}, recs = [], problems = [];
    for (const cat of LG_CATS) {
      const name = Object.keys(sheets).find((n) => /^\(?\d\)/.test(n.trim()) && cat.sheet.test(n));
      if (!name) { problems.push(`${cat.label} 시트를 찾지 못함`); continue; }
      const res = lgParseSheet(cat, sheets[name]);
      if (res.problem) problems.push(`${cat.label}: ${res.problem}`);
      res.recs.forEach((r) => { r.sheet = name; });
      perCat[cat.id] = { sheet: name, n: res.recs.length };
      recs.push(...res.recs);
    }
    return { recs, perCat, problems };
  }

  // ---- 사이트 상품 ----
  // 목록의 상품명 칸은 '이름 * 옵션 : … * 검색문구 : …'가 붙어 있어 이름 부분만 쓴다
  const lgNameHead = (n) => String(n == null ? '' : n).replace(/^\[렌탈\]\s*/, '').split(/\s\*\s/)[0].trim();
  function lgSiteKeys(model, composite) {
    const kw = (String(composite || '').match(/\*\s*검색문구\s*:\s*([^*]*)/) || [, ''])[1];
    const toks = kw.split(',').map((x) => x.trim()).filter((x) => x.length >= 5 && /[A-Za-z]/.test(x) && /\d/.test(x) && !/\s/.test(x));
    return lgKeys(model, ...toks);
  }
  function lgParseSiteName(nameHead) {
    const m = String(nameHead).match(/\(([^()]*)\)\s*$/);
    if (!m) return { svc: '', svcClass: '', visit: null, hasTail: false };
    const parts = m[1].split('/').map((s) => s.trim());
    if (parts.length >= 2) return { svc: parts[0], svcClass: lgSvcClass(parts[0]), visit: /\d\s*\+\s*\d/.test(parts[1]) ? null : lgVisitOf(parts[1]), hasTail: true };
    const only = parts[0];
    if (/자가/.test(only)) return { svc: '', svcClass: '', visit: 0, hasTail: true };
    if (/개월/.test(only)) return { svc: '', svcClass: '', visit: lgVisitOf(only), hasTail: true };
    return { svc: only, svcClass: lgSvcClass(only), visit: null, hasTail: true };
  }

  // ---- 엑셀 줄 → 묶음(= 사이트 상품 하나에 대응) ----
  // TV: 같은 기본 모델(구분1에서 .AKRG 뗀 것)의 스탠드/벽걸이/밀착벽걸이 줄은 한 상품으로 묶는다
  // 에어컨: 모델명 끝에 M이 붙은 줄(매립형)은 M이 없는 줄(일반형)과 같은 모델로 묶는다
  function lgGroupRecs(recs) {
    const groups = new Map();
    for (const r of recs) {
      let key;
      if (r.cat === 'tv') key = 'tv|' + lgTvBase(r) + '|' + lgHn(r.family);
      else {
        const base = normModel(lgBase(r.model2 || r.model1));
        const b2 = r.cat === 'ac' && /M$/.test(base) && base.length >= 8 ? base.slice(0, -1) : base;
        key = [r.cat, b2, r.svcClass, r.visit == null ? '' : r.visit].join('|');
      }
      let g = groups.get(key);
      if (!g) { g = { key, cat: r.cat, catLabel: r.catLabel, recs: [], keys: new Set() }; groups.set(key, g); }
      g.recs.push(r);
      r.keys.forEach((k) => g.keys.add(k));
    }
    return [...groups.values()].map((g) => {
      const f = g.recs[0];
      g.model = g.cat === 'tv' ? lgTvBase(f) : lgBase(f.model2 || f.model1); g.svcClass = f.svcClass; g.svcLabel = f.svcLabel; g.visit = f.visit;
      g.rows = g.recs.map((r) => r.row); g.sheet = f.sheet; g.family = f.family; g.tvKind = /사운드바|스피커/.test(f.family || '') ? 'sb' : 'plain';
      // 에어컨: 일반형(M 없음) 줄을 대표로, 아니면 첫 줄
      g.main = g.cat === 'ac' ? (g.recs.find((r) => !/M$/.test(normModel(lgBase(r.model2 || r.model1)))) || f) : f;
      return g;
    });
  }

  // ---- 사이트 상품과 짝짓기 ----
  function lgMatchGroups(groups, items) {
    const idx = new Map();
    for (const it of items) (it.keys || lgKeys(it.model)).forEach((k) => { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(it); });
    const tvItems = items.filter((it) => /TV/.test(it.catName || ''));
    const cands = (g) => {
      const set = new Map();
      const add = (k) => (idx.get(k) || []).forEach((it) => set.set(it.code, it));
      if (g.cat === 'tv') {                                    // 사이트 TV 모델명은 OLED83G6K처럼 짧게 등록된 것도 있어 앞부분이 같으면 후보로
        tvItems.forEach((it) => { if (set.has(it.code)) return; const sk = normModel(it.model); if (sk.length >= 8 && [...g.keys].some((k) => k.length >= 8 && (k.startsWith(sk) || sk.startsWith(k)))) set.set(it.code, it); });
      }
      g.keys.forEach((k) => {
        add(k);
        if (g.cat === 'ac') { add(k + 'M'); if (/M$/.test(k) && k.length >= 8) add(k.slice(0, -1)); }
      });
      return [...set.values()];
    };
    const tvBase = {};
    const tvK = (g) => g.key.split('|')[1] + '|' + g.tvKind;
    groups.forEach((g) => { if (g.cat === 'tv') { const b = tvK(g); (tvBase[b] = tvBase[b] || []).push(g); } });
    groups.forEach((g) => { if (g.cat === 'tv') { const sib = tvBase[tvK(g)]; if (sib.length > 1) g.ambiguous = sib.map((x) => x.family || '-').join(' / '); } });
    const pairs = [];
    groups.forEach((g, gi) => {
      let cs = cands(g);
      if (g.cat === 'tv') cs = cs.filter((it) => /사운드바|스피커/.test(it.nameHead || '') === (g.tvKind === 'sb'));
      g.candCount = cs.length;
      if (g.ambiguous) return;
      cs.forEach((it) => {
        const nm = it.nameInfo;
        let score = 1;
        if (g.cat === 'tv') score = 6;
        else {
          if (nm.svcClass && g.svcClass && nm.svcClass === g.svcClass) score += 3;
          if (nm.visit != null && g.visit != null && nm.visit === g.visit) score += 3;
        }
        pairs.push({ gi, it, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedG = new Set(), usedP = new Set();
    for (const p of pairs) {
      if (usedG.has(p.gi) || usedP.has(p.it.code)) continue;
      // 서비스·방문주기가 하나도 안 맞는 짝(점수 1)은, 그 모델에 상품과 줄이 하나씩뿐일 때만 같은 상품으로 본다
      if (p.score <= 1 && groups[p.gi].cat !== 'tv') {
        const sameModelGroups = groups.filter((g) => g.candCount > 0 && g.cat === groups[p.gi].cat && [...g.keys].some((k) => groups[p.gi].keys.has(k)));
        if (!(groups[p.gi].candCount === 1 && sameModelGroups.length === 1)) continue;
      }
      groups[p.gi].product = p.it; groups[p.gi].score = p.score;
      usedG.add(p.gi); usedP.add(p.it.code);
    }
    return groups;
  }

  // ---- 차이 계산 ----
  const lgWon = (n) => Number(n).toLocaleString('ko-KR');
  // 추가안내정보(goods_briefing): 케어솔루션 총요금 = 72개월 구독료 × 72, 방문주기·서비스 표기를 엑셀과 맞춘다
  function lgBriefing(text, g, rec) {
    let t = String(text == null ? '' : text);
    const p72 = rec.prices[72];
    if (p72) {
      t = t.replace(/(케어솔루션\s*총\s*요금|총\s*케어솔루션\s*요금|케어솔루션\s*요금)(\s*)([\d,]+)(\s*원)/, (m, a, sp, n, w) => a + sp + lgWon(p72 * 72) + w);
    }
    if (p72) {
      t = t.replace(/(선납금_?(\d+)%\s*:\s*)([\d,]+)(\s*원)/, (m, a, pct, n, w) => a + lgWon(Math.floor((p72 * 72 * Number(pct)) / 100 / 100) * 100) + w);
    }
    if (rec.visit != null && rec.visit > 0) {
      t = t.replace(/(\d+)(\s*개월\s*방문)/, (m, n, rest) => rec.visit + rest);
      t = t.replace(/(방문주기\s*)(\d+)(\s*개월)/, (m, a, n, b) => a + rec.visit + b);
    }
    if (rec.svcClass && rec.svcClass !== '자가') {
      t = t.replace(/\((라이트\s*플러스|라이트|프리미엄|베이직)(\s*\/\s*\d+\s*개월\s*방문)/, (m, s0, rest) => (lgSvcClass(s0) === rec.svcClass ? m : '(' + rec.svcLabel + rest));
    }
    return t;
  }
  // 상품명 끝 괄호: (라이트/6개월방문관리) 의 서비스·방문주기를 엑셀과 맞춘다 (라이트 = 라이트플러스)
  function lgNameFix(name, rec) {
    const m = String(name).match(/\(([^()]*)\)\s*$/);
    if (!m) return null;
    const info = lgParseSiteName(name);
    const svcDiff = !!(rec.svcClass && info.svcClass && info.svcClass !== rec.svcClass && rec.svcClass !== '자가');
    const visitDiff = rec.visit != null && info.visit != null && info.visit !== rec.visit;
    if (!svcDiff && !visitDiff) return null;
    let inner = m[1];
    if (svcDiff) inner = inner.replace(/^[^/]*/, rec.svcLabel);
    if (visitDiff) {
      if (rec.visit === 0) inner = inner.replace(/\d+\s*개월\s*방문관리?/, '자가관리');
      else inner = inner.replace(/\d+(\s*개월\s*방문)/, (mm, rest) => rec.visit + rest);
    }
    return String(name).replace(/\(([^()]*)\)\s*$/, '(' + inner + ')');
  }
  const LG_VARIANT_ORDER = ['벽걸이', '스탠드', '밀착형벽걸이'];
  // 사이트 렌탈사 폼 슬롯(계약36개월…)과 엑셀 구독료 비교 (TV 이외)
  function lgDiffProduct(g, prod, opts) {
    const rec = g.main;
    const out = { changes: [], rewrite: null, nameTo: null, briefTo: null, notes: [] };
    if (g.cat === 'tv') {
      // 변형별 가격 모으기
      const by = {};
      g.recs.forEach((r) => {
        const vs = lgVariantOf(r.variantRaw);
        (vs.length ? vs : ['스탠드']).forEach((v) => { by[v] = r.prices; });
      });
      const variants = LG_VARIANT_ORDER.filter((v) => by[v]);
      const same = variants.every((v) => [36, 48, 60, 72].every((p) => by[v][p] === by[variants[0]][p]));
      let want;
      if (same) want = [36, 48, 60, 72].filter((p) => by[variants[0]][p]).map((p) => ({ period: p, con: `계약${p}개월`, price: by[variants[0]][p] }));
      else want = variants.flatMap((v) => [36, 48, 60].filter((p) => by[v][p]).map((p) => ({ period: p, con: `계약${p}개월_${v}`, price: by[v][p] })));
      const have = prod.slots.map((s) => `${s.con}:${Number(s.price)}`).join(',');
      const need = want.map((s) => `${s.con}:${s.price}`).join(',');
      if (have !== need) {
        const sameStruct = prod.slots.map((s) => s.con).join(',') === want.map((s) => s.con).join(',');
        if (sameStruct) {
          want.forEach((w, i) => { if (Number(prod.slots[i].price) !== Number(w.price)) out.changes.push({ s: prod.slots[i].s, period: w.period, con: w.con, old: prod.slots[i].price, new: w.price }); });
        } else {
          out.rewrite = want;
          out.changes = want.map((w) => {
            const cur = prod.slots.find((s) => s.con === w.con);
            return { period: w.period, con: w.con, old: cur ? cur.price : '', new: w.price };
          });
          prod.slots.forEach((s) => { if (!want.some((w) => w.con === s.con)) out.changes.push({ period: s.period, con: s.con, old: s.price, new: '', remove: true }); });
        }
      }
      if (!same) out.notes.push('스탠드/벽걸이/밀착벽걸이 가격이 달라 구분별 칸으로 나눠 입력 (36·48·60개월)');
      const base = by[variants.includes('스탠드') ? '스탠드' : variants[0]] || {};
      out.briefTo = opts.brief ? lgBriefing(prod.briefing, g, { ...rec, prices: base }) : null;
      if (out.briefTo === prod.briefing) out.briefTo = null;
      return out;
    }
    [36, 48, 60, 72].forEach((p) => {
      const want = rec.prices[p];
      if (!want) return;
      const slot = prod.slots.find((x) => x.period === p && !/_/.test(x.con)) || prod.slots.find((x) => x.period === p);
      if (!slot) out.changes.push({ period: p, add: true, old: '', new: want });
      else if (Number(slot.price) !== Number(want)) out.changes.push({ s: slot.s, period: p, con: slot.con, old: slot.price, new: want });
    });
    if (g.cat === 'ac') {
      const other = g.recs.find((r) => r !== rec);
      if (other && [36, 48, 60, 72].some((p) => other.prices[p] && rec.prices[p] && other.prices[p] !== rec.prices[p])) out.notes.push(`매립형(${other.model2 || other.model1}) 가격이 일반형과 달라 일반형 기준으로 비교`);
    }
    if (opts.name) { const nf = lgNameFix(prod.name, rec); if (nf && nf !== prod.name) out.nameTo = nf; }
    if (opts.brief) { const bt = lgBriefing(prod.briefing, g, rec); if (bt !== prod.briefing) out.briefTo = bt; }
    return out;
  }

  // ====================================================================
  // LG전자 검수 - 사이트 읽기 / 분석 / 화면 / 실행
  // ====================================================================
  const LG_PLAN_KEY = 'tncLgPlan';
  const LG_STATUS_LABEL = { ok: '변경 있음', nochange: '변경 없음(일치)', nosite: '사이트에 없음(신규 등록)', conflict: '엑셀 값 충돌', ambiguous: '확인 필요(같은 모델 여러 제품군)', error: '오류', done: '변경완료', runfail: '변경 실패(확인 필요)' };
  const LG_CHIPS = ['all', 'ok', 'done', 'runfail', 'nosite', 'nochange', 'conflict', 'ambiguous', 'error'];
  let lgSite = null, lgPlan = null, lgStopFlag = false, lgBusy = false, lgFilter = 'all', lgCatSel = 'all', lgQuery = '';

  // 렌탈사명 LG전자의 brand 값 (검색 조건의 선택칸에서 읽는다)
  function lgBrandId() {
    const sel = document.querySelector('select[name="brand"]');
    const o = sel && [...sel.options].find((x) => x.text.trim() === LG_CO);
    return o ? o.value : '1002';
  }
  function lgParseList(doc) {
    const lf = doc.getElementById('ListForm');
    if (!lf) throw new Error('상품 목록 표를 찾지 못함 (로그인 만료?)');
    const headRow = [...lf.querySelectorAll('tr')].find((tr) => tr.querySelector('th') && /상품코드/.test(tr.textContent));
    const heads = headRow ? [...headRow.children].map((h) => h.textContent.replace(/\s+/g, ' ').trim()) : [];
    const ix = (label) => heads.findIndex((h) => h.includes(label));
    const ci = ix('상품코드'), ri = ix('렌탈사명'), mi = ix('모델명'), ni = ix('상품명'), si = ix('상태');
    if (ci < 0 || mi < 0 || ni < 0) throw new Error('목록 표 구조가 달라졌습니다');
    return [...lf.querySelectorAll('tr')].filter((tr) => tr.querySelector('input[name="idx[]"]')).map((tr) => {
      const t = (i) => (i >= 0 && tr.children[i] ? tr.children[i].textContent.replace(/\s+/g, ' ').trim() : '');
      const head = lgNameHead(t(ni));
      const model = t(mi), comp = t(ni), cn = t(ix('카테고리명'));
      return { code: t(ci), rentals: t(ri).split(',').map((x) => x.trim()).filter(Boolean), model, nameHead: head, nameInfo: lgParseSiteName(head), st: t(si), keys: lgSiteKeys(model, comp), catName: cn };
    });
  }
  // 사이트의 LG전자 상품을 전부 읽는다 (렌탈사명 LG전자, 모든 상태)
  async function lgLoadSite(onProg) {
    const items = [], seen = new Set(), brand = lgBrandId();
    for (let p = 1; p <= 150 && !lgStopFlag; p++) {
      const rows = lgParseList(await fetchDoc(`/admin/goods.php?ptype=&page=${p}&sno=&brand=${brand}&rental=&item=&rowcount=&method=&status_open=&status_sales=&search_item=all&search_keyword=&search_keyword2=`));
      const fresh = rows.filter((r) => !seen.has(r.code));
      if (!fresh.length) break;
      fresh.forEach((r) => { seen.add(r.code); items.push(r); });
      onProg(p, items.length);
      await sleep(60);
    }
    return { items, at: Date.now(), brand };
  }
  // 상품 수정 페이지에서 상품명·LG전자 렌탈사 폼(렌탈료 칸, 추가안내정보)을 읽는다
  async function lgReadProduct(code) {
    const doc = await fetchEdit(code);
    const mf = doc.getElementById('modifyForm');
    const forms = companyForms(doc, LG_CO);
    if (!mf || !mf.elements.goods_name) return { error: '상품 수정 페이지를 읽지 못함' };
    if (forms.length !== 1) return { error: forms.length ? `${LG_CO} 폼이 ${forms.length}개` : `${LG_CO} 렌탈사 폼이 없음` };
    const f = forms[0];
    const slots = SLOTS.filter((s) => fld(f, 'goods_price', s)).map((s) => ({ s, con: fval(f, 'goods_con', s), period: digits(fval(f, 'goods_period', s)), price: fval(f, 'goods_price', s), fix: fval(f, 'goods_fixprice', s) }))
      .filter((x) => x.con || x.price || x.period);
    return { name: mf.elements.goods_name.value, briefing: f.elements.goods_briefing ? f.elements.goods_briefing.value : '', slots };
  }

  const lgPriceSig = (g) => g.recs.map((r) => [36, 48, 60, 72].map((p) => r.prices[p] || '').join('/'));
  async function lgAnalyze() {
    if (lgBusy) return;
    if (!excel) { log('먼저 ① 엑셀 불러오기에서 LG전자 검수 엑셀을 선택하세요.'); return; }
    const parsed = lgParseWorkbook(excel.sheets);
    if (parsed.problems.length) log('엑셀 확인: ' + parsed.problems.join(' · '));
    const recs = parsed.recs.filter((r) => lgCatSel === 'all' || r.cat === lgCatSel);
    if (!recs.length) { log('분석할 줄이 없습니다. 카테고리 시트를 확인하세요.'); return; }
    lgBusy = true; lgStopFlag = false;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    $('#lgGo').disabled = true; $('#lgStop').style.display = '';
    const pg = $('#lgProg'); if (pg) pg.style.display = '';
    setProg('#lgProg', null);
    try {
      const opts = { name: $('#lgOptName').checked, brief: $('#lgOptBrief').checked };
      lgSetStd($('#lgOptStd').checked);
      lgSite = await lgLoadSite((p, n) => set('#lgText', `사이트 LG전자 상품 읽는 중 ${p}페이지 · ${n}건`));
      if (lgStopFlag) { set('#lgText', '중지됨'); return; }
      const groups = lgMatchGroups(lgGroupRecs(recs), lgSite.items);
      const todo = groups.filter((g) => g.product);
      setProg('#lgProg', 0, Math.max(1, todo.length));
      const items = [];
      const mk = (g) => ({ key: g.key, cat: g.cat, catLabel: g.catLabel, sheet: g.sheet, rows: g.rows, model: g.model, svcLabel: g.svcLabel, visit: g.visit, status: '', code: '', siteName: '', changes: [], rewrite: null, nameFrom: '', nameTo: null, briefFrom: '', briefTo: null, notes: [], msg: '' });
      groups.filter((g) => !g.product).forEach((g) => {
        const it = mk(g);
        if (g.ambiguous) { it.status = 'ambiguous'; it.msg = `같은 기본 모델에 제품군이 여러 개라 자동으로 짝짓지 않음 (제품군: ${g.ambiguous})`; items.push(it); return; }
        it.status = 'nosite';
        it.msg = g.candCount ? `사이트에 같은 모델은 있으나 서비스·방문주기(${g.svcLabel || '-'}/${g.visit == null ? '-' : g.visit === 0 ? '자가관리' : g.visit + '개월'})가 맞는 상품이 없음 → 신규 등록 필요` : '사이트에 없는 모델 → 신규 등록 필요';
        items.push(it);
      });
      let cursor = 0, doneN = 0;
      const worker = async () => {
        while (!lgStopFlag) {
          const i = cursor++;
          if (i >= todo.length) return;
          const g = todo[i], it = mk(g);
          it.code = g.product.code; it.siteName = g.product.nameHead;
          try {
            const prod = await lgReadProduct(g.product.code);
            if (prod.error) { it.status = 'error'; it.msg = `${g.product.code}: ${prod.error}`; }
            else {
              const sigs = new Set(lgPriceSig(g).filter(Boolean));
              const d = lgDiffProduct(g, prod, opts);
              it.changes = d.changes; it.rewrite = d.rewrite; it.nameFrom = prod.name; it.nameTo = d.nameTo; it.briefFrom = prod.briefing; it.briefTo = d.briefTo; it.notes = d.notes;
              if (g.cat !== 'tv' && g.cat !== 'ac' && sigs.size > 1) { it.status = 'conflict'; it.msg = `같은 모델·서비스·방문주기인데 엑셀 가격이 다름 (${g.rows.join('·')}행)`; }
              else {
                const parts = [];
                d.changes.forEach((c) => { if (!c.remove) parts.push(`${c.con && /_/.test(c.con) ? c.con.replace('계약', '') : c.period + '개월'} ${c.old === '' ? '(없음)' : lgWon(c.old)}→${lgWon(c.new)}`); else parts.push(`${c.con.replace('계약', '')} 칸 삭제`); });
                if (d.nameTo) parts.push(`상품명 ${(prod.name.match(/\(([^()]*)\)\s*$/) || [, ''])[1]}→${(d.nameTo.match(/\(([^()]*)\)\s*$/) || [, ''])[1]}`);
                if (d.briefTo) { const a = (prod.briefing.match(/요금\s*([\d,]+)\s*원/) || [, ''])[1], b = (d.briefTo.match(/요금\s*([\d,]+)\s*원/) || [, ''])[1]; parts.push(`추가안내 총요금 ${a || '-'}→${b || '-'}`); }
                it.status = parts.length ? 'ok' : 'nochange';
                it.msg = parts.length ? parts.join(' / ') : '이미 같은 값';
              }
            }
          } catch (err) { it.status = 'error'; it.msg = String(err && err.message || err); }
          items.push(it);
          doneN++; setProg('#lgProg', doneN);
          set('#lgText', `상품 확인 중 ${doneN}/${todo.length}`);
          await sleep(60);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      items.sort((a, b) => (a.cat === b.cat ? (a.rows[0] || 0) - (b.rows[0] || 0) : LG_CATS.findIndex((c) => c.id === a.cat) - LG_CATS.findIndex((c) => c.id === b.cat)));
      lgPlan = { cat: lgCatSel, at: Date.now(), fileName: excel.fileName, items, selected: items.filter((x) => x.status === 'ok').map((x) => x.key), siteN: lgSite.items.length, recN: recs.length, opts };
      ssSet(LG_PLAN_KEY, lgPlan);
      set('#lgText', lgStopFlag ? `중지됨 (${items.length}건 분석)` : `분석 완료 · 엑셀 ${recs.length}줄 / 사이트 LG전자 상품 ${lgSite.items.length}건`);
      lgFilter = 'all'; renderLg();
    } catch (err) {
      set('#lgText', '오류: ' + String(err && err.message || err));
    } finally {
      lgBusy = false;
      $('#lgGo').disabled = false; $('#lgStop').style.display = 'none';
      const pg2 = $('#lgProg'); if (pg2) pg2.style.display = 'none';
    }
  }

  // 일괄 수정 결과를 분석 결과 표에 반영 (변경완료 / 변경 실패)
  function lgApplyRunToPlan() {
    const st = getState();
    if (!lgPlan || !st || st.mode !== 'lg' || !st.results) return;
    let changed = false;
    for (const r of st.results) {
      if (r.status !== 'ok' && r.status !== 'skip' && r.status !== 'fail') continue;
      const it = lgPlan.items.find((x) => x.code === r.code && (x.status === 'ok' || x.status === 'runfail'));
      if (!it) continue;
      it.status = r.status === 'fail' ? 'runfail' : r.status === 'ok' ? 'done' : 'nochange';
      it.runMsg = r.msg || ''; it.runAt = r.at || '';
      lgPlan.selected = lgPlan.selected.filter((k) => k !== it.key);
      changed = true;
    }
    if (changed) ssSet(LG_PLAN_KEY, lgPlan);
  }
  const lgMatchQ = (it) => {
    if (!lgQuery) return true;
    const hay = [it.model, it.code, it.siteName, it.msg, it.svcLabel, it.catLabel].join(' ').toLowerCase();
    return lgQuery.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  };
  const lgInView = (it) => (lgFilter === 'all' || it.status === lgFilter) && lgMatchQ(it);
  const lgViewChosen = () => (lgPlan ? lgPlan.items.filter((it) => lgPlan.selected.includes(it.key) && it.status === 'ok' && lgInView(it)) : []);

  function renderLg() {
    lgApplyRunToPlan();
    const box = $('#lgBox');
    if (!box || !lgPlan) return;
    box.style.display = '';
    const cnt = {}; lgPlan.items.forEach((r) => { cnt[r.status] = (cnt[r.status] || 0) + 1; });
    $('#lgSum').innerHTML = `엑셀 ${lgPlan.recN}줄 · 사이트 LG전자 상품 ${lgPlan.siteN}건 → ` + LG_CHIPS.filter((k) => k !== 'all' && cnt[k]).map((k) => `${LG_STATUS_LABEL[k]} <b>${cnt[k]}</b>`).join(' · ')
      + `<div class="hint">${esc(lgPlan.fileName || '')} · ${lgPlan.cat === 'all' ? '총괄' : (LG_CATS.find((c) => c.id === lgPlan.cat) || {}).label}</div>`;
    $('#lgChips').innerHTML = LG_CHIPS.filter((k) => k === 'all' || cnt[k]).map((k) => `<button class="chip ${lgFilter === k ? 'on' : ''}" data-f="${k}">${k === 'all' ? '전체' : LG_STATUS_LABEL[k]}<i>${k === 'all' ? lgPlan.items.length : cnt[k]}</i></button>`).join('');
    const list = lgPlan.items.filter(lgInView);
    const qi = $('#lgQInfo'); if (qi) qi.innerHTML = lgQuery ? `<b>‘${esc(lgQuery)}’</b> 검색 결과 <b>${list.length}</b>건` : `전체 <b>${list.length}</b>건 표시`;
    $('#lgRows').innerHTML = list.slice(0, 1500).map((it) => {
      const can = it.status === 'ok';
      const detail = [it.msg ? it.msg.split(' / ').map((x) => `<div class="ln">${esc(x)}</div>`).join('') : '', it.notes.length ? `<div class="hint">${it.notes.map(esc).join('<br>')}</div>` : '',
        it.status === 'done' ? `<div class="hint" style="color:#13703a;font-weight:700">✔ 사이트에 반영됨${it.runAt ? ' · ' + esc(new Date(it.runAt).toLocaleString('ko-KR')) : ''}</div>` : '',
        it.status === 'runfail' ? `<div class="rv">✖ 반영 실패: ${esc(it.runMsg || '')}</div>` : ''].join('');
      return `<tr class="${can ? 'chg' : ''}"><td>${can ? `<input type="checkbox" data-k="${esc(it.key)}"${lgPlan.selected.includes(it.key) ? ' checked' : ''}>` : ''}</td>`
        + `<td><span class="st st-${it.status === 'nosite' ? 'nomodel' : it.status}">${LG_STATUS_LABEL[it.status] || it.status}</span></td>`
        + `<td><div class="mdl">${esc(it.model)}</div><div class="hint">${esc(it.catLabel)} · 엑셀 ${esc(it.rows.join('·'))}행${it.svcLabel ? ' · ' + esc(it.svcLabel) : ''}${it.visit == null ? '' : ' · ' + (it.visit === 0 ? '자가관리' : it.visit + '개월방문')}</div></td>`
        + `<td>${it.code ? `<div class="code">${esc(it.code)}</div>` : ''}<div class="hint">${esc(it.siteName || '')}</div></td>`
        + `<td>${detail}</td></tr>`;
    }).join('') + (list.length > 1500 ? `<tr><td colspan="5" class="hint">… 외 ${list.length - 1500}건 (엑셀 저장에서 전체 확인)</td></tr>` : '');
    const n = lgViewChosen().length, all = lgPlan.selected.length;
    $('#lgSel').textContent = all === n ? `선택 ${n}건` : `전체 선택 ${all}건 중 지금 화면 ${n}건만 실행`;
    $('#lgRun').disabled = !n;
    $('#lgRun').lastChild.textContent = ` 지금 화면에서 선택한 ${n}건 사이트에 반영`;
    const cb0 = $('#lgAllChk');
    if (cb0) { const cc = list.filter((r) => r.status === 'ok'); const m = cc.filter((r) => lgPlan.selected.includes(r.key)).length; cb0.checked = !!cc.length && m === cc.length; cb0.indeterminate = m > 0 && m < cc.length; cb0.disabled = !cc.length; }
  }

  function lgExport() {
    if (!lgPlan) return;
    const head = ['카테고리', '엑셀 시트', '엑셀 행', '모델', '서비스타입', '방문주기', '상태', '상품코드', '사이트 상품명', '변경 내용', '상품명 수정(전)', '상품명 수정(후)', '추가안내정보 수정(후)', '메모'];
    const rows = lgPlan.items.map((it) => [it.catLabel, it.sheet, it.rows.join('·'), it.model, it.svcLabel, it.visit == null ? '' : it.visit === 0 ? '자가관리' : it.visit + '개월', LG_STATUS_LABEL[it.status] || it.status, it.code, it.siteName, it.msg, it.nameTo ? it.nameFrom : '', it.nameTo || '', it.briefTo || '', it.notes.join(' | ')]);
    downloadXlsx('LG전자_검수결과', [{ name: '검수결과', head, rows }]);
  }

  // ---- 실행: 상품 수정 페이지에서 렌탈료·추가안내정보·상품명 수정 ----
  function lgStartRun() {
    const chosen = lgViewChosen();
    if (!chosen.length) { log('실행할 건을 선택하세요.'); return; }
    const practice = $('#lgPractice').checked;
    const jobs = chosen.map((it) => ({ key: it.key, model: it.model, code: it.code, changes: it.changes, rewrite: it.rewrite, nameTo: it.nameTo, briefTo: it.briefTo, summary: it.msg }));
    const msg = practice
      ? `연습 모드: 첫 건(${jobs[0].model} / ${jobs[0].code})의 수정 페이지를 열어 값만 채우고 멈춥니다. 저장은 하지 않습니다.`
      : `[${LG_CO}] ${jobs.length}건을 실제로 수정합니다.\n\n각 건마다 ① 상품 수정 페이지 열기 → ② 렌탈료·추가안내정보 입력 → ③ 렌탈사 [수정] 저장 → ④ 상품명 수정이 있으면 [저장 후 목록]으로 저장 → 다음 건\n\n- 오류가 나면 자동으로 멈추고, 응답이 없으면 건너뜁니다.\n- 진행 중에는 이 탭을 닫지 마세요.\n\n시작할까요?`;
    if (!confirm(msg)) return;
    ssDel(ALERT_KEY);
    const st = {
      mode: 'lg', running: true, profile: PROFILE_ID, stage: 'nav', stageAt: Date.now(), company: LG_CO, idx: 0, jobs, results: [], startedAt: Date.now(),
      opts: { pressList: true, practice },
    };
    putState(st);
    gotoJob(st);
  }
  function lgApplyChanges(f, changes) {
    for (const c of changes) {
      if (c.remove) continue;
      if (c.add) {
        const info = SLOTS.filter((s) => fld(f, 'goods_price', s)).map((s) => ({ s, raw: fval(f, 'goods_period', s), con: fval(f, 'goods_con', s), price: fval(f, 'goods_price', s) }));
        const empty = info.find((x) => !x.raw && !x.con && !x.price);
        if (!empty) continue;
        setVal(fld(f, 'goods_period', empty.s), `의무${c.period}`);
        const con = fld(f, 'goods_con', empty.s); if (con) setVal(con, `계약${c.period}개월`);
        setVal(fld(f, 'goods_price', empty.s), String(c.new));
      } else if (c.s) setVal(fld(f, 'goods_price', c.s), String(c.new));
    }
  }
  // TV 등: 렌탈료 칸을 모두 비우고 원하는 목록(계약36개월_벽걸이 …)으로 새로 채운다
  function lgApplyRewrite(f, want) {
    SLOTS.forEach((s) => {
      if (!fld(f, 'goods_price', s)) return;
      setVal(fld(f, 'goods_period', s), '');
      const con = fld(f, 'goods_con', s); if (con) setVal(con, '');
      setVal(fld(f, 'goods_price', s), '');
      const fx = fld(f, 'goods_fixprice', s); if (fx && fx.value) setVal(fx, '');
    });
    want.slice(0, SLOTS.length).forEach((w, i) => {
      const s = SLOTS[i];
      setVal(fld(f, 'goods_period', s), `의무${w.period}`);
      const con = fld(f, 'goods_con', s); if (con) setVal(con, w.con);
      setVal(fld(f, 'goods_price', s), String(w.price));
    });
  }
  const lgNorm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  // 저장 후 폼을 다시 읽어 렌탈료·추가안내정보가 반영됐는지 확인 ('' 이면 정상)
  function lgVerifyForm(f, job) {
    const slots = SLOTS.filter((s) => fld(f, 'goods_price', s)).map((s) => ({ con: fval(f, 'goods_con', s), period: digits(fval(f, 'goods_period', s)), price: Number(fval(f, 'goods_price', s)) }));
    if (job.rewrite) {
      for (const w of job.rewrite) if (!slots.some((s) => s.con === w.con && s.price === Number(w.price))) return `${w.con} ${w.price}원이 반영되지 않음`;
    } else {
      for (const c of job.changes || []) {
        if (c.remove) continue;
        if (!slots.some((s) => s.period === c.period && s.price === Number(c.new))) return `${c.period}개월 ${c.new}원이 반영되지 않음`;
      }
    }
    if (job.briefTo != null && f.elements.goods_briefing && lgNorm(f.elements.goods_briefing.value) !== lgNorm(job.briefTo)) return '추가안내정보가 반영되지 않음';
    return '';
  }
  function tickLg(st, job, forms) {
    if (st.stage === 'edit') {
      popAlerts();
      if (forms.length !== 1) { pause(st, `${LG_CO} 렌탈사 폼 ${forms.length}개 (1개여야 함)`); return; }
      const f = forms[0];
      const needForm = !!(job.rewrite || (job.changes || []).some((c) => !c.remove) || job.briefTo != null);
      if (job.rewrite) lgApplyRewrite(f, job.rewrite); else lgApplyChanges(f, job.changes || []);
      if (job.briefTo != null && f.elements.goods_briefing) setVal(f.elements.goods_briefing, job.briefTo);
      if (job.nameTo) {
        const mf = document.getElementById('modifyForm');
        if (!mf || !mf.elements.goods_name) { pause(st, '상품명 입력칸을 찾지 못함'); return; }
        setVal(mf.elements.goods_name, job.nameTo);
      }
      if (st.opts.practice) { pause(st, '연습 모드: 값만 채웠습니다. 저장은 하지 않았습니다 → 화면에서 확인하세요. 맞으면 [이 건 실제로 저장하기]를 누르세요', 'practice'); return; }
      if (!needForm) { afterRentalSaved(st, job); return; }            // 상품명만 바꾸는 건: 렌탈사 폼 저장 없이 [저장 후 목록]으로
      const btn = [...f.querySelectorAll('button')].find((b) => b.textContent.trim() === '수정');
      if (!btn) { pause(st, '렌탈사 [수정] 버튼을 찾지 못함'); return; }
      st.stage = 'rental-saving'; st.stageAt = Date.now(); putState(st);
      ui.refreshRun();
      btn.click();
      armWatchdog('rental-saving');
      pollLgSaved(getState(), job);
      return;
    }
    if (st.stage === 'rental-saving') {
      if (forms.length !== 1) { pause(st, `저장 후 ${LG_CO} 폼 ${forms.length}개`); return; }
      const al = popAlerts(), bad = alertProblem(al), v = lgVerifyForm(forms[0], job);
      if (v) { pause(st, `저장 후에도 값이 달라요: ${v}${al.length ? ' · 알림: ' + al.join(' / ') : ''}`); return; }
      if (bad) { pause(st, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(st, job);
      return;
    }
    if (st.stage === 'main-saving') {
      const al = popAlerts();
      pause(st, `[저장 후 목록] 후에도 수정 페이지에 남아 있음${al.length ? ' · 알림: ' + al.join(' / ') : ''}`);
    }
  }
  async function pollLgSaved(st0, job) {
    const at = st0.stageAt, t0 = Date.now();
    while (Date.now() - t0 < STAGE_TIMEOUT_MS - 3000) {
      await sleep(1000);
      const cur = getState();
      if (!cur || !cur.running || cur.stage !== 'rental-saving' || cur.stageAt !== at) return;
      let ok = false;
      try { const fs = companyForms(await fetchEdit(job.code), LG_CO); ok = fs.length === 1 && !lgVerifyForm(fs[0], job); } catch { /* 다음 주기에 다시 */ }
      if (!ok) continue;
      await sleep(2000);
      const c2 = getState();
      if (!c2 || !c2.running || c2.stage !== 'rental-saving' || c2.stageAt !== at) return;
      const al = popAlerts(), bad = alertProblem(al);
      if (bad) { pause(c2, `사이트 알림 확인 필요: ${al.join(' / ')}`); return; }
      afterRentalSaved(c2, c2.jobs[c2.idx]);
      return;
    }
  }

  // ---- 화면 ----
  function lgReparse() {
    const el = $('#xlInfo');
    if (!el) return;
    if (!excel) { el.textContent = '불러온 엑셀 없음'; return; }
    const p = lgParseWorkbook(excel.sheets);
    el.innerHTML = `${esc(excel.fileName)} · 카테고리 시트 <b>${Object.keys(p.perCat).length}</b>개 · 줄 <b>${p.recs.length}</b>개<br>`
      + LG_CATS.filter((c) => p.perCat[c.id]).map((c) => `${c.label} ${p.perCat[c.id].n}줄`).join(' · ')
      + (p.problems.length ? `<br><span class="rv">${p.problems.map(esc).join(' · ')}</span>` : '');
  }
  function initLgUi() {
    const left = root.querySelector('.col-l'), right = root.querySelector('.col-r');
    if (!left || !right) return;
    const stl = document.createElement('style');
    stl.textContent = '.ptabs,#periodBox,#sheetBox,#emptyBox,#resBox,#execBox,#newBanner,.card:has(#analyze),.card:has(#company){display:none!important}'
      + '.segs{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.segs button{background:#fff;color:var(--pri);border:1px solid #e7c97d;padding:7px 12px;font-size:13.5px}.segs button.on{background:var(--pri);color:#fff;border-color:var(--pri)}';
    root.appendChild(stl);
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'lgCard';
    card.innerHTML = `<div class="card-h"><span class="step">2</span>${ICON(IC.sliders)} LG전자 렌탈료 검수</div>
      <div class="hint">엑셀의 구독료(36·48·60·72개월), 서비스타입·방문주기, 케어솔루션 총요금(추가안내정보)을 사이트의 <b>렌탈사명 LG전자</b> 상품과 비교합니다. 분석은 사이트를 수정하지 않습니다.</div>
      <div class="segs" id="lgSegs"><button data-c="all" class="on">총괄</button>${LG_CATS.map((c) => `<button data-c="${c.id}">${c.label}</button>`).join('')}</div>
      <label class="opt"><input type="checkbox" id="lgOptName" checked><span>상품명 끝의 (서비스타입/방문주기)도 엑셀에 맞춤 (라이트 = 라이트플러스)</span></label>
      <label class="opt"><input type="checkbox" id="lgOptBrief" checked><span>추가안내정보의 케어솔루션 총요금(72개월 구독료 × 72)·방문주기도 맞춤</span></label>
      <label class="opt"><input type="checkbox" id="lgOptStd" checked><span>서비스타입 <b>스탠다드</b>는 라이트와 같은 서비스로 봄 (끄면 상품명의 스탠다드를 라이트로 고치는 건으로 표시)</span></label>
      <label class="opt"><input type="checkbox" id="lgPractice"><span>연습: 첫 건의 값만 채우고 저장은 하지 않음</span></label>
      <div class="go"><button id="lgGo">${ICON(IC.flash, 17)} 분석 시작 (사이트 수정 없음)</button><button id="lgStop" class="sub" style="display:none">${ICON(IC.stop, 15)} 중지</button></div>
      <progress id="lgProg" value="0" max="1" style="display:none;margin-top:10px"></progress>
      <div id="lgText" class="hint"></div>`;
    left.appendChild(card);
    const res = document.createElement('div');
    res.className = 'card'; res.id = 'lgBox'; res.style.display = 'none';
    res.innerHTML = `<div class="card-h"><span class="step">3</span>${ICON(IC.table)} LG전자 검수 결과 <span class="sp"></span><span id="lgSel" class="hint" style="margin:0;font-weight:700;color:var(--pri)"></span></div>
      <div id="lgSum" class="hint" style="color:var(--txt)"></div>
      <div class="sbar"><span class="sico">${ICON('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>', 18)}</span><input id="lgQ" type="text" placeholder="모델명·상품명으로 찾기" autocomplete="off"><button class="sx" id="lgQClear" style="display:none">✕</button><button class="sgo" id="lgQBtn">검색</button></div>
      <div class="qinfo" id="lgQInfo"></div>
      <div class="chips" id="lgChips"></div>
      <div class="row" style="margin-top:0"><button class="sub" id="lgSelOk">변경 있음 모두 선택</button><button class="sub" id="lgSelNone">표시된 건 선택 해제</button><span style="flex:1"></span><button class="sub" id="lgXlsx">${ICON(IC.down, 15)} 결과 엑셀 저장</button></div>
      <div class="tblwrap" style="margin-top:10px"><table><thead><tr><th><input type="checkbox" id="lgAllChk" title="표시된 변경 건 전체 선택/해제"></th><th>상태</th><th>엑셀 모델</th><th>사이트 상품</th><th>변경 내용</th></tr></thead><tbody id="lgRows"></tbody></table></div>
      <div class="go"><button id="lgRun" class="warn">${ICON(IC.play, 16)} 선택한 건 사이트에 반영</button></div>
      <div class="hint">실행 대상은 <b>체크했고 지금 표에 보이는 건</b>만입니다. 처음에는 [연습]을 켜서 1건을 확인하세요.</div>`;
    right.insertBefore(res, right.firstChild);
    $('#lgSegs').addEventListener('click', (e) => { const c = e.target.dataset && e.target.dataset.c; if (!c) return; lgCatSel = c; root.querySelectorAll('#lgSegs button').forEach((b) => b.classList.toggle('on', b.dataset.c === c)); });
    $('#lgGo').addEventListener('click', lgAnalyze);
    $('#lgStop').addEventListener('click', () => { lgStopFlag = true; });
    $('#lgRun').addEventListener('click', lgStartRun);
    $('#lgXlsx').addEventListener('click', lgExport);
    $('#lgChips').addEventListener('click', (e) => { const f = e.target.dataset && e.target.dataset.f; if (f) { lgFilter = f; renderLg(); } });
    const doSearch = () => { lgQuery = $('#lgQ').value.trim(); $('#lgQClear').style.display = lgQuery ? '' : 'none'; renderLg(); };
    $('#lgQBtn').addEventListener('click', doSearch);
    $('#lgQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    $('#lgQClear').addEventListener('click', () => { $('#lgQ').value = ''; doSearch(); });
    const save = () => ssSet(LG_PLAN_KEY, lgPlan);
    $('#lgRows').addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k || !lgPlan) return;
      lgPlan.selected = e.target.checked ? [...new Set([...lgPlan.selected, k])] : lgPlan.selected.filter((x) => x !== k);
      save(); renderLg();
    });
    $('#lgAllChk').addEventListener('change', (e) => {
      if (!lgPlan) return;
      const codes = lgPlan.items.filter((r) => lgInView(r) && r.status === 'ok').map((r) => r.key);
      lgPlan.selected = e.target.checked ? [...new Set([...lgPlan.selected, ...codes])] : lgPlan.selected.filter((k) => !codes.includes(k));
      save(); renderLg();
    });
    $('#lgSelOk').addEventListener('click', () => { if (!lgPlan) return; lgPlan.selected = [...new Set([...lgPlan.selected, ...lgPlan.items.filter((r) => lgInView(r) && r.status === 'ok').map((r) => r.key)])]; save(); renderLg(); });
    $('#lgSelNone').addEventListener('click', () => { if (!lgPlan) return; const del = new Set(lgPlan.items.filter(lgInView).map((r) => r.key)); lgPlan.selected = lgPlan.selected.filter((k) => !del.has(k)); save(); renderLg(); });
    const saved = ssGet(LG_PLAN_KEY);
    if (saved && saved.items) { lgPlan = saved; renderLg(); }
    lgReparse();
  }

  // ====================================================================
  // 시작
  // ====================================================================
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason, where = String((r && r.stack) || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/chrome-extension:\/\/[a-z]+\//, '')).join(' | ');
      log(`⚠ 오류: ${String((r && r.message) || r)} @ ${where}`);
      e.preventDefault();
    } catch { /* 무시 */ }
  });
  if (IS_LIST) { initListUi(); initLgUi(); initDisUi(); }
  refreshRun();
  tick();
  if (IS_LIST) tickListDel();
})();
