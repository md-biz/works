// Vercel KV / Upstash Redis 접근 래퍼.
//
// 연결 방식에 따라 주입되는 환경변수 이름이 다릅니다.
//  - Vercel KV            : KV_REST_API_URL / KV_REST_API_TOKEN
//  - Upstash(마켓플레이스) : UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// 둘 중 있는 쪽을 자동으로 사용합니다.
//
// 또한 import 시점에 예외가 터지면 함수 자체가 죽어 CORS 헤더 없이 실패하므로
// (브라우저에는 "Failed to fetch"로만 보임) 클라이언트 생성은 지연 처리합니다.

const { createClient } = require("@vercel/kv");

let client = null;

function resolveConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

function getClient() {
  if (client) return client;
  const { url, token } = resolveConfig();
  if (!url || !token) {
    throw new Error(
      "KV 환경변수가 없습니다. Vercel 프로젝트 > Storage 에서 KV(Upstash Redis)를 만들고 Connect 한 뒤 Redeploy 하세요. " +
      "(필요 변수: KV_REST_API_URL / KV_REST_API_TOKEN)"
    );
  }
  client = createClient({ url, token });
  return client;
}

function isConfigured() {
  const { url, token } = resolveConfig();
  return Boolean(url && token);
}

async function getJSON(key, fallback) {
  const v = await getClient().get(key);
  return v === null || v === undefined ? fallback : v;
}

async function setJSON(key, value) {
  await getClient().set(key, value);
}

// ---------------- 버전 확인 저장 (여러 사람이 동시에 저장할 때) ----------------
// "버전이 내가 불러온 것과 같을 때만 저장하고 버전을 1 올린다"를 Redis 안에서 한 번에(원자적으로) 처리합니다.
// 예전에는 [버전 읽기 → 데이터 쓰기 → 버전 쓰기]를 따로 했기 때문에, 두 사람이 거의 같은 순간에 저장하면
// 둘 다 통과해 한 사람의 저장이 조용히 사라질 수 있었습니다.
//
//   casWrite(verKey, baseVersion, [[key, value], ...])
//     baseVersion: 화면이 불러온 버전(숫자). null 이면 확인 없이 저장(force)
//     → { ok: true, version }   저장됨 (새 버전)
//     → { ok: false, version }  그사이 다른 저장이 있었음 (현재 버전) — 아무것도 저장하지 않음
const CAS_SCRIPT = [
  "local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0",
  "if ARGV[1] ~= 'force' and tonumber(ARGV[1]) ~= cur then return {0, cur} end",
  "for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[i]) end",
  "local nv = cur + 1",
  "redis.call('SET', KEYS[1], tostring(nv))",
  "return {1, nv}"
].join("\n");

async function casWrite(verKey, baseVersion, writes) {
  const force = baseVersion === null || baseVersion === undefined;
  const c = getClient();
  try {
    const keys = [verKey, ...writes.map((w) => w[0])];
    // 값은 @vercel/kv 의 set() 과 같은 형식(JSON 문자열)으로 저장합니다.
    const args = [force ? "force" : String(Number(baseVersion)), ...writes.map((w) => JSON.stringify(w[1]))];
    const r = await c.eval(CAS_SCRIPT, keys, args);
    if (Array.isArray(r) && r.length === 2) return { ok: Number(r[0]) === 1, version: Number(r[1]) || 0, atomic: true };
    throw new Error("eval 응답 형식이 예상과 다릅니다: " + JSON.stringify(r));
  } catch (err) {
    // 저장소가 스크립트 실행을 지원하지 않는 등 예외 상황에서는 예전 방식(순차 처리)으로 저장합니다.
    console.error("[casWrite] 원자적 저장 실패 — 순차 저장으로 대체", err && err.message);
    const cur = Number(await getJSON(verKey, 0)) || 0;
    if (!force && Number(baseVersion) !== cur) return { ok: false, version: cur, atomic: false };
    for (const [key, value] of writes) await c.set(key, value);
    await c.set(verKey, cur + 1);
    return { ok: true, version: cur + 1, atomic: false };
  }
}

// ---------------- 목록 안전 수정 (배포 관리 · 블로그 게시 관리) ----------------
// 목록 전체가 한 키에 저장되어 있어, 예전에는 [목록 읽기 → 한 행 고치기 → 목록 전체 쓰기] 사이에
// 다른 사람의 저장이 끼어들면 그 저장이 조용히 사라졌습니다. (서로 다른 행을 고쳐도 발생)
// updateList 는 "읽은 뒤로 아무도 저장하지 않았을 때만" 쓰고, 누가 먼저 저장했으면 최신 목록을 다시 읽어
// 같은 수정을 다시 적용합니다. → 두 사람의 수정이 모두 남습니다.
//
//   const out = await updateList("bloglist", (rows) => { ...; return { rows: 새목록, result: 응답에쓸값 }; });
//   fn 이 { skip: true, result } 를 돌려주면 저장하지 않습니다. (바꿀 것이 없을 때)
async function updateList(key, fn) {
  const verKey = `${key}:ver`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const version = Number(await getJSON(verKey, 0)) || 0; // 버전을 먼저 읽습니다
    const current = await getJSON(key, []);
    const out = await fn(Array.isArray(current) ? current : []);
    if (out.skip) return out.result;
    const r = await casWrite(verKey, version, [[key, out.rows]]);
    if (r.ok) return out.result;
    await new Promise((res) => setTimeout(res, 15 + Math.random() * 40 * (attempt + 1)));
  }
  const err = new Error("저장이 계속 겹칩니다. 잠시 후 다시 시도해 주세요.");
  err.statusCode = 503;
  throw err;
}

module.exports = { getClient, isConfigured, getJSON, setJSON, casWrite, updateList };
