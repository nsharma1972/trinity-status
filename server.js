const express = require('express')
const app = express()
const PORT = process.env.PORT || 3000

const SERVERS = [
  { name: 'Dev',        ip: '150.136.93.177', domain: 'dev.trinitybps.com',  color: '#3b82f6' },
  { name: 'Test',       ip: '129.213.83.13',  domain: 'test.trinitybps.com', color: '#f59e0b' },
  { name: 'Production', ip: '132.145.133.150', domain: 'apps.trinitybps.com', color: '#22c55e' },
]

const CAPROVER_PASSWORD = process.env.CAPROVER_PASSWORD || 'HImnme@1927'

// Known app metadata: description, phases per environment, health endpoint, port
// phases key = server name ('Dev' | 'Test' | 'Production'), value = label for that env
const APP_META = {
  'tdi-app':       { desc: 'TDI Ingestion Service (CSV/Excel/XML/JSON → Bronze tier)', phases: { Dev: 'Phase 1–3', Test: 'Phase 1', Production: 'Phase 1' }, port: 8000, health: '/health' },
  'tdi-auth':      { desc: 'TDI Auth Service (JWT, RBAC, MFA, tenant management)',     phases: { Dev: 'Phase 2' },                                            port: 8001, health: '/health' },
  'tdi-frontend':  { desc: 'TDI React Frontend (dashboard, pipeline, data browser)',    phases: { Dev: 'Phase 2–3' },                                          port: 80,   health: '/healthz' },
  'tdi-redis':     { desc: 'Redis 7 — event streaming (Redis Streams)',                 phases: { Dev: 'Phase 1' },                                            port: 6379, health: null },
  'tdi-processor': { desc: 'TDI ETL Processor (Bronze → Silver → Gold)',               phases: { Dev: 'Phase 1–3' },                                          port: 8080, health: '/health' },
  'tdi-supply-chain': { desc: 'TDI Supply Chain Service (vendors, PO, inventory, QC)', phases: { Dev: 'Phase 3' },                                            port: 8002, health: '/health' },
  'trinity-status': { desc: 'This infrastructure status dashboard',                    phases: { Production: 'Infra' },                                       port: 3000, health: null },
}

async function checkAppHealth(appName, rootDomain, path) {
  if (!path || !rootDomain) return null
  // CapRover apps are only accessible via nginx proxy subdomain, not direct IP:port
  const url = `http://${appName}.${rootDomain}${path}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return 'degraded'
    const text = await res.text()
    // Accept plain "ok" (nginx /healthz) or JSON {"status":"healthy"}
    if (text.trim() === 'ok') return 'healthy'
    try {
      const body = JSON.parse(text)
      return body.status === 'healthy' ? 'healthy' : 'degraded'
    } catch {
      return 'degraded'
    }
  } catch {
    return 'unreachable'
  }
}

async function getCapRoverStatus(server) {
  try {
    const loginRes = await fetch(`http://${server.ip}:3000/api/v2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: CAPROVER_PASSWORD }),
      signal: AbortSignal.timeout(5000),
    })
    const loginData = await loginRes.json()
    if (loginData.status !== 100) return { ...server, status: 'error', apps: [] }

    const token = loginData.data.token

    const [infoRes, appsRes] = await Promise.all([
      fetch(`http://${server.ip}:3000/api/v2/user/system/info`, {
        headers: { 'x-captain-auth': token }, signal: AbortSignal.timeout(5000),
      }),
      fetch(`http://${server.ip}:3000/api/v2/user/apps/appDefinitions`, {
        headers: { 'x-captain-auth': token }, signal: AbortSignal.timeout(5000),
      }),
    ])

    const infoData = await infoRes.json()
    const appsData = await appsRes.json()

    // appDefinitions is an array of objects with .appName
    const rawApps = Array.isArray(appsData.data?.appDefinitions)
      ? appsData.data.appDefinitions
      : []

    const rootDomain = infoData.data?.rootDomain

    // Fetch health for each known app in parallel
    const apps = await Promise.all(rawApps.map(async (a) => {
      const meta = APP_META[a.appName] || {}
      const healthStatus = a.instanceCount > 0
        ? await checkAppHealth(a.appName, rootDomain, meta.health)
        : 'stopped'
      return {
        name: a.appName,
        instanceCount: a.instanceCount || 0,
        desc: meta.desc || '—',
        phase: (meta.phases && meta.phases[server.name]) || '—',
        port: meta.port || null,
        health: healthStatus,
      }
    }))

    return {
      ...server,
      status: 'online',
      rootDomain,
      forceSsl: infoData.data?.forceSsl,
      apps,
    }
  } catch {
    return { ...server, status: 'offline', apps: [] }
  }
}

