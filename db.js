const DB_NAME = 'guzi-storage-db';
const DB_VERSION = 3;
let dbPromise;

const DEFAULT_IPS = ['鬼灭之刃', '我推的孩子', '小魔女 Doremi'];
const DEFAULT_TYPES = [
  '吧唧', '立牌', '色纸', '小卡拍立得', '玩偶', '挂件', '杯垫', '文件夹',
  '明信片', '海报挂画', '冰箱贴', '贴纸', '杂物周边', '粘土小人', '手办', '书本'
];
const DEFAULT_STATUSES = [
  { name: '收藏中', color: '#55A878' },
  { name: '待出售', color: '#F1C94A' }
];
const DEFAULT_LOCATION_COLORS = {
  '南京': '#92A9BD',
  '大阪': '#F2A7C3',
  '济南': '#A9C9A4',
  '未分类': '#B8B4AE'
};

function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function normalizeCatalogName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function normalizeItem(item) {
  const ips = Array.isArray(item?.ips)
    ? item.ips
    : (item?.ip ? [item.ip] : []);
  const cleanIps = [...new Set(ips.map(value => String(value || '').trim()).filter(Boolean))];
  return {
    ...item,
    ips: cleanIps,
    ip: cleanIps[0] || String(item?.ip || '').trim()
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('items')) {
        const store = db.createObjectStore('items', { keyPath: 'id' });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('locationId', 'locationId', { unique: false });
        store.createIndex('ip', 'ip', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }

      if (!db.objectStoreNames.contains('media')) {
        const store = db.createObjectStore('media', { keyPath: 'id' });
        store.createIndex('itemId', 'itemId', { unique: false });
        store.createIndex('itemId_order', ['itemId', 'order'], { unique: false });
      }

      if (!db.objectStoreNames.contains('locations')) {
        const store = db.createObjectStore('locations', { keyPath: 'id' });
        store.createIndex('parentId', 'parentId', { unique: false });
        store.createIndex('name', 'name', { unique: false });
      }

      if (!db.objectStoreNames.contains('catalogs')) {
        const store = db.createObjectStore('catalogs', { keyPath: 'id' });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('kind_normalized', ['kind', 'normalized'], { unique: true });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('数据库正在被其他页面占用，请关闭其他标签页后重试'));
  });
  return dbPromise;
}

export async function getAll(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return storeName === 'items' ? result.map(normalizeItem) : result;
}

export async function getOne(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return storeName === 'items' && result ? normalizeItem(result) : result;
}

export async function putOne(storeName, value) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const clean = storeName === 'items' ? normalizeItem(value) : value;
  await requestToPromise(tx.objectStore(storeName).put(clean));
  await transactionDone(tx);
  return clean;
}

export async function putManyItems(values) {
  const db = await openDatabase();
  const tx = db.transaction('items', 'readwrite');
  const store = tx.objectStore('items');
  for (const value of values) store.put(normalizeItem(value));
  await transactionDone(tx);
  return values.map(normalizeItem);
}

export async function deleteOne(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).delete(key));
  await transactionDone(tx);
}

