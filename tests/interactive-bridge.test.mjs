import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';

const { registerInteractiveBridge } = await loadTypeScript('../src/interactive-bridge.ts');

test('chat shows activity before text, and clears previous assistant/retry previews', async () => {
  const handlers = new Map();
  const entries = [];
  let renderer;
  let emit;
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const worker = {
    id: 'test',
    prompt: () => result,
    onEvent: listener => { emit = listener; return () => {}; },
  };
  const pi = {
    getThinkingLevel: () => 'off',
    on: (name, handler) => handlers.set(name, handler),
    registerEntryRenderer: (_type, render) => { renderer = render; },
    appendEntry: (_type, entry) => entries.push(entry),
  };
  const ui = { setStatus() {}, notify() {} };
  registerInteractiveBridge(pi, { routed: () => worker });
  const pending = handlers.get('input')({ source: 'interactive', text: 'hello' }, { ui });
  const stream = entries.find(entry => entry.role === 'stream');
  const theme = { fg: (_name, text) => text, bg: (_name, text) => text };
  const component = renderer({ data: stream }, {}, theme);
  assert.match(component.render(80).join('\n'), /thinking/);
  emit({ type: 'tool_execution_start', toolName: 'read' });
  assert.match(component.render(80).join('\n'), /running read/);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'working it out' } });
  assert.match(component.render(80).join('\n'), /working it out/);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'old attempt' } });
  emit({ type: 'auto_retry_start' });
  const retry = component.render(80).join('\n');
  assert.match(retry, /retrying/);
  assert.doesNotMatch(retry, /old attempt/);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'intermediate turn' } });
  emit({ type: 'message_start', message: { role: 'assistant' } });
  assert.doesNotMatch(component.render(80).join('\n'), /intermediate turn/);
  finish({ state: { model: null }, lastAssistantText: 'done' });
  await pending;
  assert.deepEqual(component.render(80), []);
});
