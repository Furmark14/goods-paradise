import {
  openDatabase,
  getAll,
  getOne,
  putOne,
  putManyItems,
  deleteOne,
  getMediaForItem,
  getCoverMedia,
  saveItemBundle,
  saveManyItemBundles,
  deleteItemCascade,
  deleteManyItemsCascade,
  countStore,
  clearAllData,
  importDataBundle,
  ensureDefaultLocations,
  initializeCatalogs,
  addCatalogsFromItems,
  setMeta,
  getMeta
} from './db.js';

const APP_VERSION = '0.6.0';
const BACKUP_FORMAT = 'guzi-storage-backup';
const BACKUP_SCHEMA_VERSION = 3;

const state = {
  currentTab: 'items',
  items: [],
  locations: [],
  catalogs: [],
  query: '',
  filters: { locationId: '', ip: '', type: '' },
  sort: 'updated-desc',
  shownCount: 60,
  viewMode: 'grid',
  gridColumns: Math.min(5, Math.max(2, Number(localStorage.getItem('goods-paradise-grid-columns') || 2))),
  imageCount: 0,
  bulkMode: false,
  selectedItemIds: new Set(),
  pendingImport: null,
  objectUrls: new Set(),
  loading: false
};

const mainView = document.querySelector('#main-view');
const pageTitle = document.querySelector('#page-title');
const quickAdd = document.querySelector('#quick-add');
const optionManagerButton = document.querySelector('#option-manager');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const backupFileInput = document.querySelector('#backup-file-input');

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
}

function formatMoney(value, currency = 'CNY') {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '—';
  const symbols = { CNY: '¥', JPY: '¥', USD: '$', EUR: '€', KRW: '₩' };
  return `${symbols[currency] || ''}${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function uniqueSorted(values) {
  return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function toast(message, type = 'default', duration = 2600) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  toastRoot.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 240);
  }, duration);
}

function clearObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function blobUrl(blob) {
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  return url;
}

function openModal(content, { wide = false, onClose = null } = {}) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-close>
      <section class="modal-panel ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        ${content}
      </section>
    </div>`;
  const backdrop = modalRoot.querySelector('.modal-backdrop');
  const close = () => {
    modalRoot.innerHTML = '';
    if (onClose) onClose();
  };
  backdrop.addEventListener('click', event => {
    if (event.target.matches('[data-modal-close]')) close();
  });
  modalRoot.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', close);
  });
  return { root: backdrop, close };
}

function confirmDialog({ title, message, confirmText = '确认', danger = false }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal(`
      <div class="modal-header">
        <div><div class="eyebrow">CONFIRM</div><h2>${escapeHtml(title)}</h2></div>
        <button class="icon-button" data-close-modal>×</button>
      </div>
      <div class="modal-body"><p class="dialog-message">${escapeHtml(message)}</p></div>
      <div class="modal-actions">
        <button class="button secondary" data-cancel>取消</button>
        <button class="button ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmText)}</button>
      </div>
    `, { onClose: () => finish(false) });
    modal.root.querySelector('[data-cancel]').addEventListener('click', () => {
      finish(false);
      modal.close();
    });
    modal.root.querySelector('[data-confirm]').addEventListener('click', () => {
      finish(true);
      modal.close();
    });
  });
}

function locationMap() {
  return new Map(state.locations.map(location => [location.id, location]));
}

function locationPath(locationId) {
  if (!locationId) return '未分类';
  const map = locationMap();
  const names = [];
  const visited = new Set();
  let current = map.get(locationId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? map.get(current.parentId) : null;
  }
  return names.join(' / ') || '未分类';
}

function locationOptions(selected = '') {
  const children = new Map();
  for (const location of state.locations) {
    const key = location.parentId || '__root__';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(location);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  }
  const output = ['<option value="">未指定</option>'];
  function walk(parentId, depth) {
    for (const location of children.get(parentId) || []) {
      output.push(`<option value="${location.id}" ${location.id === selected ? 'selected' : ''}>${'　'.repeat(depth)}${escapeHtml(location.name)}</option>`);
      walk(location.id, depth + 1);
    }
  }
  walk('__root__', 0);
  return output.join('');
}

function normalizeCatalogName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function catalogLabel(kind) {
  const labels = {
    ip: '作品 / IP',
    type: '物品类型',
    status: '物品状态'
  };
  return labels[kind] || '选项';
}

