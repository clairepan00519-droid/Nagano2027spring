(() => {
  const splash = document.querySelector('#naganoSplash');
  if (!splash) return;
  const variants = ['travel', 'map', 'wakeup'];
  let timer;

  function closeSplash() {
    clearTimeout(timer);
    splash.classList.add('is-leaving');
    setTimeout(() => { splash.hidden = true; splash.classList.remove('is-playing', 'is-leaving'); document.documentElement.classList.remove('splash-now'); }, 340);
  }

  function playSplash(choice = 'travel', options = {}) {
    const variant = choice === 'random' ? variants[Math.floor(Math.random() * variants.length)] : choice;
    splash.dataset.variant = variants.includes(variant) ? variant : 'travel';
    splash.hidden = false;
    requestAnimationFrame(() => splash.classList.add('is-playing'));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer = setTimeout(closeSplash, reduced ? 650 : (options.duration || 2050));
  }

  const skipBtn = splash.querySelector('.splash__skip');
  if (skipBtn) skipBtn.addEventListener('click', closeSplash);
  window.NaganoSplash = { play: playSplash, close: closeSplash };
  /* hk13：頁面一開始就播放（不再等整個網頁和圖片都載完） */
  const html = document.documentElement;
  if (html.classList.contains('splash-now')) {
    playSplash(html.getAttribute('data-splash') || 'travel');
  }
})();
