// The one thing we add to youtube.com (docs/youtube.md「浮动按钮」): a pill in the
// bottom-right corner of video pages, "language ▾ | practise this video". Built with
// createElement only (YouTube enforces Trusted Types, so innerHTML would throw), in a
// closed shadow root so the page's CSS and scripts cannot reach it. It talks to Rust
// by navigating to https://linguaclip.invalid/<cmd>, which Rust cancels; Rust answers
// with a window event named after this window's nonce. The config below is filled in by
// youtube_window.rs.
(() => {
  if (window.top !== window.self) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  const C = __LC_CONFIG__;
  const T = C.text;
  let lang = C.langs.some(l => l.code === C.lang) ? C.lang : C.langs[0].code;
  let state = { kind: 'idle' };
  let shownFor = null; // the video the current state belongs to
  let host = null;
  let root = null;

  const videoId = () => {
    let u;
    try { u = new URL(location.href); } catch { return null; }
    const id = u.pathname === '/watch'
      ? u.searchParams.get('v')
      : (/^\/shorts\/([A-Za-z0-9_-]{11})/.exec(u.pathname) || [])[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  };

  const send = (cmd, extra) => {
    const q = new URLSearchParams(Object.assign({ n: C.nonce }, extra || {}));
    location.href = 'https://linguaclip.invalid/' + cmd + '?' + q.toString();
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const button = (cls, text, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) onClick();
    });
    return b;
  };

  const CSS = `
    :host { all: initial; }
    .pill { position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px; padding: 6px; max-width: 360px;
      background: #fff; color: #1C1917; border: 1px solid #E7E5E4; border-radius: 999px;
      box-shadow: 0 16px 40px rgba(0,0,0,.18);
      font: 500 13px/1.4 "Instrument Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    .pill.card { flex-direction: column; align-items: stretch; border-radius: 14px; padding: 14px; gap: 10px; width: 320px; }
    .title { font-size: 14px; font-weight: 600; }
    .body { font-size: 12px; color: #78716C; font-weight: 400; line-height: 1.6; word-break: break-word; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
    .msg { padding: 0 10px; white-space: nowrap; }
    select { font: inherit; height: 32px; border: 0; border-radius: 999px; padding: 0 10px;
      background: #F4F4F3; color: #1C1917; cursor: pointer; outline: none; }
    button { font: inherit; height: 32px; padding: 0 14px; border: 0; border-radius: 999px;
      cursor: pointer; white-space: nowrap; background: #F4F4F3; color: #1C1917; }
    button:hover { background: #E7E5E4; }
    button.primary { background: #E8492B; color: #fff; }
    button.primary:hover { background: #d63f22; }
    button.ghost { background: transparent; color: #78716C; }
    .bar { height: 4px; border-radius: 4px; background: #F4F4F3; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: #E8492B; }
  `;

  const render = () => {
    if (!root) return;
    while (root.lastChild && root.lastChild.tagName !== 'STYLE') root.removeChild(root.lastChild);
    // Read at click time: YouTube changes video without reloading the page.
    const withId = fn => () => { const id = videoId(); if (id) fn(id); };
    const card = (title, body, buttons) => {
      const box = el('div', 'pill card');
      box.append(el('div', 'title', title), el('div', 'body', body));
      const row = el('div', 'row');
      row.append(...buttons);
      box.append(row);
      root.append(box);
    };
    const dismissBtn = () => button('ghost', T.dismiss, () => { state = { kind: 'idle' }; render(); });
    const retryBtn = cls => button(cls, T.tryAgain, withId(id => send('retry', { v: id })));
    const s = state;
    if (s.kind === 'confirm') {
      card(T.confirmTitle, T.confirmBody.replace('{mb}', String(s.mb)), [
        button('ghost', T.notNow, () => { state = { kind: 'idle' }; render(); }),
        button('primary', T.install, withId(id => send('install', { v: id, lang }))),
      ]);
      return;
    }
    if (s.kind === 'needLogin') {
      card(T.needLoginTitle, T.needLoginBody, [
        dismissBtn(),
        retryBtn(''),
        button('primary', T.loginBtn, withId(id => send('login', { v: id }))),
      ]);
      return;
    }
    if (s.kind === 'loginOpened') {
      card(T.needLoginTitle, T.loginOpenedBody, [dismissBtn(), retryBtn('primary')]);
      return;
    }
    if (s.kind === 'noChrome') {
      card(T.needLoginTitle, T.noChromeBody, [dismissBtn(), retryBtn('primary')]);
      return;
    }
    if (s.kind === 'winLogin') {
      card(T.winLoginTitle, T.winLoginBody, [dismissBtn(), retryBtn('primary')]);
      return;
    }
    if (s.kind === 'dlError') {
      card(T.downloadFailedTitle, s.detail || T.notAdded, [
        button('ghost', T.backHome, () => send('home')),
        retryBtn('primary'),
      ]);
      return;
    }
    const pill = el('div', 'pill');
    if (s.kind === 'installing') {
      const box = el('div', 'pill card');
      box.append(el('div', 'body', T.installing.replace('{pct}', String(s.pct ?? 0))));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = (s.pct ?? 0) + '%';
      bar.append(fill);
      box.append(bar);
      root.append(box);
      return;
    }
    if (s.kind === 'failed') {
      pill.append(el('span', 'msg', T.failed), button('primary', T.retry, withId(id => send('install', { v: id, lang }))));
    } else if (s.kind === 'adding') {
      pill.append(el('span', 'msg', T.adding));
    } else if (s.kind === 'retrying') {
      pill.append(el('span', 'msg', T.retrying));
    } else if (s.kind === 'notAdded') {
      pill.append(el('span', 'msg', T.notAdded), button('primary', T.tryAgain, withId(id => send('pick', { v: id, lang }))));
    } else if (s.kind === 'added') {
      pill.append(el('span', 'msg', '✓ ' + T.added), button('', T.backHome, () => send('home')));
    } else {
      const select = el('select');
      select.title = T.langHint;
      for (const l of C.langs) {
        const o = el('option', null, l.label);
        o.value = l.code;
        if (l.code === lang) o.selected = true;
        select.append(o);
      }
      select.addEventListener('change', () => { lang = select.value; });
      pill.append(select, button('primary', T.practice, withId(id => send('pick', { v: id, lang }))));
    }
    root.append(pill);
  };

  const mount = () => {
    if (host || !document.body) return;
    host = document.createElement('linguaclip-pill');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
    host.style.display = 'none';
    document.documentElement.append(host);
    render();
  };

  let addingTimer = 0;
  window.addEventListener('lc-' + C.nonce, e => {
    const d = e.detail || {};
    // A late answer about a video the user has left: leave this video's pill alone, except
    // that a finished install (which follows the user) ends its progress bar.
    if (d.v && d.v !== videoId() && d.kind !== 'installing') {
      if (state.kind === 'installing') { state = { kind: 'idle' }; shownFor = videoId(); render(); }
      return;
    }
    state = d;
    shownFor = videoId();
    clearTimeout(addingTimer);
    // The main window answers within a moment; silence means it never got the pick or retry.
    if (state.kind === 'adding' || state.kind === 'retrying') {
      addingTimer = setTimeout(() => {
        if (state.kind === 'adding' || state.kind === 'retrying') { state = { kind: 'notAdded' }; render(); }
      }, 20000);
    }
    render();
  });

  setInterval(() => {
    mount();
    if (!host) return;
    // Someone (or YouTube) removed it: put it back.
    if (!host.isConnected) document.documentElement.append(host);
    const id = videoId();
    const show = !!id && !(document.fullscreenElement || document.webkitFullscreenElement);
    host.style.display = show ? 'block' : 'none';
    // A new video starts fresh, unless components are still downloading for the last one.
    if (id !== shownFor && state.kind !== 'installing') {
      shownFor = id;
      if (state.kind !== 'idle') { state = { kind: 'idle' }; render(); }
    }
  }, 500);
})();
