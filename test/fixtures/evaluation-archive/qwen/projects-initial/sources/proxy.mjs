import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// The real credential never enters an agent's environment/config/argv or report.
// Paired agents pass through the same model/effort/output/budget policy.
export function providerPolicy(provider = 'deepseek', baseUrl, effort = 'medium') {
  if (!['off', 'medium'].includes(effort)) throw Error('Unsupported evaluation effort');
  if (provider === 'deepseek') {
    if (baseUrl) throw Error('DeepSeek endpoint cannot be overridden');
    return { endpoint: 'https://api.deepseek.com/chat/completions', effectiveEffort: effort === 'off' ? 'off' : 'high', timeoutMs: 90000 };
  }
  if (provider !== 'local-qwen') throw Error('Unsupported evaluation provider');
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1') throw Error('Local Qwen requires a credential-free loopback /v1 endpoint');
  return { endpoint: `${url.href}/chat/completions`, effectiveEffort: effort, timeoutMs: 240000 };
}

export async function startProxy({ key, model, effort, budget, limits, provider = 'deepseek', baseUrl }) {
  const policy = providerPolicy(provider, baseUrl, effort);
  const token = randomUUID();
  const usage = { requests: 0, input: 0, output: 0, cachedInput: 0, responsesWithUsage: 0, rejected: 0, errors: 0, modelMismatch: false, servedModels: [], timings:[], effectiveEffort: policy.effectiveEffort };
  const controllers = new Set();
  let tail = Promise.resolve();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] })); return; }
    if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    // Serialize internal title/answer requests too: admission sees completed
    // usage, so only one provider response can cross a token ceiling.
    const previous = tail; let release;
    tail = new Promise(resolve => { release = resolve; });
    res.on('close', () => controller.abort());
    await previous;
    let charged = false, timing=null;
    // A local exhausted budget is permanent. 429 would make some engines back off
    // and retry until the trial deadline, even though no further request is admissible.
    const reject = message => { usage.rejected++; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'eval_budget' } })); };
    try {
      if (controller.signal.aborted || req.aborted || res.destroyed) return;
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 512 * 1024) throw Error('REQUEST_TOO_LARGE'); }
      const body = JSON.parse(raw);
      // Conservative admission in bytes; completion limit is enforced at the provider.
      // Exact tokens are known only after a response: at most ONE admitted response can overshoot.
      if (usage.requests >= limits.requests || budget.requests >= limits.totalRequests ||
          usage.input + usage.output >= limits.tokens || budget.input + budget.output >= limits.totalTokens ||
          Buffer.byteLength(raw) > limits.requestBytes) { reject('Evaluation resource limit reached'); return; }
      usage.requests++; budget.requests++;
      timing={started:performance.now(),firstResponseMs:null,elapsedMs:null};
      body.model = model; body.max_tokens = limits.outputTokens;
      delete body.max_completion_tokens;
      if (provider === 'deepseek') {
        body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' };
        body.reasoning_effort = 'high';
      } else {
        delete body.thinking;
        body.reasoning_effort = effort;
        body.chat_template_kwargs = { enable_thinking: effort !== 'off', preserve_thinking: true };
        body.temperature = 1; body.top_p = 0.95; body.top_k = 20;
        body.min_p = 0; body.repetition_penalty = 1; body.presence_penalty = 0;
      }
      if (body.stream) body.stream_options = { include_usage: true };
      const upstream = await fetch(policy.endpoint, {
        method: 'POST', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(policy.timeoutMs)]),
      });
      if (!upstream.ok) { usage.errors++; res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Provider HTTP ${upstream.status}`, type: 'provider_error' } })); return; }
      res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
      const charge = data => {
        if(timing.firstResponseMs==null && data?.choices?.some(c=>[c.delta?.content,c.delta?.reasoning_content,c.message?.content,c.message?.reasoning_content].some(v=>typeof v==='string'&&v.length>0)||c.delta?.tool_calls?.length||c.message?.tool_calls?.length)) timing.firstResponseMs=performance.now()-timing.started;
        if (typeof data?.model === 'string' && !usage.servedModels.includes(data.model)) usage.servedModels.push(data.model);
        if (provider === 'local-qwen' && typeof data?.model === 'string' && data.model !== model && !usage.modelMismatch) { usage.modelMismatch = true; usage.errors++; }
        if (!data?.usage || charged) return;
        const u = data.usage;
        if (![u.prompt_tokens, u.completion_tokens].every(x => Number.isFinite(x) && x >= 0)) return;
        charged = true; usage.responsesWithUsage++;
        usage.input += u.prompt_tokens; usage.output += u.completion_tokens;
        usage.cachedInput += u.prompt_cache_hit_tokens || 0;
        budget.input += u.prompt_tokens; budget.output += u.completion_tokens;
      };
      // Preserve streaming bytes, parse usage separately with proper UTF-8 chunk boundaries.
      let buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        if (res.destroyed) { controller.abort(); break; }
        res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
        if (body.stream) {
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (line.startsWith('data:') && !line.includes('[DONE]')) { try { charge(JSON.parse(line.slice(5))); } catch { /* not a JSON data event */ } }
          }
        } else if (buffer.length > 2 * 1024 * 1024) throw Error('RESPONSE_TOO_LARGE');
      }
      if (!body.stream) { try { charge(JSON.parse(buffer)); } catch { /* unavailable usage remains explicit */ } }
      res.end();
    } catch { usage.errors++; if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Evaluation upstream interrupted', type: 'eval_transport' } })); }
    finally { if(timing){usage.timings.push({firstResponseMs:timing.firstResponseMs,elapsedMs:performance.now()-timing.started});}controllers.delete(controller); release(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, token, usage,
    async close() { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
