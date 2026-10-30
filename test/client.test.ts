import { readFileSync } from "node:fs";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { describe, expect, it, vi } from "vitest";

/**
 * lib/client.js is a hand-written browser bundle (no build step): it registers a
 * CJS factory with window.__ModuleLoader__, and the host client module table
 * answers the factory's require calls. These tests rebuild that contract in
 * Node - a stub registration port, a stub module table, and a fake ConfigForm -
 * and exercise the card controller's pure logic: draft staging, validation,
 * path-op generation, status/writable handling, refusal recovery, and the
 * optional provider directory. React rendering is not exercised beyond the
 * view branch the slot owner asks for.
 */
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

interface ClientPluginExports {
  apply: (ctx: unknown) => void;
  inject: string[];
}

interface Registration {
  id: string;
  factory: (require: (spec: string) => unknown) => ClientPluginExports;
}

interface DraftProvider {
  name: string;
  rate: number | undefined;
  burst: number | undefined;
}

interface Draft {
  enabled: boolean;
  providers: DraftProvider[];
}

interface CardSnapshot {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  revision: number | undefined;
  seed: Draft;
  draft: Draft;
  dirty: boolean;
  invalid: string | null;
  catalog: {
    status: "unavailable" | "loading" | "ready";
    providers: Array<{ provider: string; displayName: string }>;
  };
  pendingProvider: string;
  saveState: {
    kind: "idle" | "saving" | "saved" | "error";
    errorKey?: string;
    message?: string;
    validation?: boolean;
  };
}

interface CardActions {
  setEnabled: (enabled: boolean) => void;
  setPendingProvider: (value: string) => void;
  addProvider: (name?: string) => boolean;
  removeProvider: (name: string) => void;
  setRate: (name: string, value: unknown) => void;
  setBurst: (name: string, value: unknown) => void;
  discard: () => void;
  save: () => Promise<boolean>;
  refreshCatalog: () => Promise<void>;
}

interface InjectFace {
  hooks: {
    rateLimiter: {
      getSnapshot: () => CardSnapshot;
      subscribe: (listener: () => void) => () => void;
    };
  };
  actions: CardActions;
}

interface SlotRegistrationRecord {
  definition: Record<string, unknown>;
  component: (props: unknown) => unknown;
}

interface FormSnapshot {
  status: "loading" | "ready" | "unavailable";
  value?: unknown;
  base?: unknown;
  user?: unknown;
  revision?: number;
  writable: boolean;
}

interface FormStub {
  form: {
    getSnapshot: () => FormSnapshot;
    subscribe: (listener: () => void) => () => void;
    mutate: (ops: unknown[], revision?: number) => Promise<boolean>;
  };
  mutateCalls: Array<{ ops: Array<Record<string, unknown>>; revision: number | undefined }>;
  setSnapshot: (next: FormSnapshot) => void;
  setMutateResult: (fn: (ops: unknown[], revision?: number) => Promise<boolean>) => void;
  listenerCount: () => number;
}

/** Run the client bundle and capture the factory it registers. */
function loadRegistration(): Registration {
  let registration: Registration | undefined;
  const windowStub = {
    __ModuleLoader__: {
      load: (value: Registration) => {
        registration = value;
      },
    },
  };
  // Function construction injects window without polluting the test process.
  const run = new Function("window", clientSource) as (window: unknown) => void;
  run(windowStub);
  if (registration === undefined) throw new Error("client bundle did not register");
  return registration;
}

/** Minimal React face: the card only calls createElement. */
const reactStub = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
};

/** Host require replica: answers from the module table, misses throw like the client module system. */
function createRequire(table: Record<string, unknown>) {
  const calls: string[] = [];
  const require = (spec: string) => {
    calls.push(spec);
    if (Object.hasOwn(table, spec)) return table[spec];
    throw new Error("client-modules: require(" + JSON.stringify(spec) + ") missed the module table");
  };
  return { require, calls };
}

/** Ready form snapshot holding a section value. */
function readySection(value: unknown, overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return { status: "ready", value, base: undefined, user: undefined, revision: 7, writable: true, ...overrides };
}

