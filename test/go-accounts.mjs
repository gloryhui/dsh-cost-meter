import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

// 多 GO 订阅的账号发现(本 fork):覆盖两代宿主的配置读取路径。
//
// 背景:DSH 0.2.0-rc.2 的 settings 服务(SettingsForms)已没有 get(id) 方法,只有
// describe/update/replace/mutate/write/schema。旧写法 `settings.get('llm-pi-ai')` 会被
// 可选链静默短路成 undefined——插件不报错、只是永远只发现兜底账号。本用例确保
// configEditor 路径(新版官方读取方式)与 settings.get 路径(旧宿主)都能发现全部订阅。
const root = mkdtempSync(join(tmpdir(), 'cm-go-accounts-'))
const envNames = ['DSH_HOME', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'OPENCODE_GO_API_KEY', 'OPENCODE_GO_2_API_KEY', 'OPENCODE_API_KEY']
const savedEnv = Object.fromEntries(envNames.map(n => [n, process.env[n]]))
const originalFetch = globalThis.fetch
try {
  for (const n of envNames) delete process.env[n]
  process.env.DSH_HOME = root
  process.env.USERPROFILE = root
  process.env.HOME = root
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  const storage = join(root, 'storages', 'cost-meter')
  mkdirSync(storage, { recursive: true })
  writeFileSync(join(storage, 'ledger.json'), JSON.stringify({ version: 1, config: { goQuota: { enabled: true, display: 'both' } }, days: {} }))
  // 额度查询一律软失败(401),本用例只关心账号发现,不关心取数。
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })

  // 与用户真实配置同形:账号 1 未写 baseURL(靠 apiKeyEnv 命名约定识别),
  // 账号 2 写了官方端点,另有一个非 GO 路由必须被排除。
  const providers = {
    'opencode-go': { displayName: 'OpenCode Go (账号 1)', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go-2': { displayName: 'OpenCode Go (账号 2)', api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_2_API_KEY' },
    'ollama-online': { displayName: 'ollama-online', api: 'openai-completions', baseURL: 'https://ollama.com/v1', apiKeyEnv: 'OLLAMA_ONLINE_API_KEY' },
  }
  const credentials = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, source: '' }),
    set: async () => {},
    unset: async () => {},
  }
  const llmEntry = { options: { id: 'llm-pi-ai', config: { providers } } }
  const otherEntry = { options: { id: 'llm-deepseek', config: { models: [] } } }

  /** 用给定服务集合挂载插件,返回 costMeter 服务与它注册的服务表。 */
  function mount(services) {
    const provided = {}
    apply({
      get: name => services[name],
      provide: (name, service) => { provided[name] = service },
      on: () => () => {},
      inject() {},
      effect: () => {},
      logger: { info() {}, warn() {}, error() {} },
    })
    return { service: provided.costMeter, provided }
  }

  /** 账号 id 列表(按下发顺序)。 */
  async function accountIds(services) {
    const { service } = mount(services)
    assert.ok(service, 'costMeter 服务已注册')
    const state = await service.getState()
    const accounts = Array.isArray(state.goQuotaAccounts) ? state.goQuotaAccounts : null
    assert.ok(accounts !== null, 'state.goQuotaAccounts 必须存在')
    return accounts
  }

  // 1) 新版宿主:只有 configEditor(settings 服务存在但**没有** get 方法)。
  {
    const accounts = await accountIds({
      credentials,
      settings: { describe: () => [] },
      configEditor: { entries: () => [otherEntry, llmEntry] },
    })
    assert.deepEqual(accounts.map(a => a.id), ['opencode-go', 'opencode-go-2'], 'configEditor.entries() 路径发现两个订阅且顺序与配置一致')
    assert.deepEqual(accounts.map(a => a.label), ['OpenCode Go (账号 1)', 'OpenCode Go (账号 2)'], '账号名取路由 displayName')
    assert.ok(!accounts.some(a => a.id === 'ollama-online'), '非 GO 端点路由被排除')
  }

  // 2) 新版宿主但 entries() 不可用:回退 configuration() 的 override 层。
  {
    const accounts = await accountIds({
      credentials,
      settings: {},
      configEditor: { configuration: () => [{ entry: llmEntry, inherited: {}, override: { providers } }] },
    })
    assert.deepEqual(accounts.map(a => a.id), ['opencode-go', 'opencode-go-2'], 'configEditor.configuration() 的 override 路径同样可用')
  }

  // 3) 旧宿主:settings 服务提供 get(id)(新宿主没有这个方法)。
  {
    const accounts = await accountIds({
      credentials,
      settings: { get: section => (section === 'llm-pi-ai' ? { providers } : {}) },
    })
    assert.deepEqual(accounts.map(a => a.id), ['opencode-go', 'opencode-go-2'], '旧宿主 settings.get() 路径保持可用')
  }

  // 4) 两条路径都拿不到:退化为单个兜底账号(等价改造前的单账号行为)。
  {
    const accounts = await accountIds({ credentials, settings: {}, configEditor: { entries: () => [], configuration: () => [] } })
    assert.deepEqual(accounts.map(a => a.id), ['default'], '读不到路由表时退化为兜底账号')
    assert.equal(accounts[0].label, 'OpenCode GO')
  }

  // 5) 配置读取抛错时不能拖垮插件(服务在 boot 早期可能不可用)。
  {
    const accounts = await accountIds({
      credentials,
      settings: { get: () => { throw new Error('unavailable') } },
      configEditor: {
        entries: () => { throw new Error('not ready') },
        configuration: () => { throw new Error('not ready') },
      },
    })
    assert.deepEqual(accounts.map(a => a.id), ['default'], '配置读取异常时安全退化为兜底账号')
  }

  console.log('[ok] 多 GO 订阅账号发现:configEditor(新版)/ settings.get(旧版)/ 异常回退三条路径')
} finally {
  globalThis.fetch = originalFetch
  for (const n of envNames) savedEnv[n] === undefined ? delete process.env[n] : process.env[n] = savedEnv[n]
  rmSync(root, { recursive: true, force: true })
}
