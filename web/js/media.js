import { imageUrl } from './api.js';
import { fixWebm } from './webm.js';

// Reproductores de audio ya armados: el chat redibuja todos los mensajes cuando llega uno nuevo, y así
// el audio que está sonando sigue (se mueve el mismo elemento en vez de crear otro).
const audioBoxes = new Map();

export function renderMedia(media, { onOpenPhoto } = {}) {
  if (media.kind === 'audio' && audioBoxes.has(media.filename)) return audioBoxes.get(media.filename);
  const box = document.createElement('div');
  box.className = 'attachment-media';
  if (!['image', 'video', 'audio'].includes(media.kind)) return box;
  if (media.kind === 'audio') {
    imageUrl(media.filename).then((url) => {
      if (!box.isConnected) return URL.revokeObjectURL(url);
      box.append(audioPlayer(url));
      audioBoxes.set(media.filename, box);
    }).catch(() => {
      box.textContent = 'No se pudo cargar el audio.';
    });
    return box;
  }
  const player = document.createElement(media.kind === 'image' ? 'img' : media.kind);
  let content = player;
  if (media.kind === 'image') {
    player.alt = 'Foto adjunta';
    if (onOpenPhoto) {
      const photo = document.createElement('button');
      photo.type = 'button';
      photo.className = 'attachment-photo';
      photo.setAttribute('aria-label', 'Abrir foto adjunta');
      photo.onclick = () => onOpenPhoto(player.src);
      photo.append(player);
      content = photo;
    }
  } else {
    player.controls = true;
    player.preload = 'metadata';
    player.playsInline = true;
  }

  imageUrl(media.filename).then((url) => {
    if (!box.isConnected) {
      URL.revokeObjectURL(url);
      return;
    }
    player.src = url;
    box.append(content);
  }).catch(() => {
    box.textContent = 'No se pudo cargar el adjunto.';
  });
  return box;
}

// --- Reproductor de audio propio (estilo mensaje de voz): igual en todos los navegadores y con los colores
// de la apariencia. Play/pausa, forma de onda que se puede tocar o arrastrar, tiempo y velocidad.
const BARS = 32;
const SPEEDS = [1, 1.5, 2];
let playing = null; // el audio que suena: al dar play a otro, este se pausa
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function audioPlayer(url) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  const box = el('div', 'audio-player');
  const play = el('button', 'audio-play');
  play.type = 'button';
  const bars = Array.from({ length: BARS }, () => el('span'));
  const seek = Object.assign(el('input', 'audio-seek'), { type: 'range', min: 0, max: 1000, step: 1, value: 0 });
  seek.setAttribute('aria-label', 'Posición del audio');
  const wave = el('div', 'audio-wave');
  wave.append(...bars, seek);
  const time = el('span', 'audio-time', '0:00');
  const speed = el('button', 'audio-speed', '1×');
  speed.type = 'button';
  speed.title = 'Velocidad';
  box.append(play, wave, time, speed);

  let duration = 0; // la del audio decodificado (la que dice el archivo puede venir mal)
  let shown = null;
  const total = () => duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
  function paint() {
    const d = total();
    const p = d ? Math.min(1, audio.currentTime / d) : 0;
    bars.forEach((b, i) => b.classList.toggle('on', (i + 0.5) / BARS <= p));
    seek.value = Math.round(p * 1000);
    time.textContent = clock(audio.paused && !audio.currentTime ? d : audio.currentTime);
    if (shown === audio.paused) return;
    shown = audio.paused;
    const label = audio.paused ? 'Reproducir audio' : 'Pausar audio';
    play.replaceChildren(svgIcon(audio.paused ? 'play' : 'pause'));
    play.setAttribute('aria-label', label);
    play.title = label;
  }
  const loop = () => {
    paint();
    if (!audio.paused) requestAnimationFrame(loop);
  };
  play.onclick = () => {
    if (!audio.paused) return audio.pause();
    if (playing && playing !== audio) playing.pause();
    playing = audio;
    audio.play().catch(() => {});
  };
  seek.oninput = () => {
    audio.currentTime = (seek.value / 1000) * total();
    paint();
  };
  speed.onclick = () => {
    audio.playbackRate = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length];
    speed.textContent = `${String(audio.playbackRate).replace('.', ',')}×`;
  };
  audio.onplay = loop;
  audio.onpause = paint;
  audio.onloadedmetadata = paint;
  audio.onended = () => {
    audio.currentTime = 0;
    paint();
  };
  paint();

  // Forma de onda y duración real: se decodifica una versión liviana (8 kHz, un canal).
  fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => new OfflineAudioContext(1, 1, 8000).decodeAudioData(buf))
    .then((decoded) => {
      duration = decoded.duration;
      const data = decoded.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / BARS));
      const peaks = bars.map((_, i) => {
        let max = 0;
        for (let k = i * step; k < Math.min(data.length, (i + 1) * step); k++) max = Math.max(max, Math.abs(data[k]));
        return max;
      });
      const top = Math.max(...peaks) || 1;
      bars.forEach((b, i) => (b.style.height = `${Math.max(14, Math.round((peaks[i] / top) * 100))}%`));
      paint();
    })
    .catch(() => {}); // sin forma de onda: quedan barras parejas y la duración del archivo
  return box;
}

