// Applies the saved Sun/Moon choice before first paint so pages don't flash the wrong theme.
(function () {
  try {
    if (localStorage.getItem('loofary-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {
    /* storage blocked — stay on the default dark theme */
  }
})();
