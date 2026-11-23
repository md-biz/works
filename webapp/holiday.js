// ============================================================
// holiday.js — 휴일 관리 (공휴일 설정 · 월별 달력 · 휴가 등록 · 월 통계)
// app.js 다음에 불러옵니다. (escapeHtml, API_BASE, ASSIGNEE_OPTIONS 등 사용)
// ============================================================

// 근태 종류: 하루당 시간 / 하루당 일수
const LEAVE_TYPES = {
  연차: { hours: 8, days: 1 },
  반차: { hours: 4, days: 0.5 },
  반반차: { hours: 2, days: 0.25 },
  검진: { hours: 8, days: 1 }
};

// 담당자 그룹별 색상 (기획 푸른색 · 디자인 보라색 · 퍼블 녹색 · GA 주황색)
const LEAVE_ROLE_COLORS = {
  기획: "role-plan",
  디자인: "role-design",
  퍼블: "role-pub",
  GA: "role-ga"
};

const holidayState = {
  holidays: {},   // { "2026": [{ id, name, date }] }
  leaves: [],     // [{ id, start, end, type, assignee, role, hours, days }]
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  loaded: false
};

// ---------------- 저장소 (Vercel API 또는 localStorage) ----------------

function hdNsQuery() { return window.APP_NS ? `?ns=${encodeURIComponent(window.APP_NS)}` : ""; }
function hdLocalKey() { return "wm_holidays_v1" + (window.APP_NS ? `_${window.APP_NS}` : ""); }

function hdSaveLocal() {
  try {
    localStorage.setItem(hdLocalKey(), JSON.stringify({ holidays: holidayState.holidays, leaves: holidayState.leaves }));
  } catch (e) { /* 용량 초과 등 무시 */ }
}

function hdApplyData(data) {
  holidayState.holidays = (data && data.holidays && typeof data.holidays === "object") ? data.holidays : {};
  holidayState.leaves = (data && Array.isArray(data.leaves)) ? data.leaves : [];
}

// ---------------- 여러 사람이 함께 쓸 때의 저장 (서버 최신본과 합치기) ----------------
// 휴가·공휴일은 "목록 전체"를 서버에 저장합니다. 예전에는 내 화면의 목록을 그대로 덮어썼기 때문에,
// 내가 화면을 연 뒤에 다른 사람이 등록한 휴가가 내 저장으로 사라질 수 있었습니다.
// 지금은 저장 직전에 서버 최신 목록을 받아 "내가 바꾼 부분(추가·수정·삭제)"만 얹어서 저장합니다.

const hdSync = {
  base: null,               // 마지막으로 서버와 맞춘 상태 { holidays, leaves } — 내가 바꾼 부분을 가려내는 기준
  chain: Promise.resolve(), // 저장을 한 번에 하나씩 순서대로 처리
  saving: 0,
  lastCheck: 0,
  retryTimer: null, retryCount: 0
};

function hdClone(v) { return JSON.parse(JSON.stringify(v)); }
function hdNormalize(data) {
  return {
    holidays: (data && data.holidays && typeof data.holidays === "object" && !Array.isArray(data.holidays)) ? data.holidays : {},
    leaves: (data && Array.isArray(data.leaves)) ? data.leaves : []
  };
}
// 키 순서와 무관하게 내용이 같은지 비교하기 위한 문자열
function hdStable(v) {
  if (Array.isArray(v)) return "[" + v.map(hdStable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + hdStable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
function hdItemKey(x) { return (x && x.id) || hdStable(x); }

// base(마지막으로 맞춘 상태) · local(내 화면) · server(서버 최신) 세 목록을 합칩니다.
// - 내가 추가·수정한 항목은 내 것을, 내가 지운 항목은 제외, 나머지는 서버 내용을 그대로 따릅니다.
// - 다른 사람이 지운 항목을 내가 수정했다면 내용 보존을 위해 남깁니다.
function hdMergeList(base, local, server) {
  const baseMap = new Map(base.map(x => [hdItemKey(x), x]));
  const localMap = new Map(local.map(x => [hdItemKey(x), x]));
  const changedByMe = (k, l) => { const b = baseMap.get(k); return !b || hdStable(b) !== hdStable(l); };
  const out = [];
  const seen = new Set();
  server.forEach(s => {
    const k = hdItemKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    const l = localMap.get(k);
    if (!l) { if (!baseMap.has(k)) out.push(s); return; } // 내가 지운 항목은 제외, 남이 추가한 항목은 유지
    out.push(changedByMe(k, l) ? l : s);
  });
  local.forEach(l => {
    const k = hdItemKey(l);
    if (seen.has(k)) return;
    seen.add(k);
    if (changedByMe(k, l)) out.push(l);
  });
  return out;
}

function hdFlatHolidays(holidays) {
  const out = [];
  Object.keys(holidays || {}).forEach(y => (holidays[y] || []).forEach(h => { if (h) out.push(h); }));
  return out;
}

// 서버 최신 데이터와 내 화면의 변경분을 합친 결과 { holidays, leaves }
function hdMergeWithServer(serverData) {
  const server = hdNormalize(serverData);
  const base = hdSync.base || { holidays: {}, leaves: [] };

  const leaves = hdMergeList(base.leaves, holidayState.leaves, server.leaves)
    .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));

  // 공휴일: 연도 구분 없이 합친 뒤 날짜의 연도로 다시 묶습니다. (두 사람이 같은 공휴일을 각각 불러온 경우 중복 제거)
  const holidays = {};
  const dup = new Set();
  hdMergeList(hdFlatHolidays(base.holidays), hdFlatHolidays(holidayState.holidays), hdFlatHolidays(server.holidays))
    .forEach(h => {
      const sig = `${h.date}|${h.name}`;
      if (dup.has(sig)) return;
      dup.add(sig);
      const y = String(h.date || "").slice(0, 4) || "기타";
      (holidays[y] = holidays[y] || []).push(h);
    });
  Object.keys(holidays).forEach(y => holidays[y].sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))));

  return { holidays, leaves, server };
}

