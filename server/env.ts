/**
 * Environment loading for every entry point (import this first, instead of `dotenv/config`).
 *
 * 1. This repo's `.env`.
 * 2. The shared LLM keys file, `~/.config/asitminz/llm.env` (`LLM_SHARED_ENV` names another path; `off` skips it),
 *    which ContentPipe and JobPipe both read so a provider key is set once. It also carries `LLM_CATALOG`.
 *
 * dotenv never overrides a variable that is already set, even to the empty string, so the order is the precedence:
 * the shell, then `.env`, then the shared file. A project can still pin its own value for any key.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const SHARED_ENV_PATH = (() => {
  const v = process.env.LLM_SHARED_ENV?.trim();
  if (v === 'off') return undefined;
  return v || path.join(os.homedir(), '.config', 'asitminz', 'llm.env');
})();

if (SHARED_ENV_PATH && fs.existsSync(SHARED_ENV_PATH)) dotenv.config({ path: SHARED_ENV_PATH, quiet: true });
