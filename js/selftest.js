// The bundle self-test (plan test 5.4): fetch every file of data/manifest.json, check bytes and SHA-256, decode it.
// The summary line reads "SELFTEST PASS n/n" or "SELFTEST FAIL k of n"; the headless check greps it from the DOM.
import { fetchBytes, maybeGunzip, readPack, sha256Hex } from './data.js';

const rows = document.getElementById('rows');
const summary = document.getElementById('summary');
const esc = (value) => String(value).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function line(path, bytes, ok, detail) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(path)}</td><td class="num">${bytes.toLocaleString('en-CA')}</td>`
    + `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</td><td>${esc(detail)}</td>`;
  rows.appendChild(tr);
}

async function decode(path, bytes) {
  if (path.endsWith('.bin.gz')) {
    const pack = readPack(await maybeGunzip(bytes));
    return `${pack.header.kind} [${pack.shape.join(' x ')}] ${pack.header.columns.map((c) => `${c.name}:${c.dtype}`).join(' ')}`;
  }
  if (path.endsWith('.json') || path.endsWith('.json.gz')) {
    const value = JSON.parse(new TextDecoder().decode(await maybeGunzip(bytes)));
    return `JSON with ${Object.keys(value).length} keys`;
  }
  if (path.endsWith('.png') || path.endsWith('.webp')) {
    const image = await createImageBitmap(new Blob([bytes], { type: path.endsWith('.png') ? 'image/png' : 'image/webp' }));
    return `image ${image.width} x ${image.height}`;
  }
  return 'not decoded (text)';
}

async function run() {
  const manifestBytes = await fetchBytes('data/manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  let failed = 0;
  let done = 0;
  // the data files, and the page's own files when fm_assemble.py put them next to the data (manifest "site")
  const site = manifest.site ? manifest.site.files : [];
  const queue = [...manifest.files, ...site];
  const total = queue.length;
  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      try {
        const bytes = await fetchBytes(file.path);           // manifest paths are relative to the page's folder
        const problems = [];
        if (bytes.length !== file.bytes) problems.push(`size ${bytes.length}, manifest ${file.bytes}`);
        const digest = await sha256Hex(bytes);
        if (digest !== file.sha256) problems.push('SHA-256 differs from the manifest');
        const detail = await decode(file.path, bytes);
        if (problems.length) failed += 1;
        line(file.path, bytes.length, !problems.length, problems.length ? problems.join('; ') : detail);
      } catch (error) {
        failed += 1;
        line(file.path, 0, false, error.message);
      }
      done += 1;
      summary.textContent = `Checked ${done} of ${total}…`;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const what = `bundle ${manifest.bundle_id}${site.length ? `, site ${manifest.site.site_id}: ${site.length} page files` : ''}`;
  summary.dataset.status = failed ? 'fail' : 'pass';
  summary.textContent = failed ? `SELFTEST FAIL ${failed} of ${total} files (${what})`
    : `SELFTEST PASS ${total}/${total} files (${what})`;
}

run().catch((error) => {
  summary.dataset.status = 'fail';
  summary.textContent = `SELFTEST FAIL: ${error.message}`;
});
