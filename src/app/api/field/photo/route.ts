import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';
import { ValidationError } from '../../../../lib/errors';

/**
 * Photo upload.
 *
 * Deliberately separate from the operation that records the photo. The metadata lands the
 * moment the shutter closes; the file follows whenever there is bandwidth. A technician on
 * a rural route queues forty photos and sends them over the depot's wifi that evening, and
 * the job's documentation is never waiting on a file transfer.
 *
 * Local disk here. A deployment points this at object storage; nothing else changes.
 */
const UPLOAD_ROOT = join(process.cwd(), 'uploads');
const MAX_BYTES = 12 * 1024 * 1024;

function resolveSafely(storageKey: string): string {
  // A storage key arrives from a device and is used as a path. Anything that escapes the
  // upload root is refused rather than sanitised, because a key that needed sanitising is
  // not a key this server issued.
  if (!/^[a-zA-Z0-9/_-]+\.[a-z0-9]{2,5}$/.test(storageKey)) {
    throw new ValidationError('Invalid storage key');
  }
  const resolved = normalize(join(UPLOAD_ROOT, storageKey));
  if (!resolved.startsWith(UPLOAD_ROOT + '/')) {
    throw new ValidationError('Invalid storage key');
  }
  return resolved;
}

export async function POST(request: Request) {
  try {
    await requireContext();

    const form = await request.formData();
    const storageKey = String(form.get('storageKey') ?? '');
    const file = form.get('file');

    if (!(file instanceof Blob)) throw new ValidationError('No file was sent');
    if (file.size > MAX_BYTES) throw new ValidationError('That photo is too large');

    const target = resolveSafely(storageKey);
    const bytes = Buffer.from(await file.arrayBuffer());

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);

    // Returned so the device can prove the file that arrived is the file it sent.
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    return jsonResponse({ storageKey, bytes: bytes.length, contentHash });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    await requireContext();

    const storageKey = new URL(request.url).searchParams.get('key') ?? '';
    const bytes = await readFile(resolveSafely(storageKey));

    return new Response(new Uint8Array(bytes), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
