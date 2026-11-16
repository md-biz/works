// 배포 관리 · 블로그 게시 관리 공통 정의 (필드 목록 · 값 정리)
// - 파일명이 "_" 로 시작하므로 Vercel 이 API 주소로 노출하지 않습니다. (서버 함수 개수 증가 없음)
// - 목록 API(bloglist.js, deployments.js)와 행 수정 API(bloglist/[id].js, deployments/[id].js)가 함께 씁니다.

// ---------- 블로그 게시 관리 ----------
// bloglist.html 의 COLUMNS 와 동일한 필드 구성 + 최대 길이 (0 = 제한 없음)
const BLOG_KEY = "bloglist";
const BLOG_FIELDS = {
  blog_date: 10, title: 200, url: 1000, category: 0, biz_category: 0, product: 30, keyword: 500,
  stg_thumb: 20, stg_pub: 20, stg_review: 1000, prod_review: 1000, received_date: 10, open_date: 10, status: 10, note: 1000
};
function blogValue(field, raw) {
  let v = raw != null ? String(raw).trim() : "";
  if (BLOG_FIELDS[field]) v = v.slice(0, BLOG_FIELDS[field]);
  return v === "" ? null : v;
}

// ---------- 배포 관리 ----------
// developlist.html 의 COLUMNS 와 동일한 필드 구성
const DEPLOY_KEY = "deployments";
const DEPLOY_FIELDS = [
  "deploy_date", "deploy_time", "deploy_type", "category", "work_type", "scope", "rms_no",
  "task_name", "file_list",
  "requester", "planner", "publisher", "developer",
  "impact",
  "stg_review_at", "stg_reviewer",
  "prod_review_at", "prod_reviewer",
  "confirm_up"
];
function deployValue(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).slice(0, 5000);
  return v.trim() === "" ? null : v;
}

// 요청 주소의 [id] 값
function rowId(req) {
  let id = req.query ? req.query.id : "";
  if (Array.isArray(id)) id = id[0];
  return String(id || "").trim();
}

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b) || {}; } catch (e) { return {}; } }
  return b;
}

module.exports = { BLOG_KEY, BLOG_FIELDS, blogValue, DEPLOY_KEY, DEPLOY_FIELDS, deployValue, rowId, parseBody };
