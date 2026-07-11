(function(global){
  'use strict';

  const { collections, schemaVersion } = global.OmniConfig;

  function base(type, data={}){
    const now = Date.now();
    return {
      id: data.id || global.OmniUtils.uid(type),
      type,
      status: data.status || 'active',
      active: data.active !== false,
      deleted: data.deleted === true ? true : false,
      schemaVersion,
      createdAt: data.createdAt || now,
      updatedAt: now,
      createdBy: data.createdBy || '',
      updatedBy: data.updatedBy || '',
      ...data
    };
  }

  const Schema = {
    collections,
    base,
    defaults: {
      user: data => base('user', {role:'customer', username:'', displayName:'', phone:'', vendorId:'', ...data}),
      vendor: data => base('vendor', {ownerUserId:'', ownerAlias:'', crName:'', crNumber:'', businessType:'', public:false, adminApproved:false, suspended:false, status:'pending', lat:0, lng:0, logo:'', shopfront:'', whatsapp:'', benefitNumber:'', ...data}),
      branch: data => base('branch', {vendorId:'', name:'', address:'', phone:'', lat:0, lng:0, isDefault:false, ...data}),
      product: data => base('product', {vendorId:'', name:'', category:'', description:'', price:0, cost:0, image:'', barcode:'', qrCode:'', sku:'', stockMode:'none', stockQty:0, ...data}),
      customer: data => base('customer', {userId:'', name:'', phone:'', defaultAddress:'', lat:0, lng:0, ...data}),
      order: data => base('order', {vendorId:'', branchId:'', customerId:'', customerName:'', customerPhone:'', customerAddress:'', customerLat:0, customerLng:0, status:'pending', paymentMethod:'cash', subtotal:0, discount:0, tax:0, total:0, source:'customer', ...data}),
      creditAccount: data => base('creditAccount', {vendorId:'', customerId:'', phone:'', status:'pending', creditLimit:0, balance:0, dueDays:30, ...data}),
      event: data => base('event', {vendorId:'', actorUserId:'', action:'', entityType:'', entityId:'', summary:'', ...data})
    },
    requiredByCollection: {
      vendors: ['id','crName','status'],
      publicVendors: ['id','crName'],
      products: ['id','vendorId','name'],
      orders: ['id','vendorId','status','total'],
      users: ['id','username','role']
    },
    validate(collection, record){
      const required = Schema.requiredByCollection[collection] || ['id'];
      const missing = required.filter(key => record[key] === undefined || record[key] === null || record[key] === '');
      return {ok: missing.length === 0, missing};
    }
  };

  global.OmniSchema = Schema;
})(window);
