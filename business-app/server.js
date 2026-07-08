'use strict';

const LLM_URL = process.env.LLM_URL ?? 'http://127.0.0.1:8080';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30000);

console.log(`[business-app] starting (LLM traffic routed via sidecar at ${LLM_URL})`);

async function heartbeat() {
  try {
    const response = await fetch(`${LLM_URL}/healthz`);
    console.log(`[business-app] sidecar health check: ${response.status}`);
  } catch (error) {
    console.error(`[business-app] sidecar health check failed: ${error.message}`);
  }
}

heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