function catalogNames(kind) {
  return state.catalogs
    .filter(record => record.kind === kind)
    .map(record => record.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function catalogOptions(kind, selected = '') {
  const names = catalogNames(kind);
  const selectedName = String(selected || '').trim();
  const hasSelected = names.some(name => normalizeCatalogName(name) === normalizeCatalogName(selectedName));
  const output = ['<option value="">未指定</option>'];
  if (selectedName && !hasSelected) {
    output.push(`<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName)}（当前记录，已从词库移除）</option>`);
  }
  for (const name of names) {
    output.push(`<option value="${escapeHtml(name)}" ${normalizeCatalogName(name) === normalizeCatalogName(selectedName) ? 'selected' : ''}>${escapeHtml(name)}</option>`);
  }
  return output.join('');
}

function catalogUsageCount(kind, name) {
  const normalized = normalizeCatalogName(name);
  if (kind === 'ip') {
    return state.items.filter(item => itemIps(item).some(value => normalizeCatalogName(value) === normalized)).length;
  }
  return state.items.filter(item => normalizeCatalogName(item[kind]) === normalized).length;
}

async function createCatalogEntry(kind, rawName, color = '') {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error(`请填写${catalogLabel(kind)}名称`);
  if (!['ip', 'type', 'status'].includes(kind)) throw new Error('词库类型不正确');
  const normalized = normalizeCatalogName(name);
  const duplicate = state.catalogs.find(record => record.kind === kind && (record.normalized || normalizeCatalogName(record.name)) === normalized);
  if (duplicate) return duplicate;

  const now = new Date().toISOString();
  const record = {
    id: makeId(),
    kind,
    name,
    normalized,
    color: kind === 'status' ? safeColor(color, '#9B9B9B') : undefined,
    order: state.catalogs.filter(entry => entry.kind === kind).length + 1,
    createdAt: now,
    updatedAt: now
  };
  await putOne('catalogs', record);
  await reloadData();
  return record;
}

async function openCatalogManager(kind, { returnToOptions = true } = {}) {
  let query = '';
  const label = catalogLabel(kind);
  const supportsColor = kind === 'status';
  const modal = openModal(`
    <div class="modal-header sticky">
      <div><div class="eyebrow">OPTION LIBRARY</div><h2>管理${escapeHtml(label)}</h2></div>
      <button type="button" class="icon-button" data-close-modal>×</button>
    </div>
    <div class="modal-body catalog-manager-body">
      <form id="catalog-add-form" class="catalog-add-form ${supportsColor ? 'with-color' : ''}">
        <input id="catalog-new-name" maxlength="100" placeholder="输入新的${escapeHtml(label)}名称" autocomplete="off">
        ${supportsColor ? '<input id="catalog-new-color" class="color-input" type="color" value="#9B9B9B" aria-label="新状态颜色">' : ''}
        <button class="button primary" type="submit">添加</button>
      </form>
      <label class="search-box compact-search">
        <span>⌕</span>
        <input id="catalog-search" type="search" placeholder="搜索选项">
      </label>
      <div class="catalog-manager-note">
        ${supportsColor
          ? '状态颜色会显示为物品图片左上角的圆形灯标。删除状态选项不会改动已有物品。'
          : '删除选项只会让它不再出现在新增物品的选择列表中，不会改动已有物品记录。'}
      </div>
      <div id="catalog-manager-list" class="catalog-manager-list"></div>
    </div>
    <div class="modal-actions sticky-bottom">
      ${returnToOptions ? '<button type="button" class="button secondary" data-back-options>返回选项管理</button>' : ''}
      <button type="button" class="button primary" data-close-modal>完成</button>
    </div>
  `, { wide: true });

  async function updateRecordColor(record, color) {
    const cleanColor = safeColor(color, '#9B9B9B');
    await putOne('catalogs', { ...record, color: cleanColor, updatedAt: new Date().toISOString() });
    await reloadData();
  }

  function renderList() {
    const records = state.catalogs
      .filter(record => record.kind === kind)
      .filter(record => !query || record.name.toLocaleLowerCase('zh-CN').includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const container = modal.root.querySelector('#catalog-manager-list');
    if (!records.length) {
      container.innerHTML = '<div class="empty-state compact"><h2>没有匹配项目</h2><p>可以在上方输入名称并添加。</p></div>';
      return;
    }

    container.innerHTML = records.map(record => {
      const usage = catalogUsageCount(kind, record.name);
      const color = safeColor(record.color, '#9B9B9B');
      return `
        <div class="catalog-manager-row" data-catalog-id="${record.id}">
          <div class="catalog-row-main">
            ${supportsColor ? `<span class="color-dot large" style="--dot-color:${color}"></span>` : ''}
            <div><strong>${escapeHtml(record.name)}</strong><span>${usage ? `${usage} 条物品正在使用` : '暂无物品使用'}</span></div>
          </div>
          <div class="catalog-row-actions">
            ${supportsColor ? `<input class="color-input compact" type="color" value="${color}" data-catalog-color="${record.id}" aria-label="${escapeHtml(record.name)}颜色">` : ''}
            <button type="button" class="mini-button danger-text" data-delete-catalog="${record.id}">删除</button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-catalog-color]').forEach(input => {
      input.addEventListener('change', async () => {
        const record = state.catalogs.find(entry => entry.id === input.dataset.catalogColor);
        if (!record) return;
        await updateRecordColor(record, input.value);
        renderList();
        renderCurrentTab();
        toast('状态颜色已更新', 'success');
      });
    });

    container.querySelectorAll('[data-delete-catalog]').forEach(button => {
      button.addEventListener('click', async () => {
        const record = state.catalogs.find(entry => entry.id === button.dataset.deleteCatalog);
        if (!record) return;
        const usage = catalogUsageCount(kind, record.name);
        const message = usage
          ? `已有 ${usage} 条物品使用“${record.name}”。删除选项后已有记录保持不变，确定继续吗？`
          : `确定删除“${record.name}”吗？`;
        if (!window.confirm(message)) return;
        await deleteOne('catalogs', record.id);
        await reloadData();
        renderList();
        renderCurrentTab();
        toast('选项已删除');
      });
    });
  }

  modal.root.querySelector('#catalog-search').addEventListener('input', event => {
    query = event.target.value.trim().toLocaleLowerCase('zh-CN');
    renderList();
  });

  modal.root.querySelector('#catalog-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = modal.root.querySelector('#catalog-new-name');
    const colorInput = modal.root.querySelector('#catalog-new-color');
    try {
      const before = state.catalogs.length;
      const record = await createCatalogEntry(kind, input.value, colorInput?.value || '');
      input.value = '';
      renderList();
      toast(state.catalogs.length > before ? `已添加：${record.name}` : `“${record.name}”已存在`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  modal.root.querySelector('[data-back-options]')?.addEventListener('click', () => {
    modal.close();
    openOptionManager();
  });

  renderList();
}

function safeColor(value, fallback = '') {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function itemIps(item) {
  const values = Array.isArray(item?.ips) ? item.ips : (item?.ip ? [item.ip] : []);
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function statusColor(status) {
  const normalized = normalizeCatalogName(status);
  const record = state.catalogs.find(entry => entry.kind === 'status' && normalizeCatalogName(entry.name) === normalized);
  return safeColor(record?.color, '#9B9B9B');
}

function locationColor(locationId) {
  if (!locationId) return '';
  const map = locationMap();
  const visited = new Set();
  let current = map.get(locationId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const color = safeColor(current.color, '');
    if (color) return color;
    current = current.parentId ? map.get(current.parentId) : null;
  }
  return '';
}

function selectedIpsSummary(values) {
  const list = [...values];
  if (!list.length) return '请选择作品 / IP';
  if (list.length <= 2) return list.join('、');
  return `${list.slice(0, 2).join('、')} 等 ${list.length} 项`;
}

function openOptionManager() {
  const modal = openModal(`
    <div class="modal-header sticky">
      <div><div class="eyebrow">COLLECTION OPTIONS</div><h2>管理分类与颜色</h2></div>
      <button type="button" class="icon-button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      <div class="option-manager-intro">在这里统一管理新增物品时使用的选项。位置颜色用于物品外框，状态颜色用于左上角圆形灯标。</div>
      <section class="option-manager-grid">
        <button type="button" class="option-manager-card" data-option-section="location">
          <span class="option-manager-icon">⌂</span>
          <div><strong>存放位置</strong><span>${state.locations.length} 个位置 · 可设置外框颜色</span></div>
          <span class="option-arrow">›</span>
        </button>
        <button type="button" class="option-manager-card" data-option-section="status">
          <span class="option-manager-icon">●</span>
          <div><strong>物品状态</strong><span>${catalogNames('status').length} 项 · 可设置灯标颜色</span></div>
          <span class="option-arrow">›</span>
        </button>
        <button type="button" class="option-manager-card" data-option-section="ip">
          <span class="option-manager-icon">◎</span>
          <div><strong>作品 / IP</strong><span>${catalogNames('ip').length} 项 · 物品支持复数 IP</span></div>
          <span class="option-arrow">›</span>
        </button>
        <button type="button" class="option-manager-card" data-option-section="type">
          <span class="option-manager-icon">◇</span>
          <div><strong>物品类型</strong><span>${catalogNames('type').length} 项</span></div>
          <span class="option-arrow">›</span>
        </button>
      </section>
    </div>
    <div class="modal-actions sticky-bottom">
      <button type="button" class="button primary" data-close-modal>完成</button>
    </div>
  `, { wide: true });

  modal.root.querySelectorAll('[data-option-section]').forEach(button => {
    button.addEventListener('click', () => {
      const section = button.dataset.optionSection;
      modal.close();
      if (section === 'location') openLocationManager();
      else openCatalogManager(section);
    });
  });
}

function locationManagerRows() {
  const children = locationChildrenMap();
  const itemCounts = new Map();
  for (const item of state.items) itemCounts.set(item.locationId, (itemCounts.get(item.locationId) || 0) + 1);

  function descendantCount(id) {
    let total = itemCounts.get(id) || 0;
    for (const child of children.get(id) || []) total += descendantCount(child.id);
    return total;
  }

  function walk(parentId, depth) {
    return (children.get(parentId) || []).map(location => {
      const ownColor = safeColor(location.color, '');
      const inherited = locationColor(location.id);
      const pickerColor = ownColor || inherited || '#B8B4AE';
      return `
        <div class="location-manager-row" style="--depth:${depth}">
          <div class="location-manager-name">
            <span class="location-indent"></span>
            <span class="color-dot large" style="--dot-color:${pickerColor}"></span>
            <div><strong>${escapeHtml(location.name)}</strong><span>${descendantCount(location.id)} 条物品${ownColor ? '' : ' · 继承颜色'}</span></div>
          </div>
          <div class="location-manager-actions">
            <input class="color-input compact" type="color" value="${pickerColor}" data-location-color="${location.id}" aria-label="${escapeHtml(location.name)}颜色">
            <button type="button" class="mini-button" data-clear-location-color="${location.id}">继承</button>
            <button type="button" class="mini-button" data-add-location-child="${location.id}">＋子位置</button>
            <button type="button" class="mini-button" data-edit-location="${location.id}">编辑</button>
            <button type="button" class="mini-button danger-text" data-remove-location="${location.id}">删除</button>
          </div>
        </div>
        ${walk(location.id, depth + 1)}
      `;
    }).join('');
  }
  return walk('__root__', 0);
}

function openLocationManager() {
  const modal = openModal(`
    <div class="modal-header sticky">
      <div><div class="eyebrow">LOCATION & COLOR</div><h2>管理存放位置</h2></div>
      <button type="button" class="icon-button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      <div class="catalog-manager-note">位置颜色会体现在物品卡片外框。子位置没有单独颜色时，会继承最近一级上级位置的颜色。</div>
      <div id="location-manager-list" class="location-manager-list">${locationManagerRows()}</div>
      <button type="button" class="button primary full-width" data-add-root-location>新增一级位置</button>
    </div>
    <div class="modal-actions sticky-bottom">
      <button type="button" class="button secondary" data-back-options>返回选项管理</button>
      <button type="button" class="button primary" data-close-modal>完成</button>
    </div>
  `, { wide: true });

  const reopen = () => {
    modal.close();
    openLocationManager();
  };

  modal.root.querySelector('[data-add-root-location]').addEventListener('click', () => {
    modal.close();
    openLocationEditor(null, null, true);
  });

  modal.root.querySelectorAll('[data-add-location-child]').forEach(button => {
    button.addEventListener('click', () => {
      modal.close();
      openLocationEditor(null, button.dataset.addLocationChild, true);
    });
  });

  modal.root.querySelectorAll('[data-edit-location]').forEach(button => {
    button.addEventListener('click', () => {
      modal.close();
      openLocationEditor(button.dataset.editLocation, null, true);
    });
  });

  modal.root.querySelectorAll('[data-location-color]').forEach(input => {
    input.addEventListener('change', async () => {
      const location = state.locations.find(entry => entry.id === input.dataset.locationColor);
      if (!location) return;
      await putOne('locations', { ...location, color: safeColor(input.value, ''), updatedAt: new Date().toISOString() });
      await reloadData();
      renderCurrentTab();
      reopen();
      toast('位置颜色已更新', 'success');
    });
  });

  modal.root.querySelectorAll('[data-clear-location-color]').forEach(button => {
    button.addEventListener('click', async () => {
      const location = state.locations.find(entry => entry.id === button.dataset.clearLocationColor);
      if (!location) return;
      await putOne('locations', { ...location, color: '', updatedAt: new Date().toISOString() });
      await reloadData();
      renderCurrentTab();
      reopen();
      toast('已改为继承上级颜色', 'success');
    });
  });

  modal.root.querySelectorAll('[data-remove-location]').forEach(button => {
    button.addEventListener('click', async () => {
      const locationId = button.dataset.removeLocation;
      const location = state.locations.find(entry => entry.id === locationId);
      const hasChildren = state.locations.some(entry => entry.parentId === locationId);
      const used = state.items.some(item => item.locationId === locationId);
      if (hasChildren || used) {
        toast('该位置仍有子位置或物品，不能直接删除', 'error', 4200);
        return;
      }
      if (!window.confirm(`确定删除“${location?.name || ''}”吗？`)) return;
      await deleteOne('locations', locationId);
      await reloadData();
      renderCurrentTab();
      reopen();
      toast('位置已删除');
    });
  });

  modal.root.querySelector('[data-back-options]').addEventListener('click', () => {
    modal.close();
    openOptionManager();
  });
}

async function reloadData() {
  [state.items, state.locations, state.catalogs, state.imageCount] = await Promise.all([
    getAll('items'),
    getAll('locations'),
    getAll('catalogs'),
    countStore('media')
  ]);
  state.catalogs = await initializeCatalogs(state.items);
  state.items = state.items.map(item => ({
    ...item,
    ips: itemIps(item),
    ip: itemIps(item)[0] || ''
  }));
  const validIds = new Set(state.items.map(item => item.id));
  state.selectedItemIds = new Set([...state.selectedItemIds].filter(id => validIds.has(id)));
  state.locations.sort((a, b) => (a.order || 0) - (b.order || 0));
  state.catalogs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-CN'));
}

function setLoading(loading, text = '处理中…') {
  state.loading = loading;
  let overlay = document.querySelector('#global-loading');
  if (loading) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'global-loading';
      overlay.className = 'global-loading';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="loading-card"><div class="spinner"></div><div id="loading-text">${escapeHtml(text)}</div><div id="loading-progress" class="loading-progress"></div></div>`;
  } else if (overlay) {
    overlay.remove();
  }
}

function updateLoading(text, progress = '') {
  const textNode = document.querySelector('#loading-text');
  const progressNode = document.querySelector('#loading-progress');
  if (textNode) textNode.textContent = text;
  if (progressNode) progressNode.textContent = progress;
}

function setTab(tab) {
  if (tab !== 'items') {
    state.bulkMode = false;
    state.selectedItemIds.clear();
  }
  state.currentTab = tab;
  state.shownCount = 60;
  document.querySelectorAll('.nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  const titles = { items: 'Goods Paradise 谷子天国', locations: '存放位置', backup: '备份与恢复', settings: '设置' };
  pageTitle.textContent = titles[tab];
  quickAdd.hidden = !['items', 'locations'].includes(tab) || state.bulkMode;
  optionManagerButton.hidden = tab !== 'items' || state.bulkMode;
  quickAdd.setAttribute('aria-label', tab === 'locations' ? '新增位置' : '新增物品');
  renderCurrentTab();
}

function renderCurrentTab() {
  clearObjectUrls();
  if (state.currentTab === 'items') renderItemsView();
  if (state.currentTab === 'locations') renderLocationsView();
  if (state.currentTab === 'backup') renderBackupView();
  if (state.currentTab === 'settings') renderSettingsView();
}

function filteredItems() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  let list = state.items.filter(item => {
    if (state.filters.locationId && item.locationId !== state.filters.locationId) return false;
    if (state.filters.ip && !itemIps(item).includes(state.filters.ip)) return false;
    if (state.filters.type && item.type !== state.filters.type) return false;
    if (!query) return true;
    const haystack = [
      item.name, item.remark, ...itemIps(item), item.type,
      item.status, ...(item.tags || []), locationPath(item.locationId)
    ].join(' ').toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });

  const sorters = {
    'updated-desc': (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    'created-desc': (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    'created-asc': (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
    'name-asc': (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
    'quantity-desc': (a, b) => Number(b.quantity || 0) - Number(a.quantity || 0),
    'price-desc': (a, b) => Number(b.price || 0) - Number(a.price || 0)
  };
  return list.sort(sorters[state.sort] || sorters['updated-desc']);
}

function itemCard(item) {
  const ips = itemIps(item);
  const chips = [item.type, ...ips].filter(Boolean).slice(0, 3);
  const frameColor = locationColor(item.locationId) || '#D8D5D0';
  const lightColor = statusColor(item.status);
  const selected = state.selectedItemIds.has(item.id);
  return `
    <article class="item-card ${state.bulkMode ? 'bulk-mode' : ''} ${selected ? 'batch-selected' : ''}" data-item-id="${item.id}" style="--location-color:${frameColor}">
      <div class="item-cover-wrap">
        <div class="image-placeholder">无图</div>
        <img class="item-cover" data-cover-for="${item.id}" alt="${escapeHtml(item.name)}" loading="lazy" />
        <span class="status-light" style="--status-color:${lightColor}" title="${escapeHtml(item.status || '未指定状态')}" aria-label="${escapeHtml(item.status || '未指定状态')}"></span>
        ${state.bulkMode ? `<button type="button" class="batch-check ${selected ? 'selected' : ''}" data-batch-check="${item.id}" aria-label="${selected ? '取消选择' : '选择物品'}">${selected ? '✓' : ''}</button>` : ''}
        <span class="quantity-badge">×${formatNumber(item.quantity || 1)}</span>
      </div>
      <div class="item-card-body">
        <h3>${escapeHtml(item.name || '未命名')}</h3>
        <div class="chip-row">${chips.map(chip => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>
        <div class="item-meta-line"><span>${escapeHtml(locationPath(item.locationId))}</span><span>${formatMoney(item.price, item.currency)}</span></div>
      </div>
    </article>`;
}

async function loadCoverForElement(element) {
  if (element.dataset.loaded) return;
  element.dataset.loaded = 'true';
  const item = state.items.find(candidate => candidate.id === element.dataset.coverFor);
  if (!item) return;
  try {
    const media = await getCoverMedia(item);
    const blob = media?.thumbnailBlob || media?.originalBlob;
    if (!blob || !document.body.contains(element)) return;
    element.src = blobUrl(blob);
    element.classList.add('loaded');
  } catch (error) {
    console.warn('封面加载失败', error);
  }
}

function activateLazyCovers() {
  const images = [...mainView.querySelectorAll('[data-cover-for]')];
  if (!('IntersectionObserver' in window)) {
    images.forEach(loadCoverForElement);
    return;
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        loadCoverForElement(entry.target);
      }
    }
  }, { rootMargin: '300px' });
  images.forEach(image => observer.observe(image));
}

function renderItemsView() {
  clearObjectUrls();
  const ips = uniqueSorted(state.items.flatMap(item => itemIps(item)));
  const types = uniqueSorted(state.items.map(item => item.type));
  const list = filteredItems();
  const visible = list.slice(0, state.shownCount);
  const selectedCount = state.selectedItemIds.size;

  mainView.innerHTML = `
    <section class="summary-strip two-column">
      <div><strong>${formatNumber(state.items.length)}</strong><span>条记录</span></div>
      <div><strong>${formatNumber(state.imageCount)}</strong><span>张图片</span></div>
    </section>

    <section class="item-action-grid">
      <button id="batch-add-items" class="item-action-button primary-action">
        <span class="item-action-icon">＋</span>
        <span><strong>批量添加</strong><small>多张图片分别创建物品</small></span>
      </button>
      <button id="toggle-bulk-mode" class="item-action-button ${state.bulkMode ? 'active-action' : ''}">
        <span class="item-action-icon">✓</span>
        <span><strong>${state.bulkMode ? '结束批量操作' : '开启批量操作'}</strong><small>${state.bulkMode ? `已选择 ${selectedCount} 项` : '点选已有物品并统一编辑'}</small></span>
      </button>
    </section>

    ${state.bulkMode ? `
      <section class="bulk-toolbar">
        <div class="bulk-toolbar-title"><strong>已选择 ${selectedCount} 项</strong><span>可以跨筛选条件继续选择</span></div>
        <div class="bulk-toolbar-actions">
          <button id="bulk-select-results" class="mini-button">全选当前 ${list.length} 条结果</button>
          <button id="bulk-clear-selection" class="mini-button">清空选择</button>
          <button id="bulk-edit-selected" class="button primary small" ${selectedCount ? '' : 'disabled'}>批量编辑</button>
          <button id="bulk-delete-selected" class="button danger small" ${selectedCount ? '' : 'disabled'}>批量删除</button>
          <button id="bulk-exit" class="button secondary small">退出</button>
        </div>
      </section>
    ` : ''}

    <button id="manage-options-inline" class="manage-options-button">
      <span class="manage-options-icon">☷</span>
      <span><strong>管理分类与颜色</strong><small>存放位置、物品状态、作品 / IP、物品类型</small></span>
      <span class="option-arrow">›</span>
    </button>

    <section class="toolbar-card">
      <label class="search-box">
        <span>⌕</span>
        <input id="item-search" type="search" placeholder="搜索名称、IP、备注、状态或位置" value="${escapeHtml(state.query)}" />
      </label>
      <div class="filter-grid">
        <select id="filter-location" aria-label="按位置筛选">
          <option value="">全部位置</option>
          ${state.locations.map(location => `<option value="${location.id}" ${state.filters.locationId === location.id ? 'selected' : ''}>${escapeHtml(locationPath(location.id))}</option>`).join('')}
        </select>
        <select id="filter-ip" aria-label="按作品筛选">
          <option value="">全部作品 / IP</option>
          ${ips.map(value => `<option ${state.filters.ip === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
        </select>
        <select id="filter-type" aria-label="按类型筛选">
          <option value="">全部物品类型</option>
          ${types.map(value => `<option ${state.filters.type === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
        </select>
        <select id="sort-items" aria-label="排序">
          <option value="updated-desc" ${state.sort === 'updated-desc' ? 'selected' : ''}>最近修改</option>
          <option value="created-desc" ${state.sort === 'created-desc' ? 'selected' : ''}>最新录入</option>
          <option value="created-asc" ${state.sort === 'created-asc' ? 'selected' : ''}>最早录入</option>
          <option value="name-asc" ${state.sort === 'name-asc' ? 'selected' : ''}>名称排序</option>
          <option value="quantity-desc" ${state.sort === 'quantity-desc' ? 'selected' : ''}>数量从多到少</option>
          <option value="price-desc" ${state.sort === 'price-desc' ? 'selected' : ''}>价格从高到低</option>
        </select>
      </div>
    </section>

    <div class="section-heading item-display-heading">
      <div><h2>物品</h2><span>${formatNumber(list.length)} 条结果</span></div>
      <div class="display-controls">
        ${state.viewMode === 'grid' ? `
          <label class="grid-column-control">
            <span>每行</span>
            <select id="grid-column-count" aria-label="选择每行显示数量">
              ${[2,3,4,5].map(value => `<option value="${value}" ${state.gridColumns === value ? 'selected' : ''}>${value} 个</option>`).join('')}
            </select>
          </label>
        ` : ''}
        <button id="toggle-view" class="text-button">${state.viewMode === 'grid' ? '切换列表' : '切换网格'}</button>
      </div>
    </div>

    ${visible.length ? `
      <section class="items-${state.viewMode}" ${state.viewMode === 'grid' ? `style="--grid-columns:${state.gridColumns}"` : ''}>
        ${visible.map(itemCard).join('')}
      </section>
      ${visible.length < list.length ? `<button id="load-more" class="button secondary full-width">继续加载（剩余 ${list.length - visible.length} 条）</button>` : ''}
    ` : `
      <section class="empty-state">
        <div class="empty-icon">□</div>
        <h2>${state.items.length ? '没有符合条件的物品' : '开始建立你的谷子数据库'}</h2>
        <p>${state.items.length ? '调整搜索词或筛选条件后再试。' : '可以单件录入、批量添加，也可以从完整备份中一次性导入。'}</p>
        <div class="empty-action-row">
          <button id="empty-add" class="button primary">新增第一件物品</button>
          <button id="empty-batch-add" class="button secondary">批量添加图片</button>
        </div>
      </section>`}
  `;

  mainView.querySelector('#batch-add-items')?.addEventListener('click', openBatchAddEditor);
  mainView.querySelector('#empty-batch-add')?.addEventListener('click', openBatchAddEditor);
  mainView.querySelector('#toggle-bulk-mode')?.addEventListener('click', () => {
    state.bulkMode = !state.bulkMode;
    if (!state.bulkMode) state.selectedItemIds.clear();
    quickAdd.hidden = state.bulkMode;
    optionManagerButton.hidden = state.bulkMode;
    renderItemsView();
  });
  mainView.querySelector('#bulk-exit')?.addEventListener('click', () => {
    state.bulkMode = false;
    state.selectedItemIds.clear();
    quickAdd.hidden = false;
    optionManagerButton.hidden = false;
    renderItemsView();
  });
  mainView.querySelector('#bulk-select-results')?.addEventListener('click', () => {
    for (const item of list) state.selectedItemIds.add(item.id);
    renderItemsView();
  });
  mainView.querySelector('#bulk-clear-selection')?.addEventListener('click', () => {
    state.selectedItemIds.clear();
    renderItemsView();
  });
  mainView.querySelector('#bulk-edit-selected')?.addEventListener('click', openBatchEditSelected);
  mainView.querySelector('#bulk-delete-selected')?.addEventListener('click', openBatchDeleteSelected);
  mainView.querySelector('#manage-options-inline')?.addEventListener('click', openOptionManager);

  const search = mainView.querySelector('#item-search');
  let searchTimer;
  search?.addEventListener('input', event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      state.shownCount = 60;
      renderItemsView();
    }, 180);
  });

  mainView.querySelector('#filter-location')?.addEventListener('change', event => {
    state.filters.locationId = event.target.value;
    state.shownCount = 60;
    renderItemsView();
  });
  mainView.querySelector('#filter-ip')?.addEventListener('change', event => {
    state.filters.ip = event.target.value;
    state.shownCount = 60;
    renderItemsView();
  });
  mainView.querySelector('#filter-type')?.addEventListener('change', event => {
    state.filters.type = event.target.value;
    state.shownCount = 60;
    renderItemsView();
  });
  mainView.querySelector('#sort-items')?.addEventListener('change', event => {
    state.sort = event.target.value;
    renderItemsView();
  });
  mainView.querySelector('#grid-column-count')?.addEventListener('change', event => {
    state.gridColumns = Math.min(5, Math.max(2, Number(event.target.value || 2)));
    localStorage.setItem('goods-paradise-grid-columns', String(state.gridColumns));
    renderItemsView();
  });
  mainView.querySelector('#toggle-view')?.addEventListener('click', () => {
    state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
    renderItemsView();
  });
  mainView.querySelector('#load-more')?.addEventListener('click', () => {
    state.shownCount += 60;
    renderItemsView();
  });
  mainView.querySelector('#empty-add')?.addEventListener('click', () => openItemEditor());

  mainView.querySelectorAll('.item-card').forEach(card => {
    card.addEventListener('click', event => {
      const itemId = card.dataset.itemId;
      if (state.bulkMode) {
        if (event.target.closest('[data-batch-check]')) return;
        if (state.selectedItemIds.has(itemId)) state.selectedItemIds.delete(itemId);
        else state.selectedItemIds.add(itemId);
        renderItemsView();
      } else {
        openItemDetail(itemId);
      }
    });
  });
  mainView.querySelectorAll('[data-batch-check]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const itemId = button.dataset.batchCheck;
      if (state.selectedItemIds.has(itemId)) state.selectedItemIds.delete(itemId);
      else state.selectedItemIds.add(itemId);
      renderItemsView();
    });
  });

  activateLazyCovers();
}

async function decodeImage(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (_) {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = error => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    image.src = url;
  });
}

async function createThumbnailBlob(sourceBlob, maxSize = 640) {
  try {
    const image = await decodeImage(sourceBlob);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (typeof image.close === 'function') image.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob || sourceBlob;
  } catch (error) {
    console.warn('无法生成缩略图，暂时使用原图', error);
    return sourceBlob;
  }
}


function suggestedBatchName(file, index) {
  const base = String(file?.name || '').replace(/\.[^.]+$/, '').trim();
  if (!base || /^(img|image|photo|dsc)[-_ ]?\d*$/i.test(base)) return `新物品 ${index + 1}`;
  return base;
}

function renderSharedIpChoices(container, selectedIps, query = '', onChange = null) {
  const allNames = [...new Set([...catalogNames('ip'), ...selectedIps])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visible = allNames.filter(name => !normalizedQuery || name.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
  container.innerHTML = visible.length
    ? visible.map(name => `
        <label class="multi-choice-row">
          <input type="checkbox" value="${escapeHtml(name)}" ${selectedIps.has(name) ? 'checked' : ''}>
          <span>${escapeHtml(name)}</span>
        </label>`).join('')
    : '<div class="catalog-empty-text padded">没有匹配项目</div>';

  container.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) selectedIps.add(input.value);
      else selectedIps.delete(input.value);
      if (onChange) onChange();
    });
  });
}