function hdModalOpen() {
  return ["leaveModal", "holidayModal"].some(id => {
    const m = document.getElementById(id);
    return m && m.style.display === "flex";
  });
}

async function loadHolidayData() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(hdLocalKey()) || "null"); } catch (e) { local = null; }
  if (!API_BASE) {
    hdApplyData(local);
    holidayState.loaded = true;
    return;
  }
  try {
    const data = await apiFetchJson("/api/holidays" + hdNsQuery());
    hdApplyData(data);
    hdSaveLocal();
  } catch (err) {
    console.error("[휴일 데이터 불러오기 실패]", err);
    hdApplyData(local);
  }
  hdSync.base = hdClone(hdNormalize(holidayState));
  holidayState.loaded = true;
}

// 다른 사용자가 등록한 휴가·공휴일 반영: 휴가공유/요약 화면을 열 때, 창으로 돌아올 때, 1분마다 확인합니다.
// 팝업이 열려 있거나 저장 중이면 건너뜁니다. 아직 저장하지 못한 내 변경은 그대로 유지됩니다.
async function hdRefreshFromServer() {
  if (!API_BASE || !holidayState.loaded || hdSync.saving) return;
  if (document.visibilityState !== "visible" || hdModalOpen()) return;
  if (typeof state === "undefined" || (state.view !== "holiday" && state.view !== "summary")) return;
  if (Date.now() - hdSync.lastCheck < 10000) return;
  hdSync.lastCheck = Date.now();
  try {
    const data = await apiFetchJson("/api/holidays" + hdNsQuery());
    if (hdSync.saving || hdModalOpen()) return;
    const merged = hdMergeWithServer(data);
    const before = hdStable(hdNormalize(holidayState));
    holidayState.holidays = merged.holidays;
    holidayState.leaves = merged.leaves;
    hdSync.base = hdClone(merged.server);
    hdSaveLocal();
    if (hdStable(hdNormalize(holidayState)) !== before) hdRefreshViews();
  } catch (e) { /* 확인 실패는 조용히 무시 (다음 확인 때 재시도) */ }
}
document.addEventListener("visibilitychange", hdRefreshFromServer);
window.addEventListener("focus", hdRefreshFromServer);
setInterval(hdRefreshFromServer, 60000);

// part: "holidays" | "leaves"
// 저장은 한 번에 하나씩 순서대로 처리합니다. (연달아 저장해도 서로 덮어쓰지 않도록)
function saveHolidayData(part) {
  hdSaveLocal();
  if (!API_BASE) return Promise.resolve();
  const run = () => hdSaveNow(part);
  hdSync.chain = hdSync.chain.then(run, run);
  return hdSync.chain;
}

