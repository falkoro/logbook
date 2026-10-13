// The file seam: R2 on Cloudflare, a folder on disk when self-hosted.
export type StoredBlob = { body: ReadableStream | ArrayBuffer; mime: string | null; size: number };

export interface Blobs {
  put(key: string, body: ArrayBuffer, mime: string | null): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
}

export const r2 = (bucket: R2Bucket): Blobs => ({
  async put(key, body, mime) {
    await bucket.put(key, body, { httpMetadata: mime ? { contentType: mime } : undefined });
  },
  async get(key) {
    const o = await bucket.get(key);
    return o ? { body: o.body, mime: o.httpMetadata?.contentType ?? null, size: o.size } : null;
  },
});
