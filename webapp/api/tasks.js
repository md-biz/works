const { withApi } = require("./_cors");
const { getClient, getJSON, setJSON, casWrite } = require("./_kv");
const { resolveNs } = require("./_ns");
const { randomUUID } = require("crypto");
const detail = require("./_detail");

module.exports = withApi(async (req, res) => {
  // ?ns=biz 가 있으면 저장 키 앞에 "biz:" 를 붙여 index_biz.html 데이터를 분리합니다.
  const ns = resolveNs(req);
  if (!ns.ok) return res.status(400).json({ error: ns.error });
  // ?ns=detail (업무상세내역): 사용자별 저장 · 관리자 전체 조회/탭 삭제 → _detail.js
  if (detail.isDetail(ns)) return detail.handleDetailTasks(req, res);

  // 월별 저장 버전 — 저장할 때마다 1씩 올라갑니다.
  // 화면이 불러온 버전과 서버 버전이 다르면(그사이 누가 저장함) 덮어쓰지 않고 409로 최신 목록을 돌려줍니다.
  const verKey = (month) => ns.key(`tasks:${month}:ver`);
  const getVer = async (month) => Number(await getJSON(verKey(month), 0)) || 0;

  // 버전과 업무 목록을 KV 명령 한 번(MGET)으로 함께 읽습니다.
  // - 한 번에 읽으므로 왕복 시간이 줄고, 읽는 사이 다른 저장이 끼어들어 "예전 목록 + 새 버전"이 나가는 일도 없습니다.
  // - MGET이 실패하면 예전 방식(버전 먼저 → 목록)으로 읽습니다.
  const readMonth = async (month) => {
    try {
      const [v, list] = await getClient().mget(verKey(month), ns.key(`tasks:${month}`));
      return { version: Number(v) || 0, tasks: Array.isArray(list) ? list : [] };
    } catch (e) {
      console.error("[tasks] mget 실패 — 순차 읽기로 대체", e && e.message);
      const version = await getVer(month);
      const tasks = await getJSON(ns.key(`tasks:${month}`), []);
      return { version, tasks };
    }
  };

  if (req.method === "GET") {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: "month 쿼리 파라미터가 필요합니다." });
    const { version, tasks } = await readMonth(month);
    return res.status(200).json({ tasks, version });
  }

  if (req.method === "POST") {
    const { month, task } = req.body || {};
    if (!month || !task) return res.status(400).json({ error: "month, task 값이 필요합니다." });
    const tasks = await getJSON(ns.key(`tasks:${month}`), []);
    const newTask = { ...task, id: task.id || randomUUID() };
    tasks.push(newTask);
    await setJSON(ns.key(`tasks:${month}`), tasks);
    const version = (await getVer(month)) + 1;
    await setJSON(verKey(month), version);
    return res.status(201).json({ task: newTask, version });
  }

  if (req.method === "PUT") {
    // 월 전체 목록 저장
    // - 일반 저장: baseVersion(화면이 불러온 버전)을 함께 보내야 하며, 서버 버전과 다르면 409
    // - force: true — 새 월 이월 복사, 연결 확인 테스트처럼 덮어써도 되는 경우만 사용
    const { month, tasks, baseVersion, force } = req.body || {};
    if (!month || !Array.isArray(tasks)) return res.status(400).json({ error: "month, tasks 배열이 필요합니다." });
    const conflict = async (error) => res.status(409).json({ error, conflict: true, ...(await readMonth(month)) });

    if (!force && (baseVersion === undefined || baseVersion === null)) {
      // 예전 app.js(버전 정보 없이 월 전체를 덮어쓰던 화면)가 다른 사람 수정분을 지우지 않도록 막습니다.
      return conflict("화면이 예전 버전입니다. 새로고침(Ctrl+F5) 후 다시 입력해 주세요.");
    }

    // 버전 확인과 저장을 한 번에 처리 — 두 사람이 같은 순간에 저장해도 한 명만 통과하고,
    // 다른 한 명은 409로 최신 목록을 받아 화면에서 합친 뒤 다시 저장합니다.
    let addedIds = false;
    const withIds = tasks.map(t => {
      if (t.id) return t;
      addedIds = true;
      return { ...t, id: randomUUID() };
    });
    const r = await casWrite(verKey(month), force ? null : Number(baseVersion), [[ns.key(`tasks:${month}`), withIds]]);
    if (!r.ok) return conflict("다른 화면에서 먼저 저장된 내용이 있습니다.");
    // 응답 크기 줄이기: 화면이 보낸 목록 그대로 저장됐으면 버전만 돌려줍니다.
    // (id를 새로 붙인 경우에만 목록을 돌려줌 — 화면은 tasks가 없으면 보낸 목록을 그대로 기준으로 씀)
    return res.status(200).json(addedIds ? { tasks: withIds, version: r.version } : { ok: true, version: r.version });
  }

  return res.status(405).json({ error: "지원하지 않는 메서드입니다." });
});
