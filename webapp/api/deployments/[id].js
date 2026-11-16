// 배포 관리(developlist.html) 행 수정 API
//   PATCH  /api/deployments/<id>   body { 필드: 값, ... }  → { deployment: {...} }
//   DELETE /api/deployments/<id>                           → { deleted: 0|1 }
// 보낸 필드만 바꿉니다. 같은 순간에 다른 사람이 다른 행(또는 같은 행의 다른 칸)을 저장해도 서로 덮어쓰지 않습니다.

const { withApi } = require("../_cors");
const { updateList } = require("../_kv");
const { DEPLOY_KEY: KEY, DEPLOY_FIELDS: FIELDS, deployValue, rowId, parseBody } = require("../_lists");

module.exports = withApi(async (req, res) => {
  const id = rowId(req);
  if (!id) return res.status(400).json({ error: "id 값이 필요합니다." });

  if (req.method === "PATCH" || req.method === "PUT") {
    const body = parseBody(req);
    const patch = {};
    FIELDS.forEach((f) => { if (body[f] !== undefined) patch[f] = deployValue(body[f]); });
    if (!Object.keys(patch).length) return res.status(400).json({ error: "수정할 항목이 없습니다." });

    const deployment = await updateList(KEY, (rows) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return { skip: true, result: null };
      const next = rows.slice();
      next[i] = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
      return { rows: next, result: next[i] };
    });
    if (!deployment) return res.status(404).json({ error: "행을 찾을 수 없습니다. 다른 사용자가 삭제했을 수 있습니다." });
    return res.status(200).json({ deployment });
  }

  if (req.method === "DELETE") {
    const deleted = await updateList(KEY, (rows) => {
      const next = rows.filter((r) => r.id !== id);
      return next.length === rows.length ? { skip: true, result: 0 } : { rows: next, result: 1 };
    });
    return res.status(200).json({ deleted });
  }

  return res.status(405).json({ error: "지원하지 않는 메서드입니다." });
});
