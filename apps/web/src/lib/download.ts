import type { ApiRoutePath } from '@civ/shared';
import { requestRaw } from '../api/client';

/*
 * File exports are fetched (so the Authorization header is sent) and handed to the
 * browser as a blob, instead of navigating to the URL.
 */

/** Extract the filename from a Content-Disposition header. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

/** Download an export endpoint as a file. Throws ApiError on failure. */
export async function downloadExport(
  path: ApiRoutePath,
  params: Record<string, string | number>,
  fallbackName: string,
): Promise<string> {
  const response = await requestRaw(path, { params });
  const blob = await response.blob();
  const name = filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return name;
}
