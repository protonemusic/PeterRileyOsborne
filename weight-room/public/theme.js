'use strict';

/*
 * Light/dark theme toggle, on every page.
 * - Starts with the device's setting.
 * - Once someone flips the toggle, that choice is saved on this device (for every page)
 *   until they flip it again.
 * Load this in <head> (not deferred) so the saved theme applies before the page draws.
 */
(function () {
  const KEY = 'wr-theme';
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }
  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : Boolean(media && media.matches));

  apply(saved());

  function addToggle() {
    const bar = document.createElement('div');
    bar.className = 'site-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('role', 'switch');
    const label = document.createElement('span');
    label.textContent = 'Dark mode';
    const track = document.createElement('span');
    track.className = 'track';
    track.setAttribute('aria-hidden', 'true');
    btn.append(label, track);
    // School logo: the white-lettered version on dark backgrounds.
    const logo = document.createElement('img');
    logo.alt = 'Creswell High School Bulldogs';
    logo.className = 'site-logo';
    logo.width = 451;
    logo.height = 109;
    const sync = () => {
      btn.setAttribute('aria-checked', String(isDark()));
      const src = isDark() ? '/logo-dark.png' : '/logo.png';
      if (logo.getAttribute('src') !== src) logo.src = src;
    };
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch { /* private mode: applies to this page only */ }
      sync();
    });
    // Follow the device while no choice has been saved.
    if (media && media.addEventListener) media.addEventListener('change', sync);
    // Another tab changed it.
    window.addEventListener('storage', (e) => { if (e.key === KEY) { apply(e.newValue); sync(); } });
    sync();
    // School logo on the left, theme switch on the right.
    bar.append(logo, btn);
    document.body.prepend(bar);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addToggle);
  else addToggle();
}());
