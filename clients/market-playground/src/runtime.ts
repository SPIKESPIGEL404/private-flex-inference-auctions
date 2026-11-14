import { createFxTerminal, supportsJspi } from 'libfx/browser';
import type { FxTerminal, FxTerminalAdapter } from 'libfx/browser';
import { Bash, defineCommand } from 'just-bash/browser';
import { sessionStore } from './store';
import fxWasm from '../node_modules/libfx/fx-term.wasm?url';
import type { Buyer, BuyerStatus, Phase } from './model';
import { ApiError } from './wallet-api';

export interface RuntimeOptions { preview: boolean; ownerScope: string; walletStatus: () => unknown }

type Listener = (data: string | Uint8Array) => void;
export class BuyerRuntime {
  private runtime?: FxTerminal;
  private data = new Set<Listener>();
  private resizeListeners = new Set<() => void>();
  private disposed = false;
  private closed = false;
  private active = false;
  private generation = 0;
  private buyer: Buyer;
  readonly bash: Bash;
  constructor(buyer: Buyer, private state: (value: BuyerStatus) => void, private account: (micros: number, turns: number) => void,
    private options: RuntimeOptions) {
    this.buyer = buyer;
    this.bash = new Bash({
      cwd: '/workspace',
      files: {
        '/workspace/AGENTS.md': options.preview
          ? 'This is a scripted, offline UI preview. Use market status to inspect the preview buyer. Never imply a live bid or a verified execution. No network or provider credentials are available.'
          : 'You are an independent inference buyer. All model calls go through the hosted buyer gateway. Use market status for wallet setup state. Never claim a purchase succeeded without a gateway result. Local files cannot change owner spending rules or create funds.',
        '/workspace/task.txt': buyer.task,
        '/workspace/README.md': 'Private Market browser workspace. Files belong to this buyer only.\n',
      },
      customCommands: [defineCommand('market', async args => ({
        stdout: args[0] === 'status' ? JSON.stringify(options.preview
          ? { mode: 'scripted-preview', buyer: this.buyer.number, budget_micro_usd: this.buyer.budgetMicros, simulated_usage_micro_usd: this.buyer.previewMicros, live_orders: 0 }
          : { mode: 'wallet-setup', buyer: this.buyer.number, wallet: this.options.walletStatus(), procurement_ready: false }, null, 2) + '\n' : 'Commands: market status\n',
        stderr: '', exitCode: 0,
      }))],
    });
  }
  update(buyer: Buyer) { this.buyer = buyer; }
  async mount(output: (bytes: Uint8Array) => void, dimensions: () => { cols: number; rows: number }) {
    if (!supportsJspi()) throw new Error('This browser needs WebAssembly JSPI support. Try a current Chrome or Safari.');
    const owner = this;
    const adapter: FxTerminalAdapter = {
      get cols() { return dimensions().cols; }, get rows() { return dimensions().rows; },
      write: output,
      onData(fn) { owner.data.add(fn); return () => owner.data.delete(fn); },
      onResize(fn) { owner.resizeListeners.add(fn); return () => owner.resizeListeners.delete(fn); },
    };
    const store = sessionStore(this.storageId);
    let saved: Array<{ id: string; updatedAtMs: number }> = [];
    try { saved = await store.list(); } catch { /* fx will report persistence errors on commit. */ }
    if (this.disposed) return;
    const last = saved.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    const runtime = await createFxTerminal({
      wasm: fxWasm,
      terminal: adapter,
      env: { AI_GATEWAY_API_KEY: this.options.preview ? 'offline-preview-not-a-credential' : 'managed-transport-not-a-credential', FX_MODEL: 'openai/gpt-6-luna', FX_PERMISSION_MODE: 'auto', FX_MAX_AGENT_STEPS: '4', FX_AUTO_UPGRADE: '0', FX_SOUND: 'off' },
      args: last ? ['--resume', last.id] : [],
      fetch: this.options.preview ? this.previewFetch : this.liveFetch,
      sessionStore: store,
      promptHistoryStore: {
        load: (_root: string, limit: number) => this.readHistory().slice(-limit),
        append: (_root: string, value: string) => {
          if (new TextEncoder().encode(value).length > 64000) return 'record_too_large';
          const history = this.readHistory();
          if (history.at(-1) === value) return 'duplicate';
          localStorage.setItem(`private-market.history.${this.storageId}`, JSON.stringify([...history, value].slice(-50)));
        },
        clear: () => localStorage.removeItem(`private-market.history.${this.storageId}`),
      },
      workspace: {
        info: { version: 1, root: '/workspace', cwd: '/workspace', home: '/workspace', gitAvailable: false, ephemeral: true },
        permission: 'allow-sandboxed',
        exec: async ({ command, signal }: { command: string; signal: AbortSignal }) => this.bash.exec(command, { signal }),
        readFile: async ({ path }: { path: string }) => { try { return await this.bash.fs.readFile(path); } catch { return null; } },
      },
      onEvent: event => {
        if (event.type.endsWith('persist_error')) this.state({ phase: 'error', detail: 'Local session could not be saved.' });
        if (event.type === 'runtime.exit' && !this.disposed) {
          this.closed = true; this.active = false;
          this.state({ phase: 'error', detail: 'fx session closed. Reload the page to resume it.' });
        }
      },
    }).catch(error => { if (this.disposed) return undefined; throw error; });
    if (!runtime) return;
    if (this.disposed) {
      // Changing owners can park a terminal before its WASM harness becomes
      // interactive. Observe both promises before aborting so cancellation does
      // not become an unhandled rejection or an error in the new owner's pane.
      const stopped = Promise.allSettled([runtime.interactive, runtime.exited]);
      runtime.abort(); await stopped; return;
    }
    this.runtime = runtime;
    try { await runtime.interactive; }
    catch (error) { if (this.disposed) return; throw error; }
    if (!this.disposed) { this.state({ phase: 'ready' }); return true; }
  }
  input(data: string) { if (!this.disposed) for (const fn of this.data) fn(data); }
  resize() { for (const fn of this.resizeListeners) fn(); }
  start() {
    if (!this.runtime || this.active || this.disposed || this.closed) return;
    this.active = true; this.state({ phase: 'running' });
    // Clear an unfinished composer before inserting the configured task.
    this.runtime.write('\x15' + this.buyer.task.replace(/[\r\n]+/g, ' ') + '\r');
  }
  pause() {
    if (this.closed) return;
    const wasActive = this.active;
    this.generation++; this.active = false;
    if (wasActive) this.runtime?.write('\x03');
    this.state({ phase: 'paused' });
  }
  dispose() { this.disposed = true; this.generation++; this.runtime?.abort(); this.data.clear(); this.resizeListeners.clear(); }
  private get storageId() { return this.options.preview ? this.buyer.id : `${this.options.ownerScope}:${this.buyer.id}`; }
  private readHistory(): string[] {
    const raw = JSON.parse(localStorage.getItem(`private-market.history.${this.storageId}`) ?? '[]');
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string').slice(-50) : [];
  }
  private liveFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    if (this.disposed) throw new DOMException('Closed', 'AbortError');
    this.active = true;
    this.state({ phase: 'running' });
    try {
      if (this.options.ownerScope === 'disconnected') throw new ApiError('login_required');
      if (init.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') throw new ApiError('unsupported_model_request');
      const response = await fetch('/buyer-api/inference', { method: 'POST', credentials: 'same-origin', redirect: 'error',
        signal: init.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          ownerScope: this.options.ownerScope, buyerId: this.buyer.id, requestId: crypto.randomUUID(), gatewayRequest: JSON.parse(init.body),
        }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new ApiError(typeof error.error === 'string' ? error.error : 'procurement_unavailable');
      }
      // A future live implementation must attach its order/settlement evidence.
      // Do not count the scripted preview's fixed 120 microUSD as real spending.
      return response;
    } catch (error) {
      this.active = false;
      this.state({ phase: 'error', detail: error instanceof Error ? error.message : 'Inference procurement unavailable.' });
      throw error;
    }
  };
  private previewFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    // Deliberately no global fetch here: neither user input nor a fake credential leaves the browser.
    if (this.disposed) throw new DOMException('Closed', 'AbortError');
    const generation = ++this.generation;
    this.active = true;
    this.state({ phase: 'running' });
    let finalPhase: Phase = this.buyer.scenario === 'waiting' ? 'waiting' : 'complete';
    if (this.buyer.scenario === 'limit' || this.buyer.previewMicros + 120 > this.buyer.budgetMicros) finalPhase = 'paused';
    const texts = finalPhase === 'waiting' ? ['[preview] ', 'Waiting for an eligible offer.']
      : finalPhase === 'paused' ? ['[preview] ', 'Budget limit reached. ', 'Paused.']
      : ['[preview] ', 'Completed this turn.'];
    const encoder = new TextEncoder();
    const signal = init.signal;
    const events = texts.map(delta => ({ type: 'text-delta', id: 'preview', delta }));
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        await new Promise(r => setTimeout(r, 210));
        if (this.disposed || generation !== this.generation || signal?.aborted) {
          if (generation === this.generation) this.active = false;
          controller.error(new DOMException('Paused', 'AbortError')); return;
        }
        if (index < events.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        else {
          controller.enqueue(encoder.encode('data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":0},"outputTokens":{"total":0}}}\n\ndata: [DONE]\n\n'));
          controller.close(); this.active = false;
          const amount = finalPhase === 'complete' ? Math.min(this.buyer.budgetMicros, this.buyer.previewMicros + 120) : this.buyer.previewMicros;
          this.account(amount, this.buyer.turns + 1);
          this.state({ phase: finalPhase });
        }
      },
      cancel: () => { if (generation === this.generation) this.active = false; },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
}