export async function getMediaForItem(itemId) {
  const db = await openDatabase();
  const tx = db.transaction('media', 'readonly');
  const index = tx.objectStore('media').index('itemId');
  const result = await requestToPromise(index.getAll(IDBKeyRange.only(itemId)));
  await transactionDone(tx);
  return result.sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getCoverMedia(item) {
  if (!item) return null;
  if (item.coverMediaId) {
    const media = await getOne('media', item.coverMediaId);
    if (media) return media;
  }
  const all = await getMediaForItem(item.id);
  return all[0] || null;
}

export async function saveItemBundle(item, mediaToPut = [], mediaIdsToDelete = []) {
  const db = await openDatabase();
  const tx = db.transaction(['items', 'media'], 'readwrite');
  const items = tx.objectStore('items');
  const media = tx.objectStore('media');

  items.put(normalizeItem(item));
  for (const record of mediaToPut) media.put(record);
  for (const id of mediaIdsToDelete) media.delete(id);

  await transactionDone(tx);
  return normalizeItem(item);
}

export async function saveManyItemBundles(bundles) {
  const db = await openDatabase();
  const tx = db.transaction(['items', 'media'], 'readwrite');
  const items = tx.objectStore('items');
  const media = tx.objectStore('media');

  for (const bundle of bundles) {
    items.put(normalizeItem(bundle.item));
    for (const record of bundle.mediaToPut || []) media.put(record);
  }

  await transactionDone(tx);
  return bundles.map(bundle => normalizeItem(bundle.item));
}

export async function deleteItemCascade(itemId) {
  const db = await openDatabase();
  const tx = db.transaction(['items', 'media'], 'readwrite');
  tx.objectStore('items').delete(itemId);

  const mediaStore = tx.objectStore('media');
  const index = mediaStore.index('itemId');
  const cursorRequest = index.openCursor(IDBKeyRange.only(itemId));
  cursorRequest.onsuccess = event => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  await transactionDone(tx);
}

export async function deleteManyItemsCascade(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return { deletedItems: 0, deletedMedia: 0 };

  const db = await openDatabase();
  const tx = db.transaction(['items', 'media'], 'readwrite');
  const itemStore = tx.objectStore('items');
  const mediaStore = tx.objectStore('media');
  const mediaIndex = mediaStore.index('itemId');
  let deletedMedia = 0;

  for (const itemId of ids) {
    itemStore.delete(itemId);
    const request = mediaIndex.openCursor(IDBKeyRange.only(itemId));
    request.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        deletedMedia += 1;
        cursor.continue();
      }
    };
  }

  await transactionDone(tx);
  return { deletedItems: ids.length, deletedMedia };
}

export async function countStore(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const count = await requestToPromise(tx.objectStore(storeName).count());
  await transactionDone(tx);
  return count;
}

export async function clearAllData() {
  const db = await openDatabase();
  const tx = db.transaction(['items', 'media', 'locations', 'catalogs', 'meta'], 'readwrite');
  tx.objectStore('items').clear();
  tx.objectStore('media').clear();
  tx.objectStore('locations').clear();
  tx.objectStore('catalogs').clear();
  tx.objectStore('meta').clear();
  await transactionDone(tx);
}

export async function importDataBundle({ items, media, locations, catalogs = [], mode = 'merge' }) {
  let importItems = items.map(normalizeItem);
  let importMedia = media;
  let importLocations = locations;
  let importCatalogs = catalogs;

  if (mode === 'add') {
    const [existingItems, existingMedia, existingLocations, existingCatalogs] = await Promise.all([
      getAll('items'), getAll('media'), getAll('locations'), getAll('catalogs')
    ]);
    const itemIds = new Set(existingItems.map(item => item.id));
    const mediaIds = new Set(existingMedia.map(record => record.id));
    const locationIds = new Set(existingLocations.map(location => location.id));
    const catalogIds = new Set(existingCatalogs.map(record => record.id));
    const catalogKeys = new Set(existingCatalogs.map(record => `${record.kind}:${record.normalized || normalizeCatalogName(record.name)}`));
    const acceptedItemIds = new Set(importItems.filter(item => !itemIds.has(item.id)).map(item => item.id));

    importItems = importItems.filter(item => acceptedItemIds.has(item.id));
    importMedia = media.filter(record => acceptedItemIds.has(record.itemId) && !mediaIds.has(record.id));
    importLocations = locations.filter(location => !locationIds.has(location.id));
    importCatalogs = catalogs.filter(record => {
      const key = `${record.kind}:${record.normalized || normalizeCatalogName(record.name)}`;
      return !catalogIds.has(record.id) && !catalogKeys.has(key);
    });
  }

  const db = await openDatabase();
  const tx = db.transaction(['items', 'media', 'locations', 'catalogs'], 'readwrite');
  const itemStore = tx.objectStore('items');
  const mediaStore = tx.objectStore('media');
  const locationStore = tx.objectStore('locations');
  const catalogStore = tx.objectStore('catalogs');

  if (mode === 'replace') {
    itemStore.clear();
    mediaStore.clear();
    locationStore.clear();
    catalogStore.clear();
  }

  for (const location of importLocations) locationStore.put(location);
  for (const item of importItems) itemStore.put(normalizeItem(item));
  for (const record of importMedia) mediaStore.put(record);
  for (const record of importCatalogs) {
    const clean = {
      ...record,
      normalized: record.normalized || normalizeCatalogName(record.name)
    };
    catalogStore.put(clean);
  }

  await transactionDone(tx);
}

