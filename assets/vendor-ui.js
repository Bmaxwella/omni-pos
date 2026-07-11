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

  function shell(){
    document.getElementById('app').innerHTML = `
      <aside class="side">
        <div class="brand"><div class="brand-mark">OM</div><div>OMNI<br><span class="muted">VENDOR</span></div></div>
        <nav class="nav" data-nav>
          <button class="active" data-view="dashboard">Dashboard</button>
          <button data-view="pos">POS Sale</button>
          <button data-view="orders">Orders</button>
          <button data-view="products">Products</button>
          <button data-view="customers">Customers & Credit</button>
          <button data-view="employees">Employees</button>
          <button data-view="attendance">Attendance</button>
          <button data-view="settings">Settings</button>
        </nav>
        <div class="sync"><span id="syncDot" class="dot"></span><span id="syncText">Connecting to GUN</span></div>
      </aside>
      <main class="main">
        <div class="mobile-tabs" data-nav><button class="btn primary" data-view="dashboard">Dashboard</button><button class="btn" data-view="pos">POS</button><button class="btn" data-view="orders">Orders</button><button class="btn" data-view="products">Products</button><button class="btn" data-view="customers">Credit</button></div>
        <header class="top">
          <div class="search"><span>⌕</span><input id="search" placeholder="Search products, orders, customers"></div>
          <button id="loginOwnerBtn" class="btn">Demo owner</button>
          <button id="checkShiftBtn" class="btn primary">Check in</button>
        </header>
        <section class="content">
          <div id="dashboard" class="view active"></div>
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
  function setStatus(status){ document.getElementById('syncDot')?.classList.toggle('online', status.online); const text=document.getElementById('syncText'); if(text) text.textContent=status.text || 'Connecting'; }
  function stat(label,value,pill=''){ return `<div class="card pad metric"><span class="muted">${U.esc(label)}</span><b>${U.esc(value)}</b>${pill?`<span class="pill ${pill.cls||''}">${U.esc(pill.text)}</span>`:''}</div>`; }
  function table(rows, columns, actions){
    if(!rows.length) return '<div class="card empty">No records found</div>';
    return `<div class="table-wrap"><table class="table"><thead><tr>${columns.map(c=>`<th>${U.esc(c.label)}</th>`).join('')}${actions?'<th>Actions</th>':''}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${U.esc(c.format?c.format(row):row[c.key])}</td>`).join('')}${actions?`<td>${actions(row)}</td>`:''}</tr>`).join('')}</tbody></table></div>`;
  }

  global.VendorUI = { toast, shell, bindNav, activeView, setStatus, stat, table };
})(window);
