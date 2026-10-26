# Pendientes · tu cola de WhatsApp sin responder

Dashboard personal que se conecta a tu WhatsApp como un dispositivo vinculado y te muestra:

- **Quién espera tu respuesta** y desde cuándo, ordenado por urgencia.
- **Semáforos** por tiempo de espera: 🟡 Atención → 🔴 Urgente → 🚨 Crítico.
- **⭐ VIP** con umbrales más cortos: clientes, familia, mejores amigos, los grupos que quieras.
- **Avisos por WhatsApp** a tu propio chat ("Tú"): alerta inmediata cuando alguien pasa a crítico y resúmenes a las horas que elijas.
- **Tu tiempo de respuesta** del día y de la semana.

Todo corre en tu servidor. No se envía nada a terceros.

## Cómo funciona

1. El servicio se vincula a tu cuenta escaneando un QR, igual que WhatsApp Web.
2. Recibe los mensajes que te llegan y también los que tú envías desde el teléfono.
3. Por cada chat guarda cuándo fue el último mensaje tuyo y el último de la otra persona.
   Si el último es de la otra persona, el chat está **pendiente** y el reloj corre desde su primer mensaje sin respuesta.
4. Cuando respondes (o reaccionas, si lo activas), la espera se cierra y se registra cuánto tardaste.

Umbrales por defecto, editables desde Ajustes:

| Estado | ⭐ VIP | Normal |
|---|---|---|
| 🟡 Atención | 30 min | 3 h |
| 🔴 Urgente | 2 h | 12 h |
| 🚨 Crítico (aviso inmediato) | 6 h | 48 h |

Acciones por chat: **Abrir en WhatsApp**, **✓ Listo** (no requiere respuesta), **⏰ Posponer**, **☆ Marcar VIP**, **Ignorar**.

Al instalar se fija una **fecha de inicio: hoy menos 30 días**. Los mensajes anteriores a esa fecha se
ignoran por completo, para que la sincronización inicial no arrastre pendientes viejos de hace meses.
Desde esa fecha en adelante todo cuenta sin límite: una espera de tres meses sigue siendo crítica.
La fecha se puede ver y cambiar en Ajustes. Al arrancar, y al cambiar la fecha, las esperas que
empezaron antes se cierran solas (sin contar como respuesta), así que actualizar la herramienta
limpia los pendientes viejos que una versión anterior hubiera cargado.

Grupos de WhatsApp: por defecto solo cuentan si te mencionan o responden a un mensaje tuyo. Estados, canales y listas de difusión se ignoran siempre.

## Instalación en el VPS de Hostinger

Hay tres caminos. Los dos primeros no necesitan terminal: usan la imagen ya construida
`ghcr.io/marianaflash/whastapp:latest`, que GitHub Actions publica en cada push.

### Opción A · Docker Manager de hPanel (solo clics)

Requiere que el VPS tenga una plantilla con Docker (en hPanel → VPS → Sistema operativo,
por ejemplo "Ubuntu 24.04 with Docker").

1. En hPanel entra a tu VPS y abre **Docker Manager**.
2. Elige **Compose** → **Compose manually** y pega el contenido de `docker-compose.hostinger.yml`.
3. En el panel de variables agrega `DASHBOARD_PASSWORD` con una contraseña larga y
   `PUBLIC_URL` con `http://IP_DEL_SERVIDOR:3000`.
4. Pulsa **Deploy** y espera a que el contenedor esté en verde.
5. Si tienes un firewall activo en hPanel, agrega una regla TCP para el puerto `3000`.
6. Abre `http://IP_DEL_SERVIDOR:3000`, entra y escanea el QR.

### Opción B · Script con la API de Hostinger (sin SSH)

Crea un token en hPanel → **API** y ejecuta desde cualquier computador con Node 18 o superior:

```bash
node scripts/deploy-hostinger.mjs --token TU_TOKEN --password CLAVE_DEL_DASHBOARD
```

El script encuentra tu VPS, crea el proyecto en Docker Manager, abre el puerto 3000 si hay
firewall y te dice la URL. Si el proyecto ya existe, lo actualiza a la última imagen sin perder datos.
Borra el token en hPanel cuando termines.

### Opción C · Una línea en la terminal (VPS Ubuntu sin Docker)

Si el VPS tiene un Ubuntu normal, sin plantilla Docker, abre la **terminal del navegador** en hPanel
(o SSH) y pega:

```bash
curl -fsSL https://raw.githubusercontent.com/MarianaFlash/Whastapp/claude/sleepy-johnson-mx3qyu/scripts/install.sh | bash
```

El instalador pone Docker si falta, descarga la imagen, elige un puerto libre a partir del 3000,
genera una contraseña y al final imprime la URL y la contraseña. Para actualizar, vuelve a pegar la
misma línea. Para fijar tu propia contraseña: `DASHBOARD_PASSWORD='mi-clave' bash` en lugar de `bash`.

### Opción D · Paso a paso por SSH

Necesitas un VPS con Ubuntu y acceso SSH. Todo corre en Docker, no hace falta instalar Node.

