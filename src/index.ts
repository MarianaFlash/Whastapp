import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { assertConfig, config } from './config.js';
import { Repo } from './db.js';
import { Notifier } from './notifier.js';
import { INITIAL_HISTORY_DAYS } from './settings.js';
import { localDateKey } from './status.js';
import { Tracker } from './tracker.js';
import { createServer } from './web/server.js';
import { WhatsAppClient } from './whatsapp.js';

assertConfig();

const logger = pino({ level: config.logLevel });
const here = path.dirname(fileURLToPath(import.meta.url));

const repo = new Repo(path.join(config.dataDir, 'pendientes.sqlite'));

// Primera vez: fija la fecha desde la que se cuentan mensajes (hoy menos 30 días) y no se mueve más.
if (!repo.getSettings().trackingSinceDate) {
  const since = localDateKey(new Date(Date.now() - INITIAL_HISTORY_DAYS * 86400_000), config.timezone);
  repo.saveSettings({ ...repo.getSettings(), trackingSinceDate: since });
  logger.info({ since }, 'fecha de inicio fijada; lo anterior se ignora');
}

const tracker = new Tracker(repo, () => repo.getSettings());

const wa = new WhatsAppClient({
  authDir: path.join(config.dataDir, 'auth'),
  logger,
  onMessage: (ev) => {
    const result = tracker.handle(ev);
    if (result.started) logger.debug({ jid: ev.jid }, 'nueva espera');
    if (result.resolved) logger.debug({ jid: ev.jid }, 'espera resuelta');
  },
  onName: ({ jid, name, saved }) => {
    const chat = repo.findChatByAnyJid(jid);
    if (!chat) return;
    if (saved || !chat.name) repo.setName(jid, name, Math.floor(Date.now() / 1000));
  },
  batch: (fn) => repo.transaction(fn),
});

const notifier = new Notifier({
  repo,
  wa,
  logger,
  publicUrl: config.publicUrl,
  timezone: config.timezone,
});

const app = createServer({
  repo,
  tracker,
  wa,
  notifier,
  logger,
  password: config.dashboardPassword!,
  publicDir: path.join(here, 'web', 'public'),
  publicUrl: config.publicUrl,
  timezone: config.timezone,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, dataDir: config.dataDir, timezone: config.timezone }, 'dashboard listo');
});

wa.start().catch((err) => logger.error({ err }, 'no se pudo iniciar WhatsApp'));

const tick = setInterval(() => {
  notifier.tick(new Date()).catch((err) => logger.warn({ err }, 'fallo en el ciclo de avisos'));
}, 30_000);

const prune = setInterval(() => {
  repo.pruneProcessed(Math.floor(Date.now() / 1000) - 90 * 86400);
}, 6 * 3600 * 1000);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'apagando');
  clearInterval(tick);
  clearInterval(prune);
  server.close();
  await wa.stop();
  repo.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
