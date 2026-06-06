/**
 * CF Pages Function: /api/health
 * 健康检查端点，前端轮询确认桥接服务可用
 */
export async function onRequestGet() {
  return Response.json({ code: 200, msg: 'ok', data: { bridge: 'cloudflare' } });
}
