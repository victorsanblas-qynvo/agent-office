import { createConnection } from 'node:net';

export const ORDER_PREFIX = '[Agent Office]';

export const ORDER_LEAD = `${ORDER_PREFIX} Orden del usuario desde el panel de la oficina:`;

export function orderText(text: string): string {
  return `${ORDER_LEAD} ${text.trim()}`;
}

// A message of the user to every lead: from the panel as well, but neither a task nor a plan of whoever reads it.
export const BROADCAST_LEAD = `${ORDER_PREFIX} Mensaje del usuario a todos los jefes desde el panel de la oficina:`;

export function broadcastText(text: string): string {
  return `${BROADCAST_LEAD} ${text.trim()}`;
}

// Not ORDER_PREFIX on purpose: the templates read what starts with it as an order of the user, and a chat line is not one.
export const CHAT_PREFIX = '[Chat de Agent Office]';

// What the user wrote in a channel, after the lines of the team the session had not seen yet.
export function chatInboxText(channel: string, pending: string, text: string): string {
  const lines = [`${CHAT_PREFIX} #${channel}`];
  if (pending) lines.push(pending);
  lines.push(`usuario: ${text.replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

export function encodeInbox(token: string | null, content: string): string {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: 'auth', token }));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content } }));
  return `${lines.join('\n')}\n`;
}

export function deliver(socketPath: string, payload: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error('tiempo de espera agotado'));
    }, timeoutMs);
    socket.on('connect', () => socket.end(payload));
    socket.on('error', (error) => finish(error));
    socket.on('close', (hadError) => {
      if (!hadError) finish();
    });
  });
}
