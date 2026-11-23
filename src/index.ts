import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { ClaudeResponder } from './ai.js';
import { assertConfig, config } from './config.js';
import { Repo } from './db.js';
import { Notifier } from './notifier.js';
import { INITIAL_HISTORY_DAYS, nextTrackingSinceDate } from './settings.js';
import { Seller } from './seller.js';
import { localDateKey } from './status.js';
import { Tracker } from './tracker.js';
import { createServer } from './web/server.js';
import { WhatsAppClient } from './whatsapp.js';

assertConfig();

const logger = pino({ level: config.logLevel });
const here = path.dirname(fileURLToPath(import.meta.url));
logger.info({ version: config.version, builtAt: config.builtAt }, 'Pendientes');

const repo = new Repo(path.join(config.dataDir, 'pendientes.sqlite'));

const tracker = new Tracker(repo, () => repo.getSettings());

/**
 * Mantiene la fecha de inicio al día: en modo "mes en curso" la mueve al día 1 cuando cambia el mes;
 * en modo fijo la pone una sola vez (hoy menos 30 días). Luego cierra las esperas anteriores.
 */
function syncStartDate(force = false): void {
  const now = new Date();
  const settings = repo.getSettings();
  const next = nextTrackingSinceDate(
    settings,
    localDateKey(now, config.timezone),
    localDateKey(new Date(now.getTime() - INITIAL_HISTORY_DAYS * 86400_000), config.timezone),
  );
  if (next) {
    repo.saveSettings({ ...settings, trackingSinceDate: next });
    logger.info({ since: next, mode: settings.trackingSinceMode }, 'fecha de inicio actualizada; lo anterior se ignora');
  }
  if (next || force) {
    const cleaned = tracker.applyStartDate(Math.floor(now.getTime() / 1000));
    if (cleaned > 0) logger.info({ cleaned, since: repo.getSettings().trackingSinceDate }, 'esperas anteriores a la fecha de inicio cerradas');
  }
}

// Al arrancar siempre limpia (datos de versiones anteriores o fecha cambiada).
syncStartDate(true);

// Se asigna después de crear el cliente de WhatsApp, que el modo vendedor necesita para responder.
let seller: Seller | null = null;

const wa = new WhatsAppClient({
  authDir: path.join(config.dataDir, 'auth'),
  logger,
  onMessage: (ev) => {
    const result = tracker.handle(ev);
    if (result.started) logger.debug({ jid: ev.jid }, 'nueva espera');
    if (result.resolved) logger.debug({ jid: ev.jid }, 'espera resuelta');
    try {
      seller?.handle(ev, result.skipped);
    } catch (err) {
      logger.error({ err, jid: ev.jid }, 'modo vendedor: no se pudo procesar el mensaje');
    }
  },
  onName: ({ jid, name, saved }) => {
    const chat = repo.findChatByAnyJid(jid);
    if (!chat) return;
    if (saved || !chat.name) repo.setName(jid, name, Math.floor(Date.now() / 1000));
  },
  batch: (fn) => repo.transaction(fn),
});

seller = new Seller({
  repo,
  wa,
  logger,
  responder: config.anthropicApiKey
    ? new ClaudeResponder(config.anthropicApiKey, config.anthropicModel, config.anthropicEffort)
    : null,
  timezone: config.timezone,
  publicUrl: config.publicUrl,
});
const sellerReady = seller;
if (repo.getSettings().seller.enabled) {
  const status = sellerReady.status();
  logger.info({ ready: status.ready, model: status.model, problem: status.problem }, 'modo vendedor activado');
}

// Al (re)conectar, contesta lo que haya quedado pendiente mientras estaba desconectado.
let wasConnected = false;
wa.on('state', () => {
  const connected = wa.isConnected();
  if (connected && !wasConnected) sellerReady.resumePending();
  wasConnected = connected;
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
  seller: sellerReady,
  logger,
  password: config.dashboardPassword!,
  publicDir: path.join(here, 'web', 'public'),
  publicUrl: config.publicUrl,
  timezone: config.timezone,
  version: config.version,
  builtAt: config.builtAt,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, dataDir: config.dataDir, timezone: config.timezone }, 'dashboard listo');
});

wa.start().catch((err) => logger.error({ err }, 'no se pudo iniciar WhatsApp'));

const tick = setInterval(() => {
  try {
    syncStartDate();
  } catch (err) {
    logger.warn({ err }, 'no se pudo actualizar la fecha de inicio');
  }
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
  sellerReady.stop();
  await wa.stop();
  repo.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