app.get('/api/status', async (req, res) => {
  const results = await Promise.all(SERVERS.map(getCapRoverStatus))
  res.json({ servers: results, timestamp: new Date().toISOString() })
})

app.get('/', (req, res) => res.send(HTML))

app.listen(PORT, () => console.log(`Status dashboard running on port ${PORT}`))

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrinityBPS Infrastructure</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { padding: 24px 32px; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 20px; font-weight: 600; color: #f8fafc; }
    header h1 span { color: #6366f1; }
    .timestamp { font-size: 13px; color: #64748b; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; padding: 28px 32px; }
    .card { background: #1e293b; border-radius: 12px; border: 1px solid #334155; overflow: hidden; }
    .card-header { padding: 16px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #334155; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .dot.online  { background: #22c55e; box-shadow: 0 0 8px #22c55e88; }
    .dot.offline { background: #ef4444; }
    .dot.loading { background: #64748b; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .card-title  { font-size: 16px; font-weight: 600; }
    .card-domain { font-size: 12px; color: #64748b; margin-top: 2px; }
    .badge { margin-left: auto; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
    .badge.online  { background: #14532d; color: #86efac; }
    .badge.offline { background: #450a0a; color: #fca5a5; }
    .badge.loading { background: #1e293b; color: #64748b; }
    .card-body { padding: 16px 20px; }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #0f172a; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #94a3b8; }
    .stat-value { font-weight: 500; }
    .apps-section { margin-top: 14px; }
    .apps-title { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .app-item { background: #0f172a; border-radius: 8px; margin-bottom: 8px; padding: 10px 12px; }
    .app-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .app-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .app-dot.healthy    { background: #22c55e; }
    .app-dot.degraded   { background: #f59e0b; }
    .app-dot.unreachable{ background: #ef4444; }
    .app-dot.stopped    { background: #475569; }
    .app-dot.unknown    { background: #64748b; }
    .app-name { font-size: 13px; font-weight: 600; flex: 1; }
    .app-phase { font-size: 11px; background: #1e3a5f; color: #93c5fd; padding: 2px 7px; border-radius: 4px; }
    .app-desc { font-size: 12px; color: #64748b; margin-bottom: 4px; }
    .app-meta { display: flex; gap: 12px; font-size: 11px; color: #475569; }
    .app-item { text-decoration: none; color: inherit; display: block; }
    .app-item:hover { background: #1a2744; }
    .open-btn { margin-left: auto; font-size: 11px; font-weight: 500; padding: 3px 10px; border-radius: 5px; background: #312e81; color: #a5b4fc; text-decoration: none; border: 1px solid #4338ca; white-space: nowrap; }
    .open-btn:hover { background: #3730a3; color: #c7d2fe; }
    .health-pill { padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 500; }
    .health-pill.healthy     { background: #14532d; color: #86efac; }
    .health-pill.degraded    { background: #451a03; color: #fed7aa; }
    .health-pill.unreachable { background: #450a0a; color: #fca5a5; }
    .health-pill.stopped     { background: #1e293b; color: #64748b; }
    .health-pill.unknown     { background: #1e293b; color: #64748b; }
    .no-apps { color: #475569; font-size: 13px; font-style: italic; padding: 8px 0; }
    .services { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; padding: 0 32px 28px; }
    .service-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; display: flex; align-items: center; gap: 12px; }
    .service-icon { font-size: 22px; }
    .service-name { font-size: 13px; font-weight: 500; }
    .service-status { font-size: 11px; color: #22c55e; margin-top: 2px; }
    .refresh-btn { background: #6366f1; color: white; border: none; padding: 7px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; transition: background 0.2s; }
    .refresh-btn:hover { background: #4f46e5; }
    .section-title { font-size: 12px; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 32px 12px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Trinity<span>BPS</span> Infrastructure</h1>
      <div class="timestamp" id="ts">Loading...</div>
    </div>
    <button class="refresh-btn" onclick="load()">Refresh</button>
  </header>

  <div style="padding: 28px 32px 4px">
    <div class="section-title">CapRover Environments</div>
  </div>
  <div class="grid" id="grid">
    ${[1,2,3].map(() => `
    <div class="card">
      <div class="card-header">
        <div class="dot loading"></div>
        <div><div class="card-title">Loading...</div></div>
        <span class="badge loading">...</span>
      </div>
    </div>`).join('')}
  </div>

  <div class="section-title" style="padding: 4px 32px 12px">Managed Services</div>
  <div class="services">
    <div class="service-card"><div class="service-icon">🐘</div><div><div class="service-name">Neon Postgres</div><div class="service-status">● Connected (3 schemas)</div></div></div>
    <div class="service-card"><div class="service-icon">☁️</div><div><div class="service-name">Cloudflare R2</div><div class="service-status">● 2 buckets</div></div></div>
    <div class="service-card"><div class="service-icon">🔥</div><div><div class="service-name">Backblaze B2</div><div class="service-status">● Connected</div></div></div>
    <div class="service-card"><div class="service-icon">🤖</div><div><div class="service-name">Telegram Bot</div><div class="service-status">● @trinityai_Univ_bot</div></div></div>
    <div class="service-card"><div class="service-icon">🌐</div><div><div class="service-name">Cloudflare DNS</div><div class="service-status">● trinitybps.com</div></div></div>
    <div class="service-card"><div class="service-icon">☁️</div><div><div class="service-name">Oracle Cloud</div><div class="service-status">● 3 VMs running</div></div></div>
  </div>

  <script>
    async function load() {
      document.getElementById('ts').textContent = 'Refreshing...'
      try {
        const res = await fetch('/api/status')
        const data = await res.json()
        document.getElementById('ts').textContent = 'Last updated: ' + new Date(data.timestamp).toLocaleTimeString() + ' — auto-refreshes every 30s'
        renderServers(data.servers)
      } catch {
        document.getElementById('ts').textContent = 'Failed to load status'
      }
    }

    function healthPill(h) {
      if (!h) return ''
      return \`<span class="health-pill \${h}">\${h}</span>\`
    }

    function appUrl(appName, rootDomain) {
      return \`http://\${appName}.\${rootDomain}\`
    }

    function renderServers(servers) {
      document.getElementById('grid').innerHTML = servers.map(s => {
        const isOnline = s.status === 'online'
        const apps = s.apps || []
        const frontend = apps.find(a => a.name === 'tdi-frontend')
        const frontendUrl = frontend && s.rootDomain ? appUrl('tdi-frontend', s.rootDomain) : null
        return \`
        <div class="card">
          <div class="card-header">
            <div class="dot \${s.status}"></div>
            <div>
              <div class="card-title">\${s.name}</div>
              <div class="card-domain">\${s.domain}</div>
            </div>
            <span class="badge \${s.status}">\${s.status.toUpperCase()}</span>
            \${frontendUrl ? \`<a class="open-btn" href="\${frontendUrl}" target="_blank" rel="noopener">Open ↗</a>\` : ''}
          </div>
          <div class="card-body">
            <div class="stat-row"><span class="stat-label">IP Address</span><span class="stat-value">\${s.ip}</span></div>
            <div class="stat-row"><span class="stat-label">Root Domain</span><span class="stat-value">\${s.rootDomain || '—'}</span></div>
            <div class="stat-row"><span class="stat-label">HTTPS</span><span class="stat-value" style="color:\${s.forceSsl ? '#22c55e' : '#f59e0b'}">\${s.forceSsl ? 'Enforced' : isOnline ? 'Available' : '—'}</span></div>
            <div class="stat-row"><span class="stat-label">Applications</span><span class="stat-value">\${apps.length}</span></div>
            <div class="apps-section">
              <div class="apps-title">Deployed Applications</div>
              \${apps.length === 0
                ? '<div class="no-apps">No apps deployed</div>'
                : apps.map(a => {
                    const href = s.rootDomain && a.port !== 6379 ? appUrl(a.name, s.rootDomain) : null
                    const tag = href ? \`<a class="app-item" href="\${href}" target="_blank" rel="noopener">\` : '<div class="app-item">'
                    const close = href ? '</a>' : '</div>'
                    return \`
                  \${tag}
                    <div class="app-top">
                      <div class="app-dot \${a.health || 'unknown'}"></div>
                      <div class="app-name">\${a.name}</div>
                      <span class="app-phase">\${a.phase}</span>
                      \${healthPill(a.health)}
                    </div>
                    <div class="app-desc">\${a.desc}</div>
                    <div class="app-meta">
                      \${a.port ? '<span>Port ' + a.port + '</span>' : ''}
                      <span>\${a.instanceCount} instance\${a.instanceCount !== 1 ? 's' : ''}</span>
                    </div>
                  \${close}\`
                  }).join('')
              }
            </div>
          </div>
        </div>\`
      }).join('')
    }

    load()
    setInterval(load, 30000)
  </script>
</body>
</html>`