export async function ensureDefaultLocations() {
  const existing = await getAll('locations');
  if (existing.length) return existing;

  const createdAt = new Date().toISOString();
  const defaults = [
    { id: generateId(), name: '南京', parentId: null, color: DEFAULT_LOCATION_COLORS['南京'], createdAt, updatedAt: createdAt, order: 1 },
    { id: generateId(), name: '大阪', parentId: null, color: DEFAULT_LOCATION_COLORS['大阪'], createdAt, updatedAt: createdAt, order: 2 },
    { id: generateId(), name: '济南', parentId: null, color: DEFAULT_LOCATION_COLORS['济南'], createdAt, updatedAt: createdAt, order: 3 },
    { id: generateId(), name: '未分类', parentId: null, color: DEFAULT_LOCATION_COLORS['未分类'], createdAt, updatedAt: createdAt, order: 99 }
  ];

  const db = await openDatabase();
  const tx = db.transaction('locations', 'readwrite');
  for (const location of defaults) tx.objectStore('locations').put(location);
  await transactionDone(tx);
  return defaults;
}

async function addCatalogNames(candidates) {
  const existing = await getAll('catalogs');
  const keys = new Set(existing.map(record => `${record.kind}:${record.normalized || normalizeCatalogName(record.name)}`));
  const createdAt = new Date().toISOString();
  const additions = [];

  for (const candidate of candidates) {
    const name = String(candidate.name || '').replace(/\s+/g, ' ').trim();
    const kind = candidate.kind;
    const normalized = normalizeCatalogName(name);
    if (!name || !['ip', 'type', 'status'].includes(kind)) continue;
    const key = `${kind}:${normalized}`;
    if (keys.has(key)) continue;
    keys.add(key);
    additions.push({
      id: generateId(),
      kind,
      name,
      normalized,
      color: kind === 'status' ? (candidate.color || '#9B9B9B') : undefined,
      order: existing.length + additions.length + 1,
      createdAt,
      updatedAt: createdAt
    });
  }

  if (additions.length) {
    const db = await openDatabase();
    const tx = db.transaction('catalogs', 'readwrite');
    for (const record of additions) tx.objectStore('catalogs').put(record);
    await transactionDone(tx);
  }
  return getAll('catalogs');
}

export async function addCatalogsFromItems(items = [], includeDefaults = false) {
  const candidates = [];
  if (includeDefaults) {
    candidates.push(...DEFAULT_IPS.map(name => ({ kind: 'ip', name })));
    candidates.push(...DEFAULT_TYPES.map(name => ({ kind: 'type', name })));
    candidates.push(...DEFAULT_STATUSES.map(record => ({ kind: 'status', ...record })));
  }
  for (const item of items) {
    const ips = Array.isArray(item?.ips) ? item.ips : (item?.ip ? [item.ip] : []);
    for (const name of ips) {
      if (name) candidates.push({ kind: 'ip', name });
    }
    if (item?.type) candidates.push({ kind: 'type', name: item.type });
  }
  return addCatalogNames(candidates);
}

export async function initializeCatalogs(items = []) {
  const initialized = await getMeta('catalogsInitializedV3');
  if (!initialized) {
    await addCatalogsFromItems(items, true);
    await setMeta('catalogsInitializedV3', true);
  }
  return getAll('catalogs');
}

export async function setMeta(key, value) {
  return putOne('meta', { key, value, updatedAt: new Date().toISOString() });
}

export async function getMeta(key) {
  const record = await getOne('meta', key);
  return record?.value;
}
