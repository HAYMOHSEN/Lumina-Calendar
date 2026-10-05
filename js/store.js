/* Lumina Calendar — local storage layer.
 * Primary store: IndexedDB (survives far better than localStorage and can hold folder handles).
 * Fallback: localStorage, used only when IndexedDB is unavailable. */
(function (global) {
  'use strict';

  const DB_NAME = 'lumina-calendar';
  const DB_VERSION = 1;
  const LS_EVENTS = 'lumina.events';
  const LS_KV = 'lumina.kv.';

  let dbPromise = null;
  let useFallback = false;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { useFallback = true; return resolve(null); }
      let req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { useFallback = true; return resolve(null); }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { useFallback = true; resolve(null); };
      req.onblocked = function () { useFallback = true; resolve(null); };
    });
    return dbPromise;
  }

  function tx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      let result;
      const t = db.transaction(store, mode);
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('aborted')); };
      try { result = fn(t.objectStore(store)); } catch (e) { reject(e); }
    });
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* ---------- events ---------- */
  async function getAllEvents() {
    const db = await openDB();
    if (!db) {
      try { return JSON.parse(localStorage.getItem(LS_EVENTS) || '[]'); } catch (e) { return []; }
    }
    const t = db.transaction('events', 'readonly');
    return reqToPromise(t.objectStore('events').getAll());
  }

  async function replaceAllEvents(list) {
    const db = await openDB();
    if (!db) {
      localStorage.setItem(LS_EVENTS, JSON.stringify(list));
      return;
    }
    await tx(db, 'events', 'readwrite', function (store) {
      store.clear();
      for (const ev of list) store.put(plain(ev));
    });
  }

  async function putEvent(ev) {
    const db = await openDB();
    if (!db) {
      const list = await getAllEvents();
      const i = list.findIndex(function (e) { return e.id === ev.id; });
      if (i >= 0) list[i] = ev; else list.push(ev);
      localStorage.setItem(LS_EVENTS, JSON.stringify(list));
      return;
    }
    await tx(db, 'events', 'readwrite', function (store) { store.put(plain(ev)); });
  }

  async function deleteEvent(id) {
    const db = await openDB();
    if (!db) {
      const list = (await getAllEvents()).filter(function (e) { return e.id !== id; });
      localStorage.setItem(LS_EVENTS, JSON.stringify(list));
      return;
    }
    await tx(db, 'events', 'readwrite', function (store) { store.delete(id); });
  }

  /* Strip prototype-inherited occurrence fields; IndexedDB needs plain, cloneable objects. */
  function plain(ev) {
    return JSON.parse(JSON.stringify(ev.event || ev));
  }

  /* ---------- key/value ---------- */
  async function kvGet(key) {
    const db = await openDB();
    if (!db) {
      try { const v = localStorage.getItem(LS_KV + key); return v === null ? undefined : JSON.parse(v); } catch (e) { return undefined; }
    }
    const t = db.transaction('kv', 'readonly');
    return reqToPromise(t.objectStore('kv').get(key));
  }

  async function kvSet(key, value) {
    const db = await openDB();
    if (!db) {
      try { localStorage.setItem(LS_KV + key, JSON.stringify(value)); } catch (e) { /* handles are not serialisable; ignore */ }
      return;
    }
    await tx(db, 'kv', 'readwrite', function (store) { store.put(value, key); });
  }

  async function kvDelete(key) {
    const db = await openDB();
    if (!db) { localStorage.removeItem(LS_KV + key); return; }
    await tx(db, 'kv', 'readwrite', function (store) { store.delete(key); });
  }

  /* ---------- persistence hints ---------- */
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = await navigator.storage.persisted();
        if (already) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  global.LuminaStore = {
    getAllEvents: getAllEvents, replaceAllEvents: replaceAllEvents, putEvent: putEvent, deleteEvent: deleteEvent,
    kvGet: kvGet, kvSet: kvSet, kvDelete: kvDelete, requestPersistence: requestPersistence,
    get usingFallback() { return useFallback; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
