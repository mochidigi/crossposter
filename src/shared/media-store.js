const DATABASE_NAME = "crossposter-handoff";
const STORE_NAME = "media";
const DATABASE_VERSION = 1;

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

// Every stored record's id and age, for the retention sweep.
export async function listHandoffMediaRecords() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const records = [];
  await new Promise((resolve, reject) => {
    const request = transaction.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      records.push({ id: cursor.value.id, createdAt: cursor.value.createdAt });
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("The stored media could not be listed."));
  });
  return records;
}

export async function storeHandoffMedia(blob, metadata = {}) {
  if (!blob || !Number(blob.size)) throw new Error("The downloaded media file was empty.");
  const id = crypto.randomUUID();
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
