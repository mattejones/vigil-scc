import { SshRegistry } from './registry.js';
import { queue } from '../queue/queue.js';

export { SshRegistry } from './registry.js';

// Singleton registry shared across the application.
export const sshRegistry = new SshRegistry();

// Wire the registry into the queue as the live command runner.
// This replaces the stub runner set up in queue.ts.
export function initSsh(): void {
  queue.setRunner(sshRegistry);

  // Forward SSH connection events to the queue's EventEmitter
  // so the WebSocket bridge can push them to the UI.
  sshRegistry.on('connection:connected',    (id) => queue.emit('connection:connected',    id));
  sshRegistry.on('connection:disconnected', (id) => queue.emit('connection:disconnected', id));
  sshRegistry.on('connection:error',        (id, err) => queue.emit('connection:error',   id, err));

  console.log('[ssh] registry initialised');
}
