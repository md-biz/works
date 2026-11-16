// 연결 진단용 엔드포인트.
// 브라우저에서 https://<프로젝트>.vercel.app/api/health 로 직접 열어보세요.
const { withApi } = require("./_cors");
const { isConfigured, getClient, casWrite } = require("./_kv");

// 연결 진단은 로그인 없이도 열 수 있습니다. (데이터는 내려주지 않음)
module.exports = withApi(async (req, res) => {
  const configured = isConfigured();
  const result = {
    ok: true,
    api: "정상 배포됨",
    node: process.version,
    kvEnvDetected: configured,
    envVarsSeen: {
      KV_REST_API_URL: Boolean(process.env.KV_REST_API_URL),
      KV_REST_API_TOKEN: Boolean(process.env.KV_REST_API_TOKEN),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
    }
  };

  if (!configured) {
    result.ok = false;
    result.kv = "미연결";
    result.next = "Vercel 프로젝트 > Storage 에서 KV(Upstash Redis) 생성 후 Connect, 그리고 Redeploy 하세요.";
    return res.status(200).json(result);
  }

  try {
    await getClient().set("__health__", Date.now());
    const v = await getClient().get("__health__");
    result.kv = "읽기/쓰기 정상";
    result.kvValue = v;
    // 동시 저장 보호(버전 확인 저장)가 동작하는지 확인
    const t = await casWrite("__health__:ver", null, [["__health__:cas", Date.now()]]);
    result.safeSave = t.ok && t.atomic ? "동시 저장 보호 정상" : "동시 저장 보호 미동작 (순차 저장으로 대체 중)";
  } catch (e) {
    result.ok = false;
    result.kv = "연결 실패";
    result.kvError = e && e.message ? e.message : String(e);
  }

  return res.status(200).json(result);
}, { public: true });