/** ConfigForm stub: one snapshot, its listeners, and a scripted mutate answer. */
function createFormStub(initial: Partial<FormSnapshot> = {}): FormStub {
  let snapshot: FormSnapshot = {
    status: "loading",
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const mutateCalls: FormStub["mutateCalls"] = [];
  let mutateResult: (ops: unknown[], revision?: number) => Promise<boolean> = async () => true;
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mutate: (ops: unknown[], revision?: number) => {
      mutateCalls.push({ ops: ops as Array<Record<string, unknown>>, revision });
      return mutateResult(ops, revision);
    },
  };
  return {
    form,
    mutateCalls,
    setSnapshot: (next: FormSnapshot) => {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    setMutateResult: (fn) => {
      mutateResult = fn;
    },
    listenerCount: () => listeners.size,
  };
}

interface RemoteStub {
  $on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  llm: { listConfigurableProviders: ReturnType<typeof vi.fn> };
}

/** Remote namespace stub: the provider directory and its invalidation event. */
function createRemoteStub(options: { providers?: unknown[]; rejection?: string } = {}): RemoteStub {
  const off = vi.fn();
  return {
    $on: vi.fn(() => off),
    off,
    llm: {
      listConfigurableProviders: vi.fn(async () => {
        if (options.rejection !== undefined) throw new Error(options.rejection);
        return { ok: true, value: options.providers ?? [] };
      }),
    },
  };
}

interface CtxStubOptions {
  form?: FormStub;
  remote?: RemoteStub;
}

/** ctx stub covering exactly the surfaces client.js touches. */
function createCtxStub(options: CtxStubOptions = {}) {
  const form = options.form ?? createFormStub();
  const registered: SlotRegistrationRecord[] = [];
  const whileServedCalls: string[][] = [];
  const localeRegistrations: Array<{ ns: string; dicts: Record<string, Record<string, string>> }> = [];
  const formRequests: string[] = [];
  const injectCalls: string[][] = [];
  const injectCleanups: Array<() => void> = [];
  const effects: Array<{ label: string | undefined; dispose: unknown }> = [];
  const ctx = {
    effect: (fn: () => unknown, label?: string) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return typeof dispose === "function" ? dispose : () => undefined;
    },
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => {
        localeRegistrations.push({ ns, dicts });
        return () => undefined;
      },
      bind: () => (key: string) => key,
    },
    configForms: {
      get: (id: string) => {
        formRequests.push(id);
        return form.form;
      },
      whileServed: (namespaces: string[], register: (served: ReadonlySet<string>) => () => void) => {
        whileServedCalls.push(namespaces);
        return register(new Set(namespaces));
      },
    },
    inject: (deps: string[], callback: (rctx: unknown) => unknown) => {
      injectCalls.push(deps);
      if (options.remote === undefined) return () => undefined;
      const dispose = callback({ remote: options.remote, on: () => () => undefined });
      const cleanup = typeof dispose === "function" ? (dispose as () => void) : () => undefined;
      injectCleanups.push(cleanup);
      return cleanup;
    },
    slots: {
      inject: (_name: string, produce: () => unknown) => produce(),
      register: (definition: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registered.push({ definition, component });
        return () => undefined;
      },
    },
  };
  return { ctx, form, registered, whileServedCalls, localeRegistrations, formRequests, injectCalls, injectCleanups, effects };
}

interface MountedCard {
  exports: ClientPluginExports;
  registered: SlotRegistrationRecord[];
  record: SlotRegistrationRecord;
  face: InjectFace;
  form: FormStub;
  state: () => CardSnapshot;
  whileServedCalls: string[][];
  localeRegistrations: Array<{ ns: string; dicts: Record<string, Record<string, string>> }>;
  formRequests: string[];
  injectCalls: string[][];
  injectCleanups: Array<() => void>;
  effects: Array<{ label: string | undefined; dispose: unknown }>;
}