const RECORDING_TYPES = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
];
const MAX_RECORDING_MS = 120_000;

// Grabar un audio. Mientras se graba, una barra ocupa el lugar del formulario (como en WhatsApp):
// borrar (cancela sin mandar), tiempo, pausar/seguir y enviar. `confirm` es [ícono, texto] del botón de enviar.
export function audioRecorder({ onRecorded, onError, confirm = ['send', 'Enviar audio'] }) {
  const button = el('button', 'ghost audio-recorder');
  button.type = 'button';
  button.append(svgIcon('mic'));
  button.setAttribute('aria-label', 'Grabar audio');
  button.title = 'Grabar audio';
  const iconButton = (name, label, className) => {
    const b = el('button', className);
    b.type = 'button';
    b.append(svgIcon(name));
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  };

  let busy = false;
  button.onclick = async () => {
    if (busy) return;
    const format = RECORDING_TYPES.find(([type]) => globalThis.MediaRecorder?.isTypeSupported(type));
    if (!format || !navigator.mediaDevices?.getUserMedia) return onError('Este navegador no permite grabar audio.');
    const [mimeType, extension] = format;
    busy = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      busy = false;
      return onError(err.name === 'NotAllowedError' ? 'No diste permiso para usar el micrófono.' : 'No se pudo usar el micrófono.');
    }
    const host = button.closest('form') ?? button.parentElement;
    if (!host) {
      stream.getTracks().forEach((t) => t.stop());
      busy = false;
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 });
    const chunks = [];
    let failed = false;
    let cancelled = false;
    let recorded = 0; // ms grabados antes de la última pausa
    let since = performance.now(); // desde cuándo graba (si no está en pausa)
    const elapsed = () => recorded + (recorder.state === 'recording' ? performance.now() - since : 0);

    const time = el('span', 'rec-time', '0:00');
    const state = el('span', 'rec-state', 'Grabando…');
    const cancel = iconButton('trash', 'Borrar grabación', 'ghost danger rec-cancel');
    const pause = iconButton('pause', 'Pausar grabación', 'soft rec-pause');
    const send = iconButton(confirm[0], confirm[1], 'primary rec-send');
    const bar = el('div', 'rec-bar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Grabando audio');
    bar.append(cancel, el('span', 'rec-dot'), time, state, pause, send);
    host.append(bar);
    host.classList.add('is-recording');

    const finish = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      bar.remove();
      host.classList.remove('is-recording');
      busy = false;
    };
    const stop = () => {
      if (recorder.state === 'recording') recorded += performance.now() - since; // después de stop, elapsed() ya no lo suma
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const tick = () => {
      if (!button.isConnected) return (cancelled = true), stop(); // se fue de la pantalla: no se manda
      const ms = elapsed();
      if (ms >= MAX_RECORDING_MS) stop();
      const s = Math.min(MAX_RECORDING_MS / 1000, Math.floor(ms / 1000));
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const timer = setInterval(tick, 250);

    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onerror = () => {
      failed = true;
      onError('No se pudo grabar el audio.');
    };
    recorder.onstop = async () => {
      finish();
      if (failed || cancelled) return;
      if (!chunks.length || elapsed() < 500) return onError('El audio quedó vacío.');
      const file = new File(chunks, `Grabación.${extension}`, { type: recorder.mimeType || mimeType });
      // El teléfono a veces graba los tiempos con un salto (2 s que figuran como 2:59): se corrige acá.
      onRecorded(extension === 'webm' ? new File([fixWebm(new Uint8Array(await file.arrayBuffer()))], file.name, { type: file.type }) : file);
    };

    cancel.onclick = () => {
      cancelled = true;
      stop();
    };
    send.onclick = stop;
    pause.onclick = () => {
      if (recorder.state === 'recording') {
        recorder.pause();
        recorded += performance.now() - since;
      } else if (recorder.state === 'paused') {
        recorder.resume();
        since = performance.now();
      }
      const paused = recorder.state === 'paused';
      bar.classList.toggle('paused', paused);
      state.textContent = paused ? 'En pausa' : 'Grabando…';
      const label = paused ? 'Seguir grabando' : 'Pausar grabación';
      pause.replaceChildren(svgIcon(paused ? 'mic' : 'pause'));
      pause.setAttribute('aria-label', label);
      pause.title = label;
    };

    recorder.start();
    since = performance.now();
    send.focus();
  };
  return button;
}
