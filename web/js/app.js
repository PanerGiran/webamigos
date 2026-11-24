import { api, getToken, imageUrl, setToken, WS_URL } from './api.js';

const root = document.getElementById('app');
const MAX_IMAGE = 5 * 1024 * 1024;
const fmt = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
let me = null;

// --- Utilidades de DOM (sin innerHTML: los textos de los usuarios siempre entran como texto) ---

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.flat().filter((c) => c != null && c !== false && c !== ''));
  return el;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// Botón con ícono. Si no lleva texto visible, el texto va como etiqueta accesible.
function btn(iconName, text, onclick, className = 'soft', { iconOnly = false } = {}) {
  const b = h('button', { type: 'button', className: `${className}${iconOnly ? ' icon-only' : ''}`, onclick }, icon(iconName), !iconOnly && text);
  if (iconOnly) b.setAttribute('aria-label', text), (b.title = text);
  return b;
}

const label = (text, input) => h('label', {}, h('span', {}, text), input);
const errorBox = () => h('p', { className: 'error', role: 'alert' });

// Una sola descarga por foto de perfil, aunque aparezca muchas veces en pantalla.
const avatarUrls = new Map();

// Foto de perfil si hay; si no (o mientras carga), iniciales con un color fijo sacado del nombre de usuario.
function avatar(user, size = '') {
  const initials = user.display_name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const el = h('span', { className: `avatar ${size}`, title: user.display_name }, initials);
  el.style.setProperty('--h', [...user.username].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7));
  el.setAttribute('aria-hidden', 'true');
  if (user.avatar) {
    if (!avatarUrls.has(user.avatar)) avatarUrls.set(user.avatar, imageUrl(user.avatar));
    avatarUrls
      .get(user.avatar)
      .then((url) => el.replaceChildren(h('img', { src: url, alt: '' })))
      .catch(() => avatarUrls.delete(user.avatar));
  }
  return el;
}

function timeAgo(date) {
  const s = (Date.now() - date) / 1000;
  if (s < 45) return 'recién';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return fmt.format(date);
}

const toastEl = h('div', { className: 'toast', role: 'status' });
document.body.append(toastEl);
let toastTimer;
function toast(text, kind = '') {
  toastEl.textContent = text;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 2600);
}

// Visor de fotos a pantalla completa (se cierra con un toque o con Esc).
const lightboxImg = h('img', { alt: '' });
const lightbox = h('dialog', { className: 'lightbox', onclick: () => lightbox.close() }, lightboxImg);
document.body.append(lightbox);
// Panel que sube desde abajo (listas cortas: quién reaccionó, etc.). Se cierra tocando afuera o con Esc.
const sheetBody = h('div', { className: 'sheet-body' });
const sheetTitle = h('h2', {});
const sheet = h('dialog', { className: 'sheet' }, h('div', { className: 'sheet-head' }, sheetTitle), sheetBody);
sheet.onclick = (e) => e.target === sheet && sheet.close();
document.body.append(sheet);
function openSheet(title, ...children) {
  sheetTitle.textContent = title;
  sheetBody.replaceChildren(...children);
  sheet.showModal();
}

function openPhoto(src) {
  lightboxImg.src = src;
  lightbox.showModal();
}

function go(path) {
  history.pushState(null, '', path);
  render();
}
const link = (href, props, ...children) =>
  h('a', { href, ...props, onclick: (e) => (e.preventDefault(), go(href)) }, ...children);

// Envuelve un submit: bloquea el botón mientras espera y muestra el error en `msg`.
const onSubmit = (msg, fn) => async (e) => {
  e.preventDefault();
  const b = e.submitter;
  if (b) b.disabled = true;
  msg.textContent = '';
  try {
    await fn();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    if (b) b.disabled = false;
  }
};

// Acción con manejo de error: si falla, aviso en vez de romper.
const safe = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, 'error');
  }
};

