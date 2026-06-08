// The Outfit Planner — a Tier-B custom app (one `custom` block) seeded by the
// Wardrobe bundle. It runs in the App Player's sandboxed iframe and talks ONLY
// through the injected `window.cobblr` SDK (capability-scoped, member-bounded):
//   • lists garments from the Wardrobe instance's saved view (H2-scoped)
//   • loads each garment's photo via cobblr.image() (data URL — the sandbox
//     can't auth-fetch core-files directly)
//   • drags garments onto a figure (Pointer Events → works on touch + mouse)
//   • saves/loads named looks in the app's own KV scratchpad (cobblr.appSave/
//     appLoad) — never touches your real entities
//
// Exported as a string so featured-bundles.ts can drop it into the Wardrobe
// bundle's provides_apps. Keep it dependency-free vanilla JS.

export const OUTFIT_PLANNER_HTML = String.raw`
<style>
  :root{--line:#e6e2da;--muted:#8a8377;--accent:#7c6f5a;--bg:#f3efe7;}
  *{box-sizing:border-box}
  .op-wrap{display:flex;flex-direction:column;gap:10px;font:14px system-ui,-apple-system,sans-serif;color:#332f28}
  .op-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .op-stagewrap{position:relative;width:100%;max-width:340px;margin:0 auto;aspect-ratio:9/16;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;touch-action:none}
  .op-figure{position:absolute;inset:0;width:100%;height:100%;opacity:.5;pointer-events:none}
  .op-item{position:absolute;touch-action:none;cursor:grab;border-radius:8px;user-select:none}
  .op-item img{width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
  .op-item.sel{outline:2px solid var(--accent);outline-offset:1px}
  .op-chip{display:flex;flex-direction:column;align-items:center;gap:3px;width:64px;cursor:grab;touch-action:none}
  .op-chip .sw{width:58px;height:58px;border-radius:9px;border:1px solid var(--line);background:#fafafa center/contain no-repeat;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--muted);text-align:center;overflow:hidden}
  .op-chip .nm{font-size:10px;line-height:1.1;text-align:center;color:#4a463d;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .op-palette{display:flex;gap:8px;overflow-x:auto;padding:4px 2px;min-height:84px}
  .op-pal-cat{font:10px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:6px 0 0}
  .op-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;font:13px system-ui;color:#332f28;cursor:pointer}
  .op-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .op-btn:disabled{opacity:.5;cursor:default}
  .op-looks{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}
  .op-look{flex:0 0 auto;border:1px solid var(--line);border-radius:8px;padding:6px 9px;background:#fff;cursor:pointer;font-size:12px;display:flex;gap:6px;align-items:center}
  .op-look .x{color:var(--muted);cursor:pointer}
  .op-empty{color:var(--muted);font-size:12px;padding:8px}
  .op-hint{font-size:11px;color:var(--muted)}
  input.op-name{flex:1;min-width:120px;border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:13px system-ui}
  .op-size{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
</style>
<div class="op-wrap">
  <div id="op-status" class="op-hint">Loading your wardrobe…</div>
  <div class="op-stagewrap" id="op-stage">
    <svg class="op-figure" viewBox="0 0 90 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g fill="none" stroke="#b9b1a2" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
        <circle cx="45" cy="15" r="9"/>
        <path d="M45 24 C40 24 38 28 38 33 L38 40 C30 43 24 49 22 60 L26 62 C29 53 33 49 38 47 L38 70 C36 88 35 104 36 110 L34 150 L41 150 L44 112 L46 112 L49 150 L56 150 L54 110 C55 104 54 88 52 70 L52 47 C57 49 61 53 64 62 L68 60 C66 49 60 43 52 40 L52 33 C52 28 50 24 45 24 Z"/>
      </g>
    </svg>
  </div>
  <div class="op-row" id="op-selbar" style="display:none">
    <button class="op-btn" id="op-front">Bring front</button>
    <button class="op-btn" id="op-remove">Remove</button>
    <span class="op-size">size <input id="op-resize" type="range" min="36" max="200" value="92"></span>
  </div>
  <div class="op-pal-cat">// your garments — tap or drag onto the figure</div>
  <div class="op-palette" id="op-palette"></div>
  <div class="op-row">
    <input class="op-name" id="op-lookname" placeholder="Name this look (e.g. Friday work)"/>
    <button class="op-btn primary" id="op-save">Save look</button>
    <button class="op-btn" id="op-clear">Clear</button>
  </div>
  <div class="op-pal-cat">// saved looks</div>
  <div class="op-looks" id="op-looks"><span class="op-empty">No saved looks yet.</span></div>
</div>
<script>
(function(){
  var stage=document.getElementById('op-stage');
  var palette=document.getElementById('op-palette');
  var status=document.getElementById('op-status');
  var looksEl=document.getElementById('op-looks');
  var selbar=document.getElementById('op-selbar');
  var resize=document.getElementById('op-resize');
  var garments=[];      // {id,title,color,type,src}
  var items=[];         // placed: {garmentId,el,x,y,w,z,src,title}
  var looks=[];         // saved
  var sel=null, z=1;

  function rect(){return stage.getBoundingClientRect();}
  function isHex(c){return typeof c==='string' && /^#?[0-9a-fA-F]{3,8}$/.test(c.trim());}
  function hex(c){c=String(c).trim();return c[0]==='#'?c:'#'+c;}

  function chipBg(g){
    if(g.src) return 'background-image:url('+g.src+')';
    if(isHex(g.color)) return 'background:'+hex(g.color);
    return '';
  }

  // ---- placing + dragging (Pointer Events: mouse + touch) ----
  function place(g,x,y,w,zz){
    var el=document.createElement('div');
    el.className='op-item';
    var s=w||92;
    el.style.width=s+'px';el.style.height=s+'px';
    el.style.left=(x-s/2)+'px';el.style.top=(y-s/2)+'px';
    el.style.zIndex=zz||(++z);
    if(g.src){var im=document.createElement('img');im.src=g.src;el.appendChild(im);}
    else{el.style.background=isHex(g.color)?hex(g.color):'#d9d4c8';el.style.border='1px solid #cfc9bb';
         var lab=document.createElement('div');lab.style.cssText='font:10px system-ui;color:#fff;text-align:center;line-height:'+s+'px;text-shadow:0 1px 2px rgba(0,0,0,.4)';lab.textContent=g.title;el.appendChild(lab);}
    var rec={garmentId:g.id,el:el,x:x,y:y,w:s,z:Number(el.style.zIndex),src:g.src,title:g.title,color:g.color};
    items.push(rec);
    enableDrag(el,rec);
    stage.appendChild(el);
    select(rec);
    return rec;
  }
  function enableDrag(el,rec){
    var sx,sy,ox,oy,drag=false;
    el.addEventListener('pointerdown',function(e){
      e.preventDefault();select(rec);drag=true;el.setPointerCapture(e.pointerId);el.style.cursor='grabbing';
      sx=e.clientX;sy=e.clientY;ox=rec.x;oy=rec.y;
    });
    el.addEventListener('pointermove',function(e){
      if(!drag)return;var r=rect();
      rec.x=ox+(e.clientX-sx);rec.y=oy+(e.clientY-sy);
      el.style.left=(rec.x-rec.w/2)+'px';el.style.top=(rec.y-rec.w/2)+'px';
    });
    el.addEventListener('pointerup',function(e){drag=false;el.style.cursor='grab';try{el.releasePointerCapture(e.pointerId);}catch(_){}});
  }
  function select(rec){
    sel=rec;
    items.forEach(function(it){it.el.classList.toggle('sel',it===rec);});
    selbar.style.display=rec?'flex':'none';
    if(rec)resize.value=rec.w;
  }
  stage.addEventListener('pointerdown',function(e){if(e.target===stage||e.target.tagName==='svg'||e.target.tagName==='path'||e.target.tagName==='circle'||e.target.tagName==='g'){select(null);}});

  document.getElementById('op-remove').onclick=function(){if(!sel)return;sel.el.remove();items=items.filter(function(i){return i!==sel;});select(null);};
  document.getElementById('op-front').onclick=function(){if(!sel)return;sel.z=++z;sel.el.style.zIndex=sel.z;};
  resize.oninput=function(){if(!sel)return;var s=Number(resize.value);sel.w=s;sel.el.style.width=s+'px';sel.el.style.height=s+'px';sel.el.style.left=(sel.x-s/2)+'px';sel.el.style.top=(sel.y-s/2)+'px';};
  document.getElementById('op-clear').onclick=function(){items.forEach(function(i){i.el.remove();});items=[];select(null);};

  // ---- palette → drag a garment onto the stage (clone follows pointer) ----
  function makeChip(g){
    var chip=document.createElement('div');chip.className='op-chip';
    var sw=document.createElement('div');sw.className='sw';var bg=chipBg(g);if(bg)sw.style.cssText+=';'+bg;if(!g.src&&!isHex(g.color))sw.textContent=g.title;
    var nm=document.createElement('div');nm.className='nm';nm.textContent=g.title;
    chip.appendChild(sw);chip.appendChild(nm);
    // Tap to add it to the figure (mobile-friendly), or drag to drop it exactly
    // where you want. A tap (no real movement) lands it stacked near the torso;
    // either way you can drag the placed garment to reposition.
    chip.addEventListener('pointerdown',function(e){
      e.preventDefault();
      var sx=e.clientX,sy=e.clientY,moved=false;
      var ghost=sw.cloneNode(true);ghost.style.cssText+=';position:fixed;width:64px;height:64px;opacity:.85;pointer-events:none;z-index:9999;border-radius:9px';
      document.body.appendChild(ghost);
      function mv(ev){if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>6)moved=true;ghost.style.left=(ev.clientX-32)+'px';ghost.style.top=(ev.clientY-32)+'px';}
      mv(e);
      function up(ev){
        document.removeEventListener('pointermove',mv);document.removeEventListener('pointerup',up);
        ghost.remove();
        var r=rect();
        if(ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom){
          place(g,ev.clientX-r.left,ev.clientY-r.top);
        }else if(!moved){
          var k=items.length;place(g,r.width*0.5,r.height*0.30+(k%4)*44);
        }
      }
      document.addEventListener('pointermove',mv);document.addEventListener('pointerup',up);
    });
    return chip;
  }

  // ---- saved looks ----
  function snapshot(){var r=rect();return items.map(function(i){return {garmentId:i.garmentId,xr:i.x/r.width,yr:i.y/r.height,w:i.w,z:i.z};});}
  function gById(id){for(var i=0;i<garments.length;i++)if(garments[i].id===id)return garments[i];return null;}
  function loadLook(look){
    items.forEach(function(i){i.el.remove();});items=[];select(null);
    var r=rect();
    (look.items||[]).slice().sort(function(a,b){return (a.z||0)-(b.z||0);}).forEach(function(p){
      var g=gById(p.garmentId);if(!g)return;
      place(g,(p.xr||0.5)*r.width,(p.yr||0.5)*r.height,p.w,p.z);
    });
    select(null);
  }
  function renderLooks(){
    looksEl.innerHTML='';
    if(!looks.length){looksEl.innerHTML='<span class="op-empty">No saved looks yet.</span>';return;}
    looks.forEach(function(L,idx){
      var el=document.createElement('div');el.className='op-look';
      var t=document.createElement('span');t.textContent=L.name||('Look '+(idx+1));t.onclick=function(){loadLook(L);};
      var x=document.createElement('span');x.className='x';x.textContent='×';x.title='Delete';
      x.onclick=function(e){e.stopPropagation();looks.splice(idx,1);persist();renderLooks();};
      el.appendChild(t);el.appendChild(x);looksEl.appendChild(el);
    });
  }
  function persist(){return window.cobblr.appSave('looks',looks);}
  document.getElementById('op-save').onclick=function(){
    var nameEl=document.getElementById('op-lookname');
    var nm=(nameEl.value||'').trim()||('Look '+(looks.length+1));
    if(!items.length){status.textContent='Add a few garments to the figure first.';return;}
    looks.unshift({name:nm,at:Date.now(),items:snapshot()});
    nameEl.value='';persist().then(function(){renderLooks();status.textContent='Saved “'+nm+'”.';});
  };

  // ---- boot: list garments from the Wardrobe instance's saved view ----
  // Through core-views /data — instance kinds now resolve there (H2-scoped),
  // so no raw instance API. Custom values land under row.fields.metadata.
  function garmentFromRow(row){
    var f=row.fields||{}; var meta=f.metadata||{};
    // Load the ORIGINAL (drop ?variant=) so a cut-out garment keeps its
    // transparency — the resized medium/thumb variants flatten alpha to black.
    var ip=row.image_path||f.image_path;
    if(ip)ip=ip.replace(/\?variant=[^&]*/,'').replace(/&variant=[^&]*/,'');
    return {id:row.id,title:row.title||f.name||'Garment',color:meta.color,type:meta.garment_type,image_path:ip};
  }
  function renderGarments(rows){
    if(!rows.length){status.textContent='Your Wardrobe is empty — add some garments (with photos) first.';return Promise.resolve();}
    status.textContent=rows.length+' garments — tap (or drag) any onto the figure, arrange, then Save look.';
    return Promise.all(rows.map(function(row){
      var g=garmentFromRow(row);
      if(!g.image_path)return Promise.resolve(g);
      return window.cobblr.image(g.image_path).then(function(d){g.src=d;return g;}).catch(function(){return g;});
    })).then(function(gs){
      gs.sort(function(a,b){return String(a.type||'~').localeCompare(String(b.type||'~'));});
      garments=gs;palette.innerHTML='';
      gs.forEach(function(g){palette.appendChild(makeChip(g));});
    });
  }
  window.cobblr.get('/modules/core-views/views').then(function(r){
    var views=(r&&(r.items||r))||[];
    var v=views.filter(function(x){return (x.entity_kind||'')==='wardrobe:item';});
    var view=v.filter(function(x){return x.pinned;})[0]||v[0];
    if(!view){status.textContent='No Wardrobe table found — add a garment to your Wardrobe first.';return;}
    return window.cobblr.viewData(view.id,{limit:200}).then(renderGarments);
  }).catch(function(err){status.textContent='Could not load wardrobe: '+((err&&err.message)||err);});

  window.cobblr.appLoad('looks').then(function(v){looks=Array.isArray(v)?v:[];renderLooks();}).catch(function(){});
})();
</script>
`;
