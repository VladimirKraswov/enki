// Synthetic, versioned tasks. The oracle stays outside the agent's filesystem tools.
import {projectFixtures} from './project-fixtures.mjs';
export const suiteVersion = '2.0.0';
const code = (id, category, prompt, initial, reference, assertions) => ({
  id, category, prompt, files: { 'solution.cjs': initial }, reference: { 'solution.cjs': reference },
  assertions,
});
export const fixtures = [
  code('zero-value', 'code', 'Fix price(quantity, unit): zero is a valid quantity; only null/undefined default to 1.',
    'exports.price=(q,u)=>(q||1)*u;', 'exports.price=(q,u)=>(q??1)*u;',
    'assert.equal(s.price(0,8),0);assert.equal(s.price(null,8),8);assert.equal(s.price(undefined,8),8);assert.equal(s.price(3,8),24);'),
  code('stable-order', 'code', 'Fix sort(items): return items sorted ascending by score, stable for ties, without modifying the input array.',
    'exports.sort=a=>a.sort((x,y)=>x.score-y.score);', 'exports.sort=a=>[...a].sort((x,y)=>x.score-y.score);',
    'const a=[{id:1,score:3},{id:2,score:1},{id:3,score:1}];const before=JSON.stringify(a);assert.deepEqual(s.sort(a).map(x=>x.id),[2,3,1]);assert.equal(JSON.stringify(a),before);assert.notEqual(s.sort(a),a);'),
  code('scope-events', 'code', 'Fix accepts(event, active): accept only when BOTH directory and session match. Compare directory strings exactly.',
    'exports.accepts=(e,a)=>e.session===a.session;', 'exports.accepts=(e,a)=>e.session===a.session&&e.directory===a.directory;',
    'const a={session:"s",directory:"/project/A"};assert.equal(s.accepts(a,a),true);assert.equal(s.accepts({...a,directory:"/project/B"},a),false);assert.equal(s.accepts({...a,session:"other"},a),false);assert.equal(s.accepts({...a,directory:"/project/a"},a),false);'),
  code('idempotent-usage', 'code', 'Fix total(records): sum numeric tokens once per (device,id). Different devices with the same id are distinct. Do not modify records.',
    'exports.total=r=>r.reduce((n,x)=>n+x.tokens,0);',
    'exports.total=r=>{const seen=new Set();return r.reduce((n,x)=>{const k=JSON.stringify([x.device,x.id]);if(seen.has(k))return n;seen.add(k);return n+x.tokens},0)};',
    'const r=[{device:"a",id:"1",tokens:5},{device:"a",id:"1",tokens:5},{device:"b",id:"1",tokens:7},{device:"a|b",id:"c",tokens:2},{device:"a",id:"b|c",tokens:3}];const before=JSON.stringify(r);assert.equal(s.total(r),17);assert.equal(JSON.stringify(r),before);assert.equal(s.total([]),0);'),
  code('unicode-budget', 'code', 'Fix fits(text, limit): use UTF-8 byte length and include equality at limit.',
    'exports.fits=(t,l)=>t.length<l;', 'exports.fits=(t,l)=>Buffer.byteLength(t,"utf8")<=l;',
    'assert.equal(s.fits("abc",3),true);assert.equal(s.fits("я",1),false);assert.equal(s.fits("я",2),true);assert.equal(s.fits("😀",3),false);assert.equal(s.fits("😀",4),true);assert.equal(s.fits("",0),true);'),
  code('verdict-invalidates', 'code', 'Fix update(card, patch): return a new card. Changing goal or evidence resets verdict to unreviewed. A no-op patch preserves verdict. Never mutate card.',
    'exports.update=(c,p)=>Object.assign(c,p);',
    'exports.update=(c,p)=>({...c,...p,verdict:(("goal" in p&&p.goal!==c.goal)||("evidence" in p&&p.evidence!==c.evidence))?"unreviewed":c.verdict});',
    'const c={goal:"old",evidence:"pass",verdict:"accepted"};assert.equal(s.update(c,{goal:"new"}).verdict,"unreviewed");assert.equal(s.update(c,{evidence:"fail"}).verdict,"unreviewed");assert.equal(s.update(c,{goal:"old"}).verdict,"accepted");assert.equal(c.goal,"old");assert.notEqual(s.update(c,{}),c);'),
  code('failed-write', 'recovery', 'Fix async save(state, persist): persist the draft before clearing it and updating saved. On failure keep draft and saved unchanged and propagate the error.',
    'exports.save=async(s,p)=>{s.saved=s.draft;s.draft=null;await p(s.saved)};',
    'exports.save=async(s,p)=>{const draft=s.draft;await p(draft);s.saved=draft;s.draft=null};',
    'const state={draft:"new",saved:"old"};await assert.rejects(s.save(state,async()=>{throw Error("disk full")}));assert.deepEqual(state,{draft:"new",saved:"old"});await s.save(state,async v=>assert.equal(v,"new"));assert.deepEqual(state,{draft:null,saved:"new"});'),
  code('bounded-retry', 'recovery', 'Fix async run(action, maxAttempts): maxAttempts includes initial call. Retry failures at most that many times; return first success, propagate last error, and reject maxAttempts < 1 with no action calls.',
    'exports.run=async(f,n)=>{for(let i=0;i<=n;i++){try{return await f()}catch(e){if(i===n)throw e}}};',
    'exports.run=async(f,n)=>{if(n<1)throw Error("invalid limit");for(let i=0;i<n;i++){try{return await f()}catch(e){if(i===n-1)throw e}}};',
    'let calls=0;await assert.rejects(s.run(async()=>{calls++;throw Error("fail")},3));assert.equal(calls,3);calls=0;assert.equal(await s.run(async()=>{if(++calls<2)throw Error("once");return 7},3),7);assert.equal(calls,2);calls=0;await assert.rejects(s.run(async()=>{calls++},0));assert.equal(calls,0);'),
  code('stale-edit', 'recovery', 'Fix replace(current, expected, oldText, newText): throw on stale current !== expected, empty oldText, or zero/multiple occurrences. Otherwise replace the unique match. No partial edits.',
    'exports.replace=(c,e,o,n)=>c.replace(o,n);',
    'exports.replace=(c,e,o,n)=>{if(c!==e||!o||c.split(o).length!==2)throw Error("conflict");return c.replace(o,()=>n)};',
    'assert.equal(s.replace("abc","abc","b","$&"),"a$&c");assert.throws(()=>s.replace("abc","old","b","x"));assert.throws(()=>s.replace("aba","aba","a","x"));assert.throws(()=>s.replace("abc","abc","z","x"));assert.throws(()=>s.replace("abc","abc","","x"));'),
  ...projectFixtures,
  ...[
    ['browser-discount', 'Apply a 15% discount to Oak only, save, and leave Pine unchanged.', false],
    ['browser-validation', 'Try to save Oak discount 120. Verify validation refuses it, then correct to 20 and save. Leave Pine unchanged.', false],
    ['browser-workflow', 'Update Oak and Pine in two separate edits. First submit invalid Oak discount 120 and observe validation, then save Oak 20. Save Pine 10. Preserve other data; exactly two successful saves. Recover from any stale snapshot with a fresh observation.', true],
    ['browser-stale-view', 'Set Oak discount to 10 and save. The fixture may change its viewport/scroll unexpectedly: recover using a fresh snapshot; never repeat a stale coordinate action blindly.', true],
  ].map(([id, prompt, disturbance]) => ({ id, category: 'browser', prompt, disturbance,
    files: {}, ...(id==='browser-workflow'?{workflow:true,expectedPine:10,expectedSaves:2}:{}), expected: id === 'browser-discount' ? 15 : ['browser-validation','browser-workflow'].includes(id) ? 20 : 10 })),
];

