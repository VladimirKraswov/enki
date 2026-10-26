// Minimal stdio MCP adapter over the shared, scoped evaluation tools.
import { createInterface } from 'node:readline';
import { tools } from './backend.mjs';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    if (!Object.hasOwn(request, 'id')) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'arvela-eval', version: '1.0.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: tools.filter(t=>t.name!=='check'||process.env.ARVELA_EVAL_CATEGORY==='project').filter(t => t.name !== 'memory_search' || process.env.ARVELA_EVAL_MEMORY === 'tools').filter(t => process.env.ARVELA_EVAL_CATEGORY === 'browser' ? t.name.startsWith('browser_') : !t.name.startsWith('browser_')) };
    else if (request.method === 'tools/call') {
      const response = await fetch(`${process.env.ARVELA_EVAL_URL}/tool`, {
        method: 'POST', headers: { authorization: `Bearer ${process.env.ARVELA_EVAL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: request.params.name, args: request.params.arguments }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error('EVAL_TRANSPORT_FAILURE');
      const body = await response.json();
      const value = body.error ?? body.result;
      result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: !!body.error };
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Evaluation transport failed' } }) + '\n'); }
}
