'use strict';

const form = document.getElementById('login-form');
const msg = document.getElementById('login-msg');

function nextPath(role) {
  const next = new URLSearchParams(location.search).get('next') || '';
  // Only allow same-site paths.
  const safe = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '';
  if (safe) return safe;
  return role === 'kiosk' ? '/' : '/admin';
}

if (new URLSearchParams(location.search).get('next') === '/admin') {
  msg.textContent = 'Log in with a staff or admin account to open the admin page.';
  msg.className = 'message warn';
  msg.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not log in');
    location.replace(nextPath(data.user.role));
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'message error';
    msg.hidden = false;
    btn.disabled = false;
  }
});
