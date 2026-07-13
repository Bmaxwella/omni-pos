(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.VendorUI;
  const POS = global.VendorPOS.POS;
  const state = DB.state.cache;
  let completingSale = false;
  let currentUser = global.OmniAuth.savedSession();
  let renderTimer = null;
  let presenceTimer = null;
  let liveUnsubscribers = [];
  let audioContext = null;
  let orderAlertTimer = null;
  let posCategory = 'All';
  let productEditor = {id:'', images:[], attributes:[{name:'', value:''}]};
  let productImageBusy = false;
  let driverWatchId = null;
  let driverSelectedOrderId = '';
  let driverMap = null;
  let driverMarker = null;
  let driverDestinationMarker = null;
  let driverRoute = null;
  let driverLine = null;
  let lastDriverLocationWrite = 0;
  let scannerControls = null;
  let scannerStream = null;
  let scannerFrame = 0;
  const pendingRenders = new Set();
  const VENDOR_COLLECTIONS = ['users','vendors','publicVendors','employees','branches','products','productInventory','orders','orderItems','payments','creditAccounts','creditTransactions','vendorCreditSettings','employeeShifts','deliveryAssignments'];

  function vendorId(){ return currentUser?.vendorId || ''; }
  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }
  function mine(name){ return rows(name).filter(row => row.vendorId === vendorId()); }
  function can(permission){ return global.OmniPermissions.has(currentUser, permission); }
  function vendorProfile(){ return rows('vendors').find(v=>v.id===vendorId()) || {}; }
  function userId(){ return currentUser?.userId || currentUser?.id || ''; }
  function currentUserRecord(){ return rows('users').find(user => user.id === userId()) || currentUser || {}; }
  function productImages(product={}){
    const saved = U.parseJson(product.imagesJson || '[]', []);
    const images = [product.image || '', ...(Array.isArray(saved) ? saved : [])].filter(source => typeof source === 'string' && (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)));
    return [...new Set(images)].slice(0, 3);
  }
  function productAttributes(product={}){
    const saved = U.parseJson(product.attributesJson || '[]', []);
    return Array.isArray(saved) ? saved.filter(item => item && (item.name || item.value)).map(item => ({name:String(item.name || ''), value:String(item.value || '')})) : [];
  }
  function productImage(product){ return productImages(product)[0] || ''; }
  function productInitial(product){ return U.esc(String(product?.name || 'P').slice(0,1).toUpperCase()); }
  function resetProductEditor(){ productEditor = {id:'', images:[], attributes:[{name:'', value:''}]}; }
  function beginProductEdit(product){
    productEditor = {id:product.id, images:productImages(product), attributes:productAttributes(product)};
    if(!productEditor.attributes.length) productEditor.attributes.push({name:'', value:''});
  }
  function syncEditorAttributes(){
    productEditor.attributes = [...document.querySelectorAll('[data-product-attribute]')].map(row => ({
      name:row.querySelector('[data-attribute-name]')?.value.trim() || '',
      value:row.querySelector('[data-attribute-value]')?.value.trim() || ''
    }));
  }
  function rerenderProductsKeepingFields(){
    syncEditorAttributes();
    const fields = captureViewFields('products');
    renderProducts();
    restoreViewFields(fields);
  }
  function readBlob(blob){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Image could not be read'));
      reader.readAsDataURL(blob);
    });
  }
  function canvasBlob(canvas, quality){
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  async function compressProductImage(file){
    if(!file?.type?.startsWith('image/')) throw new Error('Choose an image file');
    if(file.size > 8 * 1024 * 1024) throw new Error('Each image must be smaller than 8 MB');
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Image format is not supported'));
        element.src = url;
      });
      let result = '';
      for(const size of [1000, 820, 680]) {
        const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await canvasBlob(canvas, size === 1000 ? .78 : size === 820 ? .66 : .54);
        if(!blob) continue;
        result = await readBlob(blob);
        if(result.length <= 190000) break;
      }
      if(!result || result.length > 260000) throw new Error('This image is too detailed. Choose a smaller image');
      return result;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function stopBarcodeScanner(){
    if(scannerFrame) cancelAnimationFrame(scannerFrame);
    scannerFrame = 0;
    try { scannerControls?.stop?.(); } catch {}
    scannerControls = null;
    if(scannerStream) scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
    document.getElementById('barcodeScannerModal')?.remove();
  }

  function playScanSuccessTone(){
    try {
      const AudioEngine = global.AudioContext || global.webkitAudioContext;
      if(!AudioEngine) return;
      const context = audioContext || new AudioEngine();
      if(!audioContext) audioContext = context;
      const now = context.currentTime;
      [1175, 1568, 2093].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const offset = index * .09;
        oscillator.type = index === 1 ? 'square' : 'triangle';
        oscillator.frequency.setValueAtTime(frequency, now + offset);
        gain.gain.setValueAtTime(.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(.42, now + offset + .008);
        gain.gain.exponentialRampToValueAtTime(.0001, now + offset + .075);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + .08);
      });
    } catch {}
  }

  async function startBarcodeScanner(onDetected){
    stopBarcodeScanner();
    await unlockOrderSound();
    if(!navigator.mediaDevices?.getUserMedia) return UI.toast('Camera scanning is unavailable. Enter the barcode or SKU manually','bad');
    const modal = document.createElement('div');
    modal.id = 'barcodeScannerModal';
    modal.className = 'scanner-modal';
    modal.innerHTML = `<section class="scanner-panel"><div class="scanner-head"><div><span class="eyebrow">Live camera</span><h2>Scan barcode</h2></div><button id="closeScannerBtn" class="icon-btn" aria-label="Close scanner">×</button></div><div class="scanner-viewport"><video id="barcodeVideo" playsinline muted></video><span class="scanner-line"></span></div><p id="scannerStatus">Point the camera at a barcode. It will register automatically.</p></section>`;
    document.body.appendChild(modal);
    document.getElementById('closeScannerBtn').onclick = stopBarcodeScanner;
    const video = document.getElementById('barcodeVideo');
    const status = document.getElementById('scannerStatus');
    let finished = false;
    const finish = value => {
      const code = String(value || '').trim();
      if(!code || finished) return;
      finished = true;
      playScanSuccessTone();
      navigator.vibrate?.(70);
      stopBarcodeScanner();
      onDetected(code);
      UI.toast(`Barcode detected: ${code}`,'ok');
    };
    try {
      if(global.BarcodeDetector) {
        scannerStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
        video.srcObject = scannerStream;
        await video.play();
        const formats = await global.BarcodeDetector.getSupportedFormats?.();
        const preferred = ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code'];
        const selectedFormats = Array.isArray(formats) ? preferred.filter(format=>formats.includes(format)) : preferred;
        const detector = selectedFormats.length ? new global.BarcodeDetector({formats:selectedFormats}) : new global.BarcodeDetector();
        const detect = async () => {
          if(!document.getElementById('barcodeScannerModal')) return;
          try {
            const results = await detector.detect(video);
            if(results[0]?.rawValue) return finish(results[0].rawValue);
          } catch {}
          scannerFrame = requestAnimationFrame(detect);
        };
        detect();
      } else if(global.ZXingBrowser?.BrowserMultiFormatReader) {
        const reader = new global.ZXingBrowser.BrowserMultiFormatReader();
        scannerControls = await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}}}, video, result => {
          const value = result?.getText?.() || result?.text;
          if(value) finish(value);
        });
      } else {
        status.textContent = 'Automatic scanning is not supported on this browser. Enter the barcode or SKU manually.';
      }
    } catch(error) {
      stopBarcodeScanner();
      UI.toast(error.name === 'NotAllowedError' ? 'Camera permission was not granted' : 'Camera scanner could not start','bad');
    }
  }
  function appReady(){ return !!document.querySelector('.content .view'); }
  function searchTerm(){ return String(document.getElementById('search')?.value || '').trim().toLowerCase(); }
  function matchesTerm(row, keys){
    const term = searchTerm();
    if(!term) return true;
    return keys.some(key => String(row?.[key] || '').toLowerCase().includes(term));
  }
  function activeField(){
    const el = document.activeElement;
    return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el : null;
  }
  function isEditingField(){
    const el = activeField();
    return !!el && el.id !== 'search';
  }
  function clearLiveTimers(){
    if(renderTimer) clearTimeout(renderTimer);
    if(presenceTimer) clearInterval(presenceTimer);
    renderTimer = null;
    presenceTimer = null;
    if(orderAlertTimer) clearInterval(orderAlertTimer);
    orderAlertTimer = null;
    stopDriverTracking();
    stopBarcodeScanner();
  }
  function permissionGate(message='You do not have permission to view this workspace area.'){
    return `<div class="card pad empty"><h2>Permission required</h2><p class="muted">${U.esc(message)}</p></div>`;
  }
  function updateShiftButton(){
    const btn = document.getElementById('checkShiftBtn');
    if(!btn) return;
    const open = mine('employeeShifts').find(s=>s.userId===userId() && s.status==='open');
    btn.textContent = open ? 'Check out' : 'Check in';
  }

  function pendingCustomerOrders(){
    return mine('orders').filter(order => order.source === 'customer' && order.status === 'pending');
  }

  async function unlockOrderSound(){
    try {
      const AudioEngine = global.AudioContext || global.webkitAudioContext;
      if(!AudioEngine) return false;
      if(!audioContext) audioContext = new AudioEngine();
      if(audioContext.state === 'suspended') await audioContext.resume();
      updateOrderAlert();
      return audioContext.state === 'running';
    } catch {
      return false;
    }
  }

  function playOrderTone(){
    if(!audioContext || audioContext.state !== 'running') return;
    const now = audioContext.currentTime;
    [0, .16, .32].forEach((offset, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = index === 1 ? 'square' : 'sawtooth';
      oscillator.frequency.setValueAtTime(index === 1 ? 980 : index === 2 ? 1280 : 1180, now + offset);
      gain.gain.setValueAtTime(.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(.38, now + offset + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, now + offset + .13);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + .14);
    });
  }

  function updateOrderAlert(){
    const alert = document.getElementById('orderAlert');
    if(!alert) return;
    const pending = pendingCustomerOrders();
    if(!pending.length || !can('orders.update_status')) {
      alert.classList.remove('active');
      if(alert.dataset.signature !== 'none') alert.innerHTML = '';
      alert.dataset.signature = 'none';
      if(orderAlertTimer) clearInterval(orderAlertTimer);
      orderAlertTimer = null;
      return;
    }
    const audioReady = audioContext?.state === 'running';
    alert.classList.add('active');
    const signature = `${pending.map(order => order.id).sort().join('|')}:${audioReady}`;
    if(alert.dataset.signature !== signature) {
      alert.dataset.signature = signature;
      alert.innerHTML = `<div><strong>${pending.length} new order${pending.length === 1 ? '' : 's'}</strong><span>Accept or cancel to stop the alert.</span></div><button class="btn small" data-review-orders>Review orders</button>${audioReady ? '' : '<button class="btn small primary" data-enable-sound>Enable sound</button>'}`;
      alert.querySelector('[data-review-orders]').onclick = () => document.querySelector('[data-view="orders"]')?.click();
      const enable = alert.querySelector('[data-enable-sound]');
      if(enable) enable.onclick = unlockOrderSound;
    }
    if(audioReady && !orderAlertTimer) {
      playOrderTone();
      orderAlertTimer = setInterval(playOrderTone, 1100);
    }
  }

  function viewUsesCollection(collection){
    const view = UI.activeView?.() || 'dashboard';
    const dependencies = {
      dashboard: new Set(['orders','products','creditAccounts','employeeShifts','vendors']),
      deliveries: new Set(['orders','orderItems','deliveryAssignments','payments','creditAccounts','vendorCreditSettings']),
      pos: new Set(['products']),
      orders: new Set(['orders','orderItems']),
      products: new Set(['products','productInventory']),
      customers: new Set(['creditAccounts','creditTransactions','vendorCreditSettings']),
      employees: new Set(['employees','users']),
      attendance: new Set(['employeeShifts']),
      settings: new Set(['vendors','publicVendors'])
    };
    return collection === 'search' || collection === 'deferred' || dependencies[view]?.has(collection);
  }

  function flushPendingRender(){
    if(!pendingRenders.size || isEditingField()) return;
    pendingRenders.clear();
    scheduleRender('deferred');
  }

  function captureViewFields(view){
    const container = document.getElementById(view);
    if(!container) return [];
    return [...container.querySelectorAll('input[id],select[id],textarea[id]')].filter(field => field.type !== 'file').map(field => ({id:field.id, value:field.value, checked:field.checked}));
  }

  function restoreViewFields(fields){
    fields.forEach(saved => {
      const field = document.getElementById(saved.id);
      if(!field) return;
      field.value = saved.value;
      if(field.type === 'checkbox' || field.type === 'radio') field.checked = saved.checked;
    });
  }

  function renderAuthGate(){
    clearLiveTimers();
    const app = document.getElementById('app');
    app.className = 'auth-root';
    app.innerHTML = `<main class="auth-screen"><section class="auth-card">
      <div class="auth-copy">
        <div class="auth-brand"><span class="brand-mark">OM</span><strong>OMNI Vendor</strong></div>
        <div><span class="auth-kicker">Operations workspace</span><h1>Run the day from one place.</h1><p>Sales, orders, delivery, products, customer credit, and attendance stay connected for your team.</p></div>
        <div class="auth-points"><span>Role-based access</span><span>Live orders</span><span>Secure sign in</span></div>
      </div>
      <div class="auth-form">
        <div class="auth-form-intro"><span class="eyebrow">Welcome back</span><h2>Sign in to your workspace</h2><p>Vendor owners and employees use the account assigned to them.</p></div>
        <div class="auth-tabs"><button class="btn primary active" data-auth-tab="login">Sign in</button><button class="btn" data-auth-tab="signup">Register vendor</button></div>
        <form id="loginPanel" class="auth-panel active">
          <div class="form-grid"><div class="field"><label>Username</label><input id="liUser" autocomplete="username" required autofocus></div><div class="field"><label>Password</label><input id="liPass" type="password" autocomplete="current-password" required></div></div>
          <button class="btn primary auth-submit">Sign in</button>
        </form>
        <form id="signupPanel" class="auth-panel">
          <div class="form-grid">
            <div class="field"><label>Username</label><input id="suUser" autocomplete="username" required></div>
            <div class="field"><label>Password</label><input id="suPass" type="password" autocomplete="new-password" required></div>
            <div class="field"><label>CR Name</label><input id="suCrName" required></div>
            <div class="field"><label>CR Number</label><input id="suCrNumber" required></div>
            <div class="field"><label>Business Type</label><input id="suBusinessType" value="Restaurant"></div>
            <div class="field"><label>WhatsApp / Phone</label><input id="suPhone" inputmode="tel"></div>
          </div>
          <button class="btn primary auth-submit">Create vendor account</button>
        </form>
        <div class="relay-diagnostic"><span id="authRelayDot" class="dot"></span><div><b id="authRelayState">Connecting</b><small>Secure cloud service</small></div></div>
      </div>
    </section></main>`;
    UI.setStatus(DB.state.status);
    document.querySelectorAll('[data-auth-tab]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('[data-auth-tab]').forEach(item => item.classList.toggle('active', item === btn));
      document.querySelectorAll('.auth-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${btn.dataset.authTab}Panel`));
    });
    document.getElementById('signupPanel').onsubmit = e => runAuth(e, () => global.OmniAuth.signUpVendor({username:document.getElementById('suUser').value, password:document.getElementById('suPass').value, crName:document.getElementById('suCrName').value.trim(), crNumber:document.getElementById('suCrNumber').value.trim(), businessType:document.getElementById('suBusinessType').value.trim(), phone:document.getElementById('suPhone').value.trim()}));
    document.getElementById('loginPanel').onsubmit = e => runAuth(e, () => global.OmniAuth.login(document.getElementById('liUser').value, document.getElementById('liPass').value));
  }

  async function runAuth(event, action){
    event.preventDefault();
    const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"],button:not([type])');
    const label = submit?.textContent;
    if(submit){ submit.disabled=true; submit.textContent='Please wait…'; }
    try {
      currentUser = await action();
      startApp();
    } catch(error) {
      UI.toast(error.message || 'Could not continue','bad');
      if(submit?.isConnected){ submit.disabled=false; submit.textContent=label; }
    }
  }

  function syncPresence(){
    if(!currentUser) return;
    DB.put('presence', userId(), {id:userId(), userId:userId(), username:currentUser.username || '', vendorId:vendorId(), employeeId:currentUser.employeeId || '', role:currentUser.role || 'vendor_user', mode:'vendor', view:UI.activeView?.() || 'dashboard', online:true, updatedAt:Date.now()}, {userId:userId(), vendorId:vendorId()}).catch(() => {});
  }

  function startPresenceSync(){
    if(presenceTimer) clearInterval(presenceTimer);
    syncPresence();
    presenceTimer = setInterval(syncPresence, 30000);
  }

  async function publicVendorPayload(vendor){
    return {...vendor, id:vendor.id || vendorId(), products:'[]', updatedAt:Date.now()};
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

  function creditPolicy(){
    return mine('vendorCreditSettings').find(setting => setting.vendorId === vendorId()) || {id:`credit_policy_${vendorId()}`,vendorId:vendorId(),enabled:true,requireIndividualApproval:true,defaultCreditLimit:50,maximumCreditLimit:500,defaultDueDays:30,allowPosCredit:true,allowDeliveryCredit:true};
  }

  function creditAccountFor(orderOrPhone){
    const phone = typeof orderOrPhone === 'string' ? orderOrPhone : orderOrPhone?.customerPhone || '';
    const customerId = typeof orderOrPhone === 'object' ? orderOrPhone?.customerId || '' : '';
    return mine('creditAccounts').find(account => (customerId && account.customerId === customerId) || (phone && account.phone === phone));
  }

  function validateCredit(account, amount, channel='pos'){
    const policy = creditPolicy();
    if(policy.enabled === false) throw new Error('Customer credit is disabled by the vendor administrator');
    if(channel === 'pos' && policy.allowPosCredit === false) throw new Error('Credit is not allowed at POS checkout');
    if(channel === 'delivery' && policy.allowDeliveryCredit === false) throw new Error('Credit is not allowed for payment on delivery');
    if(!account || account.status !== 'active' || account.adminApproved !== true) throw new Error('This customer has not been approved for credit by the vendor administrator');
    const maximum = Number(policy.maximumCreditLimit || 0);
    const accountLimit = Number(account.creditLimit || 0);
    const effectiveLimit = maximum > 0 ? Math.min(accountLimit, maximum) : accountLimit;
    if(Number(account.balance || 0) + Number(amount || 0) > effectiveLimit) throw new Error('This transaction exceeds the customer credit limit');
    return {policy, effectiveLimit};
  }

  async function dispatchOrder(orderId){
    const order = mine('orders').find(item => item.id === orderId);
    if(!order) return;
    if(!order.customerAddress && !(Number(order.customerLat) && Number(order.customerLng))) return UI.toast('Add a delivery address or coordinates before dispatching','bad');
    const assignmentId = `delivery_${order.id}`;
    await DB.put('deliveryAssignments', assignmentId, {id:assignmentId,vendorId:vendorId(),orderId:order.id,status:'available',customerName:order.customerName||'',customerPhone:order.customerPhone||'',customerAddress:order.customerAddress||'',destinationLat:Number(order.customerLat||0),destinationLng:Number(order.customerLng||0),total:Number(order.total||0),paymentMethod:order.paymentMethod||'cash',createdAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
    await DB.patch('orders', order.id, {status:'ready_for_delivery',deliveryStatus:'waiting_driver',dispatchedAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
    await DB.event('order_ready_for_delivery','order',order.id,{vendorId:vendorId(),summary:`Order ${order.id} is ready for a driver`},{userId:userId(),vendorId:vendorId()});
    UI.toast('Order sent to the driver queue','ok');
    renderOrders();
  }

  function stopDriverTracking(){
    if(driverWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(driverWatchId);
    driverWatchId = null;
    lastDriverLocationWrite = 0;
  }

  function resetDriverMap(){
    try { driverMap?.remove(); } catch {}
    driverMap = null; driverMarker = null; driverDestinationMarker = null; driverRoute = null; driverLine = null;
  }

  function activeDriverAssignment(){
    return mine('deliveryAssignments').find(assignment => ['accepted','picked_up'].includes(assignment.status) && assignment.driverUserId === userId()) || null;
  }

  function renderDriverMap(order, assignment){
    const container = document.getElementById('driverRouteMap');
    if(!container || !global.L || !order) return;
    if(!driverMap || driverMap.getContainer() !== container) {
      resetDriverMap();
      driverMap = L.map(container).setView([26.0667,50.5577],12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(driverMap);
    }
    const destination = Number(order.customerLat) && Number(order.customerLng) ? L.latLng(Number(order.customerLat),Number(order.customerLng)) : null;
    const origin = Number(assignment?.driverLat) && Number(assignment?.driverLng) ? L.latLng(Number(assignment.driverLat),Number(assignment.driverLng)) : null;
    if(destination) {
      if(!driverDestinationMarker) driverDestinationMarker = L.marker(destination).addTo(driverMap).bindPopup('Delivery destination');
      else driverDestinationMarker.setLatLng(destination);
    }
    if(origin) {
      if(!driverMarker) driverMarker = L.circleMarker(origin,{radius:9,color:'#102841',fillColor:'#1fc996',fillOpacity:1,weight:3}).addTo(driverMap).bindPopup('Your live location');
      else driverMarker.setLatLng(origin);
    }
    if(driverRoute){ try { driverMap.removeControl(driverRoute); } catch {} driverRoute=null; }
    if(driverLine){ try { driverMap.removeLayer(driverLine); } catch {} driverLine=null; }
    if(origin && destination) {
      if(global.L.Routing?.control) {
        driverRoute = L.Routing.control({waypoints:[origin,destination],router:L.Routing.osrmv1({serviceUrl:'https://router.project-osrm.org/route/v1'}),routeWhileDragging:false,addWaypoints:false,draggableWaypoints:false,fitSelectedRoutes:true,show:false,createMarker:()=>null,lineOptions:{styles:[{color:'#2563eb',opacity:.85,weight:6}]}}).addTo(driverMap);
        driverRoute.on('routingerror', () => { if(!driverLine) driverLine=L.polyline([origin,destination],{color:'#2563eb',dashArray:'7 7',weight:4}).addTo(driverMap); });
      } else driverLine=L.polyline([origin,destination],{color:'#2563eb',dashArray:'7 7',weight:4}).addTo(driverMap);
      driverMap.fitBounds(L.latLngBounds([origin,destination]).pad(.18));
    } else if(destination) driverMap.setView(destination,14);
    setTimeout(()=>driverMap?.invalidateSize(),80);
  }

  function updateDriverMapLocation(lat,lng){
    if(!driverMap) return;
    const point=L.latLng(lat,lng);
    if(!driverMarker) driverMarker=L.circleMarker(point,{radius:9,color:'#102841',fillColor:'#1fc996',fillOpacity:1,weight:3}).addTo(driverMap).bindPopup('Your live location');
    else driverMarker.setLatLng(point);
  }

  function startDriverTracking(assignment){
    if(!navigator.geolocation) return UI.toast('Location tracking is unavailable on this device','bad');
    stopDriverTracking();
    driverWatchId = navigator.geolocation.watchPosition(position => {
      const lat=position.coords.latitude, lng=position.coords.longitude;
      updateDriverMapLocation(lat,lng);
      if(Date.now()-lastDriverLocationWrite<4000) return;
      lastDriverLocationWrite=Date.now();
      DB.patch('deliveryAssignments',assignment.id,{driverLat:lat,driverLng:lng,accuracy:Number(position.coords.accuracy||0),locationUpdatedAt:Date.now()}, {userId:userId(),vendorId:vendorId()}).catch(()=>{});
    }, error => UI.toast(error.message || 'Live location could not be updated','bad'), {enableHighAccuracy:true,maximumAge:3000,timeout:15000});
    UI.toast('Live delivery location is active','ok');
  }

  async function acceptDelivery(assignmentId){
    const assignment=mine('deliveryAssignments').find(item=>item.id===assignmentId);
    if(!assignment || assignment.status!=='available') return UI.toast('This delivery is no longer available','bad');
    const order=mine('orders').find(item=>item.id===assignment.orderId);
    if(!order) return UI.toast('Order details are unavailable','bad');
    const user=currentUserRecord();
    await DB.patch('deliveryAssignments',assignment.id,{status:'accepted',driverUserId:userId(),driverEmployeeId:currentUser.employeeId||'',driverName:user.displayName||currentUser.username||'Driver',driverPhone:user.phone||'',acceptedAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
    await DB.patch('orders',order.id,{status:'out_for_delivery',deliveryStatus:'active',driverUserId:userId(),outForDeliveryAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
    driverSelectedOrderId=order.id;
    const updated={...assignment,status:'accepted',driverUserId:userId()};
    startDriverTracking(updated);
    UI.toast('Delivery accepted. The customer can now follow your location','ok');
    renderDeliveries();
  }

  async function completeDelivery(assignmentId){
    const assignment=mine('deliveryAssignments').find(item=>item.id===assignmentId);
    const order=assignment&&mine('orders').find(item=>item.id===assignment.orderId);
    if(!assignment||!order) return;
    const method=document.getElementById('deliveryPaymentMethod')?.value||order.paymentMethod||'cash';
    const paid=mine('payments').some(payment=>payment.orderId===order.id&&['paid','credit'].includes(payment.status));
    try {
      if(!paid){
        if(method==='credit') await chargeCredit(order.customerPhone,order,'delivery');
        await DB.put('payments',U.uid('payment'),{orderId:order.id,vendorId:vendorId(),method,amount:Number(order.total||0),status:method==='credit'?'credit':'paid',collectedBy:userId(),collectedAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
      }
      await DB.patch('deliveryAssignments',assignment.id,{status:'delivered',deliveredAt:Date.now()}, {userId:userId(),vendorId:vendorId()});
      await DB.patch('orders',order.id,{status:'done',deliveryStatus:'delivered',deliveredAt:Date.now(),paymentMethod:method}, {userId:userId(),vendorId:vendorId()});
      stopDriverTracking(); resetDriverMap(); driverSelectedOrderId='';
      UI.toast('Delivery completed and payment recorded','ok'); renderDeliveries();
    } catch(error){ UI.toast(error.message||'Delivery could not be completed','bad'); }
  }

  function renderDeliveries(){
    const isDriver=currentUser?.role==='driver';
    if(isDriver&&!can('orders.delivery')) { document.getElementById('deliveries').innerHTML=permissionGate('This account is not assigned to delivery work.'); return; }
    if(!isDriver&&!can('orders.read')&&!can('orders.*')&&!can('vendor.*')) { document.getElementById('deliveries').innerHTML=permissionGate('This role cannot view delivery records.'); return; }
    const assignments=mine('deliveryAssignments');
    const history=assignments.filter(item=>item.status==='delivered'&&(!isDriver||item.driverUserId===userId())).sort((a,b)=>Number(b.deliveredAt||b.updatedAt||0)-Number(a.deliveredAt||a.updatedAt||0));
    const historyTable=UI.table(history,[{key:'orderId',label:'Order'},{key:'customerName',label:'Customer'},{key:'driverName',label:'Driver'},{key:'deliveredAt',label:'Delivered',format:r=>r.deliveredAt?new Date(Number(r.deliveredAt)).toLocaleString():'-'},{key:'total',label:'Total',format:r=>U.money(r.total)}]);
    if(!isDriver){
      const activeRows=assignments.filter(item=>['available','accepted','picked_up'].includes(item.status)).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
      document.getElementById('deliveries').innerHTML=`<div class="grid cols-3">${UI.stat('Awaiting driver',activeRows.filter(item=>item.status==='available').length)}${UI.stat('Out for delivery',activeRows.filter(item=>['accepted','picked_up'].includes(item.status)).length,{text:'live',cls:'ok'})}${UI.stat('Completed deliveries',history.length)}</div><section class="card pad"><div class="head"><h2>Active deliveries</h2><span class="pill">${activeRows.length} active</span></div>${UI.table(activeRows,[{key:'orderId',label:'Order'},{key:'customerName',label:'Customer'},{key:'customerPhone',label:'Phone'},{key:'driverName',label:'Driver'},{key:'status',label:'Status'}])}</section><section class="card pad"><div class="head"><h2>Delivery history</h2><span class="pill">${history.length} completed</span></div>${historyTable}</section>`;
      return;
    }
    const available=assignments.filter(item=>item.status==='available').filter(item=>{const order=mine('orders').find(row=>row.id===item.orderId);return order&&matchesTerm(order,['id','customerName','customerPhone','customerAddress']);});
    const active=activeDriverAssignment();
    if(active) driverSelectedOrderId=active.orderId;
    const selected=active||assignments.find(item=>item.orderId===driverSelectedOrderId&&item.status==='available')||available[0]||null;
    const order=selected&&mine('orders').find(item=>item.id===selected.orderId);
    const items=order?mine('orderItems').filter(item=>item.orderId===order.id):[];
    const destination=order&&Number(order.customerLat)&&Number(order.customerLng)?`${Number(order.customerLat)},${Number(order.customerLng)}`:'';
    document.getElementById('deliveries').innerHTML=`<div class="driver-workspace"><section class="card driver-queue"><div class="driver-section-head"><div><span class="eyebrow">Driver queue</span><h1>Deliveries</h1></div><span class="pill ${available.length?'warn':'ok'}">${available.length} available</span></div><div class="delivery-list">${available.map(item=>{const row=mine('orders').find(order=>order.id===item.orderId)||{};return `<button class="delivery-list-item ${selected?.id===item.id?'active':''}" data-select-delivery="${U.esc(item.orderId)}"><strong>${U.esc(row.customerName||'Customer')}</strong><span>${U.esc(row.customerAddress||'Location pin')}</span><b>${U.money(row.total)}</b></button>`;}).join('')||'<div class="pos-empty"><strong>No deliveries waiting</strong><span>Prepared orders will appear here automatically.</span></div>'}</div></section><section class="card driver-detail">${order?`<div class="driver-section-head"><div><span class="eyebrow">${active?'Active delivery':'Delivery details'}</span><h2>${U.esc(order.customerName||'Customer')}</h2></div><span class="pill ${active?'ok':'warn'}">${U.esc(active?'Tracking live':'Available')}</span></div><div class="driver-customer"><div><span>Phone</span><a href="tel:${U.esc(order.customerPhone||'')}">${U.esc(order.customerPhone||'Not provided')}</a></div><div><span>Address</span><b>${U.esc(order.customerAddress||'Pinned location')}</b></div><div><span>Order</span><b>${items.map(item=>`${item.nameSnapshot||'Item'} × ${item.qty||0}`).join(', ')||order.id}</b></div><div><span>Amount</span><b>${U.money(order.total)}</b></div></div>${destination?`<div id="driverRouteMap" class="driver-route-map"></div>`:'<div class="empty">This order has no map coordinates. Use the written address and contact the customer.</div>'}<div class="driver-actions">${!active?`<button class="btn primary" data-accept-delivery="${U.esc(selected.id)}">Accept delivery</button>`:`<button class="btn" id="resumeTrackingBtn">Resume live tracking</button><a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}">Open navigation</a><div class="field"><label>Payment on delivery</label><select id="deliveryPaymentMethod"><option value="cash" ${order.paymentMethod==='cash'?'selected':''}>Cash</option><option value="benefit" ${order.paymentMethod==='benefit'?'selected':''}>Benefit</option><option value="card" ${order.paymentMethod==='card'?'selected':''}>Card</option><option value="credit" ${order.paymentMethod==='credit'?'selected':''}>Approved credit</option></select></div><button class="btn primary" data-complete-delivery="${U.esc(active.id)}">Complete delivery</button>`}</div>`:'<div class="pos-empty"><strong>Select a delivery</strong><span>Customer and route details will appear here.</span></div>'}</section></div><section class="card pad delivery-history"><div class="head"><h2>My delivery history</h2><span class="pill">${history.length} completed</span></div>${historyTable}</section>`;
    document.querySelectorAll('[data-select-delivery]').forEach(btn=>btn.onclick=()=>{driverSelectedOrderId=btn.dataset.selectDelivery;renderDeliveries();});
    document.querySelectorAll('[data-accept-delivery]').forEach(btn=>btn.onclick=()=>acceptDelivery(btn.dataset.acceptDelivery));
    document.querySelectorAll('[data-complete-delivery]').forEach(btn=>btn.onclick=()=>completeDelivery(btn.dataset.completeDelivery));
    document.getElementById('resumeTrackingBtn')?.addEventListener('click',()=>startDriverTracking(active));
    if(order&&selected) renderDriverMap(order,selected);
  }

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
      <div class="grid split"><div class="card pad"><div class="head"><h2>Recent Orders</h2></div>${UI.table(orders.slice(-8).reverse(), [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}])}</div><div class="card pad"><h2>Role</h2><p><b>${U.esc(currentUser.role)}</b></p><p class="muted">Vendor: ${U.esc(vendorProfile().crName || vendorId())}</p><p class="muted">Public status: ${U.esc(vendorProfile().status || 'pending')}</p></div></div>`;
  }

  function syncSaleDraft(){
    const name = document.getElementById('posCustomerName');
    if(name) POS.sale.customerName = name.value;
    const phone = document.getElementById('posPhone');
    if(phone) POS.sale.phone = phone.value;
    const note = document.getElementById('posNote');
    if(note) POS.sale.note = note.value;
    const payment = document.getElementById('posPayment');
    if(payment) POS.sale.paymentMethod = payment.value;
    const discount = document.getElementById('posDiscount');
    if(discount) POS.sale.discount = Math.max(0, Number(discount.value || 0));
  }

  function updatePosTotals(){
    const discount = document.getElementById('posDiscountValue');
    const total = document.getElementById('posGrandTotal');
    const complete = document.getElementById('completeSaleBtn');
    if(discount) discount.textContent = U.money(POS.discount());
    if(total) total.textContent = U.money(POS.total());
    if(complete) complete.textContent = `Complete sale · ${U.money(POS.total())}`;
  }

  function addProductToSale(product){
    const result = POS.add(product);
    if(!result.ok) return UI.toast(result.error || 'Product could not be added','bad');
    renderPos();
  }

  function posProductCard(product){
    const image = productImage(product);
    const tracked = product.stockMode === 'track';
    const stock = Number(product.stockQty || 0);
    const unavailable = tracked && stock <= 0;
    const low = tracked && stock > 0 && stock <= Number(product.lowStockThreshold || 0);
    return `<article class="pos-product ${unavailable?'sold-out':''}">
      <div class="pos-product-media">${image?`<img src="${U.esc(image)}" alt="${U.esc(product.name || 'Product')}">`:`<span>${productInitial(product)}</span>`}${product.featured===true?'<span class="pos-featured">Featured</span>':''}</div>
      <div class="pos-product-body"><span class="eyebrow">${U.esc(product.category || 'General')}</span><h3>${U.esc(product.name)}</h3><div class="pos-product-meta"><b>${U.money(product.price)}</b><span class="pill ${unavailable?'bad':low?'warn':'ok'}">${tracked ? unavailable ? 'Out of stock' : `${stock} in stock` : U.esc(product.unit || 'Available')}</span></div><button class="btn primary" data-add-product="${U.esc(product.id)}" ${unavailable?'disabled':''}>Add to sale</button></div>
    </article>`;
  }

  function renderPos(){
    if(!can('pos.use')) { document.getElementById('pos').innerHTML = permissionGate('This employee role cannot use the POS sale screen.'); return; }
    const allProducts = mine('products').filter(product=>product.active!==false).sort((a,b)=>String(a.category||'').localeCompare(String(b.category||'')) || String(a.name||'').localeCompare(String(b.name||'')));
    const categories = ['All', ...new Set(allProducts.map(product=>product.category || 'General'))];
    if(!categories.includes(posCategory)) posCategory = 'All';
    const products = allProducts.filter(product => (posCategory === 'All' || (product.category || 'General') === posCategory) && matchesTerm(product, ['name','category','barcode','sku','description','attributesJson']));
    document.getElementById('pos').innerHTML = `<div class="pos-workspace">
      <section class="card pos-catalog-panel">
        <div class="pos-catalog-head"><div><span class="eyebrow">Fast checkout</span><h1>Point of Sale</h1><p>${products.length} of ${allProducts.length} products</p></div><div class="pos-scan"><label for="posScan">Barcode or SKU</label><div><input id="posScan" placeholder="Scan or enter code" autocomplete="off"><button id="posCameraScanBtn" class="btn" type="button">Camera</button><button id="posScanBtn" class="btn blue" type="button">Add</button></div></div></div>
        <div class="pos-category-tabs">${categories.map(category=>`<button type="button" class="${category===posCategory?'active':''}" data-pos-category="${U.esc(category)}">${U.esc(category)}</button>`).join('')}</div>
        <div class="pos-product-grid">${products.map(posProductCard).join('') || '<div class="pos-empty full"><strong>No matching products</strong><span>Try another category, name, barcode, or SKU.</span></div>'}</div>
      </section>
      ${global.VendorPOS.renderCart()}
    </div>`;
    ['posCustomerName','posPhone','posNote'].forEach(id => document.getElementById(id)?.addEventListener('input', syncSaleDraft));
    document.getElementById('posPayment')?.addEventListener('change', syncSaleDraft);
    document.getElementById('posDiscount')?.addEventListener('input', () => { syncSaleDraft(); updatePosTotals(); });
    document.querySelectorAll('[data-pos-category]').forEach(btn => btn.onclick = () => { syncSaleDraft(); posCategory = btn.dataset.posCategory; renderPos(); });
    document.querySelectorAll('[data-add-product]').forEach(btn => btn.onclick = () => addProductToSale(allProducts.find(product=>product.id===btn.dataset.addProduct)));
    document.querySelectorAll('[data-cart-decrease]').forEach(btn => btn.onclick = () => { syncSaleDraft(); POS.remove(btn.dataset.cartDecrease); renderPos(); });
    document.querySelectorAll('[data-cart-increase]').forEach(btn => btn.onclick = () => { syncSaleDraft(); const line=POS.cart.find(item=>item.productId===btn.dataset.cartIncrease); addProductToSale(allProducts.find(product=>product.id===line?.productId)); });
    document.querySelectorAll('[data-cart-remove-line]').forEach(btn => btn.onclick = () => { syncSaleDraft(); POS.removeLine(btn.dataset.cartRemoveLine); renderPos(); });
    const scan = () => {
      const code = document.getElementById('posScan').value.trim().toLowerCase();
      if(!code) return;
      const product = allProducts.find(item => String(item.barcode || '').toLowerCase() === code || String(item.sku || '').toLowerCase() === code || String(item.qrCode || '').toLowerCase() === code);
      if(!product) return UI.toast('No product matches this code','bad');
      addProductToSale(product);
    };
    document.getElementById('posScanBtn').onclick = scan;
    document.getElementById('posCameraScanBtn').onclick = () => startBarcodeScanner(code => { const input=document.getElementById('posScan'); if(input) input.value=code; const product=allProducts.find(item=>[item.barcode,item.sku,item.qrCode].some(value=>String(value||'').toLowerCase()===code.toLowerCase())); if(product) addProductToSale(product); else UI.toast('Barcode was read but no product matches it','bad'); });
    document.getElementById('posScan').onkeydown = event => { if(event.key === 'Enter'){ event.preventDefault(); scan(); } };
    document.getElementById('completeSaleBtn')?.addEventListener('click', completeSale);
  }

  async function completeSale(){
    syncSaleDraft();
    if(completingSale) return;
    if(!vendorId()) return UI.toast('Login again before completing a sale','bad');
    if(!POS.cart.length) return UI.toast('Cart is empty','bad');
    const id = U.uid('order');
    const phone = POS.sale.phone.trim();
    const paymentMethod = POS.sale.paymentMethod;
    if(paymentMethod === 'credit' && !phone) return UI.toast('Customer phone is required for credit','bad');
    if(paymentMethod === 'credit') {
      try { validateCredit(creditAccountFor(phone), POS.total(), 'pos'); }
      catch(error) { return UI.toast(error.message,'bad'); }
    }
    completingSale = true;
    const submit = document.getElementById('completeSaleBtn');
    if(submit) { submit.disabled = true; submit.textContent = 'Saving sale...'; }
    try {
    for(const line of POS.lines()) {
      const product = mine('products').find(item => item.id === line.productId);
      if(product?.stockMode === 'track' && Number(product.stockQty || 0) < line.qty) throw new Error(`${product.name} no longer has enough stock`);
    }
    const order = {id, vendorId:vendorId(), customerPhone:phone, customerName:POS.sale.customerName.trim() || phone || 'Walk-in', note:POS.sale.note.trim(), status:'done', paymentMethod, subtotal:POS.subtotal(), discount:POS.discount(), total:POS.total(), source:'pos', createdBy:userId(), createdAt:Date.now()};
    await DB.put('orders', id, order, {userId:userId(), vendorId:vendorId()});
    for(const line of POS.lines()) {
      await DB.put('orderItems', U.uid('item'), {orderId:id, vendorId:vendorId(), productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, attributesSnapshot:line.attributesJson || '[]', qty:line.qty, total:line.total}, {userId:userId(), vendorId:vendorId()});
      const product = mine('products').find(item => item.id === line.productId);
      if(product?.stockMode === 'track') await DB.patch('products', product.id, {stockQty:Math.max(0, Number(product.stockQty || 0) - line.qty)}, {userId:userId(), vendorId:vendorId()});
    }
    await DB.put('payments', U.uid('payment'), {orderId:id, vendorId:vendorId(), method:paymentMethod, amount:order.total, status:paymentMethod==='credit'?'credit':'paid'}, {userId:userId(), vendorId:vendorId()});
    if(paymentMethod === 'credit' && phone) await chargeCredit(phone, order, 'pos');
    await syncPublicVendor();
    await DB.event('pos_sale_completed','order',id,{vendorId:vendorId(), summary:`POS sale ${U.money(order.total)}`},{userId:userId(), vendorId:vendorId()});
    POS.clear(); UI.toast('Sale completed','ok'); renderPos();
    } catch(error) {
      UI.toast(error.message || 'Sale could not be saved','bad');
    } finally {
      completingSale = false;
      if(submit?.isConnected) { submit.disabled = false; submit.textContent = 'Complete sale'; }
    }
  }

  async function chargeCredit(phone, order, channel='pos'){
    const account = creditAccountFor(typeof order === 'object' ? order : phone);
    validateCredit(account, order.total, channel);
    const nextBalance = Number(account.balance||0) + Number(order.total||0);
    const dueAt=Date.now()+Number(account.dueDays||creditPolicy().defaultDueDays||30)*86400000;
    await DB.put('creditAccounts', account.id, {...account, balance:nextBalance, nextDueAt:dueAt}, {userId:userId(), vendorId:vendorId()});
    await DB.put('creditTransactions', U.uid('ctx'), {vendorId:vendorId(), creditAccountId:account.id, type:'charge', amount:order.total, orderId:order.id, dueAt, note:channel==='delivery'?'Delivery credit charge':'POS credit charge'}, {userId:userId(), vendorId:vendorId()});
  }

  function productManagerCard(product, canWrite){
    const image = productImage(product);
    const attributes = productAttributes(product);
    const tracked = product.stockMode === 'track';
    const stock = Number(product.stockQty || 0);
    const low = tracked && stock <= Number(product.lowStockThreshold || 0);
    return `<article class="catalog-row">
      <div class="catalog-thumb">${image?`<img src="${U.esc(image)}" alt="">`:`<span>${productInitial(product)}</span>`}</div>
      <div class="catalog-main"><div class="catalog-title"><h3>${U.esc(product.name)}</h3><span class="pill ${product.active===false?'bad':'ok'}">${product.active===false?'Hidden':'Active'}</span>${product.featured===true?'<span class="pill warn">Featured</span>':''}</div><p>${U.esc(product.category || 'General')} · ${U.esc(product.itemType || 'product')} · ${U.esc(product.sku || 'No SKU')}</p><div class="attribute-chips">${attributes.slice(0,3).map(item=>`<span>${U.esc(item.name)}: ${U.esc(item.value)}</span>`).join('')}${attributes.length>3?`<span>+${attributes.length-3}</span>`:''}</div></div>
      <div class="catalog-numbers"><b>${U.money(product.price)}</b><span class="${low?'stock-low':''}">${tracked ? `${stock} in stock` : 'Stock not tracked'}</span></div>
      ${canWrite?`<div class="catalog-actions"><button class="btn small" data-edit-product="${U.esc(product.id)}">Edit</button><button class="btn small danger" data-delete-product="${U.esc(product.id)}">Archive</button></div>`:''}
    </article>`;
  }

  function attributeEditorRows(){
    return productEditor.attributes.map((item,index)=>`<div class="attribute-row" data-product-attribute><input id="prodAttrName${index}" data-attribute-name value="${U.esc(item.name)}" placeholder="Attribute, e.g. Size"><input id="prodAttrValue${index}" data-attribute-value value="${U.esc(item.value)}" placeholder="Value, e.g. Large"><button type="button" class="icon-btn danger-icon" data-remove-attribute="${index}" aria-label="Remove attribute">×</button></div>`).join('');
  }

  function productImageEditor(){
    return `<div class="product-images">${productEditor.images.map((source,index)=>`<div class="product-image-item ${index===0?'primary-image':''}"><img src="${U.esc(source)}" alt="Product image ${index+1}"><span>${index===0?'Primary':`Image ${index+1}`}</span><div>${index?`<button type="button" class="btn small" data-primary-image="${index}">Make primary</button>`:''}<button type="button" class="icon-btn danger-icon" data-remove-image="${index}" aria-label="Remove image">×</button></div></div>`).join('') || '<div class="image-empty">No images added</div>'}</div>`;
  }

  function productEditorForm(product){
    const editing = !!productEditor.id;
    const value = (key, fallback='') => U.esc(product?.[key] ?? fallback);
    return `<form id="productForm" class="card product-editor form">
      <div class="product-editor-head"><div><span class="eyebrow">${editing?'Catalog update':'New catalog item'}</span><h2>${editing?'Edit product':'Add product or service'}</h2></div>${editing?'<button id="cancelProductEdit" type="button" class="btn ghost">Cancel edit</button>':''}</div>
      <section class="product-form-section"><h3>Details</h3><div class="form-grid"><div class="field"><label>Name</label><input id="prodName" required value="${value('name')}"></div><div class="field"><label>Category</label><input id="prodCategory" required value="${value('category','General')}"></div><div class="field"><label>Type</label><select id="prodItemType"><option value="product" ${(product?.itemType||'product')==='product'?'selected':''}>Product</option><option value="service" ${product?.itemType==='service'?'selected':''}>Service</option></select></div><div class="field"><label>Unit</label><input id="prodUnit" value="${value('unit','each')}" placeholder="each, kg, hour"></div><div class="field full"><label>Description</label><textarea id="prodDescription" placeholder="What customers should know">${value('description')}</textarea></div></div></section>
      <section class="product-form-section"><h3>Pricing</h3><div class="form-grid cols-3"><div class="field"><label>Selling price</label><input id="prodPrice" type="number" min="0" step="0.001" required value="${value('price',0)}"></div><div class="field"><label>Compare-at price</label><input id="prodComparePrice" type="number" min="0" step="0.001" value="${value('compareAtPrice',0)}"></div><div class="field"><label>Cost</label><input id="prodCost" type="number" min="0" step="0.001" value="${value('cost',0)}"></div><div class="field"><label>Tax rate %</label><input id="prodTaxRate" type="number" min="0" max="100" step="0.01" value="${value('taxRate',0)}"></div><div class="field"><label>Preparation minutes</label><input id="prodPrep" type="number" min="0" step="1" value="${value('preparationMinutes',0)}"></div></div></section>
      <section class="product-form-section"><h3>Codes & inventory</h3><div class="form-grid"><div class="field"><label>SKU</label><input id="prodSku" value="${value('sku')}"></div><div class="field"><label>Barcode</label><div class="code-input"><input id="prodBarcode" value="${value('barcode')}"><button id="scanProductBarcodeBtn" class="btn" type="button">Scan</button></div></div><div class="field"><label>QR code value</label><input id="prodQr" value="${value('qrCode')}"></div><div class="field"><label>Stock mode</label><select id="prodStockMode"><option value="none" ${(product?.stockMode||'none')==='none'?'selected':''}>Do not track</option><option value="track" ${product?.stockMode==='track'?'selected':''}>Track quantity</option></select></div><div class="field"><label>Stock quantity</label><input id="prodStock" type="number" min="0" step="1" value="${value('stockQty',0)}"></div><div class="field"><label>Low-stock alert at</label><input id="prodLowStock" type="number" min="0" step="1" value="${value('lowStockThreshold',0)}"></div></div></section>
      <section class="product-form-section"><div class="section-title"><h3>Attributes</h3><button id="addAttributeBtn" type="button" class="btn small">Add attribute</button></div><p class="section-help">Add details such as size, color, material, brand, duration, or dietary information.</p><div id="productAttributes" class="attribute-editor">${attributeEditorRows()}</div></section>
      <section class="product-form-section"><div class="section-title"><h3>Images</h3><span class="pill">${productEditor.images.length}/3</span></div><p class="section-help">Upload up to three images or take a photo. Files are resized automatically.</p>${productImageEditor()}<div class="image-actions"><div class="image-source-buttons"><label class="btn image-upload">Choose images<input id="prodImageFiles" type="file" accept="image/*" multiple></label><label class="btn image-upload">Take photo<input id="prodImageCamera" type="file" accept="image/*" capture="environment"></label></div><div class="image-url"><input id="prodImageUrl" placeholder="Or paste an image URL"><button id="addImageUrlBtn" class="btn" type="button">Add URL</button></div></div></section>
      <section class="product-form-section product-options"><label><input id="prodActive" type="checkbox" ${product?.active===false?'':'checked'}> Available for sale</label><label><input id="prodFeatured" type="checkbox" ${product?.featured===true?'checked':''}> Featured item</label></section>
      <div class="product-editor-footer"><button class="btn primary">${editing?'Save changes':'Create product'}</button>${editing?'<button id="archiveProductBtn" type="button" class="btn danger">Archive product</button>':''}</div>
    </form>`;
  }

  function renderProducts(){
    if(!can('products.read')) { document.getElementById('products').innerHTML = permissionGate('This role cannot view products.'); return; }
    const allProducts = mine('products').sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
    const products = allProducts.filter(product=>matchesTerm(product, ['name','category','barcode','sku','description','attributesJson']));
    const canWrite = can('products.create') || can('products.update');
    const editingProduct = productEditor.id ? allProducts.find(product=>product.id===productEditor.id) : null;
    if(productEditor.id && !editingProduct) resetProductEditor();
    const activeCount = allProducts.filter(product=>product.active!==false).length;
    const lowCount = allProducts.filter(product=>product.stockMode==='track' && Number(product.stockQty||0)<=Number(product.lowStockThreshold||0)).length;
    document.getElementById('products').innerHTML = `<div class="product-management">
      <section class="card catalog-panel"><div class="catalog-head"><div><span class="eyebrow">Catalog</span><h1>Products & services</h1><p>${activeCount} active · ${lowCount} low stock</p></div>${canWrite?'<button id="newProductBtn" class="btn primary">New product</button>':''}</div><div class="catalog-list">${products.map(product=>productManagerCard(product,canWrite)).join('') || '<div class="pos-empty"><strong>No products found</strong><span>Create a product or adjust your search.</span></div>'}</div></section>
      ${canWrite?productEditorForm(editingProduct):permissionGate('This role can view the catalog but cannot change products.')}
    </div>`;
    if(!canWrite) return;
    document.getElementById('newProductBtn').onclick = () => { resetProductEditor(); renderProducts(); document.getElementById('productForm')?.scrollIntoView({behavior:'smooth',block:'start'}); };
    document.getElementById('cancelProductEdit')?.addEventListener('click', () => { resetProductEditor(); renderProducts(); });
    document.querySelectorAll('[data-edit-product]').forEach(btn => btn.onclick = () => { const product=allProducts.find(item=>item.id===btn.dataset.editProduct); if(product){ beginProductEdit(product); renderProducts(); document.getElementById('productForm')?.scrollIntoView({behavior:'smooth',block:'start'}); } });
    document.querySelectorAll('[data-attribute-name],[data-attribute-value]').forEach(input => input.addEventListener('input', syncEditorAttributes));
    document.getElementById('addAttributeBtn').onclick = () => { syncEditorAttributes(); productEditor.attributes.push({name:'',value:''}); rerenderProductsKeepingFields(); document.querySelector('[data-product-attribute]:last-child input')?.focus(); };
    document.querySelectorAll('[data-remove-attribute]').forEach(btn => btn.onclick = () => { syncEditorAttributes(); productEditor.attributes.splice(Number(btn.dataset.removeAttribute),1); if(!productEditor.attributes.length) productEditor.attributes.push({name:'',value:''}); rerenderProductsKeepingFields(); });
    document.querySelectorAll('[data-remove-image]').forEach(btn => btn.onclick = () => { productEditor.images.splice(Number(btn.dataset.removeImage),1); rerenderProductsKeepingFields(); });
    document.querySelectorAll('[data-primary-image]').forEach(btn => btn.onclick = () => { const index=Number(btn.dataset.primaryImage); const [image]=productEditor.images.splice(index,1); productEditor.images.unshift(image); rerenderProductsKeepingFields(); });
    document.getElementById('addImageUrlBtn').onclick = () => {
      const input = document.getElementById('prodImageUrl');
      const source = input.value.trim();
      if(productEditor.images.length >= 3) return UI.toast('A product can have up to three images','bad');
      if(!/^https?:\/\//i.test(source) && !/^data:image\//i.test(source)) return UI.toast('Enter a valid image URL','bad');
      productEditor.images.push(source); rerenderProductsKeepingFields(); const next=document.getElementById('prodImageUrl'); if(next) next.value='';
    };
    document.getElementById('scanProductBarcodeBtn').onclick = () => startBarcodeScanner(code => { const input=document.getElementById('prodBarcode'); if(input){ input.value=code; input.dispatchEvent(new Event('input',{bubbles:true})); } });
    const addProductImageFiles = async event => {
      if(productImageBusy) return;
      const files = [...event.target.files];
      if(!files.length) return;
      if(productEditor.images.length + files.length > 3) return UI.toast('Choose no more than three images in total','bad');
      productImageBusy = true;
      try {
        const added = [];
        for(const file of files) added.push(await compressProductImage(file));
        productEditor.images.push(...added);
        rerenderProductsKeepingFields();
        UI.toast(`${files.length} image${files.length===1?'':'s'} added`,'ok');
      } catch(error) { UI.toast(error.message || 'Image could not be added','bad'); }
      finally { productImageBusy = false; }
    };
    document.getElementById('prodImageFiles').onchange = addProductImageFiles;
    document.getElementById('prodImageCamera').onchange = addProductImageFiles;
    const archiveProduct = async id => {
      if(!confirm('Archive this product? It will no longer appear for sale.')) return;
      await DB.softDelete('products', id, {userId:userId(), vendorId:vendorId()});
      if(productEditor.id===id) resetProductEditor();
      await syncPublicVendor(); UI.toast('Product archived','ok'); renderProducts();
    };
    document.querySelectorAll('[data-delete-product]').forEach(btn => btn.onclick = () => archiveProduct(btn.dataset.deleteProduct));
    document.getElementById('archiveProductBtn')?.addEventListener('click', () => archiveProduct(productEditor.id));
    document.getElementById('productForm').onsubmit = async event => {
      event.preventDefault();
      syncEditorAttributes();
      const id = productEditor.id || U.uid('product');
      const wasEditing = !!productEditor.id;
      const existing = allProducts.find(product=>product.id===id) || {};
      const barcode = document.getElementById('prodBarcode').value.trim();
      const sku = document.getElementById('prodSku').value.trim();
      if(barcode && allProducts.some(product=>product.id!==id && String(product.barcode||'').toLowerCase()===barcode.toLowerCase())) return UI.toast('This barcode is already used by another product','bad');
      if(sku && allProducts.some(product=>product.id!==id && String(product.sku||'').toLowerCase()===sku.toLowerCase())) return UI.toast('This SKU is already used by another product','bad');
      const attributes = productEditor.attributes.filter(item=>item.name || item.value);
      const record = {...existing, id, vendorId:vendorId(), name:document.getElementById('prodName').value.trim(), category:document.getElementById('prodCategory').value.trim() || 'General', description:document.getElementById('prodDescription').value.trim(), itemType:document.getElementById('prodItemType').value, unit:document.getElementById('prodUnit').value.trim() || 'each', price:Number(document.getElementById('prodPrice').value||0), compareAtPrice:Number(document.getElementById('prodComparePrice').value||0), cost:Number(document.getElementById('prodCost').value||0), taxRate:Number(document.getElementById('prodTaxRate').value||0), preparationMinutes:Number(document.getElementById('prodPrep').value||0), sku, barcode, qrCode:document.getElementById('prodQr').value.trim(), stockMode:document.getElementById('prodStockMode').value, stockQty:Number(document.getElementById('prodStock').value||0), lowStockThreshold:Number(document.getElementById('prodLowStock').value||0), image:productEditor.images[0]||'', imagesJson:JSON.stringify(productEditor.images), attributesJson:JSON.stringify(attributes), active:document.getElementById('prodActive').checked, featured:document.getElementById('prodFeatured').checked};
      const submit = event.submitter;
      if(submit) { submit.disabled=true; submit.textContent='Saving...'; }
      try {
        const result = await DB.put('products', id, record, {userId:userId(), vendorId:vendorId()});
        await syncPublicVendor();
        resetProductEditor();
        const action = wasEditing ? 'Product updated' : 'Product created';
        UI.toast(result.synced ? `${action} and synced` : `${action} · waiting to sync`, result.synced ? 'ok' : '');
        renderProducts();
      } catch(error) { UI.toast(error.message || 'Product could not be saved','bad'); if(submit?.isConnected){submit.disabled=false;submit.textContent=productEditor.id?'Save changes':'Create product';} }
    };
  }

  function renderOrders(){
    if(!can('orders.read')) { document.getElementById('orders').innerHTML = permissionGate('This role cannot view orders.'); return; }
    const orders = mine('orders').filter(o=>matchesTerm(o, ['id','customerName','customerPhone','customerAddress','paymentMethod','status'])).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
    const canUpdate = can('orders.update_status') || can('orders.*');
    const canDispatch = can('orders.delivery_dispatch') || can('orders.*');
    const actions = row => {
      if(!canUpdate || ['done','cancelled'].includes(row.status)) return '';
      if(row.status === 'pending') return `<button class="btn small primary" data-status="${row.id}" data-next="accepted">Accept</button> <button class="btn small danger" data-status="${row.id}" data-next="cancelled">Cancel</button>`;
      if(row.status === 'accepted') return `<button class="btn small primary" data-status="${row.id}" data-next="preparing">Start preparing</button> <button class="btn small danger" data-status="${row.id}" data-next="cancelled">Cancel</button>`;
      if(row.status === 'preparing' && row.source === 'customer' && canDispatch) return `<button class="btn small primary" data-dispatch-order="${row.id}">Out for delivery</button> <button class="btn small danger" data-status="${row.id}" data-next="cancelled">Cancel</button>`;
      if(['ready_for_delivery','out_for_delivery'].includes(row.status)) return '<span class="pill warn">Driver workflow active</span>';
      return `<button class="btn small primary" data-status="${row.id}" data-next="done">Mark done</button> <button class="btn small danger" data-status="${row.id}" data-next="cancelled">Cancel</button>`;
    };
    const itemSummary = order => {
      const items = mine('orderItems').filter(item => item.orderId === order.id);
      return items.map(item => `${item.nameSnapshot || 'Item'} × ${Number(item.qty || 0)}`).join(', ') || '-';
    };
    document.getElementById('orders').innerHTML = `<div class="card pad"><div class="head"><h2>Orders</h2><span class="pill ${pendingCustomerOrders().length ? 'warn' : ''}">${orders.length} records</span></div>${UI.table(orders, [{key:'id',label:'Order'}, {key:'customerName',label:'Customer'}, {key:'items',label:'Items',format:itemSummary}, {key:'customerPhone',label:'Phone'}, {key:'customerAddress',label:'Address'}, {key:'paymentMethod',label:'Payment'}, {key:'status',label:'Status'}, {key:'total',label:'Total',format:r=>U.money(r.total)}], actions)}</div>`;
    document.querySelectorAll('[data-status]').forEach(btn => btn.onclick = async () => {
      const next = btn.dataset.next;
      const timing = next === 'accepted' ? {acceptedAt:Date.now()} : next === 'cancelled' ? {cancelledAt:Date.now()} : next === 'done' ? {completedAt:Date.now()} : {preparingAt:Date.now()};
      await DB.patch('orders', btn.dataset.status, {status:next, ...timing}, {userId:userId(), vendorId:vendorId()});
      updateOrderAlert();
      UI.toast(next === 'accepted' ? 'Order accepted' : next === 'cancelled' ? 'Order cancelled' : 'Order updated','ok');
      renderOrders();
    });
    document.querySelectorAll('[data-dispatch-order]').forEach(btn => btn.onclick = () => dispatchOrder(btn.dataset.dispatchOrder));
  }

  function renderCustomers(){
    if(!can('credit.read')) { document.getElementById('customers').innerHTML = permissionGate('This role cannot view customer credit records.'); return; }
    const accounts = mine('creditAccounts').filter(c=>matchesTerm(c, ['phone','customerName','status']));
    const ledger = mine('creditTransactions').filter(t=>matchesTerm(t, ['type','note','creditAccountId'])).slice(-20).reverse();
    const isOwner = currentUser.role === 'vendor_owner';
    const canPay = can('credit.payment') || can('credit.*');
    const policy = creditPolicy();
    const actions = account => `${isOwner?`<button class="btn small primary" data-approve-credit="${account.id}">${account.adminApproved===true?'Amend':'Approve'}</button> <button class="btn small danger" data-suspend-credit="${account.id}">Suspend</button>`:''}${canPay?` <button class="btn small" data-pay-credit="${account.id}">Payment</button>`:''}`;
    document.getElementById('customers').innerHTML = `<div class="credit-workspace">${isOwner?`<form id="creditPolicyForm" class="card pad form"><div class="head"><h2>Credit Policy</h2><span class="pill ${policy.enabled===false?'bad':'ok'}">${policy.enabled===false?'Disabled':'Enabled'}</span></div><div class="form-grid cols-3"><div class="field"><label>Default customer limit</label><input id="policyDefaultLimit" type="number" min="0" step="0.001" value="${U.esc(policy.defaultCreditLimit||0)}"></div><div class="field"><label>Maximum allowed limit</label><input id="policyMaxLimit" type="number" min="0" step="0.001" value="${U.esc(policy.maximumCreditLimit||0)}"></div><div class="field"><label>Default due days</label><input id="policyDueDays" type="number" min="1" step="1" value="${U.esc(policy.defaultDueDays||30)}"></div></div><div class="credit-policy-toggles"><label><input id="policyEnabled" type="checkbox" ${policy.enabled===false?'':'checked'}> Enable customer credit</label><label><input id="policyPos" type="checkbox" ${policy.allowPosCredit===false?'':'checked'}> Allow at POS</label><label><input id="policyDelivery" type="checkbox" ${policy.allowDeliveryCredit===false?'':'checked'}> Allow on delivery</label><label><input type="checkbox" checked disabled> Vendor approval required per customer</label></div><button class="btn primary">Save credit policy</button></form>`:''}<section class="card pad"><div class="head"><h2>Customer Accounts</h2><span class="pill warn">${accounts.filter(account=>account.status==='pending').length} pending</span><span class="pill">${accounts.length} total</span></div>${UI.table(accounts,[{key:'customerName',label:'Customer'},{key:'phone',label:'Phone'},{key:'status',label:'Status'},{key:'adminApproved',label:'Approved',format:r=>r.adminApproved===true?'Yes':'No'},{key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)},{key:'balance',label:'Balance',format:r=>U.money(r.balance)},{key:'dueDays',label:'Due'}],actions)}</section>${isOwner?`<form id="creditForm" class="card pad form"><h2>Create credit account</h2><p class="muted">New accounts remain pending until you approve their individual limit.</p><div class="form-grid"><div class="field"><label>Customer name</label><input id="creditName" required></div><div class="field"><label>Phone</label><input id="creditPhone" inputmode="tel" required></div></div><button class="btn primary">Create pending account</button></form>`:''}<section class="card pad"><h2>Credit Ledger</h2>${UI.table(ledger,[{key:'createdAt',label:'Date',format:r=>r.createdAt?new Date(Number(r.createdAt)).toLocaleString():'-'},{key:'type',label:'Type'},{key:'amount',label:'Amount',format:r=>U.money(r.amount)},{key:'note',label:'Note'}])}</section></div>`;
    document.getElementById('creditPolicyForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const maximum=Number(document.getElementById('policyMaxLimit').value||0), defaultLimit=Number(document.getElementById('policyDefaultLimit').value||0);
      if(maximum>0&&defaultLimit>maximum) return UI.toast('Default limit cannot exceed the maximum limit','bad');
      await DB.put('vendorCreditSettings',policy.id||`credit_policy_${vendorId()}`,{...policy,id:policy.id||`credit_policy_${vendorId()}`,vendorId:vendorId(),enabled:document.getElementById('policyEnabled').checked,requireIndividualApproval:true,defaultCreditLimit:defaultLimit,maximumCreditLimit:maximum,defaultDueDays:Number(document.getElementById('policyDueDays').value||30),allowPosCredit:document.getElementById('policyPos').checked,allowDeliveryCredit:document.getElementById('policyDelivery').checked},{userId:userId(),vendorId:vendorId()});
      UI.toast('Credit policy saved','ok'); renderCustomers();
    });
    document.getElementById('creditForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      await DB.put('creditAccounts',U.uid('credit'),{vendorId:vendorId(),customerName:document.getElementById('creditName').value.trim(),phone:document.getElementById('creditPhone').value.trim(),status:'pending',adminApproved:false,creditLimit:0,balance:0,dueDays:Number(policy.defaultDueDays||30)},{userId:userId(),vendorId:vendorId()});
      UI.toast('Pending credit account created','ok'); renderCustomers();
    });
    document.querySelectorAll('[data-approve-credit]').forEach(btn=>btn.onclick=async()=>{
      const account=mine('creditAccounts').find(item=>item.id===btn.dataset.approveCredit); if(!account)return;
      const limitInput=prompt('Approved credit limit',String(account.creditLimit||policy.defaultCreditLimit||0)); if(limitInput===null)return;
      const dueInput=prompt('Payment due in how many days?',String(account.dueDays||policy.defaultDueDays||30)); if(dueInput===null)return;
      const limit=Number(limitInput||0), dueDays=Number(dueInput||0);
      if(limit<0||dueDays<1) return UI.toast('Enter a valid limit and due period','bad');
      if(Number(policy.maximumCreditLimit||0)>0&&limit>Number(policy.maximumCreditLimit)) return UI.toast('This limit exceeds the vendor maximum','bad');
      await DB.patch('creditAccounts',account.id,{status:'active',adminApproved:true,approvedBy:userId(),approvedAt:Date.now(),creditLimit:limit,dueDays},{userId:userId(),vendorId:vendorId()});
      UI.toast('Customer credit approved','ok'); renderCustomers();
    });
    document.querySelectorAll('[data-suspend-credit]').forEach(btn=>btn.onclick=async()=>{const account=mine('creditAccounts').find(item=>item.id===btn.dataset.suspendCredit);if(!account)return;await DB.patch('creditAccounts',account.id,{status:'suspended',adminApproved:false,suspendedAt:Date.now()},{userId:userId(),vendorId:vendorId()});UI.toast('Credit account suspended','ok');renderCustomers();});
    document.querySelectorAll('[data-pay-credit]').forEach(btn=>btn.onclick=async()=>{const amount=Number(prompt('Payment amount','1')||0);const account=mine('creditAccounts').find(item=>item.id===btn.dataset.payCredit);if(!account||amount<=0)return;await DB.patch('creditAccounts',account.id,{balance:Math.max(0,Number(account.balance||0)-amount)},{userId:userId(),vendorId:vendorId()});await DB.put('creditTransactions',U.uid('ctx'),{vendorId:vendorId(),creditAccountId:account.id,type:'payment',amount,note:'Credit payment'},{userId:userId(),vendorId:vendorId()});UI.toast('Payment recorded','ok');renderCustomers();});
  }

  function renderEmployees(){
    if(!can('employees.read')) { document.getElementById('employees').innerHTML = permissionGate('This role cannot view employee records.'); return; }
    const employees = mine('employees').filter(e=>matchesTerm(e, ['name','role','jobTitle','username']));
    const canWrite = can('employees.create') || can('employees.*');
    document.getElementById('employees').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Employees & Permissions</h2><span class="pill">${employees.length} records</span></div>${UI.table(employees, [{key:'name',label:'Name'}, {key:'role',label:'Role'}, {key:'jobTitle',label:'Job'}, {key:'phone',label:'Phone'}, {key:'username',label:'Username'}, {key:'active',label:'Active'}])}</div>${canWrite?`<form id="employeeForm" class="card pad form"><h2>Add employee</h2><div class="form-grid"><div class="field"><label>Name</label><input id="empName" required></div><div class="field"><label>Username</label><input id="empUser" required></div><div class="field"><label>Password</label><input id="empPass" type="password" required></div><div class="field"><label>Phone</label><input id="empPhone" inputmode="tel"></div><div class="field"><label>Role</label><select id="empRole"><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="driver">Driver</option></select></div><div class="field"><label>Job title</label><input id="empJob" value="Staff"></div></div><button class="btn primary">Save employee</button></form>`:permissionGate('This role can read employees but cannot create users.')}</div>`;
    if(!canWrite) return;
    document.getElementById('employeeForm').onsubmit = async e => {
      e.preventDefault();
      const username = document.getElementById('empUser').value.trim().toLowerCase();
      const employeeId = U.uid('employee');
      const role = document.getElementById('empRole').value;
      const phone = document.getElementById('empPhone').value.trim();
      await DB.put('employees', employeeId, {id:employeeId, vendorId:vendorId(), name:document.getElementById('empName').value.trim(), username, phone, role, jobTitle:document.getElementById('empJob').value.trim(), active:true}, {userId:userId(), vendorId:vendorId()});
      const userRecord = {id:`user_${username.replace(/[^a-z0-9]+/g,'_')}`, username, displayName:document.getElementById('empName').value.trim(), phone, role, vendorId:vendorId(), employeeId, passwordHash:await global.OmniAuth.hashPassword(document.getElementById('empPass').value), active:true, deleted:false};
      await DB.put('users', userRecord.id, userRecord, {userId:userId(), vendorId:vendorId()});
      UI.toast('Employee user saved','ok'); renderEmployees();
    };
  }

  async function toggleShift(){
    const open = mine('employeeShifts').find(s=>s.userId===userId() && s.status==='open');
    if(open){ await DB.patch('employeeShifts', open.id, {status:'closed', checkOutAt:Date.now()}, {userId:userId(), vendorId:vendorId()}); UI.toast('Checked out','ok'); }
    else { await DB.put('employeeShifts', U.uid('shift'), {vendorId:vendorId(), userId:userId(), employeeId:currentUser.employeeId || userId(), status:'open', checkInAt:Date.now()}, {userId:userId(), vendorId:vendorId()}); UI.toast('Checked in','ok'); }
    updateShiftButton();
  }

  function renderAttendance(){
    if(!can('attendance.read') && !can('attendance.self')) { document.getElementById('attendance').innerHTML = permissionGate('This role cannot view attendance.'); return; }
    const shifts = mine('employeeShifts').filter(s=>can('attendance.read') || s.userId===userId()).sort((a,b)=>Number(b.checkInAt||0)-Number(a.checkInAt||0));
    const now=Date.now();
    const duration=shift=>Math.max(0,(Number(shift.checkOutAt)||now)-Number(shift.checkInAt||now));
    const totalMs=shifts.reduce((sum,shift)=>sum+duration(shift),0);
    const dayKeys=[...new Set(shifts.filter(shift=>shift.checkInAt).map(shift=>U.todayKey(Number(shift.checkInAt))))];
    const chartDays=Array.from({length:14},(_,index)=>{const date=new Date();date.setHours(0,0,0,0);date.setDate(date.getDate()-(13-index));const key=U.todayKey(date.getTime());const hours=shifts.filter(shift=>U.todayKey(Number(shift.checkInAt||0))===key).reduce((sum,shift)=>sum+duration(shift),0)/3600000;return {label:date.toLocaleDateString(undefined,{weekday:'short'}),hours};});
    const maxHours=Math.max(1,...chartDays.map(day=>day.hours));
    const employeeName=shift=>mine('employees').find(employee=>employee.id===shift.employeeId)?.name||rows('users').find(user=>user.id===shift.userId)?.displayName||shift.employeeId;
    document.getElementById('attendance').innerHTML = `<div class="grid cols-4 attendance-metrics">${UI.stat('Total hours',(totalMs/3600000).toFixed(1))}${UI.stat('Days worked',dayKeys.length)}${UI.stat('Average / day',dayKeys.length?(totalMs/3600000/dayKeys.length).toFixed(1)+' h':'0 h')}${UI.stat('Currently checked in',shifts.filter(shift=>shift.status==='open').length,{text:'live',cls:'ok'})}</div><div class="grid split"><section class="card pad"><div class="head"><h2>Hours · Last 14 days</h2></div><div class="attendance-chart">${chartDays.map(day=>`<div class="attendance-bar"><span style="height:${Math.max(day.hours?8:2,day.hours/maxHours*100)}%"></span><b>${day.hours?day.hours.toFixed(1):'0'}</b><small>${day.label}</small></div>`).join('')}</div></section><section class="card pad"><div class="head"><h2>Attendance summary</h2></div><p class="muted">Hours include completed shifts and the elapsed time of active shifts.</p><div class="attendance-callout"><b>${(totalMs/3600000).toFixed(1)} hours</b><span>across ${dayKeys.length} working day${dayKeys.length===1?'':'s'}</span></div></section></div><div class="card pad"><div class="head"><h2>Shift records</h2><span class="pill">${shifts.length} records</span></div>${UI.table(shifts, [{key:'employeeId',label:'Employee',format:employeeName}, {key:'status',label:'Status'}, {key:'checkInAt',label:'Check in',format:r=>r.checkInAt?new Date(Number(r.checkInAt)).toLocaleString():'-'}, {key:'checkOutAt',label:'Check out',format:r=>r.checkOutAt?new Date(Number(r.checkOutAt)).toLocaleString():'-'}, {key:'duration',label:'Hours',format:r=>(duration(r)/3600000).toFixed(2)}])}</div>`;
  }

  function renderSettings(){
    if(!can('vendor.update') && !can('vendor.*')) { document.getElementById('settings').innerHTML = permissionGate('Only vendor owners can change the public vendor profile.'); return; }
    const vendor = vendorProfile();
    const mediaPreview = (id,source,label,wide=false) => `<div id="${id}" class="vendor-media-preview ${wide?'wide':''}">${source?`<img src="${U.esc(source)}" alt="${U.esc(label)}">`:`<span>${U.esc(label)}</span>`}</div>`;
    document.getElementById('settings').innerHTML = `<form id="vendorSettingsForm" class="card pad form vendor-settings"><div class="head"><h2>Vendor Settings</h2><span class="pill ${vendor.status==='approved'?'ok':'warn'}">${U.esc(vendor.status||'pending')}</span></div><div class="form-grid"><div class="field"><label>CR Name</label><input id="crName" required value="${U.esc(vendor.crName||'')}"></div><div class="field"><label>CR Number</label><input id="crNumber" required value="${U.esc(vendor.crNumber||'')}"></div><div class="field"><label>Business Type</label><input id="businessType" value="${U.esc(vendor.businessType||'')}"></div><div class="field"><label>WhatsApp</label><input id="whatsapp" value="${U.esc(vendor.whatsapp||'')}"></div><div class="field"><label>Benefit / IBAN</label><input id="benefitNumber" value="${U.esc(vendor.benefitNumber||'')}"></div><div class="field"><label>Latitude</label><input id="lat" type="number" step="any" value="${U.esc(vendor.lat||'')}"></div><div class="field"><label>Longitude</label><input id="lng" type="number" step="any" value="${U.esc(vendor.lng||'')}"></div></div><div class="vendor-media-grid"><section class="vendor-media-card"><h3>Logo</h3>${mediaPreview('logoPreview',vendor.logo,'Logo')}<div class="field"><label>Image URL</label><input id="logo" value="${U.esc(vendor.logo||'')}"></div><div class="image-source-buttons"><label class="btn image-upload">Upload<input id="logoUpload" type="file" accept="image/*"></label><label class="btn image-upload">Take photo<input id="logoCamera" type="file" accept="image/*" capture="environment"></label></div></section><section class="vendor-media-card"><h3>Shopfront</h3>${mediaPreview('shopfrontPreview',vendor.shopfront,'Shopfront',true)}<div class="field"><label>Image URL</label><input id="shopfront" value="${U.esc(vendor.shopfront||'')}"></div><div class="image-source-buttons"><label class="btn image-upload">Upload<input id="shopfrontUpload" type="file" accept="image/*"></label><label class="btn image-upload">Take photo<input id="shopfrontCamera" type="file" accept="image/*" capture="environment"></label></div></section></div><label class="settings-toggle"><input id="public" type="checkbox" ${vendor.public?'checked':''}> Request public marketplace listing</label><button class="btn primary">Save vendor profile</button></form>`;
    const bindMedia = (inputId,targetId,previewId,label) => {
      document.getElementById(inputId).onchange = async event => {
        const file = event.target.files?.[0];
        if(!file) return;
        try {
          const source = await compressProductImage(file);
          document.getElementById(targetId).value = source;
          document.getElementById(previewId).innerHTML = `<img src="${U.esc(source)}" alt="${U.esc(label)}">`;
          UI.toast(`${label} image ready. Save the profile to publish it`,'ok');
        } catch(error) { UI.toast(error.message || 'Image could not be added','bad'); }
      };
    };
    bindMedia('logoUpload','logo','logoPreview','Logo'); bindMedia('logoCamera','logo','logoPreview','Logo');
    bindMedia('shopfrontUpload','shopfront','shopfrontPreview','Shopfront'); bindMedia('shopfrontCamera','shopfront','shopfrontPreview','Shopfront');
    document.getElementById('vendorSettingsForm').onsubmit = async e => {
      e.preventDefault();
      const row = {id:vendorId(), crName:document.getElementById('crName').value.trim(), crNumber:document.getElementById('crNumber').value.trim(), businessType:document.getElementById('businessType').value.trim(), whatsapp:document.getElementById('whatsapp').value.trim(), benefitNumber:document.getElementById('benefitNumber').value.trim(), lat:Number(document.getElementById('lat').value||0), lng:Number(document.getElementById('lng').value||0), logo:document.getElementById('logo').value.trim(), shopfront:document.getElementById('shopfront').value.trim(), ownerUserId:userId(), ownerAlias:currentUser.username || '', status:vendor.status||'pending', public:document.getElementById('public').checked, adminApproved:vendor.adminApproved===true, suspended:vendor.suspended===true, active:true};
      await DB.put('vendors', vendorId(), row, {userId:userId(), vendorId:vendorId()});
      await syncPublicVendor();
      UI.toast('Vendor profile saved and synced','ok');
    };
  }

  function render(preserveFields=false){
    if(!currentUser || !appReady()) return;
    const view = UI.activeView();
    const fields = preserveFields ? captureViewFields(view) : [];
    if(view==='dashboard') renderDashboard();
    if(view==='deliveries') renderDeliveries();
    if(view==='pos') renderPos();
    if(view==='orders') renderOrders();
    if(view==='products') renderProducts();
    if(view==='customers') renderCustomers();
    if(view==='employees') renderEmployees();
    if(view==='attendance') renderAttendance();
    if(view==='settings') renderSettings();
    if(preserveFields) restoreViewFields(fields);
    updateShiftButton();
    updateOrderAlert();
  }

  function scheduleRender(collection){
    if(!currentUser || !appReady()) return;
    if(collection === 'presence' || collection === 'events') return;
    if(collection === 'deliveryAssignments' && UI.activeView?.() === 'deliveries' && driverWatchId !== null) return;
    if(!viewUsesCollection(collection)) return;
    if(isEditingField()) {
      pendingRenders.add(collection);
      return;
    }
    if(renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render(true);
    }, 120);
  }

  function startApp(){
    UI.shell(currentUser); UI.bindNav(render); DB.init(UI.setStatus);
    liveUnsubscribers.forEach(unsubscribe => unsubscribe());
    liveUnsubscribers = [];
    VENDOR_COLLECTIONS.forEach(name => { state[name] = []; });
    const scopeKey = vendorId();
    const accepts = (name, row) => {
      if(name === 'vendors' || name === 'publicVendors') return row.id === vendorId();
      if(name === 'users') return row.id === userId() || row.vendorId === vendorId();
      return row.vendorId === vendorId();
    };
    VENDOR_COLLECTIONS.forEach(name => {
      const unsubscribe = DB.subscribe(name, () => {
        if(name === 'orders') updateOrderAlert();
        scheduleRender(name);
      }, {includeDeleted:true, scopeKey, accept:row => accepts(name, row)});
      liveUnsubscribers.push(unsubscribe);
    });
    document.getElementById('search').oninput = () => scheduleRender('search');
    document.getElementById('app').onfocusout = () => setTimeout(flushPendingRender, 0);
    document.getElementById('app').addEventListener('pointerdown', unlockOrderSound, {capture:true, once:true});
    document.getElementById('logoutBtn').onclick = () => {
      global.OmniAuth.clearSession();
      currentUser = null;
      POS.clear();
      resetDriverMap();
      liveUnsubscribers.forEach(unsubscribe => unsubscribe());
      liveUnsubscribers = [];
      pendingRenders.clear();
      renderAuthGate();
    };
    document.getElementById('checkShiftBtn').onclick = toggleShift;
    document.getElementById('userMode').textContent = `${currentUser.role || 'vendor'} · ${currentUser.username || ''}`;
    startPresenceSync();
    render();
  }

  async function boot(){
    DB.init(UI.setStatus);
    const session = global.OmniAuth.savedSession();
    if(session?.userId) {
      try {
        const user = await DB.get('users', session.userId, 8000);
        if(user && user.deleted !== true && user.active !== false && ['vendor_owner','manager','cashier','driver'].includes(user.role) && user.vendorId) {
          currentUser = {...session, ...user, userId:user.id};
          global.OmniAuth.saveSession(currentUser);
          startApp();
          return;
        }
      } catch {}
      global.OmniAuth.clearSession();
    }
    currentUser = null;
    renderAuthGate();
  }
  boot();
})(window);
