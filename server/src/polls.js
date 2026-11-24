// Validación de encuestas (posts y chat).
import { z } from 'zod';

// Opciones de encuesta que vienen como JSON en el formulario: 2 a 6, sin vacías ni repetidas.
const pollOptions = z.array(z.string().trim().min(1).max(100)).min(2).max(6).refine((a) => new Set(a.map((s) => s.toLowerCase())).size === a.length);
export function parsePoll(raw) {
  if (raw === undefined || raw === '') return { options: null };
  try {
    const r = pollOptions.safeParse(JSON.parse(raw));
    return r.success ? { options: r.data } : { error: true };
  } catch {
    return { error: true };
  }
}
