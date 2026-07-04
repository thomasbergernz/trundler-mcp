import { homedir } from 'os';
import { join } from 'path';

/**
 * Root directory where trundler keeps per-provider credentials and session state.
 * - Windows: %LOCALAPPDATA%\trundler
 * - macOS/Linux: $XDG_CONFIG_HOME/trundler  (falls back to ~/.config/trundler)
 *
 * Nothing sensitive is ever stored inside the repo — tokens live here.
 */
export function configDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'trundler');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'trundler');
}

/** Per-provider subdirectory, e.g. <configDir>/countdown */
export function providerDir(providerId: string): string {
  return join(configDir(), providerId);
}

/** Log to stderr only — stdout is reserved for the MCP protocol over stdio. */
export function log(...args: unknown[]): void {
  console.error('[trundler]', ...args);
}