/** Load, apply, and take the card's inject face. */
function mount(options: CtxStubOptions = {}): MountedCard {
  const stub = createCtxStub(options);
  const { require } = createRequire({
    react: reactStub,
    "@deepseek-ai/dsh-client-store": { createSnapshotStore },
  });
  const exports = loadRegistration().factory(require);
  exports.apply(stub.ctx);
  const record = stub.registered[0];
  if (record === undefined) throw new Error("card did not register into plugins.row.config");
  const face = (record.definition.inject as () => InjectFace)();
  return { ...stub, exports, record, face, state: () => face.hooks.rateLimiter.getSnapshot() };
}

describe("client bundle 契约", () => {
  it("注册模块工厂、row config 卡与 zh/en 字典", () => {
    const table: Record<string, unknown> = {
      react: reactStub,
      "@deepseek-ai/dsh-client-store": { createSnapshotStore },
    };
    const { require, calls } = createRequire(table);
    const registration = loadRegistration();
    expect(registration.id).toBe("@xidong-ai/dsh-rate-limiter");
    const exports = registration.factory(require);
    expect(exports.inject).toEqual(["slots", "locale", "configForms"]);
    expect(calls).toContain("react");
    expect(calls).toContain("@deepseek-ai/dsh-client-store");
    expect(calls).not.toContain("@deepseek-ai/dsh-client-runtime/client");

    const mounted = mount();
    expect(mounted.formRequests).toEqual(["rate-limiter"]);
    expect(mounted.whileServedCalls).toEqual([["rate-limiter"]]);
    expect(mounted.record.definition.name).toBe("plugins.row.config");
    expect(mounted.record.definition.key).toBe("@xidong-ai/dsh-rate-limiter#rate-limiter");
    expect(mounted.record.definition.locale).toBe("settings.rate-limiter");
    expect(typeof mounted.face.hooks.rateLimiter.getSnapshot).toBe("function");
    expect(typeof mounted.face.hooks.rateLimiter.subscribe).toBe("function");
    expect(typeof mounted.face.actions.save).toBe("function");
    expect(typeof mounted.face.actions.setRate).toBe("function");

    const locales = mounted.localeRegistrations[0];
    expect(locales?.ns).toBe("settings.rate-limiter");
    const zh = locales?.dicts.zh ?? {};
    const en = locales?.dicts.en ?? {};
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(zh.summaryOn).toContain("{count}");
    expect(en.summaryOff).toContain("{count}");
  });
});

