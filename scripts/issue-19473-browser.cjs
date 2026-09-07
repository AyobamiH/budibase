const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium } = createRequire(path.join(process.env.RUNNER_TEMP, 'browser/package.json'))('playwright')

const origin = 'http://127.0.0.1:10000'
const evidence = path.resolve('evidence/browser')
fs.mkdirSync(evidence, { recursive: true })
const report = { apiMocked: false, cases: [], setup: [] }
let browser, context, page

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

async function main() {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await json(await context.request.post('/api/global/auth/default/login', {
    data: { username: 'issue19473@example.test', password: process.env.TEST_PASSWORD },
  }), 'login')
  const self = await json(await context.request.get('/api/global/self'), 'self')
  if (!self.csrfToken) throw new Error('Authenticated self did not expose a CSRF token')
  console.log(`::add-mask::${self.csrfToken}`)
  await context.setExtraHTTPHeaders({ 'x-csrf-token': self.csrfToken, 'x-budibase-api-version': '1' })
  const app = await json(await context.request.post('/api/applications', {
    multipart: {
      name: 'Issue 19473 isolated reproduction',
      url: '/issue-19473',
      fileToImport: {
        name: 'reproduction.tar.gz',
        mimeType: 'application/gzip',
        buffer: fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'reproduction.tar.gz')),
      },
    },
  }), 'import')
  const appId = app.appId
  assert.match(appId || '', /^app_dev_/, 'Import returns a development workspace appId, not the app_metadata document ID')
  report.workspace = { appId, metadataId: app._id, url: app.url }
  const headers = { 'x-budibase-app-id': appId }
  const screensResponse = await json(await context.request.get('/api/screens', { headers }), 'screens')
  const screens = Array.isArray(screensResponse) ? screensResponse : screensResponse.screens
  assert.ok(Array.isArray(screens), 'Screens response is an array')
  report.screenSummary = screens.map(screen => ({ id: screen._id, name: screen.name, routing: screen.routing, workspaceAppId: screen.workspaceAppId }))
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
  assert.ok(screen && form && button && eventKey, 'Imported fixture contains a form and Save Row button')
  const originalActions = structuredClone(button[eventKey])
  const save = originalActions.find(action => action['##eventHandlerType'] === 'Save Row')
  const table = await json(await context.request.get(`/api/tables/${save.parameters.tableId}`, { headers }), 'fixture-table')
  report.fixture = {
    formId: form._id,
    saveProviderId: save.parameters.providerId ?? null,
    fieldOverrideKeys: Object.keys(save.parameters.fields || {}),
    actions: originalActions.map(action => action['##eventHandlerType']),
    table: { primaryDisplay: table.primaryDisplay, schema: table.schema },
  }
  const buttonName = button.text || button._instanceName
  let appUrl

  async function configure(mode) {
    const response = await json(await context.request.get('/api/screens', { headers }), `screens-${mode}`)
    const currentScreens = Array.isArray(response) ? response : response.screens
    const currentScreen = currentScreens.find(item => item._id === screen._id)
    assert.ok(currentScreen, 'Fixture screen still exists')
    visit(currentScreen, node => {
      if (node._id !== button._id) return
      node[eventKey] = structuredClone(originalActions)
      const saveAction = node[eventKey].find(action => action['##eventHandlerType'] === 'Save Row')
      if (mode !== 'as-exported') saveAction.parameters.providerId = form._id
      if (mode === 'explicit-validation') {
        node[eventKey].unshift({ '##eventHandlerType': 'Validate Form', parameters: { componentId: form._id } })
      }
    })
    await json(await context.request.post('/api/screens', { headers, data: currentScreen }), `save-screen-${mode}`)
    await json(await context.request.post(`/api/applications/${appId}/publish`, { headers, data: {} }), `publish-${mode}`)
    const catalogue = await json(await context.request.get('/api/client/applications'), `published-apps-${mode}`)
    const prodId = appId.replace('app_dev_', 'app_')
    const published = catalogue.apps.find(item => item.appId === `${prodId}_${screen.workspaceAppId}`)
    assert.ok(published?.url, 'Published catalogue contains the exact imported workspace app')
    appUrl = `${origin}/app${published.url.startsWith('/') ? published.url : '/' + published.url}`
    report.appPath = new URL(appUrl).pathname
  }

  async function exercise(mode, variant) {
    page = await context.newPage()
    const entry = { mode, variant, assetOverrides: [], requests: [], responses: [], networkErrors: [], pageErrors: [] }
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
    page.on('pageerror', error => entry.pageErrors.push(error.message))
    page.on('request', request => {
      if (request.method() === 'POST' && /\/rows(?:\?|$)/.test(request.url())) {
        entry.requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
      }
    })
    page.on('response', async response => {
      if (response.status() >= 400 && response.url().startsWith(origin + '/api/')) {
        let body
        try { body = await response.json() } catch { body = null }
        entry.networkErrors.push({ path: new URL(response.url()).pathname, status: response.status(), body })
      }
      if (response.request().method() === 'POST' && /\/rows(?:\?|$)/.test(response.url())) {
        let body
        try { body = await response.json() } catch { body = null }
        entry.responses.push({ status: response.status(), body })
      }
    })
    await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60000 })
    entry.initialBody = (await page.locator('body').innerText()).slice(0, 4000)
    entry.buttons = await page.getByRole('button').allTextContents()
    const inputs = page.getByRole('textbox')
    await inputs.nth(1).waitFor({ timeout: 25000 })
    assert.ok(entry.assetOverrides.includes('budibase-client.js'), 'Tested client source was actually loaded')
    await inputs.nth(1).fill('Optional field example')
    await page.screenshot({ path: path.join(evidence, `${mode}-${variant}-before.png`), fullPage: true })
    const saveButton = page.getByRole('button', { name: buttonName, exact: true })
    await saveButton.click()
    await page.waitForTimeout(1200)
    entry.errorsAfterEmptySave = await page.locator('.spectrum-Form-item .error').allTextContents()
    entry.bodyAfterEmptySave = (await page.locator('body').innerText()).slice(0, 4000)
    entry.requestCountAfterEmptySave = entry.requests.length
    await page.screenshot({ path: path.join(evidence, `${mode}-${variant}-invalid.png`), fullPage: true })
    if (mode !== 'as-exported') {
      await inputs.nth(0).fill(`Valid ${variant} ${mode}`)
      await saveButton.click()
      await page.waitForTimeout(1200)
      entry.errorsAfterCorrection = await page.locator('.spectrum-Form-item .error').allTextContents()
      entry.bodyAfterCorrection = (await page.locator('body').innerText()).slice(0, 4000)
      await page.screenshot({ path: path.join(evidence, `${mode}-${variant}-corrected.png`), fullPage: true })
      assert.ok(entry.responses.some(response => response.status >= 200 && response.status < 300), 'Corrected form saves to the real database')
    }
    assert.equal(entry.pageErrors.length, 0, `No browser exceptions: ${entry.pageErrors.join('; ')}`)
    await page.close()
    page = undefined
  }

  for (const mode of ['as-exported', 'connected', 'explicit-validation']) {
    await configure(mode)
    for (const variant of ['upstream', 'candidate']) await exercise(mode, variant)
  }
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
