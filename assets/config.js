(function(global){
  'use strict';

  global.OmniConfig = {
    appRoot: 'omni-v2',
    schemaVersion: 1,
    currency: 'BHD',
    peers: [
      'https://gun-manhattan.herokuapp.com/gun',
      'https://peer.wallie.io/gun',
      'https://gundb-relay-mlccl.ondigitalocean.app/gun',
      'https://gun.defucc.me/gun',
      'https://a.talkflow.team/gun'
    ],
    collections: [
      'users','vendors','vendorUsers','employees','branches','products','productOptions',
      'productCodes','qrCodes','images','customers','customerLocations',
      'customerVendorProfiles','vendorCreditSettings','creditAccounts',
      'creditTransactions','orders','orderItems','payments','employeeShifts',
      'permissions','threads','messages','passwordResets','events','presence',
      'settings','imports','exports','databaseBackups','analyticsSnapshots',
      'auditLogs','notifications','deliveryAssignments','productInventory'
    ]
  };
})(window);
