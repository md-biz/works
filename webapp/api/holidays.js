// 휴일 관리 API
//  GET  /api/holidays          → { holidays: { "2026": [{id,name,date}] }, leaves: [{id,start,end,type,assignee,role,hours,days}] }
//  GET 응답에는 version(저장할 때마다 1씩 증가)이 함께 내려갑니다.
//  PUT  /api/holidays          → body { holidays?, leaves?, baseVersion } (보낸 항목만 저장)
//       baseVersion(화면이 불러온 버전)이 서버 버전과 다르면 저장하지 않고 409 로 최신 데이터를 돌려줍니다.
//       → 화면(holiday.js)이 최신 데이터에 자기 변경분만 합쳐서 다시 저장합니다.
//  ?ns=biz 가 있으면 저장 키 앞에 "biz:" 를 붙여 데이터를 분리합니다.
const { withApi } = require("./_cors");
const { getJSON, casWrite } = require("./_kv");

const NS_PATTERN = /^[a-z0-9_-]{1,20}$/i;

function resolveKey(req) {
  let raw = req.query ? req.query.ns : "";
  if (Array.isArray(raw)) raw = raw[0];
  const ns = String(raw || "").trim();
  if (!ns) return { ok: true, key: (name) => name };
  if (!NS_PATTERN.test(ns)) return { ok: false, error: "ns 값은 영문·숫자·-·_ 20자 이내만 사용할 수 있습니다." };
  return { ok: true, key: (name) => `${ns}:${name}` };
}

module.exports = withApi(async (req, res) => {
  const ns = resolveKey(req);
  if (!ns.ok) return res.status(400).json({ error: ns.error });

  const verKey = ns.key("holidays:ver");
  // 버전을 먼저 읽습니다. (읽는 사이 다른 저장이 끼어들어도 "예전 데이터 + 새 버전" 조합이 나가지 않도록)
  const readAll = async () => {
    const version = Number(await getJSON(verKey, 0)) || 0;
    return {
      holidays: await getJSON(ns.key("holidays"), {}),
      leaves: await getJSON(ns.key("leaves"), []),
      version
    };
  };

  if (req.method === "GET") {
    return res.status(200).json(await readAll());
  }

  if (req.method === "PUT") {
    const { holidays, leaves, baseVersion, force } = req.body || {};
    if (holidays === undefined && leaves === undefined) {
      return res.status(400).json({ error: "holidays 또는 leaves 값이 필요합니다." });
    }
    const writes = [];
    if (holidays !== undefined) {
      if (!holidays || typeof holidays !== "object" || Array.isArray(holidays)) {
        return res.status(400).json({ error: "holidays 는 연도별 객체여야 합니다." });
      }
      writes.push([ns.key("holidays"), holidays]);
    }
    if (leaves !== undefined) {
      if (!Array.isArray(leaves)) return res.status(400).json({ error: "leaves 는 배열이어야 합니다." });
      writes.push([ns.key("leaves"), leaves]);
    }

    if (!force && (baseVersion === undefined || baseVersion === null)) {
      // 예전 holiday.js(목록 전체를 그대로 덮어쓰던 화면)가 다른 사람이 등록한 휴가를 지우지 않도록 막습니다.
      return res.status(409).json({
        error: "화면이 예전 버전입니다. 새로고침(Ctrl+F5) 후 다시 등록해 주세요.", conflict: true, ...(await readAll())
      });
    }
    const r = await casWrite(verKey, force ? null : Number(baseVersion), writes);
    if (!r.ok) {
      return res.status(409).json({ error: "다른 화면에서 먼저 저장된 내용이 있습니다.", conflict: true, ...(await readAll()) });
    }
    return res.status(200).json({ ok: true, version: r.version });
  }

  return res.status(405).json({ error: "지원하지 않는 메서드입니다." });
});
