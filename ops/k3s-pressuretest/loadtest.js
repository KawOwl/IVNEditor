// k6 WebSocket 压测脚本
//
// 用法：
//   BASE_URL=http://your-ecs-ip:30080 SCRIPT_ID=xxx k6 run loadtest.js
//
// 阶梯：50 → 200 → 500 → 800 → 1000，维持 5 分钟，再降到 0
//
// 注意：
//   - BASE_URL 带协议前缀（http 或 https）
//   - SCRIPT_ID 是已发布剧本的 id，需要先在 Langfuse UI 里创建对应 project
//     拿到 key 填进 ivn-backend secret
//   - 压测期间会真实消耗 LLM API 预算，建议先用 Mock 或小剧本试跑

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:30080';
const SCRIPT_ID = __ENV.SCRIPT_ID || '';
const HOST_HEADER = __ENV.HOST_HEADER || 'ivn.local';

export const options = {
  stages: [
    { duration: '1m',  target: 50  },
    { duration: '2m',  target: 200 },
    { duration: '2m',  target: 500 },
    { duration: '2m',  target: 800 },
    { duration: '3m',  target: 1000 },
    { duration: '5m',  target: 1000 }, // 持平观察稳定性
    { duration: '2m',  target: 0    },
  ],
  thresholds: {
    'ws_connect_duration': ['p(95)<5000'],
    'ws_error_rate': ['rate<0.05'],
    'http_req_failed': ['rate<0.02'],
  },
};

const wsConnectDuration = new Trend('ws_connect_duration');
const wsMessagesReceived = new Counter('ws_messages_received');
const narrativeCompleted = new Counter('narrative_completed');
const wsErrorRate = new Rate('ws_error_rate');

function jsonHeaders(token) {
  const h = { 'Content-Type': 'application/json', 'Host': HOST_HEADER };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export default function () {
  // 1. 匿名 session —— 路由以实际为准，这里假设 /api/auth/anonymous
  const authRes = http.post(
    `${BASE_URL}/api/auth/anonymous`,
    null,
    { headers: jsonHeaders() }
  );
  if (!check(authRes, { 'auth ok': (r) => r.status === 200 })) {
    wsErrorRate.add(1);
    return;
  }
  const sessionId = authRes.json('sessionId') || authRes.json('id');
  if (!sessionId) { wsErrorRate.add(1); return; }

  // 2. 创建 playthrough
  const ptRes = http.post(
    `${BASE_URL}/api/playthroughs`,
    JSON.stringify({ scriptId: SCRIPT_ID, kind: 'production' }),
    { headers: jsonHeaders(sessionId) }
  );
  if (!check(ptRes, { 'playthrough ok': (r) => r.status === 200 })) {
    wsErrorRate.add(1);
    console.error('create playthrough failed', ptRes.status, ptRes.body);
    return;
  }
  const playthroughId = ptRes.json('id');
  if (!playthroughId) { wsErrorRate.add(1); return; }

  // 3. WebSocket
  const wsProto = BASE_URL.startsWith('https') ? 'wss' : 'ws';
  const wsHost = BASE_URL.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProto}://${wsHost}/api/sessions/ws?sessionId=${sessionId}&playthroughId=${playthroughId}`;

  const startTime = Date.now();
  let turnsCompleted = 0;

  const res = ws.connect(
    wsUrl,
    { headers: { 'Host': HOST_HEADER } },
    function (socket) {
      wsConnectDuration.add(Date.now() - startTime);

      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'start' }));
      });

      socket.on('message', (data) => {
        wsMessagesReceived.add(1);
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        // 等 AI 问玩家之后，思考 5-15 秒回复
        if (msg.type === 'input-hint' || msg.type === 'input-type') {
          sleep(Math.random() * 10 + 5);
          const inputs = [
            '我走向前方',
            '我仔细观察周围',
            '我试着和她说话',
            '我伸手触碰',
            '我停下来思考',
            '我回头看',
          ];
          const text = inputs[Math.floor(Math.random() * inputs.length)];
          socket.send(JSON.stringify({ type: 'input', text }));
          turnsCompleted++;

          // 玩 3 轮后退出，给其他 VU 让资源
          if (turnsCompleted >= 3) {
            narrativeCompleted.add(1);
            socket.close();
          }
        }

        if (msg.type === 'error') {
          wsErrorRate.add(1);
        }
      });

      socket.on('error', (e) => { wsErrorRate.add(1); console.error('ws error', e.error()); });
      socket.setTimeout(() => socket.close(), 5 * 60 * 1000);
    }
  );

  check(res, { 'ws connected': (r) => r && r.status === 101 });
}