async function openBatchAddEditor() {
  const drafts = [];
  const selectedIps = new Set();

  const modal = openModal(`
    <form id="batch-add-form" class="editor-form">
      <div class="modal-header sticky">
        <div><div class="eyebrow">BATCH CREATE</div><h2>批量添加物品</h2></div>
        <button type="button" class="icon-button" data-close-modal>×</button>
      </div>

      <div class="modal-body editor-body">
        <section class="form-section">
          <div class="section-heading compact">
            <div><h3>选择不同物品的图片</h3><span>每张图片会建立一条独立物品记录</span></div>
          </div>
          <div class="capture-actions">
            <label class="button secondary file-button">相机拍照<input id="batch-camera-input" type="file" accept="image/*" capture="environment" hidden></label>
            <label class="button secondary file-button">从图库多选<input id="batch-gallery-input" type="file" accept="image/*" multiple hidden></label>
          </div>
          <div class="batch-help">相机通常一次拍摄一张，可以重复点击继续拍摄；从图库可一次选择多张。请在下方分别确认每件物品的名称。</div>
          <div id="batch-image-drafts" class="batch-image-drafts"></div>
        </section>

        <section class="form-section form-grid">
          <div class="section-heading compact span-2"><div><h3>统一设置</h3><span>以下内容将应用到本次全部物品</span></div></div>

          <label class="field span-2"><span>物品状态</span><select name="status">${catalogOptions('status', '收藏中')}</select></label>
          <label class="field span-2"><span>存放位置</span><select name="locationId">${locationOptions('')}</select></label>

          <div class="field span-2">
            <span>作品 / IP（可多选）</span>
            <div class="multi-select-dropdown">
              <button id="batch-ip-toggle" type="button" class="multi-select-toggle">
                <span id="batch-ip-summary">${escapeHtml(selectedIpsSummary(selectedIps))}</span><span>⌄</span>
              </button>
              <div id="batch-ip-panel" class="multi-select-panel" hidden>
                <label class="search-box compact-search"><span>⌕</span><input id="batch-ip-search" type="search" placeholder="搜索作品 / IP"></label>
                <div id="batch-ip-options" class="multi-choice-list"></div>
              </div>
            </div>
          </div>

          <label class="field span-2"><span>物品类型</span><select name="type">${catalogOptions('type', '')}</select></label>
        </section>
      </div>

      <div class="modal-actions sticky-bottom">
        <button type="button" class="button secondary" data-close-modal>取消</button>
        <button id="batch-add-submit" type="submit" class="button primary" disabled>创建 0 条物品</button>
      </div>
    </form>
  `, { wide: true });

  function updateSubmit() {
    const button = modal.root.querySelector('#batch-add-submit');
    button.disabled = drafts.length === 0;
    button.textContent = `创建 ${drafts.length} 条物品`;
  }

  function renderDrafts() {
    const container = modal.root.querySelector('#batch-image-drafts');
    if (!drafts.length) {
      container.innerHTML = '<div class="media-empty">尚未选择图片。</div>';
      updateSubmit();
      return;
    }
    container.innerHTML = drafts.map((draft, index) => `
      <article class="batch-image-row" data-batch-draft="${draft.id}">
        <img src="${draft.previewUrl}" alt="物品 ${index + 1}">
        <div class="batch-image-fields">
          <label class="field"><span>物品 ${index + 1} 名称 *</span><input data-batch-name="${draft.id}" maxlength="160" value="${escapeHtml(draft.name)}" placeholder="填写角色、版本或款式"></label>
          <span>${escapeHtml(draft.file.name || '相机照片')} · 默认数量 1、价格 0</span>
        </div>
        <button type="button" class="media-remove batch-remove" data-remove-batch="${draft.id}" aria-label="移除图片">×</button>
      </article>
    `).join('');

    container.querySelectorAll('[data-batch-name]').forEach(input => {
      input.addEventListener('input', () => {
        const draft = drafts.find(entry => entry.id === input.dataset.batchName);
        if (draft) draft.name = input.value;
      });
    });
    container.querySelectorAll('[data-remove-batch]').forEach(button => {
      button.addEventListener('click', () => {
        const index = drafts.findIndex(entry => entry.id === button.dataset.removeBatch);
        if (index >= 0) drafts.splice(index, 1);
        renderDrafts();
      });
    });
    updateSubmit();
  }

  function renderIps() {
    renderSharedIpChoices(
      modal.root.querySelector('#batch-ip-options'),
      selectedIps,
      modal.root.querySelector('#batch-ip-search').value,
      () => {
        modal.root.querySelector('#batch-ip-summary').textContent = selectedIpsSummary(selectedIps);
      }
    );
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name));
    for (const file of files) {
      const index = drafts.length;
      drafts.push({
        id: makeId(),
        file,
        name: suggestedBatchName(file, index),
        previewUrl: blobUrl(file)
      });
    }
    renderDrafts();
  }

  modal.root.querySelector('#batch-camera-input').addEventListener('change', async event => {
    await addFiles(event.target.files);
    event.target.value = '';
  });
  modal.root.querySelector('#batch-gallery-input').addEventListener('change', async event => {
    await addFiles(event.target.files);
    event.target.value = '';
  });
  modal.root.querySelector('#batch-ip-toggle').addEventListener('click', () => {
    const panel = modal.root.querySelector('#batch-ip-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderIps();
      modal.root.querySelector('#batch-ip-search').focus();
    }
  });
  modal.root.querySelector('#batch-ip-search').addEventListener('input', renderIps);

  renderDrafts();
  renderIps();

  modal.root.querySelector('#batch-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!drafts.length) {
      toast('请先拍照或选择图片', 'error');
      return;
    }
    const missingIndex = drafts.findIndex(draft => !String(draft.name || '').trim());
    if (missingIndex >= 0) {
      toast(`请填写物品 ${missingIndex + 1} 的名称`, 'error');
      modal.root.querySelector(`[data-batch-name="${drafts[missingIndex].id}"]`)?.focus();
      return;
    }

    const formData = new FormData(event.currentTarget);
    const shared = {
      status: String(formData.get('status') || '收藏中'),
      locationId: String(formData.get('locationId') || ''),
      ips: [...selectedIps],
      type: String(formData.get('type') || '').trim()
    };

    setLoading(true, '正在批量建立物品…');
    try {
      const bundles = [];
      const baseTime = Date.now();
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        updateLoading('正在处理图片与缩略图…', `${index + 1}/${drafts.length}`);
        const itemId = makeId();
        const mediaId = makeId();
        const thumbnailBlob = await createThumbnailBlob(draft.file);
        const timestamp = new Date(baseTime + index).toISOString();

        bundles.push({
          item: {
            id: itemId,
            name: String(draft.name).trim(),
            quantity: 1,
            price: 0,
            currency: 'CNY',
            remark: '',
            status: shared.status,
            locationId: shared.locationId,
            ips: shared.ips,
            ip: shared.ips[0] || '',
            type: shared.type,
            tags: [],
            legacyId: '',
            createdAt: timestamp,
            updatedAt: timestamp,
            coverMediaId: mediaId
          },
          mediaToPut: [{
            id: mediaId,
            itemId,
            order: 0,
            isCover: true,
            originalBlob: draft.file,
            thumbnailBlob,
            originalName: draft.file.name || `image-${mediaId}`,
            mimeType: draft.file.type || 'application/octet-stream',
            originalSize: draft.file.size,
            thumbnailSize: thumbnailBlob.size,
            availability: 'full',
            createdAt: timestamp,
            updatedAt: timestamp
          }]
        });
      }

      const chunkSize = 20;
      for (let offset = 0; offset < bundles.length; offset += chunkSize) {
        const chunk = bundles.slice(offset, offset + chunkSize);
        updateLoading('正在写入本地数据库…', `${Math.min(offset + chunk.length, bundles.length)}/${bundles.length}`);
        await saveManyItemBundles(chunk);
      }
      await reloadData();
      modal.close();
      state.bulkMode = false;
      state.selectedItemIds.clear();
      quickAdd.hidden = false;
      optionManagerButton.hidden = false;
      renderItemsView();
      toast(`已批量创建 ${bundles.length} 条物品`, 'success', 4200);
    } catch (error) {
      console.error(error);
      toast(`批量添加失败：${error.message}`, 'error', 5200);
    } finally {
      setLoading(false);
    }
  });
}

