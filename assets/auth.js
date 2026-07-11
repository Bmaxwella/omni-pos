(function(global){
  'use strict';

  const KEY = 'omni_v2_session';

  function savedSession(){
    return global.OmniUtils.parseJson(localStorage.getItem(KEY) || 'null', null);
  }

  function saveSession(user){
    localStorage.setItem(KEY, JSON.stringify({userId:user.id, username:user.username, role:user.role, vendorId:user.vendorId || '', at:Date.now()}));
  }

  function clearSession(){
    localStorage.removeItem(KEY);
  }

  async function signIn(username, role='customer', vendorId=''){
    const id = `user_${String(username || '').toLowerCase().replace(/[^a-z0-9]+/g,'_') || global.OmniUtils.uid('user')}`;
    const user = {id, username, displayName:username, role, vendorId, active:true, deleted:false};
    await global.OmniDB.put('users', id, user, {userId:id, vendorId});
    saveSession(user);
    await global.OmniDB.event('user_signed_in', 'user', id, {summary:`${username} signed in`, vendorId}, {userId:id, vendorId});
    return user;
  }

  global.OmniAuth = { savedSession, saveSession, clearSession, signIn };
})(window);
