// The Cataloging Bench — a Tier-B custom app (one `custom` block) seeded by the
// CNC Tooling bundle. It runs in the App Player's sandboxed iframe and talks
// ONLY through the injected `window.cobblr` SDK.
//
// Guided, hands-busy capture: for each unknown tool it walks the operator
// through measure (caliper) → weigh (scale) → observe (cutting end) →
// photograph → bin, then composes a deterministic spec name and commits the
// item via the capability-gated `inventory:bench-commit` action (a sandboxed
// app can't write entities directly — every write goes through an action). A
// best-effort multimodal AI identify on the server enriches the name/brand from
// the measurements when a provider is configured.
//
// ── LIVE MODE (Phase 2) ──────────────────────────────────────────────────
// When an edge agent at the bench is connected, the readings arrive FROM the
// hardware instead of being confirmed on screen. The agent (a small on-site
// process with an API token) writes the live state to THIS app's own KV bag:
//
//   PUT /modules/core-apps/apps/cataloging-bench/data/bench-live
//       { caliper_mm, scale_g, pedal_seq, ts }
//
// …and the app polls it via cobblr.appLoad("bench-live"). The caliper/scale
// steps then show the LIVE reading (read-only, updating), and the physical FOOT
// PEDAL is the monotonically-increasing `pedal_seq` — when it ticks up, the app
// fires the current step's capture. No new endpoint, table, or action: the
// agent just writes the app's KV; the app reads its own KV. The whole flow
// works identically with no agent connected (Phase 1: editable readings, the
// on-screen button / spacebar is the pedal). Reference agent:
// scripts/bench-agent/agent.mjs.
//
// Exported as a string so featured-bundles.ts can drop it into the bundle's
// provides_apps. Keep it dependency-free vanilla JS.