function shell(...children) {
  const path = location.pathname;
  return [
    h(
      'header',
      { className: 'top' },
      link('/', { className: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Amigos'),
      h(
        'nav',
        {},
        link('/chat', { className: `navlink${path === '/chat' ? ' active' : ''}` }, icon('message'), h('span', { className: 'label' }, 'Chat')),
        me.role === 'admin' && link('/admin', { className: `navlink${path === '/admin' ? ' active' : ''}` }, icon('shield'), h('span', { className: 'label' }, 'Admin')),
        link(`/u/${me.username}`, { className: `navlink me${path === '/perfil' || path === `/u/${me.username}` ? ' active' : ''}`, title: 'Tu perfil' }, avatar(me, 'sm')),
      ),
    ),
    h('main', {}, ...children),
  ];
}

// --- Pantallas sin sesión ---

function authLayout(subtitle, form) {
  return h(
    'div',
    { className: 'auth' },
    h('div', { className: 'auth-box fade-in' }, h('div', { className: 'auth-head' }, h('img', { src: '/favicon.svg', alt: '' }), h('h1', {}, 'Amigos'), h('p', {}, subtitle)), form),
  );
}

function inviteScreen(token) {
  const pw = h('input', { type: 'password', required: true, minLength: 10, maxLength: 200, autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', required: true, minLength: 10, maxLength: 200, autocomplete: 'new-password' });
  const msg = errorBox();
  return authLayout(
    '¡Te invitaron! Elegí tu contraseña para entrar.',
    h(
      'form',
      {
        className: 'card',
        onsubmit: onSubmit(msg, async () => {
          if (pw.value !== pw2.value) throw new Error('Las contraseñas no coinciden.');
          const r = await api('/invite/accept', { method: 'POST', json: { token, password: pw.value } });
          setToken(r.token);
          me = null;
          go('/');
        }),
      },
      label('Contraseña (mínimo 10 caracteres)', pw),
      label('Repetila', pw2),
      msg,
      h('button', { className: 'primary block' }, 'Crear contraseña y entrar'),
    ),
  );
}

function loginScreen() {
  const user = h('input', { required: true, maxLength: 32, autocomplete: 'username', autocapitalize: 'none', spellcheck: false });
  const pw = h('input', { type: 'password', required: true, maxLength: 200, autocomplete: 'current-password' });
  const msg = errorBox();
  return authLayout(
    'Solo para el grupo.',
    h(
      'form',
      {
        className: 'card',
        onsubmit: onSubmit(msg, async () => {
          const r = await api('/login', { method: 'POST', json: { username: user.value.trim(), password: pw.value } });
          setToken(r.token);
          me = null;
          go('/');
        }),
      },
      label('Usuario', user),
      label('Contraseña', pw),
      msg,
      h('button', { className: 'primary block' }, 'Entrar'),
    ),
  );
}

// --- Feed ---

// scope 'profile': el post queda solo en el perfil propio (no sale en el feed global).
function composer(onPosted, { scope = 'feed', placeholder = `¿Qué contás, ${me.display_name.split(' ')[0]}?` } = {}) {
  const msg = errorBox();
  const text = h('textarea', { maxLength: 5000, rows: 1, placeholder });
  // El cuadro crece con el texto.
  text.oninput = () => {
    text.style.height = 'auto';
    text.style.height = `${text.scrollHeight}px`;
  };
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  const previewImg = h('img', { alt: 'Vista previa' });
  const clear = () => {
    file.value = '';
    if (previewImg.src) URL.revokeObjectURL(previewImg.src);
    previewImg.removeAttribute('src');
    preview.hidden = true;
  };
  const preview = h('div', { className: 'preview-wrap', hidden: true }, previewImg, btn('x', 'Quitar imagen', clear, '', { iconOnly: true }));
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return clear();
    if (f.size > MAX_IMAGE) {
      clear();
      msg.textContent = 'La imagen pasa los 5 MB.';
      return;
    }
    msg.textContent = '';
    if (previewImg.src) URL.revokeObjectURL(previewImg.src);
    previewImg.src = URL.createObjectURL(f);
    preview.hidden = false;
  };
  return h(
    'form',
    {
      className: 'card composer',
      onsubmit: onSubmit(msg, async () => {
        if (!text.value.trim() && !file.files[0]) throw new Error('Escribí algo o elegí una foto.');
        const form = new FormData();
        form.append('body', text.value);
        form.append('scope', scope);
        if (file.files[0]) form.append('image', file.files[0]);
        await api('/posts', { method: 'POST', form });
        text.value = '';
        text.style.height = '';
        clear();
        toast('¡Publicado!');
        onPosted();
      }),
    },
    h('div', { className: 'composer-top' }, avatar(me), text),
    preview,
    msg,
    h('div', { className: 'composer-bar' }, btn('image', 'Foto', () => file.click(), 'ghost'), file, h('button', { className: 'primary' }, icon('send'), 'Publicar')),
  );
}

// Texto escrito por usuarios. Por ahora texto plano; las menciones lo convierten en links.
const richText = (s) => [s ?? ''];
const editedTag = () => h('span', { className: 'edited', title: 'Editado' }, ' · editado');

// Editor en el lugar: cambia `el` por un cuadro de texto; al guardar llama a save(texto) y vuelve a mostrar `el`.
function editInPlace(el, current, { maxLength, save }) {
  const input = h('textarea', { value: current, maxLength, rows: 3 });
  const msg = errorBox();
  const back = () => form.replaceWith(el);
  const form = h(
    'form',
    {
      className: 'edit-form',
      onsubmit: onSubmit(msg, async () => {
        await save(input.value.trim());
        back();
      }),
    },
    input,
    msg,
    h('div', { className: 'row' }, h('button', { type: 'button', className: 'ghost sm', onclick: back }, 'Cancelar'), h('button', { className: 'primary sm' }, 'Guardar')),
  );
  el.replaceWith(form);
  input.focus();
}

function postCard(p) {
  const date = new Date(p.created_at);
  const who = h('div', { className: 'who' }, h('strong', {}, p.display_name), h('time', { dateTime: p.created_at, title: fmt.format(date) }, timeAgo(date)), p.edited_at && editedTag());
  const tools = h('div', { className: 'post-tools' });
  const head = h('div', { className: 'post-head' }, profileLink(p, { className: 'who-link' }, avatar(p), who), tools);
  const bodyEl = h('p', { className: 'body', hidden: !p.body }, ...richText(p.body));
  const card = h('article', { className: 'card post fade-in' }, head, bodyEl);
  if (p.user_id === me.id) {
    tools.append(
      btn('edit', 'Editar post', () =>
        editInPlace(bodyEl, p.body ?? '', {
          maxLength: 5000,
          save: async (text) => {
            const r = await api(`/posts/${p.id}`, { method: 'PATCH', json: { body: text } });
            p.body = r.body;
            bodyEl.replaceChildren(...richText(r.body));
            bodyEl.hidden = !r.body;
            if (!who.querySelector('.edited')) who.append(editedTag());
          },
        }), 'ghost', { iconOnly: true }),
    );
  }
  if (p.user_id === me.id || me.role === 'admin') {
    tools.append(
      btn('trash', 'Borrar post', safe(async () => {
        if (!confirm('¿Borrar este post?')) return;
        await api(`/posts/${p.id}`, { method: 'DELETE' });
        card.remove();
        toast('Post borrado');
      }), 'ghost danger', { iconOnly: true }),
    );
  }
  if (p.filename) {
    const img = h('img', { className: 'photo', alt: p.body ? '' : `Foto de ${p.display_name}`, width: p.width, height: p.height });
    card.append(img);
    imageUrl(p.filename)
      .then((url) => {
        // shortcut: el blob no se libera (lo usa el visor); con miles de fotos en una sesión, liberar los que salen de pantalla.
        img.src = url;
        img.onclick = () => openPhoto(url);
      })
      .catch(() => img.replaceWith(h('p', { className: 'muted small' }, '(no se pudo cargar la imagen)')));
  }
  card.append(...postFooter(p));
  return card;
}

const EMOJIS = ['❤️', '😂', '🔥', '😮', '😢', '👍'];

// Reacciones + botón de comentarios, y la sección de comentarios (se carga al abrirla).
function postFooter(p) {
  let reactions = p.reactions ?? [];
  let count = p.comment_count ?? 0;
  const chips = h('div', { className: 'chips' });
  const picker = h('div', { className: 'emoji-picker', hidden: true });

  const react = safe(async (emoji) => {
    picker.hidden = true;
    const mine = reactions.some((r) => r.emoji === emoji && r.mine);
    reactions = (await api(`/posts/${p.id}/reactions`, { method: 'PUT', json: { emoji, on: !mine } })).reactions;
    drawChips();
  });
  function drawChips() {
    const ordered = EMOJIS.map((e) => reactions.find((r) => r.emoji === e)).filter(Boolean);
    chips.replaceChildren(
      ...[...ordered.map((r) => {
        const b = h('button', { type: 'button', className: `chip${r.mine ? ' mine' : ''}`, onclick: () => react(r.emoji) }, `${r.emoji} ${r.count}`);
        b.setAttribute('aria-pressed', r.mine);
        return b;
      }),
      btn('smile', 'Reaccionar', () => (picker.hidden = !picker.hidden), 'ghost', { iconOnly: true }),
      ordered.length > 0 && h('button', { type: 'button', className: 'who-reacted', onclick: safe(showWho) }, 'quiénes'),
      ].filter(Boolean), // replaceChildren no descarta los false (h() sí)
    );
  }
  async function showWho() {
    const { reactions: groups } = await api(`/posts/${p.id}/reactions`);
    openSheet(
      'Reacciones',
      ...groups.map((g) =>
        h(
          'div',
          { className: 'react-group' },
          h('div', { className: 'react-emoji' }, g.emoji, h('span', { className: 'muted small' }, String(g.users.length))),
          ...g.users.map((u) => profileLink(u, { className: 'person' }, avatar(u, 'sm'), h('span', {}, u.display_name))),
        ),
      ),
    );
  }
  picker.append(...EMOJIS.map((e) => h('button', { type: 'button', className: 'emoji', onclick: () => react(e), ariaLabel: `Reaccionar con ${e}` }, e)));
  drawChips();

  const countLabel = h('span', {}, String(count));
  const setCount = (n) => (countLabel.textContent = String((count = n)));
  const list = h('div', { className: 'comment-list' });
  const input = h('input', { maxLength: 1000, placeholder: 'Escribí un comentario…', required: true, autocomplete: 'off' });
  const sendBtn = h('button', { className: 'primary icon-only', ariaLabel: 'Comentar' }, icon('send'));
  const section = h(
    'div',
    { className: 'comments', hidden: true },
    list,
    h(
      'form',
      {
        className: 'comment-form',
        onsubmit: async (e) => {
          e.preventDefault();
          sendBtn.disabled = true;
          try {
            const { comment } = await api(`/posts/${p.id}/comments`, { method: 'POST', json: { body: input.value } });
            list.append(commentRow(comment, () => setCount(count - 1)));
            input.value = '';
            setCount(count + 1);
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            sendBtn.disabled = false;
          }
        },
      },
      avatar(me, 'sm'),
      input,
      sendBtn,
    ),
  );
  let loaded = false;
  const toggleComments = safe(async () => {
    section.hidden = !section.hidden;
    if (section.hidden) return;
    if (!loaded) {
      list.replaceChildren(h('p', { className: 'muted small' }, 'Cargando…'));
      const { comments } = await api(`/posts/${p.id}/comments`);
      list.replaceChildren(...comments.map((c) => commentRow(c, () => setCount(count - 1))));
      setCount(comments.length);
      loaded = true;
    }
    input.focus();
  });
  const commentsBtn = h('button', { type: 'button', className: 'ghost', onclick: toggleComments }, icon('message'), countLabel);
  commentsBtn.setAttribute('aria-label', 'Comentarios');

  return [h('div', { className: 'post-foot' }, chips, commentsBtn), picker, section];
}

function commentRow(c, onDeleted) {
  const date = new Date(c.created_at);
  const text = h('p', {}, ...richText(c.body));
  const meta = h('time', { dateTime: c.created_at, title: fmt.format(date) }, timeAgo(date), c.edited_at && editedTag());
  const tools = h('div', { className: 'post-tools' });
  const row = h(
    'div',
    { className: 'comment' },
    profileLink(c, {}, avatar(c, 'sm')),
    h('div', { className: 'comment-bubble' }, profileLink(c, { className: 'name' }, h('strong', {}, c.display_name)), text, meta),
    tools,
  );
  if (c.user_id === me.id) {
    tools.append(
      btn('edit', 'Editar comentario', () =>
        editInPlace(text, c.body, {
          maxLength: 1000,
          save: async (body) => {
            const { comment } = await api(`/comments/${c.id}`, { method: 'PATCH', json: { body } });
            c.body = comment.body;
            text.replaceChildren(...richText(comment.body));
            if (!meta.querySelector('.edited')) meta.append(editedTag());
          },
        }), 'ghost', { iconOnly: true }),
    );
  }
  if (c.user_id === me.id || me.role === 'admin') {
    tools.append(
      btn('trash', 'Borrar comentario', safe(async () => {
        if (!confirm('¿Borrar este comentario?')) return;
        await api(`/comments/${c.id}`, { method: 'DELETE' });
        row.remove();
        onDeleted();
      }), 'ghost danger', { iconOnly: true }),
    );
  }
  return row;
}

const emptyState = (emoji, title, sub) => h('div', { className: 'empty' }, h('div', { className: 'big' }, emoji), h('p', {}, title), sub && h('p', { className: 'muted' }, sub));

// Lista de posts con paginación infinita. `query`: filtros extra para /api/posts (ej. 'user=juli&scope=profile').
function postList(query, empty) {
  const list = h('section', { className: 'feed' });
  const status = h('div', { className: 'feed-status muted center small' }, 'Cargando…');
  let before = 0;
  let loading = false;
  let done = false;

  // Cuando el aviso del final entra en pantalla, se pide la página siguiente.
  const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore());
  async function loadMore() {
    if (loading || done) return;
    loading = true;
    try {
      const qs = [query, before && `before=${before}`].filter(Boolean).join('&');
      const { posts, more } = await api(`/posts${qs ? `?${qs}` : ''}`);
      list.append(...posts.map(postCard));
      if (posts.length) before = posts.at(-1).id;
      done = !more;
      if (!done) status.textContent = '';
      else if (list.childElementCount) status.textContent = 'Eso es todo por ahora ✨';
      else status.replaceChildren(empty);
    } catch (err) {
      status.textContent = err.message;
    } finally {
      loading = false;
    }
    // Volver a observar dispara el chequeo otra vez: si la página no llenó la pantalla, sigue cargando.
    if (!done) {
      io.unobserve(status);
      io.observe(status);
    } else io.disconnect();
  }
  io.observe(status);
  return { list, status };
}

function feedScreen() {
  const { list, status } = postList('', emptyState('📸', 'Todavía no hay nada.', '¡Subí el primer meme!'));
  return shell(...[installCard(true), pushNudge(), composer(render), list, status].filter(Boolean));
}

// --- Instalar la app (PWA) ---

let installPrompt = null; // lo da Chrome/Android/Edge cuando la app se puede instalar
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

// Tarjeta "Instalá Amigos". En el feed (banner) se puede descartar; en Editar perfil queda siempre.
function installCard(banner) {
  const empty = h('div', { className: 'install-ui', hidden: true });
  empty.dataset.banner = banner ? '1' : '';
  if (isStandalone() || (banner && localStorage.getItem('installDismissed')) || (!installPrompt && !isIOS)) return empty;
  const card = h(
    'section',
    { className: 'card install install-ui fade-in' },
    h('img', { src: '/icons/icon-192.png', alt: '' }),
    h(
      'div',
      { className: 'grow' },
      h('strong', {}, 'Instalá Amigos'),
      h('p', { className: 'muted small' }, installPrompt ? 'Tenela en tu pantalla de inicio y abrila como una app.' : 'En Safari tocá Compartir y después "Agregar a inicio".'),
    ),
    installPrompt &&
      h('button', {
        className: 'primary sm',
        onclick: async () => {
          installPrompt.prompt();
          if ((await installPrompt.userChoice).outcome === 'accepted') installPrompt = null;
        },
      }, 'Instalar'),
    banner && btn('x', 'Ahora no', () => (localStorage.setItem('installDismissed', '1'), card.remove()), 'ghost', { iconOnly: true }),
  );
  card.dataset.banner = empty.dataset.banner;
  return card;
}
const refreshInstallCards = () => document.querySelectorAll('.install-ui').forEach((el) => el.replaceWith(installCard(el.dataset.banner === '1')));

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // se muestra nuestra tarjeta en vez del aviso del navegador
  installPrompt = e;
  refreshInstallCards();
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  refreshInstallCards();
  toast('¡App instalada!');
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// --- Notificaciones push ---

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// En iPhone solo funcionan con la app instalada y abierta desde el ícono.
const pushNeedsInstall = () => isIOS && !isStandalone();
const currentSubscription = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

function base64UrlToBytes(s) {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (Notification.permission === 'denied') throw new Error('Las notificaciones están bloqueadas para este sitio. Activalas desde la configuración del navegador.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('No se dio permiso para las notificaciones.');
  const { key } = await api('/push/key');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) }));
  await api('/push/subscribe', { method: 'POST', json: sub.toJSON() });
}

