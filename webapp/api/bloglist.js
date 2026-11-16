// 블로그 게시 관리(bloglist.html) 목록 API
//   GET    /api/bloglist                              → { items: [...] }  (최신순)
//   POST   /api/bloglist   body {}                    → { item: {...} }   (빈 행 1건 추가)
//   POST   /api/bloglist   body { rows:[...], replace } → { items: [...] } (CSV 일괄 등록, 배열 순서대로 맨 위)
//   DELETE /api/bloglist   body { ids: [...] }        → { deleted: n }
// 개별 행 수정은 api/bloglist/[id].js (PATCH) 가 담당합니다.
// 추가·삭제·수정은 모두 updateList 로 처리해, 여러 사람이 같은 순간에 저장해도 서로 덮어쓰지 않습니다.

const { withApi } = require("./_cors");
const { getJSON, updateList } = require("./_kv");
const { BLOG_KEY: KEY, BLOG_FIELDS: FIELDS, blogValue, parseBody } = require("./_lists");
const { randomUUID } = require("crypto");

function clean(src) {
  const out = {};
  Object.keys(FIELDS).forEach(f => { out[f] = blogValue(f, src ? src[f] : null); });
  return out;
}

function newRow(src, createdAt) {
  return { id: randomUUID(), created_at: createdAt || new Date().toISOString(), ...clean(src) };
}

module.exports = withApi(async (req, res) => {
  if (req.method === "GET") {
    const rows = await getJSON(KEY, []);
    const sorted = [...rows].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return res.status(200).json({ items: sorted });
  }

  if (req.method === "POST") {
    const body = parseBody(req);

    if (Array.isArray(body.rows)) {
      if (body.rows.length > 5000) return res.status(400).json({ error: "한 번에 최대 5000건까지 등록할 수 있습니다." });
      const base = Date.now();
      const n = body.rows.length;
      // 첫 번째 행이 가장 최신(맨 위)이 되도록 created_at 부여
      const made = body.rows.map((r, i) => newRow(r, new Date(base + (n - i)).toISOString()));
      await updateList(KEY, (rows) => ({ rows: body.replace ? made : rows.concat(made) }));
      return res.status(201).json({ items: made });
    }

    const row = newRow(body);
    await updateList(KEY, (rows) => ({ rows: rows.concat([row]) }));
    return res.status(201).json({ item: row });
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
