const DATABASE_NAME = "crossposter-handoff";
const STORE_NAME = "media";
const DATABASE_VERSION = 1;

export const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;

let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("The Crossposter media store could not be opened."));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("The Crossposter media store failed."));
    transaction.onabort = () => reject(transaction.error || new Error("The Crossposter media store was interrupted."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The stored media could not be read."));
  });
}

export async function clearHandoffMedia() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(STORE_NAME).clear();
  await complete;
}

export async function deleteHandoffMedia(mediaIds = []) {
  const ids = [...new Set(mediaIds)].filter(Boolean);
  if (!ids.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const complete = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  ids.forEach(id => store.delete(id));
  await complete;
}

export async function storeHandoffMedia(blob, metadata = {}) {
  if (!blob || !Number(blob.size)) throw new Error("The downloaded media file was empty.");
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record = {
    id,
    blob,
    kind: metadata.kind || (blob.type.startsWith("video/") ? "video" : "image"),
    name: metadata.name || "crossposter-media",
    type: metadata.type || blob.type || "application/octet-stream",
    lastModified: metadata.lastModified || Date.now(),
    size: blob.size,
    createdAt: Date.now()
  };
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(STORE_NAME).put(record);
  await complete;
  const { blob: _blob, createdAt: _createdAt, id: mediaId, ...reference } = record;
  return { mediaId, ...reference };
}

export async function getHandoffMedia(mediaId) {
  if (!mediaId) return null;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(STORE_NAME).get(mediaId));
}

export async function readHandoffMediaChunk(mediaId, offset = 0, requestedBytes = MEDIA_CHUNK_BYTES) {
  const record = await getHandoffMedia(mediaId);
  if (!record?.blob) throw new Error("This handoff media is no longer available.");
  const start = Math.max(0, Math.min(Number(offset) || 0, record.blob.size));
  const length = Math.max(1, Math.min(Number(requestedBytes) || MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES));
  const end = Math.min(start + length, record.blob.size);
  const bytes = new Uint8Array(await record.blob.slice(start, end).arrayBuffer());
  return {
    data: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
    totalSize: record.blob.size,
    done: end >= record.blob.size
  };
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
