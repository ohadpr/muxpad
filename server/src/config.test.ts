import { describe, expect, it } from 'vitest';
import { loadVoiceSettings, voiceApiKey } from './config.js';

// Env is passed explicitly — nothing here reads or mutates process.env, and
// nothing here runs loadConfig() (which touches the real home directory).

describe('voiceApiKey', () => {
  it('prefers MUXPAD_OPENAI_API_KEY so a separate capped project key can be used', () => {
    expect(voiceApiKey({ MUXPAD_OPENAI_API_KEY: 'sk-muxpad', OPENAI_API_KEY: 'sk-other' })).toBe(
      'sk-muxpad',
    );
  });

  it('falls back to OPENAI_API_KEY', () => {
    expect(voiceApiKey({ OPENAI_API_KEY: 'sk-other' })).toBe('sk-other');
  });

  it('is undefined when neither is set, or when the value is blank', () => {
    expect(voiceApiKey({})).toBeUndefined();
    expect(voiceApiKey({ MUXPAD_OPENAI_API_KEY: '   ' })).toBeUndefined();
    // A blank override must not mask a real fallback key.
    expect(voiceApiKey({ MUXPAD_OPENAI_API_KEY: '', OPENAI_API_KEY: 'sk-real' })).toBe('sk-real');
  });
});

describe('loadVoiceSettings', () => {
  it('defaults to marin, a 10-minute session limit and a 60-minute daily cap', () => {
    expect(loadVoiceSettings({})).toEqual({
      voice: 'marin',
      sessionTtlMs: 10 * 60_000,
      dailyCapMinutes: 60,
    });
  });

  it('reads the MUXPAD_VOICE_* overrides', () => {
    expect(
      loadVoiceSettings({
        MUXPAD_VOICE_NAME: 'cedar',
        MUXPAD_VOICE_SESSION_MINUTES: '3',
        MUXPAD_VOICE_DAILY_MINUTES: '15',
      }),
    ).toEqual({ voice: 'cedar', sessionTtlMs: 180_000, dailyCapMinutes: 15 });
  });

  it('ignores junk and zero rather than silently removing a cost ceiling', () => {
    // The failure this prevents: `MUXPAD_VOICE_DAILY_MINUTES=` or a typo
    // parsing to NaN/0 and being read as "no limit".
    for (const bad of ['', 'lots', '0', '-5', 'NaN']) {
      const s = loadVoiceSettings({
        MUXPAD_VOICE_DAILY_MINUTES: bad,
        MUXPAD_VOICE_SESSION_MINUTES: bad,
      });
      expect(s.dailyCapMinutes).toBe(60);
      expect(s.sessionTtlMs).toBe(10 * 60_000);
    }
  });
});
