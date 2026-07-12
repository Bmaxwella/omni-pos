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
      report({online:true, count:state.connectedRelays.size, text:'All changes saved'});
    });
    state.gun.on('bye', peer => {
      state.connectedRelays.delete(peerName(peer));
      report({online:state.connectedRelays.size > 0, count:state.connectedRelays.size, text:state.connectedRelays.size ? 'All changes saved' : 'Offline · changes will sync later'});
    });
    setTimeout(() => {
      if(!state.connectedRelays.size) report({online:false,count:0,text:'Offline · changes will sync later'});
    }, 6500);
    return state;
  }

  function node(collection, id){
    if(!state.root) init();
    const col = state.root.get(collection);
    return id ? col.get(id) : col;
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

  function subscribe(collection, callback, options={}){
    if(!config.collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
    const listenerKey = `${collection}:${options.includeDeleted === true}:${options.scopeKey || 'all'}`;
    if(state.listeners[listenerKey]) return state.listeners[listenerKey];
    const chain = node(collection).map();
    const handler = (data, key) => {
      const clean = data ? {...utils.cleanGun(data), id:data.id || key} : null;
      if(clean && typeof options.accept === 'function' && !options.accept(clean, key)) return;
      upsertCache(collection, data, key);
      const rows = (state.cache[collection] || []).filter(row => options.includeDeleted || row.deleted !== true);
      callback?.(rows, clean, key);
    };
    chain.on(handler);
    const unsubscribe = () => { chain.off(); delete state.listeners[listenerKey]; };
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
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        reject(new Error('Your change could not be confirmed. Check your connection and try again.'));
      }, 12000);
      node(collection, currentId).put(row, ack => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        if(ack?.err) reject(new Error(String(ack.err)));
        else {
          upsertCache(collection, row, currentId);
          resolve({ack, row});
        }
      });
    });
  }

  async function patch(collection, id, changes, meta={}){
    const cached = (state.cache[collection] || []).find(row => row.id === id);
    const existing = cached || await new Promise(resolve => node(collection, id).once(data => resolve(data ? {...utils.cleanGun(data), id} : null)));
    if(!existing) throw new Error(`Cannot update missing record: ${collection}/${id}`);
    return put(collection, id, {...existing, ...changes, id, createdAt:existing.createdAt}, meta);
  }

  async function softDelete(collection, id, meta={}){
    const res = await patch(collection, id, {deleted:true, active:false, deletedAt:Date.now()}, meta);
    await event('record_deleted', collection, id, {summary:`Soft deleted ${collection}/${id}`, vendorId:meta.vendorId || ''}, meta);
    return res;
  }

  function readOnce(collection, wait=900){
    return new Promise(resolve => {
      const rows = [];
      node(collection).map().once((data, key) => {
        if(data) rows.push({...utils.cleanGun(data), id:data.id || key});
      });
      setTimeout(() => resolve(rows.filter(row => row.deleted !== true)), wait);
    });
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

  global.OmniDB = { init, node, subscribe, put, patch, softDelete, readOnce, event, exportCollection, importRows, state };
})(window);
