// 배포 관리(developlist.html) 목록 API
//   GET    /api/deployments            → { deployments: [...] }  (최신순)
//   POST   /api/deployments   body {}  → { deployment: {...} }   (빈 행 1건 추가)
//   DELETE /api/deployments   body { ids: [...] } → { deleted: n }
// 개별 행 수정은 api/deployments/[id].js (PATCH) 가 담당합니다.
// 추가·삭제·수정은 모두 updateList 로 처리해, 여러 사람이 같은 순간에 저장해도 서로 덮어쓰지 않습니다.

const { withApi } = require("./_cors");
const { getJSON, updateList } = require("./_kv");
const { DEPLOY_KEY: KEY, DEPLOY_FIELDS: FIELDS, parseBody } = require("./_lists");
const { randomUUID } = require("crypto");

function blankRow() {
  const row = { id: randomUUID(), created_at: new Date().toISOString() };
  FIELDS.forEach(f => { row[f] = null; });
  return row;
}

module.exports = withApi(async (req, res) => {
  if (req.method === "GET") {
    const rows = await getJSON(KEY, []);
    // 최신 등록순 (페이지가 created_at 내림차순을 기대합니다)
    const sorted = [...rows].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return res.status(200).json({ deployments: sorted });
  }

  if (req.method === "POST") {
    const row = blankRow();
    await updateList(KEY, (rows) => ({ rows: rows.concat([row]) }));
    return res.status(201).json({ deployment: row });
  }

  if (req.method === "DELETE") {
    const { ids } = parseBody(req);
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids 배열이 필요합니다." });
    const deleted = await updateList(KEY, (rows) => {
      const next = rows.filter(r => !ids.includes(r.id));
      const n = rows.length - next.length;
      return n ? { rows: next, result: n } : { skip: true, result: 0 };
    });
    return res.status(200).json({ deleted });
  }

  return res.status(405).json({ error: "지원하지 않는 메서드입니다." });
});