```bash
ssh root@IP_DEL_SERVIDOR

# 1. Docker (si el VPS no lo trae ya)
curl -fsSL https://get.docker.com | sh

# 2. Código
git clone https://github.com/marianaflash/whastapp.git pendientes
cd pendientes

# 3. Configuración
cp .env.example .env
nano .env        # pon DASHBOARD_PASSWORD y PUBLIC_URL

# 4. Arrancar
docker compose up -d --build
docker compose logs -f pendientes   # Ctrl+C para salir de los logs
```

Abre el **firewall** del VPS en el panel de Hostinger para el puerto `3000` (o `80` y `443` si usas HTTPS, ver abajo).

Entra a `http://IP_DEL_SERVIDOR:3000`, escribe la contraseña y escanea el QR desde
**WhatsApp → Dispositivos vinculados → Vincular un dispositivo**.

En uno o dos minutos se sincroniza el historial reciente y aparecen los chats pendientes.

### HTTPS con tu dominio (recomendado)

Apunta un subdominio (por ejemplo `pendientes.tudominio.com`) a la IP del VPS y en `.env` define:

```
DOMAIN=pendientes.tudominio.com
BIND_ADDRESS=127.0.0.1
PUBLIC_URL=https://pendientes.tudominio.com
```

Arranca con el perfil `https`, que levanta Caddy con certificado automático:

```bash
docker compose --profile https up -d --build
```

### Actualizar

```bash
cd pendientes
git pull
docker compose up -d --build        # añade --profile https si lo usas
```

### Copia de seguridad

Los datos (sesión de WhatsApp y base SQLite) viven en el volumen `pendientes_data`:

```bash
docker run --rm -v pendientes_pendientes_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/pendientes-backup.tgz -C /data .
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DASHBOARD_PASSWORD` | sí | Contraseña del dashboard. |
| `PUBLIC_URL` | no | URL del dashboard, se incluye en los mensajes de WhatsApp. |
| `TZ` | no | Zona horaria. Por defecto `America/Bogota`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` o `error`. |
| `PORT` | no | Puerto interno. Por defecto `3000`. |
| `DATA_DIR` | no | Carpeta de datos. Por defecto `./data` (en Docker, `/data`). |
| `DOMAIN`, `BIND_ADDRESS` | no | Solo para el perfil `https`. |

## Ajustes desde el dashboard

- Umbrales VIP y normales en minutos.
- Avisos por WhatsApp: activar o no, aviso inmediato en crítico, horas de los resúmenes, nombre del asistente.
- Horario silencioso: durante ese rango no se envían avisos (los pendientes siguen contando).
- Grupos: solo menciones, todo, o ignorar.
- Reacciones como respuesta, guardar vista previa del último mensaje.
- Grupos VIP (etiquetas) y botones para probar el aviso, enviar el resumen ahora o desvincular.

Los avisos del navegador se activan desde Ajustes y solo funcionan con la pestaña abierta.

## Privacidad y riesgos

- Se guardan **metadatos**: identificador del chat, nombre, hora y dirección de cada mensaje, y una vista previa corta del último mensaje pendiente (puedes apagarla). No se guarda el historial.
- La base de datos y la sesión de WhatsApp están solo en tu servidor. Protégelo con una contraseña larga y, si puedes, HTTPS.
- La conexión usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería **no oficial** que habla el protocolo de WhatsApp Web. Va contra los términos de servicio de WhatsApp. El riesgo de bloqueo es bajo para un uso personal que casi solo lee, pero no es cero. Por eso la herramienta no envía nada a terceros: solo te escribe a ti.
- Si WhatsApp cierra la sesión (por ejemplo, si desvinculas el dispositivo desde el teléfono), el dashboard vuelve a mostrar el QR.
- Si el teléfono pasa 14 días sin conectarse, WhatsApp desvincula los dispositivos y hay que escanear de nuevo.

## Desarrollo local

Requiere Node 22.13 o superior (usa el SQLite integrado de Node).

```bash
npm install
cp .env.example .env    # y edítalo
set -a; source .env; set +a
npm run dev             # http://localhost:3000
npm test                # pruebas unitarias
npm run build && npm start
```

## Estructura

```
src/
  index.ts        arranque y cableado
  config.ts       variables de entorno
  settings.ts     ajustes editables y validación
  db.ts           SQLite (node:sqlite) y consultas
  tracker.ts      lógica de "quién espera respuesta"
  status.ts       semáforos, orden y formato
  stats.ts        tiempo de respuesta del día y la semana
  whatsapp.ts     cliente Baileys: conexión, QR, historial, mensajes
  notifier.ts     alertas críticas y resúmenes a tu chat
  web/server.ts   API y login
  web/public/     dashboard (HTML, CSS y JS sin dependencias)
```

## Próximas fases

- **Fase 2:** aviso con un segundo número (un "asistente" con contacto propio), estadísticas por contacto, exportar, PWA para el móvil.
- **Fase 3:** clasificar con IA si el último mensaje realmente pide respuesta, borradores sugeridos y responder desde el dashboard.
