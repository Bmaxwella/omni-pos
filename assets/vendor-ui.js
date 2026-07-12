(function(global){
  'use strict';
  const U = global.OmniUtils;

  function toast(message, type=''){
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    document.getElementById('toastStack').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function shell(user={}){
    const driver = user.role === 'driver';
    const navItems = driver
      ? [['deliveries','Deliveries'],['attendance','My attendance']]
      : [['dashboard','Dashboard'],['pos','POS Sale'],['orders','Orders'],['deliveries','Delivery history'],['products','Products'],['customers','Customers & Credit'],['employees','Employees'],['attendance','Attendance'],['settings','Settings']];
    const defaultView = driver ? 'deliveries' : 'dashboard';
    const nav = navItems.map(([view,label],index)=>`<button class="${index===0?'active':''}" data-view="${view}">${label}</button>`).join('');
    const mobileNav = navItems.map(([view,label],index)=>`<button class="btn ${index===0?'primary':''}" data-view="${view}">${label}</button>`).join('');
    document.getElementById('app').innerHTML = `
      <aside class="side">
        <div class="brand"><div class="brand-mark">OM</div><div>OMNI<br><span class="muted">VENDOR</span></div></div>
        <nav class="nav" data-nav>${nav}</nav>
        <div class="sync"><span id="syncDot" class="dot"></span><span id="syncText">Connecting securely</span><small class="relay-url">GUN relay: ${U.esc(global.OmniConfig.peers.join(', '))}</small></div>
      </aside>
      <main class="main">
        <div id="orderAlert" class="order-alert" role="alert" aria-live="assertive"></div>
        <div class="mobile-tabs" data-nav>${mobileNav}</div>
        <header class="top">
          <div class="search"><span>⌕</span><input id="search" placeholder="${driver?'Search deliveries, customers, addresses':'Search products, orders, customers'}"></div>
          <span id="userMode" class="pill">${driver?'Driver':'Vendor'}</span>
          <button id="logoutBtn" class="btn ghost">Switch user</button>
          <button id="checkShiftBtn" class="btn primary">Check in</button>
        </header>
        <section class="content">
          <div id="dashboard" class="view ${defaultView==='dashboard'?'active':''}"></div>
          <div id="deliveries" class="view ${defaultView==='deliveries'?'active':''}"></div>
          <div id="pos" class="view"></div>
          <div id="orders" class="view"></div>
          <div id="products" class="view"></div>
          <div id="customers" class="view"></div>
          <div id="employees" class="view"></div>
          <div id="attendance" class="view"></div>
          <div id="settings" class="view"></div>
        </section>
      </main>`;
  }

  function bindNav(render){
    document.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === btn.dataset.view));
      document.querySelectorAll('[data-nav] button').forEach(item => item.classList.toggle('active', item.dataset.view === btn.dataset.view));
      render();
    });
  }

  function activeView(){ return document.querySelector('.view.active')?.id || 'dashboard'; }
  function setStatus(status){
    document.getElementById('syncDot')?.classList.toggle('online', status.online);
    document.getElementById('authRelayDot')?.classList.toggle('online', status.online);
    const text=document.getElementById('syncText');
    const authText=document.getElementById('authRelayState');
    if(text) text.textContent=status.text || 'Connecting';
    if(authText) authText.textContent=status.online ? 'Connected' : (status.text || 'Connecting');
  }
  function stat(label,value,pill=''){ return `<div class="card pad metric"><span class="muted">${U.esc(label)}</span><b>${U.esc(value)}</b>${pill?`<span class="pill ${pill.cls||''}">${U.esc(pill.text)}</span>`:''}</div>`; }
  function table(rows, columns, actions){
    if(!rows.length) return '<div class="card empty">No records found</div>';
    return `<div class="table-wrap"><table class="table"><thead><tr>${columns.map(c=>`<th>${U.esc(c.label)}</th>`).join('')}${actions?'<th>Actions</th>':''}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${U.esc(c.format?c.format(row):row[c.key])}</td>`).join('')}${actions?`<td>${actions(row)}</td>`:''}</tr>`).join('')}</tbody></table></div>`;
  }

  global.VendorUI = { toast, shell, bindNav, activeView, setStatus, stat, table };
})(window);
