const DATABASE_NAME = "cr-image-refiner";
const DATABASE_VERSION = 2;
const STORE_NAME = "imageHistory";
const TEMPLATE_STORE_NAME = "templates";

let databasePromise;

export async function saveHistoryEntry(entry) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(entry);
  await transactionDone(transaction);
}

export async function listActiveHistory(now = Date.now()) {
  const entries = await listHistoryEntries();
  const active = [];
  const expiredIds = [];
  for (const entry of entries) {
    if (Number(entry.expiresAt) > now) active.push(entry);
    else expiredIds.push(entry.id);
  }
  if (expiredIds.length) await deleteHistoryEntries(expiredIds);
  return active.sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
}

export async function deleteHistoryEntries(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const id of uniqueIds) store.delete(id);
  await transactionDone(transaction);
}

export async function clearHistoryEntries() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
}

export async function trimHistoryEntries(limit = 20) {
  const entries = await listActiveHistory();
  if (entries.length > limit) {
    await deleteHistoryEntries(entries.slice(limit).map((entry) => entry.id));
  }
}

export function historyBytes(entries) {
  return entries.reduce((total, entry) => total + Number(entry.blob?.size || 0), 0);
}

export async function migrateLocalStorageHistory(entries, ttl) {
  let migrated = 0;
  const now = Date.now();
  for (const item of Array.isArray(entries) ? entries : []) {
    const createdAt = Number(item.createdAt || now);
    const expiresAt = Number(item.expiresAt || createdAt + ttl);
    if (!item.id || !item.dataUrl || expiresAt <= now) continue;
    try {
      const blob = await dataUrlToBlob(item.dataUrl);
      await saveHistoryEntry({
        id: item.id,
        blob,
        title: item.title || "生成画像",
        createdAt,
        expiresAt
      });
      migrated += 1;
    } catch {
      // Skip malformed legacy entries so one damaged image cannot block startup.
    }
  }
  await trimHistoryEntries(20);
  return migrated;
}

export async function saveTemplateEntry(entry) {
  const database = await openDatabase();
  const transaction = database.transaction(TEMPLATE_STORE_NAME, "readwrite");
  transaction.objectStore(TEMPLATE_STORE_NAME).put(entry);
  await transactionDone(transaction);
}

export async function listActiveTemplates(now = Date.now()) {
  const entries = await listStoreEntries(TEMPLATE_STORE_NAME);
  const active = entries.filter((entry) => Number(entry.expiresAt) > now);
  const expiredIds = entries.filter((entry) => Number(entry.expiresAt) <= now).map((entry) => entry.id);
  if (expiredIds.length) await deleteTemplateEntries(expiredIds);
  return active.sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
}

export async function deleteTemplateEntries(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(TEMPLATE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(TEMPLATE_STORE_NAME);
  for (const id of uniqueIds) store.delete(id);
  await transactionDone(transaction);
}

export async function migrateLocalStorageTemplates(entries) {
  let migrated = 0;
  const now = Date.now();
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item?.id || Number(item.expiresAt) <= now) continue;
    await saveTemplateEntry(item);
    migrated += 1;
  }
  return migrated;
}

async function listHistoryEntries() {
  return listStoreEntries(STORE_NAME);
}

async function listStoreEntries(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).getAll();
  const result = await requestResult(request);
  await transactionDone(transaction);
  return result;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
        const store = database.createObjectStore(TEMPLATE_STORE_NAME, { keyPath: "id" });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("IndexedDBを開けませんでした。"));
    request.onblocked = () => reject(new Error("別タブを閉じてから再読み込みしてください。"));
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDBの処理に失敗しました。"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDBの処理が中断されました。"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDBの処理に失敗しました。"));
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("旧履歴画像を読み込めませんでした。");
  return response.blob();
}