async function hdSaveNow(part) {
  setSaveStatus("saving", "저장 중...");
  hdSync.saving += 1;
  try {
    // 서버 최신본을 받아 내 변경분(추가·수정·삭제)만 얹어 저장합니다.
    // 서버는 "내가 받은 버전(baseVersion)과 지금 버전이 같을 때만" 저장하고, 그사이 다른 사람이 저장했으면
    // 409 로 최신본을 돌려줍니다 → 다시 합쳐서 저장 (최대 6회).
    const path = "/api/holidays" + hdNsQuery();
    let data = await apiFetchJson(path);
    let saved = false;
    for (let attempt = 0; attempt < 6 && !saved; attempt++) {
      const merged = hdMergeWithServer(data);
      const before = hdStable(hdNormalize(holidayState));
      holidayState.holidays = merged.holidays;
      holidayState.leaves = merged.leaves;
      hdSync.base = hdClone(merged.server);
      hdSaveLocal();
      if (hdStable(hdNormalize(holidayState)) !== before) hdRefreshViews(); // 다른 사용자 변경이 있었으면 화면에도 반영

      // 서버와 달라진 부분만 저장 (이전에 저장하지 못한 다른 부분이 있으면 함께)
      const body = {};
      ["holidays", "leaves"].forEach(p => {
        if (hdStable(holidayState[p]) !== hdStable(merged.server[p])) body[p] = holidayState[p];
      });
      if (!Object.keys(body).length) { saved = true; break; } // 서버 내용과 같음 → 저장 완료

      const versioned = data && typeof data.version === "number"; // 서버(api/holidays.js)가 버전 확인을 지원하는지
      if (versioned) body.baseVersion = data.version;
      const res = await fetch(API_BASE + withNs(path), {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.status === 409) {
        const latest = await res.json().catch(() => ({}));
        if (!latest || !Array.isArray(latest.leaves)) throw new Error(`409 충돌${latest && latest.error ? " - " + latest.error : ""} (/api/holidays)`);
        data = latest; // 최신본 기준으로 다시 합쳐서 저장
        continue;
      }
      if (!res.ok) throw await buildHttpError(res, "/api/holidays");
      if (versioned) {
        hdSync.base = hdClone(hdNormalize(holidayState));
        saved = true;
        break;
      }
      // 서버가 예전 버전(버전 확인 없음)일 때: 다시 읽어 내 변경이 실제로 남았는지 확인합니다.
      await new Promise(r => setTimeout(r, 150 + Math.random() * 300));
      data = await apiFetchJson(path);
    }
    if (!saved) throw new Error("다른 사용자의 저장과 계속 겹칩니다. 잠시 후 자동으로 다시 시도합니다. (/api/holidays)");
    hdSync.retryCount = 0;
    if (hdSync.retryTimer) { clearTimeout(hdSync.retryTimer); hdSync.retryTimer = null; }
    const t = new Date();
    setSaveStatus("ok", `저장됨 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`);
  } catch (err) {
    saveState.lastError = ((err && err.message) || String(err)) +
      "\n\n[확인] api/holidays.js 파일을 올리고 Vercel 에서 Redeploy 했는지 확인하세요. (이 브라우저에는 저장되어 있으며, 자동으로 다시 저장을 시도합니다)";
    setSaveStatus("error", "저장 실패 · 자동 재시도 중 (클릭)");
    // 자동 재시도: 5초 → 15초 → 이후 1분 간격 (최대 10회)
    if (hdSync.retryCount < 10 && !hdSync.retryTimer) {
      const delay = [5000, 15000, 60000][Math.min(hdSync.retryCount, 2)];
      hdSync.retryCount += 1;
      hdSync.retryTimer = setTimeout(() => {
        hdSync.retryTimer = null;
        saveHolidayData(part).catch(() => {});
      }, delay);
    }
    throw err;
  } finally {
    hdSync.saving -= 1;
  }
}

// ---------------- 날짜 유틸 ----------------

function hdYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function hdDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function hdIsValidYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  return hdYmd(hdDate(s)) === s;
}

// "2026-10-23", "20261023", "2026.10.23", "10/23", "1023" → "YYYY-MM-DD" (실패 시 "")
function hdParseDateText(text, fallbackYear) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  let m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})$/.exec(raw) || /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  let iso = "";
  if (m) iso = `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
  else iso = mmddToIso(raw, fallbackYear);
  return hdIsValidYmd(iso) ? iso : "";
}

// 전체 연도의 공휴일 { "YYYY-MM-DD": "휴일명" }
function hdHolidayMap() {
  const map = {};
  Object.values(holidayState.holidays).forEach(list => {
    (list || []).forEach(h => {
      if (!h.date) return;
      map[h.date] = map[h.date] ? `${map[h.date]} · ${h.name}` : (h.name || "휴일");
    });
  });
  return map;
}

function hdIsWorkday(ymd, holidayMap) {
  const dow = hdDate(ymd).getDay();
  return dow !== 0 && dow !== 6 && !holidayMap[ymd];
}

// 기간 안의 근무일(주말·공휴일 제외) 목록
function hdWorkdays(start, end, holidayMap) {
  const out = [];
  if (!hdIsValidYmd(start) || !hdIsValidYmd(end) || start > end) return out;
  const map = holidayMap || hdHolidayMap();
  const d = hdDate(start);
  const last = hdDate(end);
  while (d <= last) {
    const ymd = hdYmd(d);
    if (hdIsWorkday(ymd, map)) out.push(ymd);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function hdCalcLeave(type, start, end, holidayMap) {
  const t = LEAVE_TYPES[type] || LEAVE_TYPES.연차;
  const n = hdWorkdays(start, end, holidayMap).length;
  return { workdays: n, hours: n * t.hours, days: n * t.days };
}

// 담당자가 현재 속한 그룹 (담당자 설정 기준, 없으면 등록 당시 그룹)
function hdRoleOf(name, fallback) {
  for (const role of Object.keys(ASSIGNEE_OPTIONS)) {
    if (ASSIGNEE_OPTIONS[role].includes(name)) return role;
  }
  return fallback || "";
}

// 특정 연/월에 걸친 휴가를 담당자별로 집계 { name: { role, days, hours } }
function hdMonthStats(year, month) {
  const map = hdHolidayMap();
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const stats = {};
  holidayState.leaves.forEach(lv => {
    const t = LEAVE_TYPES[lv.type] || LEAVE_TYPES.연차;
    const n = hdWorkdays(lv.start, lv.end, map).filter(d => d.startsWith(prefix)).length;
    if (!n) return;
    const s = stats[lv.assignee] || (stats[lv.assignee] = { role: hdRoleOf(lv.assignee, lv.role), days: 0, hours: 0 });
    s.days += n * t.days;
    s.hours += n * t.hours;
  });
  return stats;
}

// 요약 탭 "투입 MM"용: 월 탭(예: "10월")의 직무별 휴가 시간 합계
function leaveHoursByRoleForMonth(monthLabel) {
  const month = parseInt(monthLabel, 10);
  const sums = {};
  if (!month) return sums;
  const stats = hdMonthStats(sheetYear(), month);
  Object.values(stats).forEach(s => { if (s.role) sums[s.role] = (sums[s.role] || 0) + s.hours; });
  return sums;
}

function hdFmtNum(n) { return Number.isInteger(n) ? String(n) : String(+n.toFixed(2)); }

// ---------------- 달력 화면 ----------------

function renderHolidayView() {
  const panel = document.getElementById("holidayPanel");
  if (!panel) return;
  const { year, month } = holidayState;

  // 연도 선택 범위: 올해 -2 ~ +2 + 데이터가 있는 연도
  const thisYear = new Date().getFullYear();
  const years = new Set();
  for (let y = thisYear - 2; y <= thisYear + 2; y++) years.add(y);
  Object.keys(holidayState.holidays).forEach(y => years.add(+y));
  years.add(year);
  const yearOpts = [...years].sort((a, b) => a - b)
    .map(y => `<option value="${y}" ${y === year ? "selected" : ""}>${y}년</option>`).join("");
  const monthOpts = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${m}월</option>`).join("");

  const legend = Object.keys(LEAVE_ROLE_COLORS)
    .map(r => `<span class="hd-legend-item"><i class="hd-dot ${LEAVE_ROLE_COLORS[r]}"></i>${r}</span>`).join("");

  panel.innerHTML = `
    <div class="hd-layout">
      <div class="summary-card hd-cal-card">
        <div class="hd-cal-head">
          <div class="hd-nav">
            <button type="button" class="hd-nav-btn" id="hdPrev" title="이전 달">‹</button>
            <select id="hdYear" class="status-filter">${yearOpts}</select>
            <select id="hdMonth" class="status-filter">${monthOpts}</select>
            <button type="button" class="hd-nav-btn" id="hdNext" title="다음 달">›</button>
            <button type="button" class="btn btn-ghost hd-today" id="hdToday">오늘</button>
            <button type="button" class="btn btn-ghost hd-today" id="hdExportCsv" title="이 달의 휴가 목록을 CSV로 저장">CSV 내보내기</button>
          </div>
          <div class="hd-legend">${legend}<span class="hd-legend-hint">날짜를 누르면 휴가를 등록합니다</span></div>
        </div>
        <div id="hdCalendar" class="hd-calendar"></div>
      </div>
    </div>`;

  document.getElementById("hdPrev").onclick = () => hdMoveMonth(-1);
  document.getElementById("hdNext").onclick = () => hdMoveMonth(1);
  document.getElementById("hdYear").onchange = (e) => { holidayState.year = +e.target.value; renderHolidayView(); };
  document.getElementById("hdMonth").onchange = (e) => { holidayState.month = +e.target.value; renderHolidayView(); };
  document.getElementById("hdToday").onclick = () => {
    const now = new Date();
    holidayState.year = now.getFullYear();
    holidayState.month = now.getMonth() + 1;
    renderHolidayView();
  };

  document.getElementById("hdExportCsv").onclick = exportLeaveCsv;

  renderHolidayCalendar();
}

