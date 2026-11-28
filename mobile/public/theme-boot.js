// Runs before first paint (a plain script, so the CSP's script-src 'self' allows it):
// puts `dark` on <html> from the saved choice (localStorage linguaclip_theme) or the
// system setting, so a night launch never flashes white. utils/theme.ts takes over
// once the app loads. Kept identical in public/ and mobile/public/ (test-theme.mjs).
(function () {
  var v = null;
  try { v = localStorage.getItem('linguaclip_theme'); } catch (e) { /* storage blocked: follow the system */ }
  var dark = v === 'dark' || (v !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }
})();
