#!/usr/bin/env node
/**
 * Despliega (o actualiza) Pendientes en un VPS de Hostinger usando su API y el Docker Manager.
 * No necesita SSH. Requiere un VPS con plantilla "Docker" y un token de API de hPanel.
 *
 * Uso:
 *   node scripts/deploy-hostinger.mjs --token TOKEN --password CLAVE_DASHBOARD [--vm 123456] [--public-url URL]
 *
 * También acepta las variables HOSTINGER_API_TOKEN, DASHBOARD_PASSWORD, PUBLIC_URL y TZ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://developers.hostinger.com';
const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return fallback;
}

const token = arg('token', process.env.HOSTINGER_API_TOKEN);
const password = arg('password', process.env.DASHBOARD_PASSWORD);
const project = arg('project', 'pendientes');
const tz = arg('tz', process.env.TZ || 'America/Bogota');
const wantedVm = arg('vm', process.env.HOSTINGER_VM_ID);
let publicUrl = arg('public-url', process.env.PUBLIC_URL);
const recreate = process.argv.includes('--recreate');

if (!token) fail('Falta el token de API. Pásalo con --token o en HOSTINGER_API_TOKEN.');
if (!password) fail('Falta la contraseña del dashboard. Pásala con --password o en DASHBOARD_PASSWORD.');

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'object' && data ? JSON.stringify(data) : String(data);
    throw new Error(`${method} ${route} → ${res.status}: ${detail.slice(0, 500)}`);
  }
  return data;
}

function findIpv4(value) {
  const json = JSON.stringify(value ?? null);
  const match = /"(\d{1,3}(?:\.\d{1,3}){3})"/.exec(json);
  return match ? match[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('→ Consultando tus servidores en Hostinger…');
  const vms = await api('GET', '/api/vps/v1/virtual-machines');
  const list = Array.isArray(vms) ? vms : vms?.data ?? [];
  if (list.length === 0) fail('No hay VPS en esta cuenta.');

  let vm;
  if (wantedVm) vm = list.find((v) => String(v.id) === String(wantedVm) || v.hostname?.includes(String(wantedVm)));
  else if (list.length === 1) vm = list[0];
  if (!vm) {
    console.log('Hay varios servidores. Indica cuál con --vm ID:');
    for (const v of list) console.log(`  - ${v.id}  ${v.hostname}  ${v.plan ?? ''}  ${v.state}`);
    process.exit(1);
  }

  const ip = findIpv4(vm.ipv4);
  const templateName = vm.template?.name ?? '(desconocida)';
  console.log(`✓ Servidor ${vm.id} · ${vm.hostname} · IP ${ip ?? '?'} · plantilla "${templateName}" · estado ${vm.state}`);
  if (!/docker/i.test(templateName)) {
    console.log('⚠ La plantilla del VPS no parece incluir Docker. El Docker Manager solo funciona con plantillas "Docker".');
    console.log('  En hPanel: VPS → Sistema operativo → cambia a "Ubuntu 24.04 with Docker" (reinstala el servidor) o despliega por terminal.');
  }
  if (!publicUrl) publicUrl = `http://${ip}:3000`;

  const compose = fs.readFileSync(path.join(here, '..', 'docker-compose.hostinger.yml'), 'utf8');
  const environment = [`DASHBOARD_PASSWORD=${password}`, `PUBLIC_URL=${publicUrl}`, `TZ=${tz}`].join('\n');

  console.log('→ Revisando proyectos Docker existentes…');
  const projects = (await api('GET', `/api/vps/v1/virtual-machines/${vm.id}/docker`)) ?? [];
  const existing = (Array.isArray(projects) ? projects : projects.data ?? []).find((p) => p.name === project);

  if (existing && recreate) {
    console.log(`⚠ Borrando el proyecto "${project}" (se pierden la sesión de WhatsApp y la base de datos)…`);
    await api('DELETE', `/api/vps/v1/virtual-machines/${vm.id}/docker/${project}/down`);
    await sleep(5000);
  }

  if (existing && !recreate) {
    console.log(`→ El proyecto "${project}" ya existe. Actualizando a la última imagen…`);
    await api('POST', `/api/vps/v1/virtual-machines/${vm.id}/docker/${project}/update`);
  } else {
    console.log(`→ Creando el proyecto "${project}"…`);
    await api('POST', `/api/vps/v1/virtual-machines/${vm.id}/docker`, {
      project_name: project,
      content: compose,
      environment,
    });
  }

  console.log('→ Esperando a que arranque (puede tardar un par de minutos la primera vez)…');
  let state = 'unknown';
  for (let i = 0; i < 36; i += 1) {
    await sleep(5000);
    try {
      const now = (await api('GET', `/api/vps/v1/virtual-machines/${vm.id}/docker`)) ?? [];
      const p = (Array.isArray(now) ? now : now.data ?? []).find((x) => x.name === project);
      state = p?.state ?? 'unknown';
      process.stdout.write(`  estado: ${state} (${p?.status ?? ''})\r`);
      if (state === 'running') break;
    } catch (err) {
      process.stdout.write(`  esperando… (${err.message.slice(0, 60)})\r`);
    }
  }
  console.log('');
  if (state !== 'running') {
    console.log(`⚠ El proyecto quedó en estado "${state}". Revisa los logs en hPanel → Docker Manager → ${project}.`);
  } else {
    console.log('✓ Contenedor en marcha.');
  }

  // Firewall: solo si el VPS tiene un grupo de firewall activo. Sin firewall, el puerto ya está abierto.
  if (vm.firewall_group_id) {
    console.log(`→ El servidor tiene el firewall ${vm.firewall_group_id} activo. Abriendo el puerto 3000…`);
    let group = null;
    for (let page = 1; page <= 10 && !group; page += 1) {
      const res = await api('GET', `/api/vps/v1/firewall?page=${page}`);
      group = (res?.data ?? []).find((g) => g.id === vm.firewall_group_id) ?? null;
      if (!res?.meta || res.meta.current_page * res.meta.per_page >= res.meta.total) break;
    }
    const rules = group?.rules ?? [];
    const open = rules.some((r) => String(r.port) === '3000' && ['TCP', 'any'].includes(r.protocol));
    if (open) console.log('✓ El puerto 3000 ya estaba permitido.');
    else {
      await api('POST', `/api/vps/v1/firewall/${vm.firewall_group_id}/rules`, {
        protocol: 'TCP',
        port: '3000',
        source: 'any',
        source_detail: 'any',
      });
      await api('POST', `/api/vps/v1/firewall/${vm.firewall_group_id}/sync/${vm.id}`);
      console.log('✓ Regla TCP 3000 añadida y sincronizada.');
    }
  } else {
    console.log('✓ No hay firewall de Hostinger activo, el puerto 3000 ya es accesible.');
  }

  console.log('\nListo. Siguientes pasos:');
  console.log(`  1. Abre ${publicUrl} y entra con tu contraseña.`);
  console.log('  2. Escanea el QR desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo.');
  console.log('  3. Marca tus VIP con ⭐ y prueba el aviso desde Ajustes.');
}

main().catch((err) => fail(err.message));
