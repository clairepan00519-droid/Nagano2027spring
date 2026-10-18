/* 長野春旅行程：App Shell、圖片與已瀏覽內容離線快取 */
const CACHE_VERSION='nagano-trip-ng15';
const SHELL_CACHE=`nagano-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE=`nagano-runtime-${CACHE_VERSION}`;
/* 圖片快取獨立於版本：更新網站不會清掉已下載的圖片，也不必重新下載 */
const IMAGE_CACHE='nagano-images-persist';
const LOCAL_MEDIA_CACHE='nagano-local-media';
const SHELL=['./', './index.html', './app.js', './style.css', './splash.css', './splash.js', './manifest.webmanifest', './config.js', './fonts/ChenYuluoyan-Thin-sub.woff2', './images/apple-touch-icon.png', './images/art-lodging.webp', './images/art-route.webp', './images/art-shopping.webp', './images/day00.webp', './images/day01.webp', './images/day02.webp', './images/day03.webp', './images/day04.webp', './images/day05.webp', './images/day06.webp', './images/day07.webp', './images/day08.webp', './images/day09.webp', './images/day10.webp', './images/day11.webp', './images/favicon.png', './images/header.webp', './images/icon-192.png', './images/icon-512.png', './images/icon-maskable-512.png', './images/logo.webp', './images/mood-accomplished.webp', './images/mood-amazed.webp', './images/mood-happy.webp', './images/mood-rainy.webp', './images/mood-relaxed.webp', './images/mood-satisfied.webp', './images/mood-sleepy.webp', './images/mood-tired.webp', './images/nav-food.webp', './images/nav-guide.webp', './images/nav-itinerary.webp', './images/nav-lodging.webp', './images/nav-route.webp', './images/nav-shopping.webp', './images/nav-weather.webp', './images/overview.webp', './images/scene-day00.webp', './images/scene-day01.webp', './images/scene-day02.webp', './images/scene-day03.webp', './images/scene-day04.webp', './images/scene-day05.webp', './images/scene-day06.webp', './images/scene-day07.webp', './images/scene-day08.webp', './images/scene-day09.webp', './images/scene-day10.webp', './images/scene-day11.webp', './images/serow-camera.webp', './images/serow-guide.webp', './images/serow-peek.webp', './images/serow-point.webp', './images/serow-rainy.webp', './images/serow-satisfied.webp', './images/serow-shop.webp', './images/serow-sleepy.webp', './images/serow-welcome.webp', './images/sp-jump.webp', './images/sp-look-back.webp', './images/sp-peek.webp', './images/sp-run.webp', './images/sp-sleep.webp', './images/sp-stretch.webp', './images/sp-walk.webp', './images/sp-wisteria.webp', './images/splash-serow-camera.webp', './images/splash-serow-point.webp', './images/splash-serow-welcome.webp', './images/weather/weather-chilly.webp', './images/weather/weather-cloudy.webp', './images/weather/weather-drizzle.webp', './images/weather/weather-fog.webp', './images/weather/weather-partly-cloudy.webp', './images/weather/weather-rain.webp', './images/weather/weather-snow.webp', './images/weather/weather-sunny.webp', './images/weather/weather-thunderstorm.webp', './images/weather/weather-wind.webp', './images/deco/cabin.webp', './images/deco/cedar.webp', './images/deco/cotton-grass.webp', './images/deco/forest-trees.webp', './images/deco/leaves-branch.webp', './images/deco/mountain.webp', './images/deco/mountains-green.webp', './images/deco/mountains-snowcap.webp', './images/deco/petals-floating.webp', './images/deco/rose.webp', './images/deco/stream-stones.webp', './images/deco/tea-cup.webp', './images/deco/wildflowers.webp', './images/deco/wisteria-divider.webp', './images/deco/wisteria-hanging.webp', './images/deco/wisteria-sprig.webp'];

self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then(async cache=>{
    await Promise.all(SHELL.map(async path=>{
      try{const res=await fetch(path,{cache:'reload'});if(res.ok)await cache.put(path,res);}catch(e){}
    }));
  }));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==SHELL_CACHE&&k!==RUNTIME_CACHE&&k!==IMAGE_CACHE&&k!==LOCAL_MEDIA_CACHE).map(k=>caches.delete(k))))
    .then(async()=>{
      await self.clients.claim();
      /* 不強制重新載入（會打斷正在輸入的家人），改通知頁面由使用者決定 */
      const windows=await self.clients.matchAll({type:'window'});
      windows.forEach(client=>client.postMessage({type:'SW_ACTIVATED',version:CACHE_VERSION}));
    }));
});

function isWeather(url){return url.hostname.includes('api.open-meteo.com')||url.hostname.includes('api.rainviewer.com');}
function isStaticLib(url){return url.hostname.includes('fonts.googleapis.com')||url.hostname.includes('fonts.gstatic.com')||url.hostname.includes('cdnjs.cloudflare.com');}
function imageFallback(){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="100%" height="100%" fill="#DED8E8"/><text x="600" y="330" text-anchor="middle" font-size="50" font-family="sans-serif" fill="#3B6A5A">北阿爾卑斯・信州</text><text x="600" y="390" text-anchor="middle" font-size="25" font-family="sans-serif" fill="#745b49">離線圖片尚未下載</text></svg>';
  return new Response(svg,{headers:{'Content-Type':'image/svg+xml;charset=utf-8','Cache-Control':'no-store'}});
}

/* 頁面請求「把全部圖片下載到這台裝置」 */
async function precacheImages(urls){
  const cache=await caches.open(IMAGE_CACHE);
  const list=[...new Set(urls)].filter(u=>/^https?:/i.test(u));
  let done=0,failed=0;const total=list.length;
  const post=async()=>{const cs=await self.clients.matchAll({type:'window'});cs.forEach(c=>c.postMessage({type:'PRECACHE_PROGRESS',done,failed,total}));};
  const queue=list.slice();
  async function worker(){
    while(queue.length){
      const url=queue.shift();
      try{
        if(await cache.match(url)){done++;}
        else{
          let res=null;
          try{const r=await fetch(url,{mode:'cors'});if(r.ok)res=r;}catch(e){}
          if(!res){try{const r=await fetch(url,{mode:'no-cors'});if(r&&(r.ok||r.type==='opaque'))res=r;}catch(e){}}
          if(res){await cache.put(url,res);done++;}else failed++;
        }
      }catch(e){failed++;}
      if((done+failed)%4===0)await post();
    }
  }
  await Promise.all([worker(),worker(),worker(),worker()]);
  await post();
}
self.addEventListener('message',event=>{
  const d=event.data||{};
  if(d.type==='PRECACHE_IMAGES'&&Array.isArray(d.urls))event.waitUntil(precacheImages(d.urls));
});

self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  let url;try{url=new URL(req.url);}catch(e){return;}
  if(isWeather(url))return;
  /* 單機預覽模式上傳的照片 */
  if(url.origin===self.location.origin&&url.pathname.includes('/local-media/')){
    event.respondWith(caches.open(LOCAL_MEDIA_CACHE).then(c=>c.match(url.href)).then(r=>r||new Response('',{status:404})));
    return;
  }

  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>{const copy=res.clone();caches.open(SHELL_CACHE).then(c=>c.put('./index.html',copy));return res;}).catch(async()=>await caches.match('./index.html')||await caches.match('./')));
    return;
  }

  if(url.origin===self.location.origin&&/\.(webp|png|jpe?g|gif|svg|ico)$/i.test(url.pathname)){
    event.respondWith(caches.match(req).then(c=>c||fetch(req).then(res=>{if(res.ok)caches.open(SHELL_CACHE).then(x=>x.put(req,res.clone()));return res;})));
    return;
  }

  if(url.origin===self.location.origin){
    /* 程式碼與版面：先連網取最新版，離線才用快取 */
    event.respondWith(fetch(req,{cache:'no-store'}).then(res=>{
      if(res.ok)caches.open(SHELL_CACHE).then(c=>c.put(req,res.clone()));
      return res;
    }).catch(()=>caches.match(req)));
    return;
  }

  if(req.destination==='image'){
    /* 圖片：有快取就用快取（含「下載離線圖片」存下的），沒有才連網並順便存起來 */
    event.respondWith(caches.open(IMAGE_CACHE).then(async cache=>{
      const cached=await cache.match(req.url)||await cache.match(req);if(cached)return cached;
      try{const res=await fetch(req);if(res.ok||res.type==='opaque')await cache.put(req,res.clone());return res;}catch(e){return imageFallback();}
    }));
    return;
  }

  if(isStaticLib(url)){
    event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{caches.open(RUNTIME_CACHE).then(c=>c.put(req,res.clone()));return res;})));
  }
});