async function disablePush() {
  const sub = pushSupported && (await currentSubscription());
  if (!sub) return;
  await api('/push/subscribe', { method: 'DELETE', json: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// Tarjeta de Editar perfil: activar/desactivar en este dispositivo y elegir qué avisos llegan.
function notificationsCard() {
  const body = h('div', {}, h('p', { className: 'muted small' }, 'Cargando…'));
  const text = (t, cls = 'muted small') => h('p', { className: cls }, t);
  async function draw() {
    if (!pushSupported) return body.replaceChildren(text('Este navegador no permite notificaciones.'));
    if (pushNeedsInstall()) return body.replaceChildren(text('En iPhone, primero instalá la app (en Safari: Compartir → "Agregar a inicio") y abrila desde el ícono.'));
    if (Notification.permission === 'denied') {
      return body.replaceChildren(text('Las notificaciones están bloqueadas para este sitio. Para activarlas, tocá el candado junto a la dirección (o la configuración de la app) y permitilas.'));
    }
    const sub = await currentSubscription();
    if (!sub || Notification.permission !== 'granted') {
      return body.replaceChildren(
        text('Recibí un aviso cuando alguien publica, te comenta o escribe en el chat.'),
        h('div', { className: 'actions', style: 'border:0;padding:0' }, btn('bell', 'Activar en este dispositivo', safe(async () => {
          await enablePush();
          toast('Notificaciones activadas');
          await draw();
        }), 'primary')),
      );
    }
    // Se vuelve a registrar por si el servidor la había dado de baja (ej. al cerrar sesión).
    await api('/push/subscribe', { method: 'POST', json: sub.toJSON() });
    const prefs = await api('/me/notifications');
    const toggle = (key, label) => {
      const cb = h('input', { type: 'checkbox', checked: prefs[key] });
      cb.onchange = safe(async () => {
        await api('/me/notifications', { method: 'PATCH', json: { [key]: cb.checked } });
        toast('Guardado');
      });
      return h('label', { className: 'check' }, cb, label);
    };
    body.replaceChildren(
      text('✓ Activadas en este dispositivo', 'ok'),
      toggle('posts', 'Posts nuevos en el feed'),
      toggle('comments', 'Comentarios en mis posts'),
      toggle('chat', 'Mensajes del chat (si no lo tengo abierto)'),
      btn('bell-off', 'Desactivar en este dispositivo', safe(async () => {
        await disablePush();
        toast('Notificaciones desactivadas');
        await draw();
      }), 'soft sm'),
    );
  }
  draw().catch((err) => body.replaceChildren(text(err.message, 'error')));
  return h('section', { className: 'card fade-in' }, h('h2', {}, 'Notificaciones'), body);
}

// Recordatorio en el feed (se puede descartar). No aparece si ya se respondió el permiso.
function pushNudge() {
  if (!pushSupported || pushNeedsInstall() || Notification.permission !== 'default' || localStorage.getItem('pushDismissed')) return null;
  const card = h(
    'section',
    { className: 'card install fade-in' },
    h('span', { className: 'nudge-icon' }, icon('bell')),
    h('div', { className: 'grow' }, h('strong', {}, 'Activá las notificaciones'), h('p', { className: 'muted small' }, 'Enterate cuando alguien publica o te comenta.')),
    h('button', {
      className: 'primary sm',
      onclick: safe(async () => {
        await enablePush();
        card.remove();
        toast('Notificaciones activadas');
      }),
    }, 'Activar'),
    btn('x', 'Ahora no', () => (localStorage.setItem('pushDismissed', '1'), card.remove()), 'ghost', { iconOnly: true }),
  );
  return card;
}

// Franja de portada: la foto si hay, si no el degradado de la marca.
function coverBox(filename, extra = '') {
  const box = h('div', { className: `cover ${extra}` });
  if (filename) imageUrl(filename).then((url) => box.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
  return box;
}

// Editar perfil: tema claro/oscuro (lo aplica js/theme.js; se guarda en este dispositivo).
function appearanceCard() {
  const opts = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];
  const bar = h('div', { className: 'tabs', role: 'radiogroup', ariaLabel: 'Tema' });
  const draw = (sel) =>
    bar.replaceChildren(
      ...opts.map(([value, text]) => {
        const b = h('button', {
          type: 'button',
          className: `tab${value === sel ? ' active' : ''}`,
          onclick: () => {
            value === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', value);
            window.applyTheme();
            draw(value);
          },
        }, text);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', value === sel);
        return b;
      }),
    );
  draw(localStorage.getItem('theme') ?? 'auto');
  return h('section', { className: 'card fade-in' }, h('h2', {}, 'Apariencia'), h('p', { className: 'muted small', style: 'margin-bottom:10px' }, 'Automático sigue el modo de tu teléfono.'), bar);
}

// Editar perfil: nombre, bio y portada.
function profileInfoCard() {
  const name = h('input', { required: true, maxLength: 64, value: me.display_name });
  const bio = h('textarea', { maxLength: 300, rows: 3, placeholder: 'Contá algo de vos (opcional)' });
  const count = h('span', { className: 'muted small counter' }, '0/300');
  bio.oninput = () => (count.textContent = `${bio.value.length}/300`);
  const msg = errorBox();
  let cover = null;
  const coverSlot = h('div', {});
  const coverFile = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  function drawCover() {
    coverSlot.replaceChildren(
      coverBox(cover, 'small'),
      h('div', { className: 'actions', style: 'border:0;padding:0;margin-top:8px' },
        btn('image', cover ? 'Cambiar portada' : 'Poner portada', () => coverFile.click(), 'soft sm'),
        cover && btn('trash', 'Quitar portada', safe(async () => {
          if (!confirm('¿Quitar la foto de portada?')) return;
          await api('/me/cover', { method: 'DELETE' });
          cover = null;
          drawCover();
          toast('Portada quitada');
        }), 'soft danger sm'),
      ),
    );
  }
  coverFile.onchange = safe(async () => {
    const f = coverFile.files[0];
    coverFile.value = '';
    if (!f) return;
    if (f.size > MAX_IMAGE) throw new Error('La imagen pasa los 5 MB.');
    const form = new FormData();
    form.append('image', f);
    toast('Subiendo portada…');
    cover = (await api('/me/cover', { method: 'PUT', form })).cover;
    drawCover();
    toast('Portada actualizada');
  });
  drawCover();
  api(`/users/${me.username}`)
    .then(({ user }) => {
      bio.value = user.bio ?? '';
      bio.oninput();
      cover = user.cover;
      drawCover();
    })
    .catch((err) => (msg.textContent = err.message));

  return h(
    'form',
    {
      className: 'card fade-in',
      onsubmit: onSubmit(msg, async () => {
        const r = await api('/me/profile', { method: 'PATCH', json: { display_name: name.value, bio: bio.value } });
        me.display_name = r.display_name;
        toast('Perfil guardado');
        render();
      }),
    },
    h('h2', {}, 'Tu perfil'),
    h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Portada'), coverSlot, coverFile),
    label('Nombre visible', name),
    h('label', {}, h('span', {}, 'Bio'), bio, count),
    msg,
    h('button', {}, 'Guardar perfil'),
  );
}

// --- Perfil público ---

const profileLink = (user, props, ...children) => link(`/u/${user.username}`, { ...props, title: `Perfil de ${user.display_name}` }, ...children);
const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' });

async function userScreen(username) {
  const { user } = await api(`/users/${encodeURIComponent(username)}`);
  const isMe = user.id === me.id;
  const first = user.display_name.split(' ')[0];

  // La foto de perfil se ve completa (sin el recorte cuadrado) al tocarla.
  const big = avatar(user, 'xl');
  const photo = user.avatar
    ? h('button', {
        type: 'button',
        className: 'avatar-view',
        ariaLabel: 'Ver foto de perfil completa',
        title: 'Ver foto completa',
        onclick: safe(async () => openPhoto(await imageUrl(user.avatar_full ?? user.avatar))),
      }, big)
    : big;

  const cover = coverBox(user.cover);
  const head = h(
    'section',
    { className: 'card profile-card fade-in' },
    cover,
    h(
      'div',
      { className: 'profile-body' },
      photo,
      h('h1', {}, user.display_name),
      h('p', { className: 'muted' }, `@${user.username} `, user.role === 'admin' && h('span', { className: 'badge accent' }, icon('shield'), 'admin')),
      user.bio && h('p', { className: 'bio' }, ...richText(user.bio)),
      h('p', { className: 'muted small' }, `En el grupo desde ${monthFmt.format(new Date(user.created_at))}`),
      isMe && link('/perfil', { className: 'btn-link' }, icon('edit'), 'Editar perfil'),
    ),
  );

  const tabBar = h('div', { className: 'tabs', role: 'tablist' });
  const content = h('div');
  const tabs = [
    ['profile', 'Perfil', user.profile_count],
    ['feed', 'En el feed', user.feed_count],
  ];
  function showTab(scope) {
    tabBar.replaceChildren(
      ...tabs.map(([s, text, n]) => {
        const b = h('button', { type: 'button', className: `tab${s === scope ? ' active' : ''}`, onclick: () => showTab(s) }, text, h('span', { className: 'count' }, String(n)));
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', s === scope);
        return b;
      }),
    );
    const empty =
      scope === 'profile'
        ? emptyState('🪴', isMe ? 'Tu perfil está vacío.' : `${first} todavía no publicó nada en su perfil.`, isMe && 'Lo que publiques acá no sale en el feed.')
        : emptyState('📭', isMe ? 'No publicaste nada en el feed.' : `${first} no publicó nada en el feed.`);
    const { list, status } = postList(`user=${encodeURIComponent(user.username)}&scope=${scope}`, empty);
    content.replaceChildren(
      ...[isMe && scope === 'profile' && composer(render, { scope: 'profile', placeholder: 'Publicá algo en tu perfil…' }), list, status].filter(Boolean),
    );
  }
  showTab('profile');
  return shell(head, tabBar, content);
}

// --- Perfil ---

function profileScreen() {
  const cur = h('input', { type: 'password', required: true, maxLength: 200, autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', required: true, minLength: 10, maxLength: 200, autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', required: true, minLength: 10, maxLength: 200, autocomplete: 'new-password' });
  const msg = errorBox();
  const logout = async () => {
    await disablePush().catch(() => {}); // que este dispositivo no siga recibiendo avisos de esta cuenta
    await api('/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    me = null;
    go('/login');
  };
  // Foto de perfil: se sube apenas se elige (el servidor la recorta cuadrada).
  const photo = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  photo.onchange = safe(async () => {
    const f = photo.files[0];
    photo.value = '';
    if (!f) return;
    if (f.size > MAX_IMAGE) throw new Error('La imagen pasa los 5 MB.');
    const form = new FormData();
    form.append('image', f);
    toast('Subiendo foto…');
    Object.assign(me, await api('/me/avatar', { method: 'PUT', form }));
    toast('Foto actualizada');
    render();
  });
  const removePhoto = safe(async () => {
    if (!confirm('¿Quitar tu foto de perfil?')) return;
    await api('/me/avatar', { method: 'DELETE' });
    me.avatar = null;
    toast('Foto quitada');
    render();
  });
  const pickPhoto = h('button', { type: 'button', className: 'avatar-edit', onclick: () => photo.click(), ariaLabel: 'Cambiar foto de perfil', title: 'Cambiar foto' }, avatar(me, 'lg'), h('span', { className: 'cam' }, icon('camera')));

  return shell(
    link(`/u/${me.username}`, { className: 'back' }, '← Ver mi perfil'),
    h('h1', { className: 'page-title' }, 'Editar perfil'),
    h(
      'section',
      { className: 'card fade-in' },
      h(
        'div',
        { className: 'profile-head' },
        pickPhoto,
        photo,
        h('div', {}, h('h1', {}, me.display_name), h('p', { className: 'muted' }, `@${me.username} `, me.role === 'admin' && h('span', { className: 'badge accent' }, icon('shield'), 'admin'))),
      ),
      h('div', { className: 'actions' }, btn('camera', me.avatar ? 'Cambiar foto' : 'Poner foto', () => photo.click(), 'soft sm'), me.avatar && btn('trash', 'Quitar foto', removePhoto, 'soft danger sm')),
    ),
    profileInfoCard(),
    h(
      'form',
      {
        className: 'card fade-in',
        onsubmit: onSubmit(msg, async () => {
          if (pw.value !== pw2.value) throw new Error('Las contraseñas nuevas no coinciden.');
          await api('/me/password', { method: 'POST', json: { current_password: cur.value, new_password: pw.value } });
          cur.value = pw.value = pw2.value = '';
          toast('Contraseña cambiada. Se cerraron tus otras sesiones.');
        }),
      },
      h('h2', {}, 'Cambiar contraseña'),
      label('Contraseña actual', cur),
      label('Nueva (mínimo 10 caracteres)', pw),
      label('Repetila', pw2),
      msg,
      h('button', {}, 'Guardar contraseña'),
    ),
    appearanceCard(),
    notificationsCard(),
    installCard(false),
    btn('logout', 'Cerrar sesión', logout, 'soft danger block'),
  );
}

// --- Admin ---

function linkBox(name, link) {
  const input = h('input', { value: link, readOnly: true, onfocus: (e) => e.target.select() });
  const copy = btn('copy', 'Copiar', async () => {
    await navigator.clipboard.writeText(link).catch(() => input.select());
    toast('Link copiado');
  }, '');
  // En el celular abre el menú de compartir (WhatsApp, Telegram, etc.).
  const share =
    navigator.share &&
    btn('share', 'Compartir', () => navigator.share({ title: 'Amigos', text: `${name}, entrá con este link para crear tu contraseña:`, url: link }).catch(() => {}), 'soft');
  return h(
    'div',
    {},
    h('h2', {}, `Link para ${name}`),
    h('p', { className: 'muted small' }, 'Mandáselo por privado. Vale 48 h y sirve una sola vez.'),
    h('div', { className: 'linkbox' }, input),
    h('div', { className: 'actions', style: 'border:0;padding:0;margin:0' }, copy, share),
  );
}

function statusBadge(u) {
  if (!u.is_active) return h('span', { className: 'badge' }, icon('lock'), 'Bloqueada');
  if (u.pending) {
    const exp = u.invite_expires_at && new Date(u.invite_expires_at);
    return exp > new Date()
      ? h('span', { className: 'badge warn', title: `Vence ${fmt.format(exp)}` }, 'Invitación pendiente')
      : h('span', { className: 'badge danger' }, 'Invitación vencida');
  }
  return h('span', { className: 'badge ok' }, 'Activa');
}

function adminScreen() {
  const list = h('section', {}, h('p', { className: 'muted center small' }, 'Cargando…'));
  const result = h('section', { className: 'card highlight fade-in', hidden: true });
  const showLink = (name, link) => {
    result.replaceChildren(linkBox(name, link));
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  async function load() {
    try {
      const { users } = await api('/admin/users');
      list.replaceChildren(
        h('div', { className: 'section-title' }, h('h2', { style: 'margin:0' }, 'Cuentas'), h('span', { className: 'muted small' }, `${users.length} en total`)),
        ...users.map(userCard),
      );
    } catch (err) {
      list.replaceChildren(h('p', { className: 'error' }, err.message));
    }
  }

  function userCard(u) {
    const isMe = u.id === me.id;
    const patch = async (json, done) => {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', json });
      if (isMe) me = await api('/me');
      await load();
      toast(done);
    };
    const actions = [
      btn('edit', 'Renombrar', safe(async () => {
        const name = prompt('Nombre visible', u.display_name)?.trim();
        if (name && name !== u.display_name) await patch({ display_name: name }, 'Nombre actualizado');
      }), 'soft sm'),
    ];
    if (!isMe) {
      actions.push(
        btn('key', u.pending ? 'Nuevo link' : 'Resetear acceso', safe(async () => {
          if (!u.pending && !confirm(`Esto borra la contraseña de ${u.display_name} y cierra sus sesiones. Después le mandás el link nuevo. ¿Seguir?`)) return;
          const { link } = await api(`/admin/users/${u.id}/invite`, { method: 'POST' });
          await load();
          showLink(u.display_name, link);
        }), 'soft sm'),
        btn('star', u.role === 'admin' ? 'Quitar admin' : 'Hacer admin', safe(() =>
          patch({ role: u.role === 'admin' ? 'member' : 'admin' }, u.role === 'admin' ? 'Ya no es admin' : 'Ahora es admin'),
        ), 'soft sm'),
        btn(u.is_active ? 'lock' : 'unlock', u.is_active ? 'Bloquear' : 'Desbloquear', safe(async () => {
          if (u.is_active && !confirm(`¿Bloquear a ${u.display_name}? Se le cierran las sesiones y no puede entrar hasta que la desbloquees.`)) return;
          await patch({ is_active: !u.is_active }, u.is_active ? 'Cuenta bloqueada' : 'Cuenta desbloqueada');
        }), 'soft sm'),
        btn('trash', 'Eliminar', safe(async () => {
          if (!confirm(`¿Eliminar la cuenta de ${u.display_name}? No va a poder entrar más. Sus posts quedan.`)) return;
          await api(`/admin/users/${u.id}`, { method: 'DELETE' });
          await load();
          toast('Cuenta eliminada');
        }), 'soft danger sm'),
      );
    }
    const lastSeen = !u.pending && u.last_login_at ? `Último ingreso ${timeAgo(new Date(u.last_login_at))}` : '';
    return h(
      'article',
      { className: `card user fade-in${u.is_active ? '' : ' blocked'}` },
      h(
        'div',
        { className: 'user-row' },
        avatar(u),
        h(
          'div',
          { className: 'who' },
          h('div', {}, profileLink(u, { className: 'name' }, h('strong', {}, u.display_name)), h('span', { className: 'muted small' }, `@${u.username}`)),
          h('div', { className: 'badges' }, statusBadge(u), u.role === 'admin' && h('span', { className: 'badge accent' }, icon('shield'), 'admin'), isMe && h('span', { className: 'badge' }, 'vos')),
          lastSeen && h('p', { className: 'muted small', style: 'margin-top:4px' }, lastSeen),
        ),
      ),
      h('div', { className: 'actions' }, actions),
    );
  }

  const user = h('input', {
    required: true,
    pattern: '[a-z0-9_]{3,32}',
    maxLength: 32,
    autocapitalize: 'none',
    spellcheck: false,
    placeholder: 'juan_p',
    oninput: (e) => (e.target.value = e.target.value.toLowerCase()),
  });
  const name = h('input', { required: true, maxLength: 64, placeholder: 'Juan' });
  const isAdmin = h('input', { type: 'checkbox' });
  const msg = errorBox();
  const form = h(
    'form',
    {
      className: 'card fade-in',
      onsubmit: onSubmit(msg, async () => {
        const r = await api('/admin/users', {
          method: 'POST',
          json: { username: user.value, display_name: name.value, role: isAdmin.checked ? 'admin' : 'member' },
        });
        const created = name.value.trim();
        form.reset();
        await load();
        showLink(created, r.link);
      }),
    },
    h('h2', {}, 'Nueva cuenta'),
    label('Usuario (3 a 32: a-z, 0-9, _)', user),
    label('Nombre visible', name),
    h('label', { className: 'check' }, isAdmin, 'Que sea admin'),
    msg,
    h('button', { className: 'primary' }, icon('user-plus'), 'Crear y generar link'),
  );

  load();
  return shell(h('h1', { className: 'page-title' }, 'Administración'), form, result, list);
}

// --- Chat ---

let chatSocket = null; // una sola conexión; render() la cierra al salir del chat
const hourFmt = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short' });
const dayHourFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function chatScreen() {
  let messages = [];
  let more = false;
  const list = h('div', { className: 'chat-list' });
  const status = h('span', { className: 'muted small' }, 'Conectando…');
  const online = h('div', { className: 'online' });
  const input = h('textarea', { rows: 1, maxLength: 2000, placeholder: 'Escribí un mensaje…' });
  const sendBtn = h('button', { className: 'primary icon-only', ariaLabel: 'Enviar', disabled: true }, icon('send'));
  const olderBtn = h('button', { type: 'button', className: 'soft sm older' }, 'Ver mensajes anteriores');

  let activeId = null; // mensaje con la barra de acciones abierta (se abre tocándolo)
  let replyTo = null;
  const replyBar = h('div', { className: 'reply-bar', hidden: true });
  const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const react = (m, emoji) => {
    const on = !m.reactions?.some((r) => r.emoji === emoji && r.user_ids.includes(me.id));
    chatSocket?.send(JSON.stringify({ type: 'react', message_id: m.id, emoji, on }));
  };
  function cancelReply() {
    replyTo = null;
    replyBar.hidden = true;
  }
  function startReply(m) {
    replyTo = m;
    activeId = null;
    replyBar.replaceChildren(
      h('div', { className: 'grow' }, h('strong', {}, `Respondiendo a ${m.display_name}`), h('span', { className: 'muted small' }, short(m.body))),
      btn('x', 'Cancelar respuesta', cancelReply, 'ghost', { iconOnly: true }),
    );
    replyBar.hidden = false;
    draw();
    input.focus();
  }
  // Tocar una cita lleva al mensaje original (si ya está cargado).
  function jumpTo(id) {
    const el = list.querySelector(`[data-id="${id}"]`);
    if (!el) return toast('Ese mensaje es más viejo: tocá "Ver mensajes anteriores".');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  function bubble(m, prev) {
    const mine = m.user_id === me.id;
    const date = new Date(m.created_at);
    // Mensajes seguidos de la misma persona van agrupados (sin repetir nombre ni avatar).
    const first = !prev || prev.user_id !== m.user_id || date - new Date(prev.created_at) > 5 * 60_000;
    const sameDay = date.toDateString() === new Date().toDateString();
    const stop = (fn) => (e) => (e.stopPropagation(), fn());
    const row = h(
      'div',
      { className: `msg${mine ? ' mine' : ''}${first ? ' first' : ''}` },
      !mine && (first ? profileLink(m, {}, avatar(m, 'sm')) : h('span', { className: 'avatar-gap' })),
      h(
        'div',
        { className: 'msg-col' },
        h(
          'div',
          {
            className: `bubble${activeId === m.id ? ' active' : ''}`,
            onclick: (e) => {
              if (e.target.closest('a')) return;
              activeId = activeId === m.id ? null : m.id;
              draw();
            },
          },
          !mine && first && profileLink(m, { className: 'name' }, h('strong', {}, m.display_name)),
          m.reply && h('button', { type: 'button', className: 'quote', onclick: stop(() => jumpTo(m.reply.id)) }, h('strong', {}, m.reply.display_name), h('span', {}, m.reply.body)),
          h('p', {}, ...richText(m.body)),
          h('time', { dateTime: m.created_at, title: fmt.format(date) }, (sameDay ? hourFmt : dayHourFmt).format(date)),
        ),
        m.reactions?.length > 0 &&
          h('div', { className: 'msg-reactions' }, ...m.reactions.map((r) => h('button', { type: 'button', className: `chip${r.user_ids.includes(me.id) ? ' mine' : ''}`, onclick: stop(() => react(m, r.emoji)) }, `${r.emoji} ${r.count}`))),
        activeId === m.id &&
          h(
            'div',
            { className: 'msg-actions' },
            ...EMOJIS.map((e) => h('button', { type: 'button', className: 'emoji', ariaLabel: `Reaccionar con ${e}`, onclick: stop(() => (react(m, e), (activeId = null), draw())) }, e)),
            h('button', { type: 'button', className: 'soft sm', onclick: stop(() => startReply(m)) }, 'Responder'),
          ),
      ),
    );
    row.dataset.id = m.id;
    return row;
  }

  // keep: 'bottom' baja al final, 'top' mantiene la posición al cargar mensajes viejos arriba.
  function draw(keep) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    const prevHeight = list.scrollHeight;
    list.replaceChildren(
      ...[
        more && olderBtn,
        !messages.length && h('div', { className: 'empty' }, h('div', { className: 'big' }, '💬'), h('p', {}, 'Nadie escribió todavía.'), h('p', { className: 'muted' }, '¡Rompé el hielo!')),
        ...messages.map((m, i) => bubble(m, messages[i - 1])),
      ].filter(Boolean),
    );
    if (keep === 'top') list.scrollTop = list.scrollHeight - prevHeight;
    else if (keep === 'bottom' || nearBottom) list.scrollTop = list.scrollHeight;
  }

  olderBtn.onclick = safe(async () => {
    olderBtn.disabled = true;
    const r = await api(`/messages?before=${messages[0].id}`);
    messages = [...r.messages, ...messages];
    more = r.more;
    olderBtn.disabled = false;
    draw('top');
  });

  // Al conectar (y al reconectar) se trae el historial reciente, así no se pierde nada de lo que pasó mientras tanto.
  async function loadLatest() {
    const r = await api('/messages');
    messages = r.messages;
    more = r.more;
    draw('bottom');
  }

  function connect() {
    const ws = new WebSocket(WS_URL);
    chatSocket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready') {
        status.textContent = 'En línea';
        sendBtn.disabled = false;
        loadLatest().catch((err) => toast(err.message, 'error'));
      } else if (msg.type === 'message' && !messages.some((m) => m.id === msg.message.id)) {
        messages.push(msg.message);
        draw(msg.message.user_id === me.id ? 'bottom' : undefined);
      } else if (msg.type === 'reactions') {
        const m = messages.find((x) => x.id === msg.message_id);
        if (m) (m.reactions = msg.reactions), draw();
      } else if (msg.type === 'presence') {
        const n = msg.users.length;
        online.replaceChildren(
          h('div', { className: 'stack' }, msg.users.slice(0, 5).map((u) => avatar(u, 'xs'))),
          h('span', { className: 'muted small' }, `${n} conectado${n === 1 ? '' : 's'}`),
        );
        online.title = msg.users.map((u) => u.display_name).join(', ');
      } else if (msg.type === 'error') toast(msg.error, 'error');
    };
    ws.onclose = (e) => {
      sendBtn.disabled = true;
      if (chatSocket !== ws) return; // se salió del chat
      if (e.code === 4001) {
        setToken(null);
        return location.assign('/login');
      }
      status.textContent = 'Reconectando…';
      setTimeout(() => chatSocket === ws && connect(), 2000);
    };
  }

  const send = () => {
    const body = input.value.trim();
    if (!body || chatSocket?.readyState !== WebSocket.OPEN) return;
    chatSocket.send(JSON.stringify({ type: 'message', body, ...(replyTo && { reply_to: replyTo.id }) }));
    cancelReply();
    input.value = '';
    input.style.height = '';
    input.focus();
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  // Enter envía; Shift+Enter hace un salto de línea.
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  draw();
  connect();
  const nodes = shell(
    h('div', { className: 'chat-head' }, h('div', {}, h('h1', {}, 'Chat del grupo'), status), online),
    list,
    replyBar,
    h('form', { className: 'chat-form', onsubmit: (e) => (e.preventDefault(), send()) }, input, sendBtn),
  );
  nodes[1].className = 'chat-main';
  return nodes;
}

// --- Rutas ---

async function render() {
  const path = location.pathname;
  if (sheet.open) sheet.close();
  if (chatSocket && path !== '/chat') {
    const ws = chatSocket;
    chatSocket = null;
    ws.close();
  }
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return root.replaceChildren(inviteScreen(invite[1]));
  if (!getToken()) return path === '/login' ? root.replaceChildren(loginScreen()) : go('/login');
  if (!me) {
    try {
      me = await api('/me');
    } catch (err) {
      return root.replaceChildren(
        h(
          'div',
          { className: 'auth' },
          h('div', { className: 'auth-box card center' }, emptyState('📡', navigator.onLine ? err.message : 'Sin conexión', 'Cuando vuelva internet, probá de nuevo.'), h('button', { className: 'primary', onclick: () => location.reload() }, 'Reintentar')),
        ),
      );
    }
  }
  if (path === '/perfil') return root.replaceChildren(...profileScreen());
  const profile = path.match(/^\/u\/([a-z0-9_]{1,32})$/);
  if (profile) {
    let nodes;
    try {
      nodes = await userScreen(profile[1]);
    } catch (err) {
      nodes = shell(h('section', { className: 'card' }, emptyState('🤷', err.message, 'Puede que la cuenta ya no exista.')));
    }
    // Si mientras cargaba se navegó a otra pantalla, no pisarla.
    return location.pathname === path && root.replaceChildren(...nodes);
  }
  if (path === '/chat') return chatSocket || root.replaceChildren(...chatScreen());
  if (path === '/admin' && me.role === 'admin') return root.replaceChildren(...adminScreen());
  if (path !== '/') return go('/');
  root.replaceChildren(...feedScreen());
}

window.addEventListener('popstate', render);
render();
