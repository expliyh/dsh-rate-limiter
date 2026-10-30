// dsh-rate-limiter browser half: the Plugins page configuration card for the
// 'rate-limiter' settings entry owned by the host half. Self-contained by hand
// (this repo has no client bundler): the client module system adopts the CJS
// factory below and the kernel loads { apply, inject } as a client plugin.
//
// dsh 0.2.2 mechanism: the Plugins page renders a row's configuration from the
// keyed slot 'plugins.row.config', keyed '<package name>#<row id>', with owner
// props { view: 'summary' | 'page', form?: ConfigPageForm }. The card stages
// edits over the shared ConfigForm that the configForms service exposes for the
// entry (getSnapshot/subscribe/mutate), so reads and writes ride the same
// revision-fenced settings transport as the built-in configuration pages. The
// registration exists only while the Host serves the namespace
// (configForms.whileServed), so a host without the entry shows no card.
//
// Runtime value imports are limited to the platform seeds: react and
// @deepseek-ai/dsh-client-store.
window.__ModuleLoader__.load({
  id: '@xidong-ai/dsh-rate-limiter',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    /** Locale namespace of the card copy. */
    const LOCALE_NS = 'settings.rate-limiter'
    /** Settings/profile entry id the card edits (the row id in cordis.patch.yml). */
    const ENTRY_ID = 'rate-limiter'
    /** Plugin package name; a row config key is '<name>#<row id>'. */
    const PACKAGE_NAME = '@xidong-ai/dsh-rate-limiter'
    /** 'plugins.row.config' key naming this row. */
    const ROW_CONFIG_KEY = PACKAGE_NAME + '#' + ENTRY_ID
    /** Rate floor of the host Config schema (BucketSchema.rate). */
    const MIN_RATE = 0.001
    /** Bucket staged when a provider is added before the user edits it. */
    const DEFAULT_BUCKET = { rate: 1, burst: 5 }

    // ── locale dictionaries (follow the app's language setting) ─────────────
    const zh = {
      summaryOn: '限速：启用 · {count} 个供应商',
      summaryOff: '限速：停用 · {count} 个供应商',
      summaryLoading: '限速设置加载中…',
      summaryUnavailable: '限速配置不可用',
      loading: '正在加载限速器设置…',
      unavailable: '限速配置暂不可用：宿主当前未暴露 rate-limiter 配置项。',
      readOnly: '当前设置提供方只读，无法保存修改。',
      saved: '限速器设置已保存。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saveFailed: '保存失败：',
      saveConflict: '配置已被外部修改，已重新载入最新值；你的修改仍保留，请再次保存。',
      saveReadOnly: '当前设置只读，无法保存。',
      enabled: '启用限速',
      providerPick: '添加供应商',
      providerPlaceholder: '选择供应商',
      providerManualPlaceholder: '输入供应商标识',
      addProvider: '添加',
      noProviders: '尚未配置任何供应商，限速不会作用于任何请求。',
      addHint: '从供应商目录选择一个尚未添加的供应商标识加入列表；新增项默认速率 1、突发容量 5，可自行修改。',
      manualAddHint: '供应商目录暂不可用，可直接输入供应商标识后添加。',
      remove: '移除',
      rate: '速率（词元每秒）',
      burst: '突发容量',
      rateHint: '补充速率，即长期平均 QPS；需为不小于 0.001 的有限数值。',
      burstHint: '桶容量，允许的突发请求数；需为不小于 1 的整数。',
      invalidRate: '速率必须为不小于 0.001 的有限数值。',
      invalidBurst: '突发容量必须为不小于 1 的整数。',
      invalidProvider: '供应商标识不能为空。',
    }
    const en = {
      summaryOn: 'Rate limiting: on · {count} providers',
      summaryOff: 'Rate limiting: off · {count} providers',
      summaryLoading: 'Loading rate limiter settings…',
      summaryUnavailable: 'Rate limiter configuration unavailable',
      loading: 'Loading rate limiter settings…',
      unavailable: 'Rate limiter configuration is unavailable: the Host does not expose the rate-limiter entry.',
      readOnly: 'This deployment stores settings read-only.',
      saved: 'Rate limiter settings saved.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saveFailed: 'Save failed: ',
      saveConflict: 'The configuration changed elsewhere and the latest values were reloaded; your edits are kept, so save again.',
      saveReadOnly: 'The settings provider is read-only, so saving is not possible.',
      enabled: 'Enable rate limiting',
      providerPick: 'Add provider',
      providerPlaceholder: 'Select a provider',
      providerManualPlaceholder: 'Type a provider id',
      addProvider: 'Add',
      noProviders: 'No provider is configured, so no request is rate limited.',
      addHint: 'Pick one provider from the directory that is not in the list yet. New rows start at rate 1 / burst 5 and can be edited.',
      manualAddHint: 'The provider directory is unavailable; type a provider id and add it directly.',
      remove: 'Remove',
      rate: 'Rate (token/s)',
      burst: 'Burst capacity',
      rateHint: 'Refill rate, i.e. the long-term average QPS; must be a finite number of at least 0.001.',
      burstHint: 'Bucket capacity, the number of burst requests allowed; must be an integer of at least 1.',
      invalidRate: 'Rate must be a finite number of at least 0.001.',
      invalidBurst: 'Burst must be an integer of at least 1.',
      invalidProvider: 'A provider id must not be empty.',
    }

    // ── pure draft helpers ─────────────────────────────────────────────────
    /** Whether a value is a finite number. */
    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }
    /** Convert a control value into a number; an empty draft becomes undefined. */
    function toNumber(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'number') return value
      if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed === '' ? undefined : Number(trimmed)
      }
      return Number(value)
    }
    /** Normalize one stored bucket (the host schema already validated it). */
    function bucketOf(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      const rate = isFiniteNumber(raw.rate) ? raw.rate : DEFAULT_BUCKET.rate
      const burst = typeof raw.burst === 'number' && Number.isInteger(raw.burst) && raw.burst >= 1
        ? raw.burst
        : DEFAULT_BUCKET.burst
      return { rate, burst }
    }
    /** Normalize a section value into the card's seed draft. */
    function seedOf(value) {
      const section = value !== null && typeof value === 'object' ? value : {}
      const enabled = typeof section.enabled === 'boolean' ? section.enabled : true
      const providers = []
      const raw = section.providers
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [name, bucket] of Object.entries(raw)) {
          const normalized = bucketOf(bucket)
          providers.push({ name, rate: normalized.rate, burst: normalized.burst })
        }
      }
      return { enabled, providers }
    }
    /** Deep copy a draft; store snapshots are frozen and shared. */
    function cloneDraft(draft) {
      return {
        enabled: draft.enabled === true,
        providers: draft.providers.map((provider) => ({
          name: provider.name,
          rate: provider.rate,
          burst: provider.burst,
        })),
      }
    }
    /** Whether two drafts hold the same values (list order included). */
    function draftEquals(left, right) {
      if (left.enabled !== right.enabled) return false
      if (left.providers.length !== right.providers.length) return false
      for (let index = 0; index < left.providers.length; index += 1) {
        const a = left.providers[index]
        const b = right.providers[index]
        if (a.name !== b.name || a.rate !== b.rate || a.burst !== b.burst) return false
      }
      return true
    }
    /** First draft validation failure key, or null when the draft is saveable. */
    function validationKeyOf(draft) {
      for (const provider of draft.providers) {
        if (typeof provider.name !== 'string' || provider.name.trim() === '') return 'invalidProvider'
        if (!isFiniteNumber(provider.rate) || provider.rate < MIN_RATE) return 'invalidRate'
        if (typeof provider.burst !== 'number' || !Number.isInteger(provider.burst) || provider.burst < 1) return 'invalidBurst'
      }
      return null
    }
    /**
     * Ordered path ops that turn the seed into the draft. The nested
     * providers.<name>.(rate|burst) paths ride the host Config's volatile
     * 'providers' node, so the host half must declare that node volatile.
     */
    function buildOps(seed, draft) {
      const ops = []
      if (seed.enabled !== draft.enabled) {
        ops.push({ op: 'set', path: ['enabled'], value: draft.enabled === true })
      }
      const seeded = new Map(seed.providers.map((provider) => [provider.name, provider]))
      for (const provider of draft.providers) {
        const previous = seeded.get(provider.name)
        if (previous === undefined) {
          ops.push({ op: 'set', path: ['providers', provider.name, 'rate'], value: provider.rate })
          ops.push({ op: 'set', path: ['providers', provider.name, 'burst'], value: provider.burst })
          continue
        }
        if (previous.rate !== provider.rate) {
          ops.push({ op: 'set', path: ['providers', provider.name, 'rate'], value: provider.rate })
        }
        if (previous.burst !== provider.burst) {
          ops.push({ op: 'set', path: ['providers', provider.name, 'burst'], value: provider.burst })
        }
      }
      const kept = new Set(draft.providers.map((provider) => provider.name))
      for (const provider of seed.providers) {
        if (!kept.has(provider.name)) ops.push({ op: 'unset', path: ['providers', provider.name] })
      }
      return ops
    }
    /** Normalize the provider directory answer into the card's catalog entries. */
    function catalogOf(entries) {
      const providers = []
      const seen = new Set()
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry === null || typeof entry !== 'object') continue
        const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
        if (provider === '' || seen.has(provider)) continue
        seen.add(provider)
        const displayName = typeof entry.displayName === 'string' && entry.displayName !== ''
          ? entry.displayName
          : provider
        providers.push({ provider, displayName })
      }
      return providers
    }
    /** Human-readable message of an unknown thrown value. */
    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message
      return String(error)
    }

    // ── controller: form snapshot -> card state, staged draft -> path ops ───
    /**
     * Stages the row's configuration over the shared entry form. The snapshot
     * store it owns is the card's reactive read channel (bound as
     * props.useRateLimiter); every write goes through the form's revision-fenced
     * mutate, so a refused or stale write reloads the host state instead of
     * keeping a stale draft baseline.
     */
    class RateLimiterCardController {
      /** @param form - shared ConfigForm of the rate-limiter entry. */
      constructor(form) {
        this.form = form
        /** Revision the staged draft started from; undefined fences at the latest read. */
        this.baselineRevision = undefined
        /** Provider directory loader supplied while the remote services are live. */
        this.catalogLoader = undefined
        this.catalogGeneration = 0
        this.unsubscribe = undefined
        this.store = createSnapshotStore({
          status: 'loading',
          writable: false,
          revision: undefined,
          seed: { enabled: true, providers: [] },
          draft: { enabled: true, providers: [] },
          dirty: false,
          invalid: null,
          catalog: { status: 'unavailable', providers: [] },
          pendingProvider: '',
          saveState: { kind: 'idle' },
        })
        this.unsubscribe = form.subscribe(() => { this.sync() })
        this.sync()
      }

      /** Re-derive what the host serves; staged edits survive until saved or discarded. */
      sync() {
        const snapshot = this.form.getSnapshot()
        const current = this.store.getSnapshot()
        const ready = snapshot.status === 'ready' && snapshot.value !== undefined
        const adopt = ready && !current.dirty
        const seed = ready ? seedOf(snapshot.value) : current.seed
        this.store.update((state) => {
          state.status = snapshot.status
          state.writable = snapshot.writable === true
          state.revision = snapshot.revision
          if (!ready) return
          state.seed = seed
          state.draft = adopt ? cloneDraft(seed) : state.draft
          state.dirty = adopt ? false : !draftEquals(state.draft, seed)
          state.invalid = validationKeyOf(state.draft)
        })
      }

      /** Publish a staged draft and re-derive its dirty/invalid flags. */
      commitDraft(next, clearPending) {
        const current = this.store.getSnapshot()
        const dirty = !draftEquals(next, current.seed)
        this.store.update((state) => {
          state.draft = next
          state.dirty = dirty
          state.invalid = validationKeyOf(next)
          state.saveState = { kind: 'idle' }
          if (clearPending) state.pendingProvider = ''
        })
        if (dirty && this.baselineRevision === undefined && current.revision !== undefined) {
          this.baselineRevision = current.revision
        }
      }

      setEnabled(enabled) {
        const current = this.store.getSnapshot()
        this.commitDraft({ enabled: enabled === true, providers: current.draft.providers })
      }

      setPendingProvider(value) {
        const text = typeof value === 'string' ? value : ''
        this.store.update((state) => { state.pendingProvider = text })
      }

      /** Stage a provider with the default bucket; false for a blank or duplicate id. */
      addProvider(name) {
        const current = this.store.getSnapshot()
        const candidate = name === undefined || name === null ? current.pendingProvider : name
        const key = typeof candidate === 'string' ? candidate.trim() : ''
        if (key === '') return false
        if (current.draft.providers.some((provider) => provider.name === key)) return false
        this.commitDraft({
          enabled: current.draft.enabled,
          providers: [...current.draft.providers, { name: key, rate: DEFAULT_BUCKET.rate, burst: DEFAULT_BUCKET.burst }],
        }, true)
        return true
      }

      removeProvider(name) {
        const current = this.store.getSnapshot()
        if (!current.draft.providers.some((provider) => provider.name === name)) return
        this.commitDraft({
          enabled: current.draft.enabled,
          providers: current.draft.providers.filter((provider) => provider.name !== name),
        })
      }

      setRate(name, value) {
        this.editBucket(name, 'rate', toNumber(value))
      }

      setBurst(name, value) {
        this.editBucket(name, 'burst', toNumber(value))
      }

      editBucket(name, field, value) {
        const current = this.store.getSnapshot()
        if (!current.draft.providers.some((provider) => provider.name === name)) return
        this.commitDraft({
          enabled: current.draft.enabled,
          providers: current.draft.providers.map((provider) => provider.name === name
            ? { name: provider.name, rate: provider.rate, burst: provider.burst, [field]: value }
            : provider),
        })
      }

      discard() {
        this.baselineRevision = undefined
        this.store.update((state) => {
          state.draft = cloneDraft(state.seed)
          state.dirty = false
          state.invalid = null
          state.pendingProvider = ''
          state.saveState = { kind: 'idle' }
        })
      }

      /** Adopt the host-accepted values as the new clean draft. */
      adoptSeed(saved) {
        this.store.update((state) => {
          state.draft = cloneDraft(state.seed)
          state.dirty = false
          state.invalid = null
          if (saved) state.saveState = { kind: 'saved' }
        })
      }

      /**
       * Write every staged edit in one revision-fenced mutation, then re-read.
       * @returns whether the host accepted the write.
       */
      async save() {
        const state = this.store.getSnapshot()
        if (state.status !== 'ready') return false
        if (state.saveState.kind === 'saving') return false
        if (!state.writable) {
          this.store.update((draft) => { draft.saveState = { kind: 'error', errorKey: 'saveReadOnly' } })
          return false
        }
        if (state.invalid !== null) {
          this.store.update((draft) => { draft.saveState = { kind: 'error', errorKey: state.invalid, validation: true } })
          return false
        }
        const ops = buildOps(state.seed, state.draft)
        if (ops.length === 0) {
          this.store.update((draft) => { draft.saveState = { kind: 'saved' } })
          return true
        }
        this.store.update((draft) => { draft.saveState = { kind: 'saving' } })
        let accepted
        try {
          accepted = await this.form.mutate(ops, this.baselineRevision)
        } catch (error) {
          this.store.update((draft) => {
            draft.saveState = { kind: 'error', errorKey: 'saveFailed', message: messageOf(error) }
          })
          return false
        }
        if (!accepted) {
          // A refused write means the host holds a newer revision: reload it and
          // let the next save fence at the latest read.
          this.baselineRevision = undefined
          this.sync()
          this.store.update((draft) => { draft.saveState = { kind: 'error', errorKey: 'saveConflict' } })
          return false
        }
        this.baselineRevision = undefined
        this.sync()
        this.adoptSeed(true)
        return true
      }

      /** Bind (or, with undefined, unbind) the provider directory source. */
      setCatalogSource(loader) {
        this.catalogLoader = loader
        if (loader === undefined) {
          this.catalogGeneration += 1
          this.store.update((state) => { state.catalog = { status: 'unavailable', providers: [] } })
          return Promise.resolve()
        }
        return this.refreshCatalog()
      }

      /** Re-read the optional provider directory; failure falls back to manual entry. */
      refreshCatalog() {
        const loader = this.catalogLoader
        const generation = ++this.catalogGeneration
        if (loader === undefined) {
          this.store.update((state) => { state.catalog = { status: 'unavailable', providers: [] } })
          return Promise.resolve()
        }
        this.store.update((state) => { state.catalog = { status: 'loading', providers: state.catalog.providers } })
        const settle = (next) => {
          if (generation !== this.catalogGeneration) return
          this.store.update((state) => { state.catalog = next })
        }
        return Promise.resolve()
          .then(() => loader())
          .then(
            (entries) => { settle({ status: 'ready', providers: catalogOf(entries) }) },
            () => { settle({ status: 'unavailable', providers: [] }) },
          )
      }

      /** Release the form subscription and stop any in-flight catalog read. */
      dispose() {
        this.catalogGeneration += 1
        this.catalogLoader = undefined
        if (this.unsubscribe !== undefined) {
          this.unsubscribe()
          this.unsubscribe = undefined
        }
      }

      /** The inject face the slot registration publishes. */
      inject() {
        return {
          hooks: { rateLimiter: this.store },
          actions: {
            setEnabled: (enabled) => { this.setEnabled(enabled) },
            setPendingProvider: (value) => { this.setPendingProvider(value) },
            addProvider: (name) => this.addProvider(name),
            removeProvider: (name) => { this.removeProvider(name) },
            setRate: (name, value) => { this.setRate(name, value) },
            setBurst: (name, value) => { this.setBurst(name, value) },
            discard: () => { this.discard() },
            save: () => this.save(),
            refreshCatalog: () => this.refreshCatalog(),
          },
        }
      }
    }

    // ── card styles (inline + CSS variables, matching the built-in pages) ───
    const S = {
      form: { display: 'flex', flexDirection: 'column', gap: 10 },
      notice: { color: 'var(--dsw-alias-label-secondary)', margin: 0, fontSize: 12, lineHeight: 1.5 },
      saved: { color: 'var(--dsw-alias-label-secondary)', margin: 0, fontSize: 12, lineHeight: 1.5 },
      failed: { minWidth: 0, color: 'var(--dsw-alias-label-error)', flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 },
      warnHint: { color: 'var(--dsw-alias-label-warning, #b7791f)', margin: 0, fontSize: 12, lineHeight: 1.5 },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' },
      checkLabel: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.5 },
      checkbox: { accentColor: 'var(--dsw-alias-brand-primary)' },
      fieldset: { border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      addRow: { display: 'flex', alignItems: 'center', gap: 8 },
      input: {
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 10px',
        fontSize: 13, lineHeight: 1.5, minWidth: 0,
      },
      addButton: {
        appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)', background: 'transparent', borderRadius: 8,
        padding: '5px 14px', fontSize: 13, lineHeight: 1.5, flex: 'none',
      },
      hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 12, lineHeight: 1.5 },
      list: { display: 'flex', flexDirection: 'column', gap: 2, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' },
      rowName: {
        color: 'var(--dsw-alias-label-primary)', fontSize: 13, flex: '1 1 30%', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowInput: {
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '4px 8px',
        fontSize: 12, lineHeight: 1.4, flex: '1 1 0', minWidth: 0,
      },
      removeButton: {
        appearance: 'none', font: 'inherit', cursor: 'pointer', border: 0,
        color: 'var(--dsw-alias-label-error)', background: 'transparent', borderRadius: 6,
        padding: '4px 8px', fontSize: 12, flex: 'none',
      },
      footer: {
        borderTop: '1px solid var(--dsw-alias-border-l2)', justifyContent: 'flex-end',
        alignItems: 'center', gap: 8, padding: '12px 0 4px', display: 'flex',
      },
      discard: {
        appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)', background: 'transparent', borderRadius: 8,
        padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
      },
      save: {
        appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid transparent',
        color: 'var(--dsw-alias-label-inverse, #fff)', background: 'var(--dsw-alias-brand-primary)',
        borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
      },
    }

    // ── card component (React.createElement, no JSX) ────────────────────────
    /** One line for the row page when the package carries no description. */
    function renderSummary(state, t) {
      if (state.status === 'loading') return t('summaryLoading')
      if (state.status === 'unavailable') return t('summaryUnavailable')
      return t(state.seed.enabled ? 'summaryOn' : 'summaryOff', { count: state.seed.providers.length })
    }

    /** Localized text of a save error. */
    function saveErrorText(saveState, t) {
      if (saveState.message !== undefined && saveState.message !== '') return t('saveFailed') + saveState.message
      return t(saveState.errorKey === undefined ? 'saveFailed' : saveState.errorKey)
    }

    function paragraph(style, text) {
      return React.createElement('p', { style }, text)
    }

    /** Provider picker: the directory when it is live, free text otherwise. */
    function renderAddRow(state, t, actions, disabled) {
      const taken = new Set(state.draft.providers.map((provider) => provider.name))
      const options = state.catalog.providers.filter((option) => !taken.has(option.provider))
      const canPick = state.catalog.status === 'ready' && options.length > 0
      const pending = state.pendingProvider
      const picker = canPick
        ? React.createElement('select', {
          id: 'rate-limiter-pending-provider',
          style: { ...S.input, flex: '1 1 auto' },
          value: pending,
          disabled,
          'aria-label': t('providerPick'),
          onChange: (event) => { actions.setPendingProvider(event.target.value) },
        },
        React.createElement('option', { value: '' }, t('providerPlaceholder')),
        options.map((option) => React.createElement('option', { value: option.provider, key: option.provider }, option.displayName)))
        : React.createElement('input', {
          id: 'rate-limiter-pending-provider',
          type: 'text',
          style: { ...S.input, flex: '1 1 auto' },
          value: pending,
          disabled,
          placeholder: t('providerManualPlaceholder'),
          'aria-label': t('providerPick'),
          onChange: (event) => { actions.setPendingProvider(event.target.value) },
        })
      return React.createElement(
        'div',
        { style: S.addRow },
        picker,
        React.createElement('button', {
          type: 'button',
          style: S.addButton,
          disabled: disabled || pending.trim() === '',
          onClick: () => { actions.addProvider() },
        }, t('addProvider')),
      )
    }

    /** One provider's rate/burst row. */
    function renderProviderRow(provider, index, t, actions, disabled) {
      return React.createElement(
        'div',
        { style: S.row, key: provider.name },
        React.createElement('span', { style: S.rowName, title: provider.name }, provider.name),
        React.createElement('input', {
          id: 'rate-limiter-rate-' + index,
          type: 'number',
          min: MIN_RATE,
          step: 'any',
          style: S.rowInput,
          value: isFiniteNumber(provider.rate) ? String(provider.rate) : '',
          disabled,
          placeholder: t('rate'),
          title: t('rateHint'),
          'aria-label': t('rate') + ' ' + provider.name,
          onChange: (event) => { actions.setRate(provider.name, event.target.value) },
        }),
        React.createElement('input', {
          id: 'rate-limiter-burst-' + index,
          type: 'number',
          min: 1,
          step: 1,
          style: S.rowInput,
          value: typeof provider.burst === 'number' && Number.isFinite(provider.burst) ? String(provider.burst) : '',
          disabled,
          placeholder: t('burst'),
          title: t('burstHint'),
          'aria-label': t('burst') + ' ' + provider.name,
          onChange: (event) => { actions.setBurst(provider.name, event.target.value) },
        }),
        React.createElement('button', {
          type: 'button',
          style: S.removeButton,
          disabled,
          onClick: () => { actions.removeProvider(provider.name) },
        }, t('remove')),
      )
    }

    /** The editable page view with its own save controls. */
    function renderPage(state, t, actions) {
      if (state.status === 'loading') {
        return React.createElement('div', { style: S.form }, paragraph(S.notice, t('loading')))
      }
      if (state.status === 'unavailable') {
        return React.createElement('div', { style: S.form }, paragraph(S.notice, t('unavailable')))
      }
      const saving = state.saveState.kind === 'saving'
      const disabled = !state.writable || saving
      const children = []
      if (!state.writable) children.push(paragraph(S.notice, t('readOnly')))
      if (state.saveState.kind === 'saved') children.push(paragraph(S.saved, t('saved')))
      children.push(React.createElement(
        'div',
        { style: S.checkboxRow },
        React.createElement('label', { htmlFor: 'rate-limiter-enabled', style: S.checkLabel }, t('enabled')),
        React.createElement('input', {
          id: 'rate-limiter-enabled',
          type: 'checkbox',
          style: S.checkbox,
          checked: state.draft.enabled,
          disabled,
          onChange: (event) => { actions.setEnabled(event.target.checked) },
        }),
      ))
      children.push(React.createElement(
        'fieldset',
        { style: S.fieldset, disabled: !state.writable },
        renderAddRow(state, t, actions, disabled),
        paragraph(S.hint, state.catalog.status === 'ready' && state.catalog.providers.length > 0 ? t('addHint') : t('manualAddHint')),
        state.draft.providers.length === 0
          ? paragraph(S.hint, t('noProviders'))
          : React.createElement('div', { style: S.list }, state.draft.providers.map(
            (provider, index) => renderProviderRow(provider, index, t, actions, disabled),
          )),
      ))
      if (state.invalid !== null) children.push(paragraph(S.warnHint, t(state.invalid)))
      if (state.saveState.kind === 'error' && state.saveState.validation !== true) {
        children.push(paragraph(S.failed, saveErrorText(state.saveState, t)))
      }
      children.push(React.createElement(
        'div',
        { style: S.footer },
        React.createElement('button', {
          type: 'button',
          style: S.discard,
          disabled: !state.dirty || saving,
          onClick: () => { actions.discard() },
        }, t('discard')),
        React.createElement('button', {
          type: 'button',
          style: S.save,
          disabled: !state.dirty || saving || !state.writable || state.invalid !== null,
          onClick: () => { void actions.save() },
        }, t(saving ? 'saving' : 'save')),
      ))
      return React.createElement('div', { style: S.form, 'data-rate-limiter-config': '' }, ...children)
    }

    /**
     * The row configuration card: a one-liner for 'summary', the staged form
     * with save controls for 'page'.
     * @param props - owner props (view), locale seat (t), and the inject face.
     * @returns the summary text or the page element.
     */
    function RateLimiterCard(props) {
      const state = props.useRateLimiter((snapshot) => snapshot)
      if (props.view === 'summary') return renderSummary(state, props.t)
      return renderPage(state, props.t, props.actions)
    }

    // ── provider directory (optional remote service) ────────────────────────
    /** Read the configurable provider directory through the remote namespace. */
    async function loadProviderDirectory(remote) {
      const answer = await remote.llm.listConfigurableProviders()
      if (answer === null || typeof answer !== 'object' || answer.ok !== true) {
        const message = answer !== null && typeof answer === 'object' && answer.error !== undefined
          ? answer.error.message
          : 'provider directory unavailable'
        throw new Error(message)
      }
      return answer.value
    }

    // ── plugin entry ─────────────────────────────────────────────────────────
    /**
     * Mount the row's configuration card while the Host serves its namespace.
     * @param ctx - the browser plugin context (slots, locale, configForms).
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'rate-limiter: card locale')
      const controller = new RateLimiterCardController(ctx.configForms.get(ENTRY_ID))
      ctx.effect(() => () => { controller.dispose() }, 'rate-limiter: form subscription')
      // The provider directory is an optional convenience; the card allows a
      // typed provider id when the remote namespace is absent or failing.
      ctx.inject(['remote', 'remote.llm'], (remoteCtx) => {
        const remote = remoteCtx.remote
        controller.setCatalogSource(() => loadProviderDirectory(remote))
        const disposers = []
        if (typeof remote.$on === 'function') {
          disposers.push(remote.$on('llm/adapters-updated', () => { void controller.refreshCatalog() }))
        }
        if (typeof remoteCtx.on === 'function') {
          disposers.push(remoteCtx.on('connection/reset', () => { void controller.refreshCatalog() }))
        }
        return () => {
          for (const dispose of disposers) {
            if (typeof dispose === 'function') dispose()
          }
          controller.setCatalogSource(undefined)
        }
      })
      // Keyed row configuration: '<package name>#<row id>', live only while the
      // Host serves the entry, so an uncomposed or disabled row shows no card.
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
        locale: LOCALE_NS,
        inject: () => controller.inject(),
      }, RateLimiterCard))), 'rate-limiter: plugins row config')
    }

    module.exports = { apply, inject: ['slots', 'locale', 'configForms'] }
    return module.exports
  },
})
