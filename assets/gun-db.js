(function(global){
  'use strict';

  const config = global.OmniConfig;
  const utils = global.OmniUtils;
  const state = {
    gun: null,
    root: null,
    connectedRelays: new Set(),
    cache: Object.fromEntries(config.collections.map(name => [name, []])),
    listeners: {},
    subscriptions: new Map(),
    hydrated: new Set(),
    hydrationRuns: new Map(),
    pendingWrites: new Map(),
    status: {online:false, count:0, text:'Connecting securely'}
  };

  function peerName(peer){
    return String(peer?.url || peer?.wire?.url || peer?.id || peer || 'relay').replace(/^https?:\/\//,'').replace(/^wss?:\/\//,'');
  }

  function init(onStatus){
    if(onStatus) state.listeners.status = onStatus;
    if(state.gun) {
      onStatus?.(state.status);
      return state;
    }
    const report = status => {
      state.status = status;
      state.listeners.status?.(status);
    };
    state.gun = Gun({peers: config.peers, localStorage: true, retry: Infinity});
    state.root = state.gun.get(config.appRoot);
    state.gun.on('hi', peer => {
      state.connectedRelays.add(peerName(peer));
      report({online:true, count:state.connectedRelays.size, text:state.pendingWrites.size ? `Connected · syncing ${state.pendingWrites.size} saved change${state.pendingWrites.size===1?'':'s'}` : state.hydrated.size ? `Data synced · ${state.hydrated.size} sections loaded` : 'Connected · loading saved data'});
      setTimeout(() => state.subscriptions.forEach(subscription => hydrateSubscription(subscription, true)), 350);
    });
    state.gun.on('bye', peer => {
      state.connectedRelays.delete(peerName(peer));
      report({online:state.connectedRelays.size > 0, count:state.connectedRelays.size, text:state.connectedRelays.size ? 'Connected · changes sync automatically' : 'Offline · changes stay on this device'});
    });
    setTimeout(() => {
      if(!state.connectedRelays.size) report({online:false,count:0,text:'Offline · changes stay on this device'});
    }, 6500);
    const reconnect = () => {
      if(document.visibilityState === 'hidden') return;
      try { state.gun.opt({peers:config.peers}); } catch {}
      setTimeout(() => state.subscriptions.forEach(subscription => hydrateSubscription(subscription, true)), 500);
    };
    global.addEventListener?.('online', reconnect);
    document.addEventListener?.('visibilitychange', reconnect);
    return state;
  }

  function reportStatus(text){
    const status = {online:state.connectedRelays.size > 0, count:state.connectedRelays.size, text};
    state.status = status;
    state.listeners.status?.(status);
  }

  function node(collection, id){
    if(!state.root) init();
    const col = state.root.get(collection);
    return id ? col.get(id) : col;
  }

  function indexNode(collection, id){
    if(!state.root) init();
    const collectionIndex = state.root.get('_indexes').get(collection);
    return id ? collectionIndex.get(id) : collectionIndex;
  }

  function visibleRows(collection, options){
    return (state.cache[collection] || []).filter(row => options.includeDeleted || row.deleted !== true);
  }

  function acceptRow(options, row, key){
    return !row || typeof options.accept !== 'function' || options.accept(row, key);
  }

  function rememberId(collection, id, updatedAt=Date.now()){
    if(!id) return;
    indexNode(collection, id).put({id, updatedAt:Number(updatedAt || Date.now())});
  }

  function parentKeys(chain, wait=1400){
    return new Promise(resolve => {
      const keys = new Set();
      const collect = data => {
        const clean = data && typeof data === 'object' ? utils.cleanGun(data) : {};
        Object.keys(clean || {}).filter(key => key !== '_' && clean[key] !== null).forEach(key => keys.add(key));
      };
      chain.on(collect);
      setTimeout(() => { chain.off(); resolve([...keys]); }, wait);
    });
  }

  function directRecord(collection, id, wait=1800){
    return new Promise(resolve => {
      let settled = false;
      const chain = node(collection, id);
      const finish = data => {
        if(settled || !data) return;
        settled = true;
        chain.off();
        resolve(data ? {...utils.cleanGun(data), id:data.id || id} : null);
      };
      chain.on(finish);
      setTimeout(() => {
        if(settled) return;
        settled = true;
        chain.off();
        resolve(null);
      }, wait);
    });
  }

  async function hydrateSubscription(subscription, force=false){
    const {collection, callback, options} = subscription;
    if(state.hydrationRuns.has(collection)) return state.hydrationRuns.get(collection);
    const run = (async () => {
      const discovered = new Map();
      const collect = (data, key) => {
        if(!data) return;
        const row = {...utils.cleanGun(data), id:data.id || key};
        if(acceptRow(options, row, key)) discovered.set(row.id, row);
      };
      const onceChain = node(collection).map();
      onceChain.once(collect);
      const [collectionKeys, indexedKeys] = await Promise.all([parentKeys(node(collection)), parentKeys(indexNode(collection))]);
      const ids = [...new Set([...collectionKeys, ...indexedKeys, ...(state.cache[collection] || []).map(row => row.id)].filter(Boolean))];
      const direct = await Promise.all(ids.map(id => directRecord(collection, id)));
      direct.forEach((row, index) => collect(row, ids[index]));
      discovered.forEach(row => {
        upsertCache(collection, row, row.id);
        rememberId(collection, row.id, row.updatedAt);
      });
      state.hydrated.add(collection);
      callback?.(visibleRows(collection, options), null, null, {hydrated:true, count:discovered.size});
      reportStatus(state.pendingWrites.size ? `Loading complete · ${state.pendingWrites.size} change${state.pendingWrites.size===1?'':'s'} waiting to sync` : `Data synced · ${state.hydrated.size} sections loaded`);
      return discovered.size;
    })().finally(() => state.hydrationRuns.delete(collection));
    state.hydrationRuns.set(collection, run);
    return run;
  }

  function upsertCache(collection, data, key){
    const list = state.cache[collection] || (state.cache[collection] = []);
    const id = data?.id || key;
    const index = list.findIndex(item => item.id === id);
    if(!data) {
      if(index >= 0) list.splice(index, 1);
      return;
    }
    const row = {...utils.cleanGun(data), id};
    if(index >= 0) list[index] = row;
    else list.push(row);
  }

  function restoreCache(collection, id, previous){
    if(previous) upsertCache(collection, previous, id);
    else upsertCache(collection, null, id);
  }

  function writeRecord(collection, id, payload, row, previous, options={}){
    const writeKey = `${collection}/${id}`;
    const startedAt = Date.now();
    const pending = {collection, id, startedAt, operation:options.operation || 'write'};
    state.pendingWrites.set(writeKey, pending);
    if(row) upsertCache(collection, row, id);
    else upsertCache(collection, null, id);
    if(options.removeIndex) indexNode(collection, id).put(null);
    else rememberId(collection, id, row?.updatedAt || startedAt);
    return new Promise((resolve, reject) => {
      let returned = false;
      const finishQueued = () => {
        if(returned) return;
        returned = true;
        reportStatus(state.connectedRelays.size ? 'Saved · relay confirmation pending' : 'Saved on this device · waiting for connection');
        resolve({ack:null, row, queued:true, synced:false});
      };
      const timer = setTimeout(finishQueued, 4000);
      node(collection, id).put(payload, ack => {
        clearTimeout(timer);
        const latest = state.pendingWrites.get(writeKey) === pending;
        if(latest) state.pendingWrites.delete(writeKey);
        if(ack?.err) {
          if(latest) {
            restoreCache(collection, id, previous);
            if(options.removeIndex && previous) rememberId(collection, id, previous.updatedAt);
            reportStatus(`Sync error · ${String(ack.err)}`);
          }
          if(!returned) {
            returned = true;
            reject(new Error(String(ack.err)));
          }
          return;
        }
        reportStatus(state.connectedRelays.size ? `Data synced · ${state.hydrated.size} sections loaded` : 'Saved on this device · waiting for connection');
        if(!returned) {
          returned = true;
          resolve({ack, row, queued:state.connectedRelays.size === 0, synced:state.connectedRelays.size > 0});
        }
      });
    });
  }

  function subscribe(collection, callback, options={}){
    if(!config.collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
    const listenerKey = `${collection}:${options.includeDeleted === true}:${options.scopeKey || 'all'}`;
    if(state.listeners[listenerKey]) return state.listeners[listenerKey];
    const chain = node(collection).map();
    const subscription = {collection, callback, options, chain};
    const handler = (data, key) => {
      const clean = data ? {...utils.cleanGun(data), id:data.id || key} : null;
      if(!acceptRow(options, clean, key)) return;
      upsertCache(collection, data, key);
      if(clean) rememberId(collection, clean.id, clean.updatedAt);
      const rows = visibleRows(collection, options);
      callback?.(rows, clean, key);
    };
    chain.on(handler);
    state.subscriptions.set(listenerKey, subscription);
    hydrateSubscription(subscription);
    setTimeout(() => hydrateSubscription(subscription, true), 4200);
    setTimeout(() => hydrateSubscription(subscription, true), 12000);
    const unsubscribe = () => { chain.off(); state.subscriptions.delete(listenerKey); delete state.listeners[listenerKey]; };
    state.listeners[listenerKey] = unsubscribe;
    return unsubscribe;
  }

  function put(collection, id, record, meta={}){
    if(!config.collections.includes(collection)) return Promise.reject(new Error(`Unknown collection: ${collection}`));
    const currentId = id || record.id || utils.uid(collection.slice(0,-1) || 'row');
    const now = Date.now();
    const row = {
      id: currentId,
      schemaVersion: config.schemaVersion,
      deleted: false,
      createdAt: record.createdAt || now,
      updatedAt: now,
      updatedBy: meta.userId || record.updatedBy || '',
      ...record,
      id: currentId
    };
    const validation = global.OmniSchema?.validate(collection, row);
    if(validation && !validation.ok) return Promise.reject(new Error(`Missing required fields: ${validation.missing.join(', ')}`));
    const previous = (state.cache[collection] || []).find(item => item.id === currentId) || null;
    return writeRecord(collection, currentId, row, row, previous);
  }

  async function patch(collection, id, changes, meta={}){
    const cached = (state.cache[collection] || []).find(row => row.id === id);
    const existing = cached || await directRecord(collection, id, 5000);
    if(!existing) throw new Error(`Cannot update missing record: ${collection}/${id}`);
    const now = Date.now();
    const delta = {
      ...changes,
      id,
      schemaVersion: config.schemaVersion,
      updatedAt: now,
      updatedBy: meta.userId || changes.updatedBy || existing.updatedBy || ''
    };
    const row = {...existing, ...delta};
    return writeRecord(collection, id, delta, row, existing, {operation:'update'});
  }

  async function softDelete(collection, id, meta={}){
    const res = await patch(collection, id, {deleted:true, active:false, deletedAt:Date.now()}, meta);
    await event('record_deleted', collection, id, {summary:`Soft deleted ${collection}/${id}`, vendorId:meta.vendorId || ''}, meta);
    return res;
  }

  async function hardDelete(collection, id){
    if(!config.collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
    const cached = (state.cache[collection] || []).find(row => row.id === id);
    const existing = cached || await directRecord(collection, id, 3200);
    if(!existing) {
      upsertCache(collection, null, id);
      indexNode(collection, id).put(null);
      return {ack:null, row:null, missing:true, synced:state.connectedRelays.size > 0};
    }
    return writeRecord(collection, id, null, null, existing, {operation:'hard-delete', removeIndex:true});
  }

  async function readOnce(collection, wait=1800){
    if(!config.collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
    const discovered = new Map();
    node(collection).map().once((data, key) => {
      if(data) discovered.set(data.id || key, {...utils.cleanGun(data), id:data.id || key});
    });
    const [collectionKeys, indexedKeys] = await Promise.all([
      parentKeys(node(collection), wait),
      parentKeys(indexNode(collection), wait)
    ]);
    const ids = [...new Set([...collectionKeys, ...indexedKeys, ...(state.cache[collection] || []).map(row => row.id)].filter(Boolean))];
    const direct = await Promise.all(ids.map(id => directRecord(collection, id, Math.max(wait, 2400))));
    direct.filter(Boolean).forEach(row => discovered.set(row.id, row));
    return [...discovered.values()].filter(row => row.deleted !== true);
  }

  function event(action, entityType, entityId, data={}, meta={}){
    const id = utils.uid('event');
    return put('events', id, {
      id,
      type:'event',
      action,
      entityType,
      entityId,
      vendorId: data.vendorId || meta.vendorId || '',
      actorUserId: meta.userId || '',
      summary: data.summary || action,
      dataJson: JSON.stringify(data || {}),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, meta);
  }

  async function exportCollection(collection){
    const rows = await readOnce(collection, 1200);
    return rows;
  }

  async function importRows(collection, rows, meta={}){
    const results = [];
    for(const input of rows) {
      const id = input.id || utils.uid(collection.slice(0,-1) || 'row');
      results.push(await put(collection, id, {...input, id}, meta));
    }
    await event('collection_imported', collection, collection, {summary:`Imported ${rows.length} rows into ${collection}`, count:rows.length}, meta);
    return results;
  }

  global.OmniDB = { init, node, get:(collection,id,wait=5000) => directRecord(collection,id,wait), subscribe, put, patch, softDelete, hardDelete, readOnce, event, exportCollection, importRows, hydrate:collection => {
    const subscriptions = [...state.subscriptions.values()].filter(item => !collection || item.collection === collection);
    return Promise.all(subscriptions.map(item => hydrateSubscription(item, true)));
  }, state };
})(window);
