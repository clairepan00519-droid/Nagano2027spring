(function () {
  'use strict';
  const currentScript = document.currentScript;
  const base = new URL('.', currentScript.src);
  let started = false;
  window.initSnowbird = function (options = {}) {
    if (started) return window.snowbird;
    const data = window.SNOWBIRD_CONTENT;
    if (!data || !data.birds.length || !data.messages.length) throw new Error('先載入 snowbird-content.js');
    started = true;
    const config = Object.assign({firstDelay:12000,minDelay:65000,maxDelay:110000,visibleTime:20000},options);
    const root = document.createElement('aside');
    root.className = 'snowbird-widget'; root.hidden = true;
    root.setAttribute('aria-label','角落小羚羊');
    const panel = document.createElement('div'); panel.className='snowbird-bubble'; panel.hidden=true;
    const label=document.createElement('small'), text=document.createElement('p'), source=document.createElement('a');
    source.textContent='看看來源'; source.target='_blank'; source.rel='noopener noreferrer';
    const next=document.createElement('button'); next.textContent='再說一句'; next.type='button';
    const close=document.createElement('button'); close.textContent='等等再來'; close.type='button';
    const mute=document.createElement('button'); mute.textContent='今天先別出現'; mute.type='button';
    const controls=document.createElement('div'); controls.className='snowbird-controls'; controls.append(next,close,mute);
    panel.append(label,text,source,controls);
    const birdButton=document.createElement('button'); birdButton.type='button'; birdButton.className='snowbird-bird';
    birdButton.setAttribute('aria-expanded','false');
    const img=document.createElement('img'); img.alt=''; img.width=112; img.height=112; birdButton.append(img);
    root.append(panel,birdButton); document.body.append(root);
    let scheduleTimer, hideTimer, stopped=false, deck=[];
    /* 數字＋單位、英文詞、片假名詞不要被拆到兩行 */
    function noBreakHTML(t){
      const esc=String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return esc.replace(/(\d[\d,.:～~\-]*\s?(?:公尺|公里|公分|分鐘|小時|年|月|日|號|天|度|°C|cm|km|%|萬|億|倍)?|[A-Za-z][A-Za-z'’&.\-]*(?:\s[A-Za-z][A-Za-z'’&.\-]*)*|[\u30A0-\u30FF・]{2,})/g,'<span class="sb-nb">$1</span>');
    }
    /* 依標點切成一小段一小段，換行盡量落在逗號、句號之後，不會把一個詞拆到下一行 */
    function phraseHTML(t){
      const parts=String(t).match(/[^，、。；：！？!?）」』]+[，、。；：！？!?）」』]*|[，、。；：！？!?）」』]+/g)||[String(t)];
      return parts.map(x=>'<span class="sb-ph">'+noBreakHTML(x)+'</span>').join('');
    }
    function pickMessage() {
      if (!deck.length) deck=data.messages.map((_,i)=>i);
      const i=deck.splice(Math.floor(Math.random()*deck.length),1)[0], m=data.messages[i];
      label.textContent=m.label; text.innerHTML=phraseHTML(m.text);
      source.hidden=!m.source; if(m.source) source.href=m.source;
    }
    function schedule(delay) {
      clearTimeout(scheduleTimer);
      if(stopped) return;
      scheduleTimer=setTimeout(()=>{if(document.hidden) schedule(10000); else show();}, delay ?? config.minDelay+Math.random()*(config.maxDelay-config.minDelay));
    }
    function hide() {
      clearTimeout(hideTimer); root.hidden=true; panel.hidden=true; birdButton.setAttribute('aria-expanded','false'); schedule();
    }
    function show(index) {
      if(stopped) return;
      clearTimeout(scheduleTimer); clearTimeout(hideTimer);
      const b=data.birds[index ?? Math.floor(Math.random()*data.birds.length)];
      img.src=new URL(b.file,base).href; birdButton.setAttribute('aria-label',b.name+'，點我聽一句話');
      root.classList.toggle('snowbird-left',Math.random()<0.5); root.hidden=false; panel.hidden=true;
      birdButton.setAttribute('aria-expanded','false'); hideTimer=setTimeout(hide,config.visibleTime);
    }
    function open() {clearTimeout(hideTimer); pickMessage(); panel.hidden=false; birdButton.setAttribute('aria-expanded','true');}
    birdButton.addEventListener('click',()=>{if(panel.hidden)open();else hide();});
    next.addEventListener('click',pickMessage); close.addEventListener('click',hide);
    mute.addEventListener('click',()=>{try{localStorage.setItem('nagano_serow_muted_day',new Date().toDateString())}catch(e){};stopped=true;clearTimeout(scheduleTimer);clearTimeout(hideTimer);root.hidden=true;});
    root.addEventListener('keydown',e=>{if(e.key==='Escape'){hide();}});
    window.snowbird={show,hide,open(i){show(i);open();},stop(){stopped=true;clearTimeout(scheduleTimer);clearTimeout(hideTimer);root.hidden=true;},resume(){stopped=false;schedule(config.firstDelay);}};
    /* 「今天先別出現」：今天之內都不出現，明天自動回來 */
    let muted=false;try{muted=localStorage.getItem('nagano_serow_muted_day')===new Date().toDateString()}catch(e){};if(!muted)schedule(config.firstDelay); return window.snowbird;
  };
})();
