import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { Repo } from '../db.js';
import type { Notifier } from '../notifier.js';
import { sanitizeSettings } from '../settings.js';
import { computeStats } from '../stats.js';
import { compareUrgency, isQuietHours, toChatView, type ChatView } from '../status.js';
import type { Tracker } from '../tracker.js';
import type { WhatsAppClient } from '../whatsapp.js';

interface Deps {
  repo: Repo;
  tracker: Tracker;
  wa: WhatsAppClient;
  notifier: Notifier;
  logger: Logger;
  password: string;
  publicDir: string;
  publicUrl: string;
  timezone: string;
}

const COOKIE = 'pendientes_session';
const COOKIE_DAYS = 30;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getOrCreateSecret(repo: Repo): string {
  const existing = repo.getValue('sessionSecret');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  repo.setValue('sessionSecret', secret);
  return secret;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createServer(deps: Deps): express.Express {
  const { repo, tracker, wa, notifier, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  const secret = getOrCreateSecret(repo);
  const sessionToken = crypto.createHmac('sha256', secret).update(`v1:${deps.password}`).digest('hex');
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  const isAuthed = (req: Request): boolean => {
    const given = parseCookies(req.headers.cookie)[COOKIE];
    return Boolean(given && safeEqual(given, sessionToken));
  };

  const cookieFlags = (req: Request): string =>
    `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

  // ---------- login ----------

  app.post('/api/login', (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    const password = String((req.body as { password?: unknown })?.password ?? '');
    if (password && safeEqual(password, deps.password)) {
      loginAttempts.delete(ip);
      res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken}; Max-Age=${COOKIE_DAYS * 86400}; ${cookieFlags(req)}`);
      res.status(204).end();
      return;
    }
    const next = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    next.count += 1;
    loginAttempts.set(ip, next);
    logger.warn({ ip }, 'intento de login fallido');
    res.status(401).json({ error: 'Contraseña incorrecta' });
  });

  app.post('/api/logout', (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
    res.status(204).end();
  });

  // ---------- páginas ----------

  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.path === '/' || req.path === '/index.html') && !isAuthed(req)) {
      res.redirect('/login.html');
      return;
    }
    if (req.path === '/login.html' && isAuthed(req)) {
      res.redirect('/');
      return;
    }
    next();
  });
  app.use(express.static(deps.publicDir, { index: 'index.html', maxAge: '5m' }));

  // ---------- API protegida ----------

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthed(req)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    next();
  });

  let qrCache: { qr: string; dataUrl: string } | null = null;
  const qrDataUrl = async (qr: string): Promise<string> => {
    if (qrCache?.qr === qr) return qrCache.dataUrl;
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 288 });
    qrCache = { qr, dataUrl };
    return dataUrl;
  };

  app.get('/api/status', async (_req: Request, res: Response) => {
    const now = new Date();
    const ts = Math.floor(now.getTime() / 1000);
    const settings = repo.getSettings();
    const views = notifier.pendingViews(ts, settings);
    const active = views.filter((v) => !v.snoozed);
    const qr = wa.state.status === 'qr' && wa.state.qr ? await qrDataUrl(wa.state.qr) : null;
    res.json({
      now: ts,
      timezone: deps.timezone,
      publicUrl: deps.publicUrl,
      quietHours: isQuietHours(now, settings.quietHours, deps.timezone),
      connection: {
        status: wa.state.status,
        me: wa.state.me,
        lastError: wa.state.lastError,
        connectedAt: wa.state.connectedAt,
        historyMessages: wa.state.historyMessages,
        historyDone: wa.state.historyDone,
      },
      qrDataUrl: qr,
      counts: {
        pending: active.length,
        critical: active.filter((v) => v.level === 'critical').length,
        red: active.filter((v) => v.level === 'red').length,
        yellow: active.filter((v) => v.level === 'yellow').length,
        vip: active.filter((v) => v.tier === 'vip').length,
        snoozed: views.length - active.length,
      },
      stats: computeStats(repo, now, deps.timezone),
    });
  });

  app.get('/api/chats', (req: Request, res: Response) => {
    const view = String(req.query.view ?? 'pending');
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const settings = repo.getSettings();
    const ts = nowSeconds();
    let views: ChatView[] = repo.listChats().map((row) => toChatView(row, settings, ts));
    switch (view) {
      case 'pending':
        views = views.filter((v) => v.pending && !v.snoozed);
        break;
      case 'snoozed':
        views = views.filter((v) => v.pending && v.snoozed);
        break;
      case 'vip':
        views = views.filter((v) => v.tier === 'vip' && !v.ignored);
        break;
      case 'ignored':
        views = views.filter((v) => v.ignored);
        break;
      default:
        views = views.filter((v) => !v.ignored);
    }
    if (q) views = views.filter((v) => v.name.toLowerCase().includes(q) || (v.preview ?? '').toLowerCase().includes(q));
    views.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      if (a.pending) return compareUrgency(a, b);
      const la = Math.max(a.lastIncomingAt ?? 0, a.lastOutgoingAt ?? 0);
      const lb = Math.max(b.lastIncomingAt ?? 0, b.lastOutgoingAt ?? 0);
      return lb - la;
    });
    res.json(views.slice(0, 500));
  });

  const respondChat = (res: Response, jid: string): void => {
    const row = repo.getChat(jid);
    if (!row) {
      res.status(404).json({ error: 'Chat no encontrado' });
      return;
    }
    res.json(toChatView(row, repo.getSettings(), nowSeconds()));
  };

  app.post('/api/chats/:jid/resolve', (req: Request, res: Response) => {
    const jid = String(req.params.jid);
    if (!tracker.resolveManually(jid, nowSeconds())) {
      res.status(404).json({ error: 'Chat no encontrado' });
      return;
    }
    respondChat(res, jid);
  });

  app.post('/api/chats/:jid/snooze', (req: Request, res: Response) => {
    const jid = String(req.params.jid);
    const body = (req.body ?? {}) as { minutes?: unknown; until?: unknown; clear?: unknown };
    const ts = nowSeconds();
    let until: number | null = null;
    if (!body.clear) {
      if (Number.isFinite(Number(body.until)) && Number(body.until) > ts) until = Math.floor(Number(body.until));
      else if (Number.isFinite(Number(body.minutes)) && Number(body.minutes) > 0) until = ts + Math.round(Number(body.minutes) * 60);
      else {
        res.status(400).json({ error: 'Indica minutes o until' });
        return;
      }
    }
    if (!repo.setSnooze(jid, until, ts)) {
      res.status(404).json({ error: 'Chat no encontrado' });
      return;
    }
    respondChat(res, jid);
  });

  app.post('/api/chats/:jid/vip', (req: Request, res: Response) => {
    const jid = String(req.params.jid);
    const raw = (req.body as { group?: unknown })?.group;
    const group = raw === null || raw === undefined || raw === '' ? null : String(raw).trim().slice(0, 40);
    if (!repo.setVip(jid, group, nowSeconds())) {
      res.status(404).json({ error: 'Chat no encontrado' });
      return;
    }
    if (group) {
      const settings = repo.getSettings();
      if (!settings.vipGroups.includes(group)) {
        repo.saveSettings(sanitizeSettings({ ...settings, vipGroups: [...settings.vipGroups, group] }));
      }
    }
    respondChat(res, jid);
  });

  app.post('/api/chats/:jid/ignore', (req: Request, res: Response) => {
    const jid = String(req.params.jid);
    const ignored = Boolean((req.body as { ignored?: unknown })?.ignored);
    if (!repo.setIgnored(jid, ignored, nowSeconds())) {
      res.status(404).json({ error: 'Chat no encontrado' });
      return;
    }
    respondChat(res, jid);
  });

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(repo.getSettings());
  });

  app.put('/api/settings', (req: Request, res: Response) => {
    const settings = sanitizeSettings(req.body);
    repo.saveSettings(settings);
    res.json(settings);
  });

  app.post('/api/notify/test', async (_req: Request, res: Response) => {
    try {
      const text = await notifier.sendTest();
      res.json({ ok: true, text });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post('/api/notify/digest', async (_req: Request, res: Response) => {
    try {
      const text = await notifier.sendDigestNow();
      res.json({ ok: true, text });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post('/api/whatsapp/logout', async (_req: Request, res: Response) => {
    await wa.logout();
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'error en el servidor web');
    if (res.headersSent) return;
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}
