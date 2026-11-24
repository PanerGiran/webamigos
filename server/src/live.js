// Avisos en vivo por el WebSocket. ws.js completa sendTo al arrancar; así las rutas no dependen del socket
// (y en los tests o sin WebSocket no pasa nada).
export const live = { sendTo() {} };
