import {describe,it,expect} from 'vitest';
// @ts-expect-error App-owned Node module is exercised directly.
import {createSearch,parseMcp,parseRss} from '../src-tauri/resources/shared/web-search-core.mjs';
const rss='<rss><channel><item><title>Node &amp; JS</title><link>https://nodejs.org/</link><description>Docs</description></item></channel></rss>';
describe('shared resilient search',()=>{
 it('falls back on403 and skips denied services during cooldown',async()=>{
  const calls:string[]=[];let time=1000;
  const s=createSearch({now:()=>time,fetcher:async(url:string)=>{calls.push(url);return url.includes('bing')?new Response(rss):new Response('Denied',{status:403});}});
  const a=await s.search({query:'Node documentation'});expect(a.provider).toBe('bing');expect(a.failures).toHaveLength(2);expect(a.results[0].url).toBe('https://nodejs.org/');
  await s.search({query:'Node documentation'});expect(calls).toHaveLength(4);
  time+=600001;await s.search({query:'Node documentation'});expect(calls).toHaveLength(7);
 });
 it('honors rate limit and exposes explicit all-provider failure',async()=>{
  let count=0;const s=createSearch({providers:['exa'],now:()=>1000,fetcher:async()=>{count++;return new Response('',{status:429,headers:{'Retry-After':'120'}});}});
  expect((await s.search({query:'test'})).isError).toBe(true);expect(s.status()[0].retryAt).toBe(121000);
  await s.search({query:'different'});expect(count).toBe(1);
 });
 it('does not fall back after user cancellation',async()=>{
  const c=new AbortController();let count=0;const s=createSearch({fetcher:async()=>{count++;c.abort();throw Error('network');}});
  await expect(s.search({query:'test'},c.signal)).rejects.toThrow();expect(count).toBe(1);
 });
 it('rejects MCP errors, HTML challenges, XML entities and unsafe links',()=>{
  expect(()=>parseMcp('{"result":{"isError":true,"content":[{"type":"text","text":"error"}]}}')).toThrow();
  expect(()=>parseRss('<html>captcha</html>',5)).toThrow();expect(()=>parseRss('<!DOCTYPE rss>'+rss,5)).toThrow();
  expect(()=>parseRss(rss.replace('https://nodejs.org/','javascript:alert(1)'),5)).toThrow();
 });
 it('parses SSE and treats valid empty results as success',async()=>{
  expect(parseMcp('data: {"result":{"content":[{"type":"text","text":"verified"}]}}\n\n')).toBe('verified');
  const s=createSearch({providers:['bing'],fetcher:async()=>new Response('<rss><channel></channel></rss>')});expect((await s.search({query:'rare'})).results).toEqual([]);
 });
 it('falls back on a bounded timeout and HTTP200 MCP error',async()=>{
  const s=createSearch({timeoutMs:20,fetcher:async(url:string,options:{signal:AbortSignal})=>{
   if(url.includes('parallel')) return await new Promise<Response>((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
   if(url.includes('exa')) return new Response('{"result":{"isError":true,"content":[]}}');
   return new Response(rss);
  }});
  const result=await s.search({query:'Node.js documentation'});expect(result.provider).toBe('bing');expect(result.failures.map((f:{reason:string})=>f.reason)).toEqual(['timeout','provider_error']);
 });
 it('rejects irrelevant RSS rather than claiming success',async()=>{
  const s=createSearch({providers:['bing'],fetcher:async()=>new Response(rss)});
  const result=await s.search({query:'curl-impersonate official documentation'});expect(result.isError).toBe(true);expect(result.failures[0].reason).toBe('irrelevant_results');
 });
 it('a query-specific relevance miss does not disable the provider for a better query',async()=>{
  let calls=0;
  const s=createSearch({providers:['bing'],now:()=>1000,fetcher:async()=>{calls++;return new Response(rss);}});
  const miss=await s.search({query:'"quake2" free 2023 source github "quake2data" OR "q2rtx"',scope:'web'});
  expect(miss.isError).toBe(true);expect(miss.failures[0]).toMatchObject({reason:'irrelevant_results',retryAt:0});
  expect(s.status()[0].state).toBe('available');
  const hit=await s.search({query:'Node documentation',scope:'web'});
  expect(hit.provider).toBe('bing');expect(hit.results[0].url).toBe('https://nodejs.org/');expect(calls).toBe(2);
 });
 it('unverifiable query terms still reject output but do not poison provider health',async()=>{
  let calls=0;const s=createSearch({providers:['bing'],fetcher:async()=>{calls++;return new Response(rss);}});
  expect((await s.search({query:'site:example.org docs'})).failures[0].reason).toBe('unverified_results');
  expect((await s.search({query:'Node'})).provider).toBe('bing');expect(calls).toBe(2);
 });
 it('uses explicitly limited GitHub repository fallback after bad RSS',async()=>{
  const calls:string[]=[];const s=createSearch({providers:['bing','github'],fetcher:async(url:string)=>{calls.push(url);return url.includes('bing')?new Response(rss):Response.json({items:[{full_name:'lwthiker/curl-impersonate',html_url:'https://github.com/lwthiker/curl-impersonate',description:'curl-impersonate'}]});}});
  const result=await s.search({query:'curl-impersonate official github documentation'});expect(result.provider).toBe('github');expect(result.scope).toBe('github-repositories');expect(result.queryUsed).toBe('curl-impersonate');expect(calls[1]).toContain('q=curl-impersonate');
 });
 it('tries repository fallback on valid empty RSS for an explicit GitHub query',async()=>{
  const s=createSearch({providers:['bing','github'],fetcher:async(url:string)=>url.includes('bing')?new Response('<rss><channel></channel></rss>'):Response.json({items:[{full_name:'lwthiker/curl-impersonate',html_url:'https://github.com/lwthiker/curl-impersonate'}]})});
  const r=await s.search({query:'curl-impersonate github'});expect(r.provider).toBe('github');expect(r.failures[0].reason).toBe('no_results');expect(s.status()[0].state).toBe('available');
 });
 it('does not silently narrow an unrelated web query to GitHub',async()=>{
  const calls:string[]=[];const s=createSearch({providers:['bing','github'],fetcher:async(url:string)=>{calls.push(url);return new Response(rss);}});
  expect((await s.search({query:'concert tickets'})).isError).toBe(true);expect(calls).toHaveLength(1);
 });
 it('bounds responses and validates before making requests',async()=>{
  let count=0;const s=createSearch({providers:['bing'],fetcher:async()=>{count++;return new Response('x'.repeat(262145));}});
  await expect(s.search({query:'test',numResults:100})).rejects.toThrow();expect(count).toBe(0);
  expect((await s.search({query:'test'})).failures[0].reason).toBe('response_too_large');
 });
});

describe('repository discovery relevance',()=>{
 const genericGithub='<rss><channel><item><title>GitHub</title><link>https://github.com/github</link><description>How people build software. GitHub has repositories.</description></item></channel></rss>';
 it('rejects generic software results for the observed Quake discovery query',async()=>{
  const s=createSearch({providers:['bing'],fetcher:async()=>new Response(genericGithub)});
  const result=await s.search({query:'github official id Software Quake 2 GPL 3.20 source code repository'});
  expect(result.isError).toBe(true);expect(result.failures[0].reason).toBe('irrelevant_results');
 });
 it('falls back to project repositories after generic software RSS',async()=>{
  const urls:string[]=[];
  const s=createSearch({providers:['bing','github'],fetcher:async(url:string)=>{
   urls.push(url);return url.includes('bing')?new Response(genericGithub):Response.json({items:[{full_name:'id-Software/Quake-2',html_url:'https://github.com/id-Software/Quake-2',description:'Quake 2 GPL Source Release'}]});
  }});
  const result=await s.search({query:'github official id Software Quake 2 GPL 3.20 source code repository'});
  expect(result.provider).toBe('github');expect(result.queryUsed).toBe('quake');
  expect(result.results[0].url).toBe('https://github.com/id-Software/Quake-2');
  expect(urls[1]).toContain('q=quake&');
 });
});