describe("controller：表单快照与草稿", () => {
  it("从 ready 快照 seed 出 enabled 与 providers 列表", () => {
    const form = createFormStub(readySection({ enabled: false, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    const state = card.state();
    expect(state.status).toBe("ready");
    expect(state.writable).toBe(true);
    expect(state.revision).toBe(7);
    expect(state.seed).toEqual({ enabled: false, providers: [{ name: "alpha", rate: 2, burst: 3 }] });
    expect(state.draft).toEqual(state.seed);
    expect(state.dirty).toBe(false);
    expect(state.invalid).toBeNull();
  });

  it("跟随 loading / ready / unavailable 转换并保留草稿", () => {
    const form = createFormStub();
    const card = mount({ form });
    expect(card.state().status).toBe("loading");
    form.setSnapshot(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    expect(card.state().status).toBe("ready");
    card.face.actions.setRate("alpha", 4);
    expect(card.state().dirty).toBe(true);
    // 未保存的外部变化：草稿保留，seed 更新。
    form.setSnapshot(readySection({ enabled: true, providers: { alpha: { rate: 9, burst: 3 } } }, { revision: 9 }));
    expect(card.state().seed.providers[0]?.rate).toBe(9);
    expect(card.state().draft.providers[0]?.rate).toBe(4);
    expect(card.state().dirty).toBe(true);
    expect(card.state().revision).toBe(9);
    form.setSnapshot({ status: "unavailable", writable: false });
    expect(card.state().status).toBe("unavailable");
    expect(card.state().seed.providers[0]?.rate).toBe(9);
    form.setSnapshot(readySection({ enabled: false, providers: { gamma: { rate: 2, burst: 2 } } }));
    expect(card.state().status).toBe("ready");
    expect(card.state().seed).toEqual({ enabled: false, providers: [{ name: "gamma", rate: 2, burst: 2 }] });
    // 刷新不覆盖编辑中的草稿，只把它与新 seed 的差异记为 dirty。
    expect(card.state().draft).toEqual({ enabled: true, providers: [{ name: "alpha", rate: 4, burst: 3 }] });
    expect(card.state().dirty).toBe(true);
    card.face.actions.discard();
    expect(card.state().draft).toEqual(card.state().seed);
    expect(card.state().dirty).toBe(false);
  });

  it("编辑 enabled、速率、突发容量与供应商增删", () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    const { actions } = card.face;
    actions.setEnabled(false);
    expect(card.state().draft.enabled).toBe(false);
    expect(card.state().dirty).toBe(true);
    actions.setRate("alpha", 4);
    expect(card.state().draft.providers[0]?.rate).toBe(4);
    actions.setBurst("alpha", "6");
    expect(card.state().draft.providers[0]?.burst).toBe(6);
    expect(actions.addProvider("beta")).toBe(true);
    expect(card.state().draft.providers.map((provider) => provider.name)).toEqual(["alpha", "beta"]);
    expect(card.state().draft.providers[1]).toEqual({ name: "beta", rate: 1, burst: 5 });
    expect(card.state().pendingProvider).toBe("");
    expect(actions.addProvider("beta")).toBe(false);
    expect(actions.addProvider("")).toBe(false);
    actions.removeProvider("alpha");
    expect(card.state().draft.providers.map((provider) => provider.name)).toEqual(["beta"]);
    actions.discard();
    expect(card.state().draft).toEqual(card.state().seed);
    expect(card.state().dirty).toBe(false);
  });

  it("使用 pendingProvider 添加手动输入的供应商", () => {
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form });
    card.face.actions.setPendingProvider("  sensenova  ");
    expect(card.face.actions.addProvider()).toBe(true);
    expect(card.state().draft.providers[0]).toEqual({ name: "sensenova", rate: 1, burst: 5 });
  });
});

describe("controller：校验", () => {
  it("非法速率/突发容量在写之前被拦截", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    card.face.actions.setRate("alpha", 0);
    expect(card.state().invalid).toBe("invalidRate");
    expect(await card.face.actions.save()).toBe(false);
    expect(form.mutateCalls).toHaveLength(0);
    expect(card.state().saveState).toMatchObject({ kind: "error", errorKey: "invalidRate", validation: true });
    card.face.actions.setRate("alpha", "");
    expect(card.state().invalid).toBe("invalidRate");
    card.face.actions.setRate("alpha", 2);
    card.face.actions.setBurst("alpha", 1.5);
    expect(card.state().invalid).toBe("invalidBurst");
    expect(await card.face.actions.save()).toBe(false);
    expect(form.mutateCalls).toHaveLength(0);
  });

  it("速率下限对齐宿主 schema 的 0.001", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 1, burst: 1 } } }));
    const card = mount({ form });
    card.face.actions.setRate("alpha", 0.0005);
    expect(card.state().invalid).toBe("invalidRate");
    card.face.actions.setRate("alpha", 0.001);
    expect(card.state().invalid).toBeNull();
  });
});