// ---------------- 휴가 CSV 내보내기 (보고 있는 연/월 기준) ----------------
// 해당 월에 걸친 휴가를 한 줄씩 내보냅니다. 시간·일수는 그 달에 해당하는 근무일만 계산합니다.
// 열: 그룹 / 담당자 / 시작일 / 종료일 / 근태명 / 시간 / 일수 / 담당자별 시간 합계
// 정렬: 그룹 → 담당자 → 시작일. "담당자별 시간 합계"는 담당자의 첫 줄에만 표시합니다.
function exportLeaveCsv() {
  const { year, month } = holidayState;
  const map = hdHolidayMap();
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const q = (v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`;

  const rows = holidayState.leaves
    .map(lv => {
      const t = LEAVE_TYPES[lv.type] || LEAVE_TYPES.연차;
      const n = hdWorkdays(lv.start, lv.end, map).filter(d => d.startsWith(prefix)).length;
      return { lv, role: hdRoleOf(lv.assignee, lv.role), n, days: n * t.days, hours: n * t.hours };
    })
    .filter(r => r.n > 0)
    .sort((a, b) => hdRoleOrder(a.role) - hdRoleOrder(b.role) || (a.lv.assignee || "").localeCompare(b.lv.assignee || "") || a.lv.start.localeCompare(b.lv.start));

  if (!rows.length) { alert(`${year}년 ${month}월에 등록된 휴가가 없습니다.`); return; }

  // 담당자별 시간 합계
  const hoursByPerson = {};
  rows.forEach(r => { hoursByPerson[r.lv.assignee] = (hoursByPerson[r.lv.assignee] || 0) + r.hours; });

  const header = ["그룹", "담당자", "시작일", "종료일", "근태명", "시간", "일수", "담당자별 시간 합계"];
  const shown = new Set();
  const lines = rows.map(r => {
    const who = r.lv.assignee;
    const sum = shown.has(who) ? "" : hdFmtNum(hoursByPerson[who]);
    shown.add(who);
    return [r.role || "-", who, r.lv.start, r.lv.end, r.lv.type, hdFmtNum(r.hours), hdFmtNum(r.days), sum].map(q).join(",");
  });
  const totalDays = rows.reduce((a, r) => a + r.days, 0);
  const totalHours = rows.reduce((a, r) => a + r.hours, 0);
  lines.push(["계", "", "", "", "", hdFmtNum(totalHours), hdFmtNum(totalDays), hdFmtNum(totalHours)].map(q).join(","));

  const csv = [header.map(q).join(","), ...lines].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `휴가공유_${year}년${String(month).padStart(2, "0")}월${window.APP_NS ? "_" + window.APP_NS : ""}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hdMoveMonth(delta) {
  const d = new Date(holidayState.year, holidayState.month - 1 + delta, 1);
  holidayState.year = d.getFullYear();
  holidayState.month = d.getMonth() + 1;
  renderHolidayView();
}

function renderHolidayCalendar() {
  const el = document.getElementById("hdCalendar");
  const { year, month } = holidayState;
  const map = hdHolidayMap();
  const today = hdYmd(new Date());

  // 근무일별 휴가 목록
  const byDate = {};
  holidayState.leaves.forEach(lv => {
    hdWorkdays(lv.start, lv.end, map).forEach(d => { (byDate[d] = byDate[d] || []).push(lv); });
  });

  const first = new Date(year, month - 1, 1);
  const cursor = new Date(first);
  cursor.setDate(1 - first.getDay()); // 일요일 시작
  const lastDay = new Date(year, month, 0);
  const weeks = Math.ceil((first.getDay() + lastDay.getDate()) / 7);

  const dows = ["일", "월", "화", "수", "목", "금", "토"];
  let html = `<div class="hd-dow-row">${dows.map((d, i) => `<div class="hd-dow ${i === 0 ? "is-sun" : i === 6 ? "is-sat" : ""}">${d}</div>`).join("")}</div>`;
  html += `<div class="hd-grid">`;
  for (let i = 0; i < weeks * 7; i++) {
    const ymd = hdYmd(cursor);
    const dow = cursor.getDay();
    const holidayName = map[ymd];
    const cls = ["hd-cell"];
    if (cursor.getMonth() !== month - 1) cls.push("is-other");
    if (dow === 6) cls.push("is-sat");
    if (dow === 0 || holidayName) cls.push("is-red");
    if (ymd === today) cls.push("is-today");

    const chips = (byDate[ymd] || [])
      .slice()
      .sort((a, b) => hdRoleOrder(hdRoleOf(a.assignee, a.role)) - hdRoleOrder(hdRoleOf(b.assignee, b.role)) || a.assignee.localeCompare(b.assignee))
      .map(lv => {
        const role = hdRoleOf(lv.assignee, lv.role);
        return `<button type="button" class="hd-chip ${LEAVE_ROLE_COLORS[role] || "role-etc"}" data-leave="${escapeHtml(lv.id)}" title="${escapeHtml(`${lv.assignee} ${lv.type} (${lv.start}${lv.end !== lv.start ? " ~ " + lv.end : ""})`)}">${escapeHtml(lv.assignee)} ${escapeHtml(lv.type)}</button>`;
      }).join("");

    html += `<div class="${cls.join(" ")}" data-date="${ymd}">
      <div class="hd-cell-top"><span class="hd-num">${cursor.getDate()}</span>${holidayName ? `<span class="hd-hname" title="${escapeHtml(holidayName)}">${escapeHtml(holidayName)}</span>` : ""}</div>
      <div class="hd-chips">${chips}</div>
    </div>`;
    cursor.setDate(cursor.getDate() + 1);
  }
  html += `</div>`;
  el.innerHTML = html;

  el.querySelectorAll(".hd-cell").forEach(cell => {
    cell.onclick = () => openLeaveModal({ date: cell.dataset.date });
  });
  el.querySelectorAll(".hd-chip").forEach(chip => {
    chip.onclick = (e) => {
      e.stopPropagation();
      const lv = holidayState.leaves.find(l => l.id === chip.dataset.leave);
      if (lv) openLeaveModal({ leave: lv });
    };
  });
}

function hdRoleOrder(role) {
  const order = Object.keys(LEAVE_ROLE_COLORS);
  const i = order.indexOf(role);
  return i < 0 ? 99 : i;
}

function renderHolidayStats() {
  const el = document.getElementById("hdStats");
  const { year, month } = holidayState;
  const stats = hdMonthStats(year, month);

  // 담당자 설정의 모든 담당자 + 설정에서 빠졌지만 이번 달 기록이 있는 담당자
  const rows = [];
  Object.keys(ASSIGNEE_OPTIONS).forEach(role => {
    ASSIGNEE_OPTIONS[role].forEach(name => rows.push({ name, role, ...(stats[name] || { days: 0, hours: 0 }) }));
  });
  Object.keys(stats).forEach(name => {
    if (!rows.some(r => r.name === name)) rows.push({ name, ...stats[name] });
  });

  const totalDays = rows.reduce((a, r) => a + r.days, 0);
  const totalHours = rows.reduce((a, r) => a + r.hours, 0);

  let html = `<h3>${year}년 ${month}월 휴가 통계</h3>
    <table class="summary-table hd-stats-table"><thead><tr><th>그룹</th><th>담당자</th><th>일수</th><th>시간</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const dot = `<i class="hd-dot ${LEAVE_ROLE_COLORS[r.role] || "role-etc"}"></i>`;
    html += `<tr class="${r.hours ? "" : "is-zero"}"><td class="cell-label">${dot}${escapeHtml(r.role || "-")}</td><td class="cell-label">${escapeHtml(r.name)}</td><td>${r.days ? hdFmtNum(r.days) + "일" : "-"}</td><td>${r.hours ? hdFmtNum(r.hours) + "H" : "-"}</td></tr>`;
  });
  html += `<tr class="total-row"><td class="cell-label" colspan="2">계</td><td>${hdFmtNum(totalDays)}일</td><td>${hdFmtNum(totalHours)}H</td></tr>`;
  html += `</tbody></table>
    <p class="hd-stats-note">주말·공휴일은 제외하고 계산합니다. (연차·검진 8H/일, 반차 4H/0.5일, 반반차 2H/0.25일)</p>`;
  el.innerHTML = html;
}

// ---------------- 휴가 등록 / 수정 팝업 ----------------

let leaveEditing = null; // 수정 중인 휴가 id (null = 신규)

function hdDateField(id, value) {
  return `<span class="date-cell hd-date-field">
    <input type="text" id="${id}" class="hd-input shortdate-input" placeholder="YYYY-MM-DD" maxlength="10" value="${value}" />
    <input type="date" id="${id}Picker" class="date-picker" tabindex="-1" value="${value}" />
    <button type="button" class="date-btn" data-picker="${id}Picker" title="달력에서 선택">📅</button>
  </span>`;
}

function openLeaveModal({ date, leave }) {
  leaveEditing = leave ? leave.id : null;
  const modal = document.getElementById("leaveModal");
  const start = leave ? leave.start : date;
  const end = leave ? leave.end : date;
  const type = leave ? leave.type : "연차";
  const assignee = leave ? leave.assignee : "";

  const assigneeOpts = Object.keys(ASSIGNEE_OPTIONS).map(role =>
    `<optgroup label="${escapeHtml(role)}">${ASSIGNEE_OPTIONS[role].map(n =>
      `<option value="${escapeHtml(n)}" ${n === assignee ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</optgroup>`
  ).join("");
  const missing = assignee && !hdRoleOf(assignee) ? `<option value="${escapeHtml(assignee)}" selected>${escapeHtml(assignee)} (설정에 없음)</option>` : "";

  document.getElementById("leaveModalTitle").textContent = leave ? "휴가 수정" : "휴가 등록";
  document.getElementById("leaveForm").innerHTML = `
    <div class="hd-form-row">
      <label>기간</label>
      <div class="hd-range">${hdDateField("leaveStart", start)}<span class="hd-tilde">~</span>${hdDateField("leaveEnd", end)}</div>
    </div>
    <div class="hd-form-row">
      <label>근태명</label>
      <div class="hd-type-group">${Object.keys(LEAVE_TYPES).map(t =>
        `<label class="hd-type"><input type="radio" name="leaveType" value="${t}" ${t === type ? "checked" : ""} /><span>${t}</span></label>`).join("")}</div>
    </div>
    <div class="hd-form-row">
      <label>근태시간</label>
      <div id="leaveHours" class="hd-hours"></div>
    </div>
    <div class="hd-form-row">
      <label>담당자명</label>
      <select id="leaveAssignee" class="hd-input"><option value="">담당자 선택</option>${missing}${assigneeOpts}</select>
    </div>`;

  const year = +start.slice(0, 4) || holidayState.year;
  ["leaveStart", "leaveEnd"].forEach(id => {
    const text = document.getElementById(id);
    const picker = document.getElementById(id + "Picker");
    text.onchange = () => {
      const iso = hdParseDateText(text.value, year);
      if (!iso) { text.classList.add("is-invalid"); updateLeaveHours(); return; }
      text.classList.remove("is-invalid");
      text.value = iso; picker.value = iso;
      hdSyncRange(id);
      updateLeaveHours();
    };
    text.oninput = () => { text.classList.remove("is-invalid"); };
    picker.onchange = () => {
      if (!picker.value) return;
      text.value = picker.value;
      text.classList.remove("is-invalid");
      hdSyncRange(id);
      updateLeaveHours();
    };
  });
  modal.querySelectorAll(".hd-date-field .date-btn").forEach(btn => {
    btn.onclick = () => {
      const picker = document.getElementById(btn.dataset.picker);
      if (typeof picker.showPicker === "function") {
        try { picker.showPicker(); return; } catch (e) { /* 미지원 시 아래로 */ }
      }
      picker.focus(); picker.click();
    };
  });
  modal.querySelectorAll("input[name=leaveType]").forEach(r => { r.onchange = updateLeaveHours; });

  const delBtn = document.getElementById("btnLeaveDelete");
  delBtn.style.display = leave ? "" : "none";
  delBtn.onclick = deleteLeave;
  document.getElementById("btnLeaveClose").onclick = () => { modal.style.display = "none"; leaveEditing = null; };
  document.getElementById("btnLeaveSave").onclick = saveLeave;

  modal.style.display = "flex";
  updateLeaveHours();
}

// 시작일이 종료일보다 늦어지면 반대쪽을 맞춰줍니다.
function hdSyncRange(changedId) {
  const s = document.getElementById("leaveStart");
  const e = document.getElementById("leaveEnd");
  if (!hdIsValidYmd(s.value) || !hdIsValidYmd(e.value) || s.value <= e.value) return;
  if (changedId === "leaveStart") { e.value = s.value; document.getElementById("leaveEndPicker").value = s.value; }
  else { s.value = e.value; document.getElementById("leaveStartPicker").value = e.value; }
}

function hdReadLeaveForm() {
  const start = document.getElementById("leaveStart").value.trim();
  const end = document.getElementById("leaveEnd").value.trim();
  const typeEl = document.querySelector("input[name=leaveType]:checked");
  const type = typeEl ? typeEl.value : "연차";
  const assignee = document.getElementById("leaveAssignee").value;
  return { start, end, type, assignee };
}

function updateLeaveHours() {
  const { start, end, type } = hdReadLeaveForm();
  const el = document.getElementById("leaveHours");
  if (!hdIsValidYmd(start) || !hdIsValidYmd(end)) { el.innerHTML = `<span class="hd-warn">날짜를 확인하세요</span>`; return; }
  const c = hdCalcLeave(type, start, end);
  const per = LEAVE_TYPES[type].hours;
  if (!c.workdays) { el.innerHTML = `<b>0시간</b> <span class="hd-warn">선택한 기간에 근무일이 없습니다 (주말·공휴일)</span>`; return; }
  el.innerHTML = `<b>${hdFmtNum(c.hours)}시간</b> <span class="hd-sub">(${hdFmtNum(c.days)}일 · 근무일 ${c.workdays}일 × ${per}H)</span>`;
}

async function saveLeave() {
  const f = hdReadLeaveForm();
  if (!hdIsValidYmd(f.start) || !hdIsValidYmd(f.end)) { alert("기간을 YYYY-MM-DD 형식으로 입력하세요."); return; }
  if (f.start > f.end) { alert("종료일이 시작일보다 빠릅니다."); return; }
  if (!f.assignee) { alert("담당자를 선택하세요."); return; }
  const c = hdCalcLeave(f.type, f.start, f.end);
  if (!c.workdays) { alert("선택한 기간에 근무일이 없습니다. (주말·공휴일 제외)"); return; }

  const overlap = holidayState.leaves.find(l => l.id !== leaveEditing && l.assignee === f.assignee && l.start <= f.end && l.end >= f.start);
  if (overlap && !confirm(`${f.assignee} 님은 ${overlap.start}${overlap.end !== overlap.start ? " ~ " + overlap.end : ""} 에 이미 '${overlap.type}'이(가) 등록되어 있습니다.\n그래도 저장할까요?`)) return;

  const record = {
    id: leaveEditing || uid(),
    start: f.start, end: f.end, type: f.type,
    assignee: f.assignee, role: hdRoleOf(f.assignee),
    hours: c.hours, days: c.days
  };
  if (leaveEditing) {
    const i = holidayState.leaves.findIndex(l => l.id === leaveEditing);
    if (i >= 0) holidayState.leaves[i] = record; else holidayState.leaves.push(record);
  } else {
    holidayState.leaves.push(record);
  }
  holidayState.leaves.sort((a, b) => a.start.localeCompare(b.start));

  document.getElementById("leaveModal").style.display = "none";
  leaveEditing = null;
  hdRefreshViews();
  try { await saveHolidayData("leaves"); } catch (e) { /* 상태 표시에 안내 */ }
}

async function deleteLeave() {
  if (!leaveEditing) return;
  if (!confirm("이 휴가를 삭제하시겠습니까?")) return;
  holidayState.leaves = holidayState.leaves.filter(l => l.id !== leaveEditing);
  document.getElementById("leaveModal").style.display = "none";
  leaveEditing = null;
  hdRefreshViews();
  try { await saveHolidayData("leaves"); } catch (e) { /* 상태 표시에 안내 */ }
}

function hdRefreshViews() {
  if (state.view === "holiday") renderHolidayView();
  if (state.view === "summary") renderSummary();
}

// 담당자 설정에서 이름이 바뀌면 휴가 기록의 담당자명도 함께 변경
async function holidayApplyRenames(renames) {
  let changed = false;
  holidayState.leaves.forEach(lv => {
    renames.forEach(({ role, oldName, newName }) => {
      if (lv.assignee === oldName && (!lv.role || lv.role === role)) { lv.assignee = newName; lv.role = role; changed = true; }
    });
  });
  if (changed) {
    try { await saveHolidayData("leaves"); } catch (e) { /* 상태 표시에 안내 */ }
  }
}

// ---------------- 휴일 설정 팝업 (연 단위 공휴일 등록/수정/삭제) ----------------

let holidayDraft = null;
let holidayDraftYear = null;

function openHolidaySettings() {
  holidayDraft = JSON.parse(JSON.stringify(holidayState.holidays || {}));
  holidayDraftYear = holidayState.year;
  document.getElementById("holidayModal").style.display = "flex";
  renderHolidayForm();

  document.getElementById("btnHolidayClose").onclick = () => {
    document.getElementById("holidayModal").style.display = "none";
    holidayDraft = null;
  };
  document.getElementById("btnHolidaySave").onclick = saveHolidaySettings;
}

function renderHolidayForm() {
  const el = document.getElementById("holidayForm");
  const y = String(holidayDraftYear);
  const list = holidayDraft[y] || (holidayDraft[y] = []);
  // 디지털사업(index_biz.html)에서만: 업무관리(index.html)에 등록된 휴일을 불러오는 버튼
  const canImportMain = !!(window.APP_NS && API_BASE);

  el.innerHTML = `
    <div class="hd-year-bar">
      <button type="button" class="hd-nav-btn" id="hdfPrev">‹</button>
      <strong>${y}년</strong>
      <button type="button" class="hd-nav-btn" id="hdfNext">›</button>
      <span class="hd-year-count">${list.length}건</span>
      ${canImportMain ? `<button type="button" class="btn btn-ghost hd-preset" id="hdfImportMain">업무관리 휴일 불러오기</button>` : ""}
    </div>
    <div class="hd-holiday-list">
      ${list.length ? "" : `<p class="hd-empty">등록된 휴일이 없습니다. '+ 휴일 추가'를 눌러 등록하세요.</p>`}
      ${list.map((h, i) => `
        <div class="hd-holiday-row">
          <input type="date" class="hd-input" data-idx="${i}" data-field="date" value="${escapeHtml(h.date)}" min="${y}-01-01" max="${y}-12-31" />
          <input type="text" class="hd-input" data-idx="${i}" data-field="name" value="${escapeHtml(h.name)}" placeholder="휴일명" maxlength="30" />
          <button type="button" class="assignee-del" data-del="${i}" title="삭제">✕</button>
        </div>`).join("")}
    </div>
    <button type="button" class="btn btn-ghost btn-sm" id="hdfAdd">+ 휴일 추가</button>`;

  document.getElementById("hdfPrev").onclick = () => { holidayDraftYear--; renderHolidayForm(); };
  document.getElementById("hdfNext").onclick = () => { holidayDraftYear++; renderHolidayForm(); };
  document.getElementById("hdfAdd").onclick = () => {
    list.push({ id: uid(), name: "", date: "" });
    renderHolidayForm();
    const inputs = el.querySelectorAll('.hd-holiday-row input[data-field="date"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  };
  const importBtn = document.getElementById("hdfImportMain");
  if (importBtn) importBtn.onclick = () => hdImportMainHolidays(y, list, importBtn);
  el.querySelectorAll(".hd-holiday-row input").forEach(inp => {
    inp.oninput = () => { list[+inp.dataset.idx][inp.dataset.field] = inp.value; };
    inp.onchange = inp.oninput;
  });
  el.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = () => { list.splice(+btn.dataset.del, 1); renderHolidayForm(); };
  });
}

// 업무관리(index.html, ns 없음)에 등록된 해당 연도 휴일을 불러와 없는 날짜만 추가합니다.
// "?ns=" 를 직접 붙여 withNs 가 biz 를 덧붙이지 않도록 합니다. (서버는 빈 ns → 기본 키 사용)
async function hdImportMainHolidays(y, list, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "불러오는 중...";
  try {
    const data = await apiFetchJson("/api/holidays?ns=");
    const src = (data && data.holidays && Array.isArray(data.holidays[y])) ? data.holidays[y] : [];
    if (!src.length) { alert(`업무관리에 ${y}년 휴일이 등록되어 있지 않습니다.`); return; }
    const existing = new Set(list.map(h => h.date));
    let added = 0;
    src.forEach(h => {
      if (h && h.date && !existing.has(h.date)) {
        list.push({ id: uid(), name: h.name || "", date: h.date });
        existing.add(h.date);
        added++;
      }
    });
    list.sort((a, b) => (a.date || "9").localeCompare(b.date || "9"));
    renderHolidayForm();
    alert(added ? `업무관리 ${y}년 휴일 ${added}건을 추가했습니다. 확인 후 저장을 눌러주세요.` : "이미 모두 등록되어 있습니다.");
  } catch (e) {
    alert("업무관리 휴일을 불러오지 못했습니다.\n" + ((e && e.message) || e));
  } finally {
    if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = label; }
  }
}

async function saveHolidaySettings() {
  // 검증 + 연도별 재정리 (날짜의 연도 기준) + 날짜순 정렬
  const next = {};
  for (const y of Object.keys(holidayDraft)) {
    for (const h of holidayDraft[y]) {
      const name = (h.name || "").trim();
      if (!h.date && !name) continue; // 빈 행은 무시
      if (!hdIsValidYmd(h.date)) { holidayDraftYear = +y; renderHolidayForm(); alert(`${y}년: 날짜가 비어 있거나 잘못된 휴일이 있습니다.`); return; }
      if (!name) { holidayDraftYear = +y; renderHolidayForm(); alert(`${h.date}: 휴일명을 입력하세요.`); return; }
      const key = h.date.slice(0, 4);
      (next[key] = next[key] || []).push({ id: h.id || uid(), name, date: h.date });
    }
  }
  Object.keys(next).forEach(y => next[y].sort((a, b) => a.date.localeCompare(b.date)));

  const btn = document.getElementById("btnHolidaySave");
  btn.disabled = true;
  holidayState.holidays = next;
  document.getElementById("holidayModal").style.display = "none";
  holidayDraft = null;
  hdRefreshViews();
  try { await saveHolidayData("holidays"); } catch (e) { /* 상태 표시에 안내 */ }
  finally { btn.disabled = false; }
}
