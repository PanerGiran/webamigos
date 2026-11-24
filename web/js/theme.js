// Tema claro u oscuro. "auto" (por defecto) sigue al teléfono; "light" o "dark" lo fijan.
// Es un script común (no módulo) y se carga en el <head>, así se aplica antes de pintar y no parpadea.
(function () {
  var media = matchMedia('(prefers-color-scheme: dark)');
  window.applyTheme = function () {
    var pick = localStorage.getItem('theme');
    var dark = pick === 'dark' || (pick !== 'light' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.documentElement.dataset.look = localStorage.getItem('look') || 'clasico';
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.content = bg;
  };
  media.addEventListener('change', window.applyTheme);
  window.applyTheme();
  // El script corre antes que los estilos del head. Volvé a leer --bg cuando estén cargados.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.applyTheme, { once: true });
  }
})();
