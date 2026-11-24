import { api, getToken, imageUrl, setToken, WS_URL } from './api.js';
import { LOOKS } from './looks.js';

const root = document.getElementById('app');
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_PHOTOS = 6; // por post (igual que en el servidor)
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

// Visor de fotos a pantalla completa (se cierra con un toque o con Esc). En un álbum: flechas, teclado o deslizar.
const lightboxImg = h('img', { alt: '' });
const lbPrev = h('button', { type: 'button', className: 'lb-nav prev', ariaLabel: 'Foto anterior' }, '‹');
const lbNext = h('button', { type: 'button', className: 'lb-nav next', ariaLabel: 'Foto siguiente' }, '›');
const lbCount = h('span', { className: 'lb-count' });
const lightbox = h('dialog', { className: 'lightbox', onclick: () => lightbox.close() }, lightboxImg, lbPrev, lbNext, lbCount);
document.body.append(lightbox);
let lbList = [];
let lbIndex = 0;
function showLb() {
  lightboxImg.src = lbList[lbIndex];
  lbPrev.hidden = lbNext.hidden = lbCount.hidden = lbList.length < 2;
  lbCount.textContent = `${lbIndex + 1} / ${lbList.length}`;
}
const lbStep = (d) => {
  lbIndex = (lbIndex + d + lbList.length) % lbList.length;
  showLb();
};
lbPrev.onclick = (e) => (e.stopPropagation(), lbStep(-1));
lbNext.onclick = (e) => (e.stopPropagation(), lbStep(1));
lightbox.onkeydown = (e) => (e.key === 'ArrowLeft' ? lbStep(-1) : e.key === 'ArrowRight' ? lbStep(1) : null);
let lbTouchX = 0;
lightbox.addEventListener('touchstart', (e) => (lbTouchX = e.touches[0].clientX), { passive: true });
lightbox.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - lbTouchX;
  if (lbList.length > 1 && Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1);
});
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