async function openBatchEditSelected() {
  const selectedItems = state.items.filter(item => state.selectedItemIds.has(item.id));
  if (!selectedItems.length) {
    toast('请先选择需要编辑的物品', 'error');
    return;
  }

  const selectedIps = new Set();
  const modal = openModal(`
    <form id="batch-edit-form" class="editor-form">
      <div class="modal-header sticky">
        <div><div class="eyebrow">BATCH EDIT</div><h2>批量编辑 ${selectedItems.length} 项</h2></div>
        <button type="button" class="icon-button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <div class="batch-edit-note">只会修改左侧已勾选的字段；未勾选的内容保持原样。</div>

        <section class="batch-edit-section">
          <label class="batch-apply-toggle"><input id="apply-batch-ip" type="checkbox"><span>修改作品 / IP</span></label>
          <div class="batch-edit-controls" data-batch-control="ip">
            <label class="field"><span>处理方式</span><select id="batch-ip-mode">
              <option value="replace">替换为所选 IP</option>
              <option value="append">追加所选 IP</option>
              <option value="remove">移除所选 IP</option>
              <option value="clear">清空全部 IP</option>
            </select></label>
            <div class="field">
              <span>选择作品 / IP</span>
              <div class="multi-select-dropdown">
                <button id="batch-edit-ip-toggle" type="button" class="multi-select-toggle">
                  <span id="batch-edit-ip-summary">${escapeHtml(selectedIpsSummary(selectedIps))}</span><span>⌄</span>
                </button>
                <div id="batch-edit-ip-panel" class="multi-select-panel" hidden>
                  <label class="search-box compact-search"><span>⌕</span><input id="batch-edit-ip-search" type="search" placeholder="搜索作品 / IP"></label>
                  <div id="batch-edit-ip-options" class="multi-choice-list"></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="batch-edit-section">
          <label class="batch-apply-toggle"><input id="apply-batch-status" type="checkbox"><span>修改物品状态</span></label>
          <label class="field batch-edit-controls" data-batch-control="status"><span>新状态</span><select id="batch-edit-status">${catalogOptions('status', '')}</select></label>
        </section>

        <section class="batch-edit-section">
          <label class="batch-apply-toggle"><input id="apply-batch-location" type="checkbox"><span>修改存放位置</span></label>
          <label class="field batch-edit-controls" data-batch-control="location"><span>新位置</span><select id="batch-edit-location">${locationOptions('')}</select></label>
        </section>

        <section class="batch-edit-section">
          <label class="batch-apply-toggle"><input id="apply-batch-type" type="checkbox"><span>修改物品类型</span></label>
          <label class="field batch-edit-controls" data-batch-control="type"><span>新类型</span><select id="batch-edit-type">${catalogOptions('type', '')}</select></label>
        </section>
      </div>

      <div class="modal-actions sticky-bottom">
        <button type="button" class="button secondary" data-close-modal>取消</button>
        <button type="submit" class="button primary">应用到 ${selectedItems.length} 项</button>
      </div>
    </form>
  `, { wide: true });

  function refreshDisabledStates() {
    const mappings = [
      ['apply-batch-ip', 'ip'],
      ['apply-batch-status', 'status'],
      ['apply-batch-location', 'location'],
      ['apply-batch-type', 'type']
    ];
    for (const [checkboxId, control] of mappings) {
      const enabled = modal.root.querySelector(`#${checkboxId}`).checked;
      modal.root.querySelectorAll(`[data-batch-control="${control}"] input, [data-batch-control="${control}"] select, [data-batch-control="${control}"] button`).forEach(node => {
        node.disabled = !enabled;
      });
      modal.root.querySelector(`[data-batch-control="${control}"]`)?.classList.toggle('disabled-controls', !enabled);
    }
    const mode = modal.root.querySelector('#batch-ip-mode').value;
    modal.root.querySelector('#batch-edit-ip-toggle').disabled = !modal.root.querySelector('#apply-batch-ip').checked || mode === 'clear';
  }

  function renderIps() {
    renderSharedIpChoices(
      modal.root.querySelector('#batch-edit-ip-options'),
      selectedIps,
      modal.root.querySelector('#batch-edit-ip-search').value,
      () => {
        modal.root.querySelector('#batch-edit-ip-summary').textContent = selectedIpsSummary(selectedIps);
      }
    );
  }

  ['apply-batch-ip', 'apply-batch-status', 'apply-batch-location', 'apply-batch-type'].forEach(id => {
    modal.root.querySelector(`#${id}`).addEventListener('change', refreshDisabledStates);
  });
  modal.root.querySelector('#batch-ip-mode').addEventListener('change', refreshDisabledStates);
  modal.root.querySelector('#batch-edit-ip-toggle').addEventListener('click', () => {
    const panel = modal.root.querySelector('#batch-edit-ip-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderIps();
      modal.root.querySelector('#batch-edit-ip-search').focus();
    }
  });
  modal.root.querySelector('#batch-edit-ip-search').addEventListener('input', renderIps);

  renderIps();
  refreshDisabledStates();

  modal.root.querySelector('#batch-edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const applyIp = modal.root.querySelector('#apply-batch-ip').checked;
    const applyStatus = modal.root.querySelector('#apply-batch-status').checked;
    const applyLocation = modal.root.querySelector('#apply-batch-location').checked;
    const applyType = modal.root.querySelector('#apply-batch-type').checked;

    if (!applyIp && !applyStatus && !applyLocation && !applyType) {
      toast('请至少勾选一个需要修改的字段', 'error');
      return;
    }

    const ipMode = modal.root.querySelector('#batch-ip-mode').value;
    if (applyIp && ipMode !== 'clear' && selectedIps.size === 0) {
      toast('请选择至少一个作品 / IP，或使用“清空全部 IP”', 'error');
      return;
    }

    const newStatus = modal.root.querySelector('#batch-edit-status').value;
    const newLocation = modal.root.querySelector('#batch-edit-location').value;
    const newType = modal.root.querySelector('#batch-edit-type').value;
    const ipValues = [...selectedIps];
    const now = new Date().toISOString();

    const updatedItems = selectedItems.map(item => {
      const updated = { ...item, updatedAt: now };
      if (applyIp) {
        const current = itemIps(item);
        if (ipMode === 'replace') updated.ips = [...ipValues];
        if (ipMode === 'append') updated.ips = [...new Set([...current, ...ipValues])];
        if (ipMode === 'remove') updated.ips = current.filter(value => !selectedIps.has(value));
        if (ipMode === 'clear') updated.ips = [];
        updated.ip = updated.ips[0] || '';
      }
      if (applyStatus) updated.status = newStatus;
      if (applyLocation) updated.locationId = newLocation;
      if (applyType) updated.type = newType;
      return updated;
    });

    setLoading(true, '正在批量更新物品…');
    try {
      await putManyItems(updatedItems);
      await reloadData();
      modal.close();
      state.bulkMode = false;
      state.selectedItemIds.clear();
      quickAdd.hidden = false;
      optionManagerButton.hidden = false;
      renderItemsView();
      toast(`已批量更新 ${updatedItems.length} 项`, 'success', 4200);
    } catch (error) {
      console.error(error);
      toast(`批量编辑失败：${error.message}`, 'error', 5200);
    } finally {
      setLoading(false);
    }
  });
}