describe("controller：path ops 与保存", () => {
  it("把草稿差异转成 set/unset ops 并用读取时的 revision 围栏", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    const { actions } = card.face;
    actions.setEnabled(false);
    actions.setRate("alpha", 4);
    actions.addProvider("beta");
    form.setMutateResult(async () => {
      form.setSnapshot(readySection({
        enabled: false,
        providers: { alpha: { rate: 4, burst: 3 }, beta: { rate: 1, burst: 5 } },
      }, { revision: 8 }));
      return true;
    });
    expect(await actions.save()).toBe(true);
    expect(form.mutateCalls).toHaveLength(1);
    expect(form.mutateCalls[0]?.revision).toBe(7);
    expect(form.mutateCalls[0]?.ops).toEqual([
      { op: "set", path: ["enabled"], value: false },
      { op: "set", path: ["providers", "alpha", "rate"], value: 4 },
      { op: "set", path: ["providers", "beta", "rate"], value: 1 },
      { op: "set", path: ["providers", "beta", "burst"], value: 5 },
    ]);
    const state = card.state();
    expect(state.saveState).toEqual({ kind: "saved" });
    expect(state.dirty).toBe(false);
    expect(state.revision).toBe(8);
    expect(state.seed).toEqual({
      enabled: false,
      providers: [{ name: "alpha", rate: 4, burst: 3 }, { name: "beta", rate: 1, burst: 5 }],
    });
    expect(state.draft).toEqual(state.seed);
  });

  it("移除供应商生成 unset providers.<name>", async () => {
    const form = createFormStub(readySection({
      enabled: true,
      providers: { alpha: { rate: 2, burst: 3 }, gamma: { rate: 1, burst: 1 } },
    }));
    const card = mount({ form });
    card.face.actions.removeProvider("alpha");
    form.setMutateResult(async () => {
      form.setSnapshot(readySection({ enabled: true, providers: { gamma: { rate: 1, burst: 1 } } }, { revision: 8 }));
      return true;
    });
    expect(await card.face.actions.save()).toBe(true);
    expect(form.mutateCalls[0]?.ops).toEqual([{ op: "unset", path: ["providers", "alpha"] }]);
  });

  it("没有变化时直接报已保存且不写", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form });
    expect(await card.face.actions.save()).toBe(true);
    expect(form.mutateCalls).toHaveLength(0);
    expect(card.state().saveState).toEqual({ kind: "saved" });
  });

  it("只读部署拒绝保存且不写", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }, { writable: false }));
    const card = mount({ form });
    card.face.actions.setRate("alpha", 4);
    expect(await card.face.actions.save()).toBe(false);
    expect(form.mutateCalls).toHaveLength(0);
    expect(card.state().saveState).toEqual({ kind: "error", errorKey: "saveReadOnly" });
  });

  it("写入被拒（revision 冲突）后重新读取并以最新 revision 重试", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    card.face.actions.setRate("alpha", 4);
    form.setMutateResult(async () => {
      // 模拟宿主已前移：拒绝 + mirror 重读后的最新视图。
      form.setSnapshot(readySection({ enabled: true, providers: { alpha: { rate: 9, burst: 3 } } }, { revision: 9 }));
      return false;
    });
    expect(await card.face.actions.save()).toBe(false);
    let state = card.state();
    expect(state.saveState).toEqual({ kind: "error", errorKey: "saveConflict" });
    expect(state.revision).toBe(9);
    expect(state.seed.providers[0]?.rate).toBe(9);
    expect(state.draft.providers[0]?.rate).toBe(4);
    expect(state.dirty).toBe(true);
    // 再次编辑后保存：围栏换成本次读取的 revision。
    card.face.actions.setRate("alpha", 5);
    form.setMutateResult(async () => {
      form.setSnapshot(readySection({ enabled: true, providers: { alpha: { rate: 5, burst: 3 } } }, { revision: 10 }));
      return true;
    });
    expect(await card.face.actions.save()).toBe(true);
    expect(form.mutateCalls).toHaveLength(2);
    expect(form.mutateCalls[1]?.revision).toBe(9);
    expect(form.mutateCalls[1]?.ops).toEqual([{ op: "set", path: ["providers", "alpha", "rate"], value: 5 }]);
  });

  it("传输错误落到 saveFailed 并保留消息", async () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    card.face.actions.setRate("alpha", 4);
    form.setMutateResult(async () => {
      throw new Error("network down");
    });
    expect(await card.face.actions.save()).toBe(false);
    expect(card.state().saveState).toEqual({ kind: "error", errorKey: "saveFailed", message: "network down" });
    expect(card.state().dirty).toBe(true);
  });
});

