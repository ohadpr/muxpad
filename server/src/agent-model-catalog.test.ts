import { describe, expect, it } from 'vitest';
import { readModelCatalog, recordModelCatalog } from './agent-model-catalog.js';
import { openDb } from './store/db.js';
import { GlobalsStore } from './store/GlobalsStore.js';

describe('agent model catalog', () => {
  const db = () => openDb(':memory:');

  it('remembers what a backend reported, per backend', () => {
    const d = db();
    recordModelCatalog(d, 'claude', [{ value: 'opus', displayName: 'Opus' }]);
    recordModelCatalog(d, 'codex', [{ value: 'gpt-5-codex', displayName: 'GPT-5 Codex' }]);
    expect(readModelCatalog(d)).toEqual({
      claude: [{ value: 'opus', displayName: 'Opus' }],
      codex: [{ value: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
    });
  });

  it('keeps resolvedModel when the runner sends one', () => {
    const d = db();
    recordModelCatalog(d, 'claude', [
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-8' },
    ]);
    expect(readModelCatalog(d).claude?.[0]?.resolvedModel).toBe('claude-opus-4-8');
  });

  it('an EMPTY list does not erase what we knew', () => {
    // A failed supportedModels() reports []. Forgetting the real list because
    // one fetch failed would empty the launch picker for no reason.
    const d = db();
    recordModelCatalog(d, 'claude', [{ value: 'opus', displayName: 'Opus' }]);
    recordModelCatalog(d, 'claude', []);
    recordModelCatalog(d, 'claude', undefined);
    expect(readModelCatalog(d).claude).toHaveLength(1);
  });

  it('drops entries that are not model shapes, and never throws on junk', () => {
    const d = db();
    recordModelCatalog(d, 'cursor', [
      null,
      { displayName: 'no value' },
      { value: 'sonnet-4-5' },
      'nope',
    ]);
    // A value with no displayName falls back to the value — never blank.
    expect(readModelCatalog(d).cursor).toEqual([
      { value: 'sonnet-4-5', displayName: 'sonnet-4-5' },
    ]);
  });

  it('caps a runaway list', () => {
    const d = db();
    recordModelCatalog(
      d,
      'claude',
      Array.from({ length: 200 }, (_, i) => ({ value: `m${i}`, displayName: `M${i}` })),
    );
    expect(readModelCatalog(d).claude).toHaveLength(32);
  });

  it('a corrupt row reads as "we know nothing" rather than throwing', () => {
    const d = db();
    new GlobalsStore(d).set('agent_model_catalog', '{not json');
    expect(readModelCatalog(d)).toEqual({});
    // …and the next real report repairs it.
    recordModelCatalog(d, 'claude', [{ value: 'opus', displayName: 'Opus' }]);
    expect(readModelCatalog(d).claude).toHaveLength(1);
  });
});
