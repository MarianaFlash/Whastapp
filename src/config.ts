import path from 'node:path';

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

export const config = {
  port: Number(env('PORT', '3000')),
  dataDir: path.resolve(env('DATA_DIR', './data')!),
  /** Contraseña única del dashboard. Obligatoria. */
  dashboardPassword: env('DASHBOARD_PASSWORD', ''),
  /** URL pública del dashboard, se usa en los mensajes de WhatsApp. Ej: https://pendientes.midominio.com */
  publicUrl: (env('PUBLIC_URL', '') ?? '').replace(/\/$/, ''),
  /** Zona horaria para horarios silenciosos y resúmenes. */
  timezone: env('TZ', 'America/Bogota')!,
  logLevel: env('LOG_LEVEL', 'info')!,
  /** Commit con el que se construyó la imagen (lo pone el Dockerfile). */
  version: env('APP_VERSION', 'dev')!,
  builtAt: env('APP_BUILT_AT', '')!,
};

export function assertConfig(): void {
  if (!config.dashboardPassword) {
    console.error(
      'Falta DASHBOARD_PASSWORD. Define una contraseña en el archivo .env antes de arrancar.',
    );
    process.exit(1);
  }
}