export const CATALOGING_BENCH_HTML = String.raw`
<style>
  :root{--line:#23303f;--muted:#7f93a8;--accent:#3f6fb5;--bg:#0f1722;--panel:#16202d;--text:#e7eef6;--good:#4caf7d;--live:#46b06a;}
  *{box-sizing:border-box}
  .cb-wrap{font:14px system-ui,-apple-system,sans-serif;color:var(--text);display:flex;flex-direction:column;gap:12px}
  .cb-conn{display:flex;align-items:center;gap:8px;font:11px ui-monospace,monospace;color:var(--muted)}
  .cb-dot{width:9px;height:9px;border-radius:50%;background:#3a4658}
  .cb-dot.on{background:var(--live);box-shadow:0 0 0 3px rgba(70,176,106,.18)}
  .cb-stage{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;min-height:260px;display:flex;flex-direction:column;gap:14px}
  .cb-step{font:11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .cb-prompt{font-size:21px;font-weight:700;line-height:1.25}
  .cb-sub{color:var(--muted);font-size:13px}
  .cb-readout{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cb-num{width:120px;background:#0c141d;border:1px solid var(--line);border-radius:10px;color:var(--text);font:600 26px ui-monospace,monospace;padding:8px 10px;text-align:right}
  .cb-live{display:inline-flex;align-items:baseline;gap:8px;background:#0c141d;border:1px solid var(--live);border-radius:10px;padding:8px 14px;font:700 26px ui-monospace,monospace;color:#d7f3e2;min-width:120px;justify-content:flex-end}
  .cb-live .src{font:10px ui-monospace,monospace;color:var(--live);letter-spacing:.1em}
  .cb-unit{color:var(--muted);font-size:15px}
  .cb-picks{display:flex;gap:8px;flex-wrap:wrap}
  .cb-pick{border:1px solid var(--line);background:#0c141d;border-radius:9px;padding:8px 12px;color:var(--text);cursor:pointer;font-size:14px}
  .cb-pick.sel{border-color:var(--accent);background:rgba(63,111,181,.18);color:#cfe0f5}
  .cb-canvas{width:150px;height:150px;border:1px solid var(--line);border-radius:12px;background:#0c141d}
  .cb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .cb-spacer{flex:1}
  .cb-pedal{border:none;background:var(--accent);color:#fff;border-radius:12px;padding:14px 22px;font:700 16px system-ui;cursor:pointer;display:inline-flex;align-items:center;gap:9px}
  .cb-pedal:disabled{opacity:.5;cursor:default}
  .cb-pedal .key{font:11px ui-monospace,monospace;background:rgba(255,255,255,.18);border-radius:5px;padding:2px 6px}
  .cb-tape{display:flex;gap:7px;flex-wrap:wrap}
  .cb-chip{font:11px ui-monospace,monospace;background:#0c141d;border:1px solid var(--line);border-radius:7px;padding:4px 8px;color:#aebfce}
  .cb-chip b{color:var(--text);font-weight:700}
  .cb-bin{display:inline-flex;align-items:center;gap:8px;background:#0c141d;border:1px solid var(--accent);border-radius:10px;padding:10px 14px;font:600 16px ui-monospace,monospace;color:#cfe0f5}
  .cb-result{background:#0c141d;border:1px solid var(--good);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:center}
  .cb-result .nm{font-weight:700;font-size:16px}
  .cb-log h4{font:11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  .cb-logrow{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);padding:8px 0;font-size:13px}
  .cb-logrow .loc{margin-left:auto;font:11px ui-monospace,monospace;color:var(--accent)}
  .cb-ai{font:10px ui-monospace,monospace;color:var(--good);border:1px solid var(--good);border-radius:5px;padding:1px 5px}
  .cb-empty{color:var(--muted);font-size:12px}
</style>
<div class="cb-wrap">
  <div class="cb-conn" id="cb-conn"><span class="cb-dot" id="cb-dot"></span><span id="cb-conntxt">Bench not connected — simulated readings (Phase 1).</span></div>
  <div class="cb-stage" id="cb-stage"></div>
  <div class="cb-tape" id="cb-tape"></div>
  <div class="cb-log">
    <h4>// binned this session</h4>
    <div id="cb-log"><span class="cb-empty">Nothing yet — run a tool through the bench.</span></div>
  </div>
</div>
<script>
(function(){
  var stage=document.getElementById('cb-stage');
  var tapeEl=document.getElementById('cb-tape');
  var logEl=document.getElementById('cb-log');
  var dotEl=document.getElementById('cb-dot');
  var connTxt=document.getElementById('cb-conntxt');
  var SDK=(window.cobblr||{});

  var TOOL_TYPES=['End mill','Drill','Tap','Reamer','Insert'];
  var ENDS=['Square','Ball','Corner-radius','Chamfer','Drill point'];
  var MATERIALS=['Carbide','HSS','Cobalt'];
  var sample=[
    {type:'End mill',dia:6.0,oal:57,shank:6.0,flute:38,flutes:4,end:'Square',mat:'Carbide',wt:14},
    {type:'End mill',dia:3.175,oal:38,shank:3.175,flute:12,flutes:2,end:'Ball',mat:'Carbide',wt:5},
    {type:'Drill',dia:5.0,oal:86,shank:5.0,flute:52,flutes:2,end:'Drill point',mat:'HSS',wt:11},
    {type:'End mill',dia:12.0,oal:83,shank:12.0,flute:26,flutes:4,end:'Corner-radius',mat:'Carbide',wt:62},
    {type:'Tap',dia:6.0,oal:66,shank:5.0,flute:22,flutes:4,end:'Chamfer',mat:'HSS',wt:13}
  ];
  var sampleIdx=0;

  function makeSteps(s){return [
    {k:'caliper',chan:'caliper_mm',field:'diameter_mm',label:'cutting diameter',val:s.dia,unit:'mm'},
    {k:'caliper',chan:'caliper_mm',field:'shank_dia_mm',label:'shank diameter',val:s.shank,unit:'mm'},
    {k:'caliper',chan:'caliper_mm',field:'overall_length_mm',label:'overall length',val:s.oal,unit:'mm'},
    {k:'caliper',chan:'caliper_mm',field:'flute_length_mm',label:'flute length',val:s.flute,unit:'mm'},
    {k:'scale',chan:'scale_g',field:'weight_g',label:'weight',val:s.wt,unit:'g'},
    {k:'observe-type',field:'tool_type',label:'what kind of tool is it?',val:s.type},
    {k:'observe-count',field:'flute_count',label:'how many flutes / lands?',val:s.flutes},
    {k:'observe-end',field:'end_type',label:'what is the cutting end?',val:s.end},
    {k:'observe-mat',field:'material',label:'what is it made of?',val:s.mat},
    {k:'photo',field:'_photo',label:'place it in the photo box'},
    {k:'locate',field:'_bin',label:'bin it'}
  ];}

  var item=null, binSeq=0, currentPedal=null;
  // live edge state — populated by polling the app's own KV ("bench-live"),
  // which the on-site agent writes. live.on = a fresh reading was seen recently.
  var live={on:false,caliper_mm:null,scale_g:null,pedal_seq:0,seen:0};

  function nextBin(){binSeq++;var b=Math.floor((binSeq-1)/8)+1,c=((binSeq-1)%8)+1;return 'Bin '+b+' / Comp '+c;}

  function start(){
    var s=sample[sampleIdx % sample.length]; sampleIdx++;
    item={steps:makeSteps(s),i:0,captured:{},bin:nextBin(),s:s};
    render();
  }

  function specName(c){
    var t=(c.tool_type||'tool').toLowerCase(), noun=t==='end mill'?'end mill':t, bits=[];
    if(c.diameter_mm) bits.push(fmt(c.diameter_mm)+' mm');
    if(c.flute_count) bits.push(c.flute_count+'-flute');
    if(c.end_type && noun==='end mill') bits.push(String(c.end_type).toLowerCase());
    if(c.material) bits.push(String(c.material).toLowerCase());
    bits.push(noun);
    return bits.join(' ').replace(/\b\w/,function(m){return m.toUpperCase();});
  }
  function fmt(n){return (Math.round(n*1000)/1000).toString();}

  function drawTool(canvas,s){
    var x=canvas.getContext('2d'),W=canvas.width=300,H=canvas.height=300;
    x.clearRect(0,0,W,H);x.save();x.translate(W/2,H/2);x.rotate(-0.45);
    var len=200, dia=Math.max(16,Math.min(54,(s.dia||6)*5)), sh=dia*0.78;
    x.fillStyle='#7e8794';x.fillRect(-len/2,-sh/2,len*0.42,sh);
    var grad=x.createLinearGradient(0,-dia/2,0,dia/2);
    grad.addColorStop(0,(s.mat==='Carbide')?'#3a4350':'#5a6470');grad.addColorStop(.5,(s.mat==='Carbide')?'#aab4c2':'#c9cfd6');grad.addColorStop(1,(s.mat==='Carbide')?'#3a4350':'#5a6470');
    x.fillStyle=grad;x.fillRect(-len*0.08,-dia/2,len*0.55,dia);
    x.strokeStyle='rgba(10,16,24,.65)';x.lineWidth=2;
    var n=s.flutes||4, bx=-len*0.08, bw=len*0.55;
    for(var f=0;f<n*3;f++){var fx=bx+(f/(n*3))*bw;x.beginPath();x.moveTo(fx,-dia/2);x.lineTo(fx+dia*0.7,dia/2);x.stroke();}
    x.fillStyle='#8b95a3';
    if(s.end==='Ball'){x.beginPath();x.arc(bx+bw,0,dia/2,-Math.PI/2,Math.PI/2);x.fill();}
    else if(s.end==='Drill point'){x.beginPath();x.moveTo(bx+bw,-dia/2);x.lineTo(bx+bw+dia*0.7,0);x.lineTo(bx+bw,dia/2);x.closePath();x.fill();}
    else {x.fillRect(bx+bw-2,-dia/2,4,dia);}
    x.restore();
  }

  function tape(){
    var c=item?item.captured:{};
    tapeEl.innerHTML=Object.keys(c).filter(function(k){return k[0]!=='_';}).map(function(k){
      return '<span class="cb-chip">'+k.replace(/_/g,' ').replace(' mm','').replace(' g','')+' <b>'+c[k]+'</b></span>';
    }).join('');
  }

  function el(h){var d=document.createElement('div');d.innerHTML=h;return d.firstElementChild;}
  function pedal(label){return '<button class="cb-pedal" id="cb-pedal">'+label+' <span class="key">pedal ⌨ space</span></button>';}

  function render(){
    tape();
    if(!item){
      stage.innerHTML='<div class="cb-step">// the bench</div>'+
        '<div class="cb-prompt">Ready for the next tool.</div>'+
        '<div class="cb-sub">Drop an unknown tool on the bench. We\'ll measure it, weigh it, look at it, photograph it, and tell you which bin it goes in — no typing.</div>'+
        '<div class="cb-row"><div class="cb-spacer"></div>'+pedal('Start')+'</div>';
      bind(start); return;
    }
    var st=item.steps[item.i], n=item.steps.length;
    var head='<div class="cb-step">step '+(item.i+1)+' / '+n+'</div>';
    if(st.k==='caliper'||st.k==='scale'){
      var hw=st.k==='caliper'?'Measure the '+st.label+' with the calipers':'Place it on the scale, let it settle';
      var liveVal=live.on?live[st.chan]:null;
      var readout = live.on
        ? '<div class="cb-live"><span class="src">🔌 LIVE</span><span id="cb-livev">'+(liveVal!=null?fmt(liveVal):'—')+'</span></div><span class="cb-unit">'+st.unit+'</span>'
        : '<input class="cb-num" id="cb-val" value="'+st.val+'"><span class="cb-unit">'+st.unit+'</span>';
      stage.innerHTML=head+'<div class="cb-prompt">'+hw+'.</div>'+
        '<div class="cb-sub">'+(live.on?'Reading straight from the bench — pedal to capture it.':'Pedal when the reading is right (Phase 1: editable; a real caliper/scale feeds it in Phase 2).')+'</div>'+
        '<div class="cb-readout">'+readout+'</div>'+
        '<div class="cb-row"><div class="cb-spacer"></div>'+pedal('Capture')+'</div>';
      bind(function(){
        var v=live.on?live[st.chan]:parseFloat(document.getElementById('cb-val').value);
        item.captured[st.field]=(v==null||isNaN(v))?st.val:v; advance();
      });
    } else if(st.k.indexOf('observe')===0){
      var opts=st.k==='observe-type'?TOOL_TYPES:st.k==='observe-end'?ENDS:st.k==='observe-mat'?MATERIALS:[1,2,3,4,5,6];
      var cur=item.captured[st.field]!=null?item.captured[st.field]:st.val;
      stage.innerHTML=head+'<div class="cb-prompt">'+st.label+'</div>'+
        '<div class="cb-sub">In the full rig this is read from the photo box. For now, confirm what you see.</div>'+
        '<div class="cb-picks" id="cb-picks">'+opts.map(function(o){return '<button class="cb-pick'+(o==cur?' sel':'')+'" data-v="'+o+'">'+o+'</button>';}).join('')+'</div>'+
        '<div class="cb-row"><div class="cb-spacer"></div>'+pedal('Confirm')+'</div>';
      item.captured[st.field]=cur;
      document.getElementById('cb-picks').addEventListener('click',function(e){var b=e.target.closest('.cb-pick');if(!b)return;item.captured[st.field]=isNaN(b.dataset.v)?b.dataset.v:Number(b.dataset.v);[].forEach.call(this.children,function(c){c.classList.remove('sel');});b.classList.add('sel');});
      bind(advance);
    } else if(st.k==='photo'){
      stage.innerHTML=head+'<div class="cb-prompt">Place it in the photo box.</div>'+
        '<div class="cb-sub">A photo is captured + attached (for you, and for Phase-2 vision). Phase 1 renders it from the measurements.</div>'+
        '<div class="cb-row"><canvas class="cb-canvas" id="cb-cv"></canvas><div class="cb-spacer"></div>'+pedal('Capture photo')+'</div>';
      drawTool(document.getElementById('cb-cv'),{dia:item.captured.diameter_mm,flutes:item.captured.flute_count,end:item.captured.end_type,mat:item.captured.material});
      bind(advance);
    } else if(st.k==='locate'){
      stage.innerHTML=head+'<div class="cb-prompt">Done. Put it in:</div>'+
        '<div class="cb-row"><span class="cb-bin">📦 '+item.bin+'</span><div class="cb-spacer"></div>'+pedal('Bin it + commit')+'</div>'+
        '<div class="cb-sub">'+specName(item.captured)+' — committing…</div>';
      bind(commit);
    }
  }

  function advance(){item.i++; if(item.i>=item.steps.length){commit();} else render();}

  // bind: register the current step's pedal action. Fired by the on-screen
  // button, the spacebar, OR a physical foot pedal (a pedal_seq tick from live).
  function bind(fn){
    currentPedal=fn;
    var p=document.getElementById('cb-pedal'); if(p)p.onclick=function(){if(currentPedal)currentPedal();};
    window.onkeydown=function(e){if(e.code==='Space'){e.preventDefault();firePedal();}};
  }
  function firePedal(){var b=document.getElementById('cb-pedal');if(currentPedal && (!b||!b.disabled))currentPedal();}

  // The bench (the use-case) orchestrates two GENERIC capabilities — it never
  // calls a bench-specific action. First ask core-scan:identify "what is this?"
  // (best-effort, from the measurements + observations); then inventory:create-
  // item to add the tool, using the AI's name/brand when it's confident, else
  // the deterministic spec we composed. Generic modules, app-side wiring.
  function commit(){
    var p=document.getElementById('cb-pedal'); if(p){p.disabled=true;p.textContent='Committing…';}
    var c=item.captured, floor=specName(c), bin=item.bin;
    var fields={}; Object.keys(c).forEach(function(k){if(k[0]!=='_')fields[k]=c[k];});
    fields.bin=bin;
    var measurements={diameter_mm:c.diameter_mm,shank_dia_mm:c.shank_dia_mm,overall_length_mm:c.overall_length_mm,flute_length_mm:c.flute_length_mm,weight_g:c.weight_g};
    var observations={tool_type:c.tool_type,flute_count:c.flute_count,end_type:c.end_type,material:c.material};
    var doIdentify = SDK.invoke
      ? SDK.invoke('core-scan:identify',{args:{measurements:measurements,observations:observations}}).then(function(r){return (r&&r.result)||r||{};}).catch(function(){return {};})
      : Promise.resolve({});
    doIdentify.then(function(id){
      var ai = !!(id && id.identified && id.name);
      var name = ai ? id.name : floor;
      var mfr = (id && id.brand) ? id.brand : undefined;
      return SDK.invoke('inventory:create-item',{args:{instance:'tooling',name:name,manufacturer:mfr,fields:fields}})
        .then(function(cr){var res=(cr&&cr.result)||cr||{}; addLog(res.name||name,bin,ai); showResult(res.name||name,bin,ai);});
    }).catch(function(){addLog(floor,bin,false);showResult(floor,bin,false);});
  }

  function showResult(name,bin,ai){
    item=null; tape();
    stage.innerHTML='<div class="cb-step">// committed</div>'+
      '<div class="cb-result">✅ <div><div class="nm">'+name+(ai?' <span class="cb-ai">AI ✓</span>':'')+'</div><div class="cb-sub">filed in '+bin+'</div></div></div>'+
      '<div class="cb-row"><div class="cb-spacer"></div>'+pedal('Next tool')+'</div>';
    bind(start);
  }

  function addLog(name,bin,ai){
    if(logEl.querySelector('.cb-empty'))logEl.innerHTML='';
    logEl.insertBefore(el('<div class="cb-logrow">🔧 <span>'+name+'</span>'+(ai?' <span class="cb-ai">AI ✓</span>':'')+'<span class="loc">'+bin+'</span></div>'),logEl.firstChild);
  }

  // ── poll the live edge state (the agent writes this app's "bench-live" KV) ──
  function pollLive(){
    if(!SDK.appLoad){return;}
    SDK.appLoad('bench-live').then(function(v){
      var now=Date.now();
      if(v && typeof v==='object' && typeof v.ts==='number' && (now - v.ts) < 6000){
        if(!live.on){live.on=true;dotEl.classList.add('on');connTxt.textContent='Bench connected — live readings from the edge agent.';if(item)render();}
        live.caliper_mm=v.caliper_mm; live.scale_g=v.scale_g;
        // refresh the live readout in place (no full re-render → no flicker)
        var lv=document.getElementById('cb-livev');
        if(lv && item){var st=item.steps[item.i]; if(st&&st.chan&&live[st.chan]!=null)lv.textContent=fmt(live[st.chan]);}
        // a physical pedal press = pedal_seq ticking up
        if(typeof v.pedal_seq==='number' && v.pedal_seq>live.pedal_seq){live.pedal_seq=v.pedal_seq; firePedal();}
      } else if(live.on){
        live.on=false;dotEl.classList.remove('on');connTxt.textContent='Bench not connected — simulated readings (Phase 1).';if(item)render();
      }
    }).catch(function(){});
  }
  setInterval(pollLive, 400); pollLive();

  render();
})();
</script>`;
