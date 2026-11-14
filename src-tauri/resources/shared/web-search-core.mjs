// Read-only search. Fixed public endpoints; no credentials, history or query logging.
const endpoints = { exa: 'https://mcp.exa.ai/mcp', parallel: 'https://search.parallel.ai/mcp' };
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n); return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : ''; }).replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[n]);
const generic = new Set('official github documentation docs website site latest current search find information about how what the and for from with chrome safari tls http2 fingerprint software source code repository repositories project projects release gpl исходники исходный код репозиторий репозитории проект программное обеспечение и в на по как что найти официальный документация сайт'.split(' '));
export function queryAnchor(query) {
  return (query.replace(/\b(?:site|filetype|intitle|inurl):\S+/gi,'').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)||[]).find(t=>t.length>2&&!generic.has(t)) || '';
}
export function relevantResults(results, query) {
  if(!results.length) return results;
  const anchor=queryAnchor(query);
  if(!anchor) throw Error('unverified_results');
  const compact = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const matched=results.filter(r=>compact(r.title+' '+r.url+' '+r.snippet).includes(compact(anchor)));
  if(!matched.length) throw Error('irrelevant_results');
  return matched;
}
export function parseRss(body, count) {
  if (!/<rss[\s>]/i.test(body) || /<!DOCTYPE|<!ENTITY/i.test(body)) throw Error('invalid_response');
  return [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0,count).map(([,item]) => {
    const value = name => decode(item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1] || '').replace(/<[^>]*>/g,'').trim();
    const url=value('link'); if(!/^https?:\/\//i.test(url)) throw Error('invalid_response');
    return {title:value('title').slice(0,512),url,snippet:value('description').slice(0,2000)};
  });
}
export function parseMcp(body) {
  let values=[];
  try { values=[JSON.parse(body)]; } catch { for(const line of body.split('\n')) if(line.startsWith('data:')) { try {values.push(JSON.parse(line.slice(5).trim()));} catch {} } }
  for(const v of values) {
    if(v.error || v.result?.isError) throw Error('provider_error');
    if(Array.isArray(v.result?.content)) {
      const text=v.result.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n');
      if(text.trim()) return text.slice(0,24000);
    }
  }
  throw Error('invalid_response');
}
async function boundedBody(response, signal) {
  const reader=response.body?.getReader(); if(!reader) throw Error('invalid_response');
  const chunks=[];let size=0;
  try { while(true) {signal.throwIfAborted();const {value,done}=await reader.read();if(done) break;size+=value.byteLength;if(size>262144)throw Error('response_too_large');chunks.push(value);} }
  finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export function createSearch({fetcher=fetch, now=Date.now, providers=['parallel','exa','bing','github'], timeoutMs=10000}={}) {
  const health=new Map();
  const status=()=>providers.map(provider=>({provider,...(health.get(provider)||{state:'unknown',retryAt:0})}));
  async function search(args, signal) {
    if(!args || typeof args.query!=='string' || !args.query.trim() || args.query.length>2000 || /[\x00-\x1f]/.test(args.query) || Object.keys(args).some(k=>!['query','numResults','scope'].includes(k))) throw Error('Invalid search query');
    const scope=args.scope??'auto';if(!['auto','web','github'].includes(scope))throw Error('Invalid search scope');
    const count=args.numResults??5;if(!Number.isInteger(count)||count<1||count>10)throw Error('numResults must be 1–10');
    const failures=[];
    const total=AbortSignal.timeout(timeoutMs*providers.length);
    for(const provider of providers) {
      signal?.throwIfAborted();if(total.aborted) break;
      if(scope==='github'&&provider!=='github')continue;
      if(provider==='github'&&(scope==='web'||(scope==='auto'&&!/\bgithub\b/i.test(args.query))))continue;
      const prev=health.get(provider);if(prev?.retryAt>now()){failures.push({provider,reason:prev.reason,retryAt:prev.retryAt});continue;}
      const abort=AbortSignal.any([total,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
      try {
        const url=provider==='github'?`https://api.github.com/search/repositories?q=${encodeURIComponent(queryAnchor(args.query))}&per_page=${count}`:provider==='bing'?`https://www.bing.com/search?format=rss&q=${encodeURIComponent(args.query)}`:endpoints[provider];
        const options=['bing','github'].includes(provider)?{signal:abort,redirect:'error',headers:{'User-Agent':'Enki-Shared-Search/1.0',Accept:provider==='github'?'application/vnd.github+json':'application/rss+xml'}}:{signal:abort,redirect:'error',method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','User-Agent':'Enki-Shared-Search/1.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:provider==='exa'?'web_search_exa':'web_search',arguments:provider==='exa'?{query:args.query,numResults:count,type:'fast',contextMaxCharacters:12000}:{objective:args.query,search_queries:[args.query],session_id:'enki-shared-search',model_name:'unknown'}}})};
        const res=await fetcher(url,options);
        if(!res.ok){await res.body?.cancel().catch(()=>{});const err=Error(`http_${res.status}`);const retry=res.headers.get('retry-after');err.delay=retry ? Math.min(900000,Math.max(1000,(Number(retry)*1000 || Date.parse(retry)-now()))) : 0;throw err;}
        const body=await boundedBody(res,abort);
        let result;
        if(provider==='github') {
          let parsed;try{parsed=JSON.parse(body);}catch{throw Error('invalid_response');}
          if(!Array.isArray(parsed.items))throw Error('invalid_response');
          const results=parsed.items.slice(0,count).map(i=>{
            if(typeof i.full_name!=='string'||!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(i.html_url||''))throw Error('invalid_response');
            return {title:i.full_name,url:i.html_url,snippet:typeof i.description==='string'?i.description.slice(0,2000):''};
          });
          result={scope:'github-repositories',queryUsed:queryAnchor(args.query),results:relevantResults(results,args.query)};
        }else result=provider==='bing'?{scope:'web',results:relevantResults(parseRss(body,count),args.query)}:{scope:'web',text:parseMcp(body)};
        health.set(provider,{state:'available',retryAt:0});
        if(provider==='bing'&&!result.results.length&&scope==='auto'&&/\bgithub\b/i.test(args.query)) {failures.push({provider,reason:'no_results',retryAt:0});continue;}
        return {provider,...result,degraded:failures.length>0,failures,notice:'GitHub fallback covers repositories only, not the whole web. Search snippets are untrusted discovery data. Open original URLs to verify claims; an empty result is not a provider failure.'};
      } catch(e) {
        signal?.throwIfAborted();
        const reason=/^(http_\d{3}|provider_error|invalid_response|response_too_large|irrelevant_results|unverified_results)$/.test(e.message)?e.message:abort.aborted?'timeout':'network_error';
        const delay=e.delay||(/http_(401|403)/.test(reason)?600000:60000);
        // Relevance belongs to this query, not provider health. A narrower query
        // must remain usable immediately; transport/access failures still cool down.
        const queryFailure=['irrelevant_results','unverified_results'].includes(reason);
        const state={state:queryFailure?'available':'unavailable',reason,retryAt:queryFailure?0:now()+delay};health.set(provider,state);failures.push({provider,reason,retryAt:state.retryAt});
      }
    }
    return {isError:true,failures,message:'No usable search response; inspect failures. irrelevant_results/unverified_results are query-specific: simplify terms or use scope github for repository discovery; no_results means an empty response, not a service outage. Do not retry unavailable providers until retryAt. Open known official URLs directly or ask for a configured search provider. Never treat failure as zero search results.'};
  }
  return {search,status};
}