async function openBatchDeleteSelected() {
  const selectedItems = state.items.filter(item => state.selectedItemIds.has(item.id));
  if (!selectedItems.length) {
    toast('请先选择需要删除的物品', 'error');
    return;
  }

  const preview = selectedItems.slice(0, 8);
  const remaining = Math.max(0, selectedItems.length - preview.length);
  const modal = openModal(`
    <form id="batch-delete-form">
      <div class="modal-header sticky danger-header">
        <div><div class="eyebrow">PERMANENT DELETE</div><h2>批量删除 ${selectedItems.length} 项</h2></div>
        <button type="button" class="icon-button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <section class="batch-delete-warning">
          <strong>物品记录、原图和缩略图将被永久删除。</strong>
          <p>此操作不能撤销。大量卖货后删除前，建议先导出一次完整原图备份。</p>
        </section>

        <section class="batch-delete-preview">
          ${preview.map(item => `
            <div class="batch-delete-preview-row">
              <span>${escapeHtml(item.name || '未命名')}</span>
              <small>${escapeHtml(locationPath(item.locationId))} · ${escapeHtml(item.status || '未指定状态')}</small>
            </div>
          `).join('')}
          ${remaining ? `<div class="batch-delete-more">另有 ${remaining} 项未展开</div>` : ''}
        </section>

        <label class="batch-delete-confirm-check">
          <input id="batch-delete-check" type="checkbox">
          <span>我确认这些物品已经出售或不再需要，并理解图片也会一并删除。</span>
        </label>

        <label class="field">
          <span>请输入“删除”以继续</span>
          <input id="batch-delete-phrase" autocomplete="off" placeholder="删除">
        </label>
      </div>

      <div class="modal-actions sticky-bottom">
        <button type="button" class="button secondary" data-close-modal>取消</button>
        <button id="batch-delete-confirm" type="submit" class="button danger" disabled>永久删除 ${selectedItems.length} 项</button>
      </div>
    </form>
  `, { wide: true });

  const check = modal.root.querySelector('#batch-delete-check');
  const phrase = modal.root.querySelector('#batch-delete-phrase');
  const confirmButton = modal.root.querySelector('#batch-delete-confirm');

  function refreshConfirmState() {
    confirmButton.disabled = !(check.checked && phrase.value.trim() === '删除');
  }

  check.addEventListener('change', refreshConfirmState);
  phrase.addEventListener('input', refreshConfirmState);

  modal.root.querySelector('#batch-delete-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (confirmButton.disabled) return;

    const ids = selectedItems.map(item => item.id);
    setLoading(true, `正在永久删除 ${ids.length} 项…`);
    try {
      const result = await deleteManyItemsCascade(ids);
      await reloadData();
      modal.close();
      state.bulkMode = false;
      state.selectedItemIds.clear();
      quickAdd.hidden = false;
      optionManagerButton.hidden = false;
      renderItemsView();
      toast(`已删除 ${result.deletedItems} 项物品及其图片`, 'success', 4600);
    } catch (error) {
      console.error(error);
      toast(`批量删除失败：${error.message}`, 'error', 5200);
    } finally {
      setLoading(false);
    }
  });
}

