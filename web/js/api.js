// Vacío en la web (mismo origen). En una app nativa (Capacitor) va la URL del servidor, ej. 'https://tu-dominio.example'.
export const API_BASE = '';
export const WS_URL = `${(API_BASE || location.origin).replace(/^http/, 'ws')}/ws`;

export const getToken = () => localStorage.getItem('token');
export const setToken = (t) => (t ? localStorage.setItem('token', t) : localStorage.removeItem('token'));

const authHeader = () => (getToken() ? { authorization: `Bearer ${getToken()}` } : {});

export async function api(path, { method = 'GET', json, form } = {}) {
  const headers = { ...authHeader(), ...(json && { 'content-type': 'application/json' }) };
  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method, headers, body: json ? JSON.stringify(json) : form });
  } catch {
    throw new Error('Sin conexión.');
  }
  // Sesión vencida o revocada: volver al login.
  if (res.status === 401 && getToken()) {
    setToken(null);
    location.assign('/login');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data;
}

// Las imágenes exigen sesión, así que no alcanza con <img src>: se piden con el token y se muestran como blob.
export async function imageUrl(filename) {
  const res = await fetch(`${API_BASE}/api/media/${filename}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
