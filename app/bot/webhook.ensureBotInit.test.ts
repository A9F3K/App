import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';

test('ensureBotInit resets after init failure (no stuck rejected promise)', async (t) => {
  const originalInit = Bot.prototype.init;
  const originalHandleUpdate = Bot.prototype.handleUpdate;

  let initCalls = 0;
  let handleUpdateCalls = 0;

  Bot.prototype.init = async function initMock(): Promise<void> {
    initCalls += 1;
    if (initCalls === 1) throw new Error('init failed (simulated)');
  };

  Bot.prototype.handleUpdate = async function handleUpdateMock(): Promise<void> {
    handleUpdateCalls += 1;
  };

  t.after(() => {
    Bot.prototype.init = originalInit;
    Bot.prototype.handleUpdate = originalHandleUpdate;
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  process.env.BOT_TOKEN = 'test-token';

  // Import after env + prototype mocks so the module creates a bot using the patched methods.
  const mod = await import('./webhook.ts');
  const handler = mod.default as (
    req: { method: string; body?: unknown },
    res: {
      setHeader(name: string, value: string): void;
      status(code: number): { json(data: unknown): void; end(): void };
      end(): void;
    },
  ) => Promise<void>;

  function createRes() {
    let statusCode: number | null = null;
    let jsonBody: unknown = undefined;
    return {
      get statusCode() {
        return statusCode;
      },
      get jsonBody() {
        return jsonBody;
      },
      res: {
        setHeader() {},
        status(code: number) {
          statusCode = code;
          return {
            json(data: unknown) {
              jsonBody = data;
            },
            end() {},
          };
        },
        end() {},
      },
    };
  }

  const update = JSON.stringify({
    update_id: 1,
    message: { chat: { id: 123 }, text: 'hi' },
  });

  const first = createRes();
  await handler({ method: 'POST', body: update }, first.res);
  assert.equal(first.statusCode, 500);

  const second = createRes();
  await handler({ method: 'POST', body: update }, second.res);
  assert.equal(second.statusCode, 200);

  assert.equal(initCalls, 2);
  assert.equal(handleUpdateCalls, 1);
});