async function openItemEditor(itemId = null) {
  const existingItem = itemId ? await getOne('items', itemId) : null;
  const existingMedia = itemId ? await getMediaForItem(itemId) : [];
  const draftMedia = existingMedia.map(record => ({
    ...record,
    isNew: false,
    deleted: false,
    previewUrl: blobUrl(record.thumbnailBlob || record.originalBlob)
  }));

  const item = existingItem || {
    id: makeId(),
    name: '',
    quantity: 1,
    price: 0,
    currency: 'CNY',
    remark: '',
    status: '收藏中',
    locationId: '',
    ips: [],
    ip: '',
    type: '',
    tags: [],
    legacyId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    coverMediaId: null
  };

  const selectedIps = new Set(itemIps(item));

  const modal = openModal(`
    <form id="item-editor-form" class="editor-form">
      <div class="modal-header sticky">
        <div><div class="eyebrow">${existingItem ? 'EDIT ITEM' : 'NEW ITEM'}</div><h2>${existingItem ? '编辑物品' : '新增物品'}</h2></div>
        <button type="button" class="icon-button" data-close-modal>×</button>
      </div>

      <div class="modal-body editor-body">
        <section class="form-section">
          <div class="section-heading compact"><div><h3>图片</h3><span>可拍照或从图库多选</span></div></div>
          <div class="capture-actions">
            <label class="button secondary file-button">相机拍照<input id="camera-input" type="file" accept="image/*" capture="environment" hidden></label>
            <label class="button secondary file-button">从图库选择<input id="gallery-input" type="file" accept="image/*" multiple hidden></label>
          </div>
          <div id="media-drafts" class="media-drafts"></div>
        </section>

        <section class="form-section form-grid">
          <label class="field span-2"><span>名称 *</span><input name="name" required maxlength="160" value="${escapeHtml(item.name)}" placeholder="例如：音符 NYON 吧唧"></label>
          <label class="field"><span>数量</span><input name="quantity" type="number" min="0" step="1" value="${Number(item.quantity || 1)}"></label>
          <label class="field"><span>单价</span><input name="price" type="number" min="0" step="0.01" value="${Number(item.price || 0)}"></label>
          <label class="field"><span>币种</span><select name="currency">
            ${['CNY','JPY','USD','EUR','KRW'].map(value => `<option ${item.currency === value ? 'selected' : ''}>${value}</option>`).join('')}
          </select></label>

          <label class="field">
            <span>物品状态</span>
            <div class="select-with-action">
              <select name="status" id="editor-status-select">${catalogOptions('status', item.status || '收藏中')}</select>
              <button type="button" class="mini-button catalog-plus" data-quick-catalog="status" aria-label="添加物品状态">＋</button>
            </div>
            <div class="quick-catalog-add with-color" data-quick-panel="status" hidden>
              <input maxlength="100" placeholder="新增物品状态">
              <input class="color-input compact" type="color" value="#9B9B9B" aria-label="状态颜色">
              <button type="button" class="mini-button" data-confirm-quick-catalog="status">添加</button>
            </div>
          </label>

          <label class="field span-2"><span>存放位置</span><select name="locationId">${locationOptions(item.locationId)}</select></label>

          <div class="field span-2">
            <span>作品 / IP（可多选）</span>
            <div class="multi-select-dropdown">
              <button id="ip-picker-toggle" type="button" class="multi-select-toggle">
                <span id="ip-picker-summary">${escapeHtml(selectedIpsSummary(selectedIps))}</span>
                <span>⌄</span>
              </button>
              <div id="ip-picker-panel" class="multi-select-panel" hidden>
                <label class="search-box compact-search">
                  <span>⌕</span>
                  <input id="ip-picker-search" type="search" placeholder="搜索作品 / IP">
                </label>
                <div id="ip-picker-options" class="multi-choice-list"></div>
              </div>
            </div>
            <div class="quick-add-row">
              <button type="button" class="mini-button" data-quick-catalog="ip">＋ 新增作品 / IP</button>
              <button type="button" class="mini-button" data-open-catalog-manager="ip">管理 IP 词库</button>
            </div>
            <div class="quick-catalog-add" data-quick-panel="ip" hidden>
              <input maxlength="100" placeholder="新增作品 / IP">
              <button type="button" class="mini-button" data-confirm-quick-catalog="ip">添加并选中</button>
            </div>
          </div>

          <label class="field span-2">
            <span>物品类型</span>
            <div class="select-with-action">
              <select name="type" id="editor-type-select">${catalogOptions('type', item.type)}</select>
              <button type="button" class="mini-button catalog-plus" data-quick-catalog="type" aria-label="添加物品类型">＋</button>
            </div>
            <div class="quick-catalog-add" data-quick-panel="type" hidden>
              <input maxlength="100" placeholder="新增物品类型">
              <button type="button" class="mini-button" data-confirm-quick-catalog="type">添加</button>
            </div>
          </label>

          <label class="field span-2"><span>标签</span><input name="tags" value="${escapeHtml((item.tags || []).join('，'))}" placeholder="多个标签用逗号分隔"></label>
          <label class="field span-2"><span>备注</span><textarea name="remark" rows="4" placeholder="购买渠道、版本、瑕疵、交换信息等">${escapeHtml(item.remark)}</textarea></label>
        </section>
      </div>

      <div class="modal-actions sticky-bottom">
        <button type="button" class="button secondary" data-close-modal>取消</button>
        <button type="submit" class="button primary">保存</button>
      </div>
    </form>
  `, { wide: true });

  function visibleDrafts() {
    return draftMedia.filter(media => !media.deleted);
  }

  function renderDraftMedia() {
    const container = modal.root.querySelector('#media-drafts');
    const visible = visibleDrafts();
    if (!visible.length) {
      container.innerHTML = '<div class="media-empty">尚未添加图片。建议保留清晰正面图作为封面。</div>';
      return;
    }
    container.innerHTML = visible.map((media, index) => `
      <div class="media-draft" data-media-id="${media.id}">
        <img src="${media.previewUrl}" alt="图片 ${index + 1}">
        <label class="cover-choice"><input type="radio" name="cover-media" value="${media.id}" ${(item.coverMediaId ? item.coverMediaId === media.id : index === 0) ? 'checked' : ''}>封面</label>
        <button type="button" class="media-remove" data-remove-media="${media.id}" aria-label="删除图片">×</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-remove-media]').forEach(button => {
      button.addEventListener('click', () => {
        const target = draftMedia.find(media => media.id === button.dataset.removeMedia);
        if (target) target.deleted = true;
        renderDraftMedia();
      });
    });
  }

  function renderIpOptions(query = '') {
    const container = modal.root.querySelector('#ip-picker-options');
    const allNames = [...new Set([...catalogNames('ip'), ...selectedIps])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    const visible = allNames.filter(name => !normalizedQuery || name.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
    container.innerHTML = visible.length
      ? visible.map(name => `
          <label class="multi-choice-row">
            <input type="checkbox" value="${escapeHtml(name)}" ${selectedIps.has(name) ? 'checked' : ''}>
            <span>${escapeHtml(name)}</span>
          </label>`).join('')
      : '<div class="catalog-empty-text padded">没有匹配项目</div>';

    container.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) selectedIps.add(input.value);
        else selectedIps.delete(input.value);
        modal.root.querySelector('#ip-picker-summary').textContent = selectedIpsSummary(selectedIps);
      });
    });
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name));
    for (const file of files) {
      const id = makeId();
      draftMedia.push({
        id,
        itemId: item.id,
        order: draftMedia.length,
        isNew: true,
        deleted: false,
        sourceBlob: file,
        originalName: file.name || `image-${id}`,
        mimeType: file.type || 'application/octet-stream',
        originalSize: file.size,
        availability: 'full',
        createdAt: new Date().toISOString(),
        previewUrl: blobUrl(file)
      });
    }
    renderDraftMedia();
  }

  modal.root.querySelector('#camera-input').addEventListener('change', async event => {
    await addFiles(event.target.files);
    event.target.value = '';
  });
  modal.root.querySelector('#gallery-input').addEventListener('change', async event => {
    await addFiles(event.target.files);
    event.target.value = '';
  });

  modal.root.querySelector('#ip-picker-toggle').addEventListener('click', () => {
    const panel = modal.root.querySelector('#ip-picker-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderIpOptions(modal.root.querySelector('#ip-picker-search').value);
      modal.root.querySelector('#ip-picker-search').focus();
    }
  });
  modal.root.querySelector('#ip-picker-search').addEventListener('input', event => renderIpOptions(event.target.value));

  modal.root.querySelectorAll('[data-quick-catalog]').forEach(button => {
    button.addEventListener('click', () => {
      const panel = modal.root.querySelector(`[data-quick-panel="${button.dataset.quickCatalog}"]`);
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector('input:not([type="color"])')?.focus();
    });
  });

  modal.root.querySelectorAll('[data-confirm-quick-catalog]').forEach(button => {
    button.addEventListener('click', async () => {
      const kind = button.dataset.confirmQuickCatalog;
      const panel = modal.root.querySelector(`[data-quick-panel="${kind}"]`);
      const input = panel.querySelector('input:not([type="color"])');
      const color = panel.querySelector('input[type="color"]')?.value || '';
      try {
        const record = await createCatalogEntry(kind, input.value, color);
        if (kind === 'ip') {
          selectedIps.add(record.name);
          renderIpOptions(modal.root.querySelector('#ip-picker-search').value);
          modal.root.querySelector('#ip-picker-summary').textContent = selectedIpsSummary(selectedIps);
        } else {
          const select = modal.root.querySelector(kind === 'status' ? '#editor-status-select' : '#editor-type-select');
          select.innerHTML = catalogOptions(kind, record.name);
          select.value = record.name;
        }
        input.value = '';
        panel.hidden = true;
        toast(`已加入${catalogLabel(kind)}：${record.name}`, 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  modal.root.querySelector('[data-open-catalog-manager="ip"]').addEventListener('click', () => {
    toast('请先保存当前物品，再从主界面的“管理分类与颜色”进入完整词库管理。');
  });

  renderDraftMedia();
  renderIpOptions();

  modal.root.querySelector('#item-editor-form').addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get('name') || '').trim();
    if (!name) {
      toast('请填写物品名称', 'error');
      return;
    }

    setLoading(true, existingItem ? '正在保存修改…' : '正在新增物品…');
    try {
      const activeMedia = visibleDrafts();
      const selectedCover = modal.root.querySelector('input[name="cover-media"]:checked')?.value || activeMedia[0]?.id || null;
      const mediaToPut = [];

      for (let index = 0; index < activeMedia.length; index += 1) {
        const media = activeMedia[index];
        if (media.isNew) {
          updateLoading('正在处理图片…', `${index + 1}/${activeMedia.length}`);
          const thumbnailBlob = await createThumbnailBlob(media.sourceBlob);
          mediaToPut.push({
            id: media.id,
            itemId: item.id,
            order: index,
            isCover: media.id === selectedCover,
            originalBlob: media.sourceBlob,
            thumbnailBlob,
            originalName: media.originalName,
            mimeType: media.mimeType,
            originalSize: media.sourceBlob.size,
            thumbnailSize: thumbnailBlob.size,
            availability: 'full',
            createdAt: media.createdAt,
            updatedAt: new Date().toISOString()
          });
        } else {
          const clean = { ...media };
          delete clean.previewUrl;
          delete clean.isNew;
          delete clean.deleted;
          clean.order = index;
          clean.isCover = clean.id === selectedCover;
          clean.updatedAt = new Date().toISOString();
          mediaToPut.push(clean);
        }
      }

      const tags = String(formData.get('tags') || '')
        .split(/[,，;；]/)
        .map(value => value.trim())
        .filter(Boolean);
      const ips = [...selectedIps];
      const now = new Date().toISOString();
      const savedItem = {
        ...item,
        name,
        quantity: Math.max(0, Number(formData.get('quantity') || 0)),
        price: Math.max(0, Number(formData.get('price') || 0)),
        currency: String(formData.get('currency') || 'CNY'),
        status: String(formData.get('status') || '收藏中'),
        locationId: String(formData.get('locationId') || ''),
        ips,
        ip: ips[0] || '',
        type: String(formData.get('type') || '').trim(),
        tags,
        remark: String(formData.get('remark') || '').trim(),
        coverMediaId: selectedCover,
        updatedAt: now,
        createdAt: item.createdAt || now
      };
      const deletedIds = draftMedia.filter(media => media.deleted && !media.isNew).map(media => media.id);
      await saveItemBundle(savedItem, mediaToPut, deletedIds);
      await reloadData();
      modal.close();
      renderCurrentTab();
      toast(existingItem ? '物品已更新' : '物品已新增', 'success');
    } catch (error) {
      console.error(error);
      toast(`保存失败：${error.message}`, 'error', 5000);
    } finally {
      setLoading(false);
    }
  });
}

async function openItemDetail(itemId) {
  const item = await getOne('items', itemId);
  if (!item) return;
  const media = await getMediaForItem(itemId);
  const imageUrls = media.map(record => blobUrl(record.originalBlob || record.thumbnailBlob));
  const ips = itemIps(item);
  const modal = openModal(`
    <div class="modal-header sticky">
      <div><div class="eyebrow">ITEM DETAIL</div><h2>${escapeHtml(item.name)}</h2></div>
      <button class="icon-button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      <div class="detail-gallery">
        ${imageUrls.length ? imageUrls.map((url, index) => `<button class="detail-image-button" data-image-index="${index}"><img src="${url}" alt="${escapeHtml(item.name)} 图片 ${index + 1}"></button>`).join('') : '<div class="detail-no-image">无图片</div>'}
      </div>
      <section class="detail-panel" style="--detail-location-color:${locationColor(item.locationId) || '#D8D5D0'}">
        <div class="detail-key"><span>数量</span><strong>${formatNumber(item.quantity || 0)}</strong></div>
        <div class="detail-key"><span>单价</span><strong>${formatMoney(item.price, item.currency)}</strong></div>
        <div class="detail-key"><span>存放位置</span><strong><span class="color-dot" style="--dot-color:${locationColor(item.locationId) || '#D8D5D0'}"></span>${escapeHtml(locationPath(item.locationId))}</strong></div>
        <div class="detail-key"><span>物品状态</span><strong><span class="color-dot" style="--dot-color:${statusColor(item.status)}"></span>${escapeHtml(item.status || '—')}</strong></div>
        <div class="detail-key"><span>作品 / IP</span><strong>${escapeHtml(ips.join('、') || '—')}</strong></div>
        <div class="detail-key"><span>物品类型</span><strong>${escapeHtml(item.type || '—')}</strong></div>
        <div class="detail-key"><span>录入时间</span><strong>${formatDate(item.createdAt)}</strong></div>
        ${(item.tags || []).length ? `<div class="detail-tags">${item.tags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        ${item.remark ? `<div class="detail-remark"><span>备注</span><p>${escapeHtml(item.remark)}</p></div>` : ''}
        ${item.legacyId ? `<div class="legacy-id">原物屿 ID：${escapeHtml(item.legacyId)}</div>` : ''}
      </section>
    </div>
    <div class="modal-actions sticky-bottom three">
      <button class="button danger ghost" data-delete-item>删除</button>
      <button class="button secondary" data-duplicate-item>复制</button>
      <button class="button primary" data-edit-item>编辑</button>
    </div>
  `, { wide: true });

  modal.root.querySelectorAll('[data-image-index]').forEach(button => {
    button.addEventListener('click', () => openImageViewer(imageUrls, Number(button.dataset.imageIndex), item.name));
  });
  modal.root.querySelector('[data-edit-item]').addEventListener('click', () => {
    modal.close();
    openItemEditor(itemId);
  });
  modal.root.querySelector('[data-duplicate-item]').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '复制物品',
      message: '将复制文字信息。为了避免大量重复文件，图片不会自动复制，可在编辑页面重新选择。',
      confirmText: '复制'
    });
    if (!confirmed) return;
    const now = new Date().toISOString();
    const copy = {
      ...item,
      id: makeId(),
      name: `${item.name}（副本）`,
      legacyId: '',
      coverMediaId: null,
      createdAt: now,
      updatedAt: now
    };
    await putOne('items', copy);
    await reloadData();
    modal.close();
    renderCurrentTab();
    toast('已复制物品，可继续编辑并添加图片', 'success');
  });
  modal.root.querySelector('[data-delete-item]').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除物品',
      message: `将永久删除“${item.name}”及其全部本地图片。建议先确认已有备份。`,
      confirmText: '永久删除',
      danger: true
    });
    if (!confirmed) return;
    await deleteItemCascade(itemId);
    await reloadData();
    modal.close();
    renderCurrentTab();
    toast('物品已删除');
  });
}

function openImageViewer(urls, startIndex, title) {
  let index = startIndex;
  const modal = openModal(`
    <div class="image-viewer">
      <button class="icon-button viewer-close" data-close-modal>×</button>
      <button class="viewer-arrow left" data-prev aria-label="上一张">‹</button>
      <img data-viewer-image alt="${escapeHtml(title)}">
      <button class="viewer-arrow right" data-next aria-label="下一张">›</button>
      <div class="viewer-count" data-viewer-count></div>
    </div>
  `, { wide: true });
  function update() {
    modal.root.querySelector('[data-viewer-image]').src = urls[index];
    modal.root.querySelector('[data-viewer-count]').textContent = `${index + 1} / ${urls.length}`;
    modal.root.querySelector('[data-prev]').hidden = urls.length <= 1;
    modal.root.querySelector('[data-next]').hidden = urls.length <= 1;
  }
  modal.root.querySelector('[data-prev]').addEventListener('click', () => {
    index = (index - 1 + urls.length) % urls.length;
    update();
  });
  modal.root.querySelector('[data-next]').addEventListener('click', () => {
    index = (index + 1) % urls.length;
    update();
  });
  update();
}

function locationChildrenMap() {
  const map = new Map();
  for (const location of state.locations) {
    const parent = location.parentId || '__root__';
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent).push(location);
  }
  for (const children of map.values()) {
    children.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  }
  return map;
}

function locationTreeHtml() {
  const childrenMap = locationChildrenMap();
  const itemCounts = new Map();
  for (const item of state.items) itemCounts.set(item.locationId, (itemCounts.get(item.locationId) || 0) + 1);

  function descendantCount(id) {
    let total = itemCounts.get(id) || 0;
    for (const child of childrenMap.get(id) || []) total += descendantCount(child.id);
    return total;
  }

  function walk(parentId, depth) {
    return (childrenMap.get(parentId) || []).map(location => `
      <div class="location-row" style="--depth:${depth}" data-location-id="${location.id}">
        <div class="location-main">
          <span class="location-indent"></span>
          <span class="color-dot large" style="--dot-color:${locationColor(location.id) || '#B8B4AE'}"></span>
          <div><strong>${escapeHtml(location.name)}</strong><span>${descendantCount(location.id)} 条物品</span></div>
        </div>
        <div class="row-actions">
          <button class="mini-button" data-add-child="${location.id}">＋子位置</button>
          <button class="mini-button" data-rename-location="${location.id}">编辑</button>
          <button class="mini-button danger-text" data-delete-location="${location.id}">删除</button>
        </div>
      </div>
      ${walk(location.id, depth + 1)}
    `).join('');
  }
  return walk('__root__', 0);
}

