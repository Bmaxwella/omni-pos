(function(global){
  'use strict';

  const relayUrl = 'https://relay.omni-society.com/gun';

  global.OmniConfig = {
    appRoot: 'omni-v2',
    schemaVersion: 3,
    currency: 'BHD',
    relayUrl,
    peers: [relayUrl],
    databaseOnly: true,
    collections: [
      'users','vendors','publicVendors','vendorUsers','employees','branches','products','productOptions',
      'productCodes','qrCodes','images','customers','customerLocations',
      'customerVendorProfiles','vendorCreditSettings','creditAccounts',
      'creditTransactions','orders','orderItems','payments','employeeShifts',
      'permissions','threads','messages','passwordResets','events','presence',
      'settings','imports','exports','databaseBackups','analyticsSnapshots',
      'auditLogs','notifications','deliveryAssignments','productInventory'
    ]
  };
})(window);
