const { withApi } = require("./_cors");
const { getJSON, setJSON } = require("./_kv");
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

  if (req.method === "GET") {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: "month 쿼리 파라미터가 필요합니다." });
    const tasks = await getJSON(ns.key(`tasks:${month}`), []);
    const version = await getVer(month);
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
    const current = await getVer(month);

    if (!force) {
      if (baseVersion === undefined || baseVersion === null) {
        // 예전 app.js(버전 정보 없이 월 전체를 덮어쓰던 화면)가 다른 사람 수정분을 지우지 않도록 막습니다.
        return res.status(409).json({
          error: "화면이 예전 버전입니다. 새로고침(Ctrl+F5) 후 다시 입력해 주세요.",
          conflict: true, version: current, tasks: await getJSON(ns.key(`tasks:${month}`), [])
        });
      }
      if (Number(baseVersion) !== current) {
        return res.status(409).json({
          error: "다른 화면에서 먼저 저장된 내용이 있습니다.",
          conflict: true, version: current, tasks: await getJSON(ns.key(`tasks:${month}`), [])
        });
      }
    }

    const withIds = tasks.map(t => ({ ...t, id: t.id || randomUUID() }));
    await setJSON(ns.key(`tasks:${month}`), withIds);
    const version = current + 1;
    await setJSON(verKey(month), version);
    return res.status(200).json({ tasks: withIds, version });
  }

  return res.status(405).json({ error: "지원하지 않는 메서드입니다." });
});