function renderLocationsView() {
  mainView.innerHTML = `
    <section class="info-card">
      <div class="info-icon">⌂</div>
      <div><h2>分层管理存放位置</h2><p>可以建立“城市 → 房间 → 柜子 → 收纳盒”等层级，并设置物品卡片外框颜色。子位置可继承上级颜色。</p></div>
    </section>
    <section class="location-tree">
      ${state.locations.length ? locationTreeHtml() : '<div class="empty-state compact"><p>尚未创建位置。</p></div>'}
    </section>
    <button id="add-root-location" class="button primary full-width">新增一级位置</button>
    <button id="open-location-color-manager" class="button secondary full-width">集中管理位置与颜色</button>
  `;

  mainView.querySelector('#add-root-location').addEventListener('click', () => openLocationEditor());
  mainView.querySelector('#open-location-color-manager').addEventListener('click', openLocationManager);
  mainView.querySelectorAll('[data-add-child]').forEach(button => button.addEventListener('click', () => openLocationEditor(null, button.dataset.addChild)));
  mainView.querySelectorAll('[data-rename-location]').forEach(button => {
    button.addEventListener('click', () => openLocationEditor(button.dataset.renameLocation));
  });
  mainView.querySelectorAll('[data-delete-location]').forEach(button => {
    button.addEventListener('click', () => deleteLocation(button.dataset.deleteLocation));
  });
}

async function openLocationEditor(locationId = null, parentId = null, returnToManager = false) {
  const existing = locationId ? await getOne('locations', locationId) : null;
  const currentColor = safeColor(existing?.color, '#B8B4AE');
  const modal = openModal(`
    <form id="location-form">
      <div class="modal-header"><div><div class="eyebrow">LOCATION</div><h2>${existing ? '编辑位置' : '新增位置'}</h2></div><button type="button" class="icon-button" data-close-modal>×</button></div>
      <div class="modal-body form-grid">
        <label class="field span-2"><span>位置名称 *</span><input name="name" required maxlength="80" value="${escapeHtml(existing?.name || '')}" placeholder="例如：展示柜第一层"></label>
        <label class="field span-2"><span>上级位置</span><select name="parentId">${locationOptions(existing?.parentId || parentId || '')}</select></label>
        <label class="field"><span>位置颜色</span><input name="color" type="color" value="${currentColor}"></label>
        <label class="check-row location-inherit-check"><input name="inheritColor" type="checkbox" ${existing?.color ? '' : 'checked'}><span>不单独设置，继承上级颜色</span></label>
      </div>
      <div class="modal-actions"><button type="button" class="button secondary" data-close-modal>取消</button><button class="button primary">保存</button></div>
    </form>
  `);
  modal.root.querySelector('#location-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    let selectedParent = String(form.get('parentId') || '') || null;
    if (existing && selectedParent === existing.id) selectedParent = existing.parentId || null;
    if (!name) return;
    const inheritColor = Boolean(form.get('inheritColor'));
    const now = new Date().toISOString();
    await putOne('locations', {
      ...(existing || {}),
      id: existing?.id || makeId(),
      name,
      parentId: selectedParent,
      color: inheritColor ? '' : safeColor(form.get('color'), '#B8B4AE'),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      order: existing?.order || state.locations.length + 1
    });
    await reloadData();
    modal.close();
    renderCurrentTab();
    toast(existing ? '位置已更新' : '位置已新增', 'success');
    if (returnToManager) openLocationManager();
  });
}

async function deleteLocation(locationId) {
  const location = state.locations.find(entry => entry.id === locationId);
  const hasChildren = state.locations.some(entry => entry.parentId === locationId);
  const used = state.items.some(item => item.locationId === locationId);
  if (hasChildren || used) {
    toast('该位置仍有子位置或物品，不能直接删除', 'error', 4200);
    return;
  }
  const confirmed = await confirmDialog({
    title: '删除位置',
    message: `确定删除“${location?.name || ''}”吗？`,
    confirmText: '删除',
    danger: true
  });
  if (!confirmed) return;
  await deleteOne('locations', locationId);
  await reloadData();
  renderLocationsView();
  toast('位置已删除');
}

function bytesText(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function storageInfo() {
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { usage: estimate.usage || 0, quota: estimate.quota || 0, persisted };
}

async function renderBackupView() {
  const media = await getAll('media');
  const originals = media.filter(record => record.originalBlob).length;
  const thumbnails = media.filter(record => record.thumbnailBlob).length;
  const info = await storageInfo();
  const percent = info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0;

  mainView.innerHTML = `
    <section class="storage-card">
      <div class="section-heading compact"><div><h2>本机数据</h2><span>${info.persisted ? '已请求持久存储' : '尚未确认持久存储'}</span></div></div>
      <div class="storage-meter"><span style="width:${percent}%"></span></div>
      <div class="storage-caption"><span>已使用 ${bytesText(info.usage)}</span><span>可用配额 ${bytesText(info.quota)}</span></div>
      <div class="backup-stats">
        <div><strong>${state.items.length}</strong><span>物品</span></div>
        <div><strong>${originals}</strong><span>原图</span></div>
        <div><strong>${thumbnails}</strong><span>缩略图</span></div>
      </div>
      <button id="request-persist" class="button secondary full-width">请求持久存储</button>
    </section>

    <section class="backup-option">
      <div><span class="option-tag">推荐</span><h2>完整原图备份</h2><p>包含全部文字数据、原始图片和缩略图，可完整恢复。适合定期保存到百度网盘。</p></div>
      <button id="export-full" class="button primary">导出完整备份</button>
    </section>

    <section class="backup-option">
      <div><h2>缩略图轻量备份</h2><p>包含全部文字数据与缩略图，文件更小；恢复后不能找回未包含的原图。</p></div>
      <button id="export-thumb" class="button secondary">导出轻量备份</button>
    </section>

    <section class="backup-option">
      <div><h2>导入与恢复</h2><p>支持本软件导出的 .gubackup 文件，以及 Windows 物屿迁移工具生成的备份。</p></div>
      <button id="choose-backup" class="button secondary">选择备份文件</button>
    </section>

    <section class="notice-card">
      <strong>备份原则</strong>
      <p>不要把 iPhone 本地数据库视为唯一副本。建议每次集中录入后生成轻量备份，每月或大量新增图片后生成完整原图备份。</p>
    </section>
  `;

  mainView.querySelector('#request-persist').addEventListener('click', requestPersistentStorage);
  mainView.querySelector('#export-full').addEventListener('click', () => exportBackup('full'));
  mainView.querySelector('#export-thumb').addEventListener('click', () => exportBackup('thumbnail'));
  mainView.querySelector('#choose-backup').addEventListener('click', () => backupFileInput.click());
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    toast('当前浏览器不提供持久存储接口；请坚持使用外部备份', 'error', 4500);
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    toast(granted ? '已获得持久存储保护' : '浏览器暂未授予持久存储；仍可正常使用，请定期备份', granted ? 'success' : 'default', 5000);
    renderBackupView();
  } catch (error) {
    toast(`请求失败：${error.message}`, 'error');
  }
}

function extensionForMedia(record) {
  const nameMatch = String(record.originalName || '').match(/\.([a-zA-Z0-9]{2,5})$/);
  if (nameMatch) return `.${nameMatch[1].toLowerCase()}`;
  const mapping = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif'
  };
  return mapping[record.mimeType] || '.bin';
}

async function sha256Text(text) {
  if (!crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportBackup(mode = 'full', prefix = 'Goods Paradise_谷子天国') {
  if (!window.JSZip) {
    toast('压缩组件未加载，请刷新页面后重试', 'error');
    return null;
  }
  setLoading(true, mode === 'full' ? '正在整理完整原图备份…' : '正在整理轻量备份…');
  try {
    const [items, locations, catalogs, mediaRecords] = await Promise.all([
      getAll('items'), getAll('locations'), getAll('catalogs'), getAll('media')
    ]);
    const zip = new JSZip();
    const mediaMeta = [];

    for (let index = 0; index < mediaRecords.length; index += 1) {
      const record = mediaRecords[index];
      updateLoading('正在打包图片…', `${index + 1}/${mediaRecords.length}`);
      const clean = { ...record };
      delete clean.originalBlob;
      delete clean.thumbnailBlob;
      clean.originalPath = null;
      clean.thumbnailPath = null;
      clean.originalIncluded = false;

      if (mode === 'full' && record.originalBlob) {
        clean.originalPath = `media/original/${record.id}${extensionForMedia(record)}`;
        clean.originalIncluded = true;
        zip.file(clean.originalPath, record.originalBlob);
      }
      if (record.thumbnailBlob) {
        clean.thumbnailPath = `media/thumbnail/${record.id}.jpg`;
        zip.file(clean.thumbnailPath, record.thumbnailBlob);
      } else if (record.originalBlob) {
        clean.thumbnailPath = `media/thumbnail/${record.id}${extensionForMedia(record)}`;
        zip.file(clean.thumbnailPath, record.originalBlob);
      }
      clean.availability = clean.originalIncluded ? 'full' : 'thumbnail-only';
      mediaMeta.push(clean);
    }

    const itemsJson = JSON.stringify(items, null, 2);
    const locationsJson = JSON.stringify(locations, null, 2);
    const catalogsJson = JSON.stringify(catalogs, null, 2);
    const mediaJson = JSON.stringify(mediaMeta, null, 2);
    zip.file('data/items.json', itemsJson);
    zip.file('data/locations.json', locationsJson);
    zip.file('data/catalogs.json', catalogsJson);
    zip.file('data/media.json', mediaJson);

    const manifest = {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      mode,
      counts: {
        items: items.length,
        locations: locations.length,
        catalogs: catalogs.length,
        media: mediaMeta.length,
        originals: mediaMeta.filter(record => record.originalIncluded).length,
        thumbnails: mediaMeta.filter(record => record.thumbnailPath).length
      },
      dataChecksums: {
        itemsSha256: await sha256Text(itemsJson),
        locationsSha256: await sha256Text(locationsJson),
        catalogsSha256: await sha256Text(catalogsJson),
        mediaSha256: await sha256Text(mediaJson)
      }
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    updateLoading('正在压缩备份文件…', '请不要关闭页面');
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: mode === 'full' ? 4 : 7 }, mimeType: 'application/zip' },
      metadata => updateLoading('正在压缩备份文件…', `${Math.round(metadata.percent)}%`)
    );
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const filename = `${prefix}_${mode === 'full' ? '完整原图' : '缩略图'}_${timestamp}.gubackup`;
    downloadBlob(blob, filename);
    toast(`备份已生成：${bytesText(blob.size)}`, 'success', 5000);
    return blob;
  } catch (error) {
    console.error(error);
    toast(`导出失败：${error.message}`, 'error', 6000);
    return null;
  } finally {
    setLoading(false);
  }
}

async function readTextFromZip(zip, path) {
  const file = zip.file(path);
  if (!file) throw new Error(`备份缺少 ${path}`);
  return file.async('string');
}

async function readJsonFromZip(zip, path) {
  return JSON.parse(await readTextFromZip(zip, path));
}

async function verifyTextChecksum(text, expected, label) {
  if (!expected || !globalThis.crypto?.subtle) return;
  const actual = await sha256Text(text);
  if (actual && actual !== expected) throw new Error(`${label} 校验失败，备份可能损坏或不完整`);
}

