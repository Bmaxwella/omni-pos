(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.VendorUI;
  const POS = global.VendorPOS.POS;
  const state = DB.state.cache;
  let completingSale = false;
  let currentUser = global.OmniAuth.savedSession() || {userId:'user_demo_owner', username:'demo_owner', role:'vendor_owner', vendorId:'vendor_demo_seef'};

  function vendorId(){ return currentUser.vendorId || 'vendor_demo_seef'; }
  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }
  function mine(name){ return rows(name).filter(row => row.vendorId === vendorId()); }

  function renderDashboard(){
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
      <div class="grid split"><div class="card pad"><div class="head"><h2>Recent Orders</h2></div>${UI.table(orders.slice(-8).reverse(), [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}])}</div><div class="card pad"><h2>Role</h2><p><b>${U.esc(currentUser.role)}</b></p><p class="muted">Visible modules are controlled by permissions in omni-v2.</p></div></div>`;
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
    const order = {id, vendorId:vendorId(), customerPhone:phone, customerName:phone || 'Walk-in', status:'done', paymentMethod, total:POS.total(), source:'pos', createdBy:currentUser.userId, createdAt:Date.now()};
    await DB.put('orders', id, order, {userId:currentUser.userId, vendorId:vendorId()});
    for(const line of POS.lines()) await DB.put('orderItems', U.uid('item'), {orderId:id, vendorId:vendorId(), productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, qty:line.qty, total:line.total}, {userId:currentUser.userId, vendorId:vendorId()});
    await DB.put('payments', U.uid('payment'), {orderId:id, vendorId:vendorId(), method:paymentMethod, amount:order.total, status:paymentMethod==='credit'?'credit':'paid'}, {userId:currentUser.userId, vendorId:vendorId()});
    if(paymentMethod === 'credit' && phone) await chargeCredit(phone, order);
    await DB.event('pos_sale_completed','order',id,{vendorId:vendorId(), summary:`POS sale ${U.money(order.total)}`},{userId:currentUser.userId, vendorId:vendorId()});
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
    await DB.put('creditAccounts', account.id, {...account, balance:nextBalance}, {userId:currentUser.userId, vendorId:vendorId()});
    await DB.put('creditTransactions', U.uid('ctx'), {vendorId:vendorId(), creditAccountId:account.id, type:'charge', amount:order.total, orderId:order.id, note:'POS credit charge'}, {userId:currentUser.userId, vendorId:vendorId()});
  }

  function renderProducts(){
    document.getElementById('products').innerHTML = `<div class="card pad"><div class="head"><h2>Products</h2><button id="addProductBtn" class="btn primary">Add product</button></div>${UI.table(mine('products'), [{key:'name',label:'Name'}, {key:'category',label:'Category'}, {key:'price',label:'Price',format:r=>U.money(r.price)}, {key:'active',label:'Active'}], row=>`<button class="btn small danger" data-delete-product="${row.id}">Soft delete</button>`)}</div>`;
    document.getElementById('addProductBtn').onclick = async () => {
      const name = prompt('Product name'); if(!name) return;
      const price = Number(prompt('Price', '1.000') || 0);
      await DB.put('products', U.uid('product'), {vendorId:vendorId(), name, category:'General', price, active:true}, {userId:currentUser.userId, vendorId:vendorId()});
      UI.toast('Product saved','ok');
    };
    document.querySelectorAll('[data-delete-product]').forEach(btn => btn.onclick = async () => DB.softDelete('products', btn.dataset.deleteProduct, {userId:currentUser.userId, vendorId:vendorId()}));
  }

  function renderOrders(){
    document.getElementById('orders').innerHTML = `<div class="card pad"><div class="head"><h2>Orders</h2></div>${UI.table(mine('orders').sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)), [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'paymentMethod',label:'Payment'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}], row=>`<button class="btn small" data-status="${row.id}" data-next="preparing">Preparing</button> <button class="btn small primary" data-status="${row.id}" data-next="done">Done</button>`)}</div>`;
    document.querySelectorAll('[data-status]').forEach(btn => btn.onclick = async () => { await DB.patch('orders', btn.dataset.status, {status:btn.dataset.next}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Order updated','ok'); });
  }

  function renderCustomers(){
    document.getElementById('customers').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Credit Accounts</h2><button id="addCreditBtn" class="btn primary">Add credit</button></div>${UI.table(mine('creditAccounts'), [{key:'phone',label:'Phone'}, {key:'status',label:'Status'}, {key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)}, {key:'balance',label:'Balance',format:r=>U.money(r.balance)}], row=>`<button class="btn small" data-pay-credit="${row.id}">Record payment</button>`)}</div><div class="card pad"><h2>Ledger</h2>${UI.table(mine('creditTransactions').slice(-20).reverse(), [{key:'type',label:'Type'}, {key:'amount',label:'Amount',format:r=>U.money(r.amount)}, {key:'note',label:'Note'}])}</div></div>`;
    document.getElementById('addCreditBtn').onclick = async () => { const phone=prompt('Customer phone'); if(!phone)return; await DB.put('creditAccounts', U.uid('credit'), {vendorId:vendorId(), phone, status:'active', creditLimit:Number(prompt('Limit','50')||50), balance:0}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Credit account added','ok'); };
    document.querySelectorAll('[data-pay-credit]').forEach(btn => btn.onclick = async () => { const amount=Number(prompt('Payment amount','1')||0); const account=mine('creditAccounts').find(c=>c.id===btn.dataset.payCredit); if(!account)return; await DB.patch('creditAccounts', account.id, {balance:Math.max(0,Number(account.balance||0)-amount)}, {userId:currentUser.userId, vendorId:vendorId()}); await DB.put('creditTransactions', U.uid('ctx'), {vendorId:vendorId(), creditAccountId:account.id, type:'payment', amount, note:'Credit payment'}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Payment recorded','ok'); });
  }

  function renderEmployees(){
    document.getElementById('employees').innerHTML = `<div class="card pad"><div class="head"><h2>Employees & Permissions</h2><button id="addEmployeeBtn" class="btn primary">Add employee</button></div>${UI.table(mine('employees'), [{key:'name',label:'Name'}, {key:'jobTitle',label:'Job'}, {key:'branchId',label:'Branch'}, {key:'active',label:'Active'}])}</div>`;
    document.getElementById('addEmployeeBtn').onclick = async () => { const name=prompt('Employee name'); if(!name)return; await DB.put('employees', U.uid('employee'), {vendorId:vendorId(), name, jobTitle:'Staff', active:true}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Employee added','ok'); };
  }

  async function toggleShift(){
    const open = mine('employeeShifts').find(s=>s.userId===currentUser.userId && s.status==='open');
    if(open){ await DB.patch('employeeShifts', open.id, {status:'closed', checkOutAt:Date.now()}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Checked out','ok'); }
    else { await DB.put('employeeShifts', U.uid('shift'), {vendorId:vendorId(), userId:currentUser.userId, employeeId:currentUser.userId, status:'open', checkInAt:Date.now()}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Checked in','ok'); }
  }

  function renderAttendance(){
    document.getElementById('attendance').innerHTML = `<div class="card pad"><div class="head"><h2>Attendance</h2></div>${UI.table(mine('employeeShifts').sort((a,b)=>Number(b.checkInAt||0)-Number(a.checkInAt||0)), [{key:'employeeId',label:'Employee'}, {key:'status',label:'Status'}, {key:'checkInAt',label:'Check in',format:r=>r.checkInAt?new Date(Number(r.checkInAt)).toLocaleString():'-'}, {key:'checkOutAt',label:'Check out',format:r=>r.checkOutAt?new Date(Number(r.checkOutAt)).toLocaleString():'-'}])}</div>`;
  }

  function renderSettings(){
    const vendor = rows('vendors').find(v=>v.id===vendorId()) || {};
    document.getElementById('settings').innerHTML = `<div class="card pad"><div class="head"><h2>Vendor Settings</h2></div><div class="form-grid"><div class="field"><label>CR Name</label><input id="crName" value="${U.esc(vendor.crName||'')}"></div><div class="field"><label>CR Number</label><input id="crNumber" value="${U.esc(vendor.crNumber||'')}"></div><div class="field"><label>Business Type</label><input id="businessType" value="${U.esc(vendor.businessType||'')}"></div><div class="field"><label>Status</label><input disabled value="${U.esc(vendor.status||'pending')}"></div><button id="saveVendorBtn" class="btn primary full">Save vendor profile</button></div></div>`;
    document.getElementById('saveVendorBtn').onclick = async () => { await DB.put('vendors', vendorId(), {id:vendorId(), crName:document.getElementById('crName').value, crNumber:document.getElementById('crNumber').value, businessType:document.getElementById('businessType').value, ownerUserId:currentUser.userId, status:vendor.status||'pending', public:vendor.public===true}, {userId:currentUser.userId, vendorId:vendorId()}); UI.toast('Vendor profile saved','ok'); };
  }

  function render(){
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

  async function demoOwner(){
    const user = await global.OmniAuth.signIn('demo_owner','vendor_owner','vendor_demo_seef');
    currentUser = {userId:user.id, username:user.username, role:user.role, vendorId:user.vendorId};
    UI.toast('Signed in as demo owner','ok'); render();
  }

  function boot(){
    UI.shell(); UI.bindNav(render); DB.init(UI.setStatus);
    global.OmniConfig.collections.forEach(name => DB.subscribe(name, render, {includeDeleted:true}));
    document.getElementById('loginOwnerBtn').onclick = demoOwner;
    document.getElementById('checkShiftBtn').onclick = toggleShift;
    render();
  }
  boot();
})(window);
