(function(global){
  'use strict';

  const ROLE_PERMISSIONS = {
    superadmin: ['*'],
    vendor_owner: ['vendor.*','products.*','orders.*','pos.use','credit.*','employees.*','attendance.*','financials.read','reports.read','chat.*'],
    manager: ['products.*','orders.*','pos.use','credit.read','credit.payment','employees.read','attendance.read','reports.read','chat.*'],
    cashier: ['products.read','orders.read','orders.update_status','orders.delivery_dispatch','pos.use','credit.read','credit.charge','attendance.self','chat.read'],
    driver: ['orders.read','orders.delivery','credit.read','credit.charge','payments.delivery','attendance.self','chat.read'],
    customer: ['market.read','orders.create','orders.own','credit.own','profile.own'],
    guest: ['market.read','orders.create']
  };

  function has(user, permission, explicitJson){
    const role = user?.role || 'guest';
    const base = ROLE_PERMISSIONS[role] || [];
    const explicit = global.OmniUtils.parseJson(explicitJson || user?.permissionsJson || '[]', []);
    const all = [...base, ...explicit];
    return all.includes('*') || all.includes(permission) || all.some(p => p.endsWith('.*') && permission.startsWith(p.slice(0,-1)));
  }

  function canSeeVendor(user, vendor){
    if(has(user,'*')) return true;
    if(!vendor || vendor.deleted) return false;
    if((user?.role || 'guest') === 'guest' || user?.role === 'customer') {
      return vendor.public === true && vendor.status === 'approved' && vendor.active !== false;
    }
    return user?.vendorId && user.vendorId === vendor.id;
  }

  global.OmniPermissions = { ROLE_PERMISSIONS, has, canSeeVendor };
})(window);
