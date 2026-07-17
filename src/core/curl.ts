import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export interface CurlResponse {
  status: number;
  /** Response headers, keyed by lower-cased name (duplicates collapse to the last). */
  headers: Record<string, string>;
  /** Every Set-Cookie header value, in order — the Record above collapses duplicates. */
  setCookies: string[];
  body: string;
}

/**
 * GET a URL via the system `curl` and return status, headers and body.
 *
 * Some hosts we read from serve an incomplete TLS certificate chain (a missing
 * intermediate). Browsers and curl tolerate this; Node's fetch (undici) rejects
 * it with UNABLE_TO_VERIFY_LEAF_SIGNATURE. curl also ships with Windows 10 1803+,
 * macOS and Linux, so shelling out keeps those stores reachable with no new deps
 * — the same escape hatch the Foodstuffs guest-token mint already relies on.
 */
export async function curlGet(
  url: string,
  opts: {
    /** Force HTTP/1.1 — some bot-management challenges key on the h2 fingerprint. */
    http11?: boolean;
    /** Accept header (default application/json). */
    accept?: string;
  } = {},
): Promise<CurlResponse> {
  let stdout: string;
  try {
    const args = ['-s', '-D', '-', '--max-time', '30', '-H', `User-Agent: ${UA}`];
    if (opts.http11) args.push('--http1.1');
    args.push('-H', `Accept: ${opts.accept ?? 'application/json'}`, url);
    ({ stdout } = await execFileAsync('curl', args, { maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`curl request failed (${reason}). curl must be installed and on PATH.`);
  }

  // `-D -` writes the header block, a blank line, then the body — all to stdout.
  const split = stdout.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const idx = stdout.indexOf(split);
  const headerText = idx >= 0 ? stdout.slice(0, idx) : stdout;
  const body = idx >= 0 ? stdout.slice(idx + split.length) : '';

  const lines = headerText.split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  const status = Number(statusLine.split(' ')[1]) || 0;
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) {
      const name = line.slice(0, c).trim().toLowerCase();
      const value = line.slice(c + 1).trim();
      headers[name] = value;
      if (name === 'set-cookie') setCookies.push(value);
    }
  }
  return { status, headers, setCookies, body };
}
