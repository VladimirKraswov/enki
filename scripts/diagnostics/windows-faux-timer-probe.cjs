// Scratch diagnostic only: measures Node timer rounding, not model speed.
const {performance}=require('node:perf_hooks');
(async()=>{const durations=[];for(let i=0;i<100;i++){const t=performance.now();await new Promise(resolve=>setTimeout(resolve,.04));durations.push(performance.now()-t);}
 durations.sort((a,b)=>a-b);console.log('ENKI_FAUX_TIMER_PROBE '+JSON.stringify({platform:process.platform,node:process.version,samples:durations.length,requestedMs:.04,minMs:durations[0],medianMs:durations[50],p95Ms:durations[95],maxMs:durations[99],meanMs:durations.reduce((a,b)=>a+b,0)/durations.length,SDKExecuted:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