async function prepareBackupImport(file) {
  setLoading(true, '正在检查备份文件…');
  try {
    const zip = await JSZip.loadAsync(file);
    const manifest = await readJsonFromZip(zip, 'manifest.json');
    if (manifest.format !== BACKUP_FORMAT) throw new Error('不是可识别的 Goods Paradise 谷子天国备份');
    if (Number(manifest.schemaVersion) > BACKUP_SCHEMA_VERSION) throw new Error('备份版本高于当前软件，请先升级软件');
    const catalogsEntry = zip.file('data/catalogs.json');
    const catalogsProvided = Boolean(catalogsEntry);
    const [itemsText, locationsText, mediaText, catalogsText] = await Promise.all([
      readTextFromZip(zip, 'data/items.json'),
      readTextFromZip(zip, 'data/locations.json'),
      readTextFromZip(zip, 'data/media.json'),
      catalogsEntry ? catalogsEntry.async('string') : Promise.resolve('[]')
    ]);
    await Promise.all([
      verifyTextChecksum(itemsText, manifest.dataChecksums?.itemsSha256, '物品数据'),
      verifyTextChecksum(locationsText, manifest.dataChecksums?.locationsSha256, '位置数据'),
      verifyTextChecksum(mediaText, manifest.dataChecksums?.mediaSha256, '图片索引'),
      verifyTextChecksum(catalogsText, manifest.dataChecksums?.catalogsSha256, '下拉词库')
    ]);
    const items = JSON.parse(itemsText);
    const locations = JSON.parse(locationsText);
    const catalogs = JSON.parse(catalogsText);
    const mediaMeta = JSON.parse(mediaText);
    state.pendingImport = { file, zip, manifest, items, locations, catalogs, catalogsProvided, mediaMeta };
    showImportPreview();
  } catch (error) {
    console.error(error);
    toast(`无法读取备份：${error.message}`, 'error', 6000);
  } finally {
    setLoading(false);
  }
}

function showImportPreview() {
  const pending = state.pendingImport;
  if (!pending) return;
  const { manifest } = pending;
  const modal = openModal(`
    <div class="modal-header"><div><div class="eyebrow">RESTORE PREVIEW</div><h2>确认导入备份</h2></div><button class="icon-button" data-close-modal>×</button></div>
    <div class="modal-body">
      <section class="import-summary">
        <div><span>备份时间</span><strong>${formatDate(manifest.exportedAt)}</strong></div>
        <div><span>备份类型</span><strong>${manifest.mode === 'full' ? '完整原图' : '缩略图轻量版'}</strong></div>
        <div><span>物品</span><strong>${formatNumber(manifest.counts?.items || pending.items.length)} 条</strong></div>
        <div><span>下拉词库</span><strong>${formatNumber(manifest.counts?.catalogs ?? pending.catalogs.length)} 项</strong></div>
        <div><span>原图</span><strong>${formatNumber(manifest.counts?.originals || 0)} 张</strong></div>
        <div><span>缩略图</span><strong>${formatNumber(manifest.counts?.thumbnails || 0)} 张</strong></div>
      </section>
      <label class="field"><span>导入方式</span><select id="import-mode">
        <option value="replace">完全恢复：清空当前数据后恢复</option>
        <option value="merge">合并导入：相同 UUID 更新，新 UUID 新增</option>
        <option value="add">仅添加：跳过当前已存在的 UUID</option>
      </select></label>
      <label class="check-row"><input id="safety-backup" type="checkbox" checked><span>导入前先下载一份当前完整备份</span></label>
      <div class="warning-box">完全恢复会替换当前数据库。导入过程中请保持页面开启，不要锁屏或切换应用。</div>
    </div>
    <div class="modal-actions"><button class="button secondary" data-close-modal>取消</button><button class="button primary" data-run-import>开始导入</button></div>
  `, { wide: true });

  modal.root.querySelector('[data-run-import]').addEventListener('click', async () => {
    const mode = modal.root.querySelector('#import-mode').value;
    const safety = modal.root.querySelector('#safety-backup').checked;
    if (mode === 'replace') {
      const confirmed = await confirmDialog({
        title: '确认完全恢复',
        message: '当前数据库将被备份内容替换。确认继续？',
        confirmText: '确认恢复',
        danger: true
      });
      if (!confirmed) return;
    }
    modal.close();
    await executeBackupImport(mode, safety);
  });
}

async function executeBackupImport(mode, safetyBackup) {
  const pending = state.pendingImport;
  if (!pending) return;
  setLoading(true, '准备导入…');
  try {
    if (safetyBackup && state.items.length) {
      updateLoading('正在生成导入前安全备份…');
      await exportBackup('full', 'Goods Paradise_谷子天国_导入前安全备份');
      setLoading(true, '正在继续导入…');
    }

    const media = [];
    for (let index = 0; index < pending.mediaMeta.length; index += 1) {
      const meta = pending.mediaMeta[index];
      updateLoading('正在恢复图片…', `${index + 1}/${pending.mediaMeta.length}`);
      const originalEntry = meta.originalPath ? pending.zip.file(meta.originalPath) : null;
      const thumbnailEntry = meta.thumbnailPath ? pending.zip.file(meta.thumbnailPath) : null;
      const originalBlob = originalEntry
        ? new Blob([await originalEntry.async('arraybuffer')], { type: meta.mimeType || 'application/octet-stream' })
        : null;
      const thumbnailBlob = thumbnailEntry
        ? new Blob([await thumbnailEntry.async('arraybuffer')], { type: 'image/jpeg' })
        : null;
      const clean = { ...meta, originalBlob, thumbnailBlob };
      delete clean.originalPath;
      delete clean.thumbnailPath;
      delete clean.originalIncluded;
      clean.availability = originalBlob ? 'full' : 'thumbnail-only';
      media.push(clean);
    }

    updateLoading('正在写入本地数据库…');
    await importDataBundle({
      items: pending.items,
      locations: pending.locations,
      catalogs: pending.catalogs || [],
      media,
      mode
    });
    // 无论备份来自 v0.1、v0.2 还是 v0.3，都补齐当前版本的默认状态，
    // 同时从物品数据中恢复缺失的 IP 与物品类型词库。
    await addCatalogsFromItems(pending.items, true);
    await setMeta('catalogsInitializedV3', true);
    await setMeta('lastImport', {
      importedAt: new Date().toISOString(),
      sourceName: pending.file.name,
      manifest: pending.manifest,
      mode
    });
    state.pendingImport = null;
    await reloadData();
    setTab('items');
    toast(`导入完成：当前共有 ${state.items.length} 条物品`, 'success', 6000);
  } catch (error) {
    console.error(error);
    toast(`导入失败：${error.message}`, 'error', 7000);
  } finally {
    setLoading(false);
  }
}

async function renderSettingsView() {
  const lastImport = await getMeta('lastImport');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  mainView.innerHTML = `
    <section class="settings-list">
      <div class="settings-row">
        <div><strong>软件版本</strong><span>Goods Paradise 谷子天国 v${APP_VERSION}</span></div>
        <span class="status-pill">${standalone ? '主屏幕模式' : '浏览器模式'}</span>
      </div>
      <div class="settings-row column">
        <div><strong>安装到 iPhone 主屏幕</strong><span>用 Safari 打开部署地址 → 分享 → 添加到主屏幕 → 作为网页 App 打开。</span></div>
      </div>
      <div class="settings-row column">
        <div><strong>最近一次导入</strong><span>${lastImport ? `${formatDate(lastImport.importedAt)} · ${escapeHtml(lastImport.sourceName || '')}` : '尚未导入备份'}</span></div>
      </div>
    </section>

    <section class="backup-option option-management-entry">
      <div><h2>分类与颜色管理</h2><p>统一管理存放位置、物品状态、作品 / IP 和物品类型，并设置位置外框色与状态灯标色。</p></div>
      <button id="settings-option-manager" class="button primary">打开管理界面</button>
    </section>

    <section class="backup-option">
      <div><h2>创建示例数据</h2><p>仅用于测试复数 IP、位置外框、状态灯标和备份功能。可以随时删除。</p></div>
      <button id="create-demo" class="button secondary">创建 3 条示例</button>
    </section>

    <section class="backup-option">
      <div><h2>导出诊断信息</h2><p>只导出版本、记录数量和存储状态，不包含物品名称、备注或图片。</p></div>
      <button id="export-diagnostics" class="button secondary">导出诊断 JSON</button>
    </section>

    <section class="danger-zone">
      <h2>危险操作</h2>
      <p>清空操作会删除当前设备中的全部物品、位置、选项词库和图片，无法撤销。</p>
      <button id="clear-data" class="button danger">清空全部本地数据</button>
    </section>

    <section class="notice-card">
      <strong>本版本重点</strong>
      <p>已支持批量添加、批量点选编辑、批量永久删除、复数作品 / IP、分类颜色和完整备份。备份会同时保存全部词库与颜色设置。</p>
    </section>
  `;

  mainView.querySelector('#settings-option-manager').addEventListener('click', openOptionManager);
  mainView.querySelector('#create-demo').addEventListener('click', createDemoData);
  mainView.querySelector('#export-diagnostics').addEventListener('click', exportDiagnostics);
  mainView.querySelector('#clear-data').addEventListener('click', clearLocalData);
}

async function createDemoData() {
  const confirmed = await confirmDialog({
    title: '创建示例数据',
    message: '将新增 3 条不含图片的示例记录，其中一条包含两个作品 / IP。',
    confirmText: '创建'
  });
  if (!confirmed) return;
  const now = new Date();
  const firstLocation = state.locations[0]?.id || '';
  const secondLocation = state.locations[1]?.id || firstLocation;
  const demo = [
    { name: '音符 NYON 吧唧', ips: ['小魔女 Doremi'], type: '吧唧', quantity: 1, price: 68, status: '收藏中', locationId: firstLocation },
    { name: '黑川茜 MINI 立牌', ips: ['我推的孩子'], type: '立牌', quantity: 1, price: 45, status: '待出售', locationId: secondLocation },
    { name: '联动限定纪念色纸', ips: ['鬼灭之刃', '我推的孩子'], type: '色纸', quantity: 2, price: 30, status: '收藏中', locationId: firstLocation }
  ];
  for (let index = 0; index < demo.length; index += 1) {
    const timestamp = new Date(now.getTime() + index * 1000).toISOString();
    await putOne('items', {
      id: makeId(),
      ...demo[index],
      ip: demo[index].ips[0] || '',
      currency: 'CNY',
      remark: '示例记录',
      tags: ['示例'],
      legacyId: '',
      coverMediaId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }
  await reloadData();
  setTab('items');
  toast('示例数据已创建', 'success');
}

async function exportDiagnostics() {
  const info = await storageInfo();
  const media = await getAll('media');
  const payload = {
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    standalone: Boolean(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone),
    secureContext: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    indexedDB: 'indexedDB' in window,
    storage: info,
    counts: {
      items: state.items.length,
      locations: state.locations.length,
      catalogs: state.catalogs.length,
      media: media.length,
      originals: media.filter(record => record.originalBlob).length,
      thumbnails: media.filter(record => record.thumbnailBlob).length
    }
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `Goods Paradise_谷子天国_诊断_${Date.now()}.json`);
}

async function clearLocalData() {
  const confirmed = await confirmDialog({
    title: '清空全部本地数据',
    message: '物品、图片、位置与设置都会被永久删除。操作前请先导出完整原图备份。',
    confirmText: '确认清空',
    danger: true
  });
  if (!confirmed) return;
  const second = await confirmDialog({
    title: '再次确认',
    message: '这是最后一次确认。清空后只能通过外部备份恢复。',
    confirmText: '永久清空',
    danger: true
  });
  if (!second) return;
  setLoading(true, '正在清空本地数据库…');
  await clearAllData();
  await ensureDefaultLocations();
  await initializeCatalogs([]);
  await reloadData();
  setLoading(false);
  setTab('items');
  toast('本地数据已清空');
}

async function init() {
  try {
    await openDatabase();
    await ensureDefaultLocations();
    await reloadData();

    document.querySelectorAll('.nav-item').forEach(button => {
      button.addEventListener('click', () => setTab(button.dataset.tab));
    });
    quickAdd.addEventListener('click', () => {
      if (state.currentTab === 'locations') openLocationEditor();
      else openItemEditor();
    });
    optionManagerButton.addEventListener('click', openOptionManager);
    backupFileInput.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await prepareBackupImport(file);
    });

    quickAdd.hidden = false;
    optionManagerButton.hidden = false;
    renderCurrentTab();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service Worker 注册失败', error));
      });
    }
  } catch (error) {
    console.error(error);
    mainView.innerHTML = `<section class="empty-state"><h2>软件初始化失败</h2><p>${escapeHtml(error.message)}</p><button class="button primary" onclick="location.reload()">重新加载</button></section>`;
  }
}

init();
