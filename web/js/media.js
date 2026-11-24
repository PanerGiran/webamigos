import { imageUrl } from './api.js';
import { fixWebm } from './webm.js';

export function renderMedia(media, { onOpenPhoto } = {}) {
  const box = document.createElement('div');
  box.className = 'attachment-media';
  if (!['image', 'video', 'audio'].includes(media.kind)) return box;
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
    if (media.kind === 'video') player.playsInline = true;
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

const RECORDING_TYPES = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
];
const MAX_RECORDING_MS = 120_000;

export function audioRecorder({ onRecorded, onError }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost audio-recorder';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.append(use);
  const time = document.createElement('span');
  button.append(svg, time);

  function updateButton(recording) {
    const label = recording ? 'Terminar de grabar' : 'Grabar audio';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.classList.toggle('recording', recording);
    use.setAttribute('href', recording ? '/icons.svg#stop' : '/icons.svg#mic');
    time.hidden = !recording;
  }
  updateButton(false);

  let recorder;
  button.onclick = async () => {
    if (recorder) {
      if (recorder.state === 'recording') recorder.stop();
      return;
    }
    const format = RECORDING_TYPES.find(([type]) => globalThis.MediaRecorder?.isTypeSupported(type));
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      onError('Este navegador no permite grabar audio.');
      return;
    }
    const [mimeType, extension] = format;
    button.disabled = true;
    let stream;
    let timer;
    let deadline;
    const reset = () => {
      clearInterval(timer);
      clearTimeout(deadline);
      stream?.getTracks().forEach((track) => track.stop());
      recorder = null;
      button.disabled = false;
      updateButton(false);
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!button.isConnected) {
        reset();
        return;
      }
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 });
      const active = recorder;
      const chunks = [];
      let failed = false;
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      active.onerror = () => {
        failed = true;
        onError('No se pudo grabar el audio.');
      };
      active.onstop = async () => {
        reset();
        if (failed || !button.isConnected) return;
        if (!chunks.length) {
          onError('No se grabó ningún audio.');
          return;
        }
        const file = new File(chunks, `Grabación.${extension}`, { type: active.mimeType || mimeType });
        // El teléfono a veces graba los tiempos con un salto (2 s que figuran como 2:59): se corrige acá.
        onRecorded(extension === 'webm' ? new File([fixWebm(new Uint8Array(await file.arrayBuffer()))], file.name, { type: file.type }) : file);
      };
      active.start();
      const startedAt = performance.now();
      time.textContent = '0:00';
      updateButton(true);
      button.disabled = false;
      const stop = () => {
        if (active.state === 'recording') active.stop();
      };
      deadline = setTimeout(stop, MAX_RECORDING_MS);
      timer = setInterval(() => {
        if (!button.isConnected) return stop();
        const seconds = Math.min(120, Math.floor((performance.now() - startedAt) / 1000));
        time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }, 250);
    } catch (err) {
      reset();
      onError(err.name === 'NotAllowedError' ? 'No diste permiso para usar el micrófono.' : 'No se pudo usar el micrófono.');
    }
  };
  return button;
}
