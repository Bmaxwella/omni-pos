(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.VendorUI;
  const POS = global.VendorPOS.POS;
  const state = DB.state.cache;
  let completingSale = false;
  let currentUser = global.OmniAuth.savedSession();

  function vendorId(){ return currentUser?.vendorId || ''; }
  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }
  function mine(name){ return rows(name).filter(row => row.vendorId === vendorId()); }
  function can(permission){ return global.OmniPermissions.has(currentUser, permission); }
  function vendorProfile(){ return rows('vendors').find(v=>v.id===vendorId()) || {}; }
  function userId(){ return currentUser?.userId || currentUser?.id || ''; }

  function renderAuthGate(){
    document.getElementById('app').innerHTML = `<main class="auth-screen"><section class="auth-card">
      <h1>OMNI Vendor</h1><p class="muted">Sign up as a vendor owner, or login as an owner/employee.</p>
      <div class="auth-tabs"><button class="btn primary active" data-auth-tab="signup">Vendor sign up</button><button class="btn" data-auth-tab="login">Login</button></div>
      <form id="signupPanel" class="auth-panel active">
        <div class="form-grid">
          <div class="field"><label>Username</label><input id="suUser" autocomplete="username" required></div>
          <div class="field"><label>Password</label><input id="suPass" type="password" autocomplete="new-password" required></div>
          <div class="field"><label>CR Name</label><input id="suCrName" required></div>
          <div class="field"><label>CR Number</label><input id="suCrNumber" required></div>
          <div class="field"><label>Business Type</label><input id="suBusinessType" value="Restaurant"></div>
          <div class="field"><label>WhatsApp / Phone</label><input id="suPhone" inputmode="tel"></div>
        </div>
        <button class="btn primary">Create vendor account</button>
      </form>
      <form id="loginPanel" class="auth-panel">
        <div class="form-grid"><div class="field"><label>Username</label><input id="liUser" autocomplete="username" required></div><div class="field"><label>Password</label><input id="liPass" type="password" autocomplete="current-password" required></div></div>
        <button class="btn primary">Login</button>
      </form>
    </section></main>`;
    document.querySelectorAll('[data-auth-tab]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('[data-auth-tab]').forEach(item => item.classList.toggle('active', item === btn));
      document.querySelectorAll('.auth-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${btn.dataset.authTab}Panel`));
    });
    document.getElementById('signupPanel').onsubmit = e => runAuth(e, () => global.OmniAuth.signUpVendor({username:document.getElementById('suUser').value, password:document.getElementById('suPass').value, crName:document.getElementById('suCrName').value.trim(), crNumber:document.getElementById('suCrNumber').value.trim(), businessType:document.getElementById('suBusinessType').value.trim(), phone:document.getElementById('suPhone').value.trim()}));
    document.getElementById('loginPanel').onsubmit = e => runAuth(e, () => global.OmniAuth.login(document.getElementById('liUser').value, document.getElementById('liPass').value));
  }

  async function runAuth(event, action){
    event.preventDefault();
    try {
      currentUser = await action();
      startApp();
    } catch(error) {
      UI.toast(error.message || 'Could not continue','bad');
    }
  }

  function syncPresence(){
    if(!currentUser) return;
    DB.put('presence', userId(), {id:userId(), userId:userId(), username:currentUser.username || '', vendorId:vendorId(), employeeId:currentUser.employeeId || '', role:currentUser.role || 'vendor_user', mode:'vendor', view:UI.activeView?.() || 'dashboard', online:true, updatedAt:Date.now()}, {userId:userId(), vendorId:vendorId()}).catch(() => {});
  }

  async function publicVendorPayload(vendor){
    const products = mine('products').filter(p=>p.active!==false).map(p=>({id:p.id,name:p.name,category:p.category||'',description:p.description||'',price:Number(p.price||0),image:p.image||'',barcode:p.barcode||'',qrCode:p.qrCode||'',sku:p.sku||'',stockQty:Number(p.stockQty||0),active:p.active!==false,updatedAt:p.updatedAt||Date.now()}));
    return {...vendor, id:vendor.id || vendorId(), products:JSON.stringify(products), updatedAt:Date.now()};
  }

  async function syncPublicVendor(){
    const vendor = vendorProfile();
    if(!vendor.id) return;
    if(vendor.active !== false && vendor.public === true && vendor.status === 'approved' && vendor.suspended !== true) {
      await DB.put('publicVendors', vendor.id, await publicVendorPayload(vendor), {userId:userId(), vendorId:vendor.id});
    } else if(rows('publicVendors').some(v=>v.id===vendor.id)) {
      await DB.patch('publicVendors', vendor.id, {active:false, public:false, suspended:vendor.suspended === true, status:vendor.status || 'pending'}, {userId:userId(), vendorId:vendor.id});
    }
  }

  function renderDashboard(){
    syncPresence();
    const orders = mine('orders');
    const today = U.todayKey();
    const todayOrders = orders.filter(o => U.todayKey(Number(o.createdAt||0)) === today);
    const revenue = todayOrders.filter(o=>o.status!=='cancelled').reduce((sum,o)=>sum+Number(o.total||0),0);
    const openShifts = mine('employeeShifts').filter(s=>s.status==='open');
    document.getElementById('dashboard').innerHTML = `
      <div class="grid cols-4">
        ${UI.stat('Orders today', todayOrders.length, {text:U.money(revenue),cls:'ok'})}
        ${UI.stat('Active products', mine('products').filter(p=>p.active!==false).length)}
        ${UI.stat('Credit balance', U.money(mine('creditAccounts').reduce((s,c)=>s+Number(c.balance||0),0)), {text:'outstanding',cls:'warn'})}
        ${UI.stat('Checked in', openShifts.length, {text:'live',cls:'ok'})}
      </div>
      <div class="grid split"><div class="card pad"><div class="head"><h2>Recent Orders</h2></div>${UI.table(orders.slice(-8).reverse(), [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}])}</div><div class="card pad"><h2>Role</h2><p><b>${U.esc(currentUser.role)}</b></p><p class="muted">Vendor: ${U.esc(vendorProfile().crName || vendorId())}</p><p class="muted">Public status: ${U.esc(vendorProfile().status || 'pending')}</p></div></div>`;
  }

  function renderPos(){
    const products = mine('products').filter(p=>p.active!==false);
    document.getElementById('pos').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Complete POS Sale</h2></div><div class="product-grid">${products.map(p=>`<article class="card product"><div class="body"><h3>${U.esc(p.name)}</h3><p class="muted">${U.esc(p.category||'Product')}</p><b>${U.money(p.price)}</b><button class="btn primary" data-add-product="${p.id}">Add</button></div></article>`).join('') || '<div class="empty">Create products first.</div>'}</div></div>${global.VendorPOS.renderCart()}</div>`;
    document.querySelectorAll('[data-add-product]').forEach(btn => btn.onclick = () => { const product = products.find(p=>p.id===btn.dataset.addProduct); POS.add(product); renderPos(); });
    document.querySelectorAll('[data-cart-remove]').forEach(btn => btn.onclick = () => { POS.remove(btn.dataset.cartRemove); renderPos(); });
    document.getElementById('completeSaleBtn')?.addEventListener('click', completeSale);
  }

  async function completeSale(){
    if(completingSale) return;
    if(!POS.cart.length) return UI.toast('Cart is empty','bad');
    const id = U.uid('order');
    const phone = document.getElementById('posPhone').value.trim();
    const paymentMethod = document.getElementById('posPayment').value;
    if(paymentMethod === 'credit' && !phone) return UI.toast('Customer phone is required for credit','bad');
    if(paymentMethod === 'credit') {
      const account = mine('creditAccounts').find(c=>c.phone===phone && c.status==='active');
      if(!account) return UI.toast('This customer does not have an active credit account','bad');
      if(Number(account.balance||0) + POS.total() > Number(account.creditLimit||0)) return UI.toast('This sale exceeds the customer credit limit','bad');
    }
    completingSale = true;
    const submit = document.getElementById('completeSaleBtn');
    if(submit) { submit.disabled = true; submit.textContent = 'Saving sale...'; }
    try {
    const order = {id, vendorId:vendorId(), customerPhone:phone, customerName:phone || 'Walk-in', status:'done', paymentMethod, total:POS.total(), source:'pos', createdBy:userId(), createdAt:Date.now()};
    await DB.put('orders', id, order, {userId:userId(), vendorId:vendorId()});
    for(const line of POS.lines()) await DB.put('orderItems', U.uid('item'), {orderId:id, vendorId:vendorId(), productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, qty:line.qty, total:line.total}, {userId:userId(), vendorId:vendorId()});
    await DB.put('payments', U.uid('payment'), {orderId:id, vendorId:vendorId(), method:paymentMethod, amount:order.total, status:paymentMethod==='credit'?'credit':'paid'}, {userId:userId(), vendorId:vendorId()});
    if(paymentMethod === 'credit' && phone) await chargeCredit(phone, order);
    await DB.event('pos_sale_completed','order',id,{vendorId:vendorId(), summary:`POS sale ${U.money(order.total)}`},{userId:userId(), vendorId:vendorId()});
    POS.clear(); UI.toast('Sale completed','ok'); renderPos();
    } catch(error) {
      UI.toast(error.message || 'Sale could not be saved','bad');
    } finally {
      completingSale = false;
      if(submit?.isConnected) { submit.disabled = false; submit.textContent = 'Complete sale'; }
    }
  }

  async function chargeCredit(phone, order){
    const account = mine('creditAccounts').find(c=>c.phone===phone && c.status==='active');
    if(!account) throw new Error('Active credit account not found');
    const nextBalance = Number(account.balance||0) + Number(order.total||0);
    await DB.put('creditAccounts', account.id, {...account, balance:nextBalance}, {userId:userId(), vendorId:vendorId()});
    await DB.put('creditTransactions', U.uid('ctx'), {vendorId:vendorId(), creditAccountId:account.id, type:'charge', amount:order.total, orderId:order.id, note:'POS credit charge'}, {userId:userId(), vendorId:vendorId()});
  }

  function renderProducts(){
    document.getElementById('products').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Products</h2></div>${UI.table(mine('products'), [{key:'name',label:'Name'}, {key:'category',label:'Category'}, {key:'price',label:'Price',format:r=>U.money(r.price)}, {key:'stockQty',label:'Stock'}, {key:'barcode',label:'Barcode'}, {key:'active',label:'Active'}], row=>`<button class="btn small danger" data-delete-product="${row.id}">Soft delete</button>`)}</div><form id="productForm" class="card pad form"><h2>Add product/service</h2><div class="form-grid"><div class="field"><label>Name</label><input id="prodName" required></div><div class="field"><label>Category</label><input id="prodCategory" value="General"></div><div class="field"><label>Price</label><input id="prodPrice" type="number" min="0" step="0.001" required></div><div class="field"><label>Stock Qty</label><input id="prodStock" type="number" min="0" step="1" value="0"></div><div class="field"><label>Barcode</label><input id="prodBarcode"></div><div class="field"><label>SKU / QR</label><input id="prodSku"></div><div class="field full"><label>Image URL</label><input id="prodImage"></div><div class="field full"><label>Description</label><textarea id="prodDescription"></textarea></div></div><button class="btn primary">Save product</button></form></div>`;
    document.getElementById('productForm').onsubmit = async e => {
      e.preventDefault();
      await DB.put('products', U.uid('product'), {vendorId:vendorId(), name:document.getElementById('prodName').value.trim(), category:document.getElementById('prodCategory').value.trim(), description:document.getElementById('prodDescription').value.trim(), price:Number(document.getElementById('prodPrice').value||0), image:document.getElementById('prodImage').value.trim(), barcode:document.getElementById('prodBarcode').value.trim(), sku:document.getElementById('prodSku').value.trim(), qrCode:document.getElementById('prodSku').value.trim(), stockQty:Number(document.getElementById('prodStock').value||0), active:true}, {userId:userId(), vendorId:vendorId()});
      await syncPublicVendor();
      UI.toast('Product saved and synced','ok');
      renderProducts();
    };
    document.querySelectorAll('[data-delete-product]').forEach(btn => btn.onclick = async () => { await DB.softDelete('products', btn.dataset.deleteProduct, {userId:userId(), vendorId:vendorId()}); await syncPublicVendor(); UI.toast('Product removed','ok'); });
  }

  function renderOrders(){
    document.getElementById('orders').innerHTML = `<div class="card pad"><div class="head"><h2>Orders</h2></div>${UI.table(mine('orders').sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)), [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'customerPhone',label:'Phone'}, {key:'customerAddress',label:'Address'}, {key:'paymentMethod',label:'Payment'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}], row=>`<button class="btn small" data-status="${row.id}" data-next="preparing">Preparing</button> <button class="btn small primary" data-status="${row.id}" data-next="done">Done</button>`)}</div>`;
    document.querySelectorAll('[data-status]').forEach(btn => btn.onclick = async () => { await DB.patch('orders', btn.dataset.status, {status:btn.dataset.next}, {userId:userId(), vendorId:vendorId()}); UI.toast('Order updated','ok'); });
  }

  function renderCustomers(){
    document.getElementById('customers').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Credit Accounts</h2></div>${UI.table(mine('creditAccounts'), [{key:'phone',label:'Phone'}, {key:'customerName',label:'Customer'}, {key:'status',label:'Status'}, {key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)}, {key:'balance',label:'Balance',format:r=>U.money(r.balance)}, {key:'dueDays',label:'Due days'}], row=>`<button class="btn small" data-pay-credit="${row.id}">Record payment</button>`)}</div><form id="creditForm" class="card pad form"><h2>Add credit account</h2><div class="form-grid"><div class="field"><label>Customer name</label><input id="creditName"></div><div class="field"><label>Phone</label><input id="creditPhone" required></div><div class="field"><label>Limit</label><input id="creditLimit" type="number" min="0" step="0.001" value="50"></div><div class="field"><label>Due days</label><input id="creditDue" type="number" min="1" step="1" value="30"></div></div><button class="btn primary">Save credit account</button></form><div class="card pad"><h2>Ledger</h2>${UI.table(mine('creditTransactions').slice(-20).reverse(), [{key:'type',label:'Type'}, {key:'amount',label:'Amount',format:r=>U.money(r.amount)}, {key:'note',label:'Note'}])}</div></div>`;
    document.getElementById('creditForm').onsubmit = async e => { e.preventDefault(); await DB.put('creditAccounts', U.uid('credit'), {vendorId:vendorId(), customerName:document.getElementById('creditName').value.trim(), phone:document.getElementById('creditPhone').value.trim(), status:'active', creditLimit:Number(document.getElementById('creditLimit').value||0), balance:0, dueDays:Number(document.getElementById('creditDue').value||30)}, {userId:userId(), vendorId:vendorId()}); UI.toast('Credit account added','ok'); renderCustomers(); };
    document.querySelectorAll('[data-pay-credit]').forEach(btn => btn.onclick = async () => { const amount=Number(prompt('Payment amount','1')||0); const account=mine('creditAccounts').find(c=>c.id===btn.dataset.payCredit); if(!account)return; await DB.patch('creditAccounts', account.id, {balance:Math.max(0,Number(account.balance||0)-amount)}, {userId:userId(), vendorId:vendorId()}); await DB.put('creditTransactions', U.uid('ctx'), {vendorId:vendorId(), creditAccountId:account.id, type:'payment', amount, note:'Credit payment'}, {userId:userId(), vendorId:vendorId()}); UI.toast('Payment recorded','ok'); });
  }

  function renderEmployees(){
    document.getElementById('employees').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Employees & Permissions</h2></div>${UI.table(mine('employees'), [{key:'name',label:'Name'}, {key:'role',label:'Role'}, {key:'jobTitle',label:'Job'}, {key:'username',label:'Username'}, {key:'active',label:'Active'}])}</div><form id="employeeForm" class="card pad form"><h2>Add employee</h2><div class="form-grid"><div class="field"><label>Name</label><input id="empName" required></div><div class="field"><label>Username</label><input id="empUser" required></div><div class="field"><label>Password</label><input id="empPass" type="password" required></div><div class="field"><label>Role</label><select id="empRole"><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="driver">Driver</option></select></div><div class="field full"><label>Job title</label><input id="empJob" value="Staff"></div></div><button class="btn primary">Save employee</button></form></div>`;
    document.getElementById('employeeForm').onsubmit = async e => {
      e.preventDefault();
      const username = document.getElementById('empUser').value.trim().toLowerCase();
      const employeeId = U.uid('employee');
      const role = document.getElementById('empRole').value;
      await DB.put('employees', employeeId, {id:employeeId, vendorId:vendorId(), name:document.getElementById('empName').value.trim(), username, role, jobTitle:document.getElementById('empJob').value.trim(), active:true}, {userId:userId(), vendorId:vendorId()});
      const userRecord = {id:`user_${username.replace(/[^a-z0-9]+/g,'_')}`, username, displayName:document.getElementById('empName').value.trim(), role, vendorId:vendorId(), employeeId, passwordHash:await global.OmniAuth.hashPassword(document.getElementById('empPass').value), active:true, deleted:false};
      await DB.put('users', userRecord.id, userRecord, {userId:userId(), vendorId:vendorId()});
      UI.toast('Employee user saved','ok'); renderEmployees();
    };
  }

  async function toggleShift(){
    const open = mine('employeeShifts').find(s=>s.userId===userId() && s.status==='open');
    if(open){ await DB.patch('employeeShifts', open.id, {status:'closed', checkOutAt:Date.now()}, {userId:userId(), vendorId:vendorId()}); UI.toast('Checked out','ok'); }
    else { await DB.put('employeeShifts', U.uid('shift'), {vendorId:vendorId(), userId:userId(), employeeId:currentUser.employeeId || userId(), status:'open', checkInAt:Date.now()}, {userId:userId(), vendorId:vendorId()}); UI.toast('Checked in','ok'); }
  }

  function renderAttendance(){
    document.getElementById('attendance').innerHTML = `<div class="card pad"><div class="head"><h2>Attendance</h2></div>${UI.table(mine('employeeShifts').sort((a,b)=>Number(b.checkInAt||0)-Number(a.checkInAt||0)), [{key:'employeeId',label:'Employee'}, {key:'status',label:'Status'}, {key:'checkInAt',label:'Check in',format:r=>r.checkInAt?new Date(Number(r.checkInAt)).toLocaleString():'-'}, {key:'checkOutAt',label:'Check out',format:r=>r.checkOutAt?new Date(Number(r.checkOutAt)).toLocaleString():'-'}])}</div>`;
  }

  function renderSettings(){
    const vendor = vendorProfile();
    document.getElementById('settings').innerHTML = `<form id="vendorSettingsForm" class="card pad form"><div class="head"><h2>Vendor Settings</h2><span class="pill ${vendor.status==='approved'?'ok':'warn'}">${U.esc(vendor.status||'pending')}</span></div><div class="form-grid"><div class="field"><label>CR Name</label><input id="crName" required value="${U.esc(vendor.crName||'')}"></div><div class="field"><label>CR Number</label><input id="crNumber" required value="${U.esc(vendor.crNumber||'')}"></div><div class="field"><label>Business Type</label><input id="businessType" value="${U.esc(vendor.businessType||'')}"></div><div class="field"><label>WhatsApp</label><input id="whatsapp" value="${U.esc(vendor.whatsapp||'')}"></div><div class="field"><label>Benefit / IBAN</label><input id="benefitNumber" value="${U.esc(vendor.benefitNumber||'')}"></div><div class="field"><label>Latitude</label><input id="lat" type="number" step="any" value="${U.esc(vendor.lat||'')}"></div><div class="field"><label>Longitude</label><input id="lng" type="number" step="any" value="${U.esc(vendor.lng||'')}"></div><div class="field"><label>Logo URL</label><input id="logo" value="${U.esc(vendor.logo||'')}"></div><div class="field full"><label>Shopfront image URL</label><input id="shopfront" value="${U.esc(vendor.shopfront||'')}"></div><label class="full"><input id="public" type="checkbox" ${vendor.public?'checked':''}> Request public listing</label><button class="btn primary full">Save vendor profile</button></div></form>`;
    document.getElementById('vendorSettingsForm').onsubmit = async e => {
      e.preventDefault();
      const row = {id:vendorId(), crName:document.getElementById('crName').value.trim(), crNumber:document.getElementById('crNumber').value.trim(), businessType:document.getElementById('businessType').value.trim(), whatsapp:document.getElementById('whatsapp').value.trim(), benefitNumber:document.getElementById('benefitNumber').value.trim(), lat:Number(document.getElementById('lat').value||0), lng:Number(document.getElementById('lng').value||0), logo:document.getElementById('logo').value.trim(), shopfront:document.getElementById('shopfront').value.trim(), ownerUserId:userId(), ownerAlias:currentUser.username || '', status:vendor.status||'pending', public:document.getElementById('public').checked, adminApproved:vendor.adminApproved===true, suspended:vendor.suspended===true, active:true};
      await DB.put('vendors', vendorId(), row, {userId:userId(), vendorId:vendorId()});
      await syncPublicVendor();
      UI.toast('Vendor profile saved and synced','ok');
    };
  }

  function render(){
    if(!currentUser) return;
    syncPresence();
    const view = UI.activeView();
    if(view==='dashboard') renderDashboard();
    if(view==='pos') renderPos();
    if(view==='orders') renderOrders();
    if(view==='products') renderProducts();
    if(view==='customers') renderCustomers();
    if(view==='employees') renderEmployees();
    if(view==='attendance') renderAttendance();
    if(view==='settings') renderSettings();
  }

  function startApp(){
    UI.shell(); UI.bindNav(render); DB.init(UI.setStatus);
    global.OmniConfig.collections.forEach(name => DB.subscribe(name, render, {includeDeleted:true}));
    document.getElementById('logoutBtn').onclick = () => { global.OmniAuth.clearSession(); currentUser = null; renderAuthGate(); };
    document.getElementById('checkShiftBtn').onclick = toggleShift;
    document.getElementById('userMode').textContent = `${currentUser.role || 'vendor'} · ${currentUser.username || ''}`;
    render();
  }

  function boot(){
    DB.init(UI.setStatus);
    if(currentUser) startApp();
    else renderAuthGate();
  }
  boot();
})(window);
