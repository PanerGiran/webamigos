// Tema claro u oscuro. "auto" (por defecto) sigue al teléfono; "light" o "dark" lo fijan.
// Es un script común (no módulo) y se carga en el <head>, así se aplica antes de pintar y no parpadea.
(function () {
  var media = matchMedia('(prefers-color-scheme: dark)');
  window.applyTheme = function () {
    var pick = localStorage.getItem('theme');
    var dark = pick === 'dark' || (pick !== 'light' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0f0f14' : '#f6f5fb';
  };
  media.addEventListener('change', window.applyTheme);
  window.applyTheme();
})();
