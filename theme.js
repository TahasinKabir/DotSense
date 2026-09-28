/* Sets the colour theme before the page is drawn: ?theme=dark|light from the app, else the system setting. */
(function () {
  let theme = new URLSearchParams(location.search).get('theme');
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  // the app tells every window when the theme changes
  if (window.desktop && window.desktop.theme) window.desktop.theme.onChange(t => { if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; });
})();
