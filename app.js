
/* ============ 家人帳號入口（Supabase Authentication） ============ */
const FAMILY_SESSION_KEY = 'nagano_auth_session_v2';
const FAMILY_TRUSTED_DEVICE_KEY = 'nagano_trusted_device_v1';
let familyAuthSession = null;
function readAuthSession(){try{return JSON.parse(localStorage.getItem(FAMILY_SESSION_KEY)||'null');}catch(e){return null;}}
function saveAuthSession(session){
  familyAuthSession=session?{access_token:session.access_token,refresh_token:session.refresh_token,expires_at:session.expires_at||Math.floor(Date.now()/1000)+(session.expires_in||3600),email:session.user?.email||session.email||''}:null;
  if(familyAuthSession){localStorage.setItem(FAMILY_SESSION_KEY,JSON.stringify(familyAuthSession));localStorage.setItem(FAMILY_TRUSTED_DEVICE_KEY,'1');}
  else localStorage.removeItem(FAMILY_SESSION_KEY);
}
function accessToken(){return familyAuthSession?.access_token||'';}
/* Supabase 的 refresh token 只能用一次。上傳照片時常常會同時觸發好幾個
   請求（上傳本身＋背景同步／輪詢），如果 token 快過期，每個請求都會各自
   想換新 token，其中只有第一個換得到，其餘會收到「Invalid Refresh Token:
   Already Used」。這裡讓所有同時發生的請求共用同一次換新，並在真的撞到
   「已被用掉」時，先看看是不是別的請求已經換好了，是的話就直接沿用，
   避免把這個技術性錯誤原封不動地丟給使用者看。 */
let _refreshInFlight=null;
function sessionFresh(sess){return !!sess && Number(sess.expires_at||0)*1000>Date.now()+60000;}
async function refreshAuthSession(){
  /* 先看本機硬碟（localStorage）有沒有更新版本：同一台裝置可能同時開著好幾個分頁／
     背景還留著舊分頁的程式在跑，其中一個換到新 token 後會寫進 localStorage，
     其他分頁若只看自己記憶體裡的舊物件就會白白再換一次，撞上 Supabase「refresh token
     只能用一次」的限制。所以每次要換之前，先信任 localStorage 目前寫的內容。 */
  const onDisk=readAuthSession();
  if(sessionFresh(onDisk)){familyAuthSession=onDisk;return familyAuthSession;}
  if(!familyAuthSession?.refresh_token||!navigator.onLine)return familyAuthSession;
  if(_refreshInFlight)return _refreshInFlight;
  const rt=familyAuthSession.refresh_token;
  _refreshInFlight=(async()=>{
    try{
      const r=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:rt})});
      const data=await r.json();
      if(!r.ok){
        const msg=data.error_description||data.msg||'';
        if(/already used|invalid refresh token/i.test(msg)){
          /* 「已經用掉了」通常代表別的分頁／背景任務剛好搶先換過。
             重新讀一次 localStorage（而不只是記憶體裡可能過期的物件），
             有換到新的就直接沿用，避免把這個技術性錯誤丟給使用者看。 */
          const latest=readAuthSession();
          if(sessionFresh(latest)&&latest.refresh_token!==rt){familyAuthSession=latest;return familyAuthSession;}
          saveAuthSession(null);
          throw new Error('登入已過期，請重新整理頁面再登入一次。');
        }
        throw new Error(msg||'登入已過期');
      }
      saveAuthSession(data);
      return familyAuthSession;
    }finally{ _refreshInFlight=null; }
  })();
  return _refreshInFlight;
}
async function ensureAuthToken(retry){
  const onDisk=readAuthSession();
  if(sessionFresh(onDisk))familyAuthSession=onDisk;
  else if(!familyAuthSession) familyAuthSession=onDisk;
  if(sessionFresh(familyAuthSession))return familyAuthSession.access_token;
  try{
    await refreshAuthSession();
    if(sessionFresh(familyAuthSession))return familyAuthSession.access_token;
    throw new Error('登入已過期，請重新整理頁面再登入一次。');
  }catch(err){
    /* 最後一次機會：稍等一下，可能是另一個分頁的換新請求正在路上，等它寫進 localStorage 再看一次。
       真的還是沒有才把錯誤丟出去。 */
    if(!retry){
      await new Promise(res=>setTimeout(res,900));
      const again=readAuthSession();
      if(sessionFresh(again)){familyAuthSession=again;return again.access_token;}
      return ensureAuthToken(true);
    }
    throw err;
  }
}
function unlockFamilySite({offline=false}={}){
  document.body.classList.remove('family-locked');
  const gate=document.getElementById('familyGate');
  if(gate){ gate.hidden=true; gate.setAttribute('aria-hidden','true'); }
  if(!offline) startFamilyCloud();
}
/* hk11：只看模式（登入過期／暫不同步）時的頂端提示 */
function showReloginBanner(){
  if(document.getElementById('reloginBanner'))return;
  const el=document.createElement('div');el.id='reloginBanner';el.className='relogin-banner';
  el.innerHTML='<span>需要重新登入，才能和家人同步。<br>行程都還在，可以照常看；這段時間的修改會先存在這支手機，登入後自動合併。</span><button type="button">重新登入</button>';
  el.querySelector('button').onclick=()=>{const g=document.getElementById('familyGate');if(g){g.hidden=false;g.setAttribute('aria-hidden','false');}const ob=document.getElementById('offlineGateButton');if(ob){ob.hidden=false;ob.textContent='先不要，繼續看行程';ob.onclick=()=>{g.hidden=true;g.setAttribute('aria-hidden','true');};}setTimeout(()=>document.getElementById('familyGateEmail')?.focus(),80);};
  document.querySelector('.app')?.prepend(el);
}
function hideReloginBanner(){document.getElementById('reloginBanner')?.remove();}
function loginErrorText(e,status){
  const m=String(e&&e.message||e||'');
  if(/Invalid login credentials/i.test(m))return 'Email 或密碼不正確。請確認是在「這個」Supabase 專案的 Authentication → Users 建立的帳號，密碼大小寫也要一致。';
  if(/Email not confirmed/i.test(m))return '這個帳號還沒驗證。請到 Supabase → Authentication → Users，點該帳號選「Confirm user」，或刪掉重建時勾選 Auto Confirm User。';
  if(/Invalid API key|No API key|apikey/i.test(m)||status===401)return 'Supabase 金鑰不正確。請確認 config.js 裡貼的是 Project Settings → API 的「anon public」key（不是 service_role），而且整串完整沒有斷行。';
  if(status===404||/not found/i.test(m))return '找不到這個 Supabase 專案。請確認 config.js 的網址是 https://xxxx.supabase.co，最後不要多加路徑。';
  if(/timeout|Abort/i.test(m))return '連線逾時。Supabase 專案可能被暫停（免費方案一週沒用會自動暫停），請到 Supabase 首頁按「Restore project」，等幾分鐘再試。';
  if(e instanceof TypeError||/Failed to fetch|Load failed|NetworkError/i.test(m))return '連不到 Supabase。請確認網路正常、config.js 的網址正確，以及專案沒有被暫停。';
  return m||'登入失敗，請稍後再試。';
}
async function submitFamilyGate(){
  const email=document.getElementById('familyGateEmail');
  const input=document.getElementById('familyGateInput');
  const err=document.getElementById('familyGateError');
  const btn=document.getElementById('familyGateButton');
  if(!input||!btn) return;
  const label=btn.textContent; btn.disabled=true; btn.textContent='登入中…';
  if(err) err.textContent='';
  let status=0;
  try{
    if(!navigator.onLine)throw new Error('目前離線；若這台裝置曾登入，可使用下方離線查看。');
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),15000);
    let r;
    try{ r=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',signal:ctrl.signal,headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:(email?.value||'').trim(),password:input.value})}); }
    catch(fe){ throw (fe&&fe.name==='AbortError')?new Error('timeout'):fe; }
    finally{ clearTimeout(t); }
    status=r.status;
    let data={}; try{data=await r.json();}catch(_){}
    if(!r.ok)throw new Error(data.error_description||data.msg||data.message||data.error||`HTTP ${r.status}`);
    if(!data.access_token)throw new Error('登入回應不完整，請按下方「檢查連線」');
    saveAuthSession(data);hideReloginBanner();unlockFamilySite();input.value='';
  }catch(e){ if(err) err.textContent=loginErrorText(e,status); input.select(); }
  finally{ btn.disabled=false; btn.textContent=label; }
}
async function initAuthGate(){
  if(!CLOUD_CONFIGURED){ unlockFamilySite({offline:true}); document.body.classList.add('cloud-unconfigured'); return; }
  familyAuthSession=readAuthSession();
  const input=document.getElementById('familyGateInput');
  const btn=document.getElementById('familyGateButton');
  const offlineBtn=document.getElementById('offlineGateButton');
  const trusted=localStorage.getItem(FAMILY_TRUSTED_DEVICE_KEY)==='1';
  /* hk11：這支手機只要登入過，就一律提供「先看行程」，不會因為登入過期或網路怪怪的就整個打不開 */
  if(offlineBtn){offlineBtn.hidden=!trusted;offlineBtn.onclick=()=>{unlockFamilySite({offline:true});if(navigator.onLine)showReloginBanner();};}
  if(btn) btn.addEventListener('click',submitFamilyGate);
  if(input) input.addEventListener('keydown',e=>{ if(e.key==='Enter') submitFamilyGate(); });
  if(familyAuthSession){
    try{if(navigator.onLine)await ensureAuthToken();unlockFamilySite({offline:!navigator.onLine});return;}
    catch(e){
      /* 只是網路不通（例如連上 Wi-Fi 但沒網路）時，不能把登入清掉，否則離線就進不去 */
      const msg=String(e&&e.message||e);
      const netFail=e instanceof TypeError||/Failed to fetch|NetworkError|Load failed|network|timeout|Abort/i.test(msg);
      if(netFail&&trusted){unlockFamilySite({offline:true});return;}
      saveAuthSession(null);
      /* 登入過期：行程資料都還在這支手機上，先讓人照常看行程，頂端提示「重新登入」即可同步 */
      if(trusted){unlockFamilySite({offline:true});showReloginBanner();return;}
    }
  }
  setTimeout(()=>document.getElementById('familyGateEmail')?.focus(),80);
}
document.addEventListener('DOMContentLoaded',initAuthGate);
/* hk12：登入畫面的「檢查連線」，一步步告訴使用者卡在哪裡 */
async function runConnectionCheck(){
  const box=document.getElementById('gateCheckResult');if(!box)return;
  box.hidden=false;box.innerHTML='檢查中…';
  const rows=[];const add=(ok,t)=>{rows.push(`<li class="${ok?'ok':'bad'}">${ok?'✅':'❌'} ${t}</li>`);box.innerHTML=`<ul>${rows.join('')}</ul>`;};
  add(true,'網站版本：'+(typeof APP_VERSION!=='undefined'?APP_VERSION:'?'));
  if(!CLOUD_CONFIGURED){add(false,'config.js 沒有填 Supabase 網址或金鑰');return;}
  add(true,'Supabase 網址：'+SUPABASE_URL.replace(/^https:\/\//,''));
  if(!navigator.onLine){add(false,'這支手機目前沒有網路');return;}
  try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),12000);
    const r=await fetch(`${SUPABASE_URL}/auth/v1/settings`,{headers:{apikey:SUPABASE_ANON_KEY},signal:ctrl.signal});clearTimeout(t);
    if(r.ok)add(true,'連得到 Supabase，金鑰正確');
    else if(r.status===401||r.status===403)add(false,'Supabase 金鑰不正確（config.js 的 anon / publishable key）');
    else add(false,'Supabase 回應異常（HTTP '+r.status+'），專案可能被暫停：請到 Supabase 首頁按 Restore project');
  }catch(e){add(false,(e&&e.name==='AbortError')?'連線逾時：Supabase 專案可能被暫停（免費方案一週沒用會暫停）':'連不到 Supabase：請確認網路，或換 Wi-Fi／行動網路再試');return;}
  const sess=readAuthSession();
  add(!!sess,sess?'這支手機已登入過（'+(sess.email||'家人帳號')+'）':'這支手機還沒登入過：請輸入 Email 與密碼');
}
document.addEventListener('DOMContentLoaded',()=>{const v=document.getElementById('gateVersion');if(v&&typeof APP_VERSION!=='undefined')v.textContent='版本 '+APP_VERSION;});
/* 清除 v40 曾放在標頭中央的提示列；即使舊 HTML 被瀏覽器短暫還原也不會再顯示。 */
function removeLegacyHeaderStatus(){
  document.querySelectorAll('.header-action-row,#offlineReadyStatus,#todayModeButton').forEach(el=>el.remove());
}
removeLegacyHeaderStatus();
document.addEventListener('DOMContentLoaded',removeLegacyHeaderStatus);

/* 環線交通改為日期索引＋單張展開，避免手機一次捲過所有詳細內容。 */
function compactRouteTransportCards(){
  const grid=document.querySelector('.transport-grid'),nav=document.getElementById('transportQuickNav');
  if(!grid||!nav||grid.dataset.compacted)return;grid.dataset.compacted='1';
  const cards=[...grid.querySelectorAll('.transport-card')];
  cards.forEach((card,i)=>{
    const day=card.querySelector('.transport-day')?.textContent.trim()||`D${i+1}`;
    const body=card.querySelector(':scope > div:last-child');
    const title=body?.querySelector('h4')?.textContent.trim()||'交通提醒';
    const detail=document.createElement('details');detail.className='transport-card transport-card-compact';detail.id=`route-transport-${i}`;
    const summary=document.createElement('summary');summary.innerHTML=`<span class="transport-day">${escHtml(day)}</span><span class="transport-compact-title"><strong>${escHtml(title)}</strong><small>點擊查看提醒與官方連結</small></span><em>＋</em>`;
    const content=document.createElement('div');content.className='transport-card-body';while(body?.firstChild)content.appendChild(body.firstChild);
    detail.append(summary,content);card.replaceWith(detail);
    const chip=document.createElement('button');chip.type='button';chip.textContent=day;chip.onclick=()=>openRouteTransportCard(i);nav.appendChild(chip);
  });
}
function openRouteTransportCard(i){
  const target=document.getElementById(`route-transport-${i}`);if(!target)return;
  const sec=target.closest('details.transport-section');if(sec)sec.open=true;
  target.open=true;target.scrollIntoView({behavior:'smooth',block:'center'});
}
document.addEventListener('DOMContentLoaded',initTransportCards);

/* ============ 桌機編輯／手機旅行雙模式 ============ */
const UI_MODE_KEY='nagano_ui_mode_v1';
const PREVIEW_WIDTH_KEY='nagano_preview_width_v1';
function defaultUiMode(){return window.innerWidth>=1050?'edit':'travel';}
function setUiMode(mode,{persist=true}={}){
  const next=mode==='edit'?'edit':'travel';
  document.body.classList.toggle('mode-edit',next==='edit');
  document.body.classList.toggle('mode-travel',next==='travel');
  document.querySelectorAll('[data-ui-mode]').forEach(btn=>btn.classList.toggle('active',btn.dataset.uiMode===next));
  if(persist)try{localStorage.setItem(UI_MODE_KEY,next);}catch(e){}
  if(typeof syncHeaderControls==='function')syncHeaderControls();
}
function setPreviewWidth(width,{persist=true}={}){
  const next=Number(width)===390?390:430;
  document.documentElement.style.setProperty('--phone-preview-width',next+'px');
  document.querySelectorAll('[data-preview-width]').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.previewWidth)===next));
  if(persist)try{localStorage.setItem(PREVIEW_WIDTH_KEY,String(next));}catch(e){}
}
const savedUiMode=localStorage.getItem(UI_MODE_KEY);
setUiMode(savedUiMode||defaultUiMode(),{persist:false});
setPreviewWidth(localStorage.getItem(PREVIEW_WIDTH_KEY)||430,{persist:false});
document.addEventListener('DOMContentLoaded',()=>{
  setUiMode(localStorage.getItem(UI_MODE_KEY)||defaultUiMode(),{persist:false});
  setPreviewWidth(localStorage.getItem(PREVIEW_WIDTH_KEY)||430,{persist:false});
});


/* ============ 家人共用同步（Supabase REST） ============
   不依賴外部 Supabase SDK 或 Realtime WebSocket，避免 CDN／WebSocket
   在手機、公司或醫院網路被攔截。每 12 秒檢查一次家人更新。 */
/* ▼▼▼ 新 Supabase 專案建立後，把下面兩行換成「Project Settings → API」裡的 URL 與 anon public key ▼▼▼ */
/* 只取 https://xxxx.supabase.co 這一段：就算貼成 …/rest/v1/ 或 …/auth/v1 也能正常登入 */
const SUPABASE_URL = ((window.NAGANO_CONFIG||{}).SUPABASE_URL||"").trim().replace(/\/+$/,"").replace(/\/(rest|auth|storage)\/v1(\/.*)?$/i,"").replace(/\/+$/,"");
const SUPABASE_ANON_KEY = ((window.NAGANO_CONFIG||{}).SUPABASE_ANON_KEY||"").trim();
/* ▲▲▲ 兩行都留空時，網站以「單機預覽模式」運作：不需登入、資料只存在這台裝置 ▲▲▲ */
const CLOUD_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const SYNC_META_KEY = 'nagano_sync_meta_v3';
const SYNC_KEYS = ['nagano_notes','nagano_info_overrides','nagano_field_overrides','nagano_photos','nagano_covers','nagano_custom_spots','nagano_order','nagano_block_order','nagano_route_maps','nagano_transport_extras','nagano_foliage_maps','nagano_pack','nagano_shop','nagano_rules','nagano_docs','nagano_hidden_fixed_spots','nagano_transport_cards','nagano_eatshop','nagano_photo_pos','nagano_marks','nagano_livelinks','nagano_mama','nagano_surprises','nagano_tips_seen','nagano_eat_area','nagano_eat_plan','nagano_detail_covers','nagano_hidden_orig','nagano_transport_custom','nagano_eat_area_custom','nagano_sub_spots','nagano_spot_day','nagano_eat_area_order','nagano_todos','nagano_reviews'];
const MEDIA_SYNC_KEYS = new Set(['nagano_photos','nagano_covers','nagano_route_maps','nagano_transport_extras','nagano_foliage_maps']);
const STRUCTURED_LIST_KEYS = new Set(['nagano_shop','nagano_rules','nagano_todos','nagano_docs','nagano_transport_cards','nagano_eatshop','nagano_livelinks','nagano_surprises']);
const cloudSync = {enabled:false, starting:false, applyingRemote:false, pending:{}, timer:null, pollTimer:null, lastError:null, ready:false};
const MEDIA_BUCKET = 'trip-media';

function makeMediaPath(folder, ext='jpg'){
  const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now()+'-'+Math.random().toString(36).slice(2));
  return `${folder}/${new Date().toISOString().slice(0,10)}/${id}.${ext}`;
}
function publicMediaUrl(path){
  return `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function storageHeaders(contentType){
  return {'apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+accessToken(),'Content-Type':contentType,'x-upsert':'false'};
}
async function compressImageToBlob(file){
  if(!file.type.startsWith('image/')) return file;
  /* hk16：用 objectURL 讀圖（不再把整張大照片轉成超長文字），手機記憶體吃緊時比較不會卡住；
     讀不出來的格式（例如部分 HEIC）就直接上傳原檔 */
  const objUrl=URL.createObjectURL(file);
  let img;
  try{ img = await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=objUrl;}); }
  catch(e){ URL.revokeObjectURL(objUrl); return file; }
  setTimeout(()=>URL.revokeObjectURL(objUrl),0);
  const MAX_DIM=1600; let w=img.naturalWidth,h=img.naturalHeight;
  if(w>MAX_DIM||h>MAX_DIM){if(w>h){h=Math.round(h*MAX_DIM/w);w=MAX_DIM;}else{w=Math.round(w*MAX_DIM/h);h=MAX_DIM;}}
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; canvas.getContext('2d').drawImage(img,0,0,w,h);
  return await new Promise(resolve=>canvas.toBlob(b=>resolve(b||file),'image/jpeg',0.84));
}
async function uploadMediaBlob(blob, folder='uploads'){
  /* 單機預覽模式：圖片先以 Base64 存在這台裝置，接上 Supabase 後會自動搬到雲端 */
  if(!CLOUD_CONFIGURED) return await saveLocalMedia(blob);
  if(!navigator.onLine) throw new Error('目前離線，照片會在恢復網路後才能上傳');
  await ensureAuthToken();
  const ext=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg';
  const path=makeMediaPath(folder,ext);
  /* hk16：上傳最多等 90 秒，網路卡住時不會永遠停在「同步中」 */
  const ctrl=new AbortController();const tmo=setTimeout(()=>ctrl.abort(),90000);
  let r;
  try{ r=await fetch(`${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${path}`,{method:'POST',headers:storageHeaders(blob.type||'application/octet-stream'),body:blob,signal:ctrl.signal}); }
  catch(e){ throw (e&&e.name==='AbortError')?new Error('照片上傳逾時（網路太慢），請換個網路再試'):e; }
  finally{ clearTimeout(tmo); }
  const text=await r.text();
  if(!r.ok){
    if(/Bucket not found|not found/i.test(text)) throw new Error('Supabase Storage 尚未設定，請執行 SUPABASE_SETUP.sql');
    if(/row-level security|permission denied|Unauthorized/i.test(text)) throw new Error('Supabase Storage 上傳權限尚未設定');
    throw new Error(text||`圖片上傳失敗 HTTP ${r.status}`);
  }
  return publicMediaUrl(path);
}
async function uploadMediaFile(file, folder){
  /* hk16：任何地方上傳照片都會在畫面下方顯示「上傳中」，完成才消失 */
  window._upPending=(window._upPending||0)+1;window._upDone=window._upDone||0;
  const show=()=>{const bt=window._upBatch;const t=bt?`第 ${bt.i+1}／${bt.total} 張`:`完成 ${window._upDone}／${window._upDone+window._upPending}`;if(typeof showUploadProgress==='function')showUploadProgress(`📷 照片上傳中（${t}），請先不要關掉`);};
  show();
  try{ return await uploadMediaBlob(await compressImageToBlob(file),folder); }
  finally{ window._upPending--;window._upDone++; if(window._upPending<=0){window._upPending=0;window._upDone=0;if(typeof hideUploadProgress==='function')hideUploadProgress();} else show(); }
}
async function uploadLegacyDataUrl(dataUrl, folder){
  /* hk12：先確認這台裝置上真的找得到原檔；找不到（例如換了手機、清過瀏覽器）就不要上傳空檔案 */
  const res=await fetch(dataUrl);
  if(!res.ok)throw Object.assign(new Error('這台裝置上找不到這張舊照片的原檔'),{missingLocal:true});
  let blob=await res.blob();
  if(!blob||!blob.size)throw Object.assign(new Error('這台裝置上找不到這張舊照片的原檔'),{missingLocal:true});
  if(!/^image\//.test(blob.type||'')){
    const m=String(dataUrl).match(/^data:(image\/[a-z+.-]+)/i)||String(dataUrl).match(/\.(png|webp|jpe?g|heic|heif)(\?|$)/i);
    const t=m?(m[1].includes('/')?m[1]:'image/'+m[1].toLowerCase().replace('jpg','jpeg')):'image/jpeg';
    blob=new Blob([blob],{type:t});
  }
  return uploadMediaBlob(blob,folder);
}
function isLegacyDataUrl(v){ return typeof v==='string' && (/^data:image\//i.test(v) || (CLOUD_CONFIGURED && /(^|\/)local-media\//.test(v))); }
/* 單機預覽模式的照片：存進瀏覽器的 Cache Storage（容量比 localStorage 大很多），
   由 Service Worker 以 local-media/<id> 網址提供。接上 Supabase 後會自動搬到雲端。 */
const LOCAL_MEDIA_CACHE='nagano-local-media';
async function saveLocalMedia(blob){
  if(!('caches' in window)) return await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob);});
  const id=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));
  const ext=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg';
  const path=`local-media/${id}.${ext}`;
  const cache=await caches.open(LOCAL_MEDIA_CACHE);
  await cache.put(new URL(path,location.href).href,new Response(blob,{headers:{'Content-Type':blob.type||'image/jpeg'}}));
  return path;
}

/* 將任何深度的舊 Base64 圖片遞迴搬到 Storage。
   這同時處理景點照片、封面、路線圖、購物、規範及憑證。 */
async function migrateMediaTree(value, folder='legacy', progress=null){
  if(isLegacyDataUrl(value)){
    if(progress) progress.total++;
    /* hk12：單張失敗不會讓整個同步停住；保留原本的值（不刪除），之後還可以再試 */
    try{
      const url=await uploadLegacyDataUrl(value,folder);
      if(progress){ progress.done++; updateMigrationStatus(progress); }
      return url;
    }catch(e){
      console.warn('舊照片搬到雲端失敗，先保留原本的資料',e);
      if(progress){ progress.failed=(progress.failed||0)+1; progress.lastError=e; }
      return value;
    }
  }
  if(Array.isArray(value)){
    const out=[];
    for(let i=0;i<value.length;i++) out.push(await migrateMediaTree(value[i],`${folder}/${i}`,progress));
    return out;
  }
  if(value && typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value)){
      const safe=String(k).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)||'item';
      out[k]=await migrateMediaTree(v,`${folder}/${safe}`,progress);
    }
    return out;
  }
  return value;
}
function updateMigrationStatus(progress){
  const el=document.getElementById('cloudSyncStatus');
  if(!el)return;
  el.style.display='inline-flex';
  el.classList.add('sync-saving');
  el.textContent=`☁️ 正在搬移舊圖片 ${progress.done}/${progress.total}`;
}
function replaceLocalJson(key,value){
  const json=JSON.stringify(value);
  try{
    localStorage.removeItem(key);
    localStorage.setItem(key,json);
    return true;
  }catch(e){
    /* 本機快取滿不應阻止雲端共用；資料仍保留在記憶體與 Supabase。 */
    console.warn('本機快取空間不足，略過快取：',key,e);
    try{ localStorage.removeItem(key); }catch(_e){}
    return false;
  }
}

function syncHeaders(extra={}){ return {'apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+accessToken(),'Content-Type':'application/json',...extra}; }
function getSyncMeta(){ try{return JSON.parse(localStorage.getItem(SYNC_META_KEY))||{};}catch(e){return {};} }
function setSyncMeta(key,timestamp){const m=getSyncMeta();m[key]=timestamp||new Date().toISOString();try{localStorage.setItem(SYNC_META_KEY,JSON.stringify(m));}catch(e){}}
function localValueForKey(key){const raw=localStorage.getItem(key);if(raw==null)return null;try{return JSON.parse(raw);}catch(e){return null;}}
function isBlankSyncValue(v){if(v==null||v==='')return true;if(Array.isArray(v))return v.length===0;if(typeof v==='object')return Object.keys(v).length===0;return false;}
function mergePreservingLocal(local,remote){
  if(isBlankSyncValue(local)) return remote;
  if(isBlankSyncValue(remote)) return local;
  if(Array.isArray(local)&&Array.isArray(remote)){
    const out=[];[...local,...remote].forEach(v=>{const sig=typeof v==='string'?v:JSON.stringify(v);if(!out.some(x=>(typeof x==='string'?x:JSON.stringify(x))===sig))out.push(v);});return out;
  }
  if(typeof local==='object'&&typeof remote==='object'){
    const out={...remote};Object.keys(local).forEach(k=>{out[k]=k in remote?mergePreservingLocal(local[k],remote[k]):local[k];});return out;
  }
  return local;
}

/* ===== 三方合併（v47）=====
   v46 的「聯集合併」會讓刪除被還原：刪掉的項目、清空的欄位，會被雲端舊資料補回來。
   改成三方合併：記住「上次同步完成時的內容（base）」，再比較 本機／雲端 各自相對 base 改了什麼——
   只有一邊改就採用那一邊（包含刪除）；兩邊改不同項目就都保留；同一項目兩邊都改則以本機為準。 */
const SYNC_BASE_KEY='nagano_sync_base_v1';
function getSyncBase(){try{return JSON.parse(localStorage.getItem(SYNC_BASE_KEY))||{};}catch(e){return {};}}
function setSyncBase(key,value){
  const b=getSyncBase();b[key]=value;
  try{localStorage.setItem(SYNC_BASE_KEY,JSON.stringify(b));}
  catch(e){delete b[key];try{localStorage.setItem(SYNC_BASE_KEY,JSON.stringify(b));}catch(_e){}}
}
function sameJSON(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function elemKey(e){return (e&&typeof e==='object'&&!Array.isArray(e)&&e.id!=null)?'id:'+e.id:'j:'+JSON.stringify(e);}
function threeWayMerge(base,local,remote){
  if(sameJSON(local,remote))return local;
  if(sameJSON(local,base))return remote;
  if(sameJSON(remote,base))return local;
  const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
  if(Array.isArray(local)&&Array.isArray(remote)){
    const mapOf=arr=>{const m=new Map();(arr||[]).forEach(e=>m.set(elemKey(e),e));return m;};
    const bm=mapOf(Array.isArray(base)?base:[]),lm=mapOf(local),rm=mapOf(remote);
    const out=[],seen=new Set();
    const consider=k=>{
      if(seen.has(k))return;seen.add(k);
      const inB=bm.has(k),inL=lm.has(k),inR=rm.has(k);
      if(inL&&inR)out.push(threeWayMerge(bm.get(k),lm.get(k),rm.get(k)));
      else if(inL){if(!inB||!sameJSON(bm.get(k),lm.get(k)))out.push(lm.get(k));}
      else if(inR){if(!inB||!sameJSON(bm.get(k),rm.get(k)))out.push(rm.get(k));}
    };
    local.forEach(e=>consider(elemKey(e)));remote.forEach(e=>consider(elemKey(e)));
    return out;
  }
  if(isObj(local)&&isObj(remote)){
    const b=isObj(base)?base:{},out={};
    new Set([...Object.keys(local),...Object.keys(remote)]).forEach(k=>{
      const inL=k in local,inR=k in remote,inB=k in b;
      if(inL&&inR)out[k]=threeWayMerge(b[k],local[k],remote[k]);
      else if(inL){if(!inB||!sameJSON(b[k],local[k]))out[k]=local[k];}
      else if(inR){if(!inB||!sameJSON(b[k],remote[k]))out[k]=remote[k];}
    });
    return out;
  }
  return local;
}
function mergeForSync(key,local,remote){
  const base=getSyncBase()[key];
  const merged=(base===undefined)?mergePreservingLocal(local,remote):threeWayMerge(base,local,remote);
  return normalizeSyncValue(key,merged);
}

function stableItemId(prefix, parts){
  const text=parts.map(v=>String(v??'').trim().toLowerCase()).join('|');
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return `${prefix}-${(h>>>0).toString(36)}`;
}
function mergeUniqueUrls(a,b){
  return [...new Set([...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])].filter(Boolean))];
}
function normalizeStructuredList(key,value){
  if(!Array.isArray(value)) return value;
  const map=new Map();
  value.forEach((raw,index)=>{
    if(!raw||typeof raw!=='object') return;
    const item={...raw};
    if(key==='nagano_shop'){
      item.cat=item.cat||'supermarket';
      item.imgs=mergeUniqueUrls(item.imgs,item.img?[item.img]:[]);
      item.img=null;
      item.id=item.id||stableItemId('shop',[item.cat,item.name,item.location]);
    }else if(key==='nagano_rules'){
      item.id=item.id||stableItemId('rule',[item.title,item.text]);
      item.imgs=mergeUniqueUrls(item.imgs,item.img?[item.img]:[]);
      item.img=null;
    }else if(key==='nagano_docs'){
      item.id=item.id||stableItemId('doc',[item.ic,item.t,item.s]);
    }
    const fallback=`${key}-${index}`;
    const id=item.id||fallback;
    if(!map.has(id)){ map.set(id,item); return; }
    const prev=map.get(id);
    if(key==='nagano_rules'){
      map.set(id,{...prev,...item,imgs:mergeUniqueUrls(prev.imgs,item.imgs),img:null});
    }else if(key==='nagano_shop'){
      map.set(id,{...prev,...item,imgs:mergeUniqueUrls(prev.imgs,item.imgs),qty:Math.max(Number(prev.qty)||1,Number(item.qty)||1),checked:Boolean(prev.checked||item.checked)});
    }else{
      map.set(id,{...prev,...item,img:item.img||prev.img||null});
    }
  });
  return [...map.values()];
}
function normalizeSyncValue(key,value){
  return STRUCTURED_LIST_KEYS.has(key)?normalizeStructuredList(key,value):value;
}
function reportUploadError(err){
  const msg=friendlySyncError(err);
  if(/登入已過期/.test(msg)){
    if(confirm('⚠️ '+msg+'\n\n這台裝置上的資料都已經存好，不會遺失；重新整理後，請再重新做一次剛剛的操作。要現在重新整理嗎？'))location.reload();
    return;
  }
  alert('⚠️ '+msg+'\n'+String((err&&err.message)||err||''));
}
function friendlySyncError(e){
  let msg=String(e&&e.message||e||'未知錯誤');
  /* hk12：Supabase 回傳的 JSON 錯誤（{"statusCode":...,"error":...,"message":...}）轉成看得懂的中文，不再直接顯示原始碼 */
  try{const j=JSON.parse(msg);if(j&&typeof j==='object'){const code=String(j.statusCode||j.code||j.status||'');const t=[j.error,j.message,j.msg,j.error_description,j.hint].filter(Boolean).join(' ');
    if(/mime|content type/i.test(t)||code==='415')return '照片格式不被雲端接受（請改用 JPG／PNG）';
    if(/too large|exceed|size/i.test(t)||code==='413')return '照片太大，雲端拒收';
    if(/bucket not found/i.test(t))return '圖片雲端空間尚未設定（請在 Supabase 執行 SUPABASE_SETUP.sql）';
    if(/row-level security|unauthorized|permission/i.test(t)||code==='403'||code==='42501')return '雲端權限尚未設定（請在 Supabase 執行 SUPABASE_SETUP.sql）';
    if(/jwt|token|expired/i.test(t)||code==='401')return '登入已過期，請重新登入';
    if(/does not exist|PGRST205|42P01/i.test(t+code))return '尚未建立 nagano_sync 資料表（請在 Supabase 執行 SUPABASE_SETUP.sql）';
    msg=(t||('錯誤代碼 '+code)).slice(0,60);}}catch(_){}
  if(/Failed to fetch|NetworkError/i.test(msg)) return '無法連上雲端資料庫';
  if(/relation.*nagano_sync.*does not exist|PGRST205/i.test(msg)) return '尚未建立 nagano_sync 資料表';
  if(/row-level security|permission denied|42501/i.test(msg)) return 'Supabase 權限尚未設定';
  if(/Storage 尚未設定|Bucket not found/i.test(msg)) return '圖片雲端空間尚未設定';
  if(/Storage 上傳權限/i.test(msg)) return '圖片雲端上傳權限尚未設定';
  if(/quota|exceed/i.test(msg)) return '本機快取空間不足，但雲端同步仍會繼續';
  if(/already used|invalid refresh token/i.test(msg)) return '登入資訊過期，請重新整理頁面；剛剛的內容請重新操作一次。';
  if(/JWT|apikey|401|403/i.test(msg)) return 'Supabase 金鑰或權限錯誤';
  return msg.slice(0,80);
}
async function restGetRows(){
  await ensureAuthToken();
  const r=await fetch(`${SUPABASE_URL}/rest/v1/nagano_sync?select=key,value,updated_at`,{headers:syncHeaders(),cache:'no-store'});
  const text=await r.text(); if(!r.ok) throw new Error(text||`HTTP ${r.status}`); return text?JSON.parse(text):[];
}
async function restGetRow(key){
  await ensureAuthToken();
  const r=await fetch(`${SUPABASE_URL}/rest/v1/nagano_sync?key=eq.${encodeURIComponent(key)}&select=key,value,updated_at`,{headers:syncHeaders(),cache:'no-store'});
  const text=await r.text(); if(!r.ok) throw new Error(text||`HTTP ${r.status}`);
  const rows=text?JSON.parse(text):[]; return rows[0]||null;
}
/* 改為讓資料庫（而非各裝置的時鐘）決定 updated_at：
   1) 這裡不再送出用戶端時間，改由資料庫觸發器 nagano_sync_touch_updated_at 蓋掉；
   2) 用 return=representation 讀回資料庫真正寫入的 updated_at，回傳給呼叫端記錄，
   避免手機時鐘不準（快、慢或時區設定錯誤）造成「明明比較新卻被判定成舊資料而被覆蓋／消失」。
   舊的 updatedAt 參數仍接受，但只作為找不到觸發器時的備援，不影響有安裝 SUPABASE_SETUP.sql 的家人。 */
async function restUpsert(key,valueObj,updatedAt){
  await ensureAuthToken();
  const r=await fetch(`${SUPABASE_URL}/rest/v1/nagano_sync?on_conflict=key`,{method:'POST',headers:syncHeaders({'Prefer':'resolution=merge-duplicates,return=representation'}),body:JSON.stringify({key,value:JSON.stringify(valueObj),updated_at:updatedAt||new Date().toISOString()})});
  const text=await r.text(); if(!r.ok) throw new Error(text||`HTTP ${r.status}`);
  const rows=text?JSON.parse(text):[];
  return rows[0]?.updated_at || updatedAt || new Date().toISOString();
}
async function initCloudSync(){
  updateSyncStatus(null,'connecting');
  try{
    cloudSync.enabled=true;
    await reconcileInitialCloudData();
    cloudSync.ready=true; cloudSync.lastError=null; updateSyncStatus();
    clearInterval(cloudSync.pollTimer); cloudSync.pollTimer=setInterval(pollCloudChanges,12000);
  }catch(e){cloudSync.enabled=false;cloudSync.lastError=e;console.error('家人同步初始化失敗：',e);updateSyncStatus(e);throw e;}
}
/* 開啟網站時的第一次對帳。
   舊版邏輯是「時間比較新的整包蓋掉舊的」，只要某台裝置離線編輯過、或系統時間不準，
   就可能讓一整個分類（例如所有筆記、所有自訂景點）被另一台裝置的舊資料整包蓋掉，
   使用者會覺得「資料同步後消失了」。
   新版一律採用「合併」而非「整包覆蓋」：物件／陣列類的資料會把本機與雲端內容聯集起來，
   再把合併結果同時寫回本機與雲端，兩邊就會收斂成同一份、且不會平白遺失任一邊獨有的內容。
   時間戳也一律以資料庫寫回的時間為準，不再用各裝置自己的時鐘互相比較。 */
async function reconcileInitialCloudData(){
  const rows=await restGetRows();
  const remoteMap=new Map(rows.map(r=>[r.key,r]));
  for(const key of SYNC_KEYS){
    const remote=remoteMap.get(key);
    const localRaw=localStorage.getItem(key);
    let localValue=null, remoteValue=null;
    try{ if(localRaw!=null) localValue=JSON.parse(localRaw); }catch(e){}
    try{ if(remote) remoteValue=JSON.parse(remote.value); }catch(e){}

    if(MEDIA_SYNC_KEYS.has(key)){
      const progress={done:0,total:0};
      if(localValue!=null) localValue=await migrateMediaTree(localValue,`legacy/local/${key}`,progress);
      if(remoteValue!=null) remoteValue=await migrateMediaTree(remoteValue,`legacy/cloud/${key}`,progress);
    }

    let merged;
    if(localValue!=null && remoteValue!=null) merged=mergeForSync(key,localValue,remoteValue);
    else if(localValue!=null) merged=normalizeSyncValue(key,localValue);
    else if(remoteValue!=null) merged=normalizeSyncValue(key,remoteValue);
    else continue;

    cloudSync.applyingRemote=true;
    try{ replaceLocalJson(key,merged); applyStoreUpdate(key,JSON.stringify(merged)); }
    finally{ cloudSync.applyingRemote=false; }
    /* hk12：某一類寫入失敗時不讓整個同步停住，先放進待送清單稍後重試 */
    try{
      const serverTime=await restUpsert(key,merged);
      setSyncMeta(key,serverTime);setSyncBase(key,merged);
    }catch(e){console.warn('初次同步寫入失敗，稍後重試',key,e);cloudSync.pending[key]=merged;cloudSync.lastError=e;}
  }
  if(hasPendingCloudPush()){clearTimeout(cloudSync.timer);cloudSync.timer=setTimeout(flushCloudPush,3000);}
}

async function pollCloudChanges(){
  if(!navigator.onLine||cloudSync.applyingRemote)return;
  try{const rows=await restGetRows();rows.forEach(applyRemoteRow);cloudSync.lastError=null;cloudSync.lastOk=Date.now();updateSyncStatus();}
  catch(e){cloudSync.lastError=e;updateSyncStatus(e);}
}

/* 背景同步不得打斷任何正在輸入的表單。
   遠端資料會先排隊，等輸入框失焦後再一次套用。 */
const deferredRemoteRows = new Map();
let deferredRemoteTimer = null;
function isUserEditingForm(){
  const a=document.activeElement;
  if(!a) return false;
  if(a.matches && a.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select, [contenteditable="true"]')) return true;
  return false;
}
/* 除了「目前正聚焦」的欄位外，任何還開著、尚未送出的表單（例如「評論與資訊」新增框、
   景點編輯框、打包清單新增框）也算「使用者正在編輯」，即使手機鍵盤造成短暫失焦，
   也不能被背景同步強制重繪清空。 */
function isAnyComposerOpen(){
  if(isUserEditingForm()) return true;
  if(document.querySelector('.note-edit-area[style*="display: block"], .note-edit-area[style*="display:block"]')) return true;
  if(document.querySelector('[id^="spot-edit-short-"], [id^="spot-edit-full-"], .transport-extra-form:focus-within')) return true;
  if(document.getElementById('spotEditModal')?.classList.contains('active')) return true;
  if(document.getElementById('formModal')||document.getElementById('photoPosModal')||document.getElementById('mamaModal')) return true;
  if(typeof isPackComposerEditing==='function' && isPackComposerEditing()) return true;
  return false;
}
function queueRemoteRow(row){
  if(!row||!row.key)return;
  const prev=deferredRemoteRows.get(row.key);
  if(!prev || Date.parse(prev.updated_at||0)<=Date.parse(row.updated_at||0)) deferredRemoteRows.set(row.key,row);
}
function flushDeferredRemoteRows(){
  clearTimeout(deferredRemoteTimer);
  deferredRemoteTimer=setTimeout(()=>{
    if(isAnyComposerOpen()||!deferredRemoteRows.size)return;
    const rows=[...deferredRemoteRows.values()];
    deferredRemoteRows.clear();
    rows.forEach(r=>applyRemoteRow(r,true));
  },280);
}
document.addEventListener('focusout',flushDeferredRemoteRows,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')flushDeferredRemoteRows();},true);

function applyRemoteRow(row, forceApply=false){
  if(!row||typeof row.value==='undefined')return;
  if(!forceApply && isAnyComposerOpen()){ queueRemoteRow(row); return; }
  if(cloudSync.pending&&Object.prototype.hasOwnProperty.call(cloudSync.pending,row.key))return; /* 本機有尚未送出的變更，等推送時再合併 */
  const rt=row.updated_at||new Date().toISOString(), lt=getSyncMeta()[row.key];
  /* 用 >= 而非 >：自己剛推送出去、又被下一次輪詢讀回來的「回聲」時間戳會完全相同，
     不需要（也不應該）再觸發一次整區重繪。 */
  if(lt&&Date.parse(lt)>=Date.parse(rt))return;
  let pushBack=null;
  cloudSync.applyingRemote=true;
  try{
    let remote;try{remote=JSON.parse(row.value);}catch(e){remote=null;}
    if(remote==null)return; /* 雲端內容壞掉／空白時，絕不拿來覆蓋本機資料 */
    const remoteN=normalizeSyncValue(row.key,remote);
    let value=remoteN;
    /* hk11：本機若有「還沒同步上去」的變更（和上次同步完成時的內容不同），
       先和雲端版本合併，再把合併結果送回雲端，而不是直接用雲端版本整包蓋掉。 */
    const local=localValueForKey(row.key);
    if(local!=null){
      const localN=normalizeSyncValue(row.key,local),base=getSyncBase()[row.key];
      if(!sameJSON(localN,base)&&!sameJSON(localN,remoteN)){
        value=mergeForSync(row.key,localN,remoteN);
        if(!sameJSON(value,remoteN))pushBack=value;
      }
    }
    replaceLocalJson(row.key,value);setSyncMeta(row.key,rt);setSyncBase(row.key,remoteN);applyStoreUpdate(row.key,JSON.stringify(value));
  }catch(e){console.error('套用家人資料失敗',e);pushBack=null;}finally{cloudSync.applyingRemote=false;}
  if(pushBack)scheduleCloudPush(row.key,pushBack);
}
/* 若目前有任何未送出的編輯表單開著，先記下「稍後要重繪」，
   等表單關閉／送出後再統一補畫一次，避免蓋掉使用者還沒儲存的內容。 */
window._dayRemoteRenderPending = false;
function safeRenderDayContent(){
  if(isAnyComposerOpen()){ window._dayRemoteRenderPending=true; return; }
  window._dayRemoteRenderPending=false;
  if(typeof renderDayContent==='function') renderDayContent();
}
function flushPendingDayRender(){
  if(window._dayRemoteRenderPending && !isAnyComposerOpen()){
    window._dayRemoteRenderPending=false;
    if(typeof renderDayContent==='function') renderDayContent();
  }
}
function applyStoreUpdate(key,jsonStr){
  let parsed;try{parsed=JSON.parse(jsonStr);}catch(e){return;}
  switch(key){case'nagano_notes':notesStore=parsed;break;case'nagano_info_overrides':infoOverrideStore=parsed||{};break;case'nagano_field_overrides':fieldOverrideStore=parsed||{};break;case'nagano_photos':photoStore=parsed;break;case'nagano_covers':coverStore=parsed;break;case'nagano_custom_spots':customSpotsStore=parsed;break;case'nagano_order':orderStore=parsed;break;case'nagano_block_order':blockOrderStore=parsed;break;case'nagano_route_maps':routeMapStore=parsed;break;case'nagano_transport_extras':transportExtrasStore=parsed||{};break;case'nagano_foliage_maps':foliageMapStore=Array.isArray(parsed)?parsed:[];renderFoliageMaps();return;case'nagano_pack':packData=migratePackCategoryNames(parsed);window._packLive=packData;if(isPackComposerEditing()){window._packRemoteRenderPending=true;}else{renderPackList();}return;case'nagano_shop':shopData=normalizeStructuredList('nagano_shop',parsed);renderShopList();return;case'nagano_rules':rulesData=normalizeStructuredList('nagano_rules',parsed);renderRulesList();return;case'nagano_docs':docsData=mergeDocsWithDefaults(parsed);persistDocs();renderDocsList();return;case'nagano_transport_cards':transportCardsData=normalizeStructuredList('nagano_transport_cards',parsed);renderTransportCards();return;case'nagano_eatshop':eatShopStore=normalizeStructuredList('nagano_eatshop',parsed);if(typeof activeDay==='string')renderDayContent();return;case'nagano_photo_pos':photoPosStore=parsed||{};safeRenderDayContent();return;case'nagano_marks':marksStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};renderMarksBar();safeRenderDayContent();return;case'nagano_livelinks':liveData=normalizeStructuredList('nagano_livelinks',parsed);renderLive();return;case'nagano_surprises':surprisesData=normalizeStructuredList('nagano_surprises',parsed);renderSurpriseAdmin();return;case'nagano_tips_seen':tipsSeen=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};return;case'nagano_transport_custom':transportCustomStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_detail_covers':detailCoverStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_hidden_orig':hiddenOrigStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_eat_plan':eatPlanStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_eat_area':eatAreaStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};if(typeof activeDay==='string')safeRenderDayContent();return;case'nagano_mama':mamaStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};refreshMamaButtons(null);if(document.getElementById('mamaModal'))renderMamaList();return;case'nagano_hidden_fixed_spots':hiddenFixedSpotsStore=parsed||{};safeRenderDayContent();if(typeof updateSpotCount==='function')updateSpotCount();return;case'nagano_sub_spots':subSpotStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_eat_area_custom':eatAreaCustom=Array.isArray(parsed)?parsed:[];safeRenderDayContent();return;case'nagano_spot_day':spotDayStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};renderDayChips();safeRenderDayContent();return;case'nagano_reviews':reviewStore=(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))?parsed:{};safeRenderDayContent();return;case'nagano_todos':todoData=normalizeStructuredList('nagano_todos',parsed);renderTodos();return;case'nagano_eat_area_order':eatAreaOrder=Array.isArray(parsed)?parsed:[];safeRenderDayContent();return;default:return;}
  safeRenderDayContent();if(typeof updateSpotCount==='function')updateSpotCount();
}
function scheduleCloudPush(key,valueObj){
  /* 注意：這裡不再提前把 syncMeta 設成「現在」的用戶端時間。
     舊版一按下編輯就先寫入本機時間戳，若這台裝置的時鐘比家人的快，
     之後家人真正較新的更新反而會被誤判成「比較舊」而被忽略，
     於是這台裝置就會停在自己剛剛的版本、看起來跟家人的不一樣。
     現在改成：真正寫入資料庫成功、拿到資料庫回傳的時間後，才更新 syncMeta（見 flushCloudPush）。 */
  if(!cloudSync.enabled||cloudSync.applyingRemote)return;
  cloudSync.pending[key]=valueObj;
  clearTimeout(cloudSync.timer);cloudSync.timer=setTimeout(flushCloudPush,700);updateSyncStatus(null,'saving');
}
async function flushCloudPush(){
  if(cloudSync.flushing){clearTimeout(cloudSync.timer);cloudSync.timer=setTimeout(flushCloudPush,800);return;}
  const entries=Object.entries(cloudSync.pending);cloudSync.pending={};
  if(!entries.length)return;
  cloudSync.flushing=true;
  try{
  for(let ei=0;ei<entries.length;ei++){const[key,localSnapshot]=entries[ei];
    try{
      /* 推送前先讀一次雲端目前的版本，和這台裝置要送出的內容做合併（聯集），
         而不是直接整包覆蓋過去。這樣就算家人在你按下儲存前的一兩秒內，
         剛好也改了同一分類裡的「不同項目」，兩邊的變更都會保留，
         不會有一邊的資料在同步後憑空消失。 */
      let mergedValue=localSnapshot;
      /* hk11：讀不到雲端目前版本時不再「直接用本機版本蓋過去」（那樣可能把家人剛加的資料蓋掉），
         改成整批保留、稍後自動重試。 */
      const remoteRow=await restGetRow(key);
      if(remoteRow){
        let remoteValue=null; try{remoteValue=JSON.parse(remoteRow.value);}catch(e){}
        if(remoteValue!=null) mergedValue=mergeForSync(key,localSnapshot,remoteValue);
      }
      const serverTime=await restUpsert(key,mergedValue);
      if(JSON.stringify(mergedValue)!==JSON.stringify(localSnapshot)){
        /* 合併後比本機原本的內容多了家人那邊的東西，寫回本機讓這台裝置也看得到 */
        cloudSync.applyingRemote=true;
        try{ replaceLocalJson(key,mergedValue); applyStoreUpdate(key,JSON.stringify(mergedValue)); }
        finally{ cloudSync.applyingRemote=false; }
      }
      setSyncMeta(key,serverTime);setSyncBase(key,mergedValue);
      cloudSync.lastError=null;
    }catch(e){
      cloudSync.lastError=e;console.error('同步寫入失敗',e);updateSyncStatus(e);
      /* hk11：寫入失敗（離線、網路不穩、登入過期）時，把這一筆與後面還沒送出的全部放回待送清單，
         之後自動重試；期間背景輪詢不會用雲端舊資料蓋掉這些尚未送出的變更。 */
      entries.slice(ei).forEach(([k,v])=>{if(!Object.prototype.hasOwnProperty.call(cloudSync.pending,k))cloudSync.pending[k]=v;});
      cloudSync.retryDelay=Math.min((cloudSync.retryDelay||2500)*2,60000);
      clearTimeout(cloudSync.timer);cloudSync.timer=setTimeout(flushCloudPush,cloudSync.retryDelay);
      return;
    }
  }
  }finally{cloudSync.flushing=false;}
  cloudSync.retryDelay=0;
  cloudSync.lastOk=Date.now();updateSyncStatus();setTimeout(pollCloudChanges,500);
}
function hasPendingCloudPush(){return Object.keys(cloudSync.pending||{}).length>0;}
/* 切到背景、關閉 App 或恢復網路時，馬上把還沒送出的變更送出去 */
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&cloudSync.enabled&&hasPendingCloudPush()){clearTimeout(cloudSync.timer);flushCloudPush();}});
window.addEventListener('pagehide',()=>{if(cloudSync.enabled&&hasPendingCloudPush()){clearTimeout(cloudSync.timer);flushCloudPush();}});
window.addEventListener('online',()=>{if(cloudSync.enabled&&hasPendingCloudPush()){cloudSync.retryDelay=0;clearTimeout(cloudSync.timer);cloudSync.timer=setTimeout(flushCloudPush,800);}});
function updateSyncStatus(err,state){
  const el=document.getElementById('cloudSyncStatus');if(!el)return;el.style.display='inline-flex';document.body.classList.add('has-sync');el.classList.toggle('sync-error',!!err);el.classList.toggle('sync-saving',state==='saving'||state==='connecting');
  if(err){el.textContent='⚠️ '+friendlySyncError(err);el.title=String(err&&err.message||err);el.onclick=()=>{if(confirm('⚠️ 同步遇到問題：\n'+friendlySyncError(err)+'\n\n你的資料都還存在這支手機上，不會遺失。\n要現在重新連線嗎？')){cloudSync.ready=false;cloudSync.enabled=false;startFamilyCloud();}};}
  else if(state==='connecting')el.textContent='☁️ 連線中';else if(state==='saving')el.textContent='☁️ 同步中';else el.textContent='☁️ 已同步';
  if(!err)el.onclick=null;
}
/* ============ HEADER IMAGES ============ */
const headerBgs = [];
/* 標頭改用專屬插畫（images/header.webp），不再隨機載入外部圖片 */

function loadLocalMap(e){
  const f = e.target.files[0];
  if(f){
    document.getElementById('handDrawnMapImg').src = URL.createObjectURL(f);
    document.getElementById('handDrawnMapImg').style.display = 'block';
    document.getElementById('mapFallback').style.display = 'none';
  }
}

/* ============ DATA ============ */
const CAT_SCRIM={food:'37,31,49',attraction:'31,53,46',shopping:'52,44,70',hotel:'46,63,57',activity:'33,61,52',transport:'35,57,50'};
const CAT = {
  food:{label:'美食', cls:'cat-food', emoji:'🍽️'},
  activity:{label:'活動／步道', cls:'cat-activity', emoji:'🥾'},
  shopping:{label:'購物', cls:'cat-shopping', emoji:'🛍️'},
  attraction:{label:'景點', cls:'cat-attraction', emoji:'🏞️'},
  hotel:{label:'住宿', cls:'cat-hotel', emoji:'🏨'},
  transport:{label:'交通', cls:'cat-transport', emoji:'✈️'},
};

function S(name, cat, desc, opts={}){
  return Object.assign({name, cat, desc, tags:[], park:null, tip:null, dur:null, note:null, link:null, linkLabel:'查看網頁', img:null, hours:null, docMap:null, customInfo:null, recDishes:null, fullDesc:null}, opts);
}

/* ============ 長野春旅：每日行程（Lomä 山湖版／藤井莊溪谷版） ============
   days 共 14 筆：0–2 兩版共用（高崎三天），3–6 是 Lomä 版 4/27–4/30，7–10 是藤井莊版 4/27–4/30，11–13 兩版共用（橫濱與羽田）。
   兩版各自用不同的 dayIdx，所以兩版的筆記、照片、自訂景點不會互相蓋到；切換版本只是換顯示哪 10 天。
   每日鐘點為建議節奏，車程為估算，不是已訂班次。2027 花況、活動、票價、開山及班表需出發前確認。 */
const PLAN_KEY='nagano_plan_v1';
const PLANS={
  loma:{label:'Lomä 山湖版',short:'Lomä 山湖版',theme:'山湖慢住・妙高・戶隱・小布施',stay:'黑姬 Lomä 連住 2 晚',note:'黑姬 Lomä 連住 2 晚，含妙高半日；4/29 戶隱、4/30 小布施。',overview:'images/overview-loma.webp',days:[0,1,2,3,4,5,6,11,12,13]},
  fujiiso:{label:'藤井莊溪谷版',short:'藤井莊溪谷版',theme:'溪谷慢住・山田溫泉・小布施・戶隱',stay:'山田溫泉 藤井莊 連住 2 晚',note:'山田溫泉藤井莊連住 2 晚，不排妙高；4/29 小布施、4/30 戶隱。',overview:'images/overview-fujiiso.webp',days:[0,1,2,7,8,9,10,11,12,13]}
};
let PLAN=(()=>{try{const v=localStorage.getItem(PLAN_KEY);return PLANS[v]?v:'loma';}catch(e){return 'loma';}})();
function planDays(){return PLANS[PLAN].days;}
function inPlan(i){return planDays().includes(Number(i));}
function prevPlanDay(i){const a=planDays(),k=a.indexOf(Number(i));return k>0?a[k-1]:-1;}
function isLastPlanDay(i){const a=planDays();return a[a.length-1]===Number(i);}
const SCENE=Object.fromEntries(Array.from({length:14},(_,i)=>['d'+i,`images/scene-day${String(i).padStart(2,'0')}.webp`]));
const H_TAKASAKI='高崎站周邊飯店（待訂）', H_LOMA='Lomä（黑姬・信濃町）', H_FUJII='緑霞山宿 藤井荘（山田溫泉）', H_NAGANO='長野站周邊飯店（待訂）', H_YOKO='橫濱站周邊飯店（待訂）';
const hotel=(name,desc,img,opts={})=>S(name,'hotel',desc,Object.assign({img},opts));
const TAKASAKI_HOTEL=(desc,first)=>hotel(H_TAKASAKI,desc,SCENE.d0,Object.assign({mapQuery:'高崎駅',fullDesc:'選高崎站步行約 5 至 10 分鐘範圍，帶行李與搭新幹線都方便；4/26 取還車也在車站附近。訂房時比對取消條款。'},first?{tags:['連住3晚']}:{}));
const NAGANO_HOTEL=(desc,first)=>hotel(H_NAGANO,desc,SCENE.d5,Object.assign({mapQuery:'長野駅',fullDesc:'選長野站步行約 5 至 10 分鐘範圍。這兩晚還有租車，訂房時確認飯店有停車場與停車費；5/1 早上直接搭新幹線。'},first?{tags:['連住2晚']}:{}));
const YOKO_HOTEL=(desc,first)=>hotel(H_YOKO,desc,SCENE.d11,Object.assign({mapQuery:'横浜駅',fullDesc:'最後兩晚首選橫濱站步行範圍，吃飯購物、搭 JR 去 Outlet、搭京急去羽田都方便；重視港景才改住港未來，但多一次接駁。'},first?{tags:['連住2晚']}:{}));
const LOMA_HOTEL=(desc,first)=>hotel(H_LOMA,desc,SCENE.d3,Object.assign({mapQuery:'Lomä 信濃町',link:'https://loma-hotels.com/access/',linkLabel:'Lomä 交通',fullDesc:'官方提供自駕路線，信濃町 IC 至飯店約 7 分鐘。訂房先確認 4/27 與 4/28 兩晚都有房、晚餐是否包含與用餐時段、設施是否要預約，以及停車安排。設施以實際房型與方案為準。'},first?{tags:['連住2晚']}:{}));
const FUJII_HOTEL=(desc,first)=>hotel(H_FUJII,desc,SCENE.d7,Object.assign({mapQuery:'緑霞山宿 藤井荘',link:'https://fujiiso.co.jp/',linkLabel:'藤井莊官網',fullDesc:'山田溫泉的溪谷溫泉旅館。官方目前列免費停車、無須預約，停車使用時段 15 時至 11 時；連住期間白天進出或提前到達，先向旅館確認。訂房確認兩晚餐食是否有變化、午餐是否提供。'},first?{tags:['連住2晚']}:{}));
const TOGAKUSHI_LINK={link:'https://togakushi-21.jp/',linkLabel:'戶隱觀光・開山消息'};
const OBUSE_LINK={link:'https://www.obusekanko.jp/season',linkLabel:'小布施季節花況'};
const days = [
/* 0 */ {dayNum:"1",date:"4/24",weekday:"六",region:"成田 → 高崎",enRegion:"成田機場 → 東京站 → 高崎",drive:"🚄 成田Express＋新幹線，約 2.5–3.5 小時",title:"往山的方向去",dayDesc:"列車穿過陌生的城鎮，小羚羊的背包裡裝著十天的期待。",wear:"機上薄外套；4 月下旬早晚約 10°C 上下，帶一件保暖外套",weatherIco:"✈️",spots:[
    S("台灣 → 成田（航班待訂）","transport","成田機場入境，預留入境與領行李約 90–120 分鐘。",{tags:["成田進"],fullDesc:"成田進、羽田出通常要用多城市方式購票；若維持華航，可優先比桃園至成田與羽田至松山的組合。2027 實際班表及票價公布後再定。以中午或下午早段抵達為佳；若是晚班機抵達，第一晚改住東京站附近，隔天早上再去高崎，並取消部分 4/25 的活動。",img:SCENE.d0}),
    S("高崎站周邊・車站商場","activity","放好行李，只逛車站商場與附近晚餐，當天不取車。",{tags:["輕鬆"],dur:"傍晚",fullDesc:"第一天以平安抵達為主，不安排賞花或體驗。住高崎站步行範圍，放行李後在車站商場與附近找晚餐，早點休息。",mapQuery:"高崎駅",img:SCENE.d0})
  ],moreSpots:[
    TAKASAKI_HOTEL("高崎站步行範圍，連住 3 晚。",true)
  ]},
/* 1 */ {dayNum:"2",date:"4/25",weekday:"日",region:"高崎・達摩彩繪",enRegion:"少林山達磨寺・達摩彩繪",drive:"🚕 計程車或公車串接寺院與工房，不租車",title:"願望要畫上眼睛",dayDesc:"小羚羊握起畫筆，想了好久，才決定把願望藏在哪裡。",wear:"洋蔥式穿搭；寺院有階梯，穿好走的鞋",weatherIco:"🎎",spots:[
    S("少林山達磨寺","attraction","緣起達摩的發源寺，09:30 出發，留約 60–90 分鐘。",{tags:["09:30"],dur:"約60–90分鐘",fullDesc:"搭計程車或適用班次的公車前往。當天是週日，寺院與體驗不要排得太緊。",mapQuery:"少林山達磨寺",img:SCENE.d1}),
    S("高崎義大利麵／群馬地方料理","food","11:30 午餐，吃高崎義大利麵或群馬地方料理。",{tags:["11:30","午餐"],fullDesc:"高崎有「義大利麵之城」的稱號，車站周邊與市區都有老店；也可以選群馬的地方料理。",mapQuery:"高崎 パスタ",img:SCENE.d1}),
    S("達摩彩繪體驗","activity","13:30 開始，預留約 1–1.5 小時，替自己的達摩畫上眼睛。",{tags:["13:30","需預約"],dur:"約1–1.5小時",fullDesc:"候選工房為大門屋或今井だるま店 NAYA。先確認成人方案、日期、預約方式及當日是否營業。沒有訂到體驗就保留咖啡與散步，不額外塞入遠距景點。",link:"https://www.takasaki-kankoukyoukai.or.jp/?p=7469",linkLabel:"達摩彩繪體驗",mapQuery:"大門屋 高崎",img:SCENE.d1}),
    S("高崎市區咖啡・逛店","activity","15:30 以後回高崎市區喝咖啡、逛店，晚餐後早休息。",{tags:["15:30"],fullDesc:"以計程車串接寺院與工房，避免為這一天多租一整天車。",mapQuery:"高崎駅",img:SCENE.d1})
  ],moreSpots:[
    TAKASAKI_HOTEL("高崎第 2 晚，續住。")
  ]},
/* 2 */ {dayNum:"3",date:"4/26",weekday:"一",region:"藤岡・紫藤",enRegion:"高崎取車 → 藤岡 ふじの咲く丘",drive:"🚗 租車 1 天：高崎取車、藤岡賞藤、傍晚高崎還車",title:"今天，風是紫色的",dayDesc:"小羚羊抬起頭，發現春天正從藤棚上輕輕落下。",wear:"花棚下有日照，帶帽子與薄外套",weatherIco:"💜",spots:[
    S("藤岡 ふじの咲く丘","attraction","藤棚與不同品種的紫藤，上午留約 2 小時。",{tags:["紫藤","花況待確認"],dur:"約2小時",fullDesc:"例年見頃約 4 月下旬至 5 月上旬或中旬，4/26 是否盛開要看 2027 花況；平日早段是比較能避開人潮的安排。若當天大雨而 4/25 天氣較好，可以把紫藤與彩繪日互換，但週日賞花可能較多人。",link:"https://fujioka-kanko.net/spot/fujinosakuoka",linkLabel:"藤岡紫藤與開花資訊",mapQuery:"ふじの咲く丘",img:SCENE.d2}),
    S("藤岡午餐","food","賞完紫藤在藤岡附近吃午餐。",{tags:["午餐"],fullDesc:"午餐後擇一：去道之驛ららん藤岡買地方點心，或直接回高崎喝咖啡。不要另外插入遠距景點。",mapQuery:"藤岡市 ランチ",img:SCENE.d2}),
    S("道の駅 ららん藤岡","shopping","可選：買地方點心與農產品。",{tags:["可選"],dur:"約30–60分鐘",fullDesc:"想休息就省略，直接回高崎。",mapQuery:"道の駅 ららん藤岡",img:SCENE.d2})
  ],moreSpots:[
    TAKASAKI_HOTEL("高崎第 3 晚，16–17 時還車後回飯店整理行李。")
  ]},
/* 3 Lomä */ {plan:'loma',dayNum:"4",date:"4/27",weekday:"二",region:"長野 → Lomä",enRegion:"高崎 → 長野取車 → 黑姬 Lomä",drive:"🚄 北陸新幹線到長野，取車開往黑姬（租車 4 天）",title:"在山腳住下來",dayDesc:"放好背包，推開窗，今天剩下的時間都留給遠山。",wear:"山區比長野市區涼，傍晚加外套",weatherIco:"🏔️",spots:[
    S("長野站周邊午餐","food","11 時左右長野站取車後，先午餐與補充飲水。",{tags:["午餐"],fullDesc:"取車後再出發往黑姬與信濃町方向，長野至 Lomä 抓約 50–70 分鐘（一般路況估算）。",mapQuery:"長野駅",img:SCENE.d3}),
    S("野尻湖","attraction","可選：距離入住尚早時，找咖啡或短暫看湖，停留不超過 1 小時。",{tags:["可選"],dur:"1小時內",fullDesc:"依飯店確認的入住時間抵達即可，野尻湖只是順路的小停留。野尻湖曾出土諾曼象化石，湖畔有博物館。",mapQuery:"野尻湖",img:SCENE.d3})
  ],moreSpots:[
    LOMA_HOTEL("連住第 1 晚，下午與晚上留給房間、山景與飯店餐飲。",true)
  ]},
/* 4 Lomä */ {plan:'loma',dayNum:"5",date:"4/28",weekday:"三",region:"妙高・いもり池",enRegion:"Lomä → いもり池 → Lomä",drive:"🚗 單程約 25–40 分鐘，只有半日外出",title:"湖裡還住著一座山",dayDesc:"水面很安靜，小羚羊也放輕腳步，怕碰碎山的倒影。",wear:"池邊海拔較高，早上偏冷；步道可能潮濕",weatherIco:"🪞",spots:[
    S("いもり池","attraction","09:30 出發，看妙高山與湖面倒影，散步約 45–60 分鐘。",{tags:["09:30","妙高山"],dur:"約45–60分鐘",fullDesc:"天氣好時水面會映出整座妙高山。春季水芭蕉是否可看，依當年融雪與花況而定。妙高山被雲遮住或天氣差，就留在飯店，另選野尻湖附近的短程咖啡。",mapQuery:"いもり池",img:SCENE.d4}),
    S("池の平／赤倉 午餐","food","在池の平或赤倉方向選一家餐廳。",{tags:["午餐"],fullDesc:"只有半日外出，不另外繞高山道路。",mapQuery:"池の平温泉",img:SCENE.d4}),
    S("回 Lomä 休息","activity","14–15 時回飯店，下午休息、拍照與使用已確認的飯店設施。",{tags:["慢住"],fullDesc:"Lomä 適合租車前往，車子在連住期間保留，不用每天開一整天。",mapQuery:"Lomä 信濃町",img:SCENE.d3})
  ],moreSpots:[
    LOMA_HOTEL("連住第 2 晚，續住。")
  ]},
/* 5 Lomä */ {plan:'loma',dayNum:"6",date:"4/29",weekday:"四",region:"戶隱 → 長野",enRegion:"Lomä → 戶隱 → 長野",drive:"🚗 Lomä 至戶隱約 45–60 分鐘；昭和之日預留排隊與停車",title:"杉木爺爺的長長走廊",dayDesc:"走進高高的樹林，風從頭頂經過，腳步聲留在身後。",wear:"杉林裡陰涼，可能有殘雪與泥濘，穿防滑好走的鞋",weatherIco:"🌲",spots:[
    S("戶隱神社 中社","attraction","09 時出發，首選中社與周邊短遊。",{tags:["國定假日"],dur:"約1小時",fullDesc:"今天是昭和之日，預留排隊與停車緩衝；山路與交通狀況會影響時間。戶隱神社由奧社、中社、寶光社、九頭龍社、火之御子社五社組成。",mapQuery:"戸隠神社 中社",...TOGAKUSHI_LINK,img:SCENE.d5}),
    S("奧社參道・隨神門・杉木並木","activity","可選：參道開放、雪況與鞋具都適合才走，往返約 1.5–2 小時。",{tags:["看開山資訊"],dur:"約1.5–2小時",fullDesc:"杉木並木的樹齡據說約 400 年。春季可能殘雪、泥濘或尚未開山，需看 2027 公告；不把走完整條奧社路線當必達。",mapQuery:"戸隠神社 随神門",...TOGAKUSHI_LINK,img:SCENE.d5}),
    S("戶隱蕎麥麵","food","約 11 時用餐，或選可預約的店，避免熱門店長排。",{tags:["午餐","11:00"],fullDesc:"戶隱蕎麥常用「ぼっち盛り」，一小束一小束擺在竹篩上。不排忍者村或忍者博物館。",mapQuery:"戸隠 そば",img:SCENE.d10}),
    S("善光寺","attraction","可選：14–15 時離開戶隱回長野，還有精神再去善光寺附近短散步。",{tags:["可選"],dur:"約1小時",fullDesc:"不安排額外山區景點。善光寺不屬於單一宗派，自古接納各宗派的參拜者。",mapQuery:"善光寺",img:SCENE.d5})
  ],moreSpots:[
    NAGANO_HOTEL("長野站步行範圍，連住 2 晚。",true)
  ]},
/* 6 Lomä */ {plan:'loma',dayNum:"7",date:"4/30",weekday:"五",region:"小布施・八重櫻",enRegion:"千曲川桜堤 → 小布施 → 長野還車",drive:"🚗 長野出發，傍晚 16–17 時長野還車",title:"口袋裡的一點栗子香",dayDesc:"吃完甜點再拐個彎，說不定下一條小巷也值得停下。",wear:"白天較暖，洋蔥式穿搭；帶防曬",weatherIco:"🌸",spots:[
    S("千曲川堤防 八重櫻（桜堤）","attraction","08:30 出發，平日早段散步與拍照。",{tags:["08:30","花況待確認"],dur:"約1小時",fullDesc:"八重櫻例年約 4 月下旬至 5 月上旬，若已落花就刪掉這站。",mapQuery:"小布施 千曲川 桜堤",...OBUSE_LINK,img:SCENE.d6}),
    S("小布施街區","attraction","10:30–14:00 慢逛，栗子點心與午餐。",{tags:["10:30"],dur:"約3小時",fullDesc:"小布施以栗子聞名；不要把每間店都列為必去，逛累了就找咖啡坐下。",mapQuery:"小布施",...OBUSE_LINK,img:SCENE.d6}),
    S("北齋館","attraction","可選：北齋館或咖啡擇一。",{tags:["可選"],dur:"約1小時",fullDesc:"葛飾北齋晚年曾多次到小布施，北齋館展示他的肉筆畫與祭屋台天井畫。",mapQuery:"北斎館",img:SCENE.d6}),
    S("小布施栗子甜點","food","栗子點心老店多，挑一兩家就好。",{tags:["甜點"],fullDesc:"可以外帶，也可以在店內配茶慢慢吃。",mapQuery:"小布施 栗菓子",img:SCENE.d6})
  ],moreSpots:[
    NAGANO_HOTEL("長野第 2 晚，續住；整理行李與隔日車票。")
  ]},
/* 7 藤井莊 */ {plan:'fujiiso',dayNum:"4",date:"4/27",weekday:"二",region:"長野 → 藤井莊",enRegion:"高崎 → 長野取車 → 山田溫泉",drive:"🚄 北陸新幹線到長野，取車往須坂・高山村（租車 4 天）",title:"溪聲帶我們回房間",dayDesc:"沿著山路走到暖亮的窗前，今晚有熱湯，也有一夜好眠。",wear:"山區溪谷比市區涼，傍晚加外套",weatherIco:"♨️",spots:[
    S("長野站周邊午餐","food","到站取車，午餐後往須坂、高山村及山田溫泉方向。",{tags:["午餐"],fullDesc:"長野至藤井莊抓約 50–70 分鐘（規劃估算）。",mapQuery:"長野駅",img:SCENE.d7}),
    S("高山村櫻花（擇一）","attraction","可選：時間充裕時，看一處當年仍在花期的櫻花。",{tags:["可選","花況待確認"],dur:"約30–60分鐘",fullDesc:"花期不合就省略，直接上山；不繞完整五大櫻路線。",mapQuery:"高山村 桜",img:SCENE.d7}),
    S("山田溫泉・松川溪谷","activity","依旅館入住時間抵達，泡山田溫泉、看松川溪谷。",{tags:["溫泉"],fullDesc:"晚餐以訂房方案為準。",mapQuery:"山田温泉",img:SCENE.d8})
  ],moreSpots:[
    FUJII_HOTEL("溪谷溫泉旅館，連住第 1 晚。",true)
  ]},
/* 8 藤井莊 */ {plan:'fujiiso',dayNum:"5",date:"4/28",weekday:"三",region:"山田溫泉・松川溪谷",enRegion:"山田溫泉慢住",drive:"🚶 今天主軸是連住，外出 1–2 小時就夠",title:"今天沒有出發時間",dayDesc:"茶還熱著，山谷就在窗外，晚一點再決定要做什麼。",wear:"室內浴衣，外出加外套；溪谷步道可能潮濕",weatherIco:"🍵",spots:[
    S("山田溫泉街散步","activity","早餐後在溫泉街短散步，或在旅館看溪谷。",{tags:["慢住"],dur:"約1–2小時",fullDesc:"這天主軸是連住，安排 1 至 2 小時外出已足夠。",mapQuery:"山田温泉",img:SCENE.d8}),
    S("午餐（旅館或溫泉街／須坂）","food","先確認旅館是否提供午餐或需另訂。",{tags:["午餐","先確認"],fullDesc:"若旅館沒有午餐，提前選好溫泉街或須坂方向的餐廳，避免到現場才發現休業。",mapQuery:"山田温泉 食事",img:SCENE.d8}),
    S("回旅館泡湯、慢住","activity","下午回旅館泡湯、閱讀、喝茶。",{tags:["溫泉"],fullDesc:"高海拔新綠未必已展開，期待放在溪谷景觀及住宿。",mapQuery:"緑霞山宿 藤井荘",img:SCENE.d8}),
    S("松川溪谷周邊","attraction","可選：只有天氣與道路適合才短訪。",{tags:["可選"],fullDesc:"不預設雷瀧步道已開放，不走志賀高原跨山道路，也不為了妙高往返長距離開車。",mapQuery:"松川渓谷",img:SCENE.d7})
  ],moreSpots:[
    FUJII_HOTEL("連住第 2 晚，續住。")
  ]},
/* 9 藤井莊 */ {plan:'fujiiso',dayNum:"6",date:"4/29",weekday:"四",region:"小布施 → 長野",enRegion:"藤井莊 → 小布施 → 長野",drive:"🚗 10–11 時退房下山，旅館至小布施約 30–45 分鐘",title:"口袋裡的一點栗子香",dayDesc:"吃完甜點再拐個彎，說不定下一條小巷也值得停下。",wear:"白天較暖，洋蔥式穿搭；帶防曬",weatherIco:"🌰",spots:[
    S("小布施街區","attraction","中午到小布施，午餐、栗子點心與街區散步。",{tags:["國定假日"],dur:"約3小時",fullDesc:"昭和之日人較多，可以先把行李留在車上，再分區慢走。",mapQuery:"小布施",...OBUSE_LINK,img:SCENE.d9}),
    S("小布施栗子甜點","food","栗子點心老店多，挑一兩家就好。",{tags:["甜點"],fullDesc:"可以外帶，也可以在店內配茶慢慢吃。",mapQuery:"小布施 栗菓子",img:SCENE.d9}),
    S("北齋館","attraction","北齋館與咖啡擇一。",{tags:["可選"],dur:"約1小時",fullDesc:"葛飾北齋晚年曾多次到小布施，北齋館展示他的肉筆畫與祭屋台天井畫。",mapQuery:"北斎館",img:SCENE.d9}),
    S("千曲川堤防 八重櫻（桜堤）","attraction","可選：依花況去看八重櫻，或直接回長野休息。",{tags:["可選","花況待確認"],dur:"約1小時",fullDesc:"八重櫻例年約 4 月下旬至 5 月上旬，若已落花就省略。不要同天再加戶隱。",mapQuery:"小布施 千曲川 桜堤",...OBUSE_LINK,img:SCENE.d9})
  ],moreSpots:[
    NAGANO_HOTEL("長野站步行範圍，連住 2 晚；戶隱留到 4/30 平日。",true)
  ]},
/* 10 藤井莊 */ {plan:'fujiiso',dayNum:"7",date:"4/30",weekday:"五",region:"戶隱",enRegion:"長野 → 戶隱 → 長野還車",drive:"🚗 08 時出發，長野至戶隱約 60–75 分鐘；傍晚長野還車",title:"杉木爺爺的長長走廊",dayDesc:"走進高高的樹林，風從頭頂經過，腳步聲留在身後。",wear:"杉林裡陰涼，可能有殘雪與泥濘，穿防滑好走的鞋",weatherIco:"🌲",spots:[
    S("戶隱神社 中社","attraction","以中社或開放且適合步行的杉木參道擇一為主。",{tags:["08:00 出發"],dur:"約1小時",fullDesc:"早出發可減少熱門停車場及午餐排隊，但仍屬黃金週期間。戶隱神社由奧社、中社、寶光社、九頭龍社、火之御子社五社組成。不安排忍者景點。",mapQuery:"戸隠神社 中社",...TOGAKUSHI_LINK,img:SCENE.d10}),
    S("奧社參道・杉木並木","activity","可選：參道開放且適合步行才走。",{tags:["看開山資訊"],dur:"約1.5–2小時",fullDesc:"奧社春季可能殘雪、泥濘或尚未開山，需看 2027 公告。杉木並木的樹齡據說約 400 年。",mapQuery:"戸隠神社 随神門",...TOGAKUSHI_LINK,img:SCENE.d5}),
    S("戶隱蕎麥麵","food","11 時左右吃戶隱蕎麥麵。",{tags:["午餐","11:00"],fullDesc:"若要蕎麥麵製作體驗，先確認接待店與預約，並用體驗取代參道健行，保持一天一個重點。蕎麥體驗是可替換選項，不是已確認 2027 可訂的活動。",mapQuery:"戸隠 そば",img:SCENE.d10})
  ],moreSpots:[
    NAGANO_HOTEL("長野第 2 晚，續住；14–17 時早段回長野，加油並在營業時間內還車。")
  ]},
/* 11 */ {dayNum:"8",date:"5/1",weekday:"六",region:"長野 → 橫濱",enRegion:"長野 → 東京 → 橫濱",drive:"🚄 北陸新幹線＋JR，全段約 2.5–3 小時",title:"山風送我們去看海",dayDesc:"遠山慢慢退出車窗，港邊的風接住了接下來的旅程。",wear:"港邊風大，帶一件防風外套",weatherIco:"🌊",spots:[
    S("橫濱站周邊午餐","food","中午把行李交給飯店，在橫濱午餐。",{tags:["午餐"],fullDesc:"橫濱站周邊的商場與地下街選擇多，帶著行李也好找。",mapQuery:"横浜駅",img:SCENE.d11}),
    S("港未來海邊散步","attraction","下午到晚上，只選港未來海邊散步與咖啡，或橫濱站商場慢逛。",{tags:["港景"],dur:"約2小時",fullDesc:"黃昏的港未來最好看，看完就回飯店休息。",mapQuery:"みなとみらい 臨港パーク",img:SCENE.d11}),
    S("紅磚倉庫・中華街","attraction","可刪：黃金週可能很擁擠。",{tags:["可刪"],fullDesc:"橫濱紅磚倉庫原本是港口的保稅倉庫，建於明治末到大正初年。遇到人潮就留到下次。",mapQuery:"横浜赤レンガ倉庫",img:SCENE.d11})
  ],moreSpots:[
    YOKO_HOTEL("橫濱站步行範圍，連住 2 晚。",true)
  ]},
/* 12 */ {dayNum:"9",date:"5/2",weekday:"日",region:"橫濱 Bayside",enRegion:"橫濱 → 新杉田 → 鳥濱 Outlet",drive:"🚃 JR 根岸線＋金澤 Seaside Line，約 45–60 分鐘",title:"找一件帶回家的喜歡",dayDesc:"小羚羊提著袋子沿碼頭走，偶爾停下來看看船。",wear:"海邊日照強，帶帽子；好走的鞋",weatherIco:"🛍️",spots:[
    S("三井 Outlet Park 橫濱 Bayside","shopping","接近開門時抵達，購物留 2–3 小時，午餐提早或延後。",{tags:["黃金週"],dur:"約2–3小時",fullDesc:"5/2 是黃金週週日，Outlet 仍可能很多人；搭電車只是避開道路與停車壅塞。營業時間依出發前公布為準。",link:"https://mitsui-shopping-park.com/mop/yokohama/access/",linkLabel:"Bayside 交通",mapQuery:"三井アウトレットパーク 横浜ベイサイド",img:SCENE.d12}),
    S("回飯店休息・整理戰利品","activity","下午回飯店休息；已經逛夠就取消 Outlet，改橫濱站百貨與咖啡。",{tags:["慢活"],fullDesc:"不要同一天加八景島或鎌倉。",mapQuery:"横浜駅",img:SCENE.d12})
  ],moreSpots:[
    YOKO_HOTEL("橫濱第 2 晚，續住。")
  ]},
/* 13 */ {dayNum:"10",date:"5/3",weekday:"一",region:"羽田 → 台灣",enRegion:"橫濱 → 京急 → 羽田第 3 航廈",drive:"🚃 京急線約 60–90 分鐘（含退房到航廈）",title:"背包比出發時滿了一點",dayDesc:"裝進去的有小禮物，還有藤花、溪聲和幾個捨不得的午後。",wear:"機艙備薄外套",weatherIco:"💌",spots:[
    S("飯店周邊散步","activity","簡單早餐，視班機時間在飯店周邊走走，不安排遠距景點。",{tags:["憲法紀念日"],fullDesc:"今天是憲法紀念日。國際線預留起飛前約 3 小時到機場；若 15 時起飛，約 11 時從橫濱飯店出發（示例，實際依航空公司及航廈要求倒推）。",mapQuery:"横浜駅",img:SCENE.d13}),
    S("羽田 → 台灣（航班待訂）","transport","羽田機場第 3 航廈出境。",{tags:["羽田出"],fullDesc:"成田進、羽田出通常要用多城市方式購票；若維持華航，可優先比桃園至成田與羽田至松山的組合。2027 實際班表公布後再補上航班與時間。",img:SCENE.d13})
  ],moreSpots:[]}
];

/* 每日交通速查（index 與 days 相同；可在「🚉 交通」自行新增） */
const transportPlans = [
  {summary:'成田入境後搭鐵路到高崎，全程約 2.5–3.5 小時（含轉乘，估算）。', alert:'預留入境及領行李約 90–120 分鐘；東京站從地下機場列車月台走到新幹線，留 35–45 分鐘。選有停高崎的新幹線班次。', routes:[
    {from:'成田機場',to:'東京站',mode:'🚆 成田Express',time:'約 1 小時',note:'也可改 Skyliner 到京成上野，步行到 JR 上野再搭新幹線；帶大行李時東京站方案較容易沿站內指標走'},
    {from:'東京站',to:'高崎站',mode:'🚄 上越或北陸新幹線',time:'約 50–60 分',note:'選停靠高崎的班次'},
    {from:'高崎站',to:'高崎飯店',mode:'🚶 步行',time:'約 5–10 分',note:'當天不取車'}]},
  {summary:'用計程車或公車串接少林山達磨寺與彩繪工房，不租車。', alert:'週日公車班次較少，回程可以請工房或寺院幫忙叫車。', routes:[
    {from:'高崎站',to:'少林山達磨寺',mode:'🚕 計程車或公車',time:'09:30 出發',note:'公車先查適用班次'},
    {from:'少林山達磨寺',to:'彩繪工房',mode:'🚕 計程車',time:'13:30 前抵達',note:'候選：大門屋、今井だるま店 NAYA'},
    {from:'彩繪工房',to:'高崎市區',mode:'🚕 計程車',time:'15:30 以後',note:''}]},
  {summary:'高崎站附近取車，開往藤岡賞藤，16–17 時回高崎還車（租車約 1 天）。', alert:'一般路況單程約 40–60 分鐘（估算）；黃金週前的平日早段比較不塞。', routes:[
    {from:'高崎站附近租車店',to:'藤岡 ふじの咲く丘',mode:'🚗 自駕',time:'08:00–09:00 取車後出發',note:'約 40–60 分'},
    {from:'藤岡',to:'高崎站附近租車店',mode:'🚗 自駕',time:'16:00–17:00 還車',note:'可順路去ららん藤岡'}]},
  {summary:'高崎搭北陸新幹線到長野，長野站取車，開往黑姬 Lomä（租車 4 天，4/30 長野還車）。', alert:'不要誤搭只往新潟方向的上越新幹線。高崎至長野約 50–60 分鐘，依班次調整。', routes:[
    {from:'高崎站',to:'JR 長野站',mode:'🚄 北陸新幹線',time:'09:30 退房後',note:'約 50–60 分'},
    {from:'長野站',to:'長野站租車店',mode:'🚗 取車',time:'11:00 左右',note:'先午餐與補充飲水'},
    {from:'長野站',to:'Lomä（黑姬）',mode:'🚗 自駕',time:'約 50–70 分',note:'信濃町 IC 至飯店約 7 分；可順路野尻湖'}]},
  {summary:'Lomä 開到いもり池，半日外出，14–15 時回飯店。', alert:'妙高山被雲遮住或天氣差就留飯店。', routes:[
    {from:'Lomä',to:'いもり池',mode:'🚗 自駕',time:'09:30 出發',note:'約 25–40 分'},
    {from:'池の平／赤倉',to:'Lomä',mode:'🚗 自駕',time:'14:00–15:00',note:''}]},
  {summary:'Lomä 退房開往戶隱，下午回長野入住。', alert:'今天是昭和之日，戶隱停車場與蕎麥麵店可能排隊；山路時間會受交通影響。', routes:[
    {from:'Lomä',to:'戶隱神社 中社',mode:'🚗 自駕',time:'09:00 出發',note:'約 45–60 分'},
    {from:'戶隱',to:'長野站周邊飯店',mode:'🚗 自駕',time:'14:00–15:00 離開',note:'確認飯店停車場'}]},
  {summary:'長野出發去千曲川桜堤與小布施，傍晚回長野加油還車。', alert:'租車店營業時間內還車；加油後再還。', routes:[
    {from:'長野',to:'千曲川堤防 桜堤',mode:'🚗 自駕',time:'08:30 出發',note:''},
    {from:'小布施',to:'長野站租車店',mode:'🚗 自駕＋加油',time:'16:00–17:00 還車',note:'辦理行李與隔日車票'}]},
  {summary:'高崎搭北陸新幹線到長野，長野站取車，往須坂・高山村方向到山田溫泉（租車 4 天，4/30 長野還車）。', alert:'選停靠長野的北陸新幹線班次。藤井莊停車時段 15 時至 11 時，提前到達先向旅館確認。', routes:[
    {from:'高崎站',to:'JR 長野站',mode:'🚄 北陸新幹線',time:'09:30 退房後',note:'約 50–60 分'},
    {from:'長野站',to:'長野站租車店',mode:'🚗 取車',time:'到站後',note:'午餐後出發'},
    {from:'長野站',to:'緑霞山宿 藤井荘',mode:'🚗 自駕',time:'約 50–70 分',note:'經須坂、高山村'}]},
  {summary:'連住日，車子停在旅館；外出只排 1–2 小時。', alert:'不走志賀高原跨山道路；雨雪時取消高處步道。', routes:[
    {from:'藤井莊',to:'山田溫泉街',mode:'🚶 步行',time:'早餐後',note:''}]},
  {summary:'10–11 時退房下山到小布施，下午回長野入住。', alert:'昭和之日小布施人多，停好車後分區慢走。', routes:[
    {from:'藤井莊',to:'小布施',mode:'🚗 自駕',time:'10:00–11:00 退房後',note:'約 30–45 分'},
    {from:'小布施',to:'長野站周邊飯店',mode:'🚗 自駕',time:'下午',note:'確認飯店停車場'}]},
  {summary:'08 時長野出發去戶隱，早段回長野加油還車。', alert:'仍屬黃金週，早出發可以少排停車與午餐。', routes:[
    {from:'長野',to:'戶隱神社 中社',mode:'🚗 自駕',time:'08:00 出發',note:'約 60–75 分'},
    {from:'戶隱',to:'長野站租車店',mode:'🚗 自駕＋加油',time:'14:00–17:00 還車',note:'租車店營業時間內'}]},
  {summary:'長野搭北陸新幹線到東京，轉 JR 到橫濱，全段約 2.5–3 小時。', alert:'5/1 起只用鐵路；熱門日期先訂新幹線指定席。', routes:[
    {from:'長野站',to:'東京站',mode:'🚄 北陸新幹線',time:'09:00–10:00 出發',note:'約 1.5 小時'},
    {from:'東京站',to:'橫濱站',mode:'🚆 JR 東海道線等',time:'約 25–30 分',note:'依實際車次調整'}]},
  {summary:'JR 根岸線到新杉田，轉金澤 Seaside Line 到鳥濱，步行約 5 分鐘。', alert:'黃金週週日，接近開門抵達。', routes:[
    {from:'橫濱站',to:'新杉田站',mode:'🚃 JR 根岸線',time:'約 25 分',note:''},
    {from:'新杉田站',to:'鳥濱站',mode:'🚝 金澤 Seaside Line',time:'約 5 分',note:'下車步行約 5 分到 Outlet'}]},
  {summary:'橫濱站搭京急到羽田機場第 3 航廈，退房到航廈約 60–90 分鐘。', alert:'國際線預留起飛前約 3 小時到機場；部分班次需在京急蒲田轉車，優先挑直通列車。', routes:[
    {from:'橫濱站',to:'羽田機場第 3 航廈',mode:'🚃 京急線',time:'依班機倒推',note:'例：15 時起飛 → 約 11 時從飯店出發'}]}
];
const transportGeneralTips = ['準備 Suica 等 IC 卡，JR、京急、Seaside Line 都能刷','4/29 昭和之日、5/1–5/3 黃金週，移動日預留緩衝'];


/* ============ 筆記/照片/自訂景點系統 (LocalStorage 永久保存) ============ */

/* 共用安全寫入函式：localStorage 容量有限（通常僅 5-10MB／裝置），
   照片存多了可能會寫入失敗。統一在這裡攔截錯誤並提示使用者，
   而不是讓資料默默遺失、卻讓使用者誤以為「上傳照片沒反應」。 */
function safeSetItem(key, valueObj){
  let localOk = true;
  try {
    localStorage.setItem(key, JSON.stringify(valueObj));
  } catch(e) {
    localOk = false;
    console.error('localStorage 寫入失敗：', key, e);
  }
  // 若已啟用家人共享同步，改把資料推上雲端；雲端會自動用它自己的（容量大很多的）
  // 離線快取保存，所以就算這台裝置的 localStorage 滿了也不代表資料真的保不住。
  valueObj=normalizeSyncValue(key,valueObj);
  if (!cloudSync.applyingRemote) scheduleCloudPush(key, valueObj);
  if (!localOk && !cloudSync.enabled) {
    alert('⚠️ 這台裝置瀏覽器的儲存空間已滿，剛才的變更可能無法保存。請先刪除幾張較舊或較大的照片，再重新上傳。');
    return false;
  }
  return true;
}

/* 單層誤刪復原：五秒內可撤銷最近一次刪除。 */
let undoTimer=null;
function offerUndo(message,restore){
  const toast=document.getElementById('undoToast'),text=document.getElementById('undoToastText'),btn=document.getElementById('undoToastButton');
  if(!toast||!text||!btn)return;
  clearTimeout(undoTimer);text.textContent=message;toast.hidden=false;
  /* 沒有東西可以復原的「提示訊息」不顯示復原鈕；可復原的給 8 秒，長輩來得及按 */
  btn.hidden=typeof restore!=='function';
  btn.onclick=()=>{clearTimeout(undoTimer);toast.hidden=true;if(typeof restore==='function')restore();};
  undoTimer=setTimeout(()=>{toast.hidden=true;},typeof restore==='function'?8000:3500);
}
function showToast(message){offerUndo(message,null);}
function escHtml(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

const NOTE_DRAFT_KEY='nagano_note_drafts_v1';
function readNoteDrafts(){try{return JSON.parse(localStorage.getItem(NOTE_DRAFT_KEY)||'{}');}catch(e){return {};}}
function saveNoteDraft(key,value){const d=readNoteDrafts();if(value)d[key]=value;else delete d[key];try{localStorage.setItem(NOTE_DRAFT_KEY,JSON.stringify(d));}catch(e){}}
const openNoteEditors=new Set();

let notesStore = JSON.parse(localStorage.getItem('nagano_notes')) || {};
/* 相容舊版資料：以前每個景點只能存一則筆記（字串），現在改成可以新增多筆 */
Object.keys(notesStore).forEach(k=>{
  if (typeof notesStore[k] === 'string') {
    notesStore[k] = notesStore[k].trim() ? [notesStore[k].trim()] : [];
  }
});
function persistNotes(){ safeSetItem('nagano_notes', notesStore); }

/* 內建「評論與資訊」也可由使用者修改或刪除。undefined=沿用預設、null=隱藏、字串=自訂版本。 */
let infoOverrideStore = JSON.parse(localStorage.getItem('nagano_info_overrides') || '{}');
function persistInfoOverrides(){ safeSetItem('nagano_info_overrides', infoOverrideStore); }
function currentBuiltInInfo(key, fallback){
  return Object.prototype.hasOwnProperty.call(infoOverrideStore,key) ? infoOverrideStore[key] : fallback;
}
/* 內建「營業／開放時間」與「重要提點／門票」也可由使用者編輯或清空。
   undefined=沿用預設、null=清空（隱藏）、字串=自訂版本。 */
let fieldOverrideStore = JSON.parse(localStorage.getItem('nagano_field_overrides') || '{}');
function persistFieldOverrides(){ safeSetItem('nagano_field_overrides', fieldOverrideStore); }
function fieldOverrideKey(idx, field){ return idx + '::' + field; }
function currentFieldValue(idx, field, fallback){
  const k = fieldOverrideKey(idx, field);
  return Object.prototype.hasOwnProperty.call(fieldOverrideStore, k) ? fieldOverrideStore[k] : (fallback || null);
}
/* 原始預設文字改存在記憶體登記表，不再塞進 onclick 的 HTML 屬性字串裡——
   如果原文含有雙引號，直接內嵌會把 onclick="..." 屬性截斷，導致按鈕失效。 */
window._spotFieldOriginals = window._spotFieldOriginals || {};
function editSpotField(event, idx, field, label){
  if(event)event.stopPropagation();
  if(field==='mapQuery'){openNavFixModal(idx);return;}
  const k = fieldOverrideKey(idx, field);
  const fallback = (window._spotFieldOriginals[idx] || {})[field] || null;
  let current = currentFieldValue(idx, field, fallback);
  if(field==='mapQuery' && current==null) current = currentFieldValue(idx,'name',(window._spotFieldOriginals[idx]||{}).name) || '';
  const next = prompt('編輯' + label, current == null ? '' : current);
  if(next === null) return;
  const value = next.trim();
  fieldOverrideStore[k] = value || null;
  persistFieldOverrides();
  safeRenderDayContent();
  setTimeout(() => document.getElementById('spot-card-' + idx)?.classList.add('open'), 50);
}
function clearSpotField(event, idx, field){
  event.stopPropagation();
  if(!confirm('要清空這筆資訊嗎？')) return;
  fieldOverrideStore[fieldOverrideKey(idx, field)] = null;
  persistFieldOverrides();
  safeRenderDayContent();
  setTimeout(() => document.getElementById('spot-card-' + idx)?.classList.add('open'), 50);
}

/* ============ 統一編輯視窗：名稱／簡介／營業時間／提點／評論／導航地點 ============ */
let _spotEditModalIdx = null;
function openSpotEditModal(event, idx){
  if(event) event.stopPropagation();
  _spotEditModalIdx = idx;
  const orig = window._spotFieldOriginals[idx] || {};
  const infoOrig = window._spotCustomInfoOriginals[idx] || null;
  document.getElementById('editSpotName').value = currentFieldValue(idx, 'name', orig.name) || '';
  document.getElementById('editSpotDesc').value = currentFieldValue(idx, 'desc', orig.desc) || '';
  document.getElementById('editSpotFullDesc').value = currentFieldValue(idx, 'fullDesc', orig.fullDesc) || '';
  document.getElementById('editSpotHours').value = currentFieldValue(idx, 'hours', orig.hours) || '';
  document.getElementById('editSpotDur').value = currentFieldValue(idx, 'dur', orig.dur) || '';
  document.getElementById('hotelAmenityFields').style.display = orig.cat === 'hotel' ? 'block' : 'none';
  HOTEL_AMENITIES.forEach(a => { document.getElementById('editAmen_'+a.id).value = currentFieldValue(idx, 'amen_'+a.id, null) || ''; });
  document.getElementById('editSpotNote').value = currentFieldValue(idx, 'note', orig.note) || '';
  document.getElementById('editSpotInfo').value = currentBuiltInInfo(idx, infoOrig) || '';
  document.getElementById('editSpotMapQuery').value = currentFieldValue(idx, 'mapQuery', null) || '';
  document.getElementById('spotEditModal').classList.add('active');
}
function closeSpotEditModal(){
  document.getElementById('spotEditModal').classList.remove('active');
  _spotEditModalIdx = null;
  flushPendingDayRender();
}
function saveSpotEditModal(){
  const idx = _spotEditModalIdx;
  if(!idx) return;
  const setField = (field, val) => {
    const v = (val || '').trim();
    fieldOverrideStore[fieldOverrideKey(idx, field)] = v || null;
  };
  setField('name', document.getElementById('editSpotName').value);
  setField('desc', document.getElementById('editSpotDesc').value);
  setField('fullDesc', document.getElementById('editSpotFullDesc').value);
  setField('hours', document.getElementById('editSpotHours').value);
  setField('dur', document.getElementById('editSpotDur').value);
  if((window._spotFieldOriginals[idx]||{}).cat === 'hotel') HOTEL_AMENITIES.forEach(a => setField('amen_'+a.id, document.getElementById('editAmen_'+a.id).value));
  setField('note', document.getElementById('editSpotNote').value);
  setField('mapQuery', document.getElementById('editSpotMapQuery').value);
  persistFieldOverrides();
  const infoVal = document.getElementById('editSpotInfo').value.trim();
  infoOverrideStore[idx] = infoVal || null;
  persistInfoOverrides();
  document.getElementById('spotEditModal').classList.remove('active');
  _spotEditModalIdx = null;
  renderDayContent();
  setTimeout(() => document.getElementById('spot-card-' + idx)?.classList.add('open'), 50);
}
function resetSpotEditModal(){
  const idx = _spotEditModalIdx;
  if(!idx) return;
  if(!confirm('確定要把這個景點的名稱、簡介、營業時間、提點、評論、導航地點全部還原成預設嗎？')) return;
  ['name','desc','fullDesc','hours','dur','note','mapQuery','resv','amen_bath','amen_laundry','amen_breakfast','amen_dinner'].forEach(f => delete fieldOverrideStore[fieldOverrideKey(idx, f)]);
  persistFieldOverrides();
  delete infoOverrideStore[idx];
  persistInfoOverrides();
  document.getElementById('spotEditModal').classList.remove('active');
  _spotEditModalIdx = null;
  renderDayContent();
  setTimeout(() => document.getElementById('spot-card-' + idx)?.classList.add('open'), 50);
}

window._spotCustomInfoOriginals = window._spotCustomInfoOriginals || {};
/* editBuiltInInfo：hk11 改成大的多行編輯視窗（見檔案後段） */
function deleteBuiltInInfo(key){
  if(!confirm('要刪除這筆預設評論與資訊嗎？'))return;
  infoOverrideStore[key]=null; persistInfoOverrides(); renderDayContent();
  setTimeout(()=>document.getElementById('spot-card-'+key)?.classList.add('open'),50);
}

function addNote(key) {
  const input = document.getElementById('note-input-'+key);
  if(!input) return;
  const text = input.value.trim();
  if(!text) return;
  if(!notesStore[key]) notesStore[key] = [];
  notesStore[key].push(text);
  saveNoteDraft(key,'');openNoteEditors.add(String(key));
  persistNotes();
  renderDayContent();
  setTimeout(()=>{
    const card = document.getElementById('spot-card-'+key); if(card) card.classList.add('open');
    const editArea = document.getElementById('edit-note-'+key); if(editArea) editArea.style.display = 'block';
    const toggleBtn = document.getElementById('btn-note-'+key); if(toggleBtn) toggleBtn.style.display = 'none';
  }, 50);
}
function deleteNote(key, noteIdx) {
  if(!notesStore[key]) return;
  const removed=notesStore[key].splice(noteIdx, 1)[0];
  persistNotes();
  renderDayContent();
  offerUndo('已刪除一筆評論',()=>{if(!notesStore[key])notesStore[key]=[];notesStore[key].splice(noteIdx,0,removed);persistNotes();renderDayContent();});
  setTimeout(()=>{
    const card = document.getElementById('spot-card-'+key); if(card) card.classList.add('open');
  }, 50);
}
/* editNote：hk11 改成大的多行編輯視窗（見檔案後段） */
function toggleEditNote(event, key) {
  event.stopPropagation();
  const editArea = document.getElementById('edit-note-'+key);
  const toggleBtn = document.getElementById('btn-note-'+key);
  if (editArea.style.display === 'none') {
    openNoteEditors.add(String(key));
    editArea.style.display = 'block';
    if(toggleBtn) toggleBtn.style.display = 'none';
  } else {
    openNoteEditors.delete(String(key));
    editArea.style.display = 'none';
    if(toggleBtn) toggleBtn.style.display = 'inline-block';
    flushPendingDayRender();
  }
}

/* 景點照片：改用 base64 存進 LocalStorage，重新整理／關閉頁面後仍會保留。
   上傳時會先自動壓縮（最長邊 1600px、JPEG 品質 0.82），
   避免手機原圖動輒 3-8MB，很快就把裝置的 localStorage 容量塞滿導致上傳失敗。 */
let photoStore = JSON.parse(localStorage.getItem('nagano_photos')) || {};
function persistPhotos(){ return safeSetItem('nagano_photos', photoStore); }

/* 景點封面：使用者可指定某張照片（或原始配圖）作為主要亮點卡片的封面，
   而不是每次上傳新照片就自動覆蓋原本的封面 */
let coverStore = JSON.parse(localStorage.getItem('nagano_covers')) || {};
function persistCover(){ safeSetItem('nagano_covers', coverStore); }
/* (v54 已改寫) */

/* 自訂新增景點：依「天」儲存在 LocalStorage，重新整理後仍會保留 */
let customSpotsStore = JSON.parse(localStorage.getItem('nagano_custom_spots')) || {};
let hiddenFixedSpotsStore = JSON.parse(localStorage.getItem('nagano_hidden_fixed_spots')) || {};
function persistHiddenFixedSpots(){ safeSetItem('nagano_hidden_fixed_spots', hiddenFixedSpotsStore); }
function hideFixedSpot(dayIdx,key){ if(!confirm('要從這一天隱藏此項目嗎？'))return; if(!hiddenFixedSpotsStore[dayIdx])hiddenFixedSpotsStore[dayIdx]=[]; if(!hiddenFixedSpotsStore[dayIdx].includes(key))hiddenFixedSpotsStore[dayIdx].push(key); persistHiddenFixedSpots(); renderDayContent(); updateSpotCount();offerUndo('已隱藏行程項目',()=>{hiddenFixedSpotsStore[dayIdx]=(hiddenFixedSpotsStore[dayIdx]||[]).filter(k=>k!==key);persistHiddenFixedSpots();renderDayContent();updateSpotCount();}); }
function restoreFixedSpots(dayIdx){ delete hiddenFixedSpotsStore[dayIdx]; persistHiddenFixedSpots(); renderDayContent(); updateSpotCount(); }
function persistCustomSpots(){ safeSetItem('nagano_custom_spots', customSpotsStore); }
function getCustomSpots(dayIdx){ return customSpotsStore[dayIdx] || []; }

/* 依關鍵字與分類，自動組出一段景點簡介（離線生成，不需要網路，句型會隨機變化避免制式感） */
function generateAutoDesc(name, catKey, keywordsStr, dur){
  const c = CAT[catKey] || CAT.attraction;
  const kws = (keywordsStr||'').split(/[,，、]/).map(s=>s.trim()).filter(Boolean);
  const pick = arr => arr[Math.floor(Math.random()*arr.length)];

  const openers = {
    food: [`提到在地美食，「${name}」是您這趟旅程特別記下的一站`, `「${name}」是您收藏進口袋名單的用餐選擇`, `說到用餐，「${name}」是您這次特別想去嘗試的地方`],
    activity: [`「${name}」是您安排在行程中的一段體驗`, `「${name}」被您加進了這次的戶外／步道行程`, `這次行程中，「${name}」是您特別想安排的活動`],
    shopping: [`「${name}」是您順路想去逛逛的採購點`, `「${name}」被您列進了這趟旅程的購物清單`, `逛街採買方面，「${name}」是您特別留意到的地方`],
    attraction: [`「${name}」是您私房收藏的景點`, `「${name}」被您加進了這趟旅程的必訪名單`, `這次行程中，「${name}」是您特別想造訪的地方`],
    hotel: [`「${name}」是您這晚安排的住宿／休憩地點`, `「${name}」被您排進了這趟旅程的住宿清單`],
    transport: [`「${name}」是您這段行程安排的交通方式`, `「${name}」是您這趟旅程的交通安排之一`],
  };

  const kwSentence = kws.length
    ? (kws.length > 1
        ? `聽說這裡以「${kws.join('、')}」最受喜愛，很值得留意。`
        : `聽說這裡因「${kws[0]}」讓人印象深刻，很值得留意。`)
    : '';

  const closers = {
    food: ['實際營業時間與是否需要訂位，建議出發前再次確認。', '尖峰用餐時段可能需要稍候，建議預留一點彈性時間。', '若人氣較高，建議提早前往或先查詢是否可訂位。'],
    activity: ['出發前建議留意當天天氣與路況，並穿著合適的鞋子。', '建議依體力與時間彈性調整走訪範圍與路線。', '建議事先查詢開放時間與難易度，安排合適的時段前往。'],
    shopping: ['記得留意營業時間，也保留一點伴手禮預算。', '若剛好順路，很適合安排在移動途中稍作停留。', '建議先查一下營業時間，避免撲空。'],
    attraction: ['可依現場狀況彈性安排拍照與停留時間。', '建議留意人潮與光線，安排合適的造訪時段。', '建議事先查詢是否需要預約或有開放時間限制。'],
    hotel: ['記得提前確認入住與退房時間，以及辦理入住的方式。', '建議提前查看周邊生活機能與停車資訊。'],
    transport: ['建議提前確認實際時刻表與轉乘方式。', '建議預留緩衝時間，避免銜接過於緊湊。'],
  };

  const durSentence = dur ? `這裡建議停留${dur}左右。` : '';
  const full = `${pick(openers[catKey] || openers.attraction)}。${kwSentence}${durSentence}${pick(closers[catKey] || closers.attraction)}`;
  const short = `您親自新增的私房${c.label}景點${kws.length ? '，以「'+kws.join('、')+'」最受期待' : ''}。`;
  return {short, full};
}

/* 嘗試連網搜尋景點資料並生成簡介：這個功能只有在 Claude 對話介面「即時建立的 Artifact 畫布」中才能連線；
   本檔案是以可下載的靜態網頁形式提供，不論是在預覽或下載後開啟，通常都無法連上 Anthropic 伺服器，
   會自動改用上面經過強化的離線生成版本，不會中斷操作 */
async function generateAutoDescOnline(name, catKey, keywordsStr, dur){

  const c = CAT[catKey] || CAT.attraction;
  const kws = (keywordsStr||'').trim();
  const searchHint = kws ? `搜尋時請把「${name}」與關鍵字「${kws}」一起考慮，找出跟這些關鍵字最相關的資訊。` : `請直接搜尋「${name}」這個名稱找相關資訊。`;
  const prompt = `請使用網路搜尋工具，查詢日本長野、群馬或橫濱一帶「${name}」這個${c.label}的公開資訊。${searchHint}找到資料後，用繁體中文寫一段約80–120字、適合放進旅遊行程App的景點簡介，語氣自然口語、不要條列式，盡量帶入搜尋到的具體特色（不要只寫「以...聞名」這類空泛說法）。${dur ? '可自然帶入建議停留時間「'+dur+'」，':''}只回傳簡介本文，不要加前言、引號或任何說明文字。若確實搜尋不到這個名稱的公開資訊，才依名稱、分類與關鍵字合理推測寫一段通用但得體的簡介。`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  if(!resp.ok) throw new Error('API 回應失敗：' + resp.status);
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if(!text) throw new Error('沒有取得簡介文字');
  const short = text.length > 44 ? text.slice(0, 44) + '…' : text;
  return { short, full: text };
}

async function addCustomSpot(dayIdx){
  const nameEl = document.getElementById('newSpotName-'+dayIdx);
  const catEl = document.getElementById('newSpotCat-'+dayIdx);
  const kwEl = document.getElementById('newSpotKw-'+dayIdx);
  const durEl = document.getElementById('newSpotDur-'+dayIdx);
  const btnEl = document.getElementById('addSpotBtn-'+dayIdx);
  const statusEl = document.getElementById('addSpotStatus-'+dayIdx);
  const name = nameEl.value.trim();
  if(!name){ nameEl.focus(); return; }
  const catKey = catEl.value;
  const kw = kwEl.value;
  const dur = durEl.value.trim();

  if(btnEl){ btnEl.disabled = true; btnEl.textContent = '正在建立景點…'; }
  if(statusEl){ statusEl.textContent = '正在依名稱與關鍵字建立可離線使用的簡介。'; }
  const generated=generateAutoDesc(name,catKey,kw,dur);
  const {short,full}=generated,genSource='offline';

  const spot = S(name, catKey, short, { fullDesc: full, dur: dur || null, genSource });
  if(!customSpotsStore[dayIdx]) customSpotsStore[dayIdx] = [];
  customSpotsStore[dayIdx].push(spot);
  persistCustomSpots();
  nameEl.value=''; kwEl.value=''; durEl.value='';
  renderDayContent();
  updateSpotCount();
  if(btnEl){btnEl.disabled=false;btnEl.textContent='＋ 新增並自動生成簡介';}
}
function delCustomSpot(dayIdx, i){
  if(!customSpotsStore[dayIdx]) return;
  /* hk11：不再把它從清單「切掉」，只標記為已刪除。
     自訂景點的筆記、照片、評論都是用「第幾個」對應的；以前切掉後面的景點會往前補位，
     導致下一個景點接收到被刪景點的筆記照片（自己的反而不見）。標記刪除就不會錯位，也能完整復原。 */
  const cur=customSpotsStore[dayIdx][i];if(!cur||cur.deleted)return;
  customSpotsStore[dayIdx][i]={...cur,deleted:true};
  persistCustomSpots();
  renderDayContent();
  updateSpotCount();
  offerUndo('已刪除自訂景點',()=>{const a=customSpotsStore[dayIdx];if(!a||!a[i])return;const r={...a[i]};delete r.deleted;a[i]=r;persistCustomSpots();renderDayContent();updateSpotCount();});
}
function toggleEditSpot(idx){
  const el = document.getElementById('spot-edit-'+idx);
  if(el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
}
function saveSpotEdit(dayIdx, i, idx){
  if(!customSpotsStore[dayIdx] || !customSpotsStore[dayIdx][i]) return;
  const shortEl = document.getElementById('spot-edit-short-'+idx);
  const fullEl = document.getElementById('spot-edit-full-'+idx);
  const spot = customSpotsStore[dayIdx][i];
  const newShort = shortEl ? shortEl.value.trim() : '';
  const newFull = fullEl ? fullEl.value.trim() : '';
  if(newShort) spot.desc = newShort;
  if(newFull) spot.fullDesc = newFull;
  spot.genSource = 'edited';
  persistCustomSpots();
  renderDayContent();
  updateSpotCount();
}
function updateSpotCount(){
  let total = days.filter((d,i)=>inPlan(i)).reduce((a,d)=>a+d.spots.filter(x=>!x.removed).length + (d.moreSpots?d.moreSpots.length:0),0);
  Object.values(customSpotsStore).forEach(arr => total += (Array.isArray(arr)?arr.filter(x=>x&&!x.deleted).length:0));
  document.getElementById('spotCount').textContent = total;
}

/* ============ 景點排序 (LocalStorage 永久保存) ============ */
/* hk28：航班卡片放回「今日亮點」；其他交通卡片已移除（交通資訊都在「交通」分頁） */
const MAIN_CATS = ['attraction','activity','transport'];
const LIFE_CATS = ['food','shopping','hotel'];
let orderStore = JSON.parse(localStorage.getItem('nagano_order')) || {};
function persistOrder(){ safeSetItem('nagano_order', orderStore); }
function getOrderKey(dayIdx, listType){ return dayIdx + '-' + listType; }

/* (v52 已改寫) */

function applyOrder(dayIdx, listType, list){
  const okey = getOrderKey(dayIdx, listType);
  const naturalKeys = list.map(o=>o.key);
  let order = orderStore[okey];
  if(!order || !order.length) return list;
  order = order.filter(k=>naturalKeys.includes(k));
  naturalKeys.forEach(k=>{ if(!order.includes(k)) order.push(k); });
  const byKey = {}; list.forEach(o=>byKey[o.key]=o);
  return order.map(k=>byKey[k]).filter(Boolean);
}

function moveSpot(dayIdx, listType, key, dir){
  const natural = getNaturalList(dayIdx, listType);
  const naturalKeys = natural.map(o=>o.key);
  const okey = getOrderKey(dayIdx, listType);
  let order = orderStore[okey];
  if(!order || !order.length) order = naturalKeys.slice();
  else {
    order = order.filter(k=>naturalKeys.includes(k));
    naturalKeys.forEach(k=>{ if(!order.includes(k)) order.push(k); });
  }
  const i = order.indexOf(key);
  const j = i + dir;
  if(i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  orderStore[okey] = order;
  persistOrder();
  renderDayContent();
}

/* ============ 景點內「資訊與評論」區塊排序 (LocalStorage 永久保存) ============ */
let blockOrderStore = JSON.parse(localStorage.getItem('nagano_block_order')) || {};
function persistBlockOrder(){ safeSetItem('nagano_block_order', blockOrderStore); }
function moveBlock(spotKey, blockId, dir, hasBadges, hasInfo){
  const naturalIds = [];
  if(hasBadges) naturalIds.push('badges');
  if(hasInfo) naturalIds.push('info');
  naturalIds.push('note');
  let order = blockOrderStore[spotKey];
  if(!order || !order.length) order = naturalIds.slice();
  else {
    order = order.filter(id=>naturalIds.includes(id));
    naturalIds.forEach(id=>{ if(!order.includes(id)) order.push(id); });
  }
  const i = order.indexOf(blockId);
  const j = i + dir;
  if(i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  blockOrderStore[spotKey] = order;
  persistBlockOrder();
  renderDayContent();
}


let routeMapStore = JSON.parse(localStorage.getItem('nagano_route_maps')) || {};
function persistRouteMaps(){ safeSetItem('nagano_route_maps', routeMapStore); }
async function handleRouteMapUpload(e, dayIdx){
  const files = Array.from(e.target.files || []); e.target.value='';
  if(!files.length) return;
  if(!routeMapStore[dayIdx]) routeMapStore[dayIdx] = [];
  updateSyncStatus(null,'saving');
  try{
    for(const f of files){ routeMapStore[dayIdx].push(await uploadMediaFile(f,`route-maps/day-${dayIdx}`)); persistRouteMaps(); }
    renderDayContent();
  }catch(err){ persistRouteMaps(); renderDayContent(); reportUploadError(err); updateSyncStatus(err); }
}
function removeRouteMap(dayIdx, i){
  if(!routeMapStore[dayIdx]) return;
  const removed=routeMapStore[dayIdx].splice(i, 1)[0];
  persistRouteMaps();
  renderDayContent();
  offerUndo('已刪除路線圖',()=>{if(!routeMapStore[dayIdx])routeMapStore[dayIdx]=[];routeMapStore[dayIdx].splice(i,0,removed);persistRouteMaps();renderDayContent();});
}

/* 每日交通補充：可自行新增集合地點、導航位置、文字提醒及上車點／時刻表圖片。 */
let transportExtrasStore = JSON.parse(localStorage.getItem('nagano_transport_extras')) || {};
function transportExtrasFor(dayIdx){
  if(!transportExtrasStore[dayIdx])transportExtrasStore[dayIdx]={notes:[],images:[]};
  transportExtrasStore[dayIdx].notes=Array.isArray(transportExtrasStore[dayIdx].notes)?transportExtrasStore[dayIdx].notes:[];
  transportExtrasStore[dayIdx].images=Array.isArray(transportExtrasStore[dayIdx].images)?transportExtrasStore[dayIdx].images:[];
  return transportExtrasStore[dayIdx];
}
function persistTransportExtras(){safeSetItem('nagano_transport_extras',transportExtrasStore);}
function addTransportExtra(dayIdx,segmentKey='other'){
  const fieldKey=`${dayIdx}-${segmentKey}`;
  const title=document.getElementById(`transportExtraTitle-${fieldKey}`)?.value.trim();
  const detail=document.getElementById(`transportExtraDetail-${fieldKey}`)?.value.trim();
  const location=document.getElementById(`transportExtraLocation-${fieldKey}`)?.value.trim();
  if(!title){alert('請先輸入交通資訊標題');return;}
  transportExtrasFor(dayIdx).notes.push({id:stableItemId('transport',[Date.now(),title]),segmentKey,title,detail,location});
  persistTransportExtras();renderDayContent();
}
function removeTransportExtra(dayIdx,i){
  const list=transportExtrasFor(dayIdx).notes,removed=list.splice(i,1)[0];persistTransportExtras();renderDayContent();
  offerUndo('已刪除交通補充',()=>{list.splice(i,0,removed);persistTransportExtras();renderDayContent();});
}
async function handleTransportImageUpload(e,dayIdx,segmentKey='other'){
  const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;
  updateSyncStatus(null,'saving');
  try{
    const target=transportExtrasFor(dayIdx).images;
    for(const file of files)target.push({url:await uploadMediaFile(file,`transport/day-${dayIdx}`),segmentKey,title:file.name.replace(/\.[^.]+$/,'')||'交通圖片'});
    persistTransportExtras();renderDayContent();
  }catch(err){persistTransportExtras();renderDayContent();reportUploadError(err);updateSyncStatus(err);}
}
function renameTransportImage(dayIdx,i){
  const image=transportExtrasFor(dayIdx).images[i];if(!image)return;
  const next=prompt('圖片名稱（例如：長野站新幹線 11 號月台、租車店門口）',image.title||'');
  if(next===null)return;image.title=next.trim()||'交通圖片';persistTransportExtras();renderDayContent();
}
function removeTransportImage(dayIdx,i){
  const list=transportExtrasFor(dayIdx).images,removed=list.splice(i,1)[0];persistTransportExtras();renderDayContent();
  offerUndo('已移除交通圖片',()=>{list.splice(i,0,removed);persistTransportExtras();renderDayContent();});
}
function transportSegmentExtrasHTML(dayIdx,segmentKey){
  const data=transportExtrasFor(dayIdx);
  const notes=data.notes.map((n,i)=>({n,i})).filter(x=>(x.n.segmentKey||'other')===segmentKey);
  const images=data.images.map((img,i)=>({img,i})).filter(x=>(x.img.segmentKey||'other')===segmentKey);
  const noteHTML=notes.length?`<div class="transport-extra-notes">${notes.map(({n,i})=>`<article><div><strong>${escHtml(n.title)}</strong>${n.detail?`<p>${escHtml(n.detail)}</p>`:''}</div><div class="transport-extra-actions">${n.location?`<a href="${escAttr(mapsLink(n.location))}" target="_blank" rel="noopener">導航</a>`:''}<button class="edit-only" onclick="removeTransportExtra(${dayIdx},${i})">刪除</button></div></article>`).join('')}</div>`:'';
  const imageHTML=images.length?`<div class="transport-extra-gallery">${images.map(({img,i})=>`<figure><img src="${escAttr(img.url)}" alt="${escAttr(img.title||'交通圖片')}" loading="lazy" onclick="openAttachModal('${escAttr(img.url)}')"><figcaption>${escHtml(img.title||'交通圖片')}</figcaption><div class="edit-only"><button onclick="renameTransportImage(${dayIdx},${i})">改名</button><button onclick="removeTransportImage(${dayIdx},${i})">刪除</button></div></figure>`).join('')}</div>`:'';
  const fieldKey=`${dayIdx}-${segmentKey}`;
  return `<div class="transport-segment-extra">${noteHTML}${imageHTML}<details class="transport-segment-add edit-only"><summary>＋ 補充這一段</summary><div class="transport-extra-form"><input id="transportExtraTitle-${fieldKey}" placeholder="例如：長野站新幹線 11 號月台"><textarea id="transportExtraDetail-${fieldKey}" rows="2" placeholder="班次、出口、集合時間或備註"></textarea><input id="transportExtraLocation-${fieldKey}" placeholder="導航位置（可留空）"><div class="transport-segment-buttons"><button onclick="addTransportExtra(${dayIdx},'${segmentKey}')">儲存文字</button><button class="secondary" onclick="document.getElementById('transportExtraFile-${fieldKey}').click()">上傳圖片</button></div></div></details><input id="transportExtraFile-${fieldKey}" type="file" accept="image/*" multiple hidden onchange="handleTransportImageUpload(event,${dayIdx},'${segmentKey}')"></div>`;
}
function legacyTransportExtrasHTML(dayIdx){
  const data=transportExtrasFor(dayIdx);
  if(!data.notes.some(x=>!x.segmentKey)&&!data.images.some(x=>!x.segmentKey))return '';
  return `<details class="transport-legacy"><summary>其他舊版交通補充</summary>${transportSegmentExtrasHTML(dayIdx,'other')}</details>`;
}

/* ============ RENDER: ITINERARY ============ */
const dayScroll = document.getElementById('dayScroll');
const dayContent = document.getElementById('dayContent');
let activeDay = 0;

const FALLBACK_IMAGE='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#EDE5D3"/><stop offset="1" stop-color="#A6D1C2"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><path d="M0 520 L260 330 L430 450 L640 260 L900 480 L1200 360 V700 H0Z" fill="#83BCA9" opacity=".55"/><path d="M0 600 Q300 520 600 590 T1200 580 V700 H0Z" fill="#F7F3EA"/><text x="600" y="315" text-anchor="middle" font-size="58" font-family="sans-serif" fill="#3B6A5A">長野春旅</text><text x="600" y="380" text-anchor="middle" font-size="26" font-family="sans-serif" fill="#3B6A5A">圖片暫時無法載入</text></svg>`);
function imageErrorFallback(img){if(!img||img.dataset.fallbackApplied)return;img.dataset.fallbackApplied='1';img.src=FALLBACK_IMAGE;}
function mapsLink(value){
  const v=String(value||'').trim();
  if(/^https?:\/\//i.test(v))return v;
  if(/^[-+]?\d{1,3}(?:\.\d+)?\s*[,，]\s*[-+]?\d{1,3}(?:\.\d+)?$/.test(v))return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(v.replace('，',','));
  return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(v+' Japan');
}

function tripTodayIndex(now=new Date()){
  const y=now.getFullYear(),m=now.getMonth()+1,d=now.getDate();
  if(y!==2027)return -1;
  return days.findIndex((x,i)=>{if(!inPlan(i))return false;const [mm,dd]=x.date.split('/').map(Number);return mm===m&&dd===d;});
}
function goToToday(){
  const i=tripTodayIndex();setActiveDay(i>=0?i:0);
  if(i<0){const now=new Date();showToast(now<new Date(2027,3,24)?'旅程還沒開始，先顯示第 1 天（4/24）':'旅程已結束，顯示第 1 天');}
}
/* 旅途中 App 放在背景過夜，隔天打開時自動切到「今天」（使用者正在看別天時不打擾，只在停在昨天時切換） */
let _lastSeenDate=new Date().toDateString();
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible')return;
  const nowStr=new Date().toDateString();if(nowStr===_lastSeenDate)return;
  _lastSeenDate=nowStr;
  const t=tripTodayIndex();if(t<0)return;
  if(typeof activeDay==='number'&&activeDay===t-1&&!document.getElementById('formModal')){setActiveDay(t);showToast(`早安！已切到今天：D${days[t].dayNum}・${days[t].date}`);}
  else renderDayChips();
});

function renderDayChips(){
  const today=tripTodayIndex();
  dayScroll.innerHTML = `<button type="button" class="day-chip ng-today${today>=0?' live':''}" onclick="goToToday()"><div class="d">今日</div><div class="m">${today>=0?days[today].date:'—'}</div></button>`
    +days.map((d,i)=>!inPlan(i)?'':`<button type="button" class="day-chip ${i===activeDay?'active':''} ${i===today?'is-today':''}" data-i="${i}" onclick="setActiveDay(${i})" aria-pressed="${i===activeDay}"><div class="d">${d.date}</div><div class="m">週${d.weekday}</div></button>`).join('');
  const act=dayScroll.querySelector('.day-chip.active');
  if(act)requestAnimationFrame(()=>{const r=act.offsetLeft-(dayScroll.clientWidth-act.offsetWidth)/2;dayScroll.scrollTo({left:Math.max(0,r),behavior:'auto'});});
  if(typeof renderMarksBar==='function'&&typeof marksStore!=='undefined')renderMarksBar();
  if(typeof renderDayTools==='function')renderDayTools();
}

let activeSubTabStore = {}; /* dayIdx -> 'main' | 'transport' | 'more' | 'routemap' */

function transportPlanHTML(dayIdx){
  const plan=transportPlans[dayIdx];
  if(!plan)return `<section class="transport-plan"><div class="tp-head"><div><small>D${days[dayIdx].dayNum}・${days[dayIdx].date}</small><strong>今日交通</strong></div><img src="images/art-route.webp" alt="" width="56" height="56"></div>${tpLiveBarHTML(dayIdx)}${customTransportHTML(dayIdx)}${transportAddBarHTML(dayIdx)}</section>`;
  const routes=(rows,prefix='route')=>`<div class="transport-steps">${(rows||[]).map((r0,i)=>{const segmentKey=`${prefix}-${i}`;const sk=`tp${dayIdx}-${segmentKey}`;if(currentFieldValue(sk,'hidden',null)==='1')return '';const r={from:currentFieldValue(sk,'from',r0.from)||r0.from,to:currentFieldValue(sk,'to',r0.to)||r0.to,mode:currentFieldValue(sk,'mode',r0.mode)||r0.mode,time:currentFieldValue(sk,'time',r0.time)||r0.time,note:currentFieldValue(sk,'note',r0.note)||r0.note};window._tpOrig=window._tpOrig||{};window._tpOrig[sk]=r0;return `<div class="transport-step"><span class="transport-step-no">${i+1}</span><div class="transport-step-main"><div class="transport-points"><strong>${escHtml(r.from)}</strong><span>→</span><strong>${escHtml(r.to)}</strong></div><div class="transport-meta"><b>${escHtml(r.mode)}</b><span>⏱ ${escHtml(r.time)}</span></div><small>${escHtml(r.note)}</small>${tpGoButtonsHTML(dayIdx,r,i===(rows||[]).length-1)}<div class="edit-only tp-step-actions"><button type="button" onclick="editTransportStep('${sk}')">✎ 修改</button><button type="button" onclick="deleteTransportStep('${sk}')">🗑 刪除</button></div>${transportSegmentExtrasHTML(dayIdx,segmentKey)}</div></div>`;}).join('')}</div>`;
  const body=plan.choices?`<div class="transport-choice-list">${plan.choices.map((choice,i)=>`<details class="transport-choice"${i===0?' open':''}><summary>${escHtml(choice.name)}<span>展開路線</span></summary>${routes(choice.routes,`choice-${i}`)}</details>`).join('')}</div>`:plan.drive?`<div class="transport-drive-card"><span>🚗</span><div><strong>今天全程自駕</strong><small>按下方按鈕開啟當日主要地點導航；停車、休息站與道路狀況以當日為準。</small>${transportSegmentExtrasHTML(dayIdx,'drive-0')}</div></div>`:routes(plan.routes);
  return `<section class="transport-plan"><div class="tp-head"><div><small>D${days[dayIdx].dayNum}・${days[dayIdx].date}</small><strong>今日交通</strong></div><img src="images/art-route.webp" alt="" width="56" height="56"></div>${tpLiveBarHTML(dayIdx)}<div class="transport-alert">⚠️ ${escHtml(plan.alert)}</div>${body}${customTransportHTML(dayIdx)}${legacyTransportExtrasHTML(dayIdx)}${transportAddBarHTML(dayIdx)}<div class="transport-actions"><a href="https://www.google.com/maps/dir/?api=1&travelmode=${plan.drive?'driving':'transit'}&destination=${encodeURIComponent(currentFieldValue('day'+dayIdx+'-nav','mapQuery',null)||(days[dayIdx].region+' Japan'))}" target="_blank" rel="noopener">📍 開啟今日導航</a><button type="button" class="edit-only tp-nav-fix" onclick="editSpotField(event,'day${dayIdx}-nav','mapQuery','今日導航目的地（地址、經緯度或關鍵字）')">修正導航</button><button type="button" class="edit-only tp-nav-fix" onclick="restoreTransportSteps(${dayIdx})">↺ 還原本日交通步驟</button></div></section>`;
}

function setActiveDay(i) {
  if(typeof closeSpotDetail==='function')closeSpotDetail();
  if(typeof i==='number'&&days[i]&&!inPlan(i)){const hit=planDays().find(j=>days[j].date===days[i].date);if(hit!=null)i=hit;}
  activeDay = i;
  renderDayChips();
  renderDayContent();
  document.getElementById('view-itinerary').scrollIntoView({behavior:'smooth', block:'start'});
}

/* 全站搜尋：包含 10 天內建景點、自訂景點、餐廳、購物與住宿。 */
function allSearchableSpots(){
  const out=[];
  days.forEach((day,day0Idx)=>{
    if(!inPlan(day0Idx))return;
    const dayIdx=day0Idx;
    const add=(spot,key)=>{
      const dayIdx=(typeof spotDayOf==='function'?spotDayOf(key):null)??day0Idx;
      const day=days[dayIdx];
      if((hiddenFixedSpotsStore[dayIdx]||[]).includes(key))return;
      const name=currentFieldValue(key,'name',spot.name)||spot.name;
      const desc=currentFieldValue(key,'desc',spot.desc)||spot.desc||'';
      const full=currentFieldValue(key,'fullDesc',spot.fullDesc)||spot.fullDesc||'';
      const info=currentBuiltInInfo(key,spot.customInfo||'')||'';
      const listType=MAIN_CATS.includes(spot.cat)?'main':'more';
      out.push({dayIdx,key,listType,name,desc,cat:spot.cat,text:[name,desc,full,info,(spot.tags||[]).join(' '),day.region,day.title].join(' ').toLocaleLowerCase('zh-Hant')});
    };
    (day.spots||[]).forEach((spot,i)=>{if(!spot.removed)add(spot,`d${dayIdx}-m${i}`);});
    (day.moreSpots||[]).forEach((spot,i)=>add(spot,`d${dayIdx}-s${i}`));
    (customSpotsStore[dayIdx]||[]).forEach((spot,i)=>{if(!spot.deleted)add(spot,`d${dayIdx}-c${i}`);});
    const plan=transportPlans[dayIdx];
    if(plan){
      const routeText=[...(plan.routes||[]),...(plan.choices||[]).flatMap(c=>c.routes||[])].map(r=>[r.from,r.to,r.mode,r.time,r.note].join(' ')).join(' ');
      out.push({dayIdx,key:'transport-'+dayIdx,listType:'transport',name:'每日交通速查',desc:plan.summary,cat:'transport',text:[plan.summary,plan.alert,routeText,'交通 巴士 地下鐵 電車 計程車 自駕'].join(' ').toLocaleLowerCase('zh-Hant')});
    }
    const extras=transportExtrasStore[dayIdx];
    (extras?.notes||[]).forEach((n,i)=>out.push({dayIdx,key:`transport-extra-${dayIdx}-${i}`,listType:'transport',name:n.title||'交通補充',desc:n.detail||n.location||'',cat:'transport',text:[n.title,n.detail,n.location,'交通補充 集合 月台 班次'].filter(Boolean).join(' ').toLocaleLowerCase('zh-Hant')}));
  });
  return out;
}
function runGlobalSearch(raw){
  const query=String(raw||'').trim().toLocaleLowerCase('zh-Hant');
  document.querySelectorAll('#globalSearchDesktop,#globalSearchMobile').forEach(input=>{if(input.value!==raw)input.value=raw;});
  const targets=[document.getElementById('globalSearchResultsDesktop'),document.getElementById('globalSearchResultsMobile')].filter(Boolean);
  if(!query){targets.forEach(el=>{el.classList.remove('open');el.innerHTML='';});return;}
  const terms=query.split(/\s+/).filter(Boolean);
  const results=allSearchableSpots().filter(item=>terms.every(term=>item.text.includes(term))).slice(0,16);
  const html=results.length?results.map(item=>{
    const day=days[item.dayIdx],cat=CAT[item.cat]||CAT.attraction;
    return `<button class="search-result-item" type="button" onclick="jumpToSearchResult(${item.dayIdx},'${item.key}','${item.listType}')"><span class="search-result-day">D${day.dayNum}<br>${day.date}</span><span class="search-result-copy"><strong>${cat.emoji} ${escHtml(item.name)}</strong><small>${escHtml(item.desc||day.region)}</small></span></button>`;
  }).join(''):`<div class="search-empty">找不到符合「${escHtml(raw)}」的行程</div>`;
  targets.forEach(el=>{el.innerHTML=html;el.classList.add('open');});
}
function jumpToSearchResult(dayIdx,key,listType){
  if(typeof isMasterKey==='function'&&isMasterKey(key)){
    const p=planOf(key);
    if(p!=null){dayIdx=p;listType='more';}
    else{const sp=spotByKey(key);setTab('itinerary');setActiveDay(sp&&sp.cat==='shopping'?'shop':'eat');setTimeout(()=>openSpotDetail(key),80);return;}
  }
  setTab('itinerary');
  activeDay=dayIdx;activeSubTabStore[dayIdx]=listType;
  renderDayChips();renderDayContent();
  document.querySelectorAll('#globalSearchDesktop,#globalSearchMobile').forEach(input=>input.value='');
  document.querySelectorAll('.global-search-results').forEach(el=>{el.classList.remove('open');el.innerHTML='';});
  setTimeout(()=>{
    const card=document.getElementById('spot-card-'+key);
    if(card){card.classList.add('open');openSpotCardKeys.add(String(key));card.scrollIntoView({behavior:'smooth',block:'center'});}
    else if(listType==='transport')document.querySelector('.transport-plan')?.scrollIntoView({behavior:'smooth',block:'start'});
  },80);
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')runGlobalSearch('');});
document.addEventListener('click',event=>{
  if(!event.target.closest?.('.global-search-input-wrap,.global-search-results')){
    document.querySelectorAll('.global-search-results').forEach(el=>el.classList.remove('open'));
  }
});
document.addEventListener('keydown',event=>{
  if(event.key==='Enter'&&event.target.matches?.('#globalSearchDesktop,#globalSearchMobile')){
    const scope=event.target.id==='globalSearchDesktop'?'#globalSearchResultsDesktop':'#globalSearchResultsMobile';
    document.querySelector(scope+' .search-result-item')?.click();
  }
});

/* 保留景點卡片展開狀態，避免背景同步重繪後自動收合。 */
const openSpotCardKeys = new Set();
function rememberOpenSpotCards(){
  document.querySelectorAll('[id^="spot-card-"].open').forEach(card=>{
    openSpotCardKeys.add(card.id.replace('spot-card-',''));
  });
}
function restoreOpenSpotCards(){
  openSpotCardKeys.forEach(key=>{
    const card=document.getElementById('spot-card-'+key);
    if(card) card.classList.add('open');
  });
}
/* (v56 已改寫) */

function spotCardHTML(spot, key, isMainSpot, customMeta, orderInfo, fixedMeta){
  const idx = key;
  const c = CAT[spot.cat];
  const badges = [];
  if(spot.tags){
    spot.tags.forEach(t=>{
      if(t==='必吃') badges.push('<span class="badge b-eat">🍴 必吃</span>');
      if(t==='必買') badges.push('<span class="badge b-buy">🎁 必買</span>');
      if(t==='必拍') badges.push('<span class="badge b-photo">📸 必拍</span>');
    });
  }
  
  const infoBits = [];
  window._spotFieldOriginals[idx] = { cat: spot.cat, dur: spot.dur || null, hours: spot.hours || null, note: spot.note || null, name: spot.name || null, desc: spot.desc || null, fullDesc: spot.fullDesc || null };
  const displayName = currentFieldValue(idx, 'name', spot.name) || spot.name;
  const displayDesc = currentFieldValue(idx, 'desc', spot.desc) || spot.desc;
  const displayFullDesc = currentFieldValue(idx, 'fullDesc', spot.fullDesc) || displayDesc;
  const navQuery = currentFieldValue(idx, 'mapQuery', null) || spot.mapQuery || displayName;
  const safeName=escHtml(displayName),safeDesc=escHtml(displayDesc),safeFullDesc=escHtml(displayFullDesc);
  const durVal = currentFieldValue(idx, 'dur', spot.dur);
  if(durVal) infoBits.push(`<div class="info-item"><div class="k field-k-row">建議停留<span class="field-edit-actions"><button onclick="event.stopPropagation(); editSpotField(event,'${idx}','dur','建議停留時間')" title="編輯">編輯</button><button onclick="event.stopPropagation(); clearSpotField(event,'${idx}','dur')" title="清空">✕</button></span></div><div class="v">${escHtml(durVal)}</div></div>`);
  else infoBits.push(`<div class="info-item is-empty"><div class="k">建議停留</div><div class="v"><button class="field-add-btn" onclick="event.stopPropagation(); editSpotField(event,'${idx}','dur','建議停留時間')">＋ 新增</button></div></div>`);
  if(spot.cat==='hotel') infoBits.unshift(hotelAmenityBlock(idx));
  const hoursVal = currentFieldValue(idx, 'hours', spot.hours);
  if(hoursVal) infoBits.push(`<div class="info-item"><div class="k field-k-row">營業／開放時間<span class="field-edit-actions"><button onclick="event.stopPropagation(); editSpotField(event,'${idx}','hours','營業／開放時間')" title="編輯">編輯</button><button onclick="event.stopPropagation(); clearSpotField(event,'${idx}','hours')" title="清空">✕</button></span></div><div class="v info-hours">${escHtml(hoursVal)}</div></div>`);
  else infoBits.push(`<div class="info-item is-empty"><div class="k">營業／開放時間</div><div class="v"><button class="field-add-btn" onclick="event.stopPropagation(); editSpotField(event,'${idx}','hours','營業／開放時間')">＋ 新增</button></div></div>`);
  const noteVal = currentFieldValue(idx, 'note', spot.note);
  if(noteVal) infoBits.push(`<div class="info-item full-w important-info"><div class="k field-k-row">重要提點／門票<span class="field-edit-actions"><button onclick="event.stopPropagation(); editSpotField(event,'${idx}','note','重要提點／門票')" title="編輯">編輯</button><button onclick="event.stopPropagation(); clearSpotField(event,'${idx}','note')" title="清空">✕</button></span></div><div class="v">${brText(noteVal)}</div></div>`);
  else infoBits.push(`<div class="info-item full-w is-empty"><div class="k">重要提點／門票</div><div class="v"><button class="field-add-btn" onclick="event.stopPropagation(); editSpotField(event,'${idx}','note','重要提點／門票')">＋ 新增</button></div></div>`);
  
  const userPhotos = photoStore[idx] || [];
  const thumbImgs = [];
  const thumbImgsAreUserPhotos = false;
  const coverUrl = coverUrlFor(idx, spot);
  const bg = coverUrl || FALLBACK_IMAGE;
  const detailUrl = detailUrlFor(idx, spot);

  /* 使用者新增的資訊：可新增多筆，各自獨立刪除，不會互相覆蓋 */
  let userNotes = notesStore[idx] || [];
  let notesListHTML = userNotes.length ? userNotes.map((n,ni)=>`<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-top:6px; padding-top:6px; border-top:1px dashed rgba(0,0,0,0.12);"><span style="flex:1; white-space:pre-line;">${escHtml(n)}</span><span class="note-actions"><button onclick="event.stopPropagation(); editNote('${idx}', ${ni})" title="編輯">編輯</button><button onclick="event.stopPropagation(); deleteNote('${idx}', ${ni})" title="刪除">刪除</button></span></div>`).join('') : '';
  const builtInInfo = currentBuiltInInfo(idx, spot.customInfo || null);
  window._spotCustomInfoOriginals[idx] = spot.customInfo || null;
  let displayInfo = '';
  if (builtInInfo) displayInfo += `<div class="built-in-info-row"><span class="built-in-info-text">${brText(builtInInfo)}</span><span class="note-actions built-in-actions"><button onclick="event.stopPropagation(); editBuiltInInfo('${idx}')" title="編輯這筆">編輯</button><button onclick="event.stopPropagation(); deleteBuiltInInfo('${idx}')" title="刪除這筆">刪除</button></span></div>`;
  if (notesListHTML) displayInfo += `<div class="user-info-list" style="margin-top:${builtInInfo ? '8px' : '0'};"><span class="user-info-label">✏️ 您新增的資訊：</span>${notesListHTML}</div>`;

  let customInfoBox = '';
  if (displayInfo) {
    customInfoBox = `<div class="custom-info-box" onclick="event.stopPropagation()"><div class="custom-info-heading"><b>💬 評論與資訊</b><button class="custom-info-add" onclick="toggleEditNote(event, '${idx}')">＋ 新增</button></div>${displayInfo}</div>`;
  }

  const noteDraft=readNoteDrafts()[idx]||'';
  const noteEditorOpen=openNoteEditors.has(String(idx))||!!noteDraft;
  let noteEditArea = `<div class="note-edit-area" style="margin-top:10px; display:${noteEditorOpen?'block':'none'};" id="edit-note-${idx}" onclick="event.stopPropagation()"><textarea id="note-input-${idx}" placeholder="新增一筆攻略、必點菜單或提醒...（可重複新增多筆）" oninput="saveNoteDraft('${idx}',this.value);openNoteEditors.add('${idx}')" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:8px; font-size:12px; font-family:inherit; resize:vertical; min-height:60px; outline:none; margin-bottom:6px;">${escHtml(noteDraft)}</textarea><div style="display:flex; gap:6px;"><button onclick="addNote('${idx}')" style="padding:6px 14px; font-size:11px; background:var(--blue); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:700;">💾 新增這筆</button><button onclick="toggleEditNote(event, '${idx}')" style="padding:6px 14px; font-size:11px; background:#F4F1EB; color:var(--ink); border:none; border-radius:6px; cursor:pointer; font-weight:700;">收合</button></div></div>${!displayInfo ? `<button class="btn-note-toggle" onclick="toggleEditNote(event, '${idx}')" style="${noteEditorOpen?'display:none;':''}background:transparent; border:1px dashed #B3BDBA; border-radius:999px; padding:6px 12px; font-size:11.5px; color:#3D6054; cursor:pointer; font-family:inherit; margin-top:6px; margin-bottom:10px;" id="btn-note-${idx}">➕ 新增評論與資訊</button>` : ''}`;

  let miniStripHTML = thumbImgs.length > 0 ? `<div class="mini-photo-strip" onclick="event.stopPropagation();">` + thumbImgs.map((u, i) => `<div style="position:relative; display:inline-block;"><img src="${u}"${photoPosAttr(u)} onclick="openAttachModal('${u}')">${thumbImgsAreUserPhotos ? `<button class="photo-remove" onclick="removePhoto(event, '${idx}', ${i})" style="position:absolute; top:2px; right:2px; width:16px; height:16px; font-size:8px;">✕</button>` : ''}</div>`).join('') + `</div>` : '';

  const pStrip = photoManagerHTML(idx, spot);

  const badgesHTML = badges.length ? `<div class="badges" style="margin-bottom:6px;">${badges.join('')}</div>` : '';
  const infoHTML = infoBits.length ? `<div class="info-grid">${infoBits.join('')}</div>` : '';
  const noteHTML = `${customInfoBox}${noteEditArea}`;
  const blockDefs = [];
  if(badgesHTML) blockDefs.push({id:'badges', html: badgesHTML});
  if(infoHTML) blockDefs.push({id:'info', html: infoHTML});
  blockDefs.push({id:'note', html: noteHTML});
  const naturalBlockIds = blockDefs.map(b=>b.id);
  let blockOrder = blockOrderStore[idx];
  if(blockOrder && blockOrder.length){
    blockOrder = blockOrder.filter(id=>naturalBlockIds.includes(id));
    naturalBlockIds.forEach(id=>{ if(!blockOrder.includes(id)) blockOrder.push(id); });
  } else {
    blockOrder = naturalBlockIds.slice();
  }
  const byBlockId = {}; blockDefs.forEach(b=>byBlockId[b.id]=b);
  const orderedBlocks = blockOrder.map(id=>byBlockId[id]).filter(Boolean);
  const hasBadgesFlag = badgesHTML ? 'true' : 'false';
  const hasInfoFlag = infoHTML ? 'true' : 'false';
  const reorderableBlocksHTML = orderedBlocks.map((b,pos)=>{
    const upBtn = pos > 0 ? `<button onclick="event.stopPropagation(); moveBlock('${idx}','${b.id}',-1,${hasBadgesFlag},${hasInfoFlag})" style="background:#F1EEE6; border:none; cursor:pointer; font-size:10px; color:#9AA3AD; padding:2px 6px; border-radius:5px;">⬆</button>` : '';
    const downBtn = pos < orderedBlocks.length - 1 ? `<button onclick="event.stopPropagation(); moveBlock('${idx}','${b.id}',1,${hasBadgesFlag},${hasInfoFlag})" style="background:#F1EEE6; border:none; cursor:pointer; font-size:10px; color:#9AA3AD; padding:2px 6px; border-radius:5px;">⬇</button>` : '';
    return (orderedBlocks.length > 1 ? `<div class="block-order-actions" style="display:flex; justify-content:flex-end; gap:4px; margin:2px 0;">${upBtn}${downBtn}</div>` : '') + b.html;
  }).join('');

  const genLabel = spot.genSource === 'edited' ? '✏️ 簡介已由您編輯' : (spot.genSource === 'online' ? '🔍 簡介已透過網路搜尋生成' : (spot.genSource === 'offline' ? '📝 簡介為簡易生成（未連上網路）' : '🆕 自訂景點'));
  const orderBtns = orderInfo ? `<button onclick="event.stopPropagation(); moveSpot(${orderInfo.dayIdx}, '${orderInfo.listType}', '${idx}', -1)" style="background:#F1EEE6; color:var(--ink-soft); border:none; padding:4px 9px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer;">⬆ 上移</button><button onclick="event.stopPropagation(); moveSpot(${orderInfo.dayIdx}, '${orderInfo.listType}', '${idx}', 1)" style="background:#F1EEE6; color:var(--ink-soft); border:none; padding:4px 9px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer;">⬇ 下移</button>` : '';
  const fixedDelBtn = (fixedMeta&&fixedMeta.planned) ? `<button onclick="event.stopPropagation(); unplanItem('${idx}')" style="background:#FAF7F1; color:#417363; border:none; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">移出當天</button>` : fixedMeta ? `<button onclick="event.stopPropagation(); hideFixedSpot(${fixedMeta.dayIdx}, '${idx}')" style="background:#FAF7F1; color:#417363; border:none; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">➖ 刪減此項</button>` : '';
  const delBtn = customMeta ? `<button onclick="event.stopPropagation(); delCustomSpot(${customMeta.dayIdx}, ${customMeta.i})" style="background:#FAF7F1; color:#4D7A6B; border:none; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">🗑️ 刪除此景點</button>` : '';
  const editBtn = customMeta ? `<button onclick="event.stopPropagation(); toggleEditSpot('${idx}')" style="background:#F9F6F0; color:var(--blue); border:none; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">✏️ 編輯簡介</button>` : '';
  const editInfoBtn = `<button onclick="event.stopPropagation(); openSpotEditModal(event,'${idx}')" style="background:#F9F6F9; color:#4D7A6B; border:none; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">✎ 編輯景點資訊</button>`;
  const canMoveDay = !(fixedMeta&&fixedMeta.planned) && spot.cat!=='hotel' && typeof naturalDayOf==='function' && naturalDayOf(idx)!=null && !(typeof isMasterKey==='function'&&isMasterKey(idx));
  const moveDayBtn = canMoveDay ? `<button class="move-day-btn" onclick="event.stopPropagation(); openSpotDayModal('${idx}')">📅 改日期</button>` : '';
  const movedBadge = (canMoveDay && isSpotMoved(idx)) ? `<span class="badge moved-badge">原本 D${days[naturalDayOf(idx)].dayNum}・${days[naturalDayOf(idx)].date}</span>` : '';
  const customBar = `<div class="spot-management-bar" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;"><span style="display:flex; gap:6px; flex-wrap:wrap;">${movedBadge}${customMeta ? `<span class="badge" style="background:#F9F6F0; color:var(--blue);">${genLabel}</span>` : ''}</span><span style="display:flex; gap:6px; flex-wrap:wrap;">${orderBtns}${moveDayBtn}${editInfoBtn}${editBtn}${delBtn}${fixedDelBtn}</span></div>`;
  const editSpotAreaHTML = customMeta ? `<div id="spot-edit-${idx}" style="display:none; margin-bottom:10px; background:#FCFAF7; border:1px dashed #BAD4CB; border-radius:8px; padding:10px;" onclick="event.stopPropagation()">
      <div style="font-size:11px; font-weight:700; color:var(--ink-soft); margin-bottom:4px;">簡短介紹（列表中顯示）</div>
      <textarea id="spot-edit-short-${idx}" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:6px; font-size:12px; font-family:inherit; resize:vertical; min-height:40px; outline:none; margin-bottom:8px; box-sizing:border-box;">${(spot.desc||'').replace(/</g,'&lt;')}</textarea>
      <div style="font-size:11px; font-weight:700; color:var(--ink-soft); margin-bottom:4px;">完整簡介（展開後顯示）</div>
      <textarea id="spot-edit-full-${idx}" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:6px; font-size:12px; font-family:inherit; resize:vertical; min-height:80px; outline:none; margin-bottom:8px; box-sizing:border-box;">${(spot.fullDesc||spot.desc||'').replace(/</g,'&lt;')}</textarea>
      <div style="display:flex; gap:6px;">
        <button onclick="saveSpotEdit(${customMeta.dayIdx}, ${customMeta.i}, '${idx}')" style="padding:6px 14px; font-size:11px; background:var(--blue); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:700;">💾 儲存</button>
        <button onclick="toggleEditSpot('${idx}')" style="padding:6px 14px; font-size:11px; background:#F4F1EB; color:var(--ink); border:none; border-radius:6px; cursor:pointer; font-weight:700;">取消</button>
      </div>
    </div>` : '';

  if (!isMainSpot) {
    return `<div class="sub-spot-card sub-spot-${spot.cat || 'other'}" id="spot-card-${idx}"><div class="sub-spot-header${coverUrl?' has-thumb':''}" onclick="toggleSpotDetails('${idx}')">${coverUrl?`<div class="gh-thumb sm">${coverImgHTML('guide-cover-img',coverUrl)}</div>`:''}<div class="sub-spot-header-content"><h4>${safeName} ${statusChipHTML(idx)}</h4><p class="short-desc">${safeDesc}</p>${miniStripHTML}</div>${favBtnHTML(idx,"inline")}<div class="chevron">▼</div></div><div class="sub-spot-details-wrap"><div class="sub-spot-details" onclick="event.stopPropagation()">${photoViewerHTML(idx,spot)}${customBar}${editSpotAreaHTML}<p class="full-desc">${safeFullDesc}</p>${marksBoxHTML(idx)}${spot.recDishes ? `<div class="dish-tag">🍲 必點推薦：${escHtml(spot.recDishes)}</div>` : ''}${reorderableBlocksHTML}<div class="action-row" style="margin-top:10px;"><a class="btn btn-map" href="${escAttr(mapsLink(navQuery))}" target="_blank" rel="noopener">導航</a><button class="btn btn-photo edit-only" onclick="event.stopPropagation(); editSpotField(event,'${idx}','mapQuery','導航位置（Google Maps 網址、地址、經緯度或關鍵字；留空＝用景點名稱）')">修正導航</button>${spot.link ? `<a class="btn btn-photo" href="${escAttr(spot.link)}" target="_blank" rel="noopener">${escHtml(spot.linkLabel)}</a>` : ''}<button class="btn btn-photo" onclick="document.getElementById('file-${idx}').click()">上傳照片</button>${resvButtonsHTML(idx,spot)}${mamaBtnHTML(idx)}${(eatAreaStore[idx]==='none'&&(spot.cat==='food'||spot.cat==='shopping'))?`<button class="btn btn-photo" onclick="event.stopPropagation();restoreEatShopItem('${idx}')">加回${spot.cat==='food'?'吃':'逛'}·旅途</button>`:''}</div><input type="file" accept="image/*" id="file-${idx}" style="display:none" multiple onchange="handlePhoto(event, '${idx}')">${subSpotsHTML(idx)}${pStrip}${collapseBtnHTML(idx)}</div></div></div>`;
  }

  return `<div class="guide-card" id="spot-card-${idx}"><div class="guide-header" style="--scrim:${CAT_SCRIM[spot.cat]||'22,34,70'}" onclick="toggleSpotDetails('${idx}')"><div class="gh-thumb"><img class="guide-cover-img" src="${escAttr(bg)}"${photoPosAttr(bg)} alt="" loading="lazy" onerror="imageErrorFallback(this)"><button class="photo-pos-btn edit-only" type="button" data-src="${escAttr(bg)}" onclick="openPhotoPosEditor(event,this)">調整位置</button></div><div class="guide-header-content"><div class="gh-meta"><span class="cat-label ${c.cls}">${c.emoji} ${c.label}</span>${statusChipHTML(idx)}</div><h3>${safeName}</h3><p class="short-desc">${safeDesc}</p></div>${favBtnHTML(idx,"on-cover")}<div class="chevron">▼</div></div><div class="guide-details-wrap"><div class="guide-details" onclick="event.stopPropagation()">${photoViewerHTML(idx,spot)}${customBar}${editSpotAreaHTML}<p class="full-desc">${safeFullDesc}</p>${marksBoxHTML(idx)}${reorderableBlocksHTML}${spot.tip?`<div class="tip-box"><b>📸 拍照與自駕小解密：</b>${escHtml(spot.tip)}</div>`:''}${spot.docMap?`<div class="tip-box" style="background: linear-gradient(120deg,#F6F3EA,#fff); border-color:#F1EADB; color:#2A4039;"><b>🗺️ 官方步道地圖與狀態：</b><a href="${escAttr(spot.docMap)}" target="_blank" rel="noopener" style="color:var(--blue); font-weight:700; text-decoration:underline;">點此開啟</a></div>`:''}${spot.park?`<div class="park-box"><b>🅿️ 停車＆自駕補給：</b>${escHtml(spot.park)}</div>`:''}<div class="action-row" style="margin-top:10px;"><a class="btn btn-map" href="${escAttr(mapsLink(navQuery))}" target="_blank" rel="noopener">導航導出</a><button class="btn btn-photo edit-only" onclick="event.stopPropagation(); editSpotField(event,'${idx}','mapQuery','導航位置（Google Maps 網址、地址、經緯度或關鍵字；留空＝用景點名稱）')">修正導航</button>${spot.link ? `<a class="btn btn-photo" href="${escAttr(spot.link)}" target="_blank" rel="noopener">${escHtml(spot.linkLabel)}</a>` : ''}<button class="btn btn-photo" onclick="document.getElementById('file-${idx}').click()">上傳照片</button>${resvButtonsHTML(idx,spot)}${mamaBtnHTML(idx)}</div><input type="file" accept="image/*" id="file-${idx}" style="display:none" multiple onchange="handlePhoto(event, '${idx}')">${subSpotsHTML(idx)}${pStrip}${collapseBtnHTML(idx)}</div></div></div>`;
}

/* 讀取檔案並自動壓縮：長邊限制在 1600px、轉存為 JPEG(品質0.82)，
   一般手機相片可從 3-8MB 壓到數百KB，大幅降低 localStorage 塞滿導致上傳失敗的機率。
   若圖片無法被瀏覽器解碼（極少數情況），則退回存原始檔案。 */
function fileToDataURL(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = reader.result;
      const img = new Image();
      img.onload = () => {
        try {
          const MAX_DIM = 1600;
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_DIM || h > MAX_DIM) {
            if (w > h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
            else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        } catch(err) {
          resolve(rawDataUrl);
        }
      };
      img.onerror = () => resolve(rawDataUrl);
      img.src = rawDataUrl;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function handlePhoto(e, idx){
  const files = Array.from(e.target.files || []); e.target.value='';
  if(!files.length) return;
  if(!photoStore[idx]) photoStore[idx] = [];
  updateSyncStatus(null,'saving');
  /* hk16：顯示「上傳中 2/5」；每張上傳成功就先存起來，某一張失敗也不會讓前面已上傳的照片消失 */
  let ok=0,lastErr=null;
  window._upBatch={i:0,total:files.length};
  for(let i=0;i<files.length;i++){
    window._upBatch.i=i;
    try{
      const url=await uploadMediaFile(files[i],`spot-photos/${idx.replace(/[^a-zA-Z0-9_-]/g,'_')}`);
      if(!photoStore[idx]) photoStore[idx] = [];
      photoStore[idx].push(url); persistPhotos(); ok++;
    }catch(err){ lastErr=err; console.error('照片上傳失敗',err); }
  }
  window._upBatch=null;
  if(ok){ renderDayContent(); reopenCard(idx); }
  if(lastErr){
    updateSyncStatus(lastErr);
    if(ok) showToast(`已上傳 ${ok} 張，${files.length-ok} 張失敗：${friendlySyncError(lastErr)}`);
    else reportUploadError(lastErr);
  }else showToast(`已上傳 ${ok} 張照片`);
}
function showUploadProgress(text){
  let el=document.getElementById('uploadProgress');
  if(!el){el=document.createElement('div');el.id='uploadProgress';el.className='upload-progress';el.setAttribute('role','status');document.body.appendChild(el);}
  el.textContent=text;el.hidden=false;
}
window.addEventListener('beforeunload',e=>{if((window._upPending||0)>0){e.preventDefault();e.returnValue='照片還在上傳中';}});
function hideUploadProgress(){const el=document.getElementById('uploadProgress');if(el)el.hidden=true;}
function movePhoto(e, idx, photoIdx, dir) {
  if(e)e.stopPropagation();
  const arr = photoStore[idx];
  if (!arr) return;
  const target = photoIdx + dir;
  if (target < 0 || target >= arr.length) return;
  [arr[photoIdx], arr[target]] = [arr[target], arr[photoIdx]];
  const sel = coverStore[idx];
  if (sel === photoIdx) coverStore[idx] = target;
  else if (sel === target) coverStore[idx] = photoIdx;
  persistCover();
  persistPhotos();
  renderDayContent();
  setTimeout(()=>{ const card = document.getElementById('spot-card-'+idx); if(card) card.classList.add('open'); }, 50);
}

/* (v54 已改寫) */

/* (v54 已改寫) */
function closeAttachModal() { const m=document.getElementById('attachModal');m.classList.remove('active','zoomed');document.getElementById('attachModalImg').classList.remove('zoomed'); }

/* (v49 已改寫，見檔案後段) */

function fuelPricePanel(day){
  if(!day.gas) return '';
  return `<div class="fuel-price-panel"><div class="fuel-price-head"><span>${escHtml(day.gas)}</span><a href="https://www.google.com/maps/search/gas+station+Nagano+Japan" target="_blank" rel="noopener">🚗 查看沿途加油站</a></div><small>油價與營業狀況請以現場及地圖資訊為準。</small></div>`;
}

function renderDayContent(){
  if(window._detailKey)setTimeout(()=>{if(document.getElementById('spotDetailSheet'))renderSpotDetail(false);},0);
  if(typeof activeDay==='string'){renderEatShopView(activeDay);renderDayTools();return;}
  renderDayTools();
  rememberOpenSpotCards();
  const previousScrollY = window.scrollY;
  const d = days[activeDay];
  const curSubTab = activeSubTabStore[activeDay] || 'main';
  const stayList=dayStays(activeDay);
  const stayBtns=stayList.length?`<span class="stay-quick-btns"><a class="stay-quick-nav" href="${escAttr(mapsLink(stayList[0].nav))}" target="_blank" rel="noopener">導航</a><button class="stay-quick-driver" type="button" data-name="${escAttr(stayList[0].name)}" data-nav="${escAttr(stayList[0].nav)}" onclick="showDriverCard(this.dataset.name,this.dataset.nav)">給司機看</button><button class="stay-quick-fix edit-only" type="button" onclick="editSpotField(event,'${stayList[0].key}','mapQuery','導航位置（Google Maps 網址、地址、經緯度或關鍵字）')">修正</button></span>`:'';
  const stayQuickHTML=stayList.length?`<div class="stay-quick-card"><div class="stay-quick-top"><div class="stay-quick-icon"><img src="images/nav-lodging.webp" alt="" width="34" height="34"></div><div class="stay-quick-copy"><small>今晚住宿</small><strong>${stayList.map(x=>escHtml(x.name)).join('、')}</strong></div></div>${stayList.map((x,i)=>`<div class="stay-quick-amen">${stayList.length>1?`<em>${escHtml(x.name)}</em>`:''}${hotelAmenityChips(x.key)}${i===stayList.length-1?stayBtns:''}</div>`).join('')}</div>`:emptyStayCardHTML(activeDay);

  const mainList = applyOrder(activeDay, 'main', getNaturalList(activeDay, 'main'));
  const lifeList = applyOrder(activeDay, 'life', getNaturalList(activeDay, 'life'));

  let mainSpotsHTML = mainList.map(o=>spotCardHTML(o.spot, o.key, true, o.customMeta, {dayIdx:activeDay, listType:'main'}, o.fixedMeta)).join('');
  if(!mainSpotsHTML) mainSpotsHTML = '<div class="empty">此區域今天暫無排定主要亮點。</div>';

  let secondaryCardsHTML = lifeList.map(o=>spotCardHTML(o.spot, o.key, false, o.customMeta, {dayIdx:activeDay, listType:'life'}, o.fixedMeta)).join('');
  if(!secondaryCardsHTML) secondaryCardsHTML = '<div class="empty">此區域今天暫無排定食衣住項目，歡迎在下方新增您的私房景點。</div>';

  const addSpotFormHTML = `
    <div class="section-card edit-only" style="margin-top:4px;">
      <h3 style="margin:0 0 10px;">✨ 新增景點／食衣住項目</h3>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <input type="text" id="newSpotName-${activeDay}" placeholder="景點名稱（必填）" style="padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-family:inherit; font-size:13px;">
        <select id="newSpotCat-${activeDay}" style="padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-family:inherit; font-size:13px;">
          ${Object.keys(CAT).map(k=>`<option value="${k}">${CAT[k].emoji} ${CAT[k].label}</option>`).join('')}
        </select>
        <input type="text" id="newSpotKw-${activeDay}" placeholder="關鍵字，如：紫藤、蕎麥麵、溪谷（可留空）" style="padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-family:inherit; font-size:13px;">
        <input type="text" id="newSpotDur-${activeDay}" placeholder="建議停留時間，如：約1小時（可留空）" style="padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-family:inherit; font-size:13px;">
        <button id="addSpotBtn-${activeDay}" onclick="addCustomSpot(${activeDay})" style="background:linear-gradient(135deg, var(--blue), #3B6A5A); color:#fff; border:none; padding:11px; border-radius:999px; font-family:inherit; font-size:13px; font-weight:700; cursor:pointer;">＋ 新增並自動生成簡介</button>
      </div>
      <div style="font-size:11px; color:var(--ink-soft); margin-top:8px; line-height:1.5;" id="addSpotStatus-${activeDay}">新增後會依景點名稱與關鍵字在裝置上組出簡介，不需要傳送內容給外部 AI；之後可在景點卡片中繼續編輯完整介紹與導航位置。</div>
    </div>`;

  const routeMaps = routeMapStore[activeDay] || [];
  const routeMapGalleryHTML = routeMaps.length ? `<div class="route-map-gallery">${routeMaps.map((u,i)=>`<div class="route-map-item"><img src="${u}" onclick="openAttachModal('${u}')" alt="Day ${d.dayNum} 路線圖"><button class="route-map-remove" onclick="removeRouteMap(${activeDay}, ${i})">✕</button></div>`).join('')}</div>` : '<div class="empty">尚未上傳今天的行動路線圖。</div>';
  const routeMapHTML = `
    <div class="section-card" style="margin-top:4px;">
      <h3 style="margin:0 0 10px;">🗺️ 我的當日行動路線圖</h3>
      ${routeMapGalleryHTML}
      <div class="edit-only"><button onclick="document.getElementById('routeMapFile-${activeDay}').click()" style="background:linear-gradient(135deg, var(--blue), #3B6A5A); color:#fff; border:none; padding:11px 16px; border-radius:999px; font-family:inherit; font-size:13px; font-weight:700; cursor:pointer;">📷 上傳路線圖</button>
      <input type="file" accept="image/*" id="routeMapFile-${activeDay}" style="display:none" multiple onchange="handleRouteMapUpload(event, ${activeDay})">
      <div style="font-size:11px; color:var(--ink-soft); margin-top:8px; line-height:1.5;">可上傳自己規劃或手繪的當日路線圖／導航截圖，並同步給家人。</div></div>
    </div>`;
  const transportHTML=transportPlanHTML(activeDay);

  dayContent.innerHTML = `${todayRemindHTML()}
    <div class="day-card-head ng-dayhead">
      <img class="dh-art" src="${SCENE['d'+activeDay]||''}" alt="" decoding="async" onclick="openAttachModal(this.getAttribute('src'))">
      <div class="day-eyebrow"><span>DAY ${String(d.dayNum).padStart(2,'0')} · ${String(d.date).split('/').map(x=>x.padStart(2,'0')).join('.')}（${d.weekday}）</span><i></i></div>
      <div class="region">${d.title}</div>
      ${d.gas ? `<div class="gas-info">${d.gas}</div>` : ''}
      ${d.dayDesc ? `<h2>${d.dayDesc}</h2>` : ''}
      <div class="weather-strip"><div class="ico${DAY_ICON_IMG[activeDay]!==undefined?' img-ico':''}">${dayIconHTML(activeDay,d.weatherIco)}</div><div class="txt"><b style="font-family:'Zen Kaku Gothic New', sans-serif; font-size:14px;">${d.enRegion}</b><br><span style="font-size:11.5px; opacity:0.85;">${d.wear}</span></div></div>
      ${stayQuickHTML}
      <div id="daySnowSlot">${daySnowBannerHTML(activeDay)}</div>
    </div>
    <div id="day-card-${activeDay}">
      <div class="subtab-content${['weather','transport','routemap','eat'].includes(curSubTab)?'':' active'}" data-type="spots">
        <div class="spots-seg" role="tablist"><button type="button" role="tab" data-view="main" class="${curSubTab==='more'?'':'on'}" onclick="setSpotsView(${activeDay},'main')">今日亮點<em>${mainList.length}</em></button><button type="button" role="tab" data-view="life" class="${curSubTab==='more'?'on':''}" onclick="setSpotsView(${activeDay},'life')">食衣住<em>${lifeList.length}</em></button></div>
        <div class="spots-pane${curSubTab==='more'?'':' active'}" data-view="main">${mainSpotsHTML}<button onclick="setSpotsView(${activeDay},'life'); setTimeout(()=>document.getElementById('newSpotName-${activeDay}')?.focus(),200)" class="restore-default-btn">＋ 新增景點／食衣住項目</button></div>
        <div class="spots-pane${curSubTab==='more'?' active':''}" data-view="life">${secondaryCardsHTML}${addSpotFormHTML}</div>
      </div>
      <div class="subtab-content${curSubTab==='weather'?' active':''}" data-type="weather">${curSubTab==='weather'?dayWeatherPanelHTML(activeDay):''}</div>
      <div class="subtab-content${curSubTab==='transport'?' active':''}" data-type="transport">${transportHTML}</div>
      <div class="subtab-content${curSubTab==='routemap'?' active':''}" data-type="routemap" style="background:#F6F4F0; border-radius:var(--r-lg); padding:12px; margin-bottom:16px;">${routeMapHTML}</div>
      <div class="subtab-content${curSubTab==='eat'?' active':''}" data-type="eat">${curSubTab==='eat'?dayEatPanelHTML(activeDay):''}</div>
    </div>
  `;
  if(typeof dayReviewHTML==='function')dayContent.insertAdjacentHTML('beforeend',dayReviewHTML(activeDay));
  dayContent.insertAdjacentHTML('beforeend',`<div class="end-mama">${mamaBtnHTML('day'+activeDay,'wide')}<small>放不進任何景點的資訊，都可以記在這裡</small></div>`);
  {
    const _ei=Math.floor(Math.random()*CRITTER_IMGS.length);
    dayContent.insertAdjacentHTML('beforeend','<div class="end-note"><img class="bob" src="'+CRITTER_IMGS[_ei]+'" alt="" loading="lazy"><span>'+escHtml(END_NOTE_QUOTES[_ei%END_NOTE_QUOTES.length])+'</span></div>');
  }
  restoreOpenSpotCards();
  /* 背景同步重繪時維持目前閱讀位置，避免畫面突然跳到其他地方。 */
  if(Math.abs(window.scrollY-previousScrollY)>2){
    requestAnimationFrame(()=>window.scrollTo({top:previousScrollY, behavior:'auto'}));
  }
}

/* ============ RENDER: ENHANCED LIVE WEATHER & OUTFIT ============ */
const CITIES = {
  'Takasaki': {lat:36.3219, lon:139.0033, label:'高崎／藤岡'},
  'Kurohime': {lat:36.8060, lon:138.2070, label:'黑姬／妙高', plan:'loma'},
  'Yamada': {lat:36.6690, lon:138.3920, label:'山田溫泉', plan:'fujiiso'},
  'Nagano': {lat:36.6431, lon:138.1886, label:'長野／小布施'},
  'Togakushi': {lat:36.7456, lon:138.0839, label:'戶隱'},
  'Yokohama': {lat:35.4658, lon:139.6223, label:'橫濱／羽田'},
};
/* 只顯示目前版本會去的地點（Lomä 版不顯示山田溫泉，藤井莊版不顯示黑姬） */
function cityKeys(){return Object.keys(CITIES).filter(k=>!CITIES[k].plan||CITIES[k].plan===PLAN);}
const WMO = {
  0:['☀️','晴朗'],1:['🌤️','大致晴朗'],2:['⛅','局部多雲'],3:['☁️','多雲'],
  45:['🌫️','有霧'],48:['🌫️','霧淞'],
  51:['🌦️','毛毛雨'],53:['🌦️','毛毛雨'],55:['🌦️','強毛毛雨'],
  61:['🌧️','小雨'],63:['🌧️','中雨'],65:['🌧️','大雨'],
  71:['🌨️','小雪'],73:['🌨️','中雪'],75:['❄️','大雪'],
  80:['🌦️','陣雨'],81:['🌧️','強陣雨'],82:['⛈️','劇烈陣雨'],
  95:['⛈️','雷雨'],96:['⛈️','雷雨挾冰雹'],99:['⛈️','強雷雨挾冰雹'],
};
function wmoInfo(code){ return WMO[code] || ['🌡️','—']; }
/* 小羚羊天氣圖（依天氣代碼切換：晴、多雲／陰、雨） */
const WX_IMG={sunny:['sunny','晴天'],partly:['partly-cloudy','晴時多雲'],cloudy:['cloudy','陰天'],fog:['fog','起霧'],drizzle:['drizzle','小雨'],rain:['rain','下雨'],snow:['snow','下雪'],thunder:['thunderstorm','雷雨'],wind:['wind','有風']};
function wxKind(code,wind){
  code=Number(code);wind=Number(wind)||0;
  if(code>=95)return 'thunder';
  if([71,73,75,77,85,86].includes(code))return 'snow';
  if([61,63,65,66,67,80,81,82].includes(code))return 'rain';
  if(code>=51&&code<=57)return 'drizzle';
  if(code===45||code===48)return 'fog';
  if(wind>=30)return 'wind';
  if(code===3)return 'cloudy';
  if(code===2)return 'partly';
  return 'sunny';
}
function wxImgHTML(code,wind,cls='wx-img'){const [f,l]=WX_IMG[wxKind(code,wind)];return `<img class="${cls}" src="images/weather/weather-${f}.webp" alt="${l}" title="${l}" width="64" height="64" loading="lazy" decoding="async">`;}
/* 早晚偏冷是溫度提醒，不取代晴雨圖：最低溫 8°C 以下時，在穿搭旁加一張 */
function chillyHTML(min){return min!=null&&min<=8?`<img class="wx-chilly" src="images/weather/weather-chilly.webp" alt="早晚偏冷" title="早晚偏冷" width="56" height="56" loading="lazy">`:'';}
function feelsText(cw){return cw&&cw.apparent_temperature!=null?`體感 ${Math.round(cw.apparent_temperature)}°`:'';}

function getDynamicTip(temp, code) {
  let tip = "";
  if(temp < 10) tip += "🌡️ 氣溫較低，建議穿著保暖防風衣物。";
  else if(temp > 20) tip += "🌡️ 氣溫舒適，可洋蔥式穿搭。";
  else tip += "🌡️ 氣溫涼爽，建議攜帶薄外套。";
  
  if([51,53,55,61,63,65,80,81,82,95,96,99].includes(code)) tip += " ☔ 有降雨機率，請務必攜帶雨具！";
  if([0,1,2].includes(code)) tip += " 🕶️ 紫外線較強，請注意防曬與配戴墨鏡。";
  if([71,73,75].includes(code)) tip += " ❄️ 降雪機率高，請注意保暖與行車安全！";
  return tip;
}

function getUVStars(uv) {
  if(!uv) return '未知';
  if(uv <= 2) return '★☆☆☆☆ (低)';
  if(uv <= 5) return '★★☆☆☆ (中)';
  if(uv <= 7) return '★★★☆☆ (高)';
  if(uv <= 10) return '★★★★☆ (甚高)';
  return '★★★★★ (極高)';
}

let liveWeatherCache = {};

/* ---- 天氣離線快取 (localStorage) ---- */
const WEATHER_CACHE_KEY = 'nagano_weather_cache_v1';
function loadWeatherCache(){
  try{ return JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY)) || {}; }catch(e){ return {}; }
}
function saveWeatherCacheEntry(k, entry){
  try{
    const cache = loadWeatherCache();
    cache[k] = entry;
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(cache));
  }catch(e){ /* storage full or unavailable, ignore */ }
}

async function fetchWeatherFor(k, attempt){
  const {lat, lon} = CITIES[k];
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 9000);
  try{
    if(!navigator.onLine) throw new Error('OFFLINE');
    const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,snowfall,weather_code&daily=sunrise,sunset,uv_index_max,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo`;
    /* 優先使用日本氣象廳（JMA）模式的數值；若該模式暫時無資料，自動退回一般預報，避免整個天氣頁空白。 */
    let res = await fetch(base + '&models=jma_seamless', { signal: controller.signal }).catch(()=>null);
    let data = (res && res.ok) ? await res.json().catch(()=>null) : null;
    if(!data || !data.current || data.current.temperature_2m == null){
      res = await fetch(base, { signal: controller.signal });
      if(!res.ok) throw new Error('HTTP '+res.status);
      data = await res.json();
    }
    clearTimeout(timeout);
    liveWeatherCache[k] = { data, error:null, stale:false, fetchedAt: Date.now() };
    saveWeatherCacheEntry(k, liveWeatherCache[k]);
  }catch(err){
    clearTimeout(timeout);
    if(!attempt && navigator.onLine){
      await new Promise(r=>setTimeout(r, 1200));
      return fetchWeatherFor(k, 1);
    }
    const cached = loadWeatherCache()[k];
    if(cached && cached.data){
      liveWeatherCache[k] = { data: cached.data, error:null, stale:true, fetchedAt: cached.fetchedAt };
    } else {
      liveWeatherCache[k] = { data:null, error: (err && err.name === 'AbortError') ? '連線逾時' : (err && err.message === 'OFFLINE' ? '目前離線' : '連線失敗') };
    }
  }
  renderOneLiveCity(k);
}

function renderWeatherFromCache(){
  const wrap = document.getElementById('liveWeatherList');
  if(!wrap) return;
  const cache = loadWeatherCache();
  const hasAny = cityKeys().some(k=>cache[k] && cache[k].data);
  wrap.innerHTML = cityKeys().map(k=>`<div class="weather-day" id="live-${k}"><div class="date" style="width:auto; text-align:left;"><b style="font-size:12.5px;">${CITIES[k].label}</b></div><div class="mid"><div class="out">讀取中...</div></div></div>`).join('');
  cityKeys().forEach(k=>{
    if(cache[k] && cache[k].data){
      liveWeatherCache[k] = { data: cache[k].data, error:null, stale:true, fetchedAt: cache[k].fetchedAt };
      renderOneLiveCity(k);
    }
  });
  const timeEl = document.getElementById('liveWeatherTime');
  if(timeEl && hasAny){
    const times = cityKeys().map(k=>cache[k] && cache[k].fetchedAt).filter(Boolean);
    const latest = times.length ? new Date(Math.max(...times)).toLocaleString('zh-TW', {hour12:false}) : '—';
    timeEl.textContent = navigator.onLine
      ? `顯示上次快取資料（更新於 ${latest}），正在取得最新資訊...`
      : `⚠️ 目前離線，顯示上次快取資料（更新於 ${latest}）`;
  }
  return hasAny;
}

async function loadLiveWeather(){
  const wrap = document.getElementById('liveWeatherList');
  if(!wrap) return;
  const timeEl = document.getElementById('liveWeatherTime');

  if(!navigator.onLine){
    const hasAny = renderWeatherFromCache();
    if(!hasAny && timeEl) timeEl.textContent = '⚠️ 目前離線，且尚無快取資料可顯示，請連上網路後再試一次。';
    return;
  }

  wrap.innerHTML = cityKeys().map(k=>`<div class="weather-day" id="live-${k}"><div class="date" style="width:auto; text-align:left;"><b style="font-size:12.5px;">${CITIES[k].label}</b></div><div class="mid"><div class="out">讀取中...</div></div></div>`).join('');
  if(timeEl) timeEl.textContent = '即時資料抓取中...';

  await Promise.all([...cityKeys().map(k=>fetchWeatherFor(k, 0)),fetchSpotsWeather(true),prefetchSnow(true)]);

  const failCount = Object.values(liveWeatherCache).filter(v=>v && v.error).length;
  const staleCount = Object.values(liveWeatherCache).filter(v=>v && v.stale).length;
  if(timeEl){
    if(staleCount && staleCount === cityKeys().length){
      const times = Object.values(liveWeatherCache).map(v=>v.fetchedAt).filter(Boolean);
      timeEl.textContent = `⚠️ 目前離線，顯示快取資料（更新於 ${times.length?new Date(Math.max(...times)).toLocaleString('zh-TW',{hour12:false}):'—'}）`;
    } else if(failCount){
      timeEl.textContent = `即時資料更新於：${new Date().toLocaleString('zh-TW', {hour12:false})}（${failCount} 個地點連線失敗，可點擊下方「重新整理」再試一次）`;
    } else {
      timeEl.textContent = '即時資料更新於：' + new Date().toLocaleString('zh-TW', {hour12:false});
    }
  }
}

function renderOneLiveCity(k){
  const el = document.getElementById('live-'+k);
  if(!el) return;
  const entry = liveWeatherCache[k];
  const data = entry && entry.data;
  if(!data || !data.current){
    const reason = (entry && entry.error) ? entry.error : '暫時無法取得氣象資料';
    el.innerHTML = `<div class="weather-error"><span>${CITIES[k].label}：${reason}</span><button onclick="fetchWeatherFor('${k}', 0)">🔄 重試</button></div>`;
    return;
  }

  const cw = data.current;
  const [ico, desc] = wmoInfo(cw.weather_code);
  const temp = Math.round(cw.temperature_2m);
  const wind = cw.wind_speed_10m;
  const precip = cw.precipitation;
  const sr = data.daily && data.daily.sunrise ? data.daily.sunrise[0].substring(11, 16) : '--:--';
  const ss = data.daily && data.daily.sunset ? data.daily.sunset[0].substring(11, 16) : '--:--';
  const uvRaw = data.daily && data.daily.uv_index_max && data.daily.uv_index_max[0] != null ? Number(data.daily.uv_index_max[0]) : null;
  const uvText = uvRaw==null ? '未知' : uvRaw < 3 ? '低' : uvRaw < 6 ? '中' : uvRaw < 8 ? '高' : '很高';
  const tip = getDynamicTip(temp, cw.weather_code);
  const badgeHtml = entry.stale
    ? `<span class="live-badge stale"><span class="dot"></span>快取${entry.fetchedAt ? '・' + new Date(entry.fetchedAt).toLocaleString('zh-TW',{hour12:false, month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : ''}</span>`
    : `<span class="live-badge"><span class="dot"></span>即時</span>`;

  const MW_TIMES = { Takasaki:'關東平野早晚溫差大，白天可能到 20°C 以上，早晚只有 10°C 左右。', Kurohime:'黑姬與妙高海拔較高，早晚可能只有個位數，池邊步道潮濕。', Yamada:'溪谷旅館比長野市區涼，泡完湯外出記得加外套。', Nagano:'長野盆地白天舒服、早晚涼；小布施街區日照強，記得防曬。', Togakushi:'戶隱海拔約 1,200 公尺，比長野市區冷很多，參道可能殘雪與泥濘。', Yokohama:'港邊風大，黃昏散步帶一件防風外套。' };

  const isOpen=(window._weatherOpen||(window._weatherOpen=new Set())).has(k);
  el.innerHTML = `
    <details class="weather-city-card wc-details" ${isOpen?'open':''} ontoggle="weatherToggle('${k}',this.open)">
      <summary class="weather-primary wc-sum">
        <div class="wc-name"><strong>${CITIES[k].label}</strong>${badgeHtml}</div>
        <span class="wc-ico">${wxImgHTML(cw.weather_code,cw.wind_speed_10m)}</span>
        <div class="wc-temp"><b>${temp}<small>°C</small></b><em>${feelsText(cw)||desc}</em></div>
        <i class="wc-chev" aria-hidden="true">▾</i>
      </summary>
      <div class="wc-body">
        <div class="weather-metrics" aria-label="氣象數據">
          <span>${desc}</span>
          ${cw.apparent_temperature!=null?`<span>體感 ${Math.round(cw.apparent_temperature)}°C</span>`:''}
          ${data.daily&&data.daily.temperature_2m_min?`<span>今日 ${Math.round(data.daily.temperature_2m_min[0])}～${Math.round(data.daily.temperature_2m_max[0])}°C</span>`:''}
          <span>風 ${wind} km/h${cw.wind_gusts_10m!=null?`（陣風 ${Math.round(cw.wind_gusts_10m)}）`:''}</span>
          ${cw.snowfall?`<span>降雪 ${cw.snowfall} cm/h</span>`:`<span>降水 ${precip} mm</span>`}
          ${cw.relative_humidity_2m!=null?`<span>濕度 ${cw.relative_humidity_2m}%</span>`:''}
          <span>UV ${uvText}</span>
        </div>
        <div class="wc-spots" id="spots-${k}">${spotsWeatherHTML(k)}</div>
        <div class="weather-sun-row">
          <span>日出 ${sr}</span>
          <span>日落 ${ss}</span>
        </div>
        <div class="weather-tenki-row"><a href="${TENKI_LINKS[k]||'https://tenki.jp/'}" target="_blank" rel="noopener">開啟 tenki.jp ${CITIES[k].label}預報（逐時・10 天）</a></div>
        <div class="weather-travel-note"><b>當地提醒</b><span>${MW_TIMES[k]}</span></div>
        <div class="weather-wear-note">${chillyHTML(data.daily&&data.daily.temperature_2m_min?Math.round(data.daily.temperature_2m_min[0]):null)}<b>穿搭</b><span>${tip}${data.daily&&data.daily.temperature_2m_min&&data.daily.temperature_2m_min[0]<=8?' 🧥 早晚偏冷，多帶一件外套。':''}</span></div>
      </div>
    </details>
  `;
}


/* ============ 北海道版的「今日雪況＋降雪提醒」：長野春旅不需要，保留同名空函式讓其他程式照常呼叫 ============ */
async function prefetchSnow(){return false;}
function daySnowy(){return false;}
function daySnowBannerHTML(){return '';}
function renderSnowPanel(){}
function snowLineHTML(){return '';}

/* ============ hk12：即時氣象分得更細（各城市底下的景點：氣溫、體感、風、天氣） ============ */
const LIVE_SPOTS={
  Takasaki:[['高崎站',36.3228,139.0127],['少林山達磨寺',36.3290,138.9630],['藤岡 ふじの咲く丘',36.2440,139.0560]],
  Kurohime:[['野尻湖',36.8270,138.2240],['いもり池',36.8870,138.1700]],
  Yamada:[['山田溫泉',36.6690,138.3920],['松川溪谷',36.6640,138.4150]],
  Nagano:[['長野站・善光寺',36.6610,138.1880],['小布施',36.6975,138.3140]],
  Togakushi:[['戶隱神社 中社',36.7456,138.0839],['戶隱神社 奧社',36.7680,138.0720]],
  Yokohama:[['橫濱站',35.4658,139.6223],['港未來',35.4560,139.6320],['橫濱 Bayside',35.3870,139.6370]]
};
const SPOTS_WX_KEY='nagano_spots_wx_v1';
var spotsWx=(()=>{try{return JSON.parse(localStorage.getItem(SPOTS_WX_KEY))||{};}catch(e){return {};}})();
async function fetchSpotsWeather(force){
  if(!navigator.onLine)return false;
  if(!force&&spotsWx.at&&Date.now()-spotsWx.at<15*60*1000)return false;
  const list=Object.entries(LIVE_SPOTS).filter(([k])=>cityKeys().includes(k)).flatMap(([k,arr])=>arr.map(a=>({k,name:a[0],lat:a[1],lon:a[2]})));
  try{
    const u=`https://api.open-meteo.com/v1/forecast?latitude=${list.map(x=>x.lat).join(',')}&longitude=${list.map(x=>x.lon).join(',')}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,snowfall&timezone=Asia%2FTokyo`;
    const r=await fetch(u);if(!r.ok)return false;
    let d=await r.json();if(!Array.isArray(d))d=[d];
    const out={at:Date.now(),items:{}};
    list.forEach((x,i)=>{const c=d[i]&&d[i].current;if(c)out.items[x.name]={t:c.temperature_2m,f:c.apparent_temperature,w:c.wind_speed_10m,code:c.weather_code,sn:c.snowfall,el:d[i].elevation};});
    spotsWx=out;try{localStorage.setItem(SPOTS_WX_KEY,JSON.stringify(out));}catch(e){}
    Object.keys(LIVE_SPOTS).forEach(k=>{const el=document.getElementById('spots-'+k);if(el)el.innerHTML=spotsWeatherHTML(k);});
    return true;
  }catch(e){return false;}
}
function spotsWeatherHTML(k){
  const arr=LIVE_SPOTS[k]||[];if(!arr.length)return '';
  const rows=arr.map(([name])=>{
    const x=(spotsWx.items||{})[name];
    if(!x)return `<div class="wsp"><span class="wsp-name">${escHtml(name)}</span><span class="wsp-na">讀取中…</span></div>`;
    return `<div class="wsp">${wxImgHTML(x.code,x.w,'wx-img sm')}<span class="wsp-name">${escHtml(name)}${x.el>300?`<small>海拔約 ${Math.round(x.el)} m</small>`:''}</span><span class="wsp-t"><b>${Math.round(x.t)}°</b><em>體感 ${Math.round(x.f)}°</em></span><span class="wsp-w">💨 ${Math.round(x.w)}${x.sn?`<br>❄ ${x.sn}cm`:''}</span></div>`;
  }).join('');
  return `<div class="wsp-head">各景點即時</div>${rows}`;
}
setTimeout(()=>fetchSpotsWeather(false),3000);

/* ============ 內嵌 Windy 天氣圖 ============ */
function initRainRadar(){ refreshRainRadar(); }
function refreshRainRadar(){
  const el = document.getElementById('rainRadarMap');
  const timeEl = document.getElementById('rainRadarTime');
  if(!el) return;
  if(!navigator.onLine){
    el.innerHTML='<div class="satellite-offline">☁️ 目前離線，無法載入 Windy 即時圖。恢復網路後按「重新整理」。</div>';
    if(timeEl) timeEl.textContent='Windy 即時圖需要網路連線。';
    return;
  }
  const src='https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=km%2Fh&zoom=5&overlay=satellite&product=satellite&level=surface&lat=36.3&lon=138.8';
  el.innerHTML=`<iframe class="windy-satellite-frame" src="${src}" title="長野・關東 Windy 即時圖" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  if(timeEl) timeEl.textContent='Windy 即時天氣圖';
  simplifyMetServiceButton();
}
function simplifyMetServiceButton(){
  document.querySelectorAll('a,button').forEach(el=>{
    const t=(el.textContent||'').trim();
    if(/MetService/i.test(t)) el.textContent='🔗 查看 MetService';
  });
}

/* ============ GUIDE LISTS ============ */
/* 這四份清單（打包／購物／規範／票券）過去只存在記憶體中，
   重新整理頁面就會整個消失、勾選與照片也不會保留。
   現在改為讀取與寫入 LocalStorage，行為和景點筆記／照片一致。 */
const PACK_SUBCATS = {
  '🎒 隨身背包':['證件與金錢','電子用品','健康與隨身用品','機上用品','其他'],
  '👜 手提行李':['攝影器材','電子用品','衣物備用','易碎／貴重物品','其他'],
  '🧳 託運行李':['外套與保暖層','上衣與褲裝','鞋襪與配件','盥洗與保養','藥品與備品','其他']
};
function jsQuote(v){ return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

const defaultPackData = {
  '🎒 隨身背包':[{name:'護照＋機票／訂房憑證',qty:1,checked:false},{name:'Suica 交通卡（手機或實體）',qty:1,checked:false},{name:'駕照＋國際駕照（日文譯本）',qty:1,checked:false},{name:'行動電源＋充電線',qty:2,checked:false},{name:'常備藥品',qty:1,checked:false},{name:'折疊傘',qty:1,checked:false},{name:'防曬乳＋帽子',qty:1,checked:false}],
  '👜 手提行李':[{name:'相機＋備用電池',qty:1,checked:false},{name:'機上薄外套',qty:1,checked:false},{name:'貴重物品',qty:1,checked:false}],
  '🧳 託運行李':[{name:'防風薄外套（山區早晚與港邊）',qty:1,checked:false},{name:'薄毛衣或刷毛中層',qty:2,checked:false},{name:'長袖上衣',qty:4,checked:false},{name:'好走的防滑鞋（戶隱參道可能泥濘）',qty:1,checked:false},{name:'襪子',qty:5,checked:false},{name:'溫泉用小毛巾與保養品',qty:1,checked:false},{name:'購物用摺疊袋',qty:1,checked:false}]
};
function migratePackCategoryNames(data){
  // 相容舊資料：把舊版類別名稱「🧳 托運行李（衣物防寒）」自動搬到新的簡化名稱「🧳 託運行李」
  if (data && data['🧳 托運行李（衣物防寒）']) {
    if (!data['🧳 託運行李']) data['🧳 託運行李'] = data['🧳 托運行李（衣物防寒）'];
    delete data['🧳 托運行李（衣物防寒）'];
  }
  if(!data) data = structuredClone(defaultPackData);
  Object.keys(data).forEach(cat=>{
    const fallback=(packSubcatsFor(cat))[0];
    data[cat]=(data[cat]||[]).map(it=>({...it, subcat:it.subcat || fallback}));
  });
  return data;
}
let packData = migratePackCategoryNames(JSON.parse(localStorage.getItem('nagano_pack')) || structuredClone(defaultPackData));
window._packLive = packData;
function persistPack(){ safeSetItem('nagano_pack', packData); }

const defaultShopData = [{name:'小布施 栗子甜點（栗菓子）',qty:1,checked:false,img:null,cat:'souvenir',location:'小布施'},{name:'高崎達摩不倒翁',qty:1,checked:false,img:null,cat:'souvenir',location:'高崎・少林山達磨寺'},{name:'戶隱蕎麥（乾麵）',qty:1,checked:false,img:null,cat:'souvenir',location:'戶隱'},{name:'七味唐辛子（八幡屋礒五郎）',qty:1,checked:false,img:null,cat:'souvenir',location:'長野・善光寺'},{name:'信州蘋果點心',qty:1,checked:false,img:null,cat:'snack',location:'長野站'},{name:'橫濱伴手禮',qty:1,checked:false,img:null,cat:'souvenir',location:'橫濱站'}];
let shopData = normalizeStructuredList('nagano_shop', JSON.parse(localStorage.getItem('nagano_shop')) || defaultShopData);
function persistShop(){ safeSetItem('nagano_shop', shopData); }
const SHOP_CATS = {supermarket:{label:'🛒 超市', color:'#406A5C'}, drugstore:{label:'💊 藥妝', color:'#569580'}, snack:{label:'🍬 零食飲料', color:'#589782'}, icecream:{label:'🍦 冰品', color:'#67A590'}, souvenir:{label:'🎁 紀念品', color:'#4D7A6B'}};

const listSectionOpen = { pack:{}, shop:{supermarket:false, souvenir:false} };
function toggleListSection(type, key){
  if(!listSectionOpen[type]) listSectionOpen[type] = {};
  listSectionOpen[type][key] = !listSectionOpen[type][key];
  if(type === 'pack') renderPackList(); else renderShopList();
}
function escAttr(v){ return String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function capturePackComposerState(){
  const composer=document.getElementById('packComposer');
  const input=document.getElementById('newPackItem');
  return {
    open:!!composer?.classList.contains('open'),
    value:input?.value||'',
    focused:document.activeElement===input,
    start:input?.selectionStart??null,
    end:input?.selectionEnd??null,
    cat:window._packSelectedCat,
    subcat:window._packSelectedSubcat
  };
}
function isPackComposerEditing(){
  const composer=document.getElementById('packComposer');
  const input=document.getElementById('newPackItem');
  return !!(composer?.classList.contains('open') && (document.activeElement===input || (input?.value||'').trim()));
}
function restorePackComposerState(state){
  if(!state)return;
  if(state.cat)window._packSelectedCat=state.cat;
  if(state.subcat)window._packSelectedSubcat=state.subcat;
  renderPackSubcatChips();
  const input=document.getElementById('newPackItem');
  const composer=document.getElementById('packComposer');
  if(composer)composer.classList.toggle('open',!!state.open);
  if(input){
    input.value=state.value||'';
    if(state.focused){
      requestAnimationFrame(()=>{
        input.focus({preventScroll:true});
        if(state.start!=null)try{input.setSelectionRange(state.start,state.end??state.start);}catch(e){}
      });
    }
  }
}
function renderPackList(){
  const wrap = document.getElementById('packListWrap');
  if(!wrap) return;
  window._packLive = packData;
  const composerState=capturePackComposerState();
  const groups = Object.keys(packData).map((cat,catIdx)=>{
    const isOpen = listSectionOpen.pack[cat] === true;
    const done = packData[cat].filter(it=>it.checked).length;
    const subcats = packSubcatsFor(cat);
    const subHTML = subcats.map(sub=>{
      const entries=packData[cat].map((it,i)=>({it,i})).filter(x=>effectivePackSubcat(cat,x.it,subcats)===sub);
      if(!entries.length) return '';
      return `<div class="pack-subgroup"><div class="pack-subgroup-title">${escHtml(sub)}</div>${entries.map(({it,i})=>`<div class="pack-item ${it.checked?'checked':''}"><input type="checkbox" ${it.checked?'checked':''} onchange="togglePack('${jsQuote(cat)}',${i})"><div class="name shop-item-title">${escHtml(it.name)}</div><div class="qty"><button onclick="changeQty('${jsQuote(cat)}',${i},-1)">－</button><span>${Number(it.qty)||1}</span><button onclick="changeQty('${jsQuote(cat)}',${i},1)">＋</button></div><button class="pack-edit-btn edit-only" onclick="editPackItem('${jsQuote(cat)}',${i})">✎</button><button class="del" onclick="delPack('${jsQuote(cat)}',${i})">✕</button></div>`).join('')}</div>`;
    }).join('');
    return `<section class="checklist-group pack-group pack-group-${catIdx}"><button class="checklist-group-head" onclick="toggleListSection('pack', '${jsQuote(cat)}')" aria-expanded="${isOpen}"><span>${cat}</span><small>${done}/${packData[cat].length}</small><b>${isOpen?'⌃':'⌄'}</b></button><div class="checklist-group-body ${isOpen?'open':''}">${subHTML || '<div class="empty compact">此分類目前沒有項目。</div>'}</div></section>`;
  }).join('');
  wrap.innerHTML = groups + `<button class="pack-add-trigger" onclick="togglePackComposer()">＋ 新增行李品項</button><div id="packComposer" class="pack-composer"><div class="composer-label">放在哪一類？</div><div class="pack-type-grid">${Object.keys(packData).map((c,i)=>`<button class="pack-type-btn ${i===0?'active':''}" onclick="choosePackCategory('${jsQuote(c)}',this)">${c}</button>`).join('')}</div><div class="composer-label">細分類</div><div id="packSubcatChips" class="pack-subcat-chips"></div><div class="pack-entry-row"><input type="text" id="newPackItem" placeholder="輸入品項，例如：充電線" onkeydown="if(event.key==='Enter') addPackItem()"><button onclick="addPackItem()">加入清單</button></div><button class="composer-cancel" onclick="togglePackComposer(false)">取消</button></div>`;
  window._packSelectedCat = window._packSelectedCat || Object.keys(packData)[0];
  window._packSelectedSubcat = window._packSelectedSubcat || (packSubcatsFor(window._packSelectedCat))[0];
  restorePackComposerState(composerState);
}
function togglePackComposer(force){ const el=document.getElementById('packComposer'); if(!el)return; const show=typeof force==='boolean'?force:!el.classList.contains('open'); el.classList.toggle('open',show); if(show){setTimeout(()=>document.getElementById('newPackItem')?.focus(),80);}else if(window._packRemoteRenderPending){window._packRemoteRenderPending=false;renderPackList();} }
function choosePackCategory(cat,btn){ window._packSelectedCat=cat; window._packSelectedSubcat=(packSubcatsFor(cat))[0]; document.querySelectorAll('.pack-type-btn').forEach(b=>b.classList.toggle('active',b===btn)); renderPackSubcatChips(); }
/* renderPackSubcatChips 已改寫，見 v47 區塊 */
function choosePackSubcat(sub){ window._packSelectedSubcat=sub; renderPackSubcatChips(); }
function syncPackSubcatOptions(){ renderPackSubcatChips(); }
function togglePack(cat,i){ packData[cat][i].checked = !packData[cat][i].checked; persistPack(); renderPackList(); }
function changeQty(cat,i,delta){ packData[cat][i].qty = Math.max(1, packData[cat][i].qty+delta); persistPack(); renderPackList(); }
function delPack(cat,i){ const removed=packData[cat].splice(i,1)[0]; persistPack(); renderPackList();offerUndo('已刪除行李品項',()=>{packData[cat].splice(i,0,removed);persistPack();renderPackList();}); }
function addPackItem(){ const cat=window._packSelectedCat||Object.keys(packData)[0]; const subcat=window._packSelectedSubcat||(packSubcatsFor(cat))[0]; const input=document.getElementById('newPackItem'); if(input&&input.value.trim()){ packData[cat].push({name:input.value.trim(),qty:1,checked:false,subcat,manual:true}); persistPack(); listSectionOpen.pack[cat]=true; window._packSelectedCat=cat; window._packSelectedSubcat=subcat; renderPackList(); setTimeout(()=>togglePackComposer(true),0); } }

function shopImgs(it){
  if(Array.isArray(it.imgs)) return it.imgs;
  return it.img ? [it.img] : [];
}
/* renderShopList 已改寫，見檔案最後 v47 區塊 */
async function handleShopPhoto(e,i){
  const files=Array.from(e.target.files||[]);
  e.target.value='';
  if(!files.length)return;
  try{
    if(!Array.isArray(shopData[i].imgs))shopData[i].imgs=shopImgs(shopData[i]);
    shopData[i].img=null;
    updateSyncStatus(null,'saving');
    const urls=await Promise.all(files.map(f=>uploadMediaFile(f,'shopping')));
    shopData[i].imgs=mergeUniqueUrls(shopData[i].imgs,urls);
    persistShop();renderShopList();
  }catch(err){reportUploadError(err);updateSyncStatus(err);}
}
function removeShopImg(i, photoIdx){ const imgs = shopImgs(shopData[i]);const removed=imgs.splice(photoIdx,1)[0]; shopData[i].imgs = imgs; shopData[i].img = null; persistShop(); renderShopList();offerUndo('已刪除商品照片',()=>{shopImgs(shopData[i]).splice(photoIdx,0,removed);shopData[i].imgs=shopImgs(shopData[i]);persistShop();renderShopList();}); }
function toggleShop(i){ shopData[i].checked = !shopData[i].checked; persistShop(); renderShopList(); }
function changeShopQty(i,delta){ shopData[i].qty = Math.max(1, shopData[i].qty+delta); persistShop(); renderShopList(); }
function delShop(i){ const removed=shopData.splice(i,1)[0]; persistShop(); renderShopList();offerUndo('已刪除購物項目',()=>{shopData.splice(i,0,removed);persistShop();renderShopList();}); }
function addShopItem(){ const input = document.getElementById('newShopItem'); const cat = document.getElementById('newShopCat')?.value || 'supermarket'; if(input && input.value.trim()){ shopData.push({id:'shop-'+crypto.randomUUID(),name:input.value.trim(), qty:1, checked:false, imgs:[], cat, location:''}); persistShop(); listSectionOpen.shop[cat] = true; renderShopList(); } }
function setShopCat(i, val){ shopData[i].cat = val; persistShop(); renderShopList(); }
function setShopLocation(i, val){ shopData[i].location = val; persistShop(); }

/* ============ CUSTOM TRAVEL RULES ============ */
const defaultRulesData = [
  {title:'🎌 黃金週人潮',text:'4/29 昭和之日、5/1–5/3 黃金週連假，住宿、餐廳、停車場與 Outlet 都可能排隊；熱門店盡量提早或錯開用餐時間。',img:null},
  {title:'🚗 山區自駕',text:'出發前查戶隱、妙高或高山村道路狀況，向租車店確認適合的輪胎；雨雪時取消高處步道，不以跨山捷徑節省時間，駕車以白天移動為主。',img:null},
  {title:'🌸 花況每年不同',text:'藤岡紫藤與小布施八重櫻都依當年氣溫調整；落花或未開就刪掉，不另外補遠距景點。',img:null},
  {title:'🧳 行李',text:'每天依入住時間寄放，連住以同房為優先。高崎至長野可自行帶上新幹線；租車前比對人數、行李件數與後車廂。',img:null}
];
let rulesData = normalizeStructuredList('nagano_rules', JSON.parse(localStorage.getItem('nagano_rules')) || defaultRulesData);
function persistRules(){ safeSetItem('nagano_rules', rulesData); }

function renderRulesList() {
  const wrap = document.getElementById('rulesListWrap');
  if(!wrap) return;
  wrap.innerHTML = rulesData.map((r, i) => {
    // 相容舊資料：舊格式把標題用 <b>...</b> 包在 text 開頭，這裡拆出來當標題
    let title = r.title, body = r.text;
    if(!title && body){
      const m = body.match(/^<b>(.*?)<\/b>\s*[：:]?\s*/);
      if(m){ title = m[1]; body = body.slice(m[0].length); }
    }
    return `
    <div class="rule-item" style="align-items:flex-start; background:#FCFAF6; padding:10px; border-radius:8px; border:1px solid #F5F1E7;">
      <span class="dot" style="margin-top:2px;">●</span>
      <div style="flex:1;">
        ${title ? `<div style="font-weight:900; font-size:13.5px; color:var(--ink); margin-bottom:3px;">${escHtml(title)}</div>` : ''}
        <div style="font-size:12.5px; color:var(--ink-soft); line-height:1.6;">${escHtml(body)}</div>
        ${ruleImgsHTML(r,i)}
      </div>
      <button class="del" onclick="delRule(${i})" style="margin-top:2px;">✕</button>
    </div>
  `;
  }).join('') + `
    <div class="add-row rule-add-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <input type="text" id="newRuleTitle" placeholder="標題（例如：行李限重）...">
      <div style="display:flex; gap:8px;">
        <input type="text" id="newRuleItem" placeholder="內文說明...">
        <button onclick="addRuleItem()">＋</button>
      </div>
    </div>
  `;
}
/* hk11：每則規範可以放多張附圖 */
function ruleImgs(r){return mergeUniqueUrls(r&&r.imgs,r&&r.img?[r.img]:[]);}
function ruleImgsHTML(r,i){
  const imgs=ruleImgs(r);
  const th=imgs.map((u,k)=>`<div class="rule-ph"><img src="${escAttr(u)}" data-src="${escAttr(u)}" alt="規範附圖 ${k+1}" loading="lazy" onclick="openAttachModal(this.dataset.src)"><button type="button" class="edit-only" aria-label="移除這張附圖" onclick="removeRuleImg(${i},${k})">✕</button></div>`).join('');
  return `<div class="rule-phs${imgs.length?'':' no-img'}">${th}<label class="rule-ph-add edit-only">📷 ${imgs.length?'再加附圖':'新增附圖'}<input type="file" accept="image/*" multiple hidden onchange="handleRulePhoto(event, ${i})"></label></div>`;
}
async function handleRulePhoto(e,i){
  const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;
  const id=rulesData[i]&&rulesData[i].id;const urls=[];
  updateSyncStatus(null,'saving');
  for(const f of files){try{urls.push(await uploadMediaFile(f,'rules'));}catch(err){reportUploadError(err);updateSyncStatus(err);break;}}
  if(!urls.length)return;
  const r=rulesData.find(x=>x.id===id)||rulesData[i];if(!r)return;
  r.imgs=[...ruleImgs(r),...urls];r.img=null;persistRules();renderRulesList();
}
function removeRuleImg(i,k){
  const r=rulesData[i];if(!r)return;
  if(!confirm('移除這張附圖？（5 秒內可復原）'))return;
  const imgs=ruleImgs(r);const removed=imgs.splice(k,1)[0];r.imgs=imgs;r.img=null;persistRules();renderRulesList();
  offerUndo('已移除規範附圖',()=>{const t=rulesData.find(x=>x.id===r.id);if(!t)return;const a=ruleImgs(t);a.splice(Math.min(k,a.length),0,removed);t.imgs=a;t.img=null;persistRules();renderRulesList();});
}
function delRule(i) { const removed=rulesData.splice(i, 1)[0]; persistRules(); renderRulesList();offerUndo('已刪除旅遊規範',()=>{rulesData.splice(i,0,removed);persistRules();renderRulesList();}); }
function addRuleItem() {
  const titleInput = document.getElementById('newRuleTitle');
  const input = document.getElementById('newRuleItem');
  if(input && input.value.trim()){
    rulesData.push({ id:'rule-'+crypto.randomUUID(), title: titleInput ? titleInput.value.trim() : '', text: input.value.trim(), img: null, imgs: [] });
    persistRules(); renderRulesList();
  }
}

/* ============ DYNAMIC DOCS/VOUCHERS ============ */
const defaultDocsData = [
  {ic:'✈️',t:'去程 台灣 → 成田（航班待訂）',s:'4/24',chip:'航班',link:'',img:null,confirmed:false},
  {ic:'🏨',t:'高崎站周邊飯店',s:'4/24–4/26・3 晚',chip:'住宿',link:'',img:null,confirmed:false},
  {ic:'🚗',t:'租車 1：高崎取還（1 天）',s:'4/26',chip:'租車',link:'',img:null,confirmed:false},
  {ic:'🚄',t:'北陸新幹線 高崎 → 長野',s:'4/27',chip:'車票',link:'',img:null,confirmed:false},
  {ic:'🚗',t:'租車 2：長野取還（4 天）',s:'4/27–4/30',chip:'租車',link:'',img:null,confirmed:false},
  {ic:'🏨',t:'Lomä（Lomä 版）／藤井莊（藤井莊版）',s:'4/27–4/28・2 晚',chip:'住宿',link:'',img:null,confirmed:false},
  {ic:'🏨',t:'長野站周邊飯店',s:'4/29–4/30・2 晚',chip:'住宿',link:'',img:null,confirmed:false},
  {ic:'🚄',t:'北陸新幹線 長野 → 東京',s:'5/1',chip:'車票',link:'',img:null,confirmed:false},
  {ic:'🏨',t:'橫濱站周邊飯店',s:'5/1–5/2・2 晚',chip:'住宿',link:'',img:null,confirmed:false},
  {ic:'✈️',t:'回程 羽田 → 台灣（航班待訂）',s:'5/3',chip:'航班',link:'',img:null,confirmed:false}
];
function mergeDocsWithDefaults(value){
  const existing=normalizeStructuredList('nagano_docs', Array.isArray(value)?value:[]);
  const map=new Map(existing.map(d=>[String(d.t||'').trim(),d]));
  defaultDocsData.forEach(def=>{
    const key=String(def.t||'').trim();
    map.set(key,map.has(key)?{...def,...map.get(key)}:{...def});
  });
  return [...map.values()];
}
let docsData = mergeDocsWithDefaults(JSON.parse(localStorage.getItem('nagano_docs')||'null'));
/* 把舊版缺少的住宿卡補回本機／雲端。 */
setTimeout(()=>persistDocs(),0);
function persistDocs(){ safeSetItem('nagano_docs', docsData); }

const DOC_ICON_MAP={'🏨':'lodging','🚗':'route','🚙':'route','🚕':'route','🍽️':'food','🛍️':'shopping'};
function docIconHTML(ic){const k=DOC_ICON_MAP[ic]||'itinerary';return `<img class="doc-ic" src="${NAV_IC[k]}" alt="" width="34" height="34">`;}
function renderDocsList() {
  const wrap = document.getElementById('docsListWrap');
  if(!wrap) return;
  wrap.innerHTML = docsData.map((d, i) => `
    <article class="voucher-card ${d.confirmed?'is-confirmed':''}">
      <div class="voucher-main" onclick="handleDocClick(${i})">
        <div class="voucher-icon">${docIconHTML(d.ic)}</div>
        <div class="voucher-copy">
          <div class="voucher-title">${escHtml(d.t)}</div>
          <div class="voucher-sub">${escHtml(d.s)}</div>
        </div>
      </div>
      <div class="voucher-actions">
        <button class="voucher-status" onclick="toggleDocConfirmed(${i})">${d.confirmed?'已確認':(d.chip||'待確認')}</button>
        ${d.img ? `<button class="voucher-upload has-file" onclick="openAttachModal('${d.img}')">📱 顯示截圖</button>
                   <button class="voucher-remove" onclick="removeDocImg(${i})">移除截圖</button>`
                : `<button class="voucher-upload" onclick="document.getElementById('docFile-${i}').click()">📎 上傳截圖</button>`}
        <input type="file" id="docFile-${i}" accept="image/*" style="display:none" onchange="handleDocPhoto(event, ${i})">
      </div>
    </article>
  `).join('');
}
function toggleDocConfirmed(i){ docsData[i].confirmed=!docsData[i].confirmed; persistDocs(); renderDocsList(); }
function handleDocClick(i) { const d = docsData[i]; if(d.img) openAttachModal(d.img); else if(d.link) window.open(d.link, '_blank'); }
async function handleDocPhoto(e,i){const f=e.target.files[0];e.target.value='';if(!f)return;try{docsData[i].img=await uploadMediaFile(f,'documents');persistDocs();renderDocsList();}catch(err){reportUploadError(err);updateSyncStatus(err);}}
function removeDocImg(i) { const removed=docsData[i].img;docsData[i].img = null; persistDocs(); renderDocsList();offerUndo('已移除憑證截圖',()=>{docsData[i].img=removed;persistDocs();renderDocsList();}); }


/* 舊版曾把圖片 Base64 放進 localStorage。首次載入新版時，逐張搬到 Supabase Storage，
   成功後只保留短網址，從根本解決 QuotaExceededError。 */
async function migrateLegacyMediaToCloud(){
  if(CLOUD_CONFIGURED&&!navigator.onLine) return false;
  const progress={done:0,total:0};
  const stores={
    nagano_photos:photoStore,
    nagano_covers:coverStore,
    nagano_route_maps:routeMapStore,
    nagano_transport_extras:transportExtrasStore,
    nagano_shop:shopData,
    nagano_rules:rulesData,
    nagano_docs:docsData
  };
  let changed=false;
  for(const [key,value] of Object.entries(stores)){
    const before=JSON.stringify(value);
    const migrated=await migrateMediaTree(value,`legacy/local/${key}`,progress);
    if(JSON.stringify(migrated)!==before) changed=true;
    if(key==='nagano_photos') photoStore=migrated;
    else if(key==='nagano_covers') coverStore=migrated;
    else if(key==='nagano_route_maps') routeMapStore=migrated;
    else if(key==='nagano_transport_extras') transportExtrasStore=migrated||{};
    else if(key==='nagano_shop') shopData=migrated;
    else if(key==='nagano_rules') rulesData=migrated;
    else if(key==='nagano_docs') docsData=migrated;
    replaceLocalJson(key,migrated);
  }
  if(changed){
    renderDayContent();renderShopList();renderRulesList();renderDocsList();
  }
  if(progress.failed&&typeof showToast==='function')showToast(`有 ${progress.failed} 張舊照片暫時無法搬到雲端（${friendlySyncError(progress.lastError)}），已先保留，不會刪除。`);
  return progress.done>0;
}

async function startFamilyCloud(){
  if(!CLOUD_CONFIGURED)return;
  if(cloudSync.ready||cloudSync.starting)return;
  cloudSync.starting=true;
  try{
    updateSyncStatus(null,'connecting');
    await migrateLegacyMediaToCloud();
    await initCloudSync();
  }catch(err){console.error('圖片搬移／同步啟動失敗',err);updateSyncStatus(err);}
  finally{cloudSync.starting=false;}
}

/* ============ 線上／離線狀態 ============ */
function updateNetStatus(){
  const el = document.getElementById('netStatus');
  if(!el) return;
  const online = navigator.onLine;
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  el.innerHTML = online
    ? '<span class="net-dot online"></span><span class="net-txt">線上</span>'
    : '<span class="net-dot offline"></span><span class="net-txt">離線</span>';
}
window.addEventListener('online', async()=>{ updateNetStatus(); loadLiveWeather(); refreshRainRadar();if(readAuthSession()){familyAuthSession=readAuthSession();try{await ensureAuthToken();hideReloginBanner();startFamilyCloud();}catch(e){updateSyncStatus(e);if(/登入已過期/.test(String(e&&e.message||e)))showReloginBanner();}} });
window.addEventListener('offline', updateNetStatus);

/* ============ Service Worker（離線快取整個網頁） ============ */
if (navigator.serviceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=ng4').then(()=>navigator.serviceWorker.ready).catch(()=>{});
  });
}
document.addEventListener('error',e=>{if(e.target?.tagName==='IMG')imageErrorFallback(e.target);},true);

/* ============ TABS ============ */
function setTab(tab) {
  document.querySelectorAll('.tab-btn, .nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`[onclick="setTab('${tab}')"]`).forEach(b => b.classList.add('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-'+tab).classList.add('active');
  window.scrollTo({top:0, behavior:'smooth'});
  if(tab === 'weather'){ setTimeout(refreshRainRadar, 100); renderSnowPanel(); prefetchSnow(false); }
}

/* ============ 路線摘要：可收合 ============ */
function toggleRouteSummary(force){
  const card = document.getElementById('routeSummaryCard');
  const heading = document.getElementById('routeSummaryHeading');
  if(!card) return;
  const collapsed = typeof force === 'boolean' ? force : !card.classList.contains('collapsed');
  card.classList.toggle('collapsed', collapsed);
  if(heading) heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try{ localStorage.setItem('nagano_route_summary_collapsed', collapsed ? '1' : '0'); }catch(e){}
}
(function initRouteSummaryState(){
  let collapsed = false;
  try{ collapsed = localStorage.getItem('nagano_route_summary_collapsed') === '1'; }catch(e){}
  document.addEventListener('DOMContentLoaded', () => toggleRouteSummary(collapsed));
})();

function removeUnneededUtilityUI(){
  const patterns=[/跨裝置資料備份/,/匯出備份/,/匯入備份/,/輸出.*行程/,/儲存.*行程/];
  document.querySelectorAll('button,a,section,.card,.guide-card,.utility-card').forEach(el=>{
    const text=(el.textContent||'').replace(/\s+/g,' ').trim();
    if(patterns.some(r=>r.test(text))){
      const card=el.closest('section,.card,.guide-card,.utility-card') || el;
      card.style.display='none';
    }
  });
}



/* 餐飲詳細介紹：收到正式餐廳清單後補上 */

/* ============ INIT ============ */
const initialTodayIndex=tripTodayIndex();
if(initialTodayIndex>=0)activeDay=initialTodayIndex;
updateSpotCount();

/* =====================================================================
   v47 新增功能區塊
   長輩大字模式／住宿設施／照片位置調整／可編輯交通提醒／吃·逛旅途／購物圖庫／行李細項／tenki 連結
   ===================================================================== */

/* ---------- 通用表單視窗（沿用景點編輯視窗的樣式） ---------- */
function openFormModal({title,fields,onSave,onDelete,saveText='儲存'}){
  closeFormModal(true);
  const wrap=document.createElement('div');
  wrap.className='spot-edit-modal active';wrap.id='formModal';
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeFormModal();});
  const fieldHTML=fields.map(f=>{
    let input;
    if(f.type==='textarea') input=`<textarea data-f="${f.id}" rows="${f.rows||3}" placeholder="${escAttr(f.placeholder||'')}">${escHtml(f.value||'')}</textarea>`;
    else if(f.type==='file') input=`<input type="file" data-f="${f.id}" accept="image/*">`;
    else if(f.type==='custom') return `<div class="spot-edit-field">${f.label?`<span>${escHtml(f.label)}</span>`:''}${f.html}</div>`;
    else if(f.type==='date') input=`<input type="date" data-f="${f.id}" value="${escAttr(f.value||'')}">`;
    else if(f.type==='files') input=`<input type="file" data-f="${f.id}" data-multi="1" accept="image/*" multiple>`;
    else if(f.type==='select') input=`<select data-f="${f.id}">${f.options.map(o=>`<option value="${escAttr(o.value)}" ${o.value===f.value?'selected':''}>${escHtml(o.label)}</option>`).join('')}</select>`;
    else input=`<input type="text" data-f="${f.id}" value="${escAttr(f.value||'')}" placeholder="${escAttr(f.placeholder||'')}">`;
    return `<label class="spot-edit-field"><span>${escHtml(f.label)}</span>${input}</label>`;
  }).join('');
  wrap.innerHTML=`<div class="spot-edit-modal-card"><div class="spot-edit-modal-head"><h3>${escHtml(title)}</h3><button class="spot-edit-modal-close" type="button" data-close>✕</button></div><div class="spot-edit-modal-body">${fieldHTML}</div><div class="spot-edit-modal-actions">${onDelete?'<button type="button" class="spot-edit-reset" data-del>刪除</button>':''}<button type="button" class="spot-edit-save" data-save>${saveText}</button></div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]').onclick=()=>closeFormModal();
  wrap.querySelector('[data-save]').onclick=()=>{
    const v={};wrap.querySelectorAll('[data-f]').forEach(el=>{v[el.dataset.f]=el.type==='file'?(el.dataset.multi?[...(el.files||[])]:((el.files&&el.files[0])||null)):el.value.trim();});
    const r=onSave(v);
    if(r&&typeof r.then==='function'){const btn=wrap.querySelector('[data-save]');btn.disabled=true;btn.textContent='儲存中…';r.then(ok=>{if(ok===false){btn.disabled=false;btn.textContent=saveText;}else closeFormModal();}).catch(()=>{btn.disabled=false;btn.textContent=saveText;});}
    else if(r!==false)closeFormModal();
  };
  const del=wrap.querySelector('[data-del]');
  if(del)del.onclick=()=>{if(confirm('確定要刪除嗎？（刪除後 5 秒內可按「復原」）')){onDelete();closeFormModal();}};
  fields.forEach(f=>{if(typeof f.init==='function')f.init(wrap);});
  if(!fields.some(f=>f.noFocus))setTimeout(()=>wrap.querySelector('[data-f]:not([type=hidden])')?.focus(),60);
}
function closeFormModal(silent){
  document.getElementById('formModal')?.remove();
  if(!silent&&typeof flushPendingDayRender==='function')flushPendingDayRender();
}
function safeUrl(u){u=String(u||'').trim();return /^https?:\/\//i.test(u)?u:'';}
function linksToText(links){return (links||[]).map(l=>`${l.label} | ${l.url}`).join('\n');}
function parseLinkLines(text){
  return String(text||'').split('\n').map(l=>l.trim()).filter(Boolean).map(line=>{
    const parts=line.split(/\s*[|｜]\s*/);
    const url=safeUrl(parts.length>1?parts[parts.length-1]:parts[0]);
    if(!url)return null;
    const label=parts.length>1?parts.slice(0,-1).join(' '):url.replace(/^https?:\/\/(www\.)?/,'').split('/')[0];
    return {label,url};
  }).filter(Boolean);
}
function newItemId(prefix){return prefix+'-'+(crypto.randomUUID?crypto.randomUUID().slice(0,8):Date.now().toString(36)+Math.random().toString(36).slice(2,6));}

/* ---------- 1. 長輩大字模式 ---------- */
/* 三段字級：0=標準、1=放大、2=特大（舊版「大字」＝放大） */
/* (v49 已改寫，見檔案後段) */
/* (v49 已改寫，見檔案後段) */
/* (v49 已改寫，見檔案後段) */
/* 文字大小只有兩段：標準／特大 */
function setTextSize(level,{persist=true}={}){
  const big=Number(level)>=1;
  document.body.classList.toggle('large-text',big);
  document.body.classList.remove('xlarge-text');
  if(persist)try{localStorage.setItem('nagano_text_size_v2',big?'1':'0');}catch(e){}
  if(typeof syncHeaderControls==='function')syncHeaderControls();
}
(function(){let v=null;try{v=localStorage.getItem('nagano_text_size_v2');}catch(e){}if(v==null)v=localStorage.getItem('nagano_large_text_v1')==='1'?'1':'0';setTextSize(Number(v)>=1?1:0,{persist:false});})();
document.addEventListener('DOMContentLoaded',()=>setTextSize(document.body.classList.contains('large-text')?1:0,{persist:false}));


/* ---------- 11. 住宿設施（浴缸／免費洗衣機／早餐／晚餐） ---------- */
const HOTEL_AMENITIES=[
  {id:'bath',label:'浴缸',yes:'🛁 有浴缸',no:'🚿 無浴缸'},
  {id:'laundry',label:'免費洗衣機',yes:'🧺 有免費洗衣機',no:'🧺 無免費洗衣機'},
  {id:'breakfast',label:'早餐',yes:'🍳 有早餐',no:'🍳 無早餐'},
  {id:'dinner',label:'晚餐',yes:'🍽️ 有晚餐',no:'🍽️ 無晚餐'}
];
function hotelAmenityChips(key){
  return HOTEL_AMENITIES.map(a=>{
    const v=currentFieldValue(key,'amen_'+a.id,null);
    const cls=v==='yes'?'yes':v==='no'?'no':'ask';
    const txt=v==='yes'?'有':v==='no'?'無':'待確認';
    return `<button type="button" class="amen-chip amen-${cls}" onclick="cycleAmenity(event,'${key}','${a.id}')"><i></i><span>${a.label}</span><b>${txt}</b></button>`;
  }).join('');
}
function hotelAmenityBlock(key){
  return `<div class="info-item full-w hotel-amen"><div class="k">住宿設施<span class="amen-hint edit-only">（編輯模式下點一下可切換：待確認 → 有 → 無）</span></div><div class="v amen-row">${hotelAmenityChips(key)}</div></div>`;
}
function cycleAmenity(event,key,id){
  event.stopPropagation();
  if(!document.body.classList.contains('mode-edit'))return;   /* 旅行模式只顯示，不誤觸更動 */
  const cur=currentFieldValue(key,'amen_'+id,null);
  const next=cur==null?'yes':cur==='yes'?'no':null;
  fieldOverrideStore[fieldOverrideKey(key,'amen_'+id)]=next;
  persistFieldOverrides();
  renderDayContent();
  setTimeout(()=>document.getElementById('spot-card-'+key)?.classList.add('open'),50);
}
function dayStays(i){
  const d=days[i];if(!d)return [];const hidden=new Set(hiddenFixedSpotsStore[i]||[]),out=[];
  const add=(s,key)=>{if(s.cat!=='hotel'||hidden.has(key))return;const name=currentFieldValue(key,'name',s.name)||s.name;out.push({key,name,nav:currentFieldValue(key,'mapQuery',null)||name});};
  (d.spots||[]).forEach((s,j)=>add(s,`d${i}-m${j}`));
  (d.moreSpots||[]).forEach((s,j)=>add(s,`d${i}-s${j}`));
  (customSpotsStore[i]||[]).forEach((s,j)=>{if(!s.deleted)add(s,`d${i}-c${j}`);});
  return out;
}

/* ---------- 10. 照片位置調整 ---------- */
let photoPosStore=(()=>{try{return JSON.parse(localStorage.getItem('nagano_photo_pos'))||{};}catch(e){return {};}})();
function persistPhotoPos(){safeSetItem('nagano_photo_pos',photoPosStore);}
function photoPosAttr(url){
  const p=photoPosStore[url];if(!p)return '';
  const fit=p.fit==='contain'?'contain':'cover';
  const x=Math.min(100,Math.max(0,Number(p.x)));const y=Math.min(100,Math.max(0,Number(p.y)));
  return ` style="object-fit:${fit};object-position:${isNaN(x)?50:x}% ${isNaN(y)?50:y}%;"`;
}
function openPhotoPosEditor(event,btn){
  if(event)event.stopPropagation();
  const url=btn.dataset.src;
  const hw=16,hh=9;   /* 展開後的大封面是 16:9，以此比例預覽 */
  const cur=photoPosStore[url]||{};
  const st={x:isNaN(Number(cur.x))||cur.x==null?50:Number(cur.x),y:isNaN(Number(cur.y))||cur.y==null?50:Number(cur.y),fit:cur.fit==='contain'?'contain':'cover'};
  const fw=Math.min(360,window.innerWidth-56),fh=Math.round(fw*hh/hw);
  document.getElementById('photoPosModal')?.remove();
  const wrap=document.createElement('div');wrap.className='spot-edit-modal active';wrap.id='photoPosModal';
  wrap.innerHTML=`<div class="spot-edit-modal-card"><div class="spot-edit-modal-head"><h3>🖼️ 調整照片位置</h3><button class="spot-edit-modal-close" type="button" data-close>✕</button></div><p class="pp-help">用手指（或滑鼠）在下方畫面上<b>拖曳照片</b>，調整封面要露出哪一段。這裡看到的就是封面實際顯示的樣子。</p><div class="pp-frame" style="width:${fw}px;height:${fh}px;"><img src="${escAttr(url)}" draggable="false" alt=""></div><div class="pp-fit"><button type="button" data-fit="cover">填滿封面（會裁切邊緣）</button><button type="button" data-fit="contain">完整顯示整張照片</button></div><div class="spot-edit-modal-actions"><button type="button" class="spot-edit-reset" data-reset>還原預設</button><button type="button" class="spot-edit-save" data-save>💾 儲存位置</button></div></div>`;
  document.body.appendChild(wrap);
  const frame=wrap.querySelector('.pp-frame'),img=frame.querySelector('img');
  const apply=()=>{img.style.objectFit=st.fit;img.style.objectPosition=`${st.x}% ${st.y}%`;wrap.querySelectorAll('[data-fit]').forEach(b=>b.classList.toggle('active',b.dataset.fit===st.fit));frame.classList.toggle('no-drag',st.fit==='contain');};
  apply();
  const clamp=v=>Math.min(100,Math.max(0,v));
  let drag=null;
  frame.addEventListener('pointerdown',e=>{drag={sx:e.clientX,sy:e.clientY,x:st.x,y:st.y};try{frame.setPointerCapture(e.pointerId);}catch(_e){}});
  frame.addEventListener('pointermove',e=>{
    if(!drag||st.fit==='contain')return;
    const nw=img.naturalWidth,nh=img.naturalHeight;if(!nw||!nh)return;
    const scale=Math.max(fw/nw,fh/nh),ow=nw*scale-fw,oh=nh*scale-fh;
    if(ow>1)st.x=clamp(drag.x-(e.clientX-drag.sx)/ow*100);
    if(oh>1)st.y=clamp(drag.y-(e.clientY-drag.sy)/oh*100);
    apply();
  });
  const end=()=>{drag=null;};
  frame.addEventListener('pointerup',end);frame.addEventListener('pointercancel',end);
  wrap.querySelectorAll('[data-fit]').forEach(b=>b.onclick=()=>{st.fit=b.dataset.fit;apply();});
  const close=()=>{wrap.remove();flushPendingDayRender();};
  wrap.addEventListener('click',e=>{if(e.target===wrap)close();});
  wrap.querySelector('[data-close]').onclick=close;
  wrap.querySelector('[data-reset]').onclick=()=>{delete photoPosStore[url];persistPhotoPos();close();renderDayContent();};
  wrap.querySelector('[data-save]').onclick=()=>{photoPosStore[url]={x:Math.round(st.x),y:Math.round(st.y),fit:st.fit};persistPhotoPos();close();renderDayContent();};
}

/* ---------- 4. 可修改／刪除的交通提醒（環線頁） ---------- */
let transportCardsData=[];
let _transportSeed=[];
function parseTransportSeed(){
  const out=[];
  const pr=document.querySelector('.transport-principles');
  if(pr){
    const items=[...pr.querySelectorAll('.transport-principles-body ul li')].map(li=>li.textContent.trim());
    const links=[...pr.querySelectorAll('.transport-link-row a')].map(a=>({label:a.textContent.trim(),url:a.getAttribute('href')}));
    out.push({id:'tp-principles',kind:'principle',day:'',title:pr.querySelector('.transport-principles-head h4')?.textContent.trim()||'票券、叫車與搭乘原則',text:items.join('\n'),links});
  }
  document.querySelectorAll('.transport-grid .transport-card').forEach((card,i)=>{
    const day=card.querySelector('.transport-day')?.textContent.trim()||'';
    const body=card.querySelector(':scope > div:last-child');
    out.push({id:'tc-'+i+'-'+day.replace(/[^A-Za-z0-9]/g,''),kind:'card',day,title:body?.querySelector('h4')?.textContent.trim()||'交通提醒',text:body?.querySelector('p')?.textContent.trim()||'',links:[...(body?.querySelectorAll('.transport-link-row a')||[])].map(a=>({label:a.textContent.trim(),url:a.getAttribute('href')}))});
  });
  return out;
}
function initTransportCards(){
  _transportSeed=parseTransportSeed();
  let stored=null;try{stored=JSON.parse(localStorage.getItem('nagano_transport_cards'));}catch(e){}
  transportCardsData=Array.isArray(stored)?normalizeStructuredList('nagano_transport_cards',stored):structuredClone(_transportSeed);
  renderTransportCards();
}
function persistTransportCards(){safeSetItem('nagano_transport_cards',transportCardsData);}
const openTransportIds=new Set();
function tcLinksHTML(links){
  const ok=(links||[]).filter(l=>safeUrl(l.url));
  return ok.length?`<div class="transport-link-row">${ok.map(l=>`<a href="${escAttr(l.url)}" target="_blank" rel="noopener">${escHtml(l.label||l.url)}</a>`).join('')}</div>`:'';
}
function renderTransportCards(){
  const grid=document.querySelector('.transport-grid'),nav=document.getElementById('transportQuickNav');
  if(!grid)return;
  const cards=transportCardsData.filter(c=>c.kind==='card');
  grid.innerHTML=cards.map((c,i)=>`<details class="transport-card transport-card-compact" id="route-transport-${i}" ${openTransportIds.has(c.id)?'open':''} ontoggle="this.open?openTransportIds.add('${c.id}'):openTransportIds.delete('${c.id}')"><summary><span class="transport-day">${escHtml(c.day||'•')}</span><span class="transport-compact-title"><strong>${escHtml(c.title)}</strong><small>點擊查看提醒與官方連結</small></span><em>＋</em></summary><div class="transport-card-body"><p class="tc-text">${escHtml(c.text)}</p>${tcLinksHTML(c.links)}<div class="edit-only tc-edit-row"><button type="button" onclick="editTransportCard('${c.id}')">✎ 修改</button><button type="button" class="tc-del" onclick="deleteTransportCard('${c.id}')">🗑 刪除</button></div></div></details>`).join('')||'<div class="empty compact">目前沒有交通提醒。</div>';
  if(nav)nav.innerHTML=cards.map((c,i)=>`<button type="button" onclick="openRouteTransportCard(${i})">${escHtml(c.day||'•')}</button>`).join('');
  const pr=document.querySelector('.transport-principles'),p=transportCardsData.find(c=>c.kind==='principle');
  if(pr){
    pr.style.display=p?'':'none';
    if(p){
      const h=pr.querySelector('.transport-principles-head h4');if(h)h.textContent=p.title||'票券、叫車與搭乘原則';
      const body=pr.querySelector('.transport-principles-body');
      if(body)body.innerHTML=`<ul>${String(p.text||'').split('\n').filter(x=>x.trim()).map(x=>`<li>${escHtml(x)}</li>`).join('')}</ul>${tcLinksHTML(p.links)}<div class="edit-only tc-edit-row"><button type="button" onclick="editTransportCard('${p.id}')">✎ 修改</button><button type="button" class="tc-del" onclick="deleteTransportCard('${p.id}')">🗑 刪除</button></div>`;
    }
  }
  let row=document.getElementById('transportEditRow');
  if(!row){row=document.createElement('div');row.id='transportEditRow';row.className='edit-only tc-add-row';grid.insertAdjacentElement('afterend',row);}
  row.innerHTML='<button type="button" onclick="addTransportCard()">＋ 新增交通提醒</button><button type="button" onclick="restoreTransportCards()">↺ 還原預設內容</button>';
}
function transportCardFields(c){
  const isP=c.kind==='principle';
  return [
    ...(isP?[]:[{id:'day',label:'日期／標籤（例如 D3）',value:c.day}]),
    {id:'title',label:'標題',value:c.title},
    {id:'text',label:isP?'內容（每行一條）':'提醒內容',type:'textarea',rows:isP?7:5,value:c.text},
    {id:'links',label:'連結（每行一筆，格式：名稱 | 網址）',type:'textarea',rows:4,value:linksToText(c.links),placeholder:'JR 東日本運行情報 | https://traininfo.jreast.co.jp/train_info/'}
  ];
}
function editTransportCard(id){
  const c=transportCardsData.find(x=>x.id===id);if(!c)return;
  openFormModal({title:'✎ 修改交通提醒',fields:transportCardFields(c),
    onSave:v=>{if(!v.title){alert('請輸入標題');return false;}Object.assign(c,{day:v.day??c.day,title:v.title,text:v.text,links:parseLinkLines(v.links)});persistTransportCards();renderTransportCards();},
    onDelete:()=>deleteTransportCard(id,true)});
}
function deleteTransportCard(id,skipConfirm){
  if(!skipConfirm&&!confirm('確定刪除這則交通提醒？（5 秒內可復原）'))return;
  const i=transportCardsData.findIndex(x=>x.id===id);if(i<0)return;
  const removed=transportCardsData.splice(i,1)[0];persistTransportCards();renderTransportCards();
  offerUndo('已刪除交通提醒',()=>{transportCardsData.splice(i,0,removed);persistTransportCards();renderTransportCards();});
}
function addTransportCard(){
  const c={id:newItemId('tc'),kind:'card',day:'',title:'',text:'',links:[]};
  openFormModal({title:'＋ 新增交通提醒',fields:transportCardFields(c),saveText:'💾 新增',
    onSave:v=>{if(!v.title){alert('請輸入標題');return false;}c.day=v.day||'';c.title=v.title;c.text=v.text;c.links=parseLinkLines(v.links);transportCardsData.push(c);openTransportIds.add(c.id);persistTransportCards();renderTransportCards();}});
}
function restoreTransportCards(){
  if(!confirm('要把交通提醒還原成原本內建的內容嗎？你新增與修改過的內容會被取代。'))return;
  const backup=structuredClone(transportCardsData);
  transportCardsData=structuredClone(_transportSeed);persistTransportCards();renderTransportCards();
  offerUndo('已還原預設交通提醒',()=>{transportCardsData=backup;persistTransportCards();renderTransportCards();});
}
/* 每日「🚉 交通」分頁：每個步驟可修改／刪除 */
function editTransportStep(sk){
  const o=(window._tpOrig||{})[sk];if(!o)return;
  const val=f=>currentFieldValue(sk,f,o[f])||o[f]||'';
  openFormModal({title:'✎ 修改交通步驟',fields:[{id:'from',label:'起點',value:val('from')},{id:'to',label:'終點',value:val('to')},{id:'mode',label:'交通方式／路線',value:val('mode')},{id:'time',label:'預估時間',value:val('time')},{id:'note',label:'備註',type:'textarea',rows:3,value:val('note')}],
    onSave:v=>{['from','to','mode','time','note'].forEach(f=>{fieldOverrideStore[fieldOverrideKey(sk,f)]=v[f]||null;});persistFieldOverrides();safeRenderDayContent();},
    onDelete:()=>deleteTransportStep(sk,true)});
}
function deleteTransportStep(sk,skipConfirm){
  if(!skipConfirm&&!confirm('確定刪除這個交通步驟？'))return;
  const k=fieldOverrideKey(sk,'hidden');fieldOverrideStore[k]='1';persistFieldOverrides();safeRenderDayContent();
  offerUndo('已刪除交通步驟',()=>{delete fieldOverrideStore[k];persistFieldOverrides();safeRenderDayContent();});
}
function restoreTransportSteps(dayIdx){
  if(!confirm('要還原這一天所有交通步驟的修改與刪除嗎？'))return;
  Object.keys(fieldOverrideStore).filter(k=>k.startsWith(`tp${dayIdx}-`)).forEach(k=>delete fieldOverrideStore[k]);
  persistFieldOverrides();renderDayContent();
}

/* ---------- 9. 吃·旅途／逛·旅途 ---------- */
let eatShopStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_eatshop'));return Array.isArray(v)?v:[];}catch(e){return [];}})();
function persistEatShop(){safeSetItem('nagano_eatshop',eatShopStore);}
/* (v51 已改寫) */
/* (v49 已改寫，見檔案後段) */
function walkLink(fromQ,toQ){
  const q=v=>/^https?:\/\//i.test(v)?'':encodeURIComponent(v+' Japan');
  const o=q(fromQ),d=q(toQ);
  return (o&&d)?`https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=walking`:mapsLink(toQ);
}
/* (v49 已改寫，見檔案後段) */
function eatShopFields(c,groups){
  return [
    {id:'name',label:'名稱',value:c.name},
    {id:'area',label:'放在哪個住宿點附近',type:'select',value:c.area||'',options:[{value:'',label:'（未分區）'},...groups.map(g=>({value:g.label,label:g.label}))]},
    {id:'note',label:'附註（營業時間、想點什麼、預約等）',type:'textarea',rows:3,value:c.note},
    {id:'mapQuery',label:'導航位置（地址、Google Maps 網址、經緯度或關鍵字；留空＝用名稱）',value:c.mapQuery}
  ];
}
function addEatShop(kind){
  const c={id:newItemId('es'),kind,name:'',area:'',note:'',mapQuery:''};
  openFormModal({title:'＋ 新增',fields:eatShopFields(c,stayGroups()),saveText:'💾 新增',onSave:v=>{if(!v.name){alert('請輸入名稱');return false;}Object.assign(c,v);eatShopStore.push(c);persistEatShop();renderDayContent();}});
}
function editEatShop(id){
  const c=eatShopStore.find(x=>x.id===id);if(!c)return;
  openFormModal({title:'✎ 修改',fields:eatShopFields(c,stayGroups()),onSave:v=>{if(!v.name){alert('請輸入名稱');return false;}Object.assign(c,v);persistEatShop();renderDayContent();},onDelete:()=>deleteEatShop(id,true)});
}
function deleteEatShop(id,skip){
  if(!skip&&!confirm('確定刪除？'))return;
  const i=eatShopStore.findIndex(x=>x.id===id);if(i<0)return;
  const removed=eatShopStore.splice(i,1)[0];persistEatShop();if(marksStore['es:'+id])setMark('es:'+id,{fav:0,status:'',info:'',remind:'',remindDate:''});renderDayContent();
  offerUndo('已刪除',()=>{eatShopStore.splice(i,0,removed);persistEatShop();renderDayContent();});
}

/* ---------- 5/6. 購物清單：五大分類、可改名與附註、旅行模式大圖圖庫 ---------- */
/* (v52 已改寫) */
/* (v52 已改寫) */
function shopGalMove(cat,dir){
  const t=document.querySelector(`.shop-gal-track[data-cat="${cat}"]`);if(!t)return;
  t.scrollBy({left:dir*t.clientWidth,behavior:'smooth'});
}
function updateShopGalCount(t){
  const el=t.parentElement.querySelector('.shop-gal-count');if(!el||!t.clientWidth)return;
  el.textContent=`${Math.round(t.scrollLeft/t.clientWidth)+1} / ${t.children.length}`;
}
/* (v52 已改寫) */
function editShopItem(i){
  const it=shopData[i];if(!it)return;
  openFormModal({title:'✎ 修改購物項目',fields:[
    {id:'name',label:'名稱',value:it.name},
    {id:'cat',label:'分類',type:'select',value:it.cat||'supermarket',options:Object.keys(SHOP_CATS).map(k=>({value:k,label:SHOP_CATS[k].label}))},
    {id:'location',label:'附註（品牌、規格、想買的店、預算…）',type:'textarea',rows:3,value:it.location||''}],
    onSave:v=>{if(!v.name){alert('請輸入名稱');return false;}it.name=v.name;it.cat=v.cat;it.location=v.location;persistShop();listSectionOpen.shop[v.cat]=true;renderShopList();},
    onDelete:()=>{delShop(i);}});
}
/* 舊版只有「超市／紀念品」，其他一律歸超市；購物清單顯示與分類都已擴充成五類 */

/* ---------- 7. 行李打包：每個大類下再分細項（可自訂） ---------- */
function packSubcatsFor(cat){
  const base=(PACK_SUBCATS[cat]||['其他']).filter(x=>x!=='其他');
  const extra=[];
  const src=window._packLive&&window._packLive[cat];
  if(src)src.forEach(it=>{if(it.subcat&&it.subcat!=='其他'&&!base.includes(it.subcat)&&!extra.includes(it.subcat))extra.push(it.subcat);});
  return [...base,...extra,'其他'];
}
const PACK_GUESS={
  '🎒 隨身背包':[['證件與金錢',/護照|機票|憑證|證|錢|現金|日幣|信用卡|IC|票券|保險|駕照|訂房/],['電子用品',/電|充|線|手機|耳機|轉接|網卡|SIM|Wi-?Fi/i],['機上用品',/頸枕|眼罩|耳塞|機上|筆/],['健康與隨身用品',/藥|口罩|傘|衛生|濕紙巾|眼鏡|水|暖暖包|護唇|面紙|消毒/]],
  '👜 手提行李':[['攝影器材',/相機|記憶卡|鏡頭|腳架|底片/],['電子用品',/電|充|線|平板|筆電|耳機/],['易碎／貴重物品',/貴重|易碎|珠寶|首飾|藥|眼鏡/],['衣物備用',/外套|衣|襪|保暖|圍巾/]],
  '🧳 託運行李':[['鞋襪與配件',/鞋|襪|圍巾|手套|帽|腰帶/],['外套與保暖層',/外套|羽絨|刷毛|毛衣|中層|保暖|發熱/],['上衣與褲裝',/上衣|褲|裙|T恤|襯衫|睡衣|內衣|內褲/],['盥洗與保養',/盥洗|牙|洗|保濕|護唇|保養|乳|防曬|刮鬍|化妝|隱形/],['藥品與備品',/藥|備品|針線|塑膠袋|折疊袋/]]
};
function guessPackSubcat(cat,name){
  const rules=PACK_GUESS[cat]||[];
  for(const [sub,re] of rules)if(re.test(name||''))return sub;
  return null;
}
/* 舊資料的細項預設是每類第一項；沒手動指定過的品項依名稱自動歸到合適細項（只影響顯示，不改資料） */
function effectivePackSubcat(cat,it,subcats){
  const first=subcats[0];let sub=it.subcat||first;
  if(!it.manual&&sub===first){const g=guessPackSubcat(cat,it.name);if(g&&subcats.includes(g))sub=g;}
  return subcats.includes(sub)?sub:'其他';
}
function renderPackSubcatChips(){
  const el=document.getElementById('packSubcatChips');if(!el)return;
  const list=packSubcatsFor(window._packSelectedCat).slice();
  const sel=window._packSelectedSubcat;
  if(sel&&!list.includes(sel))list.splice(list.length-1,0,sel);
  if(!sel)window._packSelectedSubcat=list[0];
  el.innerHTML=list.map(s=>`<button class="pack-subcat-chip ${s===window._packSelectedSubcat?'active':''}" onclick="choosePackSubcat('${jsQuote(s)}')">${escHtml(s)}</button>`).join('')+`<button class="pack-subcat-chip add" onclick="addPackSubcat()">＋ 新細項</button>`;
}
function addPackSubcat(){
  const n=(prompt('新細項名稱（例如：嬰幼兒用品、登山裝備）','')||'').trim();
  if(!n)return;
  window._packSelectedSubcat=n;renderPackSubcatChips();
}
function editPackItem(cat,i){
  const it=packData[cat][i];if(!it)return;
  const subcats=packSubcatsFor(cat);
  openFormModal({title:'✎ 修改行李品項',fields:[
    {id:'name',label:'品項名稱',value:it.name},
    {id:'subcat',label:'細項分類',type:'select',value:effectivePackSubcat(cat,it,subcats),options:subcats.map(s=>({value:s,label:s}))},
    {id:'newsub',label:'或建立新細項（留空則使用上方選擇）',value:''}],
    onSave:v=>{if(!v.name){alert('請輸入品項名稱');return false;}it.name=v.name;it.subcat=v.newsub||v.subcat;it.manual=true;persistPack();renderPackList();},
    onDelete:()=>delPack(cat,i)});
}


/* ---------- 備份／還原／每日本機快照（參考紐西蘭版） ---------- */
const SNAPSHOT_KEY='nagano_snapshots_v1';
function collectBackup(){
  const data={};
  SYNC_KEYS.forEach(k=>{const v=localValueForKey(k);if(v!=null)data[k]=v;});
  return {app:'nagano-trip',version:47,exportedAt:new Date().toISOString(),data};
}
function backupSummary(b){
  const d=(b&&b.data)||{};
  const n=k=>{const v=d[k];return !v?0:Array.isArray(v)?v.length:Object.keys(v).length;};
  return `筆記 ${n('nagano_notes')}・自訂景點 ${Object.values(d.nagano_custom_spots||{}).reduce((a,x)=>a+(x||[]).length,0)}・購物 ${n('nagano_shop')}・行李 ${Object.values(d.nagano_pack||{}).reduce((a,x)=>a+(x||[]).length,0)}・交通提醒 ${n('nagano_transport_cards')}`;
}
function downloadBackup(){
  const b=collectBackup();
  const blob=new Blob([JSON.stringify(b,null,1)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=`nagano-trip-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}
async function applyBackupData(data){
  cloudSync.applyingRemote=true;
  try{
    for(const k of SYNC_KEYS){
      if(!(k in data))continue;
      const v=normalizeSyncValue(k,data[k]);
      replaceLocalJson(k,v);applyStoreUpdate(k,JSON.stringify(v));
    }
  }finally{cloudSync.applyingRemote=false;}
  /* 還原＝以備份為準：直接覆蓋雲端（不做合併），並重設同步基準，否則刪除的項目會被雲端補回來 */
  if(cloudSync.enabled){
    for(const k of SYNC_KEYS){
      if(!(k in data))continue;
      try{const t=await restUpsert(k,normalizeSyncValue(k,data[k]));setSyncMeta(k,t);setSyncBase(k,normalizeSyncValue(k,data[k]));}
      catch(e){console.error('還原後同步失敗',k,e);updateSyncStatus(e);}
    }
  }
  renderDayChips();renderDayContent();renderPackList();renderShopList();renderRulesList();renderDocsList();renderTransportCards();renderLive();renderMarksBar();
}
function restoreBackupFromObject(obj,label){
  const b=obj&&obj.data&&obj.app==='nagano-trip'?obj:null;
  if(!b){alert('這不是有效的長野行程備份檔。');return;}
  if(!confirm(`要還原「${label}」嗎？\n\n備份內容：${backupSummary(b)}\n\n目前這台裝置與雲端的資料會被備份內容取代。系統會先自動存一份「還原前」快照，之後還能從快照救回。`))return;
  saveSnapshot('還原前自動備份',true);
  applyBackupData(b.data).then(()=>alert('✅ 已還原。'));
}
function restoreBackupFile(ev){
  const f=ev.target.files&&ev.target.files[0];ev.target.value='';if(!f)return;
  const r=new FileReader();
  r.onload=()=>{try{restoreBackupFromObject(JSON.parse(r.result),f.name);}catch(e){alert('備份檔讀取失敗：'+e.message);}};
  r.readAsText(f);
}
function readSnapshots(){try{const v=JSON.parse(localStorage.getItem(SNAPSHOT_KEY));return Array.isArray(v)?v:[];}catch(e){return [];}}
function saveSnapshot(label,force){
  const list=readSnapshots(),today=new Date().toISOString().slice(0,10);
  if(!force&&list.some(x=>x.day===today&&x.label==='每日自動'))return;
  const bk=collectBackup();if(!force&&!Object.keys(bk.data).length)return;   /* 空資料不存，避免把好的快照擠掉 */
  const snap={id:newItemId('sn'),day:today,label:label||'每日自動',at:new Date().toISOString(),backup:bk};
  list.unshift(snap);
  let keep=list.slice(0,3);
  while(keep.length){try{localStorage.setItem(SNAPSHOT_KEY,JSON.stringify(keep));return;}catch(e){keep=keep.slice(0,-1);}}
}
function showSnapshots(){
  const list=readSnapshots();
  if(!list.length){alert('這台裝置目前沒有快照。網站每天第一次開啟時會自動保留最近 3 份。');return;}
  const wrap=document.createElement('div');wrap.className='spot-edit-modal active';wrap.id='formModal';
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeFormModal();});
  wrap.innerHTML=`<div class="spot-edit-modal-card"><div class="spot-edit-modal-head"><h3>🕘 本機快照</h3><button class="spot-edit-modal-close" type="button" data-close>✕</button></div><div class="spot-edit-modal-body">${list.map(x=>`<div class="snap-row"><div><strong>${escHtml(x.label)}</strong><small>${new Date(x.at).toLocaleString('zh-TW',{hour12:false})}</small><small>${escHtml(backupSummary(x.backup))}</small></div><button type="button" data-snap="${x.id}">還原</button></div>`).join('')}</div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]').onclick=()=>closeFormModal();
  wrap.querySelectorAll('[data-snap]').forEach(b=>b.onclick=()=>{const x=list.find(s=>s.id===b.dataset.snap);closeFormModal(true);if(x)restoreBackupFromObject(x.backup,x.label+' '+new Date(x.at).toLocaleDateString('zh-TW'));});
}
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')&&!document.activeElement?.isContentEditable){
    const el=document.getElementById(window.innerWidth>=1050?'globalSearchDesktop':'globalSearchMobile');
    if(el){e.preventDefault();setTab('itinerary');el.focus();}
  }
});
setTimeout(()=>{try{saveSnapshot();}catch(e){}},4000);

/* ---------- 8. 天氣：JMA 模型＋ tenki.jp 連結 ---------- */
const TENKI_LINKS={
  Takasaki:'https://tenki.jp/forecast/3/13/4210/10202/',
  Kurohime:'https://tenki.jp/forecast/3/23/4810/20583/',
  Yamada:'https://tenki.jp/forecast/3/23/4810/20543/',
  Nagano:'https://tenki.jp/forecast/3/23/4810/20201/',
  Togakushi:'https://tenki.jp/forecast/3/23/4810/20201/',
  Yokohama:'https://tenki.jp/forecast/3/17/4610/14100/'
};

/* =====================================================================
   v48：收藏／預約狀態／提醒、自駕即時路況、版本與同步比對
   ===================================================================== */
const APP_VERSION='ng4-2026-10-11';

/* ---------- 收藏 ★／預約狀態／提醒 ---------- */
let marksStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_marks'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistMarks(){safeSetItem('nagano_marks',marksStore);}
const BOOK_STATUS={todo:{label:'🔖 待訂',cls:'todo'},booked:{label:'✅ 已訂',cls:'booked'},paid:{label:'💳 已付款',cls:'paid'}};
function marksFor(key){return marksStore[key]||{};}
function setMark(key,patch){
  const m={...marksFor(key),...patch};
  ['fav','status','info','remind','remindDate'].forEach(f=>{if(!m[f])delete m[f];});
  if(Object.keys(m).length)marksStore[key]=m;else delete marksStore[key];
  persistMarks();renderMarksBar();
}
function localDateStr(d=new Date()){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function toggleFav(event,key){
  if(event){event.stopPropagation();event.preventDefault();}
  const on=!marksFor(key).fav;
  setMark(key,{fav:on?1:0});
  document.querySelectorAll('[data-fav]').forEach(b=>{if(b.dataset.fav===String(key)){b.classList.toggle('on',on);b.textContent=on?'★':'☆';b.setAttribute('aria-pressed',on);}});
  renderMarksBar();
  if(typeof activeDay==='string'&&window._eatFavOnly)renderDayContent();
}
function favBtnHTML(key,extra=''){const on=!!marksFor(key).fav;return `<button type="button" class="mark-star ${extra} ${on?'on':''}" data-fav="${escAttr(key)}" aria-pressed="${on}" aria-label="收藏" onclick="toggleFav(event,'${jsQuote(key)}')">${on?'★':'☆'}</button>`;}
function statusChipHTML(key){const m=marksFor(key),s=BOOK_STATUS[m.status];return s?`<span class="book-chip ${s.cls}">${s.label}</span>`:'';}
function marksBoxHTML(key){
  const m=marksFor(key),s=BOOK_STATUS[m.status];
  const has=!!(s||m.info||m.remind);
  const rows=[];
  if(s)rows.push(`<div class="mb-row"><span class="book-chip ${s.cls}">${s.label}</span>${m.info?`<span class="mb-info">${escHtml(m.info)}</span>`:''}</div>`);
  else if(m.info)rows.push(`<div class="mb-row"><span class="mb-info">${escHtml(m.info)}</span></div>`);
  if(m.remind)rows.push(`<div class="mb-row remind">⏰ ${m.remindDate?`<b>${escHtml(m.remindDate)}</b> `:''}${escHtml(m.remind)}</div>`);
  return `<div class="marks-box ${has?'':'is-empty'}" onclick="event.stopPropagation()">${rows.join('')}<button type="button" class="edit-only mb-edit" onclick="event.stopPropagation();editMarks('${jsQuote(key)}')">📌 設定預約／提醒</button></div>`;
}
/* (v51 已改寫) */
function editMarks(key){
  const m=marksFor(key);
  openFormModal({title:'📌 預約／提醒：'+markLabel(key),fields:[
    {id:'status',label:'預約狀態',type:'select',value:m.status||'',options:[{value:'',label:'（不需要預約／未設定）'},{value:'todo',label:'🔖 待訂'},{value:'booked',label:'✅ 已訂'},{value:'paid',label:'💳 已付款'}]},
    {id:'info',label:'預約資訊（時間、人數、確認碼、電話…）',type:'textarea',rows:3,value:m.info||''},
    {id:'remindDate',label:'提醒日期（選填，格式 2026-12-01；當天會在行程頁最上方提醒）',value:m.remindDate||'',placeholder:'2026-12-01'},
    {id:'remind',label:'提醒內容（例如：出發前 3 天要打電話確認）',type:'textarea',rows:2,value:m.remind||''}],
    onSave:v=>{
      if(v.remindDate&&!/^\d{4}-\d{2}-\d{2}$/.test(v.remindDate)){alert('提醒日期格式請填 2026-12-01 這樣的年-月-日');return false;}
      setMark(key,{status:v.status,info:v.info,remindDate:v.remindDate,remind:v.remind});
      renderMarksBar();safeRenderDayContent();
    },
    onDelete:()=>{setMark(key,{status:'',info:'',remindDate:'',remind:''});renderMarksBar();safeRenderDayContent();}});
}
/* 所有「可被標記」的項目：景點（含自訂）與吃逛收藏 */
function markTargets(){
  const map=new Map();
  allSearchableSpots().forEach(it=>{if(it.listType==='transport')return;map.set(it.key,{name:it.name,dayIdx:it.dayIdx,listType:it.listType});});
  eatShopStore.forEach(c=>map.set('es:'+c.id,{name:c.name,kind:c.kind}));
  return map;
}
function marksCounts(){
  const t=markTargets(),c={fav:0,todo:0,booked:0,remind:0};
  Object.entries(marksStore).forEach(([k,m])=>{
    if(!t.has(k))return;
    if(m.fav)c.fav++;if(m.status==='todo')c.todo++;if(m.status==='booked'||m.status==='paid')c.booked++;if(m.remind)c.remind++;
  });
  return c;
}
/* (v49 已改寫，見檔案後段) */
/* (v49 已改寫，見檔案後段) */
function todayRemindHTML(){
  const today=localDateStr(),t=markTargets(),items=[];
  Object.entries(marksStore).forEach(([k,m])=>{
    if(!m.remind||!t.has(k))return;
    const x=t.get(k);
    if(m.remindDate?m.remindDate===today:(x.dayIdx===activeDay))items.push({name:x.name,text:m.remind});
  });
  if(!items.length)return '';
  return `<div class="remind-banner"><b>⏰ 提醒</b>${items.map(i=>`<div>${escHtml(i.name)}：${escHtml(i.text)}</div>`).join('')}</div>`;
}

/* ---------- 自駕即時路況與緊急聯絡（可修改、刪除、新增、還原） ---------- */
const LIVE_SEED=[
  {id:'lv-jr',kind:'link',group:'交通即時狀況',title:'JR 東日本 列車運行情報',text:'新幹線與在來線的停駛、延誤以此為準；移動日早上先看一次。',url:'https://traininfo.jreast.co.jp/train_info/'},
  {id:'lv-road',kind:'link',group:'交通即時狀況',title:'JARTIC 日本道路交通情報',text:'全國道路壅塞與規制；自駕去戶隱、妙高、山田溫泉前確認。',url:'https://www.jartic.or.jp/'},
  {id:'lv-nexco',kind:'link',group:'交通即時狀況',title:'NEXCO 東日本 道路交通情報',text:'上信越道、關越道的塞車與施工規制。',url:'https://www.driveplaza.com/traffic/'},
  {id:'lv-nrt',kind:'link',group:'交通即時狀況',title:'成田機場 官方網站',text:'4/24 去程確認航班狀態與機場交通。',url:'https://www.narita-airport.jp/'},
  {id:'lv-hnd',kind:'link',group:'交通即時狀況',title:'羽田機場 官方網站',text:'5/3 回程確認航班狀態與第 3 航廈交通。',url:'https://tokyo-haneda.com/'},
  {id:'lv-togakushi',kind:'link',group:'交通即時狀況',title:'戶隱觀光・開山消息',text:'奧社參道開放、殘雪與停車資訊。',url:'https://togakushi-21.jp/'},
  {id:'lv-jma',kind:'link',group:'天氣警報',title:'氣象廳 警報・注意報',text:'大雨、強風、雷雨警報以此為準；可切換到長野縣、群馬縣、神奈川縣。',url:'https://www.jma.go.jp/bosai/warning/'},
  {id:'lv-rule',kind:'rule',group:'看到警示時怎麼決定',title:'雨天與人潮判斷順序',text:'1. 大雨或山區道路規制：取消戶隱奧社、妙高步道等高處行程，改飯店休息或市區咖啡。\n2. 黃金週塞車：提早出門，熱門停車場滿了就換下一個點，不在車陣裡硬等。\n3. 新幹線停駛：先看 JR 東日本恢復預估，必要時改搭其他班次並重新劃位。\n4. 回程日：提早前往羽田，並先查航空公司改票規定。'}
];
let liveData=[];
function initLive(){
  let stored=null;try{stored=JSON.parse(localStorage.getItem('nagano_livelinks'));}catch(e){}
  liveData=Array.isArray(stored)?normalizeStructuredList('nagano_livelinks',stored):structuredClone(LIVE_SEED);
  /* hk28：北の道ナビ網址已改（2024/3/29），舊網址自動換新 */
  let fixedUrl=false;liveData.forEach(x=>{if(x&&typeof x.url==='string'&&/\/\/(www\.)?northern-road\.jp\//.test(x.url)){x.url=x.url.replace(/\/\/(www\.)?northern-road\.jp\//,'//northern-road.ceri.go.jp/');fixedUrl=true;}});
  if(fixedUrl&&Array.isArray(stored))persistLive();
  const before=liveData.length;
  liveData=liveData.filter(x=>x.id!=='lv-emg'&&x.group!=='緊急聯絡');   /* 已移除「緊急聯絡」欄 */
  if(Array.isArray(stored)&&liveData.length!==before)persistLive();
  renderLive();
}
function persistLive(){safeSetItem('nagano_livelinks',liveData);}
function renderLive(){
  const wrap=document.getElementById('liveRoadWrap');if(!wrap)return;
  const groups=[];liveData.forEach(it=>{let g=groups.find(x=>x.name===it.group);if(!g){g={name:it.group||'其他',items:[]};groups.push(g);}g.items.push(it);});
  wrap.innerHTML=groups.map(g=>`<div class="live-group"><h4>${escHtml(g.name)}</h4>${g.items.map(it=>{
    const editBtns=`<div class="edit-only tc-edit-row"><button type="button" onclick="editLive('${it.id}')">✎ 修改</button><button type="button" class="tc-del" onclick="deleteLive('${it.id}')">🗑 刪除</button></div>`;
    if(it.kind==='rule')return `<div class="live-rule"><strong>${escHtml(it.title)}</strong><p class="tc-text">${escHtml(it.text)}</p>${editBtns}</div>`;
    const u=safeUrl(it.url);
    return `<div class="live-link">${u?`<a href="${escAttr(u)}" target="_blank" rel="noopener"><strong>${escHtml(it.title)}</strong><small>${escHtml(it.text)}</small></a>`:`<div><strong>${escHtml(it.title)}</strong><small>${escHtml(it.text)}</small></div>`}${editBtns}</div>`;
  }).join('')}</div>`).join('')||'<div class="empty compact">目前沒有項目。</div>';
  wrap.insertAdjacentHTML('beforeend','<div class="edit-only tc-add-row"><button type="button" onclick="addLive()">＋ 新增</button><button type="button" onclick="restoreLive()">↺ 還原預設內容</button></div>');
}
function liveFields(it){
  return [{id:'group',label:'分類',value:it.group},{id:'title',label:'標題',value:it.title},{id:'text',label:'說明',type:'textarea',rows:it.kind==='rule'?7:3,value:it.text},...(it.kind==='rule'?[]:[{id:'url',label:'網址（https://…）',value:it.url}])];
}
function editLive(id){
  const it=liveData.find(x=>x.id===id);if(!it)return;
  openFormModal({title:'✎ 修改',fields:liveFields(it),onSave:v=>{if(!v.title){alert('請輸入標題');return false;}if(it.kind!=='rule'&&v.url&&!safeUrl(v.url)){alert('網址需以 http:// 或 https:// 開頭');return false;}Object.assign(it,{group:v.group||'其他',title:v.title,text:v.text,url:it.kind==='rule'?'':v.url});persistLive();renderLive();},onDelete:()=>deleteLive(id,true)});
}
function deleteLive(id,skip){
  if(!skip&&!confirm('確定刪除？（5 秒內可復原）'))return;
  const i=liveData.findIndex(x=>x.id===id);if(i<0)return;
  const removed=liveData.splice(i,1)[0];persistLive();renderLive();
  offerUndo('已刪除',()=>{liveData.splice(i,0,removed);persistLive();renderLive();});
}
function addLive(){
  const it={id:newItemId('lv'),kind:'link',group:'官方即時路況',title:'',text:'',url:''};
  openFormModal({title:'＋ 新增連結',fields:liveFields(it),saveText:'💾 新增',onSave:v=>{if(!v.title){alert('請輸入標題');return false;}if(v.url&&!safeUrl(v.url)){alert('網址需以 http:// 或 https:// 開頭');return false;}Object.assign(it,{group:v.group||'其他',title:v.title,text:v.text,url:v.url});liveData.push(it);persistLive();renderLive();}});
}
function restoreLive(){
  if(!confirm('要還原成內建的路況連結與判斷規則嗎？你新增與修改的內容會被取代。'))return;
  const backup=structuredClone(liveData);liveData=structuredClone(LIVE_SEED);persistLive();renderLive();
  offerUndo('已還原預設',()=>{liveData=backup;persistLive();renderLive();});
}

/* ---------- 版本與同步狀態、雲端比對（解決「家人看到的不一樣」） ---------- */
function stableStr(v){
  if(Array.isArray(v))return '['+v.map(stableStr).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableStr(v[k])).join(',')+'}';
  return JSON.stringify(v===undefined?null:v);
}
function fmtTime(ms){return ms?new Date(ms).toLocaleString('zh-TW',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'尚未';}
async function renderDeviceStatus(){
  const el=document.getElementById('deviceStatusBody');if(!el)return;
  let swState='不支援';
  if(navigator.serviceWorker){try{const reg=await navigator.serviceWorker.getRegistration();swState=reg?(navigator.serviceWorker.controller?'已啟用（離線可用）':'已註冊，重新整理後啟用'):'未註冊';}catch(e){swState='無法取得';}}
  const email=(typeof familyAuthSession!=='undefined'&&familyAuthSession&&familyAuthSession.email)||(readAuthSession()&&readAuthSession().email)||'未登入';
  const rows=[['網站版本',APP_VERSION],['登入帳號',email],['雲端同步',cloudSync.enabled?'已連線':'未連線（離線或未登入）'],['最後成功同步',fmtTime(cloudSync.lastOk)],['離線快取',swState],['網路',navigator.onLine?'線上':'離線']];
  el.innerHTML=rows.map(([k,v])=>`<div class="ds-row"><span>${k}</span><b>${escHtml(v)}</b></div>`).join('');
}
async function forceRefreshApp(){
  if(!confirm('會清除這台裝置的網站快取並重新載入，取得最新版本。你的行程資料、照片與登入狀態不會被刪除。要繼續嗎？'))return;
  try{if(navigator.serviceWorker){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()));}}catch(e){}
  try{if(window.caches){const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));}}catch(e){}
  location.reload();
}
async function syncNowManual(){
  if(!cloudSync.enabled){alert('目前沒有連上雲端同步。請確認網路與登入狀態。');return;}
  try{await flushCloudPush();await pollCloudChanges();cloudSync.lastOk=Date.now();renderDeviceStatus();alert('✅ 已同步。');}
  catch(e){alert('同步失敗：'+String(e.message||e));}
}
async function diagnoseCloud(){
  if(!cloudSync.enabled||!navigator.onLine){alert('需要在線上且已登入家人同步，才能和雲端比對。');return;}
  let rows;try{rows=await restGetRows();}catch(e){alert('讀取雲端失敗：'+String(e.message||e));return;}
  const remote=new Map(rows.map(r=>[r.key,r]));
  const res=SYNC_KEYS.map(k=>{
    const lv=localValueForKey(k),r=remote.get(k);let rv=null;try{if(r)rv=JSON.parse(r.value);}catch(e){}
    const lBlank=isBlankSyncValue(lv),rBlank=isBlankSyncValue(rv);
    let st='same';
    if(lBlank&&rBlank)st='empty';else if(lBlank)st='cloud';else if(rBlank)st='local';else if(stableStr(normalizeSyncValue(k,lv))!==stableStr(normalizeSyncValue(k,rv)))st='diff';
    return {k,st,at:r&&r.updated_at};
  });
  const label={same:'✅ 相同',empty:'— 都是空的',cloud:'☁️ 只有雲端有',local:'📱 只有這台有',diff:'⚠️ 內容不同'};
  const diffs=res.filter(x=>x.st!=='same'&&x.st!=='empty');
  closeFormModal(true);
  const wrap=document.createElement('div');wrap.className='spot-edit-modal active';wrap.id='formModal';
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeFormModal();});
  wrap.innerHTML=`<div class="spot-edit-modal-card"><div class="spot-edit-modal-head"><h3>🔍 這台 vs 雲端</h3><button class="spot-edit-modal-close" type="button" data-close>✕</button></div><div class="spot-edit-modal-body"><p class="pp-help">${diffs.length?`有 ${diffs.length} 項不一致。通常按「立即同步」就會自動合併；若仍不一致，可選擇以哪一邊為準（系統會先自動存一份快照，可救回）。`:'✅ 這台與雲端完全一致。'}</p>${res.map(x=>`<div class="ds-row"><span>${escHtml(x.k.replace('nagano_',''))}</span><b>${label[x.st]}</b></div>`).join('')}${diffs.length?'<div class="pp-fit"><button type="button" data-pull>☁️ 以雲端為準（覆蓋這台）</button><button type="button" data-push>📱 以這台為準（覆蓋雲端）</button></div>':''}</div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]').onclick=()=>closeFormModal();
  const pull=wrap.querySelector('[data-pull]'),push=wrap.querySelector('[data-push]');
  if(pull)pull.onclick=async()=>{
    if(!confirm('這台裝置的資料會被雲端取代。系統會先存一份快照。確定？'))return;
    saveSnapshot('以雲端覆蓋前',true);closeFormModal(true);
    cloudSync.applyingRemote=true;
    try{
      for(const k of SYNC_KEYS){
        const r=remote.get(k);let v=null;try{if(r)v=JSON.parse(r.value);}catch(e){}
        if(v!=null&&!isBlankSyncValue(v)){v=normalizeSyncValue(k,v);replaceLocalJson(k,v);applyStoreUpdate(k,JSON.stringify(v));setSyncMeta(k,r.updated_at);setSyncBase(k,v);}
        else localStorage.removeItem(k);   /* 雲端沒有＝這台也清掉，重新載入後會回到內建預設 */
      }
    }finally{cloudSync.applyingRemote=false;}
    alert('✅ 已改成雲端版本，頁面將重新載入。');
    try{location.reload();}catch(e){}
  };
  if(push)push.onclick=async()=>{
    if(!confirm('雲端資料會被這台裝置取代（家人的裝置之後也會變成這個版本）。系統會先存一份快照。確定？'))return;
    saveSnapshot('以這台覆蓋雲端前',true);closeFormModal(true);
    try{for(const k of SYNC_KEYS){const v=localValueForKey(k);if(v==null)continue;const nv=normalizeSyncValue(k,v);const t=await restUpsert(k,nv);setSyncMeta(k,t);setSyncBase(k,nv);}cloudSync.lastOk=Date.now();alert('✅ 已把這台的資料寫入雲端。');}
    catch(e){alert('寫入失敗：'+String(e.message||e));}
  };
}
/* 新版通知：不再自動重新載入（會打斷正在編輯的家人），改為顯示橫幅由使用者決定 */
function showUpdateBanner(){
  if(document.getElementById('updateBanner'))return;
  const b=document.createElement('div');b.id='updateBanner';b.className='update-banner';
  b.innerHTML='🆕 網站有新版本 <button type="button" id="updateBannerBtn">立即更新</button><button type="button" id="updateBannerClose" aria-label="關閉">✕</button>';
  document.body.appendChild(b);
  document.getElementById('updateBannerBtn').onclick=()=>location.reload();
  document.getElementById('updateBannerClose').onclick=()=>b.remove();
}
if(navigator.serviceWorker){
  navigator.serviceWorker.addEventListener('message',e=>{if(e.data&&e.data.type==='SW_ACTIVATED'&&sessionStorage.getItem('nagano_sw_seen'))showUpdateBanner();sessionStorage.setItem('nagano_sw_seen','1');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)navigator.serviceWorker.getRegistration().then(r=>r&&r.update()).catch(()=>{});});
}
/* 版本改變時，自動先存一份快照，萬一新版有問題可救回 */
(function(){
  let old=null;try{old=localStorage.getItem('nagano_app_version');}catch(e){}
  if(old&&old!==APP_VERSION){try{saveSnapshot(`更新前自動備份（${old}→${APP_VERSION}）`,true);}catch(e){}}
  try{localStorage.setItem('nagano_app_version',APP_VERSION);}catch(e){}
})();
document.addEventListener('DOMContentLoaded',()=>{initLive();renderMarksBar();renderDeviceStatus();});

/* =====================================================================
   v49：手機優先改版（新標頭與圖示、逛吃畫廊、MaMa 專頁、App 安裝）
   ===================================================================== */
const DAY_CITIES=[['Takasaki'],['Takasaki'],['Takasaki'],['Nagano','Kurohime'],['Kurohime'],['Togakushi','Nagano'],['Nagano'],['Nagano','Yamada'],['Yamada'],['Nagano'],['Togakushi','Nagano'],['Nagano','Yokohama'],['Yokohama'],['Yokohama']];
const NAV_IC={itinerary:'images/nav-itinerary.webp',route:'images/nav-route.webp',guide:'images/nav-guide.webp',weather:'images/nav-weather.webp',food:'images/nav-food.webp',shopping:'images/nav-shopping.webp',lodging:'images/nav-lodging.webp'};
/* hk19：每天「交通」分頁最上方的即時狀況大按鈕（網址沿用環線頁「即時交通與警報」，在那裡改了這裡也跟著變） */
function tpLiveBarHTML(dayIdx){
  const by=id=>(typeof liveData!=='undefined'&&Array.isArray(liveData)?liveData.find(x=>x.id===id&&x.url):null)||(typeof LIVE_SEED!=='undefined'?LIVE_SEED.find(x=>x.id===id):null);
  const flight=dayIdx===0||dayIdx===13;
  const air=dayIdx===0?['lv-nrt','✈️','成田機場']:['lv-hnd','✈️','羽田機場'];
  const items=[['lv-jr','🚆','JR 運行情報'],air,['lv-road','🛣️','道路路況'],['lv-jma','⚠️','天氣警報']];
  if(flight)items.unshift(items.splice(1,1)[0]);
  const btns=items.map(([id,ic,label])=>{const x=by(id);return x&&x.url?`<a class="tp-live-btn${flight&&id===air[0]?' hot':''}" href="${escAttr(x.url)}" target="_blank" rel="noopener"><span>${ic}</span>${escHtml(label)}</a>`:'';}).join('');
  return btns?`<div class="tp-live"><small>出門前先看：</small><div class="tp-live-grid">${btns}</div></div>`:'';
}
function icImg(name,cls='ic-img'){return `<img class="${cls}" src="${NAV_IC[name]}" alt="" width="28" height="28" decoding="async">`;}

/* ---------- 標頭控制 ---------- */
function currentUiMode(){return document.body.classList.contains('mode-edit')?'edit':'travel';}
/* hk11：按鈕寫「按了會做什麼」；進入編輯模式先確認一次，避免長輩誤觸後看到一堆刪除鈕 */
function toggleUiMode(){
  if(currentUiMode()==='edit'){setUiMode('travel');return;}
  let asked=false;try{asked=sessionStorage.getItem('nagano_edit_confirmed')==='1';}catch(e){}
  if(!asked&&!confirm('要進入「編輯模式」嗎？\n\n編輯模式可以修改、新增、刪除行程內容。\n只想看行程的話，請按「取消」。'))return;
  try{sessionStorage.setItem('nagano_edit_confirmed','1');}catch(e){}
  setUiMode('edit');
}
function toggleTextSize(){setTextSize(document.body.classList.contains('large-text')?0:1);}
function syncHeaderControls(){
  const m=document.getElementById('modeBtn');
  if(m){const e=currentUiMode()==='edit';m.innerHTML=e?'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>':'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.2-1 10.4-10.4a2 2 0 0 0 0-2.8l-.4-.4a2 2 0 0 0-2.8 0L5 15.8 4 20z"/><path d="M13.5 7.5l3 3"/></svg>';m.classList.toggle('edit',e);m.title=e?'改完了，回到只看行程的旅行模式':'進入編輯模式，可以修改行程';m.setAttribute('aria-label',m.title);}
  const t=document.getElementById('sizeBtn');
  if(t){const big=document.body.classList.contains('large-text');t.textContent='Aa';t.classList.toggle('on',big);t.setAttribute('aria-label',big?'把字縮回標準大小':'把字放大');}
  let bar=document.getElementById('editModeBar');
  if(!bar&&document.querySelector('.app')){bar=document.createElement('div');bar.id='editModeBar';bar.className='edit-mode-bar';bar.innerHTML='<span>✎ 編輯模式中：可以修改、新增、刪除</span><button type="button" onclick="setUiMode(\'travel\')">完成編輯</button>';document.querySelector('.app').prepend(bar);}
}
document.addEventListener('DOMContentLoaded',syncHeaderControls);

/* ---------- 收藏面板（右上角 ★） ---------- */
function renderMarksBar(){
  const b=document.getElementById('favBadge');if(!b)return;
  const n=marksCounts().fav;
  b.textContent=n>99?'99+':String(n);b.style.display=n?'':'none';
}
function openMarksPanel(filter){
  filter=filter||'fav';
  const names={fav:'★ 收藏',todo:'🔖 待訂',booked:'✅ 已訂',remind:'⏰ 提醒'};
  const t=markTargets(),c=marksCounts();
  const rows=Object.entries(marksStore).filter(([k,m])=>t.has(k)&&(filter==='fav'?m.fav:filter==='todo'?m.status==='todo':filter==='booked'?(m.status==='booked'||m.status==='paid'):m.remind)).map(([k,m])=>({k,m,t:t.get(k)}));
  rows.sort((a,b)=>(a.t.dayIdx??99)-(b.t.dayIdx??99));
  closeFormModal(true);
  const wrap=document.createElement('div');wrap.className='spot-edit-modal active';wrap.id='formModal';
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeFormModal();});
  const tabs=Object.keys(names).map(f=>`<button type="button" class="mk-tab ${f===filter?'on':''}" data-tab="${f}">${names[f]} <b>${c[f]}</b></button>`).join('');
  const body=rows.length?rows.map(({k,m,t:x})=>`<div class="snap-row"><div><strong>${escHtml(x.name)}</strong><small>${x.dayIdx!=null?`D${days[x.dayIdx].dayNum}・${days[x.dayIdx].date}`:(x.kind==='eat'?'吃·旅途 我的收藏':'逛·旅途 我的收藏')}</small>${statusChipHTML(k)}${m.info?`<small>${escHtml(m.info)}</small>`:''}${m.remind?`<small>⏰ ${m.remindDate?escHtml(m.remindDate)+' ':''}${escHtml(m.remind)}</small>`:''}</div><button type="button" data-go="${escAttr(k)}">前往</button></div>`).join(''):`<div class="empty-art"><img src="images/bird-cookie.webp" alt="" loading="lazy"><p>目前沒有項目。<br>在景點或餐廳卡片點 ☆ 收藏，<br>或在編輯模式設定預約／提醒。</p></div>`;
  wrap.innerHTML=`<div class="spot-edit-modal-card"><div class="spot-edit-modal-head"><h3>收藏與預約</h3><button class="spot-edit-modal-close" type="button" data-close>✕</button></div><div class="mk-tabs">${tabs}</div><div class="spot-edit-modal-body">${body}</div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]').onclick=()=>closeFormModal();
  wrap.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>openMarksPanel(b.dataset.tab));
  wrap.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.go,x=t.get(k);closeFormModal(true);
    if(!x)return;
    if(x.dayIdx!=null)jumpToSearchResult(x.dayIdx,k,x.listType);
    else{setTab('itinerary');setActiveDay(x.kind);}
  });
}

/* ---------- 封面圖、蒐集景點、畫廊卡片 ---------- */
/* (v54 已改寫) */
function collectSpots(filterFn){
  const out=[];
  days.forEach((day,dayIdx)=>{
    if(!inPlan(dayIdx))return;
    const add=(spot,key)=>{
      const di=(typeof spotDayOf==='function'?spotDayOf(key):null)??dayIdx;
      if((hiddenFixedSpotsStore[di]||[]).includes(key)||!filterFn(spot,di,key))return;
      const name=currentFieldValue(key,'name',spot.name)||spot.name;
      out.push({dayIdx:di,key,cat:spot.cat,name,desc:currentFieldValue(key,'desc',spot.desc)||spot.desc||'',hours:currentFieldValue(key,'hours',spot.hours)||'',tags:spot.tags||[],nav:currentFieldValue(key,'mapQuery',null)||name,img:spotCoverFor(key,spot)});
    };
    (day.spots||[]).forEach((s,i)=>{if(!s.removed)add(s,`d${dayIdx}-m${i}`);});
    (day.moreSpots||[]).forEach((s,i)=>add(s,`d${dayIdx}-s${i}`));
    (customSpotsStore[dayIdx]||[]).forEach((s,i)=>{if(!s.deleted)add(s,`d${dayIdx}-c${i}`);});
  });
  return out;
}
/* (v51 已改寫) */
/* (v51 已改寫) */
/* (v56 已改寫) */

/* ---------- 吃·旅途／逛·旅途（畫廊） ---------- */
/* (v51 已改寫) */

/* ---------- 每日「天氣／交通／路線圖／逛吃」 ---------- */
function weatherEntryFor(k){return liveWeatherCache[k]||loadWeatherCache()[k]||null;}
/* (v51 已改寫) */
async function refreshDayWeather(){
  if(!navigator.onLine){alert('目前離線，無法更新。');return;}
  const cities=DAY_CITIES[activeDay]||['Nagano'];
  try{await Promise.all(cities.map(k=>fetchWeatherFor(k,0)));}catch(e){}
  if(typeof activeDay==='number')renderDayContent();
}
/* (v52 已改寫) */
/* (v51 已改寫) */
/* (v51 已改寫) */
function applySpotsView(container,view){
  container.querySelectorAll('.spots-seg button').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  container.querySelectorAll('.spots-pane').forEach(p=>p.classList.toggle('active',p.dataset.view===view));
}
function setSpotsView(dayIdx,view){
  activeSubTabStore[dayIdx]=view==='life'?'more':'main';
  const c=document.getElementById(`day-card-${dayIdx}`);if(c)applySpotsView(c,view);
}
function switchSubTab(dayIdx,tabType){
  const isTool=['weather','transport','routemap','eat'].includes(tabType);
  activeSubTabStore[dayIdx]=isTool?tabType:(tabType==='more'?'more':'main');
  if(activeDay===dayIdx)renderDayTools();
  const container=document.getElementById(`day-card-${dayIdx}`);
  if(!container)return;
  const showing=isTool?tabType:'spots';
  container.querySelectorAll('.subtab-content').forEach(c=>c.classList.toggle('active',c.dataset.type===showing));
  if(tabType==='weather'||tabType==='eat'){
    const panel=container.querySelector(`.subtab-content[data-type="${tabType}"]`);
    if(panel)panel.innerHTML=tabType==='weather'?dayWeatherPanelHTML(dayIdx):dayEatPanelHTML(dayIdx);
  }
  if(tabType==='weather'){
    const cities=DAY_CITIES[dayIdx]||['Nagano'];
    if(navigator.onLine&&cities.some(k=>!(liveWeatherCache[k]&&liveWeatherCache[k].data))){Promise.all(cities.map(k=>fetchWeatherFor(k,0))).then(()=>{if(activeDay===dayIdx&&activeSubTabStore[dayIdx]==='weather')renderDayContent();}).catch(()=>{});}
  }
  if(!isTool)applySpotsView(container,tabType==='more'?'life':'main');
}

/* ---------- MaMa 專頁（可貼上整篇部落格文章） ---------- */
let mamaStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_mama'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistMama(){safeSetItem('nagano_mama',mamaStore);}
function mamaCount(key){return (mamaStore[key]||[]).length;}
/* (v51 已改寫) */
function linkifyText(t){return escHtml(t).replace(/(https?:\/\/[^\s<>"']+)/g,u=>`<a href="${u}" target="_blank" rel="noopener">${u}</a>`);}
function mamaTitle(text){const first=String(text||'').split('\n').find(l=>l.trim())||'（空白）';return first.trim().slice(0,48);}
const mamaUI={key:null,editing:null,open:new Set()};
/* (v56 已改寫) */
function closeMama(silent){
  const w=document.getElementById('mamaModal');if(w)w.remove();
  document.body.classList.remove('mama-open');mamaUI.key=null;
  if(!silent){refreshMamaButtons(null);if(typeof flushPendingDayRender==='function')flushPendingDayRender();}
}
/* (v51 已改寫) */
/* (v56 已改寫) */
/* (v56 已改寫) */
function deleteMamaEntry(id){
  if(!confirm('確定刪除這則筆記？（5 秒內可復原）'))return;
  const key=mamaUI.key,arr=mamaStore[key]||[],i=arr.findIndex(x=>x.id===id);if(i<0)return;
  const removed=arr.splice(i,1)[0];if(!arr.length)delete mamaStore[key];
  persistMama();renderMamaList();refreshMamaButtons(key);
  offerUndo('已刪除筆記',()=>{(mamaStore[key]=mamaStore[key]||[]).splice(Math.min(i,(mamaStore[key]||[]).length),0,removed);persistMama();if(mamaUI.key===key)renderMamaList();refreshMamaButtons(key);});
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('mamaModal'))closeMama();});

/* ---------- 工具面板（備份、版本、安裝成 App） ---------- */
let deferredInstall=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;});
window.addEventListener('appinstalled',()=>{deferredInstall=null;});
function isStandalone(){return !!((window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone);}
function closeToolsSheet(){document.getElementById('toolsSheet')?.remove();}
function openToolsSheet(){
  closeToolsSheet();
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const install=isStandalone()?'<p class="sheet-note">✅ 已用 App 模式開啟。</p>':(deferredInstall?'<button type="button" class="sheet-btn primary" data-act="install">📲 安裝到主畫面</button>':(ios?'<p class="sheet-note">iPhone／iPad：用 <b>Safari</b> 開啟 → 點下方「分享」→「加入主畫面」。</p>':'<p class="sheet-note">用 Chrome 開啟 → 右上角選單 →「安裝應用程式」或「加到主畫面」。</p>'));
  const wrap=document.createElement('div');wrap.id='toolsSheet';wrap.className='sheet-wrap';
  wrap.innerHTML=`<div class="sheet" role="dialog" aria-label="工具與設定"><div class="sheet-grab"></div><div class="sheet-head"><b>⚙️ 工具與設定</b><button type="button" data-close aria-label="關閉">✕</button></div><div class="sheet-body">
    ${CLOUD_CONFIGURED?`<section><h4>👤 帳號</h4><p class="sheet-note">目前登入：<b>${escHtml(myEmail()||'沒有登入')}</b></p><div class="sheet-row one"><button type="button" data-act="logout">登出／換帳號</button></div></section>`:''}
    <section><h4>📲 安裝成 App</h4>${install}</section>
    <section><h4>離線使用</h4><p class="sheet-note" id="offlineStatusRow">檢查中…</p><div class="sheet-row one"><button type="button" data-act="precache">下載全部圖片到這台裝置</button></div><p class="sheet-note" style="margin-top:6px">網頁本身與你的資料會自動保留；圖片需要下載一次，之後沒網路也能看。</p></section>
    <section><h4>小驚喜</h4><div class="sheet-row one"><button type="button" data-act="surprise">來一則小知識／笑話</button></div></section>
    <section><h4>🛟 備份與還原</h4><div class="sheet-row"><button type="button" data-act="backup">⬇️ 下載備份</button><button type="button" data-act="restore">⬆️ 還原</button><button type="button" data-act="snap">🕘 快照</button></div></section>
    <section><h4>📱 版本與同步</h4><div id="deviceStatusBody" class="ds-body"></div><div class="sheet-row"><button type="button" data-act="sync">🔄 同步</button><button type="button" data-act="diag">🔍 比對雲端</button><button type="button" data-act="force">⬇️ 強制更新</button></div></section>
  </div></div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeToolsSheet();});
  wrap.querySelector('[data-close]').onclick=closeToolsSheet;
  const acts={
    install:async()=>{if(!deferredInstall)return;deferredInstall.prompt();try{await deferredInstall.userChoice;}catch(e){}deferredInstall=null;closeToolsSheet();},
    backup:()=>downloadBackup(),
    restore:()=>{closeToolsSheet();document.getElementById('restoreFile').click();},
    snap:()=>{closeToolsSheet();showSnapshots();},
    sync:()=>syncNowManual(),
    diag:()=>{closeToolsSheet();diagnoseCloud();},
    precache:()=>startOfflinePrecache(true),
    logout:()=>{closeToolsSheet();logoutFamily();},
    surprise:()=>{closeToolsSheet();showSurprise();},
    force:()=>{closeToolsSheet();forceRefreshApp();}
  };
  wrap.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>acts[b.dataset.act]&&acts[b.dataset.act]());
  renderDeviceStatus();updateOfflineRow();
}

/* =====================================================================
   v51：吃逛依區域、小驚喜、日出日落、MaMa 按鈕整合
   ===================================================================== */

/* ---------- 每日工具列：行程／天氣／交通／路線圖／逛吃 ---------- */
let lastNumericDay=0;
function renderDayTools(){
  const el=document.getElementById('dayTools');if(!el)return;
  if(typeof activeDay==='number')lastNumericDay=activeDay;
  const numeric=typeof activeDay==='number';
  const cur=numeric?(activeSubTabStore[activeDay]||'main'):'';
  const tools=[['itinerary','行程'],['weather','天氣'],['transport','交通'],['routemap','路線圖'],['eat','逛吃']];
  const isOn=t=>t==='itinerary'?(numeric&&(cur==='main'||cur==='more')):(t==='eat'&&!numeric)?true:cur===t;
  el.innerHTML=tools.map(([t,l])=>`<button type="button" class="day-tool t-${t}${isOn(t)?' active':''}" data-type="${t}" aria-pressed="${isOn(t)}" onclick="goDayTool('${t}')">${l}</button>`).join('');
}
function goDayTool(t){
  setTab('itinerary');
  if(typeof activeDay!=='number'){activeDay=lastNumericDay;renderDayChips();renderDayContent();}
  if(t==='itinerary'){switchSubTab(activeDay,'main');const h=document.getElementById('dayScroll');if(h)h.scrollIntoView({behavior:'smooth',block:'start'});return;}
  const cur=activeSubTabStore[activeDay]||'main';
  switchSubTab(activeDay,cur===t?'main':t);
}
function toggleDayTool(t){goDayTool(t);}

/* ---------- MaMa 按鈕（放在導航等按鈕同一區，帶線條圖示） ---------- */
const MAMA_SVG='<svg class="mama-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 9h6M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
function mamaInner(n){return `${MAMA_SVG}<span>MaMa</span>${n?`<b>${n}</b>`:''}`;}
function mamaBtnHTML(key,variant){
  const n=mamaCount(key);
  return `<button type="button" class="btn btn-mama${variant==='wide'?' wide':''}" data-mama="${escAttr(key)}" onclick="event.stopPropagation();openMama('${jsQuote(key)}')">${mamaInner(n)}</button>`;
}
function refreshMamaButtons(key){
  document.querySelectorAll('.btn-mama').forEach(b=>{if(key&&b.dataset.mama!==String(key))return;b.innerHTML=mamaInner(mamaCount(b.dataset.mama));});
}
function markLabel(key){
  const t=markTargets().get(key);if(t)return t.name;
  let m=String(key).match(/^day(\d+)$/);if(m&&days[Number(m[1])])return `D${days[Number(m[1])].dayNum}・${days[Number(m[1])].date} 其他筆記`;
  m=String(key).match(/^list-(eat|shop)$/);if(m)return m[1]==='eat'?'吃·旅途 其他筆記':'逛·旅途 其他筆記';
  return key;
}

/* ---------- 吃·逛旅途：依區域分組 ---------- */
const EAT_AREAS=['高崎・藤岡','長野・小布施','黑姬・妙高','山田溫泉','戶隱','橫濱'];
let eatAreaCustom=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_eat_area_custom'));return Array.isArray(v)?v:[];}catch(e){return [];}})();
function persistEatAreaCustom(){safeSetItem('nagano_eat_area_custom',eatAreaCustom);}
/* v76：區域順序可以自己調整（編輯模式的 ▲▼），同步給家人 */
var eatAreaOrder=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_eat_area_order'));return Array.isArray(v)?v:[];}catch(e){return [];}})();
function persistEatAreaOrder(){safeSetItem('nagano_eat_area_order',eatAreaOrder);}
function allEatAreas(){
  const base=[...EAT_AREAS,...eatAreaCustom.filter(x=>!EAT_AREAS.includes(x))];
  const ord=(eatAreaOrder||[]).filter(a=>base.includes(a));
  return [...new Set([...ord,...base])];
}
function moveEatArea(name,dir){
  const list=allEatAreas(),i=list.indexOf(name),j=i+dir;
  if(i<0||j<0||j>=list.length)return;
  [list[i],list[j]]=[list[j],list[i]];
  eatAreaOrder=list;persistEatAreaOrder();safeRenderDayContent();
  setTimeout(()=>{const el=[...document.querySelectorAll('.eatshop-group h3 span')].find(x=>x.textContent===name);el?.closest('.eatshop-group')?.scrollIntoView({behavior:'smooth',block:'center'});},60);
}
/* hk11 */
function isCustomArea(a){return !EAT_AREAS.includes(a);}
const AREA_ORIGIN={'高崎・藤岡':'高崎駅','長野・小布施':'長野駅','黑姬・妙高':'Lomä 信濃町','山田溫泉':'緑霞山宿 藤井荘','戶隱':'戸隠神社 中社','橫濱':'横浜駅'};
const EAT_DAY_AREA={0:'高崎・藤岡',1:'高崎・藤岡',2:'高崎・藤岡',3:'長野・小布施',4:'黑姬・妙高',5:'戶隱',6:'長野・小布施',7:'長野・小布施',8:'山田溫泉',9:'長野・小布施',10:'戶隱',11:'橫濱',12:'橫濱',13:'橫濱'};
const EAT_NAME_AREA={};
let eatAreaStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_eat_area'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistEatArea(){safeSetItem('nagano_eat_area',eatAreaStore);}
function eatAreaFor(o){
  const ov=eatAreaStore[o.key];
  if(ov==='none')return null;
  if(ov&&allEatAreas().includes(ov))return ov;
  const sp=typeof spotByKey==='function'?spotByKey(o.key):null;
  return (sp&&sp.eatArea)||EAT_NAME_AREA[o.name]||EAT_DAY_AREA[o.dayIdx]||null;
}
function stayGroups(){return allEatAreas().map(a=>({label:a,nav:AREA_ORIGIN[a]||a,dayIdxs:[]}));}
function collectEatShop(kind){
  const cat=kind==='eat'?'food':'shopping';
  return collectSpots(s=>s.cat===cat).map(o=>({...o,area:eatAreaFor(o)})).filter(o=>o.area);
}
function editEatArea(key){
  const all=collectSpots(()=>true).find(o=>o.key===key);
  const cur=eatAreaStore[key]||(all?(eatAreaFor(all)||'none'):'none');
  openFormModal({title:'調整區域：'+(all?all.name:key),fields:[{id:'area',label:'放在哪個區域',type:'select',value:cur,options:[...allEatAreas().map(a=>({value:a,label:a})),{value:'none',label:'（不列入吃逛旅途）'}]}],
    onSave:v=>{
      const had=Object.prototype.hasOwnProperty.call(eatAreaStore,key),prev=eatAreaStore[key];
      eatAreaStore[key]=v.area;persistEatArea();safeRenderDayContent();
      if(v.area==='none')offerUndo(`已把「${all?all.name:key}」移出吃逛旅途（可在頁面最下方「已移出的店家」加回）`,()=>{if(had)eatAreaStore[key]=prev;else delete eatAreaStore[key];persistEatArea();safeRenderDayContent();});
    }});
}
/* hk15（移植京丹雅行 v84）：被設成「不列入吃逛旅途」的店家，可以再加回來 */
function removedEatShop(kind){
  const cat=kind==='eat'?'food':'shopping';
  return collectSpots(s=>s.cat===cat).filter(o=>eatAreaStore[o.key]==='none');
}
function restoreEatShopItem(key){
  const o=collectSpots(()=>true).find(x=>x.key===key);if(!o)return;
  const sp=spotByKey(key);
  const natural=(sp&&sp.eatArea)||EAT_NAME_AREA[o.name]||EAT_DAY_AREA[o.dayIdx]||null;
  if(natural){
    delete eatAreaStore[key];persistEatArea();safeRenderDayContent();
    offerUndo(`已把「${o.name}」加回 ${natural}`,()=>{eatAreaStore[key]='none';persistEatArea();safeRenderDayContent();});
  }else{
    openFormModal({title:'加回吃逛旅途：'+o.name,fields:[{id:'area',label:'放在哪個區域',type:'select',value:allEatAreas()[0],options:allEatAreas().map(a=>({value:a,label:a}))}],saveText:'加回',
      onSave:v=>{eatAreaStore[key]=v.area;persistEatArea();safeRenderDayContent();showToast(`已把「${o.name}」加回 ${v.area}`);}});
  }
}
function removedEatShopHTML(kind){
  const list=removedEatShop(kind);if(!list.length)return '';
  return `<details class="eatshop-removed"><summary>已移出${kind==='eat'?'吃':'逛'}·旅途的店家（${list.length}）<em>點開可加回</em></summary>${list.map(o=>`<div class="er-row"><div><b>${escHtml(o.name)}</b><small>原本在 D${days[o.dayIdx].dayNum}・${days[o.dayIdx].date}</small></div><button type="button" onclick="restoreEatShopItem('${jsQuote(o.key)}')">加回</button></div>`).join('')}</details>`;
}
/* (v52 已改寫) */
/* (v52 已改寫) */

/* ---------- 日出日落（依日期天文計算，離線也能用） ---------- */
function sunTimes(lat,lon,y,m,d){
  const rad=Math.PI/180,deg=180/Math.PI;
  const jd0=Date.UTC(y,m-1,d,12)/86400000+2440587.5;             /* 當日 UTC 正午的儒略日 */
  const n=Math.ceil(jd0-2451545.0+0.0008);
  const Js=n-lon/360;
  const M=(357.5291+0.98560028*Js)%360;
  const C=1.9148*Math.sin(M*rad)+0.02*Math.sin(2*M*rad)+0.0003*Math.sin(3*M*rad);
  const lam=(M+C+180+102.9372)%360;
  const Jt=2451545.0+Js+0.0053*Math.sin(M*rad)-0.0069*Math.sin(2*lam*rad);
  const sd=Math.sin(lam*rad)*Math.sin(23.4397*rad),cd=Math.cos(Math.asin(sd));
  const cw=(Math.sin(-0.833*rad)-Math.sin(lat*rad)*sd)/(Math.cos(lat*rad)*cd);
  if(cw>1||cw<-1)return null;
  const w0=Math.acos(cw)*deg;
  const fmt=J=>{const ms=(J-2440587.5)*86400000+9*3600000;const t=new Date(ms);const p=x=>String(x).padStart(2,'0');return p(t.getUTCHours())+':'+p(t.getUTCMinutes());};
  return {rise:fmt(Jt-w0/360),set:fmt(Jt+w0/360)};
}
function daySunText(dayIdx,cityKey){
  const c=CITIES[cityKey],dd=(days[dayIdx].date||'').split('/');
  if(!c||dd.length<2)return '';
  const r=sunTimes(c.lat,c.lon,2027,Number(dd[0]),Number(dd[1]));
  return r?`日出 ${r.rise}　日落 ${r.set}`:'';
}
function dayWeatherPanelHTML(i){
  const d=days[i],cities=DAY_CITIES[i]||['Nagano'];
  const cards=cities.map(k=>{
    const e=weatherEntryFor(k),cw=e&&e.data&&e.data.current;
    const sun=daySunText(i,k)||'';
    const sm=sun.match(/日出\s*(\d{1,2}:\d{2}).*日落\s*(\d{1,2}:\d{2})/);
    const sunRow=sm?`<div class="dw-sun2"><span>☀︎ 日出 ${sm[1]}</span><span>☾ 日落 ${sm[2]}</span></div>`:(sun?`<div class="dw-sun2"><span>${escHtml(sun)}</span></div>`:'');
    const tenki=`<a class="dw-tenki2" href="${escAttr(TENKI_LINKS[k]||'https://tenki.jp/')}" target="_blank" rel="noopener">tenki.jp 預報 ↗</a>`;
    if(!cw)return `<div class="dw-card2 is-empty"><div class="dw-place2">${escHtml(CITIES[k].label)}</div><div class="dw-main2"><span class="dw-ico2">${wxImgHTML(2,0,'wx-img dim')}</span><b class="dw-na">—</b></div><div class="dw-desc2">尚未取得即時氣象</div>${sunRow}${tenki}</div>`;
    const [ico,desc]=wmoInfo(cw.weather_code),temp=Math.round(cw.temperature_2m);
    const tone=temp<=-5?'t-deep':temp<=0?'t-cold':temp<=8?'t-cool':'t-mild';
    const when=e.fetchedAt?new Date(e.fetchedAt).toLocaleString('zh-TW',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    return `<div class="dw-card2 ${tone}"><div class="dw-place2">${escHtml(CITIES[k].label)}${e.stale?'<em>快取</em>':''}</div><div class="dw-main2"><span class="dw-ico2">${wxImgHTML(cw.weather_code,cw.wind_speed_10m)}</span><b>${temp}°</b></div><div class="dw-desc2">${desc}${cw.apparent_temperature!=null?`・<b class="dw-feels">體感 ${Math.round(cw.apparent_temperature)}°</b>`:''}</div><div class="dw-metrics2"><span>💨 ${cw.wind_speed_10m} km/h</span><span>${cw.snowfall?`❄ ${cw.snowfall} cm`:`☔ ${cw.precipitation} mm`}</span></div>${snowLineHTML(k)}${sunRow}${when?`<small class="dw-when2">更新 ${when}</small>`:''}${tenki}</div>`;
  }).join('');
  return `<div class="day-panel dw2"><div class="dw2-head"><div><small>${d.date}（${d.weekday}）</small><strong>今日天氣與穿搭</strong></div><img src="images/nav-weather.webp" alt="" width="64" height="64"></div><div class="dw2-wear"><span class="dw2-wear-ic">🧣</span><div><small>建議穿搭</small><span>${escHtml(d.wear||'')}</span></div></div><div class="dw2-grid${cities.length>1?' two':''}">${cards}</div><button type="button" class="dp-btn" onclick="refreshDayWeather()">更新即時氣象</button><p class="dp-note">日出日落依 ${d.date} 計算；氣溫是「現在」的天氣，出發前 2–3 天再看 tenki.jp 預報。</p><button type="button" class="dp-link" onclick="setTab('weather')">看完整天氣與雨雲圖 ›</button></div>`;
}

/* ---------- 小驚喜（點角落的小動物：小知識、笑話、旅程照片；同帳號盡量不重複） ---------- */
const SURPRISE_SEED=[
  {id:'sd-t01',type:'tip',text:'日本鬣羚（カモシカ）是日本的特別天然紀念物，也是長野縣的縣獸。牠其實是牛科，不是鹿喔。'},
  {id:'sd-t02',type:'tip',text:'高崎是達摩不倒翁的主要產地，一般說法是全國約八成的達摩來自高崎。'},
  {id:'sd-t03',type:'tip',text:'許願時先替達摩畫上一隻眼睛，願望實現後再畫另一隻。'},
  {id:'sd-t04',type:'tip',text:'妙高山海拔 2,454 公尺，因為山形端正，被稱作「越後富士」。'},
  {id:'sd-t05',type:'tip',text:'野尻湖曾經挖出諾曼象（ナウマンゾウ）的化石，湖畔有專門的博物館。'},
  {id:'sd-t06',type:'tip',text:'戶隱神社由奧社、中社、寶光社、九頭龍社、火之御子社五社組成。'},
  {id:'sd-t07',type:'tip',text:'戶隱奧社參道的杉木並木，樹齡據說約 400 年。'},
  {id:'sd-t08',type:'tip',text:'戶隱蕎麥常用「ぼっち盛り」，一小束一小束擺在竹篩上。'},
  {id:'sd-t09',type:'tip',text:'葛飾北齋晚年曾多次到小布施，北齋館收藏他的肉筆畫與祭屋台天井畫。'},
  {id:'sd-t10',type:'tip',text:'善光寺不屬於單一宗派，自古接納各宗派的參拜者。'},
  {id:'sd-t11',type:'tip',text:'藤岡市的市花就是紫藤。'},
  {id:'sd-t12',type:'tip',text:'橫濱紅磚倉庫原本是港口的保稅倉庫，建於明治末到大正初年。'},
  {id:'sd-j01',type:'joke',text:'小羚羊為什麼不怕爬坡？因為牠的腿天生就是登山鞋。'},
  {id:'sd-j02',type:'joke',text:'達摩為什麼總是一隻眼睛？因為牠還在等你的願望實現。'},
  {id:'sd-j03',type:'joke',text:'行李箱最怕聽到什麼？「你怎麼回程又變重了？」（栗子甜點表示：不是我。）'},
  {id:'sd-j04',type:'joke',text:'紫藤為什麼都往下長？因為它想跟每一個抬頭的人打招呼。'},
  {id:'sd-w01',type:'tip',text:'走累了就找間咖啡館坐一下，山不會跑，花也會等你。'},
  {id:'sd-k01',type:'joke',text:'我不是山羊，是羚羊。差在我比較會擺姿勢。'},
  {id:'sd-k02',type:'joke',text:'我的角很短，因為長太長會勾到紫藤。'},
  {id:'sd-k03',type:'joke',text:'今天的步數，請把去買栗子甜點的那段算成勇敢。'},
  {id:'sd-k04',type:'joke',text:'我的導航只有兩個目的地：好吃的，和好看的。'},
  {id:'sd-k05',type:'joke',text:'紫藤垂下來的時候，我都會低頭讓它先過。'},
  {id:'sd-k06',type:'joke',text:'背包裡有地圖、零食，和一點點想再住一晚的心。'},
  {id:'sd-k07',type:'joke',text:'我在山裡長大，所以看到樓梯不會怕，看到排隊會。'},
  {id:'sd-k08',type:'joke',text:'蕎麥麵一束一束擺好，我一口一口吃好。'},
  {id:'sd-k09',type:'joke',text:'達摩說要先畫一隻眼睛許願，我說要先吃午餐。'},
  {id:'sd-k10',type:'joke',text:'我的毛很蓬，不是胖，是山上的春天還有點冷。'},
  {id:'sd-k11',type:'joke',text:'在杉木步道上，我覺得自己很小，胃口還是很大。'},
  {id:'sd-k12',type:'joke',text:'湖面很安靜，我也放輕腳步，怕吵醒山的倒影。'},
  {id:'sd-k13',type:'joke',text:'泡湯是你們的行程，發呆是我的專長。'},
  {id:'sd-k14',type:'joke',text:'今天沒有出發時間，所以我一直出發去冰箱。'},
  {id:'sd-k15',type:'joke',text:'栗子的殼很硬，栗子甜點很溫柔。'},
  {id:'sd-k16',type:'joke',text:'我把地圖打開了，結果先找到咖啡店。'},
  {id:'sd-k17',type:'joke',text:'如果行程趕不上，就先趕上自己的好心情。'},
  {id:'sd-k18',type:'joke',text:'今天沒有迷路，只是在收集沒有排進去的風景。'},
  {id:'sd-k19',type:'joke',text:'出門前看天氣，出門後看甜點。'},
  {id:'sd-k20',type:'joke',text:'黃金週人很多，我負責站在角落，看起來很悠閒。'},
  {id:'sd-k21',type:'joke',text:'新幹線很快，我的午睡更快。'},
  {id:'sd-k22',type:'joke',text:'在 Outlet 我沒有購物清單，只有購物的勇氣。'},
  {id:'sd-k23',type:'joke',text:'伴手禮的本質，是把旅行再吃一次。'},
  {id:'sd-k24',type:'joke',text:'那不是發呆，是我在替下一個景點留白。'},
  {id:'sd-k25',type:'joke',text:'我把疲勞寄放在旅館，出門只帶胃口。'},
  {id:'sd-k26',type:'joke',text:'如果咖啡店是景點，我今天完成了很多文化參訪。'},
  {id:'sd-k27',type:'joke',text:'我不是一直出現，我是在不同角落值班。'},
  {id:'sd-k28',type:'joke',text:'點我一下，我就把今天的小心事交給你。'},
  {id:'sd-k29',type:'joke',text:'下雨就少排一點，風景不會因為你休息而生氣。'},
  {id:'sd-k30',type:'joke',text:'你在等車，我在等你把剛才那張照片拍給我看。'},
  {id:'sd-k31',type:'joke',text:'拍風景時，我負責融入背景，你負責找到我。'},
  {id:'sd-k32',type:'joke',text:'小小的背包，裝不下整座山，卻裝得下今天的快樂。'},
  {id:'sd-k33',type:'joke',text:'山路慢慢開，我會在下一個彎等你。'},
  {id:'sd-k34',type:'joke',text:'今天的幸運物是外套，因為山上早晚還很涼。'},
  {id:'sd-k35',type:'joke',text:'港邊的風很大，我的瀏海直接變成全身。'},
  {id:'sd-k36',type:'joke',text:'旅行結束後，最重的行李通常叫作捨不得。'},
  {id:'sd-k37',type:'joke',text:'我研究過了，旅館的榻榻米最適合研究午睡。'},
  {id:'sd-k38',type:'joke',text:'看到美食先拍照，是我對它最後的禮貌。'}
];
let surprisesData=[];
let tipsSeen=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_tips_seen'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function initSurprises(){
  let stored=null;try{stored=JSON.parse(localStorage.getItem('nagano_surprises'));}catch(e){}
  surprisesData=Array.isArray(stored)?normalizeStructuredList('nagano_surprises',stored):structuredClone(SURPRISE_SEED);
  renderSurpriseAdmin();
}
function persistSurprises(){safeSetItem('nagano_surprises',surprisesData);}
function hash36(str){let h=5381;for(let i=0;i<str.length;i++)h=((h<<5)+h+str.charCodeAt(i))|0;return (h>>>0).toString(36);}
function accountKey(){
  let email='';
  try{email=(typeof familyAuthSession!=='undefined'&&familyAuthSession&&familyAuthSession.email)||(readAuthSession()&&readAuthSession().email)||'';}catch(e){}
  return 'a'+hash36(String(email||'guest').toLowerCase());
}
/* (v54 已改寫) */
const SURPRISE_LABEL={tip:'小知識',joke:'小羚羊碎碎念',care:'小羚羊叮嚀',photo:'旅程照片'};
function closeSurprise(){document.getElementById('surpriseCard')?.remove();}
/* (v54 已改寫) */
/* 內容庫管理（指南頁，只在編輯模式出現） */
function renderSurpriseAdmin(){
  const wrap=document.getElementById('surpriseAdminWrap');if(!wrap)return;
  wrap.innerHTML=`<div class="sa-list">${surprisesData.map(x=>`<div class="sa-row"><span class="sa-tag ${x.type}">${SURPRISE_LABEL[x.type]||x.type}</span><div class="sa-text">${x.img?`<img src="${escAttr(x.img)}" alt="">`:''}<span>${escHtml(x.text||'（照片）')}</span></div><div class="sa-btns"><button type="button" onclick="editSurprise('${x.id}')">修改</button><button type="button" class="del" onclick="deleteSurprise('${x.id}')">刪除</button></div></div>`).join('')||'<div class="empty compact">還沒有內容。</div>'}</div><div class="tc-add-row"><button type="button" onclick="addSurprise()">＋ 新增小驚喜</button><button type="button" onclick="showSurprise()">預覽一則</button><button type="button" onclick="restoreSurprises()">還原預設內容</button></div>`;
}
/* (v54 已改寫) */
async function saveSurpriseFromForm(target,v,isNew){
  if(!v.text&&!v.file&&!target.img){alert('請輸入文字或選擇照片');return false;}
  if(v.type==='photo'&&!v.file&&!target.img){alert('「旅程照片」類型需要選一張照片');return false;}
  try{
    if(v.file){updateSyncStatus(null,'saving');target.img=await uploadMediaFile(v.file,'surprises');}
  }catch(err){alert('⚠️ 照片上傳失敗：'+String(err.message||err));updateSyncStatus(err);return false;}
  target.type=v.type;target.text=v.text;
  if(isNew)surprisesData.push(target);
  persistSurprises();renderSurpriseAdmin();
}
function addSurprise(){const x={id:newItemId('sd'),type:'tip',text:'',img:''};openFormModal({title:'＋ 新增小驚喜',fields:surpriseFields(x),saveText:'儲存',onSave:v=>saveSurpriseFromForm(x,v,true)});}
function editSurprise(id){const x=surprisesData.find(s=>s.id===id);if(!x)return;openFormModal({title:'修改小驚喜',fields:surpriseFields(x),onSave:v=>saveSurpriseFromForm(x,v,false),onDelete:()=>deleteSurprise(id,true)});}
function deleteSurprise(id,skip){
  if(!skip&&!confirm('確定刪除？（5 秒內可復原）'))return;
  const i=surprisesData.findIndex(s=>s.id===id);if(i<0)return;
  const removed=surprisesData.splice(i,1)[0];persistSurprises();renderSurpriseAdmin();
  offerUndo('已刪除',()=>{surprisesData.splice(i,0,removed);persistSurprises();renderSurpriseAdmin();});
}
function restoreSurprises(){
  if(!confirm('要還原成內建的小知識與笑話嗎？你新增與修改的內容會被取代。'))return;
  const backup=structuredClone(surprisesData);surprisesData=structuredClone(SURPRISE_SEED);persistSurprises();renderSurpriseAdmin();
  offerUndo('已還原預設',()=>{surprisesData=backup;persistSurprises();renderSurpriseAdmin();});
}

/* ---------- 角落的小動物：不常出現，只從左下／右下角邊緣探頭，點了才有小驚喜 ---------- */
const CRITTER_IMGS=['images/serow-welcome.webp','images/serow-point.webp','images/serow-camera.webp','images/serow-peek.webp','images/serow-shop.webp'];
/* 每張角落插圖配一句不同的話，索引對齊 CRITTER_IMGS（之後加進來的插圖沿用最後一句） */
const END_NOTE_QUOTES=['今天也慢慢走，山不會跑。','累了就坐下來喝杯茶，風景會等你。','抬頭看看，紫藤正在往下長。','今天辛苦了，泡個湯早點睡。','山路慢慢開，下一個彎有好風景。','背包裡多了一點今天的喜歡。','早晚還涼，記得加件外套。','花開不開都沒關係，一起來就很好。'];
const critter={last:'',timer:null};
function reducedMotion(){return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}
function critterLayer(){let l=document.getElementById('critterLayer');if(!l){l=document.createElement('div');l.id='critterLayer';l.setAttribute('aria-hidden','true');document.body.appendChild(l);}return l;}
function critterBusy(){
  return document.hidden||reducedMotion()||document.body.classList.contains('mama-open')||document.body.classList.contains('family-locked')||!!document.getElementById('formModal')||!!document.getElementById('toolsSheet')||!!document.getElementById('surpriseCard')||!!document.getElementById('spotEditModal')?.classList.contains('active');
}
/* ng2：角落探頭用整隻小羚羊（有道具） */
const PEEK_IMGS=['wave','peek','gift','laugh','camera','tea','wisteria','guide'].map(n=>`images/sp-${n}.webp`);
function pickCritter(){let img,n=0;do{img=PEEK_IMGS[Math.floor(Math.random()*PEEK_IMGS.length)];n++;}while(img===critter.last&&n<6);critter.last=img;return img;}
function leafBurst(x,y){
  const l=critterLayer();
  for(let i=0;i<5;i++){
    const p=document.createElement('i');p.className='leaf-bit';
    p.style.left=x+'px';p.style.top=y+'px';
    p.style.setProperty('--dx',(Math.random()*120-60)+'px');p.style.setProperty('--dr',(Math.random()*540-270)+'deg');
    p.style.background=['#569983','#7256A2','#3B6A5A'][i%3];
    l.appendChild(p);setTimeout(()=>p.remove(),1700);
  }
}
function spawnPeek(){
  if(critterBusy())return false;
  const l=critterLayer();if(l.querySelector('.critter-peek'))return false;
  const side=Math.random()<.5?'left':'right';
  const el=document.createElement('div');el.className='critter-peek '+side;
  el.innerHTML=`<img src="${pickCritter()}" alt="" style="width:${62+Math.round(Math.random()*8)}px" draggable="false">`;
  el.addEventListener('click',()=>{const r=el.getBoundingClientRect();leafBurst(r.left+r.width/2,r.top+r.height/2);el.classList.add('hop');setTimeout(()=>el.classList.remove('in'),500);showSurprise();});
  l.appendChild(el);
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('in')));
  setTimeout(()=>el.classList.remove('in'),9000);
  setTimeout(()=>el.remove(),10500);
  return true;
}
/* (v54 已改寫) */   /* 之後約每 4–8 分鐘一次 */
/* (v54 已改寫) */
document.addEventListener('DOMContentLoaded',()=>{initSurprises();startCritters();});

/* =====================================================================
   v52：吃逛資料以「吃·旅途／逛·旅途」為本體、可排入某天的食衣住；
        購物清單畫廊（一品項一張卡、多圖左右滑）；天氣可收合；離線圖片下載
   ===================================================================== */
function brText(t){return escHtml(String(t==null?'':t).replace(/<br\s*\/?>/gi,'\n'));}

/* ---------- 吃逛資料本體與「排入日期」 ---------- */
let eatPlanStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_eat_plan'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistEatPlan(){safeSetItem('nagano_eat_plan',eatPlanStore);}
function eatCustomSpot(c){return S(c.name,c.kind==='shop'?'shopping':'food',c.note||'',{mapQuery:c.mapQuery||null});}
/* hk15（移植 v78）：自己新增的吃逛項目，卡片用詳情頁上傳的照片當封面，名稱／簡介以詳情頁修改後的為準 */
function esCardData(c){
  const key='es:'+c.id,spot=eatCustomSpot(c);
  const name=currentFieldValue(key,'name',c.name)||c.name;
  return {key,name,desc:currentFieldValue(key,'desc',c.note)||c.note,nav:currentFieldValue(key,'mapQuery',null)||c.mapQuery||name,img:spotCoverFor(key,spot)};
}
function spotByKey(key){
  let m=String(key).match(/^d(\d+)-([msc])(\d+)$/);
  if(m){const di=Number(m[1]),j=Number(m[3]),d=days[di];if(!d)return null;return m[2]==='m'?d.spots[j]:m[2]==='s'?(d.moreSpots||[])[j]:((x=>x&&!x.deleted?x:null)(getCustomSpots(di)[j]));}
  m=String(key).match(/^es:(.+)$/);
  if(m){const c=eatShopStore.find(x=>x.id===m[1]);return c?eatCustomSpot(c):null;}
  return null;
}
function masterKeySet(){
  const set=new Set();
  collectEatShop('eat').forEach(o=>set.add(o.key));
  collectEatShop('shop').forEach(o=>set.add(o.key));
  return set;
}
function isMasterKey(key){return masterKeySet().has(key);}
/* 這個項目排在哪一天：使用者選過就用選的；沒選過時，內建項目維持原本所屬的那天；自己新增的預設不排入 */
function planOf(key){
  const v=eatPlanStore[key];
  if(v==='none')return null;
  if(typeof v==='number'&&days[v])return v;
  const pooled=spotByKey(key); if(pooled&&pooled.pool)return null; /* 吃·旅途名單：預設不排入任何一天 */
  const m=String(key).match(/^d(\d+)-/);
  return m&&days[Number(m[1])]?Number(m[1]):null;
}
function plannedEntriesFor(dayIdx){
  const out=[];
  masterKeySet().forEach(key=>{if(planOf(key)===dayIdx){const spot=spotByKey(key);if(spot)out.push({spot,key,fixedMeta:{dayIdx,planned:true}});}});
  eatShopStore.forEach(c=>{if(planOf('es:'+c.id)===dayIdx)out.push({spot:eatCustomSpot(c),key:'es:'+c.id,fixedMeta:{dayIdx,planned:true}});});
  return out;
}
function getNaturalList(dayIdx, listType){
  const cats = listType === 'main' ? MAIN_CATS : LIFE_CATS;
  const hidden = new Set(hiddenFixedSpotsStore[dayIdx] || []);
  const master = masterKeySet();
  /* hk11：包含從別天「改日期」搬過來的景點 */
  const shown = spotsShownOnDay(dayIdx);
  const allFixed = shown.fixed.filter(o=>!hidden.has(o.key));
  const allCustom = shown.custom;
  const belongs=(o)=> listType==='life' ? (o.spot.life || cats.includes(o.spot.cat)) : (!o.spot.life && cats.includes(o.spot.cat));
  let result=allFixed.filter(belongs).concat(allCustom.filter(belongs)).filter(o=>!master.has(o.key));
  if(listType==='life'){
    result=result.concat(plannedEntriesFor(dayIdx));
    result.sort((a,b)=>(a.spot.cat==='hotel')-(b.spot.cat==='hotel'));
  }
  return result;
}
function afterPlanChange(){
  renderDayChips();renderDayContent();
  if(document.getElementById('spotDetailSheet'))renderSpotDetail(false);
}
function openPlanModal(key){
  const cur=planOf(key);
  const name=(spotByKey(key)||{}).name||key;
  openFormModal({title:'排入哪一天：'+name,fields:[{id:'day',label:'日期（排入後，會出現在該日的「食衣住」）',type:'select',value:cur==null?'':String(cur),options:[{value:'',label:'不排入行程'},...days.map((d,i)=>({value:String(i),label:`D${d.dayNum}・${d.date}（週${d.weekday}）${d.title}`})).filter(o=>inPlan(o.value))]}],
    onSave:v=>{eatPlanStore[key]=v.day===''?'none':Number(v.day);persistEatPlan();afterPlanChange();}});
}
function unplanItem(key){
  const prev=eatPlanStore[key];
  eatPlanStore[key]='none';persistEatPlan();afterPlanChange();
  offerUndo('已移出當天，資料仍保留在吃·逛旅途',()=>{if(prev===undefined)delete eatPlanStore[key];else eatPlanStore[key]=prev;persistEatPlan();afterPlanChange();});
}
function planTodayQuick(key,dayIdx){eatPlanStore[key]=dayIdx;persistEatPlan();afterPlanChange();}

/* ---------- 吃·逛旅途：畫廊卡片與詳情頁 ---------- */
/* (v56 已改寫) */
function renderEatShopView(kind){
  const isEat=kind==='eat',word=isEat?'吃':'逛';
  const items=collectEatShop(kind);
  const custom=eatShopStore.filter(x=>x.kind===kind);
  const used=new Set();
  const sections=allEatAreas().map((a,gi)=>{
    const its=items.filter(it=>it.area===a),cus=custom.filter(c=>c.area===a);
    cus.forEach(c=>used.add(c.id));
    const emptyArea=!its.length&&!cus.length;
    if(emptyArea&&!isCustomArea(a))return '';
    const cards=its.map(it=>gallCardHTML({...it,kind,walkFrom:(AREA_ORIGIN[a]||a),areaKey:it.key})).join('')
      +cus.map(c=>gallCardHTML({...esCardData(c),kind,walkFrom:(AREA_ORIGIN[a]||a),editId:c.id})).join('');
    const qa=jsQuote(a),nAreas=allEatAreas().length;
    const ctl=`<span class="edit-only area-ctl">${gi>0?`<button type="button" onclick="moveEatArea('${qa}',-1)" aria-label="往上移">▲ 上移</button>`:''}${gi<nAreas-1?`<button type="button" onclick="moveEatArea('${qa}',1)" aria-label="往下移">▼ 下移</button>`:''}${isCustomArea(a)?`<button type="button" onclick="renameEatArea('${qa}')">改名</button><button type="button" class="del" onclick="deleteEatArea('${qa}')">刪除</button>`:''}</span>`;
    return `<section class="eatshop-group${emptyArea?' empty-area':''}" id="eatshop-g${gi}"><h3><span>${escHtml(a)}</span><small>${its.length+cus.length} 個</small>${ctl}</h3>${emptyArea?'<div class="dp-empty edit-only">這個區域還沒有項目：按下方「＋ 新增」，或在任一張卡片按「區域」改到這裡。</div>':`<div class="gall-grid">${cards}</div>`}</section>`;
  }).join('');
  const orphan=custom.filter(c=>!used.has(c.id));
  const orphanHTML=orphan.length?`<section class="eatshop-group"><h3><span>我的收藏（未分區）</span></h3><div class="gall-grid">${orphan.map(c=>gallCardHTML({...esCardData(c),kind,editId:c.id})).join('')}</div></section>`:'';
  const chips=allEatAreas().map((a,gi)=>({a,gi})).filter(({a})=>items.some(it=>it.area===a)||custom.some(c=>c.area===a)).map(({a,gi})=>`<button type="button" onclick="document.getElementById('eatshop-g${gi}')?.scrollIntoView({behavior:'smooth',block:'start'})">${escHtml(a)}</button>`).join('');
  dayContent.innerHTML=`<div class="eatshop-hero"><img class="eh-ic" src="${isEat?NAV_IC.food:NAV_IC.shopping}" alt=""><h2>${word}·旅途</h2></div>
    ${chips?`<div class="eatshop-chips">${chips}</div>`:''}
    ${sections||emptyArtHTML('目前沒有候選項目。')}${orphanHTML}
    ${removedEatShopHTML(kind)}
    <div class="edit-only eatshop-add"><button type="button" onclick="addEatShop('${kind}')">＋ 新增我的${isEat?'私房餐廳':'逛街地點'}</button><button type="button" onclick="addEatArea()">＋ 新增區域</button></div>
    <div class="end-mama">${mamaBtnHTML('list-'+kind,'wide')}<small>放不進任何店家的資訊，記在這裡</small></div>`;
}
/* 詳情頁：沿用景點卡的完整功能（評論與資訊、上傳照片、修正導航、MaMa…） */
function openSpotDetail(key){
  if(document.getElementById('spot-card-'+key)&&!document.getElementById('spotDetailSheet')){
    const p=planOf(key);if(p!=null){jumpToSearchResult(p,key,'more');return;}
  }
  if(!spotByKey(key))return;
  window._detailKey=key;renderSpotDetail(true);
}
function renderSpotDetail(fresh){
  const key=window._detailKey;if(!key)return;
  const spot=spotByKey(key);if(!spot){closeSpotDetail();return;}
  let wrap=document.getElementById('spotDetailSheet');
  const prevScroll=wrap?(wrap.querySelector('.detail-body')||{}).scrollTop||0:0;
  if(!wrap){wrap=document.createElement('div');wrap.id='spotDetailSheet';wrap.className='detail-sheet';document.body.appendChild(wrap);document.body.classList.add('detail-open');}
  const p=planOf(key);
  const name=currentFieldValue(key,'name',spot.name)||spot.name;
  const card=spotCardHTML(spot,key,false,null,null,null).replace('class="sub-spot-card','class="sub-spot-card open');
  wrap.innerHTML=`<div class="detail-top"><button type="button" class="detail-back" onclick="closeSpotDetail()">‹ 返回</button><div class="detail-title">${escHtml(name)}</div></div>
    <div class="detail-body"><div class="detail-plan"><div><small>排入行程</small><b>${p!=null?`D${days[p].dayNum}・${days[p].date}（週${days[p].weekday}）`:'尚未排入'}</b></div><button type="button" onclick="openPlanModal('${jsQuote(key)}')">${p!=null?'改日期':'選擇日期'}</button></div>${card}</div>`;
  const body=wrap.querySelector('.detail-body');if(body&&!fresh)body.scrollTop=prevScroll;
}
function closeSpotDetail(){
  document.getElementById('spotDetailSheet')?.remove();window._detailKey=null;document.body.classList.remove('detail-open');
}
/* 每天的「逛吃」分頁：今天已排入 + 已收藏但還沒排入的候選 */
function dayEatPanelHTML(i){
  const master=[...collectEatShop('eat').map(o=>({...o,kind:'eat'})),...collectEatShop('shop').map(o=>({...o,kind:'shop'}))];
  const customs=eatShopStore.map(c=>({...esCardData(c),kind:c.kind,editId:null}));
  const all=[...master,...customs];
  const planned=all.filter(o=>planOf(o.key)===i);
  const own=collectSpots((s,di,key)=>di===i&&(s.cat==='food'||s.cat==='shopping')&&!isMasterKey(key)&&marksFor(key).fav).map(o=>({...o,kind:o.cat==='shopping'?'shop':'eat'}));
  const cand=all.filter(o=>marksFor(o.key).fav&&planOf(o.key)!==i);
  const grid=list=>`<div class="gall-grid">${list.map(o=>gallCardHTML({...o,planDay:i})).join('')}</div>`;
  const sec=(t,list,empty)=>`<h4 class="dp-sub">${t}</h4>${list.length?grid(list):`<div class="dp-empty">${empty}</div>`}`;
  return `<div class="day-panel"><div class="dp-title"><span>今天的逛吃</span></div>
    ${sec('今天已排入',[...planned,...own],'還沒有排入。到「吃·旅途」「逛·旅途」挑好，按「排入日期」。')}
    ${cand.length?sec('已收藏，尚未排入今天',cand,''):''}
    <div class="dp-two"><button type="button" onclick="setActiveDay('eat')">看全部 吃·旅途</button><button type="button" onclick="setActiveDay('shop')">看全部 逛·旅途</button></div></div>`;
}

/* ---------- 購物清單：一個品項一張卡、多圖左右滑、說明文字在下方 ---------- */
function shopCardHTML(it,i){
  const imgs=shopImgs(it),meta=SHOP_CATS[it.cat||'supermarket']||SHOP_CATS.supermarket;
  const many=imgs.length>1;
  const slides=imgs.length?imgs.map(src=>`<div class="shop-car-slide" data-src="${escAttr(src)}" onclick="openAttachModal(this.dataset.src)"><img src="${escAttr(src)}" alt="${escAttr(it.name)}" loading="lazy" draggable="false"></div>`).join(''):`<div class="shop-car-slide ph"><img src="${NAV_IC.shopping}" alt=""></div>`;
  return `<article class="shop-card ${it.checked?'is-done':''}" data-shop="${i}"><div class="shop-car"><div class="shop-car-track">${slides}</div>${many?`<button type="button" class="shop-car-nav prev" onclick="shopCarMove(${i},-1)" aria-label="上一張">‹</button><button type="button" class="shop-car-nav next" onclick="shopCarMove(${i},1)" aria-label="下一張">›</button><div class="shop-car-dots">${imgs.map((_,k)=>`<i class="${k===0?'on':''}"></i>`).join('')}</div><span class="shop-car-count">1 / ${imgs.length}</span>`:''}<span class="shop-cat-tag" style="background:${meta.color}">${escHtml(meta.label.replace(/^\S+\s*/,''))}</span></div><div class="shop-card-body"><label class="shop-card-title"><input type="checkbox" ${it.checked?'checked':''} onchange="toggleShop(${i})"><span>${escHtml(it.name)}</span><em>× ${Number(it.qty)||1}</em></label>${it.location?`<p class="shop-card-note">${escHtml(it.location)}</p>`:''}</div></article>`;
}
function shopCarMove(i,dir){
  const t=document.querySelector(`.shop-card[data-shop="${i}"] .shop-car-track`);if(!t)return;
  t.scrollBy({left:dir*t.clientWidth,behavior:'smooth'});
}
function bindShopCarousels(root){
  root.querySelectorAll('.shop-car-track').forEach(t=>{
    const car=t.parentElement,dots=car.querySelectorAll('.shop-car-dots i'),cnt=car.querySelector('.shop-car-count');
    if(!dots.length)return;
    t.addEventListener('scroll',()=>{
      const k=Math.round(t.scrollLeft/Math.max(1,t.clientWidth));
      dots.forEach((d,x)=>d.classList.toggle('on',x===k));
      if(cnt)cnt.textContent=`${k+1} / ${dots.length}`;
    },{passive:true});
  });
}
function setShopFilter(f){window._shopFilter=f;renderShopList();}
function shopGalleryHTML(){
  const filter=window._shopFilter||'all';
  const counts={all:shopData.length};Object.keys(SHOP_CATS).forEach(k=>counts[k]=shopData.filter(x=>(x.cat||'supermarket')===k).length);
  const chips=[['all','全部'],...Object.keys(SHOP_CATS).map(k=>[k,SHOP_CATS[k].label.replace(/^\S+\s*/,'')])].filter(([k])=>k==='all'||counts[k]>0).map(([k,l])=>`<button type="button" class="${filter===k?'on':''}" onclick="setShopFilter('${k}')">${escHtml(l)}<b>${counts[k]}</b></button>`).join('');
  const list=shopData.map((it,i)=>({it,i})).filter(x=>filter==='all'||(x.it.cat||'supermarket')===filter);
  const done=list.filter(x=>x.it.checked).length;
  if(!shopData.length)return '<div class="empty-art"><img src="images/art-shopping.webp" alt="" loading="lazy"><p>購物清單還是空的。<br>切到編輯模式新增項目與照片。</p></div>';
  return `<div class="shop-filter">${chips}</div><div class="shop-progress">已買 ${done} / ${list.length}</div><div class="shop-cards">${list.map(x=>shopCardHTML(x.it,x.i)).join('')}</div>`;
}
function shopItemEditHTML(it,i){
  const imgs=shopImgs(it);
  const photosHTML=imgs.length?`<div class="shop-photo-row">${imgs.map((src,pi)=>`<div class="shop-photo"><img src="${escAttr(src)}" data-src="${escAttr(src)}" onclick="openAttachModal(this.dataset.src)"><button onclick="removeShopImg(${i},${pi})">✕</button></div>`).join('')}</div>`:'';
  return `<div class="pack-item shop-item ${it.checked?'checked':''}"><input type="checkbox" ${it.checked?'checked':''} onchange="toggleShop(${i})"><div class="name shop-item-title">${escHtml(it.name)}</div><div class="qty"><button onclick="document.getElementById('shopFile-${i}').click()" class="camera-btn">照片</button><button onclick="changeShopQty(${i},-1)">－</button><span>${Number(it.qty)||1}</span><button onclick="changeShopQty(${i},1)">＋</button></div><button class="pack-edit-btn" onclick="editShopItem(${i})" title="修改名稱、分類與說明">✎</button><button class="del" onclick="delShop(${i})">✕</button><input type="file" id="shopFile-${i}" accept="image/*" multiple style="display:none" onchange="handleShopPhoto(event, ${i})">${it.location?`<div class="shop-note">${escHtml(it.location)}</div>`:''}<div class="shop-extra edit-only"><textarea rows="2" placeholder="說明：品牌、規格、想買的店…（旅行模式會顯示在圖片下方）" onchange="setShopLocation(${i}, this.value)">${escHtml(it.location||'')}</textarea></div>${photosHTML}</div>`;
}
function renderShopList(){
  const wrap=document.getElementById('shopListWrap');if(!wrap)return;
  const edit=Object.keys(SHOP_CATS).map(catKey=>{
    const meta=SHOP_CATS[catKey];
    const entries=shopData.map((it,i)=>({it,i})).filter(x=>(x.it.cat||'supermarket')===catKey);
    const isOpen=listSectionOpen.shop[catKey]===true;
    const done=entries.filter(x=>x.it.checked).length;
    const itemsHTML=entries.length?entries.map(({it,i})=>shopItemEditHTML(it,i)).join(''):'<div class="empty compact">此清單目前沒有項目。</div>';
    return `<section class="checklist-group shop-group shop-${catKey}"><button class="checklist-group-head" onclick="toggleListSection('shop','${catKey}')" aria-expanded="${isOpen}"><span>${meta.label}</span><small>${done}/${entries.length}</small><b>${isOpen?'⌃':'⌄'}</b></button><div class="checklist-group-body ${isOpen?'open':''}">${itemsHTML}</div></section>`;
  }).join('');
  const addRow=`<div class="add-row shop-add-row"><select id="newShopCat" class="pill-select">${Object.keys(SHOP_CATS).map(k=>`<option value="${k}">${SHOP_CATS[k].label}</option>`).join('')}</select><input type="text" id="newShopItem" placeholder="新增購物項目..." onkeydown="if(event.key==='Enter')addShopItem()"><button onclick="addShopItem()">＋</button></div>`;
  const scroll=window.scrollY;
  wrap.innerHTML=`<div class="shop-edit-wrap">${edit}${addRow}</div><div class="shop-gallery-wrap">${shopGalleryHTML()}</div>`;
  bindShopCarousels(wrap);
  if(Math.abs(window.scrollY-scroll)>2)window.scrollTo({top:scroll,behavior:'auto'});
}

/* ---------- 天氣：每個地點可展開／收合 ---------- */
function weatherToggle(k,open){const s=window._weatherOpen||(window._weatherOpen=new Set());if(open)s.add(k);else s.delete(k);}
function weatherExpandAll(open){
  window._weatherOpen=new Set(open?cityKeys():[]);
  document.querySelectorAll('#liveWeatherList details.wc-details').forEach(d=>{d.open=open;});
}

/* ---------- 離線：把所有圖片存到這台裝置（換版本也不會被清掉） ---------- */
const IMAGE_CACHE_NAME='nagano-images-persist';
function collectAllImageUrls(){
  const set=new Set();
  const isImg=v=>typeof v==='string'&&/^https?:\/\//i.test(v);
  const walk=v=>{if(!v)return;if(isImg(v)){set.add(v);return;}if(Array.isArray(v))v.forEach(walk);else if(typeof v==='object')Object.values(v).forEach(walk);};
  days.forEach(d=>[...(d.spots||[]),...(d.moreSpots||[])].forEach(s=>{if(isImg(s.img))set.add(s.img);}));
  [photoStore,coverStore,routeMapStore,foliageMapStore,transportExtrasStore].forEach(walk);
  (customSpotsStore&&Object.values(customSpotsStore)||[]).forEach(arr=>(arr||[]).forEach(s=>{if(s&&isImg(s.img))set.add(s.img);}));
  shopData.forEach(it=>walk([it.img,it.imgs]));
  rulesData.forEach(r=>walk([r.img,r.imgs]));
  if(typeof subSpotStore==='object')walk(subSpotStore);docsData.forEach(d=>walk(d.img));
  surprisesData.forEach(x=>walk(x.img));
  return [...set];
}
const precacheState={done:0,failed:0,total:0,running:false};
async function offlineImageStatus(){
  const urls=collectAllImageUrls();
  if(!window.caches)return {cached:0,total:urls.length,supported:false};
  const c=await caches.open(IMAGE_CACHE_NAME);let cached=0;
  for(const u of urls){if(await c.match(u))cached++;}
  return {cached,total:urls.length,supported:true};
}
async function startOfflinePrecache(manual){
  if(!navigator.serviceWorker||!navigator.serviceWorker.controller){if(manual)alert('離線功能需要「重新整理一次」後才會啟用。請重新整理再試。');return;}
  if(!navigator.onLine){if(manual)alert('目前離線，無法下載。');return;}
  const urls=collectAllImageUrls();
  precacheState.running=true;precacheState.done=0;precacheState.failed=0;precacheState.total=urls.length;
  updateOfflineRow();
  navigator.serviceWorker.controller.postMessage({type:'PRECACHE_IMAGES',urls});
}
async function updateOfflineRow(){
  const el=document.getElementById('offlineStatusRow');if(!el)return;
  if(precacheState.running){el.textContent=`下載中… ${precacheState.done + precacheState.failed} / ${precacheState.total}`;return;}
  const st=await offlineImageStatus();
  el.textContent=st.supported?`圖片已存 ${st.cached} / ${st.total} 張（沒網路也看得到）`:'這個瀏覽器不支援離線圖片';
}
if(navigator.serviceWorker){
  navigator.serviceWorker.addEventListener('message',e=>{
    const d=e.data||{};
    if(d.type==='PRECACHE_PROGRESS'){
      precacheState.done=d.done;precacheState.failed=d.failed;precacheState.total=d.total;
      if(d.done+d.failed>=d.total){precacheState.running=false;try{localStorage.setItem('nagano_precache_at',String(Date.now()));}catch(_e){}}
      updateOfflineRow();
    }
  });
}
function maybeAutoPrecache(){
  try{
    const last=Number(localStorage.getItem('nagano_precache_at')||0);
    if(Date.now()-last<20*3600*1000)return;
    if(navigator.connection&&navigator.connection.saveData)return;
    startOfflinePrecache(false);
  }catch(e){}
}
document.addEventListener('DOMContentLoaded',()=>{setTimeout(maybeAutoPrecache,9000);});

/* ---------- 內建景點順序護欄：萬一日後內建行程有調整，先自動備份 ---------- */
function builtinIndex(){
  const idx={};
  days.forEach((d,di)=>{(d.spots||[]).forEach((s,j)=>{idx[`d${di}-m${j}`]=s.name;});(d.moreSpots||[]).forEach((s,j)=>{idx[`d${di}-s${j}`]=s.name;});});
  return idx;
}
function checkBuiltinIndex(){
  try{
    const now=builtinIndex(),raw=localStorage.getItem('nagano_builtin_index_v1');
    if(raw){
      const old=JSON.parse(raw);let changed=0;
      Object.keys(old).forEach(k=>{if(now[k]!==old[k])changed++;});
      if(changed){try{saveSnapshot('內建行程調整前備份（'+changed+' 處）',true);}catch(e){}window._builtinChanged=changed;}
    }
    localStorage.setItem('nagano_builtin_index_v1',JSON.stringify(now));
  }catch(e){}
}
checkBuiltinIndex();

/* =====================================================================
   v54：照片管理（封面／展開大圖／新增／刪除）、住宿空白卡、天氣整齊、小驚喜分類、紅葉地圖主次
   ===================================================================== */
let detailCoverStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_detail_covers'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
let hiddenOrigStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_hidden_orig'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistDetailCovers(){safeSetItem('nagano_detail_covers',detailCoverStore);}
function persistHiddenOrig(){safeSetItem('nagano_hidden_orig',hiddenOrigStore);}

/* 一個景點可用的照片：原圖（可隱藏）＋你上傳的照片 */
function spotPhotoList(idx,spot){
  const list=[];
  if(spot&&spot.img&&!hiddenOrigStore[idx])list.push({url:spot.img,kind:'orig'});
  (photoStore[idx]||[]).forEach((u,i)=>list.push({url:u,kind:'user',i}));
  return list;
}
function pickPhotoBySel(sel,idx,spot){
  if(sel==null)return null;
  const list=spotPhotoList(idx,spot);
  if(sel==='original')return list.find(p=>p.kind==='orig')?spot.img:null;
  if(typeof sel==='number'){const p=list.find(x=>x.kind==='user'&&x.i===sel);return p?p.url:null;}
  if(typeof sel==='string'){const p=list.find(x=>x.url===sel);return p?p.url:null;}
  return null;
}
function coverUrlFor(idx,spot){
  const l=spotPhotoList(idx,spot);
  return pickPhotoBySel(coverStore[idx],idx,spot)||(l[0]&&l[0].url)||'';
}
function detailUrlFor(idx,spot){
  return pickPhotoBySel(detailCoverStore[idx],idx,spot)||coverUrlFor(idx,spot);
}
function spotCoverFor(key,spot){return coverUrlFor(key,spot)||'';}
function reopenCard(idx){setTimeout(()=>{const card=document.getElementById('spot-card-'+idx);if(card){card.classList.add('open');openSpotCardKeys.add(String(idx));}},50);}
function selValueFor(p){return p.kind==='orig'?'original':p.url;}
function setCoverPhoto(key,sel){coverStore[key]=sel;persistCover();renderDayContent();reopenCard(key);}
function setDetailPhoto(key,sel){detailCoverStore[key]=sel;persistDetailCovers();renderDayContent();reopenCard(key);}
function hideOrigPhoto(idx){
  const prev={hidden:hiddenOrigStore[idx],cover:coverStore[idx],big:detailCoverStore[idx]};
  hiddenOrigStore[idx]=1;
  if(coverStore[idx]==='original')delete coverStore[idx];
  if(detailCoverStore[idx]==='original')delete detailCoverStore[idx];
  persistHiddenOrig();persistCover();persistDetailCovers();renderDayContent();reopenCard(idx);
  offerUndo('已隱藏原圖',()=>{if(prev.hidden===undefined)delete hiddenOrigStore[idx];else hiddenOrigStore[idx]=prev.hidden;if(prev.cover!==undefined)coverStore[idx]=prev.cover;if(prev.big!==undefined)detailCoverStore[idx]=prev.big;persistHiddenOrig();persistCover();persistDetailCovers();renderDayContent();reopenCard(idx);});
}
function restoreOrigPhoto(e,idx){if(e)e.stopPropagation();delete hiddenOrigStore[idx];persistHiddenOrig();renderDayContent();reopenCard(idx);}
function pmAct(e,idx,i,act){
  if(e)e.stopPropagation();
  const spot=spotByKey(idx)||{};
  const p=spotPhotoList(idx,spot)[i];if(!p)return;
  if(act==='cover')return setCoverPhoto(idx,selValueFor(p));
  if(act==='big')return setDetailPhoto(idx,selValueFor(p));
  if(act==='pos')return openPhotoPosEditor(e,{dataset:{src:p.url}});
  if(act==='del')return p.kind==='orig'?hideOrigPhoto(idx):removePhoto(e,idx,p.i);
  if(act==='left')return movePhoto(e,idx,p.i,-1);
  if(act==='right')return movePhoto(e,idx,p.i,1);
}
function photoManagerHTML(idx,spot){
  const list=spotPhotoList(idx,spot);
  const hidden=!!(spot&&spot.img&&hiddenOrigStore[idx]);
  if(!list.length&&!hidden)return '';
  const cover=coverUrlFor(idx,spot),big=detailUrlFor(idx,spot),q=jsQuote(idx);
  const userCount=list.filter(p=>p.kind==='user').length;
  const tiles=list.map((p,i)=>{
    const isC=p.url===cover,isB=p.url===big;
    const mv=(p.kind==='user'&&userCount>1)?`<div class="pm-order edit-only">${p.i>0?`<button type="button" onclick="pmAct(event,'${q}',${i},'left')">◀ 往前</button>`:''}${p.i<userCount-1?`<button type="button" onclick="pmAct(event,'${q}',${i},'right')">往後 ▶</button>`:''}</div>`:'';
    return `<div class="pm-tile ${isC?'is-cover':''}"><div class="pm-img" data-src="${escAttr(p.url)}" onclick="event.stopPropagation();openAttachModal(this.dataset.src)"><img src="${escAttr(p.url)}"${photoPosAttr(p.url)} alt="" loading="lazy" onerror="imageErrorFallback(this)">${isC?'<span class="pm-b c">封面</span>':''}${isB?'<span class="pm-b b">大圖</span>':''}${p.kind==='orig'?'<span class="pm-b o">原圖</span>':''}</div>${mv}<div class="pm-btns edit-only"><button type="button" class="${isC?'on':''}" onclick="pmAct(event,'${q}',${i},'cover')">封面</button><button type="button" class="${isB?'on':''}" onclick="pmAct(event,'${q}',${i},'big')">大圖</button><button type="button" onclick="pmAct(event,'${q}',${i},'pos')">位置</button><button type="button" class="del" onclick="pmAct(event,'${q}',${i},'del')">${p.kind==='orig'?'隱藏':'刪除'}</button></div></div>`;
  }).join('');
  const add=`<button type="button" class="pm-add edit-only" onclick="event.stopPropagation();document.getElementById('file-${escAttr(idx)}').click()">＋ 新增照片</button>`;
  return `<div class="pm" onclick="event.stopPropagation()"><div class="pm-head"><b>照片（${list.length}）</b><span class="pm-hint edit-only">「封面」＝卡片縮圖，「大圖」＝展開後最上方的圖</span>${hidden?`<button type="button" class="pm-restore edit-only" onclick="restoreOrigPhoto(event,'${q}')">還原原圖</button>`:''}</div><div class="pm-grid">${tiles}${add}</div></div>`;
}
function removePhoto(e,idx,photoIdx){
  if(e)e.stopPropagation();
  const removed=photoStore[idx].splice(photoIdx,1)[0];
  const oldCover=coverStore[idx],oldBig=detailCoverStore[idx];
  const fix=(store,persist)=>{const sel=store[idx];if(typeof sel==='number'){if(sel===photoIdx)delete store[idx];else if(sel>photoIdx)store[idx]=sel-1;persist();}else if(sel===removed){delete store[idx];persist();}};
  fix(coverStore,persistCover);fix(detailCoverStore,persistDetailCovers);
  persistPhotos();renderDayContent();reopenCard(idx);
  offerUndo('已刪除照片',()=>{if(!photoStore[idx])photoStore[idx]=[];photoStore[idx].splice(photoIdx,0,removed);if(oldCover!==undefined){coverStore[idx]=oldCover;persistCover();}if(oldBig!==undefined){detailCoverStore[idx]=oldBig;persistDetailCovers();}persistPhotos();renderDayContent();reopenCard(idx);});
}
function coverImgHTML(cls,url){return `<img class="${cls}" src="${escAttr(url)}"${photoPosAttr(url)} alt="" loading="lazy" onerror="imageErrorFallback(this)">`;}

/* ---------- 今晚住宿：還沒新增時顯示空白卡，可直接新增，之後自動變成住宿卡 ---------- */
function addStayForDay(dayIdx){
  openFormModal({title:'新增住宿',fields:[{id:'name',label:'住宿名稱',value:'',placeholder:'例：Lomä Shinanomachi'},{id:'nav',label:'導航位置（地址、Google Maps 網址或關鍵字；留空＝用名稱）',value:''}],saveText:'新增',
    onSave:v=>{
      if(!v.name){alert('請輸入住宿名稱');return false;}
      const g=generateAutoDesc(v.name,'hotel','',null);
      const spot=S(v.name,'hotel',g.short,{fullDesc:g.full,genSource:'offline'});
      if(!customSpotsStore[dayIdx])customSpotsStore[dayIdx]=[];
      customSpotsStore[dayIdx].push(spot);persistCustomSpots();
      if(v.nav){fieldOverrideStore[fieldOverrideKey(`d${dayIdx}-c${customSpotsStore[dayIdx].length-1}`,'mapQuery')]=v.nav;persistFieldOverrides();}
      renderDayContent();updateSpotCount();
    }});
}
function copyPrevStay(dayIdx){
  const prev=dayStays(prevPlanDay(dayIdx));if(!prev.length)return;
  if(!customSpotsStore[dayIdx])customSpotsStore[dayIdx]=[];
  prev.forEach(p=>{
    const src=spotByKey(p.key)||{};
    const spot=S(p.name,'hotel',src.desc||'',{fullDesc:src.fullDesc||'',genSource:'offline'});
    customSpotsStore[dayIdx].push(spot);
    const nk=`d${dayIdx}-c${customSpotsStore[dayIdx].length-1}`;
    if(p.nav&&p.nav!==p.name)fieldOverrideStore[fieldOverrideKey(nk,'mapQuery')]=p.nav;
    HOTEL_AMENITIES.forEach(a=>{const v=currentFieldValue(p.key,'amen_'+a.id,null);if(v)fieldOverrideStore[fieldOverrideKey(nk,'amen_'+a.id)]=v;});
  });
  persistCustomSpots();persistFieldOverrides();renderDayContent();updateSpotCount();
}
function emptyStayCardHTML(dayIdx){
  const last=isLastPlanDay(dayIdx);
  const prev=dayStays(prevPlanDay(dayIdx));
  return `<div class="stay-quick-card empty"><div class="stay-quick-top"><div class="stay-quick-icon art"><img src="images/art-lodging.webp" alt="" width="56" height="56"></div><div class="stay-quick-copy"><small>今晚住宿</small><strong>${last?'返程日（不需住宿）':'尚未新增住宿'}</strong></div></div><div class="stay-quick-amen edit-only"><button type="button" class="stay-add" onclick="addStayForDay(${dayIdx})">＋ 新增住宿</button>${prev.length?`<button type="button" class="stay-add ghost" onclick="copyPrevStay(${dayIdx})">沿用前一晚：${escHtml(prev.map(x=>x.name).join('、'))}</button>`:''}</div></div>`;
}

/* ---------- 天氣列：整齊的欄位 ---------- */
/* （樣式在 CSS：名稱 | 圖示 | 溫度＋天氣 | 箭頭） */

/* ---------- 小驚喜：分類權重與「溫柔提醒」 ---------- */
SURPRISE_LABEL.care='溫柔提醒';
const SURPRISE_CARE_SEED=[
  {id:'sd-c01',type:'care',text:'今天走了不少路，記得多喝水，也記得找個地方坐下來休息一下。'},
  {id:'sd-c02',type:'care',text:'行程只是參考，累了就放慢一點，留一點空白也是旅行的一部分。'},
  {id:'sd-c03',type:'care',text:'出門前摸摸口袋：護照、手機、Suica、駕照，都在嗎？'},
  {id:'sd-c04',type:'care',text:'山上早晚還涼，出門帶一件外套，別讓自己著涼。'},
  {id:'sd-c05',type:'care',text:'在寺院裡放輕腳步、輕聲說話，把安靜留給每一個人。'},
  {id:'sd-c06',type:'care',text:'腳痠的時候，換一雙乾爽的襪子會舒服很多。'},
  {id:'sd-c07',type:'care',text:'拍照時留意身後的人和車，安全比一張好照片更重要。'},
  {id:'sd-c08',type:'care',text:'山路和海邊風大，天黑前先回到溫暖的地方。'},
  {id:'sd-c09',type:'care',text:'今天辛苦了，晚上泡個熱水澡，好好睡一覺。'}
];
SURPRISE_SEED.push(...SURPRISE_CARE_SEED);
function mergeNewSeeds(){
  let seen=[];try{seen=JSON.parse(localStorage.getItem('nagano_seed_seen_v1'))||[];}catch(e){}
  const ids=new Set(surprisesData.map(x=>x.id));let added=0;
  SURPRISE_SEED.forEach(x=>{if(!seen.includes(x.id)){if(!ids.has(x.id)){surprisesData.push(structuredClone(x));added++;}seen.push(x.id);}});
  try{localStorage.setItem('nagano_seed_seen_v1',JSON.stringify(seen));}catch(e){}
  if(added)persistSurprises();
}
function pickWeightedType(mode){
  const has=t=>surprisesData.some(x=>x.type===t);
  const w=mode==='more'?{tip:75,joke:25}:{tip:40,care:25,joke:20,photo:15};
  const opts=Object.entries(w).filter(([t])=>has(t));
  if(!opts.length){const any=surprisesData[0];return any?any.type:null;}
  const sum=opts.reduce((a,[,v])=>a+v,0);let r=Math.random()*sum;
  for(const [t,v] of opts){r-=v;if(r<=0)return t;}
  return opts[0][0];
}
function nextSurprise(mode){
  if(!surprisesData.length)return null;
  const acct=accountKey();
  const type=pickWeightedType(mode);
  const ofType=surprisesData.filter(x=>x.type===type);
  let seen=new Set(tipsSeen[acct]||[]);
  let pool=ofType.filter(x=>!seen.has(x.id));
  if(!pool.length){ofType.forEach(x=>seen.delete(x.id));pool=ofType.slice();}   /* 這一類看完一輪才重新開始 */
  const pick=pool[Math.floor(Math.random()*pool.length)];
  seen.add(pick.id);
  tipsSeen[acct]=[...seen];
  safeSetItem('nagano_tips_seen',tipsSeen);
  return pick;
}
/* 依標點切成一小段一小段，換行盡量落在逗號、句號之後 */
function phraseWrapHTML(t){
  const parts=String(t).match(/[^，、。；：！？!?）」』]+[，、。；：！？!?）」』]*|[，、。；：！？!?）」』]+/g)||[String(t)];
  return parts.map(x=>`<span class="ph">${escHtml(x)}</span>`).join('');
}
function showSurprise(mode){
  const m=(mode==='more')?'more':'first';
  const item=nextSurprise(m);
  if(!item){alert('還沒有小驚喜內容。請在編輯模式的指南頁新增。');return;}
  closeSurprise();
  const card=document.createElement('div');card.id='surpriseCard';card.className='surprise-card';
  const img=item.img?`<img class="sc-img" src="${escAttr(item.img)}" alt="" loading="lazy">`:'';
  card.innerHTML=`<div class="sc-head"><span class="sc-tag ${item.type}">${SURPRISE_LABEL[item.type]||'小驚喜'}</span><button type="button" class="sc-x" aria-label="關閉">✕</button></div>${(typeof SURPRISE_ART!=='undefined'&&SURPRISE_ART[item.type]&&!item.img)?`<img class="sc-art" src="${SURPRISE_ART[item.type]}" alt="">`:''}${img}${item.text?`<p>${phraseWrapHTML(item.text)}</p>`:''}<div class="sc-actions"><button type="button" class="sc-more">再來一則</button></div>`;
  document.body.appendChild(card);
  card.querySelector('.sc-x').onclick=closeSurprise;
  card.querySelector('.sc-more').onclick=()=>showSurprise('more');
  requestAnimationFrame(()=>card.classList.add('in'));
  clearTimeout(window._surpriseTimer);window._surpriseTimer=setTimeout(closeSurprise,25000);
}
function surpriseFields(x){
  return [{id:'type',label:'類型',type:'select',value:x.type,options:[{value:'tip',label:'小知識'},{value:'joke',label:'笑話'},{value:'care',label:'溫柔提醒'},{value:'photo',label:'旅程照片'}]},{id:'text',label:'文字（照片可寫一句說明）',type:'textarea',rows:4,value:x.text||''},{id:'file',label:x.img?'更換照片（不選則保留原本的）':'旅程照片（選填）',type:'file'}];
}
function critterTick(){const ok=spawnPeek();critter.timer=setTimeout(critterTick,ok?(90000+Math.random()*60000):15000);}   /* 約每 1.5–2.5 分鐘一次；被擋住時 15 秒後再試 */
function startCritters(){
  if(critter.timer||reducedMotion())return;
  critter.timer=setTimeout(critterTick,25000+Math.random()*20000);                                        /* 開啟後約 25–45 秒第一次 */
}

/* ---------- 花況與會場地圖：自己決定哪幾張明顯、哪幾張縮小 ---------- */
function foliageIsFeatured(m,i){
  const explicit=foliageMapStore.some(x=>x.featured!==undefined);
  return explicit?!!m.featured:i===0;
}
function toggleFoliageFeatured(i){
  const wasFeat=foliageIsFeatured(foliageMapStore[i],i);
  const states=foliageMapStore.map((m,k)=>foliageIsFeatured(m,k));   /* 先把目前的狀態全部固定下來 */
  foliageMapStore.forEach((m,k)=>{m.featured=states[k];});
  foliageMapStore[i].featured=!wasFeat;
  persistFoliageMaps();renderFoliageMaps();
}
function renderFoliageMaps(){
  const el=document.getElementById('foliageMapGallery');if(!el)return;
  if(!foliageMapStore.length){el.innerHTML='<div class="empty">尚未上傳花況或會場地圖。</div>';return;}
  const feat=[],rest=[];
  foliageMapStore.forEach((m,i)=>(foliageIsFeatured(m,i)?feat:rest).push({m,i}));
  const actions=i=>`<div class="foliage-map-actions"><button onclick="editFoliageMap(${i})" aria-label="改名">✎</button><button onclick="document.getElementById('foliageReplace-${i}').click()" aria-label="更換">↻</button><button onclick="removeFoliageMap(${i})" aria-label="刪除">✕</button></div><input type="file" id="foliageReplace-${i}" accept="image/*" style="display:none" onchange="replaceFoliageMap(event,${i})">`;
  const big=feat.map(({m,i})=>`<div class="fm-feature"><img src="${escAttr(m.url)}" data-src="${escAttr(m.url)}" onclick="openAttachModal(this.dataset.src)" alt="${escAttr(m.title||'花況與會場地圖')}"><div class="fm-row"><span class="fm-title">${escHtml(m.title||`花況地圖 ${i+1}`)}</span><button type="button" class="fm-feat on" onclick="toggleFoliageFeatured(${i})">改為縮圖</button></div>${actions(i)}</div>`).join('');
  const small=rest.length?`<h4 class="fm-sub">其他地圖（點一下放大）</h4><div class="fm-thumbs">${rest.map(({m,i})=>`<div class="fm-thumb"><img src="${escAttr(m.url)}" data-src="${escAttr(m.url)}" onclick="openAttachModal(this.dataset.src)" alt="${escAttr(m.title||'花況與會場地圖')}" loading="lazy"><span class="fm-title">${escHtml(m.title||`花況地圖 ${i+1}`)}</span><button type="button" class="fm-feat" onclick="toggleFoliageFeatured(${i})">設為明顯</button>${actions(i)}</div>`).join('')}</div>`:'';
  el.innerHTML=big+small;
}
function openAttachModal(src){
  const m=document.getElementById('attachModal'),img=document.getElementById('attachModalImg');
  img.src=src;m.classList.remove('zoomed');img.classList.remove('zoomed');m.classList.add('active');
}
/* 圖片檢視：點圖片放大到細節、再點縮回（用捕獲階段，不受 img 上原有 onclick 影響） */
document.addEventListener('click',e=>{
  const t=e.target;
  if(t&&t.id==='attachModalImg'){const z=!t.classList.contains('zoomed');t.classList.toggle('zoomed',z);document.getElementById('attachModal').classList.toggle('zoomed',z);}
},true);
document.addEventListener('DOMContentLoaded',()=>{mergeNewSeeds();renderSurpriseAdmin();});

/* =====================================================================
   v55：MaMa 標題與可見的編輯／刪除、卡片收合、開啟畫面
   ===================================================================== */
function mamaEntryTitle(e){
  const t=(e.title||'').trim();
  if(t)return t;
  const first=String(e.text||'').split('\n').find(l=>l.trim())||'（無標題）';
  return first.trim().slice(0,48);
}
function openMama(key){
  closeMama(true);
  mamaUI.key=key;mamaUI.editing=null;mamaUI.open=new Set();
  const wrap=document.createElement('div');wrap.id='mamaModal';wrap.className='mama-page';
  const name=markLabel(key);
  wrap.innerHTML=`<div class="mama-top"><button type="button" class="mama-back" data-close>‹ 返回</button><div class="mama-title"><span>MaMa 的筆記</span><b>${escHtml(name)}</b></div></div>
    <div class="mama-body"><div class="mama-compose"><input id="mamaTitleInput" class="mama-title-input" type="text" maxlength="60" placeholder="標題（選填，例如：餐廳心得、交通提醒）"><textarea id="mamaText" rows="6" placeholder="在這裡貼上或輸入資訊（可以整篇部落格文章直接貼上）"></textarea><div class="mama-compose-row"><small id="mamaCount">0 字</small><button type="button" class="mama-cancel" id="mamaCancel" hidden>取消編輯</button><button type="button" class="mama-save" id="mamaSave">儲存</button></div></div><div id="mamaList"></div></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('mama-open');
  const ta=wrap.querySelector('#mamaText');
  ta.addEventListener('input',()=>{wrap.querySelector('#mamaCount').textContent=ta.value.length.toLocaleString()+' 字';});
  wrap.querySelector('[data-close]').onclick=()=>closeMama();
  wrap.querySelector('#mamaSave').onclick=saveMama;
  wrap.querySelector('#mamaCancel').onclick=resetMamaCompose;
  renderMamaList();
}
function resetMamaCompose(){
  mamaUI.editing=null;
  const ta=document.getElementById('mamaText'),ti=document.getElementById('mamaTitleInput');
  if(ta){ta.value='';ta.dispatchEvent(new Event('input'));}
  if(ti)ti.value='';
  const c=document.getElementById('mamaCancel'),s=document.getElementById('mamaSave');
  if(c)c.hidden=true;if(s)s.textContent='儲存';
  document.querySelector('.mama-compose')?.classList.remove('editing');
}
function renderMamaList(){
  const list=document.getElementById('mamaList');if(!list||!mamaUI.key)return;
  const arr=mamaStore[mamaUI.key]||[];
  if(!arr.length){list.innerHTML=emptyArtHTML('還沒有內容。<br>把想記的資訊貼在上面，按「儲存」。');return;}
  list.innerHTML=arr.slice().reverse().map(e=>{
    const open=mamaUI.open.has(e.id);
    const when=e.at?new Date(e.at).toLocaleString('zh-TW',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    const editing=mamaUI.editing===e.id;
    return `<article class="mama-entry ${open?'open':''} ${editing?'is-editing':''}"><div class="me-top"><button type="button" class="mama-entry-head" data-toggle="${e.id}"><span class="me-title">${escHtml(mamaEntryTitle(e))}</span><span class="me-meta">${when}${e.edited?'・已編輯':''}・${(e.text||'').length.toLocaleString()} 字</span></button><div class="me-acts"><button type="button" data-edit="${e.id}">編輯</button><button type="button" class="del" data-del="${e.id}">刪除</button></div></div>${open?`<div class="mama-entry-text">${linkifyText(e.text)}</div>`:''}</article>`;
  }).join('');
  list.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>{const id=b.dataset.toggle;mamaUI.open.has(id)?mamaUI.open.delete(id):mamaUI.open.add(id);renderMamaList();});
  list.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    const e=(mamaStore[mamaUI.key]||[]).find(x=>x.id===b.dataset.edit);if(!e)return;
    mamaUI.editing=e.id;
    const ta=document.getElementById('mamaText'),ti=document.getElementById('mamaTitleInput');
    ta.value=e.text||'';ta.dispatchEvent(new Event('input'));ti.value=e.title||'';
    document.getElementById('mamaCancel').hidden=false;document.getElementById('mamaSave').textContent='儲存修改';
    document.querySelector('.mama-compose')?.classList.add('editing');
    renderMamaList();
    ti.scrollIntoView({behavior:'smooth',block:'center'});ta.focus();
  });
  list.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deleteMamaEntry(b.dataset.del));
}
function saveMama(){
  const ta=document.getElementById('mamaText'),ti=document.getElementById('mamaTitleInput');
  const text=ta.value.replace(/\r\n/g,'\n').trim(),title=(ti?ti.value:'').trim();
  if(!text){alert('請先輸入或貼上內容。');return;}
  const key=mamaUI.key;const arr=mamaStore[key]=mamaStore[key]||[];
  if(mamaUI.editing){const e=arr.find(x=>x.id===mamaUI.editing);if(e){e.text=text;e.title=title;e.edited=1;e.editedAt=new Date().toISOString();}}
  else{arr.push({id:newItemId('mm'),title,text,at:new Date().toISOString()});}
  const ok=persistMama();
  if(ok===false)return;
  resetMamaCompose();
  renderMamaList();refreshMamaButtons(key);
}

/* ---------- 卡片收合：展開後標題列會黏在畫面上方，另外卡片最下方也有「收合」鈕 ---------- */
function collapseBtnHTML(idx){return `<button type="button" class="collapse-btn" onclick="event.stopPropagation();toggleSpotDetails('${jsQuote(idx)}')">收合 ▲</button>`;}
function toggleSpotDetails(key){
  const card=document.getElementById('spot-card-'+key);
  if(!card)return;
  const willOpen=!card.classList.contains('open');
  card.classList.toggle('open',willOpen);
  if(willOpen)openSpotCardKeys.add(String(key));else openSpotCardKeys.delete(String(key));
  if(!willOpen){
    /* 收合後若卡片標題已經被捲到畫面上方，就把它帶回畫面，不必再往上找 */
    const top=card.getBoundingClientRect().top;
    if(top<0)window.scrollTo({top:Math.max(0,window.scrollY+top-8),behavior:'auto'});
  }
}

/* ---------- 開啟畫面：用標頭插圖與網站字體（安裝成 App 時才顯示） ---------- */
/* 開場動畫：只在符合 show-splash 條件（安裝成 App 後開啟，或 ?splash=1）時，
   且這個瀏覽階段（session）還沒播過，才播放；不會擋住頁面本身的資料請求。 */
/* hk13：改由 index.html 開頭與 splash.js 在頁面一開始就播放，這裡不再等 load */

/* =====================================================================
   v56：訂位連結、營業時間、照片縮圖＋大圖檢視、交通新增／刪除／圖片、修正導航視窗、新插圖
   ===================================================================== */
const ART={lying:'images/serow-sleepy.webp',suitcase:'images/serow-welcome.webp',photo:'images/serow-camera.webp',heart:'images/serow-satisfied.webp',rain:'images/serow-rainy.webp',search:'images/serow-guide.webp',car:'images/serow-point.webp',sleep:'images/serow-sleepy.webp'};
function emptyArtHTML(text,art){return `<div class="empty-art"><img src="${art||ART.lying}" alt="" loading="lazy"><p>${text}</p></div>`;}

/* ---------- 網址整理 ---------- */
function normalizeUrl(v){
  v=String(v||'').trim();if(!v)return '';
  if(/^https?:\/\//i.test(v))return v;
  if(/^[\w-]+(\.[\w-]+)+(\/|\?|#|$)/.test(v))return 'https://'+v;
  return '';
}

/* ---------- 修正導航：貼 Google 地圖網址、地址或座標 ---------- */
function openNavFixModal(idx){
  const orig=(window._spotFieldOriginals||{})[idx]||{};
  const sp=spotByKey(idx)||{};
  const name=currentFieldValue(idx,'name',orig.name||sp.name||'')||'';
  const cur=currentFieldValue(idx,'mapQuery',null)||'';
  const key=fieldOverrideKey(idx,'mapQuery');
  const finish=()=>{persistFieldOverrides();safeRenderDayContent();reopenCard(idx);};
  openFormModal({title:'修正導航'+(name?'：'+name:''),
    fields:[{id:'q',label:'貼上 Google 地圖網址（地圖 App：點店家 →「分享」→「複製連結」），也可以貼地址或座標；留空＝用名稱搜尋',type:'textarea',rows:3,value:cur,placeholder:'例：https://maps.app.goo.gl/xxxx　或　長野県上高井郡小布施町'}],
    saveText:'儲存',
    onSave:v=>{
      let q=v.q.replace(/\s+/g,' ').trim();
      if(q&&!/^https?:\/\//i.test(q)){const u=normalizeUrl(q);if(u&&/maps|goo\.gl|google/i.test(q))q=u;}
      fieldOverrideStore[key]=q||null;finish();
    },
    onDelete:cur?()=>{fieldOverrideStore[key]=null;finish();}:null});
  const wrap=document.getElementById('formModal');
  if(wrap){
    const link=document.createElement('a');link.className='nav-test';link.target='_blank';link.rel='noopener';link.textContent='用這個位置開啟 Google 地圖（測試）↗';
    const ta=wrap.querySelector('[data-f=q]');
    const upd=()=>{link.href=mapsLink(ta.value.trim()||name||cur);};upd();ta.addEventListener('input',upd);
    wrap.querySelector('.spot-edit-modal-body').appendChild(link);
  }
}

/* ---------- 訂位連結（吃） ---------- */
function resvUrl(key){return normalizeUrl(currentFieldValue(key,'resv',null)||'');}
function editResvLink(key){
  const sp=spotByKey(key)||{};
  const name=currentFieldValue(key,'name',sp.name||'')||'';
  const cur=currentFieldValue(key,'resv',null)||'';
  const k=fieldOverrideKey(key,'resv');
  const done=()=>{persistFieldOverrides();safeRenderDayContent();reopenCard(key);if(document.getElementById('spotDetailSheet'))renderSpotDetail(false);};
  openFormModal({title:'訂位連結'+(name?'：'+name:''),fields:[{id:'url',label:'訂位網址（Tabelog、Google 地圖、店家官網、預約系統…）',value:cur,placeholder:'https://…'}],saveText:'儲存',
    onSave:v=>{const u=normalizeUrl(v.url);if(v.url&&!u){alert('請貼上網址（以 https:// 開頭）');return false;}fieldOverrideStore[k]=u||null;done();},
    onDelete:cur?()=>{fieldOverrideStore[k]=null;done();}:null});
}
function resvButtonsHTML(idx,spot){
  if(!spot||spot.cat!=='food')return '';
  const u=resvUrl(idx);
  return (u?`<a class="btn btn-resv" href="${escAttr(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">訂位</a>`:'')+`<button type="button" class="btn btn-photo edit-only" onclick="event.stopPropagation();editResvLink('${jsQuote(idx)}')">${u?'改訂位連結':'＋ 訂位連結'}</button>`;
}

/* ---------- 吃·逛旅途卡片：營業時間直接顯示、訂位連結 ---------- */
function gallCardHTML(o){
  const ph=o.kind==='shop'?NAV_IC.shopping:NAV_IC.food;
  const cover=o.img?`<img src="${escAttr(o.img)}"${photoPosAttr(o.img)} loading="lazy" alt="" onerror="this.onerror=null;this.src='${ph}';this.className='ph';this.removeAttribute('style')">`:`<img class="ph" src="${ph}" alt="">`;
  const p=planOf(o.key);
  const planTag=p!=null?`<span class="gall-day">排入 D${days[p].dayNum}</span>`:(o.editId?'<span class="gall-day mine">我的</span>':'');
  const q=jsQuote(o.key);
  const walk=o.walkFrom?`<a href="${escAttr(walkLink(o.walkFrom,o.nav))}" target="_blank" rel="noopener">步行</a>`:'';
  const hrs=o.hours||currentFieldValue(o.key,'hours',null)||'';
  const hoursHTML=hrs?`<div class="gall-hours"><b>營業</b><span>${escHtml(hrs)}</span></div>`:`<button type="button" class="gall-hours-add edit-only" onclick="editSpotField(event,'${q}','hours','營業／開放時間')">＋ 營業時間</button>`;
  const rurl=o.kind==='eat'?resvUrl(o.key):'';
  const resv=o.kind==='eat'?(rurl?`<a class="resv" href="${escAttr(rurl)}" target="_blank" rel="noopener">訂位</a>`:'')+`<button type="button" class="edit-only wide" onclick="editResvLink('${q}')">${rurl?'改訂位連結':'＋ 訂位連結'}</button>`:'';
  let planBtn='';
  if(o.planDay!=null)planBtn=(p===o.planDay)?`<button type="button" class="on" onclick="unplanItem('${q}')">移出今天</button>`:`<button type="button" class="pri" onclick="planTodayQuick('${q}',${o.planDay})">排入今天</button>`;
  else planBtn=`<button type="button" class="${p!=null?'on':'pri'}" onclick="openPlanModal('${q}')">${p!=null?'改日期':'排入日期'}</button>`;
  const edit=o.editId?`<button type="button" class="edit-only" onclick="editEatShop('${o.editId}')">修改</button><button type="button" class="edit-only" onclick="deleteEatShop('${o.editId}')">刪除</button>`:(o.areaKey?`<button type="button" class="edit-only" onclick="editEatArea('${o.areaKey}')">區域</button>`:'');
  return `<article class="gall-card"><div class="gall-img" onclick="openSpotDetail('${q}')">${cover}${favBtnHTML(o.key,'on-cover')}${planTag}</div><div class="gall-body"><strong>${escHtml(o.name)}${statusChipHTML(o.key)}</strong>${hoursHTML}${o.desc?`<p>${escHtml(o.desc)}</p>`:''}<div class="gall-actions"><a href="${escAttr(mapsLink(o.nav))}" target="_blank" rel="noopener">導航</a>${walk}<button type="button" onclick="openSpotDetail('${q}')">詳情</button>${resv}${planBtn}${edit}</div></div></article>`;
}
/* ---------- 照片：大圖＋縮圖列（點縮圖換大圖，可左右切換），管理按鈕在編輯模式 ---------- */
function photoViewerHTML(idx,spot){
  const list=spotPhotoList(idx,spot);
  if(!list.length)return `<div class="pm-empty edit-only"><img src="${ART.photo}" alt=""><span>還沒有照片，按下方「上傳照片」新增</span></div>`;
  const big=detailUrlFor(idx,spot),many=list.length>1;
  const cur=Math.max(0,list.findIndex(p=>p.url===big));
  return `<div class="pv"><div class="pv-main"><img class="detail-cover" src="${escAttr(big)}"${photoPosAttr(big)} alt="" loading="lazy" onclick="openAttachModal(this.src)" onerror="imageErrorFallback(this)">${many?`<button type="button" class="pv-nav prev" onclick="pvStep(event,this,-1)" aria-label="上一張">‹</button><button type="button" class="pv-nav next" onclick="pvStep(event,this,1)" aria-label="下一張">›</button><span class="pv-count">${cur+1} / ${list.length}</span>`:''}</div>${many?`<div class="pv-strip">${list.map(p=>`<button type="button" class="pv-th ${p.url===big?'on':''}" data-src="${escAttr(p.url)}" onclick="pvShow(event,this)"><img src="${escAttr(p.url)}"${photoPosAttr(p.url)} alt="" loading="lazy"></button>`).join('')}</div>`:''}</div>`;
}
function pvShow(e,btn){
  if(e)e.stopPropagation();
  const pv=btn.closest('.pv');if(!pv)return;
  const img=pv.querySelector('.detail-cover'),ths=[...pv.querySelectorAll('.pv-th')];
  img.src=btn.dataset.src;
  const pos=photoPosStore[btn.dataset.src];
  img.style.cssText=pos?`object-fit:${pos.fit==='contain'?'contain':'cover'};object-position:${Number(pos.x)||50}% ${Number(pos.y)||50}%;`:'';
  ths.forEach(b=>b.classList.toggle('on',b===btn));
  const c=pv.querySelector('.pv-count');if(c)c.textContent=`${ths.indexOf(btn)+1} / ${ths.length}`;
  try{btn.scrollIntoView({block:'nearest',inline:'center'});}catch(_e){}
}
function pvStep(e,el,d){
  e.stopPropagation();
  const pv=el.closest('.pv'),ths=[...pv.querySelectorAll('.pv-th')];
  let k=ths.findIndex(b=>b.classList.contains('on'));k=(k+d+ths.length)%ths.length;pvShow(null,ths[k]);
}

/* ---------- 每日「交通」：不再有交通摘要；可新增步驟、刪除、加文字與圖片 ---------- */
let transportCustomStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_transport_custom'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistTransportCustom(){safeSetItem('nagano_transport_custom',transportCustomStore);}
function customTransportHTML(dayIdx){
  const list=transportCustomStore[dayIdx]||[];
  if(!list.length)return '';
  return `<h4 class="tp-sub">我新增的交通</h4><div class="transport-steps">${list.map((r,i)=>`<div class="transport-step"><span class="transport-step-no">${i+1}</span><div class="transport-step-main"><div class="transport-points"><strong>${escHtml(r.from||'')}</strong><span>→</span><strong>${escHtml(r.to||'')}</strong></div><div class="transport-meta"><b>${escHtml(r.mode||'')}</b>${r.time?`<span>${escHtml(r.time)}</span>`:''}</div>${r.note?`<small>${escHtml(r.note)}</small>`:''}<div class="edit-only tp-step-actions"><button type="button" onclick="editCustomTransport(${dayIdx},'${r.id}')">修改</button><button type="button" onclick="deleteCustomTransport(${dayIdx},'${r.id}')">刪除</button></div>${transportSegmentExtrasHTML(dayIdx,'custom-'+r.id)}</div></div>`).join('')}</div>`;
}
function transportStepFields(r){return [{id:'from',label:'起點',value:r.from||''},{id:'to',label:'終點',value:r.to||''},{id:'mode',label:'交通方式／路線',value:r.mode||'',placeholder:'例：北陸新幹線、JR 根岸線、自駕、步行'},{id:'time',label:'預估時間',value:r.time||'',placeholder:'例：約 30 分鐘'},{id:'note',label:'備註',type:'textarea',rows:3,value:r.note||''}];}
function addTransportStep(dayIdx){
  const r={id:newItemId('ts'),from:'',to:'',mode:'',time:'',note:''};
  openFormModal({title:`新增交通（D${days[dayIdx].dayNum}）`,fields:transportStepFields(r),saveText:'新增',onSave:v=>{if(!v.from&&!v.to&&!v.mode){alert('請至少填寫起點、終點或交通方式');return false;}Object.assign(r,v);(transportCustomStore[dayIdx]=transportCustomStore[dayIdx]||[]).push(r);persistTransportCustom();renderDayContent();}});
}
function editCustomTransport(dayIdx,id){
  const r=(transportCustomStore[dayIdx]||[]).find(x=>x.id===id);if(!r)return;
  openFormModal({title:'修改交通',fields:transportStepFields(r),onSave:v=>{Object.assign(r,v);persistTransportCustom();renderDayContent();},onDelete:()=>deleteCustomTransport(dayIdx,id,true)});
}
function deleteCustomTransport(dayIdx,id,skip){
  if(!skip&&!confirm('確定刪除這個交通步驟？（5 秒內可復原）'))return;
  const arr=transportCustomStore[dayIdx]||[],i=arr.findIndex(x=>x.id===id);if(i<0)return;
  const removed=arr.splice(i,1)[0];if(!arr.length)delete transportCustomStore[dayIdx];
  persistTransportCustom();renderDayContent();
  offerUndo('已刪除交通步驟',()=>{(transportCustomStore[dayIdx]=transportCustomStore[dayIdx]||[]).splice(Math.min(i,(transportCustomStore[dayIdx]||[]).length),0,removed);persistTransportCustom();renderDayContent();});
}
/* hk11：每段交通直接「導航到目的地」；搭計程車的段落多一個「給司機看」大字卡 */
function tpDestination(dayIdx,toText,isLast){
  const raw=String(toText||'').trim();
  const core=raw.replace(/[（(][^）)]*[）)]/g,'').trim();
  if(/^(飯店|住宿|旅館|回飯店)$/.test(core)){
    /* 一天最後一段「回飯店」＝今晚住的；白天中途「回飯店」＝昨晚住的那間 */
    const tonight=dayStays(dayIdx)[0],lastNight=dayStays(prevPlanDay(dayIdx))[0]||null;
    const st=isLast?(tonight||lastNight):(lastNight||tonight);
    if(st)return {name:st.name,nav:st.nav};
  }
  if(!core)return null;
  const list=[...getNaturalList(dayIdx,'main'),...getNaturalList(dayIdx,'life'),...(prevPlanDay(dayIdx)>=0?getNaturalList(prevPlanDay(dayIdx),'life').filter(o=>o.spot.cat==='hotel'):[])].filter(o=>o.spot&&!o.spot.pool&&o.spot.cat!=='transport');
  const hit=list.find(o=>{const n=currentFieldValue(o.key,'name',o.spot.name)||o.spot.name;return n===core||n.includes(core)||core.includes(n);});
  if(hit){const n=currentFieldValue(hit.key,'name',hit.spot.name)||hit.spot.name;return {name:n,nav:currentFieldValue(hit.key,'mapQuery',null)||hit.spot.mapQuery||n};}
  return {name:core,nav:core};
}
function tpTravelMode(mode){
  const m=String(mode||'');
  if(/步行|🚶/.test(m))return 'walking';
  if(/計程車|自駕|開車|🚕|🚗|🚙/.test(m))return 'driving';
  return 'transit';
}
function tpDirLink(nav,travelmode){
  const v=String(nav||'').trim();
  if(/^https?:\/\//i.test(v))return v;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(/^[-+]?\d/.test(v)?v:v+' Japan')}&travelmode=${travelmode}`;
}
function tpGoButtonsHTML(dayIdx,r,isLast){
  if(/✈️|航空|飛機/.test(String(r.mode||'')))return '';
  const dest=tpDestination(dayIdx,r.to,isLast);if(!dest)return '';
  const tm=tpTravelMode(r.mode);
  const taxi=/計程車|🚕/.test(String(r.mode||'')+' '+String(r.note||''));
  return `<div class="tp-go"><a href="${escAttr(tpDirLink(dest.nav,tm))}" target="_blank" rel="noopener">導航到 ${escHtml(dest.name)}</a>${taxi?`<button type="button" data-name="${escAttr(dest.name)}" data-nav="${escAttr(dest.nav)}" onclick="showDriverCard(this.dataset.name,this.dataset.nav)">給司機看</button>`:''}</div>`;
}
/* 給司機看的日文資料（日文名稱、在哪裡下車）。可在編輯模式修改，修改會同步給家人。
   地址只放有確認過的；不確定的就不寫，避免讓司機開錯地方。比對時名稱包含關鍵字即可。 */
const DRIVER_INFO=[
  ['高崎站周邊',{ja:'高崎駅',drop:'高崎駅の近くのホテルまでお願いします。',dropZh:'到高崎站附近的飯店。'}],
  ['少林山',{ja:'少林山達磨寺'}],
  ['達摩彩繪',{ja:'だるま絵付け体験の工房'}],
  ['ふじの咲く丘',{ja:'ふじの咲く丘（藤岡市）'}],
  ['Lomä',{ja:'Lomä（長野県信濃町）',drop:'ホテルの正面入口までお願いします。',dropZh:'到飯店正門口。'}],
  ['藤井荘',{ja:'緑霞山宿 藤井荘（山田温泉）',drop:'旅館の玄関までお願いします。',dropZh:'到旅館玄關。'}],
  ['長野站周邊',{ja:'長野駅',drop:'長野駅の近くのホテルまでお願いします。',dropZh:'到長野站附近的飯店。'}],
  ['橫濱站周邊',{ja:'横浜駅',drop:'横浜駅の近くのホテルまでお願いします。',dropZh:'到橫濱站附近的飯店。'}],
  ['いもり池',{ja:'いもり池（妙高高原）'}],
  ['野尻湖',{ja:'野尻湖'}],
  ['戶隱神社 中社',{ja:'戸隠神社 中社'}],
  ['奧社',{ja:'戸隠神社 奥社 入口'}],
  ['善光寺',{ja:'善光寺'}],
  ['北齋館',{ja:'北斎館'}],
  ['小布施',{ja:'小布施'}],
  ['港未來',{ja:'みなとみらい'}],
  ['紅磚倉庫',{ja:'横浜赤レンガ倉庫'}],
  ['Bayside',{ja:'三井アウトレットパーク 横浜ベイサイド'}],
  ['羽田',{ja:'羽田空港 第3ターミナル',drop:'第3ターミナル（国際線）でお願いします。',dropZh:'到第 3 航廈（國際線）。'}],
  ['成田',{ja:'成田空港'}],
  ['長野站',{ja:'JR長野駅'}],
  ['高崎站',{ja:'JR高崎駅'}],
  ['橫濱站',{ja:'JR横浜駅'}]
];
const DRIVER_FIELDS=['ja','addr','drop','dropZh'];
function driverInfo(name){
  const hit=DRIVER_INFO.find(([k])=>String(name).includes(k));
  const base=hit?hit[1]:{};const key='drv:'+name,out={};
  DRIVER_FIELDS.forEach(f=>{const v=currentFieldValue(key,f,base[f]||null);if(v)out[f]=v;});
  return out;
}
function showDriverCard(name,nav){
  document.getElementById('driverCard')?.remove();
  const info=driverInfo(name);
  const el=document.createElement('div');el.id='driverCard';el.className='driver-card';
  el.innerHTML=`<div class="driver-card-inner">
    <p class="driver-ja">ここまでお願いします</p><p class="driver-zh">（請載我到這裡）</p>
    <div class="driver-name${String(info.ja||name).length>12?' long':''}">${escHtml(info.ja||name)}</div>${info.ja&&info.ja!==name?`<div class="driver-name-zh">${escHtml(name)}</div>`:''}
    ${info.addr?`<div class="driver-addr"><small>住所</small>${escHtml(info.addr)}</div>`:''}
    ${info.drop?`<div class="driver-drop"><small>降りる場所</small><b>${escHtml(info.drop)}</b>${info.dropZh?`<span>${escHtml(info.dropZh)}</span>`:''}</div>`:''}
    <a class="driver-map" href="${escAttr(mapsLink(nav))}" target="_blank" rel="noopener">打開地圖給司機看</a>
    <button type="button" class="driver-edit edit-only">修改日文名稱／下車地點</button>
    <button type="button" class="driver-close">關閉</button></div>`;
  el.querySelector('.driver-close').onclick=()=>el.remove();
  el.querySelector('.driver-edit').onclick=()=>{el.remove();editDriverInfo(name,nav);};
  el.addEventListener('click',e=>{if(e.target===el)el.remove();});
  document.body.appendChild(el);
}
function editDriverInfo(name,nav){
  const info=driverInfo(name),key='drv:'+name;
  openFormModal({title:'給司機看：'+name,fields:[
    {id:'ja',label:'日文名稱（司機看的大字）',value:info.ja||'',placeholder:'例：緑霞山宿 藤井荘'},
    {id:'addr',label:'日文地址（選填）',value:info.addr||''},
    {id:'drop',label:'在哪裡下車（日文，給司機看）',type:'textarea',rows:2,value:info.drop||'',placeholder:'例：正面入口までお願いします。'},
    {id:'dropZh',label:'在哪裡下車（中文，給自己看）',type:'textarea',rows:2,value:info.dropZh||''}],saveText:'儲存',
    onSave:v=>{DRIVER_FIELDS.forEach(f=>{fieldOverrideStore[fieldOverrideKey(key,f)]=v[f]||'';});persistFieldOverrides();showDriverCard(name,nav);}});
}
function transportAddBarHTML(dayIdx){
  return `<div class="tp-add edit-only"><button type="button" onclick="addTransportStep(${dayIdx})">＋ 新增交通步驟</button></div>${transportSegmentExtrasHTML(dayIdx,'panel')}`;
}

/* ---------- 新插圖用在合適的地方 ---------- */
const SURPRISE_ART={tip:'images/sp-guide.webp',joke:'images/sp-laugh.webp',care:'images/sp-tea.webp',photo:'images/sp-camera.webp'};
(function extendArt(){
  CRITTER_IMGS.push(ART.suitcase,ART.photo,ART.heart,ART.rain,ART.search,ART.car);
})();

/* 每日「天氣提示條」左側圖示：原本直接顯示系統 emoji（尤其船槳／茶杯等圖示很花俏、跟手繪插畫風格不搭），
   改成統一風格的線條小圖示，顏色跟其他圖示一致。 */
const DAY_ICON_PATHS={
  '\ud83c\udf41':'<path d="M12 2c.8 2 2 3.1 3.6 3.6-1 .9-1.6 1.9-1.8 3 1.7-.3 3-.1 4.2.7-1.4 1-2 2.2-2 3.7 1.7 0 3 .6 4 2-1.6.9-3.1.9-4.6.1.3 1.6 0 3-1 4.3-1-.9-1.6-1.9-1.8-3.1-.6 1.1-.5 2.3.1 3.7-1.7-.2-2.9-1-3.7-2.4-.4 1.4-1.3 2.3-2.8 2.8.2-1.6.9-2.8 2.1-3.7-1.6-.1-2.9.4-4 1.6-.4-1.7.1-3.1 1.4-4.3-1.6-.3-3.1.1-4.4 1.1.2-1.8 1.2-3 3-3.7-1-.9-2.3-1.2-3.9-.9 1-1.4 2.4-2.1 4.2-2C9.8 5.5 10.8 4 12 2z" fill="currentColor" stroke="none"/><path d="M12 11v9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  '\ud83c\udf42':'<path d="M12 2c.8 2 2 3.1 3.6 3.6-1 .9-1.6 1.9-1.8 3 1.7-.3 3-.1 4.2.7-1.4 1-2 2.2-2 3.7 1.7 0 3 .6 4 2-1.6.9-3.1.9-4.6.1.3 1.6 0 3-1 4.3-1-.9-1.6-1.9-1.8-3.1-.6 1.1-.5 2.3.1 3.7-1.7-.2-2.9-1-3.7-2.4-.4 1.4-1.3 2.3-2.8 2.8.2-1.6.9-2.8 2.1-3.7-1.6-.1-2.9.4-4 1.6-.4-1.7.1-3.1 1.4-4.3-1.6-.3-3.1.1-4.4 1.1.2-1.8 1.2-3 3-3.7-1-.9-2.3-1.2-3.9-.9 1-1.4 2.4-2.1 4.2-2C9.8 5.5 10.8 4 12 2z" fill="currentColor" stroke="none" opacity=".82"/><path d="M12 11v9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  '\ud83c\udf75':'<path d="M4 9h13v2a6.5 6.5 0 0 1-6.5 6.5H10A6 6 0 0 1 4 11.5V9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 10h1.5a2.3 2.3 0 0 1 0 4.6H17" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3.5c.6.8.6 1.4 0 2.2M11.3 3.5c.6.8.6 1.4 0 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3.5 19.5h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  '\ud83d\udea3':'<path d="M4.5 12.5h15l-2.3 4.3a2 2 0 0 1-1.8 1.1H8.6a2 2 0 0 1-1.8-1.1z" fill="currentColor" stroke="none"/><path d="M9.3 12.5V4M9.3 4l2.4 1.5M9.3 4 6.9 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 19.3c1.6 1 3.2 1 4.8 0 1.6-1 3.2-1 4.8 0 1.6 1 3.2 1 4.8 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".55"/>',
  '\ud83c\udf0a':'<path d="M2 13.5c1.6 1.4 3.2 1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M2 17.8c1.6 1.4 3.2 1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0 1.6-1.4 3.2-1.4 4.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity=".5"/>',
  '\ud83d\ude97':'<path d="M4 16.5V13l1.6-4.2A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.3L20 13v3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 13h16" stroke="currentColor" stroke-width="1.6"/><circle cx="7.5" cy="16.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16.5" cy="16.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  '\ud83c\udf09':'<path d="M3 17.5c4-9 14-9 18 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 17.5v-9M21 17.5v-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6.5 17.5v-6M12 17.5v-7.6M17.5 17.5v-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  '\u2693':'<circle cx="12" cy="5.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 9.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 14c0 3.5 3 6 7 6s7-2.5 7-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  '\u2708\ufe0f':'<path d="M12 2.5c.7 0 1.2.6 1.2 1.4v6l6.8 4v2l-6.8-2v3.8l2 1.6v1.5l-3.2-1-3.2 1v-1.5l2-1.6v-3.8l-6.8 2v-2l6.8-4v-6c0-.8.5-1.4 1.2-1.4z" fill="currentColor" stroke="none"/>'
};
function dayIconSVG(emoji){
  const d=DAY_ICON_PATHS[emoji];
  if(!d)return escHtml(emoji||'');
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">${d}</svg>`;
}

/* 每日交通提示條的圖示：改用你提供的主題插畫（依當天路線挑選），沒有對應插畫的日子維持線條小圖示。 */
const DAY_ICON_IMG=Object.fromEntries(Array.from({length:14},(_,i)=>[i,`images/day${String(i).padStart(2,'0')}.webp`]));
function dayIconHTML(dayIdx,emoji){
  const img=DAY_ICON_IMG[dayIdx];
  if(img)return `<img src="${img}" alt="" loading="lazy">`;
  return dayIconSVG(emoji);
}


/* =====================================================================
   hk11：移植自京丹雅行 v73–v76——評論多行編輯、吃逛自訂區域與排序、副景點（含照片）、景點改日期
   ===================================================================== */
function editBuiltInInfo(key){
  const fallback=window._spotCustomInfoOriginals[key]||null;
  const current=currentBuiltInInfo(key,fallback);
  openFormModal({title:'修改評論與資訊',fields:[{id:'t',label:'內容（可以換行、貼上長文字）',type:'textarea',rows:12,value:String(current==null?'':current).replace(/<br\s*\/?>/gi,'\n')}],saveText:'儲存',
    onSave:v=>{infoOverrideStore[key]=v.t.trim()||null;persistInfoOverrides();renderDayContent();reopenCard(key);},
    onDelete:()=>{deleteBuiltInInfo(key);}});
}
function editNote(key,noteIdx){
  if(!notesStore[key]||typeof notesStore[key][noteIdx]==='undefined')return;
  openFormModal({title:'修改評論與資訊',fields:[{id:'t',label:'內容（可以換行、貼上長文字）',type:'textarea',rows:12,value:notesStore[key][noteIdx]}],saveText:'儲存',
    onSave:v=>{if(!v.t){alert('內容不能是空的；要刪掉請按「刪除」。');return false;}notesStore[key][noteIdx]=v.t;persistNotes();renderDayContent();reopenCard(key);},
    onDelete:()=>{deleteNote(key,noteIdx);}});
}

/* ---------- 吃·逛旅途：自訂區域 ---------- */
function addEatArea(){
  openFormModal({title:'新增區域',fields:[{id:'name',label:'區域名稱（例如：善光寺表參道、港未來、中華街）',value:''}],saveText:'新增',
    onSave:v=>{
      if(!v.name){alert('請輸入區域名稱');return false;}
      if(allEatAreas().includes(v.name)){alert('已經有同名的區域了');return false;}
      eatAreaCustom.push(v.name);persistEatAreaCustom();
      if(v.origin){AREA_ORIGIN[v.name]=v.origin;const o=readAreaOrigins();o[v.name]=v.origin;try{localStorage.setItem('nagano_area_origin',JSON.stringify(o));}catch(e){}}
      safeRenderDayContent();
    }});
}
function readAreaOrigins(){try{return JSON.parse(localStorage.getItem('nagano_area_origin'))||{};}catch(e){return {};}}
Object.assign(AREA_ORIGIN,readAreaOrigins());
function renameEatArea(name){
  openFormModal({title:'區域改名',fields:[{id:'name',label:'新的區域名稱',value:name}],saveText:'儲存',
    onSave:v=>{
      if(!v.name){alert('請輸入名稱');return false;}
      if(v.name!==name&&allEatAreas().includes(v.name)){alert('已經有同名的區域了');return false;}
      eatAreaCustom=eatAreaCustom.map(x=>x===name?v.name:x);persistEatAreaCustom();
      if(eatAreaOrder.includes(name)){eatAreaOrder=eatAreaOrder.map(x=>x===name?v.name:x);persistEatAreaOrder();}
      Object.keys(eatAreaStore).forEach(k=>{if(eatAreaStore[k]===name)eatAreaStore[k]=v.name;});persistEatArea();
      eatShopStore.forEach(c=>{if(c.area===name)c.area=v.name;});persistEatShop();
      if(AREA_ORIGIN[name]){AREA_ORIGIN[v.name]=AREA_ORIGIN[name];delete AREA_ORIGIN[name];}
      safeRenderDayContent();
    }});
}
function deleteEatArea(name){
  if(!confirm(`刪除「${name}」這個區域？裡面的項目不會被刪掉，會移到「未分區」。`))return;
  eatAreaCustom=eatAreaCustom.filter(x=>x!==name);persistEatAreaCustom();
  safeRenderDayContent();
}

/* ---------- 副景點：在景點卡片展開後，可再新增掛在底下的小景點 ---------- */
let subSpotStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_sub_spots'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistSubSpots(){safeSetItem('nagano_sub_spots',subSpotStore);}
function subSpotsFor(key){return Array.isArray(subSpotStore[key])?subSpotStore[key]:[];}
function subSpotFields(r){return [
  {id:'name',label:'副景點名稱（必填）',value:r.name||'',placeholder:'例：小布施堂 本店'},
  {id:'dur',label:'建議停留時間（選填）',value:r.dur||'',placeholder:'例：約 40 分鐘'},
  {id:'note',label:'介紹／備註（選填，可換行）',type:'textarea',rows:6,value:r.note||'',placeholder:'例：參道旁的茶屋可以吃剛烤好的栗子點心。'},
  {id:'nav',label:'導航位置（選填：Google 地圖網址、地址或座標；留空＝用名稱搜尋）',value:r.nav||''},
  {id:'files',label:(r.imgs&&r.imgs.length?`照片（目前 ${r.imgs.length} 張；選擇的照片會再加上去，可一次選多張）`:'照片（選填，可一次選多張）'),type:'files'}];}
async function uploadSubSpotFiles(files){
  const urls=[];
  for(const f of files||[]){try{urls.push(await uploadMediaFile(f,'sub-spots'));}catch(err){reportUploadError(err);break;}}
  return urls;
}
function subSpotImgsHTML(key,r){
  const imgs=Array.isArray(r.imgs)?r.imgs:[];
  const q=jsQuote(key);
  const th=imgs.map((u,i)=>`<div class="sub2-ph"><img src="${escAttr(u)}" data-src="${escAttr(u)}" alt="" loading="lazy" onclick="event.stopPropagation();openAttachModal(this.dataset.src)"><button type="button" class="edit-only" aria-label="移除這張照片" onclick="event.stopPropagation();removeSubSpotImg('${q}','${r.id}',${i})">✕</button></div>`).join('');
  const add=`<label class="sub2-ph-add edit-only" onclick="event.stopPropagation()">＋ 照片<input type="file" accept="image/*" multiple hidden onchange="addSubSpotImgs(event,'${q}','${r.id}')"></label>`;
  return `<div class="sub2-phs${imgs.length?'':' no-img'}">${th}${add}</div>`;
}
async function addSubSpotImgs(e,key,id){
  const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;
  updateSyncStatus(null,'saving');
  const urls=await uploadSubSpotFiles(files);if(!urls.length)return;
  const r=subSpotsFor(key).find(x=>x.id===id);if(!r)return;
  r.imgs=[...(Array.isArray(r.imgs)?r.imgs:[]),...urls];persistSubSpots();afterSubSpotChange(key);
}
function removeSubSpotImg(key,id,i){
  const r=subSpotsFor(key).find(x=>x.id===id);if(!r||!Array.isArray(r.imgs))return;
  if(!confirm('移除這張照片？（5 秒內可復原）'))return;
  const removed=r.imgs.splice(i,1)[0];persistSubSpots();afterSubSpotChange(key);
  offerUndo('已移除照片',()=>{const t=subSpotsFor(key).find(x=>x.id===id);if(!t)return;t.imgs=Array.isArray(t.imgs)?t.imgs:[];t.imgs.splice(Math.min(i,t.imgs.length),0,removed);persistSubSpots();afterSubSpotChange(key);});
}
function subSpotsHTML(idx){
  const list=subSpotsFor(idx);
  const q=jsQuote(idx);
  const items=list.map(r=>`<div class="sub2"><div class="sub2-main"><b>${escHtml(r.name)}</b>${r.dur?`<span class="sub2-dur">${escHtml(r.dur)}</span>`:''}${r.note?`<p>${escHtml(r.note)}</p>`:''}${subSpotImgsHTML(idx,r)}</div><div class="sub2-acts"><a class="sub2-nav" href="${escAttr(mapsLink(r.nav||r.name))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">導航</a><span class="edit-only sub2-edit"><button type="button" onclick="event.stopPropagation();editSubSpot('${q}','${r.id}')">編輯</button><button type="button" class="del" onclick="event.stopPropagation();deleteSubSpot('${q}','${r.id}')">刪除</button></span></div></div>`).join('');
  if(!items)return `<div class="subspots edit-only" onclick="event.stopPropagation()"><button type="button" class="subspots-add" onclick="event.stopPropagation();addSubSpot('${q}')">＋ 新增副景點</button></div>`;
  return `<div class="subspots" onclick="event.stopPropagation()"><div class="subspots-head"><b>副景點</b><em>${list.length}</em></div>${items}<button type="button" class="subspots-add edit-only" onclick="event.stopPropagation();addSubSpot('${q}')">＋ 新增副景點</button></div>`;
}
function afterSubSpotChange(key){renderDayContent();reopenCard(key);if(document.getElementById('spotDetailSheet'))renderSpotDetail(false);}
function addSubSpot(key){
  const parent=(spotByKey(key)||{}).name||'';
  openFormModal({title:'新增副景點'+(parent?'：'+parent:''),fields:subSpotFields({}),saveText:'新增',
    onSave:v=>{
      if(!v.name){alert('請輸入副景點名稱');return false;}
      return (async()=>{
        const imgs=v.files&&v.files.length?await uploadSubSpotFiles(v.files):[];
        (subSpotStore[key]=subSpotStore[key]||[]).push({id:newItemId('ss'),name:v.name,dur:v.dur,note:v.note,nav:v.nav,imgs});
        persistSubSpots();afterSubSpotChange(key);
      })();
    }});
}
function editSubSpot(key,id){
  const r=subSpotsFor(key).find(x=>x.id===id);if(!r)return;
  openFormModal({title:'編輯副景點',fields:subSpotFields(r),saveText:'儲存',
    onSave:v=>{if(!v.name){alert('名稱不能是空的');return false;}
      return (async()=>{
        const add=v.files&&v.files.length?await uploadSubSpotFiles(v.files):[];
        const cur=subSpotsFor(key).find(x=>x.id===id)||r;
        Object.assign(cur,{name:v.name,dur:v.dur,note:v.note,nav:v.nav,imgs:[...(Array.isArray(cur.imgs)?cur.imgs:[]),...add]});persistSubSpots();afterSubSpotChange(key);
      })();},
    onDelete:()=>deleteSubSpot(key,id,true)});
}
function deleteSubSpot(key,id,skipConfirm){
  const arr=subSpotsFor(key),i=arr.findIndex(x=>x.id===id);if(i<0)return;
  if(!skipConfirm&&!confirm(`刪除副景點「${arr[i].name}」？（5 秒內可復原）`))return;
  const removed=arr.splice(i,1)[0];if(!arr.length)delete subSpotStore[key];
  persistSubSpots();afterSubSpotChange(key);
  offerUndo('已刪除副景點',()=>{(subSpotStore[key]=subSpotStore[key]||[]).splice(Math.min(i,(subSpotStore[key]||[]).length),0,removed);persistSubSpots();afterSubSpotChange(key);});
}

/* ---------- 景點改日期 ---------- */
var spotDayStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_spot_day'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistSpotDay(){safeSetItem('nagano_spot_day',spotDayStore);}
function naturalDayOf(key){const m=String(key).match(/^d(\d+)-[msc]\d+$/);return m&&days[Number(m[1])]?Number(m[1]):null;}
function spotDayOf(key){
  const v=(spotDayStore||{})[key];
  if(typeof v==='number'&&days[v])return v;
  return naturalDayOf(key);
}
function isSpotMoved(key){const n=naturalDayOf(key),e=spotDayOf(key);return n!=null&&e!==n;}
/* 所有「放在 dayIdx 這天」的內建與自訂景點（含從別天移過來的） */
function spotsShownOnDay(dayIdx){
  const fixed=[],custom=[];
  days.forEach((d,di)=>{
    if(!inPlan(di))return;
    d.spots.forEach((s,i)=>{const key=`d${di}-m${i}`;if(!s.removed&&spotDayOf(key)===dayIdx)fixed.push({spot:s,key,fixedMeta:{dayIdx}});});
    (d.moreSpots||[]).forEach((s,i)=>{const key=`d${di}-s${i}`;if(spotDayOf(key)===dayIdx)fixed.push({spot:s,key,fixedMeta:{dayIdx}});});
    getCustomSpots(di).forEach((s,i)=>{const key=`d${di}-c${i}`;if(!s.deleted&&spotDayOf(key)===dayIdx)custom.push({spot:s,key,customMeta:{dayIdx:di,i}});});
  });
  return {fixed,custom};
}
function openSpotDayModal(key){
  const spot=spotByKey(key);if(!spot)return;
  const cur=spotDayOf(key),nat=naturalDayOf(key);
  const name=currentFieldValue(key,'name',spot.name)||spot.name;
  openFormModal({title:'改日期：'+name,fields:[{id:'day',label:'要放在哪一天？（筆記、照片、評論都會一起搬過去）',type:'select',value:String(cur),options:days.map((d,i)=>({value:String(i),label:`D${d.dayNum}・${d.date}（週${d.weekday}）${d.title}${i===nat?'　← 原本':''}`})).filter(o=>inPlan(o.value))}],saveText:'搬過去',
    onSave:v=>{
      const to=Number(v.day);if(!days[to]||to===cur)return;
      const prev=Object.prototype.hasOwnProperty.call(spotDayStore,key)?spotDayStore[key]:undefined;
      if(to===nat)delete spotDayStore[key];else spotDayStore[key]=to;
      persistSpotDay();
      if(hiddenFixedSpotsStore[to]&&hiddenFixedSpotsStore[to].includes(key)){hiddenFixedSpotsStore[to]=hiddenFixedSpotsStore[to].filter(k=>k!==key);persistHiddenFixedSpots();}
      renderDayChips();renderDayContent();updateSpotCount&&updateSpotCount();
      offerUndo(`已把「${name}」搬到 D${days[to].dayNum}・${days[to].date}`,()=>{if(prev===undefined)delete spotDayStore[key];else spotDayStore[key]=prev;persistSpotDay();renderDayChips();renderDayContent();});
    }});
}

/* ============ hk19（移植京丹雅行 v85）：出發前待辦（全家共用，誰勾的會顯示名字） ============ */
const TODO_SEED=[
  {id:'todo-plan',text:'全家決定走 Lomä 山湖版還是藤井莊溪谷版（右上切換可以比較）',due:'2026-12-31'},
  {id:'todo-stay2',text:'先訂連住兩晚的旅館：確認 4/27、4/28 都有房、兩晚餐食與設施預約',due:'2027-01-15'},
  {id:'todo-hotels',text:'訂高崎（3 晚）、長野（2 晚，要有停車場）、橫濱（2 晚）車站步行範圍的飯店，比對取消條款',due:'2027-01-31'},
  {id:'todo-flight',text:'2027 班表公布後，用多城市方式買「台灣 → 成田、羽田 → 台灣」機票',due:'2027-01-31'},
  {id:'todo-car',text:'預約租車：4/26 高崎 1 天、4/27–4/30 長野 4 天；比對人數、行李件數與後車廂，詢問輪胎',due:'2027-02-28'},
  {id:'todo-license',text:'每位駕駛準備駕照日文譯本（國際駕照），確認有效期限',due:'2027-03-31'},
  {id:'todo-daruma',text:'達摩彩繪工房（大門屋或今井だるま店 NAYA）：確認 4/25 成人方案與預約方式',due:'2027-03-31'},
  {id:'todo-insurance',text:'保旅遊平安險＋旅遊不便險',due:'2027-04-10'},
  {id:'todo-vjw',text:'每個人填好 Visit Japan Web（入境與海關資料），截圖 QR Code',due:'2027-04-17'},
  {id:'todo-shinkansen',text:'新幹線指定席：搭乘日前 1 個月開售，熱門日期與班次先訂（4/24、4/27、5/1）',due:'2027-04-01'},
  {id:'todo-flowers',text:'查 2027 藤岡紫藤、小布施八重櫻的花況，決定 4/25、4/26 要不要互換',due:'2027-04-20'},
  {id:'todo-togakushi',text:'查戶隱奧社參道開山與殘雪消息、山區道路狀況',due:'2027-04-22'},
  {id:'todo-ic',text:'準備 Suica（手機或實體卡），先儲值',due:'2027-04-17'},
  {id:'todo-sim',text:'買網卡／eSIM，或開通漫遊',due:'2027-04-17'},
  {id:'todo-yen',text:'換日幣（小額現金：寺院、小店、停車場）',due:'2027-04-17'},
  {id:'todo-hotel-check',text:'確認每間飯店的入住時間、行李寄放、早晚餐與停車',due:'2027-04-17'},
  {id:'todo-login',text:'每位家人都用自己的手機登入這個網站一次，並在 ⚙️ 下載離線圖片',due:'2027-04-20'},
  {id:'todo-checkin',text:'去程航班線上報到',due:'2027-04-23'}
].map(t=>({...t,done:false,note:''}));
let todoData=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_todos'));return Array.isArray(v)?normalizeStructuredList('nagano_todos',v):structuredClone(TODO_SEED);}catch(e){return structuredClone(TODO_SEED);}})();
function persistTodos(){safeSetItem('nagano_todos',todoData);}
function todoWho(){
  try{const e=(familyAuthSession&&familyAuthSession.email)||(readAuthSession()&&readAuthSession().email)||'';return e?e.split('@')[0]:'';}catch(e){return '';}
}
function todoDaysLeft(due){
  if(!due)return null;const m=String(due).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;
  const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));const t=new Date();t.setHours(0,0,0,0);
  return Math.round((d-t)/86400000);
}
function todoDueHTML(due,done){
  const n=todoDaysLeft(due);if(n==null)return '';
  const m=due.slice(5).replace('-','/').replace(/^0/,'');
  if(done)return `<span class="td-due">${m}</span>`;
  const cls=n<0?'late':n<=3?'soon':'';
  const txt=n<0?`${m}・已過 ${-n} 天`:n===0?`${m}・今天`:`${m}・還有 ${n} 天`;
  return `<span class="td-due ${cls}">${txt}</span>`;
}
function todoSorted(){
  const key=t=>t.due||'9999-99-99';
  return todoData.map((t,i)=>({t,i})).sort((a,b)=>(a.t.done-b.t.done)||key(a.t).localeCompare(key(b.t))||(a.i-b.i));
}
function renderTodos(){
  const wrap=document.getElementById('todoListWrap');
  const left=todoData.filter(t=>!t.done).length,total=todoData.length;
  if(wrap){
    const rows=todoSorted();
    const row=({t})=>`<div class="td-item${t.done?' done':''}"><label class="td-check"><input type="checkbox" ${t.done?'checked':''} onchange="toggleTodo('${jsQuote(t.id)}',this.checked)"><span class="td-box" aria-hidden="true"></span></label><div class="td-main"><div class="td-text">${escHtml(t.text)}</div>${t.note?`<div class="td-note">${brText(t.note)}</div>`:''}<div class="td-meta">${todoDueHTML(t.due,t.done)}${t.done&&t.doneBy?`<span class="td-by">✓ ${escHtml(t.doneBy)} 完成</span>`:''}</div></div><div class="td-acts edit-only"><button type="button" onclick="editTodo('${jsQuote(t.id)}')">修改</button><button type="button" class="del" onclick="deleteTodo('${jsQuote(t.id)}')">刪除</button></div></div>`;
    const undone=rows.filter(x=>!x.t.done),done=rows.filter(x=>x.t.done);
    wrap.innerHTML=`<div class="td-progress"><div class="td-bar"><i style="width:${total?Math.round((total-left)/total*100):0}%"></i></div><b>${left?`還有 ${left} 項`:'全部完成 🎉'}</b><small>已完成 ${total-left} / ${total}</small></div>
      <div class="td-list">${undone.map(row).join('')||'<div class="empty compact">都完成了！</div>'}</div>
      ${done.length?`<details class="td-done"><summary>已完成（${done.length}）</summary>${done.map(row).join('')}</details>`:''}
      <button type="button" class="td-add" onclick="addTodo()">＋ 新增待辦</button>`;
  }
  /* 收合時標題下仍顯示進度 */
  const sec=document.getElementById('todoSection');
  if(sec&&!sec.dataset.init){sec.dataset.init='1';let o=null;try{o=localStorage.getItem('nagano_todo_open');}catch(e){}sec.open=o==='1';}
  const sum=document.getElementById('todoSumLine');
  if(sum){const soon=todoData.filter(t=>!t.done&&(n=>n!=null&&n<=3)(todoDaysLeft(t.due))).length;sum.textContent=left?`還有 ${left} 項／共 ${total} 項${soon?`・${soon} 項快到期`:''}`:`全部完成 🎉（${total} 項）`;sum.classList.toggle('alert',!!soon);}
  renderTodoBanner();
}
function toggleTodo(id,checked){
  const t=todoData.find(x=>x.id===id);if(!t)return;
  t.done=!!checked;if(checked){t.doneBy=todoWho();t.doneAt=new Date().toISOString();}else{delete t.doneBy;delete t.doneAt;}
  persistTodos();renderTodos();
}
function todoFields(t){return [
  {id:'text',label:'要做什麼',type:'textarea',rows:2,value:t.text||'',placeholder:'例：預約達摩彩繪體驗'},
  {id:'due',label:'最晚哪天前完成（選填）',type:'date',value:t.due||''},
  {id:'note',label:'備註（選填：預約編號、網址、誰負責…）',type:'textarea',rows:3,value:t.note||''}];}
function addTodo(){
  openFormModal({title:'新增出發前待辦',fields:todoFields({}),saveText:'新增',onSave:v=>{
    if(!v.text){alert('請輸入要做什麼');return false;}
    todoData.push({id:newItemId('todo'),text:v.text,due:v.due,note:v.note,done:false});persistTodos();renderTodos();}});
}
function editTodo(id){
  const t=todoData.find(x=>x.id===id);if(!t)return;
  openFormModal({title:'修改待辦',fields:todoFields(t),saveText:'儲存',onSave:v=>{
    if(!v.text){alert('內容不能是空的');return false;}
    Object.assign(t,{text:v.text,due:v.due,note:v.note});persistTodos();renderTodos();},onDelete:()=>deleteTodo(id,true)});
}
function deleteTodo(id,skipConfirm){
  const i=todoData.findIndex(x=>x.id===id);if(i<0)return;
  if(!skipConfirm&&!confirm(`刪除待辦「${todoData[i].text}」？（8 秒內可復原）`))return;
  const removed=todoData.splice(i,1)[0];persistTodos();renderTodos();
  offerUndo('已刪除待辦',()=>{todoData.splice(Math.min(i,todoData.length),0,removed);persistTodos();renderTodos();});
}
/* 行程頁頂端：出發前才顯示「出發前待辦還有幾項」，點了直接跳到清單 */
function renderTodoBanner(){
  /* ng3：出發準備只放在指南頁，行程頁不顯示提示卡 */
  document.getElementById('todoBanner')?.remove();
}
function goToTodos(){const sec=document.getElementById('todoSection');if(sec)sec.open=true;setTab('guide');setTimeout(()=>document.getElementById('todoSection')?.scrollIntoView({behavior:'smooth',block:'start'}),80);}

/* v99：自己按的按鈕一定立即重畫（不走背景同步的「正在打字」保護） */
function userRender(){const go=()=>{if(document.getElementById('formModal'))return void setTimeout(go,60);window._dayRemoteRenderPending=false;renderDayContent();};go();}
/* ============ hk22（移植京丹雅行 v92–v95）：每日回顧（每個帳號各寫一則，全家都看得到） ============ */
var reviewStore=(()=>{try{const v=JSON.parse(localStorage.getItem('nagano_reviews'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(e){return {};}})();
function persistReviews(){safeSetItem('nagano_reviews',reviewStore);}
/* v94：小羚羊心情（圖片 icon）；舊版的 great/good/ok/tired 自動對應 */
const REVIEW_MOODS=[
  ['happy','開心','角角都在笑','今天真開心','#D9772B'],
  ['relaxed','放鬆','慢慢吃草就好','慢慢走也很好','#3E8E6A'],
  ['amazed','驚喜','耳朵豎起來','撿到意外的風景','#2E86B5'],
  ['satisfied','滿足','肚子圓滾滾','吃飽喝足，剛剛好','#B5651D'],
  ['accomplished','成就感','插上小旗子','今天的路都走完了','#4F7A3A'],
  ['tired','累了','腳腳走痠了','有點累，但很值得','#8A6E55'],
  ['sleepy','想睡','窩著打個盹','先讓我睡一下','#7A62B8'],
  ['rainy','雨天小失落','撐著紫藤傘','下雨了，下次再來！','#5D7FB5']];
/* hk26：拿掉「低落」「不順心」，改成「有點可惜」；更早期的心情代碼自動對應 */
const OLD_MOOD_MAP={great:'happy',good:'relaxed',ok:'relaxed',excited:'happy',moved:'amazed',content:'satisfied',touched:'amazed',surprised:'amazed',snowtired:'tired',sad:'rainy',frustrated:'rainy',disappointed:'rainy'};
function moodInfo(m){m=OLD_MOOD_MAP[m]||m;const x=REVIEW_MOODS.find(z=>z[0]===m);return x?{key:x[0],label:x[1],title:x[2],sub:x[3],color:x[4],img:`images/mood-${x[0]}.webp`}:null;}
/* v95：心情可複選，存成 "excited,touched"（舊的單一值也相容） */
function moodList(m){const seen=new Set();return String(m||'').split(',').map(x=>OLD_MOOD_MAP[x.trim()]||x.trim()).filter(x=>x&&!seen.has(x)&&seen.add(x)&&REVIEW_MOODS.some(z=>z[0]===x));}
function myReviewName(){const w=todoWho();return w||'這支手機';}
function myEmail(){try{return (familyAuthSession&&familyAuthSession.email)||(readAuthSession()&&readAuthSession().email)||'';}catch(e){return '';}}
function dayReviewHTML(i){
  const day=reviewStore[i]||{},me=accountKey();
  const entries=Object.entries(day).filter(([,r])=>r&&(r.text||r.img||r.mood)).sort((a,b)=>(a[0]===me?-1:b[0]===me?1:String(a[1].at||'').localeCompare(String(b[1].at||''))));
  const card=([k,r])=>{const ms=moodList(r.mood).map(moodInfo);const mi=ms[0];return `<div class="rv-item${k===me?' mine':''}"><div class="rv-head">${mi?`<img class="rv-deer" src="${mi.img}" alt="${escAttr(mi.label)}" width="56" height="56">`:`<span class="rv-av">${escHtml(String(r.name||'?').slice(0,1).toUpperCase())}</span>`}<div class="rv-who"><b>${escHtml(r.name||'家人')}${k===me?'<em>（我）</em>':''}</b></div></div>${ms.length?`<div class="rv-moods">${ms.map((x,n)=>`<span class="rv-mood" style="--mc:${x.color}" title="${escAttr(x.label)}">${n?`<img src="${x.img}" alt="" width="26" height="26">`:''}<b>${escHtml(x.title)}</b><small>${escHtml(x.label)}</small></span>`).join('')}</div>`:''}${r.text?`<p>${brText(r.text)}</p>`:''}${r.img?`<img class="rv-img" src="${escAttr(r.img)}" data-src="${escAttr(r.img)}" alt="" loading="lazy" onclick="openAttachModal(this.dataset.src)">`:''}${k===me?`<div class="rv-acts"><button type="button" onclick="editMyReview(${i})">修改</button><button type="button" class="rv-del" onclick="deleteMyReview(${i})">刪除</button></div>`:''}</div>`;};
  const mine=day[me]&&(day[me].text||day[me].img||day[me].mood);
  const email=myEmail();
  return `<section class="day-review"><h3><img src="images/mood-happy.webp" alt="" width="40" height="40">今日回顧</h3><p class="rv-sub">今天過得怎麼樣呀？選幾隻小羚羊代表你的心情，再說說今天最喜歡的瞬間～全家都看得到喔 🌸</p>${entries.map(card).join('')||'<div class="rv-empty">還沒有人寫喔～<br>睡前來跟小羚羊說說今天吧！</div>'}${mine?'':`<button type="button" class="rv-add" onclick="editMyReview(${i})">＋ 寫我的回顧</button>`}${CLOUD_CONFIGURED?'':'<!--'}<p class="rv-acct">${email?`目前用 <b>${escHtml(email)}</b> 寫`:'目前沒有登入'}・<button type="button" class="rv-switch" onclick="logoutFamily()">不是你？換帳號</button></p>${CLOUD_CONFIGURED?'':'-->'}</section>`;
}
function moodPickerHTML(cur){
  const sel=moodList(cur);
  return `<input type="hidden" data-f="mood" value="${escAttr(sel.join(','))}"><div class="mood-grid" role="group">${REVIEW_MOODS.map(([k,l,t,sub,c])=>`<button type="button" class="mood-opt${sel.includes(k)?' on':''}" data-mood="${k}" role="checkbox" aria-checked="${sel.includes(k)}" aria-label="${escAttr(l+'：'+t)}" style="--mc:${c}"><i class="mood-check" aria-hidden="true">✓</i><img src="images/mood-${k}.webp" alt="" width="64" height="64"><b class="mood-title">${escHtml(t)}</b><small class="mood-word">${escHtml(l)}</small><small>${escHtml(sub)}</small></button>`).join('')}</div>`;
}
function initMoodPicker(wrap){
  const hid=wrap.querySelector('[data-f="mood"]');
  wrap.querySelectorAll('.mood-opt').forEach(b=>b.onclick=()=>{const on=!b.classList.contains('on');b.classList.toggle('on',on);b.setAttribute('aria-checked',on);
    let sel=moodList(hid.value).filter(x=>x!==b.dataset.mood);if(on)sel.push(b.dataset.mood);hid.value=sel.join(',');});
}
function editMyReview(i){
  const me=accountKey(),cur=(reviewStore[i]||{})[me]||{};
  openFormModal({title:`🌸 D${days[i].dayNum}・${days[i].date} 的我`,fields:[
    {id:'mood',type:'custom',label:'今天的心情是哪幾隻小羚羊？（可以選好幾隻喔）',html:moodPickerHTML(cur.mood),init:initMoodPicker,noFocus:true},
    {id:'text',label:'今天最喜歡的瞬間是…？',type:'textarea',rows:5,value:cur.text||'',placeholder:'例如：紫藤花棚下的風真的是紫色的！'},
    {id:'file',label:cur.img?'換一張照片（選填；不選就保留原本的）':'放一張今天最喜歡的照片（選填）',type:'file'},
    {id:'name',label:'大家看到的名字',value:cur.name||myReviewName()}],saveText:'存起來 🌸',
    onSave:v=>{
      if(!v.mood&&!v.text&&!v.file&&!cur.img){alert('先選一隻小羚羊，或寫一句話吧～');return false;}
      return (async()=>{
        let img=cur.img||'';
        if(v.file){try{img=await uploadMediaFile(v.file,'reviews');}catch(err){reportUploadError(err);return false;}}
        (reviewStore[i]=reviewStore[i]||{})[me]={name:v.name||myReviewName(),mood:v.mood||'',text:v.text,img,at:new Date().toISOString()};
        persistReviews();userRender();
        showToast('記下來了！今天辛苦了 🌸');
      })();
    }});
}
/* v94：晚上 22:00–24:00 打開 app，若今天（旅行中）還沒寫回顧，小羚羊會來提醒 */
function maybeNightReviewPrompt(){
  try{
    if(document.body.classList.contains('family-locked'))return;
    const now=new Date();if(now.getHours()<22)return;
    const i=tripTodayIndex(now);if(i<0)return;
    const mine=(reviewStore[i]||{})[accountKey()];if(mine&&(mine.text||mine.img||mine.mood))return;
    const k='nagano_rv_nag_'+i,snooze=Number(localStorage.getItem(k)||0);if(Date.now()<snooze)return;
    if(document.getElementById('formModal')||document.getElementById('nightReview'))return;
    const w=document.createElement('div');w.id='nightReview';w.className='night-rv';
    w.innerHTML=`<div class="night-rv-card" role="dialog" aria-label="寫今日回顧"><img src="images/mood-sleepy.webp" alt="" width="150" height="100"><h3>今天辛苦了～</h3><p>睡覺前，跟小羚羊說說今天吧！<br>選個心情、寫一句話就好 🌸</p><button type="button" class="night-go">好呀，現在寫</button><button type="button" class="night-later">等一下再說</button></div>`;
    document.body.appendChild(w);
    const close=()=>w.remove();
    w.querySelector('.night-go').onclick=()=>{close();if(typeof setActiveDay==='function'&&activeDay!==i)setActiveDay(i);editMyReview(i);};
    w.querySelector('.night-later').onclick=()=>{try{localStorage.setItem(k,String(Date.now()+30*60000));}catch(e){}close();};
  }catch(e){}
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(maybeNightReviewPrompt,2500));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')setTimeout(maybeNightReviewPrompt,800);});
/* v94：登出／換帳號（先把還沒上傳的改動送出，再清掉登入） */
async function logoutFamily(){
  const email=myEmail();
  if(!confirm(`${email?`目前登入：${email}\n\n`:''}要登出，換成別的帳號嗎？\n行程資料會留在這支手機上，不會不見。`))return;
  try{if(typeof cloudSync!=='undefined'&&cloudSync.enabled&&navigator.onLine)await Promise.race([flushCloudPush(),new Promise(r=>setTimeout(r,4000))]);}catch(e){}
  saveAuthSession(null);
  try{localStorage.removeItem('nagano_rv_nag_'+tripTodayIndex());}catch(e){}
  location.reload();
}
function deleteMyReview(i){
  const me=accountKey(),day=reviewStore[i];if(!day||!day[me])return;
  if(!confirm('刪除我這天的回顧？（8 秒內可復原）'))return;
  const prev=day[me];delete day[me];persistReviews();userRender();
  offerUndo('已刪除回顧',()=>{(reviewStore[i]=reviewStore[i]||{})[me]=prev;persistReviews();userRender();});
}

/* ---- 初次渲染 ---- */
renderDayChips();
renderDayContent();
renderPackList();
renderShopList();
renderTodos();

/* ============ 頁面初始化 ============ */
renderRulesList();
renderDocsList();
updateNetStatus();
simplifyMetServiceButton();
removeUnneededUtilityUI();
renderWeatherFromCache();
loadLiveWeather();
initRainRadar();


/* 花況與會場地圖：可新增、改名、替換與刪除。 */
let foliageMapStore = JSON.parse(localStorage.getItem('nagano_foliage_maps')) || [];
foliageMapStore = foliageMapStore.map((item,i)=> typeof item==='string' ? {url:item,title:`花況地圖 ${i+1}`} : item);
function persistFoliageMaps(){ safeSetItem('nagano_foliage_maps',foliageMapStore); }
/* (v54 已改寫) */
async function handleFoliageMapUpload(e){
  const files=[...(e.target.files||[])];
  for(const f of files){ try{foliageMapStore.push({url:await uploadMediaFile(f,'foliage-maps'),title:f.name.replace(/\.[^.]+$/,'')});}catch(err){reportUploadError(err);} }
  try{persistFoliageMaps();}catch(err){alert('圖片容量過大，請先刪除舊地圖或改用較小截圖。');}
  e.target.value=''; renderFoliageMaps();
}
function editFoliageMap(i){ const next=prompt('修改地圖名稱',foliageMapStore[i].title||''); if(next===null)return; foliageMapStore[i].title=next.trim()||`花況地圖 ${i+1}`; persistFoliageMaps(); renderFoliageMaps(); }
async function replaceFoliageMap(e,i){ const f=e.target.files&&e.target.files[0]; e.target.value=''; if(!f)return; try{foliageMapStore[i].url=await uploadMediaFile(f,'foliage-maps');persistFoliageMaps();renderFoliageMaps();}catch(err){reportUploadError(err);} }
function removeFoliageMap(i){ if(!confirm('刪除這張花況地圖？'))return;const removed=foliageMapStore.splice(i,1)[0];persistFoliageMaps();renderFoliageMaps();offerUndo('已刪除花況地圖',()=>{foliageMapStore.splice(i,0,removed);persistFoliageMaps();renderFoliageMaps();});}
document.addEventListener('DOMContentLoaded',renderFoliageMaps);




/* ============ hk8：環線頁「10 天一覽」 ============ */
function renderRouteTimeline(){
  const el=document.getElementById('routeTimeline');if(!el)return;
  el.innerHTML=days.map((d,i)=>{
    if(!inPlan(i))return '';
    const hotel=(d.moreSpots||[]).find(s=>s.cat==='hotel');
    const hotelName=hotel?(currentFieldValue(`d${i}-s${(d.moreSpots||[]).indexOf(hotel)}`,'name',hotel.name)||hotel.name):'返家';
    return `<button type="button" class="rt-day" onclick="setTab('itinerary');setActiveDay(${i});window.scrollTo({top:0,behavior:'smooth'})">
      <img class="rt-ic" src="${DAY_ICON_IMG[i]}" alt="" loading="lazy">
      <span class="rt-body"><span class="rt-date">DAY ${String(d.dayNum).padStart(2,'0')} · ${d.date}（${d.weekday}）</span>
      <strong class="rt-title">${escHtml(d.title)}</strong>
      <span class="rt-route">${escHtml(d.enRegion)}</span>
      <span class="rt-hotel">🛏 ${escHtml(hotelName)}</span></span></button>`;}).join('');
}
renderRouteTimeline();

/* ============ 兩版行程切換（Lomä 山湖版／藤井莊溪谷版） ============
   只換顯示哪 10 天；兩版各自的筆記、照片、自訂景點都保留，切回去還在。選擇只記在這支手機上。 */
const MTN_SVG='<img class="ps-mtn" src="images/deco/mountains-snowcap.webp" alt="" aria-hidden="true">';
const PLAN_GMAPS={
  loma:'https://www.google.com/maps/dir/Narita+Airport/Takasaki+Station/Fujinosakuoka+Fujioka/Nagano+Station/Lake+Nojiri/Imoriike+Myoko/Togakushi+Shrine+Chusha/Obuse/Yokohama+Station/Haneda+Airport+Terminal+3',
  fujiiso:'https://www.google.com/maps/dir/Narita+Airport/Takasaki+Station/Fujinosakuoka+Fujioka/Nagano+Station/Yamada+Onsen+Takayama+Nagano/Obuse/Togakushi+Shrine+Chusha/Yokohama+Station/Haneda+Airport+Terminal+3'
};
function renderPlanSwitch(){
  const el=document.getElementById('planSwitch');
  if(el)el.innerHTML=`<span class="ps-label">行程版本</span><div class="ps-seg">${Object.entries(PLANS).map(([k,p])=>`<button type="button" role="radio" aria-checked="${k===PLAN}" class="${k===PLAN?'on':''}" onclick="setPlan('${k}')">${escHtml(p.short)}</button>`).join('')}</div><div class="ps-theme"><i></i><span>${escHtml(PLANS[PLAN].theme)}</span><i></i>${MTN_SVG}</div>`;
  const img=document.getElementById('handDrawnMapImg');if(img&&img.getAttribute('src')!==PLANS[PLAN].overview){img.setAttribute('src',PLANS[PLAN].overview);img.alt=`春光•藤花•山色 ${PLANS[PLAN].label} 行程總覽插畫`;}
  const note=document.getElementById('planNoteRoute');if(note)note.innerHTML=`<b>目前顯示：${escHtml(PLANS[PLAN].label)}</b><span>${escHtml(PLANS[PLAN].note)}</span><button type="button" onclick="setPlan('${PLAN==='loma'?'fujiiso':'loma'}')">改看${escHtml(PLANS[PLAN==='loma'?'fujiiso':'loma'].short)}</button>`;
  const gm=document.getElementById('routeGmapLink');if(gm)gm.href=PLAN_GMAPS[PLAN];
  document.body.dataset.plan=PLAN;
}
function setPlan(p){
  if(!PLANS[p]||p===PLAN)return;
  const cur=typeof activeDay==='number'&&days[activeDay]?days[activeDay].date:null;
  PLAN=p;try{localStorage.setItem(PLAN_KEY,p);}catch(e){}
  if(typeof activeDay==='number'&&!inPlan(activeDay)){const hit=planDays().find(i=>days[i].date===cur);activeDay=hit!=null?hit:planDays()[0];}
  renderPlanSwitch();renderDayChips();renderDayContent();renderRouteTimeline();updateSpotCount();
  if(document.getElementById('liveWeatherList')&&typeof renderWeatherFromCache==='function'){if(!renderWeatherFromCache()&&navigator.onLine&&typeof loadLiveWeather==='function')loadLiveWeather();}
  showToast(`已切換到${PLANS[p].label}`);
}
renderPlanSwitch();
/* ng3：出發準備只放在指南頁，行程頁不再顯示首頁卡片 */
setTimeout(()=>{try{renderTodoBanner();}catch(e){console.warn(e)}},0);

/* hk9：單機預覽模式啟動時，把以前存在 localStorage 的 Base64 照片搬進 Cache Storage，釋放空間 */
if(!CLOUD_CONFIGURED&&'caches' in window){
  window.addEventListener('load',()=>setTimeout(async()=>{
    try{
      const hasB64=Object.keys(localStorage).some(k=>k.startsWith('nagano_')&&/data:image\//.test(localStorage.getItem(k)||''));
      if(!hasB64)return;
      if(navigator.serviceWorker&&!navigator.serviceWorker.controller)return; /* 等 Service Worker 接手後的下一次開啟再搬 */
      await migrateLegacyMediaToCloud();
      if(typeof safeRenderDayContent==='function')safeRenderDayContent();
    }catch(e){console.warn('本機照片搬移失敗',e);}
  },1500));
}
/* 行程頁最下方的小羚羊：用角落小羚羊的插圖 */
CRITTER_IMGS.length=0;CRITTER_IMGS.push(...PEEK_IMGS);

/* 10 天一覽：記住收合狀態 */
(function(){const d=document.querySelector('.route-timeline-card');if(!d)return;
  try{if(localStorage.getItem('nagano_rt_open')==='0')d.open=false;}catch(e){}
  d.addEventListener('toggle',()=>{try{localStorage.setItem('nagano_rt_open',d.open?'1':'0')}catch(e){}});})();
/* hk14：主程式跑完的記號（給 index.html 的啟動檢查用） */
window.__appReady=true;