function openPhoto(src, list = [src], index = 0) {
  lbList = list;
  lbIndex = index;
  showLb();
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

// Marca de la app: dos círculos sobre el color de acento de la apariencia elegida.
const brandMark = () => h('span', { className: 'brand-mark', ariaHidden: 'true' });

function shell(...children) {
  const path = location.pathname;
  return [
    h(
      'header',
      { className: 'top' },
      link('/', { className: 'brand' }, brandMark(), 'Amigos'),
      h(
        'nav',
        {},
        link('/buscar', { className: `navlink${path === '/buscar' ? ' active' : ''}`, title: 'Buscar' }, icon('search')),
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
    h('div', { className: 'auth-box fade-in' }, h('div', { className: 'auth-head' }, brandMark(), h('h1', {}, 'Amigos'), h('p', {}, subtitle)), form),
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
  const text = withMentions(h('textarea', { maxLength: 5000, rows: 1, placeholder }));
  // El cuadro crece con el texto.
  text.oninput = () => {
    text.style.height = 'auto';
    text.style.height = `${text.scrollHeight}px`;
  };
  // Fotos elegidas (hasta MAX_PHOTOS), cada una con su vista previa.
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true, hidden: true });
  let photos = [];
  const preview = h('div', { className: 'preview-grid', hidden: true });
  function drawPreviews() {
    preview.replaceChildren(
      ...photos.map((ph, i) =>
        h('div', { className: 'preview-wrap' }, h('img', { src: ph.url, alt: `Foto ${i + 1}` }), btn('x', 'Quitar foto', () => {
          URL.revokeObjectURL(ph.url);
          photos.splice(i, 1);
          drawPreviews();
        }, '', { iconOnly: true })),
      ),
    );
    preview.hidden = !photos.length;
  }
  const clear = () => {
    photos.forEach((ph) => URL.revokeObjectURL(ph.url));
    photos = [];
    drawPreviews();
  };
  file.onchange = () => {
    const picked = [...file.files];
    file.value = '';
    const ok = picked.filter((f) => f.size <= MAX_IMAGE);
    const tooBig = picked.length - ok.length;
    const room = MAX_PHOTOS - photos.length;
    photos.push(...ok.slice(0, room).map((f) => ({ file: f, url: URL.createObjectURL(f) })));
    msg.textContent = tooBig ? `${tooBig === 1 ? 'Una foto pasa' : `${tooBig} fotos pasan`} los 5 MB.` : ok.length > room ? `Máximo ${MAX_PHOTOS} fotos por post.` : '';
    drawPreviews();
  };
  // Encuesta: el texto del post es la pregunta; de 2 a 6 opciones.
  let pollOn = false;
  const pollBox = h('div', { className: 'poll-editor', hidden: true });
  const optionInput = () => withMentions(h('input', { maxLength: 100, placeholder: 'Opción' }));
  let optionInputs = [];
  function drawPoll() {
    pollBox.replaceChildren(
      h('div', { className: 'poll-editor-head' }, h('strong', {}, '📊 Encuesta'), btn('x', 'Quitar encuesta', () => togglePoll(false), 'ghost', { iconOnly: true })),
      ...optionInputs.map((inp, i) =>
        h('div', { className: 'poll-option-row' }, inp, optionInputs.length > 2 && btn('x', 'Quitar opción', () => (optionInputs.splice(i, 1), drawPoll()), 'ghost', { iconOnly: true })),
      ),
      ...[optionInputs.length < 6 && h('button', { type: 'button', className: 'ghost sm', onclick: () => (optionInputs.push(optionInput()), drawPoll(), optionInputs.at(-1).focus()) }, '+ Agregar opción')].filter(Boolean),
    );
  }
  function togglePoll(on) {
    pollOn = on;
    optionInputs = on ? [optionInput(), optionInput()] : [];
    pollBox.hidden = !on;
    text.placeholder = on ? 'Escribí la pregunta…' : placeholder;
    if (on) {
      drawPoll();
      text.focus();
    }
  }

  return h(
    'form',
    {
      className: 'card composer',
      onsubmit: onSubmit(msg, async () => {
        if (!text.value.trim() && !photos.length) throw new Error('Escribí algo o elegí una foto.');
        const options = optionInputs.map((i) => i.value.trim()).filter(Boolean);
        if (pollOn && !text.value.trim()) throw new Error('Escribí la pregunta de la encuesta.');
        if (pollOn && options.length < 2) throw new Error('La encuesta necesita al menos 2 opciones.');
        const form = new FormData();
        if (pollOn) form.append('poll', JSON.stringify(options));
        form.append('body', text.value);
        form.append('scope', scope);
        for (const ph of photos) form.append('images', ph.file);
        await api('/posts', { method: 'POST', form });
        text.value = '';
        text.style.height = '';
        clear();
        togglePoll(false);
        toast('¡Publicado!');
        onPosted();
      }),
    },
    h('div', { className: 'composer-top' }, avatar(me), text),
    preview,
    pollBox,
    msg,
    h(
      'div',
      { className: 'composer-bar' },
      h('div', { className: 'composer-tools' }, btn('image', 'Foto', () => file.click(), 'ghost'), btn('poll', 'Encuesta', () => togglePoll(!pollOn), 'ghost')),
      file,
      h('button', { className: 'primary' }, icon('send'), 'Publicar'),
    ),
  );
}

// Texto escrito por usuarios: queda como texto plano, salvo los @usuario, que pasan a ser links al perfil.
const MENTION = /(?<![\w@])@([a-z0-9_]{3,32})/gi;
function richText(s) {
  const out = [];
  let last = 0;
  for (const m of (s ?? '').matchAll(MENTION)) {
    out.push(s.slice(last, m.index), link(`/u/${m[1].toLowerCase()}`, { className: 'mention' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push((s ?? '').slice(last));
  return out.filter((x) => x !== '');
}

// --- Sugerencias de @menciones (una sola caja para toda la app) ---

let usersPromise = null;
const loadUsers = () => (usersPromise ??= api('/users').then((r) => r.users).catch(() => ((usersPromise = null), [])));
const mentionBox = h('div', { className: 'mention-box', hidden: true, role: 'listbox' });
document.body.append(mentionBox);
let mention = null; // { input, start, items, index }

function closeMentions() {
  mention = null;
  mentionBox.hidden = true;
}
function pickMention(u) {
  const { input, start } = mention;
  const end = input.selectionStart;
  input.value = `${input.value.slice(0, start)}@${u.username} ${input.value.slice(end)}`;
  const caret = start + u.username.length + 2;
  input.setSelectionRange(caret, caret);
  closeMentions();
  input.dispatchEvent(new Event('input'));
  input.focus();
}
function drawMentions() {
  const r = mention.input.getBoundingClientRect();
  const above = r.bottom + 230 > innerHeight; // el cuadro del chat está abajo: la lista va arriba
  Object.assign(mentionBox.style, {
    left: `${Math.max(8, r.left)}px`,
    width: `${Math.min(r.width, 320)}px`,
    top: above ? 'auto' : `${r.bottom + 4}px`,
    bottom: above ? `${innerHeight - r.top + 4}px` : 'auto',
  });
  mentionBox.replaceChildren(
    ...mention.items.map((u, i) =>
      h('button', {
        type: 'button',
        className: `mention-item${i === mention.index ? ' active' : ''}`,
        onmousedown: (e) => (e.preventDefault(), pickMention(u)), // mousedown: antes de que el cuadro pierda el foco
      }, avatar(u, 'xs'), h('span', {}, u.display_name), h('span', { className: 'muted small' }, `@${u.username}`)),
    ),
  );
  mentionBox.hidden = false;
}
async function updateMentions(input) {
  const m = input.value.slice(0, input.selectionStart).match(/(?:^|[^\w@])@([a-z0-9_]{0,32})$/i);
  if (!m) return closeMentions();
  const q = m[1].toLowerCase();
  const items = (await loadUsers()).filter((u) => u.id !== me.id && (u.username.startsWith(q) || u.display_name.toLowerCase().includes(q))).slice(0, 5);
  if (!items.length || document.activeElement !== input) return closeMentions();
  mention = { input, start: input.selectionStart - m[1].length - 1, items, index: 0 };
  drawMentions();
}
// Engancha las sugerencias a un cuadro de texto. Hay que llamarlo antes de asignarle su propio onkeydown.
function withMentions(input) {
  input.addEventListener('input', () => updateMentions(input));
  input.addEventListener('keydown', (e) => {
    if (!mention || mention.input !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
      drawMentions();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation(); // que Enter elija a la persona en vez de mandar el mensaje
      pickMention(mention.items[mention.index]);
    } else if (e.key === 'Escape') closeMentions();
  });
  input.addEventListener('blur', () => setTimeout(() => mention?.input === input && closeMentions(), 150));
  return input;
}
const editedTag = () => h('span', { className: 'edited', title: 'Editado' }, ' · editado');

// Editor en el lugar: cambia `el` por un cuadro de texto; al guardar llama a save(texto) y vuelve a mostrar `el`.
function editInPlace(el, current, { maxLength, save }) {
  const input = withMentions(h('textarea', { value: current, maxLength, rows: 3 }));
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

// Fotos de un post: una sola a todo el ancho; varias en grilla (hasta 4 visibles, "+N" en la última).
// Tocar cualquiera abre el visor con todo el álbum.
function gallery(images, alt) {
  const urls = images.map(() => null);
  // shortcut: los blobs no se liberan (los usa el visor); con miles de fotos en una sesión, liberar los que salen de pantalla.
  const loads = images.map((img, i) => imageUrl(img.filename).then((url) => (urls[i] = url)));
  const open = async (i) => {
    await Promise.allSettled(loads);
    const ok = urls.map((u, j) => [u, j]).filter(([u]) => u);
    if (ok.length) openPhoto(null, ok.map(([u]) => u), Math.max(0, ok.findIndex(([, j]) => j === i)));
  };
  const n = Math.min(images.length, 4);
  return h(
    'div',
    { className: `gallery n${n}` },
    ...images.slice(0, 4).map((img, i) => {
      const el = h('img', { className: 'photo', alt, width: img.width, height: img.height });
      loads[i].then((url) => (el.src = url)).catch(() => el.replaceWith(h('span', { className: 'muted small' }, '(no se pudo cargar)')));
      return h('div', { className: 'cell', onclick: () => open(i) }, el, i === 3 && images.length > 4 && h('span', { className: 'more' }, `+${images.length - 4}`));
    }),
  );
}

// Encuesta de un post: tocar una opción vota (o saca el voto si ya era la tuya). Siempre muestra resultados.
function pollBlock(p) {
  const box = h('div', { className: 'poll' });
  const vote = safe(async (optionId) => {
    const r = await api(`/posts/${p.id}/vote`, { method: 'PUT', json: { option_id: p.poll.my_vote === optionId ? null : optionId } });
    p.poll = r.poll;
    draw();
  });
  async function showVoters() {
    const { options } = await api(`/posts/${p.id}/votes`);
    openSheet(
      'Votos',
      ...options.map((o) =>
        h(
          'div',
          { className: 'react-group' },
          h('div', { className: 'react-emoji' }, h('span', {}, o.text), h('span', { className: 'muted small' }, String(o.users.length))),
          ...(o.users.length ? o.users.map((u) => profileLink(u, { className: 'person' }, avatar(u, 'sm'), h('span', {}, u.display_name))) : [h('p', { className: 'muted small' }, 'Nadie todavía')]),
        ),
      ),
    );
  }
  function draw() {
    const { options, total, my_vote } = p.poll;
    box.replaceChildren(
      ...options.map((o) => {
        const pct = total ? Math.round((o.votes / total) * 100) : 0;
        const b = h(
          'button',
          { type: 'button', className: `poll-option${o.id === my_vote ? ' mine' : ''}`, onclick: () => vote(o.id) },
          h('span', { className: 'poll-text' }, o.id === my_vote && icon('check'), o.text),
          h('span', { className: 'poll-pct' }, `${pct}%`),
        );
        b.style.setProperty('--pct', `${pct}%`);
        b.setAttribute('aria-pressed', o.id === my_vote);
        return b;
      }),
      h('div', { className: 'poll-foot muted small' }, `${total} voto${total === 1 ? '' : 's'}`, total > 0 && h('button', { type: 'button', className: 'who-reacted', onclick: safe(showVoters) }, 'quiénes votaron')),
    );
  }
  draw();
  return box;
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
  if (p.poll) card.append(pollBlock(p));
  const images = p.images?.length ? p.images : p.filename ? [{ filename: p.filename, width: p.width, height: p.height }] : [];
  if (images.length) card.append(gallery(images, p.body ? '' : `Foto de ${p.display_name}`));
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
  const input = withMentions(h('input', { maxLength: 1000, placeholder: 'Escribí un comentario…', required: true, autocomplete: 'off' }));
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
      toggle('mentions', 'Cuando me mencionan con @'),
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

// Editor de encuadre: arrastrar mueve la imagen y la barra (o la rueda) acerca. Nunca deja bordes vacíos.
// Devuelve la zona elegida en píxeles de la imagen original ({ left, top, width, height }) o null si se cancela.
// El recorte lo hace el servidor: así no se pierde calidad y los GIF siguen animados.
function frameImage(file, { aspect, round = false, title }) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = h('img', { alt: '', draggable: false });
    const view = h('div', { className: `frame-view${round ? ' round' : ''}` }, img);
    view.style.aspectRatio = String(aspect);
    const zoom = h('input', { type: 'range', min: 1, max: 4, step: 0.01, value: 1, ariaLabel: 'Acercar o alejar' });
    let W, H, Vw, Vh, base, tx, ty, last;
    const scale = () => base * Number(zoom.value);
    function paint() {
      const S = scale();
      tx = Math.min(0, Math.max(Vw - W * S, tx));
      ty = Math.min(0, Math.max(Vh - H * S, ty));
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`;
    }
    img.onload = () => {
      [W, H, Vw, Vh] = [img.naturalWidth, img.naturalHeight, view.clientWidth, view.clientHeight];
      Object.assign(img.style, { width: `${W}px`, height: `${H}px` });
      base = last = Math.max(Vw / W, Vh / H); // la imagen cubre todo el marco
      tx = (Vw - W * base) / 2;
      ty = (Vh - H * base) / 2;
      paint();
    };
    // Acercar sobre el centro del marco.
    zoom.oninput = () => {
      const cx = (Vw / 2 - tx) / last;
      const cy = (Vh / 2 - ty) / last;
      last = scale();
      tx = Vw / 2 - cx * last;
      ty = Vh / 2 - cy * last;
      paint();
    };
    let drag = null;
    view.onpointerdown = (e) => {
      drag = { x: e.clientX - tx, y: e.clientY - ty };
      view.setPointerCapture(e.pointerId);
    };
    view.onpointermove = (e) => {
      if (!drag) return;
      tx = e.clientX - drag.x;
      ty = e.clientY - drag.y;
      paint();
    };
    view.onpointerup = view.onpointercancel = () => (drag = null);
    view.onwheel = (e) => {
      e.preventDefault();
      zoom.value = Math.min(4, Math.max(1, Number(zoom.value) - e.deltaY * 0.002));
      zoom.oninput();
    };

    const dlg = h('dialog', { className: 'sheet frame-dialog' });
    const done = (value) => {
      dlg.close();
      dlg.remove();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onerror = () => {
      done(null);
      toast('No se pudo abrir esa imagen.', 'error');
    };
    dlg.oncancel = (e) => (e.preventDefault(), done(null)); // Esc
    const save = () => {
      const S = scale();
      done({ left: Math.round(-tx / S), top: Math.round(-ty / S), width: Math.round(Vw / S), height: Math.round(Vh / S) });
    };
    dlg.append(
      h('div', { className: 'sheet-head' }, h('h2', {}, title)),
      h(
        'div',
        { className: 'sheet-body' },
        view,
        h('div', { className: 'zoom' }, h('span', { className: 'muted small' }, '−'), zoom, h('span', { className: 'muted small' }, '+')),
        h('p', { className: 'muted small' }, 'Arrastrá la imagen para moverla y usá la barra para acercar.'),
        h('div', { className: 'row frame-actions' }, h('button', { type: 'button', className: 'ghost', onclick: () => done(null) }, 'Cancelar'), h('button', { type: 'button', className: 'primary', onclick: save }, 'Usar este encuadre')),
      ),
    );
    document.body.append(dlg);
    dlg.showModal();
    img.src = url; // después de mostrar el diálogo, así el marco ya tiene tamaño al medir
  });
}

// Franja de portada: la foto si hay, si no el degradado de la marca.
function coverBox(filename, extra = '') {
  const box = h('div', { className: `cover ${extra}` });
  if (filename) imageUrl(filename).then((url) => box.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
  return box;
}

// --- Apariencia (la aplica js/theme.js; se guarda en este dispositivo) ---
// Las apariencias se definen en css/looks.css y se listan en js/looks.js.

const currentLook = () => localStorage.getItem('look') || 'clasico';
// La apariencia se guarda también en la cuenta: tu perfil se ve con ella y la recuperás en otro dispositivo.
const saveLook = (id) => {
  if (me) me.look = id;
  api('/me/look', { method: 'PUT', json: { look: id } }).catch(() => {});
};

// Grilla de apariencias, cada una con una mini vista previa pintada con sus propios colores.
function lookGrid() {
  const grid = h('div', { className: 'look-grid', role: 'radiogroup', ariaLabel: 'Apariencia' });
  const draw = () =>
    grid.replaceChildren(
      ...LOOKS.map((look) => {
        const preview = h('div', { className: 'look-preview' }, h('div', { className: 'lp-card' }, h('div', { className: 'lp-title' }, 'Amigos'), h('div', { className: 'lp-line' }), h('div', { className: 'lp-line' }), h('div', { className: 'lp-button' })));
        preview.dataset.look = look.id;
        const b = h('button', {
          type: 'button',
          className: `look-option${look.id === currentLook() ? ' selected' : ''}`,
          onclick: () => {
            localStorage.setItem('look', look.id);
            saveLook(look.id);
            window.applyTheme();
            draw();
          },
        }, preview, h('span', { className: 'look-name' }, look.name), h('span', { className: 'look-desc' }, look.description));
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', look.id === currentLook());
        return b;
      }),
    );
  draw();
  return grid;
}

// Modo claro / oscuro / automático (sigue al teléfono).
function modeTabs() {
  const opts = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];
  const bar = h('div', { className: 'tabs', role: 'radiogroup', ariaLabel: 'Modo' });
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
  return bar;
}

// Editar perfil: apariencia y modo.
function appearanceCard() {
  return h(
    'section',
    { className: 'card fade-in' },
    h('h2', {}, 'Apariencia'),
    lookGrid(),
    h('h3', { className: 'subhead' }, 'Modo'),
    h('p', { className: 'muted small', style: 'margin-bottom:10px' }, 'Automático sigue el modo de tu teléfono.'),
    modeTabs(),
  );
}

// La primera vez que se entra en un dispositivo: elegir cómo se ve la app (después se cambia en Editar perfil).
function welcomeLookScreen() {
  return h(
    'main',
    { className: 'welcome' },
    h('h1', {}, `¡Hola, ${me.display_name.split(' ')[0]}!`),
    h('p', { className: 'muted' }, 'Elegí cómo querés ver Amigos. Lo podés cambiar cuando quieras desde Editar perfil.'),
    lookGrid(),
    h('h3', { className: 'subhead' }, 'Modo'),
    modeTabs(),
    h('button', {
      className: 'primary block',
      onclick: () => {
        localStorage.setItem('look', currentLook()); // si no tocó ninguna, queda la clásica y no se vuelve a preguntar
        saveLook(currentLook());
        render();
      },
    }, 'Listo'),
  );
}

// Editar perfil: fondo de pantalla de tu perfil (solo se ve en tu perfil).
function backgroundField() {
  let bg = null;
  const slot = h('div', {});
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  function draw() {
    const preview = h('div', { className: 'bg-preview' });
    if (bg) imageUrl(bg).then((url) => preview.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
    slot.replaceChildren(
      bg ? preview : h('p', { className: 'muted small' }, 'Sin fondo: tu perfil usa el color de tu apariencia.'),
      h('div', { className: 'actions', style: 'border:0;padding:0;margin-top:8px' },
        btn('image', bg ? 'Cambiar fondo' : 'Poner fondo', () => file.click(), 'soft sm'),
        bg && btn('trash', 'Quitar fondo', safe(async () => {
          if (!confirm('¿Quitar el fondo de tu perfil?')) return;
          await api('/me/background', { method: 'DELETE' });
          bg = null;
          draw();
          toast('Fondo quitado');
        }), 'soft danger sm'),
      ),
    );
  }
  file.onchange = safe(async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > MAX_IMAGE) throw new Error('La imagen pasa los 5 MB.');
    const form = new FormData();
    form.append('image', f);
    toast('Subiendo fondo…');
    bg = (await api('/me/background', { method: 'PUT', form })).profile_bg;
    draw();
    toast('Fondo actualizado');
  });
  draw();
  api(`/users/${me.username}`).then(({ user }) => ((bg = user.profile_bg), draw())).catch(() => {});
  return h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Fondo de tu perfil'), slot, file);
}

// Editar perfil: nombre, bio y portada.
function profileInfoCard() {
  const name = h('input', { required: true, maxLength: 64, value: me.display_name });
  const bio = withMentions(h('textarea', { maxLength: 300, rows: 3, placeholder: 'Contá algo de vos (opcional)' }));
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
    const crop = await frameImage(f, { aspect: 3, title: 'Encuadrá la portada' });
    if (!crop) return;
    const form = new FormData();
    form.append('image', f);
    form.append('crop', JSON.stringify(crop));
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
    backgroundField(),
    label('Nombre visible', name),
    h('label', {}, h('span', {}, 'Bio'), bio, count),
    msg,
    h('button', {}, 'Guardar perfil'),
  );
}

// --- Buscador ---

function searchScreen() {
  const input = h('input', { type: 'search', placeholder: 'Buscar posts o personas…', value: new URLSearchParams(location.search).get('q') ?? '', autocomplete: 'off', ariaLabel: 'Buscar' });
  const results = h('div', {});
  let timer;
  let seq = 0;
  async function run() {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `/buscar?q=${encodeURIComponent(q)}` : '/buscar'); // al volver atrás se conserva la búsqueda
    if (q.length < 2) return results.replaceChildren(h('p', { className: 'muted center small' }, 'Escribí al menos 2 letras.'));
    const mine = ++seq;
    results.replaceChildren(h('p', { className: 'muted center small' }, 'Buscando…'));
    try {
      const { users, posts } = await api(`/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return; // mientras tanto se escribió otra cosa
      results.replaceChildren(
        ...[
          users.length && h('section', { className: 'card' }, h('h2', {}, 'Personas'), ...users.map((u) => profileLink(u, { className: 'person' }, avatar(u, 'sm'), h('span', {}, u.display_name), h('span', { className: 'muted small' }, `@${u.username}`)))),
          posts.length && h('h2', { className: 'section-title' }, `Posts (${posts.length}${posts.length === 30 ? '+' : ''})`),
          ...posts.map(postCard),
          !users.length && !posts.length && emptyState('🔎', 'No encontré nada.', 'Probá con otra palabra.'),
        ].filter(Boolean),
      );
    } catch (err) {
      if (mine === seq) results.replaceChildren(h('p', { className: 'error center' }, err.message));
    }
  }
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  };
  setTimeout(() => input.focus());
  run();
  return shell(h('div', { className: 'card search-bar' }, icon('search'), input), results);
}

// Fondo de pantalla del perfil (fijo detrás del contenido). Sin foto, el color de fondo de la apariencia del dueño.
function profileBackground(filename) {
  const layer = h('div', { className: 'profile-bg' });
  if (filename) imageUrl(filename).then((url) => layer.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
  return layer;
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
  const page = h('div', { className: 'profile-page' }, profileBackground(user.profile_bg), head, tabBar, content);
  if (user.look) page.dataset.look = user.look;
  return shell(page);
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
    closeLive();
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
    const crop = await frameImage(f, { aspect: 1, round: true, title: 'Encuadrá tu foto' });
    if (!crop) return;
    const form = new FormData();
    form.append('image', f);
    form.append('crop', JSON.stringify(crop));
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

// --- Conexión en vivo: una sola para toda la app (chat, conectados y avisos) ---

let liveSocket = null;
let liveReady = false; // ya se autenticó: recién ahí se puede mandar
let liveRetry = 0;
let livePresence = [];
let liveScreen = null; // la pantalla abierta que quiere los eventos (el chat); render() la limpia

function sendLive(msg) {
  if (!liveReady) return false;
  liveSocket.send(JSON.stringify(msg));
  return true;
}

function connectLive() {
  if (liveSocket) return;
  const ws = new WebSocket(WS_URL);
  liveSocket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ready') (liveReady = true), (liveRetry = 0);
    else if (msg.type === 'presence') livePresence = msg.users;
    else if (msg.type === 'notify') liveToast(msg);
    else if (msg.type === 'error') toast(msg.error, 'error');
    // Mensaje del chat: aviso solo si no lo estás mirando y no lo mandaste vos.
    else if (msg.type === 'message' && msg.message.user_id !== me?.id && location.pathname !== '/chat') {
      liveToast({ kind: 'chat', from: msg.message, text: msg.message.body || '📎 Mandó un adjunto', url: '/chat' });
    }
    liveScreen?.(msg);
  };
  ws.onclose = (e) => {
    liveReady = false;
    if (liveSocket !== ws) return; // se cerró a propósito (cerrar sesión)
    liveSocket = null;
    liveScreen?.({ type: 'closed' });
    if (e.code === 4001) {
      setToken(null);
      return location.assign('/login');
    }
    // Reintenta cada vez más espaciado (2 s, 4 s… hasta 30 s): si el servidor está caído no insiste en loop.
    setTimeout(() => getToken() && connectLive(), Math.min(30_000, 2000 * 2 ** liveRetry++));
  };
}

function closeLive() {
  const ws = liveSocket;
  liveSocket = null;
  liveReady = false;
  ws?.close();
}

// Avisos abajo a la derecha: foto, nombre, qué pasó y el texto. Rojo para chat y comentarios.
const liveBox = h('div', { className: 'live-toasts' });
liveBox.setAttribute('aria-live', 'polite');
document.body.append(liveBox);
const LIVE_KINDS = { chat: ['Chat', true], comment: ['Comentario', true], mention: ['Mención', false], post: ['Post nuevo', false] };
function liveToast({ kind, from, text, url }) {
  const [tag, red] = LIVE_KINDS[kind] ?? ['Aviso', false];
  const close = () => el.remove();
  const el = h(
    'div',
    {
      className: `live-toast${red ? ' red' : ''}`,
      role: 'status',
      onclick: (e) => {
        if (e.target.closest('.live-close')) return;
        close();
        go(url);
      },
    },
    avatar(from, 'sm'),
    h('div', { className: 'live-body' }, h('div', { className: 'live-top' }, h('strong', {}, from.display_name), h('span', { className: 'live-tag' }, tag)), h('p', {}, text)),
    btn('x', 'Cerrar aviso', close, 'ghost live-close', { iconOnly: true }),
  );
  liveBox.prepend(el);
  while (liveBox.children.length > 3) liveBox.lastChild.remove();
  setTimeout(close, 6000);
}
const hourFmt = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short' });
const dayHourFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function chatScreen() {
  let messages = [];
  let more = false;
  const list = h('div', { className: 'chat-list' });
  const status = h('span', { className: 'muted small' }, 'Conectando…');
  const online = h('div', { className: 'online' });
  const input = withMentions(h('textarea', { rows: 1, maxLength: 2000, placeholder: 'Escribí un mensaje…' }));
  const sendBtn = h('button', { className: 'primary icon-only', ariaLabel: 'Enviar', disabled: true }, icon('send'));
  const olderBtn = h('button', { type: 'button', className: 'soft sm older' }, 'Ver mensajes anteriores');

  let activeId = null; // mensaje con la barra de acciones abierta (se abre tocándolo)
  let replyTo = null;
  const replyBar = h('div', { className: 'reply-bar', hidden: true });
  const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const react = (m, emoji) => {
    const on = !m.reactions?.some((r) => r.emoji === emoji && r.user_ids.includes(me.id));
    sendLive({ type: 'react', message_id: m.id, emoji, on });
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

  function drawOnline(users) {
    const n = users.length;
    online.replaceChildren(
      h('div', { className: 'stack' }, users.slice(0, 5).map((u) => avatar(u, 'xs'))),
      h('span', { className: 'muted small' }, `${n} conectado${n === 1 ? '' : 's'}`),
    );
    online.title = users.map((u) => u.display_name).join(', ');
  }

  // Eventos de la conexión global mientras el chat está abierto.
  liveScreen = (msg) => {
    if (msg.type === 'ready') {
      status.textContent = 'En línea';
      sendBtn.disabled = false;
      loadLatest().catch((err) => toast(err.message, 'error')); // al reconectar trae lo que se perdió
    } else if (msg.type === 'closed') {
      sendBtn.disabled = true;
      status.textContent = 'Reconectando…';
    } else if (msg.type === 'message' && !messages.some((m) => m.id === msg.message.id)) {
      messages.push(msg.message);
      draw(msg.message.user_id === me.id ? 'bottom' : undefined);
    } else if (msg.type === 'reactions') {
      const m = messages.find((x) => x.id === msg.message_id);
      if (m) (m.reactions = msg.reactions), draw();
    } else if (msg.type === 'presence') drawOnline(msg.users);
  };

  const send = () => {
    const body = input.value.trim();
    if (!body) return;
    if (!sendLive({ type: 'message', body, ...(replyTo && { reply_to: replyTo.id }) })) return toast('Sin conexión: esperá a que vuelva.', 'error');
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
  drawOnline(livePresence);
  // Si la conexión ya estaba lista (lo normal), no va a llegar otro "ready": se arranca acá.
  if (liveReady) liveScreen({ type: 'ready' });
  const nodes = shell(
    h('div', { className: 'chat-head' }, link('/', { className: 'back chat-back', title: 'Volver al feed' }, '← Feed'), h('div', { className: 'chat-title' }, h('h1', {}, 'Chat del grupo'), status), online),
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
  closeMentions();
  liveScreen = null; // la pantalla nueva vuelve a engancharse si quiere eventos
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
  connectLive();
  if (!localStorage.getItem('look') && me.look) {
    localStorage.setItem('look', me.look);
    window.applyTheme();
  } else if (localStorage.getItem('look') && !me.look) saveLook(localStorage.getItem('look'));
  if (!localStorage.getItem('look')) return root.replaceChildren(welcomeLookScreen());
  if (path === '/perfil') return root.replaceChildren(...profileScreen());
  if (path === '/buscar') return root.replaceChildren(...searchScreen());
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
  if (path === '/chat') return root.replaceChildren(...chatScreen());
  if (path === '/admin' && me.role === 'admin') return root.replaceChildren(...adminScreen());
  if (path !== '/') return go('/');
  root.replaceChildren(...feedScreen());
}

window.addEventListener('popstate', render);
render();
