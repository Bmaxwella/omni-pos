(function(global){
  'use strict';

  const KEY = 'omni_v2_vendor_session';
  const LEGACY_KEY = 'omni_v2_session';
  const ALLOWED_ROLES = new Set(['vendor_owner','manager','cashier','driver']);

  function savedSession(){
    const saved = global.OmniUtils.parseJson(localStorage.getItem(KEY) || 'null', null);
    if(saved && ALLOWED_ROLES.has(saved.role) && saved.vendorId) return saved;
    const legacy = global.OmniUtils.parseJson(localStorage.getItem(LEGACY_KEY) || 'null', null);
    if(!legacy || !ALLOWED_ROLES.has(legacy.role) || !legacy.vendorId) return null;
    localStorage.setItem(KEY, JSON.stringify(legacy));
    return legacy;
  }

  function saveSession(user){
    localStorage.setItem(KEY, JSON.stringify({userId:user.id || user.userId, id:user.id || user.userId, username:user.username, displayName:user.displayName || user.username, phone:user.phone || '', role:user.role, vendorId:user.vendorId || '', employeeId:user.employeeId || '', at:Date.now()}));
  }

  function clearSession(){
    localStorage.removeItem(KEY);
    const legacy = global.OmniUtils.parseJson(localStorage.getItem(LEGACY_KEY) || 'null', null);
    if(legacy && ALLOWED_ROLES.has(legacy.role)) localStorage.removeItem(LEGACY_KEY);
  }

  function userIdFor(username){
    return `user_${String(username || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')}`;
  }

  function vendorIdFor(username){
    return `vendor_${String(username || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')}`;
  }

  async function hashPassword(password){
    const text = `omni-v2:${password || ''}`;
    if(global.crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
    }
    let hash = 0;
    for(let i=0;i<text.length;i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return `legacy_${Math.abs(hash)}`;
  }

  async function signIn(username, role='vendor_owner', vendorId='', extra={}){
    const cleanName = String(username || '').trim().toLowerCase();
    const id = cleanName ? userIdFor(cleanName) : global.OmniUtils.uid('user');
    const user = {id, username:cleanName || id, displayName:extra.displayName || username || 'Vendor user', role, vendorId, employeeId:extra.employeeId || '', active:true, deleted:false, lastLoginAt:Date.now()};
    await global.OmniDB.put('users', id, user, {userId:id, vendorId});
    saveSession(user);
    await global.OmniDB.event('user_signed_in', 'user', id, {summary:`${user.username} signed in`, vendorId, role}, {userId:id, vendorId});
    return user;
  }

  async function signUpVendor({username, password, crName, crNumber, businessType, phone}){
    const cleanName = String(username || '').trim().toLowerCase();
    if(!cleanName || !password || !crName || !crNumber) throw new Error('Username, password, CR name, and CR number are required.');
    const id = userIdFor(cleanName);
    const vendorId = vendorIdFor(cleanName);
    const existing = await global.OmniDB.get('users', id, 5000);
    if(existing && existing.deleted !== true) throw new Error('This username already exists.');
    const user = {id, username:cleanName, displayName:crName, role:'vendor_owner', vendorId, phone:phone || '', passwordHash:await hashPassword(password), active:true, deleted:false, createdAt:Date.now(), lastLoginAt:Date.now()};
    await global.OmniDB.put('users', id, user, {userId:id, vendorId});
    await global.OmniDB.put('vendors', vendorId, {id:vendorId, ownerUserId:id, ownerAlias:cleanName, crName, crNumber, businessType:businessType || 'General', whatsapp:phone || '', status:'pending', public:false, adminApproved:false, suspended:false, active:true}, {userId:id, vendorId});
    saveSession(user);
    await global.OmniDB.event('vendor_signed_up', 'vendor', vendorId, {summary:`${crName} signed up`, vendorId}, {userId:id, vendorId});
    return user;
  }

  async function login(username, password){
    const cleanName = String(username || '').trim().toLowerCase();
    const id = userIdFor(cleanName);
    const user = await global.OmniDB.get('users', id, 6500);
    if(!user || user.deleted === true || user.active === false) throw new Error('Account was not found.');
    if(!user.vendorId) throw new Error('This account is not linked to a vendor.');
    if(!user.passwordHash || user.passwordHash !== await hashPassword(password)) throw new Error('Password is incorrect.');
    const next = {...user, lastLoginAt:Date.now()};
    await global.OmniDB.patch('users', id, {lastLoginAt:next.lastLoginAt}, {userId:id, vendorId:user.vendorId || ''});
    saveSession(next);
    await global.OmniDB.event('vendor_user_logged_in', 'user', id, {summary:`${cleanName} logged in`, vendorId:user.vendorId, role:user.role || 'vendor_user'}, {userId:id, vendorId:user.vendorId || ''});
    return next;
  }

  global.OmniAuth = { savedSession, saveSession, clearSession, signIn, signUpVendor, login, hashPassword };
})(window);
