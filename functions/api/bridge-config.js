/**
 * CF Pages Function: GET /api/bridge-config
 *
 * 从环境变量返回桥接服务配置，避免在公开的 config.json 中暴露服务器 IP
 *
 * 环境变量（在 CF Dashboard → Pages → Settings → Environment variables 中配置）:
 *   BRIDGE_URL — 国内桥接服务地址，如 http://你的服务器IP:8080
 */
export async function onRequestGet({ env }) {
  return Response.json({
    bridgeUrl: env.BRIDGE_URL || '',
  });
}