describe("controller：可选供应商目录", () => {
  it("remote.llm 目录可用时提供选择项并支持添加", async () => {
    const remote = createRemoteStub({
      providers: [
        { provider: "alpha", displayName: "Alpha", settingsNs: "llm-alpha", settingsPath: [] },
        { provider: "beta", displayName: "", settingsNs: "llm-beta", settingsPath: [] },
        { provider: "alpha", displayName: "Duplicate", settingsNs: "llm-alpha", settingsPath: [] },
      ],
    });
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form, remote });
    await card.face.actions.refreshCatalog();
    expect(card.state().catalog).toEqual({
      status: "ready",
      providers: [{ provider: "alpha", displayName: "Alpha" }, { provider: "beta", displayName: "beta" }],
    });
    expect(remote.$on).toHaveBeenCalledWith("llm/adapters-updated", expect.any(Function));
    card.face.actions.setPendingProvider("alpha");
    expect(card.face.actions.addProvider()).toBe(true);
    expect(card.state().draft.providers[0]).toEqual({ name: "alpha", rate: 1, burst: 5 });
  });

  it("目录读取失败时降级为手动输入", async () => {
    const remote = createRemoteStub({ rejection: "directory down" });
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form, remote });
    await card.face.actions.refreshCatalog();
    expect(card.state().catalog).toEqual({ status: "unavailable", providers: [] });
    card.face.actions.setPendingProvider("manual-provider");
    expect(card.face.actions.addProvider()).toBe(true);
    expect(card.state().draft.providers[0]?.name).toBe("manual-provider");
  });

  it("没有 remote 命名空间时保持手动输入", () => {
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form });
    expect(card.state().catalog).toEqual({ status: "unavailable", providers: [] });
    expect(card.face.actions.addProvider("legacy-provider")).toBe(true);
  });
});

describe("card 组件：view 分支", () => {
  it("summary 渲染一行摘要，page 渲染带保存控件的表单", () => {
    const form = createFormStub(readySection({ enabled: true, providers: { alpha: { rate: 2, burst: 3 } } }));
    const card = mount({ form });
    const state = card.state();
    const t = (key: string, params?: { count?: number }) => params?.count === undefined
      ? key
      : key + ":" + String(params.count);
    const render = (view: "summary" | "page") => card.record.component({
      view,
      t,
      actions: card.face.actions,
      useRateLimiter: (selector: (snapshot: CardSnapshot) => unknown) => selector(state),
    });
    expect(render("summary")).toBe("summaryOn:1");
    const page = render("page") as { type: string; props: Record<string, unknown> };
    expect(page.type).toBe("div");
    expect(page.props["data-rate-limiter-config"]).toBe("");
  });

  it("loading / unavailable 不渲染编辑控件", () => {
    const loading = mount();
    const t = (key: string) => key;
    const renderWith = (card: MountedCard) => {
      const state = card.state();
      return card.record.component({
        view: "page",
        t,
        actions: card.face.actions,
        useRateLimiter: (selector: (snapshot: CardSnapshot) => unknown) => selector(state),
      }) as { props: Record<string, unknown> };
    };
    expect(renderWith(loading).props["data-rate-limiter-config"]).toBeUndefined();
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form });
    form.setSnapshot({ status: "unavailable", writable: false });
    expect(renderWith(card).props["data-rate-limiter-config"]).toBeUndefined();
  });
});

describe("生命周期", () => {
  it("dispose 释放表单订阅", () => {
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form });
    expect(form.listenerCount()).toBe(1);
    const subscription = card.effects.find((effect) => effect.label === "rate-limiter: form subscription");
    expect(subscription).toBeDefined();
    (subscription?.dispose as () => void)();
    expect(form.listenerCount()).toBe(0);
    form.setSnapshot(readySection({ enabled: false, providers: { late: { rate: 1, burst: 1 } } }));
    expect(card.state().seed).toEqual({ enabled: true, providers: [] });
  });

  it("remote 命名空间消失时解除目录源与事件订阅", async () => {
    const remote = createRemoteStub({ providers: [{ provider: "alpha", displayName: "Alpha" }] });
    const form = createFormStub(readySection({ enabled: true, providers: {} }));
    const card = mount({ form, remote });
    await card.face.actions.refreshCatalog();
    expect(card.state().catalog.status).toBe("ready");
    expect(remote.$on).toHaveBeenCalledWith("llm/adapters-updated", expect.any(Function));
    const cleanup = card.injectCleanups[0];
    expect(cleanup).toBeDefined();
    cleanup?.();
    expect(remote.off).toHaveBeenCalledTimes(1);
    await card.face.actions.refreshCatalog();
    expect(card.state().catalog).toEqual({ status: "unavailable", providers: [] });
  });
});