export const browserHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic shop</title>
<style>body{font:18px sans-serif;padding:24px}button,input{font:inherit;margin:8px;padding:8px}section{border:1px solid #888;padding:20px}</style>
<h1>Local fixture shop</h1><p>Oak discount: <span id="oak">0</span>%</p><p>Pine discount: <span id="pine">5</span>%</p>
<button aria-label="Edit Oak" onclick="document.querySelector('section').hidden=false">Edit Oak</button>
<section hidden><label>Discount<input aria-label="Discount" type="number" value="0"></label><p id="error" role="alert"></p>
<button aria-label="Save" onclick="const n=Number(document.querySelector('input').value);if(n<0||n>100){document.querySelector('#error').textContent='Discount must be 0 to 100';window.invalid=(window.invalid||0)+1;return}document.querySelector('#oak').textContent=n;document.querySelector('#error').textContent='';document.querySelector('section').hidden=true;window.saved=(window.saved||0)+1">Save</button></section></html>`;

export const browserWorkflowHtml=browserHtml
 .replace('Edit Oak</button>', `Edit Oak</button><button aria-label="Edit Pine" onclick="window.editing='pine';document.querySelector('section').hidden=false;document.querySelector('input').value=document.querySelector('#pine').textContent">Edit Pine</button>`)
 .replace("onclick=\"document.querySelector('section').hidden=false\"", "onclick=\"window.editing='oak';document.querySelector('section').hidden=false;document.querySelector('input').value=document.querySelector('#oak').textContent\"")
 .replace("document.querySelector('#oak').textContent=n", "document.querySelector('#'+(window.editing||'oak')).textContent=n");
