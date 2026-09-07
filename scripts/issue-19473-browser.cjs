const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium } = createRequire(path.join(process.env.RUNNER_TEMP, 'browser/package.json'))('playwright')

const backendOrigin = 'http://127.0.0.1:10000'
const evidence = path.resolve('evidence/browser')
fs.mkdirSync(evidence, { recursive: true })
const report = { apiMocked: false, responseBodiesModified: false, cases: [], setup: [] }
let browser, setup, page

async function json(response, stage) {
  const text = await response.text()
  report.setup.push({ stage, status: response.status() })
  if (!response.ok()) throw new Error(`${stage}: HTTP ${response.status()}: ${text.slice(0, 1200)}`)
  return text ? JSON.parse(text) : {}
}
function visit(value, fn) {
  if (Array.isArray(value)) value.forEach(item => visit(item, fn))
  else if (value && typeof value === 'object') {
    fn(value)
    Object.values(value).forEach(item => visit(item, fn))
  }
}
const isRowSave = request => request.method() === 'POST' && /\/rows(?:\?|$)/.test(request.url())
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function main() {
  browser = await chromium.launch({ headless: true })
  setup = await browser.newContext({ baseURL: backendOrigin })
  await json(await setup.request.post('/api/global/auth/default/login', {
    data: { username: 'issue19473@example.test', password: process.env.TEST_PASSWORD },
  }), 'login')
  const self = await json(await setup.request.get('/api/global/self'), 'self')
  assert.ok(self.csrfToken, 'Authenticated self exposes CSRF token')
  console.log(`::add-mask::${self.csrfToken}`)
  await setup.setExtraHTTPHeaders({ 'x-csrf-token': self.csrfToken, 'x-budibase-api-version': '1' })
  const app = await json(await setup.request.post('/api/applications', {
    multipart: {
      name: 'Issue 19473 isolated reproduction', url: '/issue-19473',
      fileToImport: {
        name: 'reproduction.tar.gz', mimeType: 'application/gzip',
        buffer: fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'reproduction.tar.gz')),
      },
    },
  }), 'import')
  const appId = app.appId
  assert.match(appId || '', /^app_dev_/)
  report.workspace = { appId, metadataId: app._id, url: app.url }
  const headers = { 'x-budibase-app-id': appId }
  const screens = await json(await setup.request.get('/api/screens', { headers }), 'screens')
  assert.ok(Array.isArray(screens))
  let screen, form, button, eventKey
  for (const candidate of screens) {
    let candidateForm, candidateButton, candidateEvent
    visit(candidate, node => {
      if (node._component?.endsWith('/form')) candidateForm = node
      if (node._component?.endsWith('/button')) {
        const key = Object.keys(node).find(key => Array.isArray(node[key]) && node[key].some(action => action?.['##eventHandlerType'] === 'Save Row'))
        if (key) { candidateButton = node; candidateEvent = key }
      }
    })
    if (candidateForm && candidateButton) {
      screen = candidate; form = candidateForm; button = candidateButton; eventKey = candidateEvent
      break
    }
  }
  assert.ok(screen && form && button && eventKey, 'Original form and action were imported')
  const originalActions = structuredClone(button[eventKey])
  const save = originalActions.find(action => action['##eventHandlerType'] === 'Save Row')
  const table = await json(await setup.request.get(`/api/tables/${save.parameters.tableId}`, { headers }), 'fixture-table')
  report.fixture = {
    formId: form._id, saveProviderId: save.parameters.providerId ?? null,
    fieldOverrideKeys: Object.keys(save.parameters.fields || {}),
    actions: originalActions.map(action => action['##eventHandlerType']),
    table: { primaryDisplay: table.primaryDisplay, schema: table.schema },
  }
  const workspaceApp = await json(await setup.request.get(`/api/workspaceApp/${screen.workspaceAppId}`, { headers }), 'workspace-app')
  const editable = Object.fromEntries(['_id', '_rev', 'name', 'url', 'navigation', 'theme', 'customTheme', 'projectIds'].filter(key => workspaceApp[key] !== undefined).map(key => [key, workspaceApp[key]]))
  const enabled = await json(await setup.request.put(`/api/workspaceApp/${screen.workspaceAppId}`, {
    headers, data: { ...editable, disabled: false },
  }), 'enable-disposable-app')
  assert.equal(enabled.workspaceApp?.disabled, false)
  report.fixture.appEnabledForTest = true
  const buttonName = button.text || button._instanceName
  let appPath

  async function configure(mode) {
    const currentScreens = await json(await setup.request.get('/api/screens', { headers }), `screens-${mode}`)
    const currentScreen = currentScreens.find(item => item._id === screen._id)
    visit(currentScreen, node => {
      if (node._id !== button._id) return
      node[eventKey] = structuredClone(originalActions)
      const action = node[eventKey].find(action => action['##eventHandlerType'] === 'Save Row')
      if (mode !== 'as-exported') action.parameters.providerId = form._id
      if (mode === 'explicit-validation') {
        node[eventKey].unshift({ '##eventHandlerType': 'Validate Form', parameters: { componentId: form._id } })
      }
    })
    await json(await setup.request.post('/api/screens', { headers, data: currentScreen }), `save-screen-${mode}`)
    await json(await setup.request.post(`/api/applications/${appId}/publish`, { headers, data: {} }), `publish-${mode}`)
    const catalogue = await json(await setup.request.get('/api/client/applications'), `published-apps-${mode}`)
    const prodId = appId.replace('app_dev_', 'app_')
    const published = catalogue.apps.find(item => item.appId === `${prodId}_${screen.workspaceAppId}`)
    assert.ok(published?.url, 'Exact imported workspace app is published')
    appPath = '/app' + published.url
  }

  async function exercise(mode, variant, protocol) {
    const origin = protocol === 'h2' ? 'https://127.0.0.1:10443' : backendOrigin
    const context = await browser.newContext({
      baseURL: origin, storageState: await setup.storageState(), ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 }, serviceWorkers: 'block',
    })
    page = await context.newPage()
    const entry = { mode, variant, protocol, assetOverrides: [], requests: [], responses: [], wireResponses: [], pageErrors: [] }
    report.cases.push(entry)
    const dist = path.join(process.env.RUNNER_TEMP, `client-${variant}`)
    await page.route('**/api/assets/**', async route => {
      const pathname = new URL(route.request().url()).pathname
      let file
      if (/\/client(?:\/budibase-client\.js)?$/.test(pathname) || pathname.endsWith('/budibase-client.js')) file = path.join(dist, 'budibase-client.js')
      else if (pathname.includes('/chunks/')) file = path.join(dist, 'chunks', path.basename(pathname))
      if (file && fs.existsSync(file)) {
        entry.assetOverrides.push(path.relative(dist, file))
        await route.fulfill({ path: file, contentType: 'application/javascript' })
      } else await route.continue()
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', ({ response }) => {
      if (/\/rows(?:\?|$)/.test(response.url)) {
        entry.wireResponses.push({ protocol: response.protocol, status: response.status, statusText: response.statusText })
      }
    })
    page.on('pageerror', error => entry.pageErrors.push(error.message))
    page.on('request', request => {
      if (isRowSave(request)) entry.requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
    })
    const responses = []
    page.on('response', response => {
      if (isRowSave(response.request())) responses.push((async () => {
        entry.responses.push({ status: response.status(), statusText: response.statusText(), body: await response.json() })
      })())
    })
    await page.goto(origin + appPath, { waitUntil: 'networkidle', timeout: 60000 })
    const inputs = page.getByRole('textbox')
    await inputs.nth(1).waitFor({ timeout: 20000 })
    assert.ok(entry.assetOverrides.includes('budibase-client.js'), 'Built source bundle actually served')
    await inputs.nth(1).fill('Optional field example')
    await settle(page)
    const saveButton = page.getByRole('button', { name: buttonName, exact: true })
    const filePrefix = `${protocol}-${mode}-${variant}`
    if (mode === 'explicit-validation') {
      await saveButton.click()
      await page.locator('.spectrum-Form-item .error').first().waitFor()
      await settle(page)
      assert.equal(entry.requests.length, 0, 'Explicit validation prevents invalid API save')
    } else {
      const failure = page.waitForResponse(response => isRowSave(response.request()))
      const log = page.waitForEvent('console', { predicate: message => message.text().includes('[Client] HTTP 500') })
      await saveButton.click()
      const response = await failure
      assert.equal(response.status(), 500)
      const body = await response.json()
      assert.equal(body.message, undefined, 'Real backend response has no message')
      assert.equal(body.error, undefined, 'Real backend response has no general error')
      assert.deepEqual(body.validationErrors, { required_display_column: ["can't be blank"] })
      await log
      await settle(page)
      const toast = page.getByText("required_display_column can't be blank", { exact: true })
      const shouldNotify = variant === 'candidate' || protocol === 'http1'
      if (shouldNotify) await toast.waitFor({ state: 'visible', timeout: 5000 })
      entry.validationNotificationVisible = await toast.isVisible()
      assert.equal(entry.validationNotificationVisible, shouldNotify, 'Notification matches transport and tested source')
      assert.ok(entry.wireResponses.some(item => item.protocol === (protocol === 'h2' ? 'h2' : 'http/1.1')), 'Browser confirms actual API transport protocol')
      if (protocol === 'h2') assert.equal(response.statusText(), '', 'HTTP/2 supplies no status text')
    }
    entry.inlineErrors = await page.locator('.spectrum-Form-item .error').allTextContents()
    entry.bodyAfterInvalidSave = (await page.locator('body').innerText()).slice(0, 4000)
    await page.screenshot({ path: path.join(evidence, `${filePrefix}-invalid.png`), fullPage: true })
    if (mode !== 'as-exported') {
      const value = `Valid ${protocol} ${variant} ${mode}`
      await inputs.nth(0).fill(value)
      await inputs.nth(0).blur()
      await page.waitForFunction(() => document.querySelectorAll('.spectrum-Form-item .error').length === 0)
      await settle(page)
      const saved = page.waitForResponse(response => isRowSave(response.request()))
      await saveButton.click()
      const response = await saved
      assert.equal(response.status(), 200, 'Corrected form saves to real backend')
      const row = await response.json()
      assert.match(row._id, /^ro_/)
      assert.equal(row.required_display_column, value)
      assert.equal(row.some_other_column, 'Optional field example')
      entry.savedRow = { id: row._id, value: row.required_display_column }
      await page.getByText('Row saved', { exact: true }).waitFor()
      await settle(page)
      await page.screenshot({ path: path.join(evidence, `${filePrefix}-corrected.png`), fullPage: true })
    }
    await Promise.all(responses)
    assert.equal(entry.pageErrors.length, 0, `No browser exceptions: ${entry.pageErrors.join('; ')}`)
    entry.passed = true
    await context.close()
    page = undefined
  }

  for (const mode of ['as-exported', 'connected', 'explicit-validation']) {
    await configure(mode)
    for (const protocol of ['http1', 'h2']) {
      for (const variant of ['upstream', 'candidate']) await exercise(mode, variant, protocol)
    }
  }
  assert.equal(report.cases.length, 12)
  report.completed = true
}

main().catch(async error => {
  report.completed = false
  report.failure = error.message
  if (page) {
    try {
      report.failureBody = (await page.locator('body').innerText()).slice(0, 4000)
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true })
    } catch {}
  }
  process.exitCode = 1
}).finally(async () => {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (browser) await browser.close()
})
