/**
 * Parse diagnostics.
 *
 * When a page arrives and cannot be parsed, the build keeps a small excerpt of
 * the bytes. It is gitignored, rewritten each run, and never published: it
 * exists so the next person can see what changed instead of reproducing a live
 * request first.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * @param {object[]} attempts Source attempts from one build.
 * @param {{root: string, directory?: string}} options
 * @returns {Promise<string[]>} Paths written.
 */
export async function saveDiagnostics(attempts, { root, directory = 'data/diagnostics' }) {
  const written = [];
  for (const attempt of attempts) {
    if (!attempt?.diagnostic?.excerpt) continue;
    const target = resolve(root, directory);
    await mkdir(target, { recursive: true });
    const path = resolve(target, `${attempt.def.id}.html`);
    const stamp = new Date(attempt.fetchedAt).toISOString();
    const header = `<!-- ${attempt.def.id} ${stamp} stage=${attempt.diagnostic.stage} bytes=${attempt.diagnostic.bytes} -->\n`;
    await writeFile(path, header + attempt.diagnostic.excerpt, 'utf8');
    written.push(path);
  }
  return written;
}
