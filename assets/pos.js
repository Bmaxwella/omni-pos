(function(global){
  'use strict';
  const U = global.OmniUtils;

  const POS = {
    cart: [],
    sale: {customerName:'', phone:'', note:'', paymentMethod:'cash', discount:0},
    add(product){
      if(!product || !product.id) return {ok:false, error:'Product is unavailable'};
      const line = POS.cart.find(item => item.productId === product.id);
      const quantity = line ? line.qty + 1 : 1;
      if(product.stockMode === 'track' && quantity > Number(product.stockQty || 0)) return {ok:false, error:`Only ${Number(product.stockQty || 0)} in stock`};
      if(line) line.qty = quantity;
      else POS.cart.push({
        productId:product.id,
        name:product.name,
        price:Number(product.price || 0),
        qty:1,
        image:product.image || '',
        sku:product.sku || '',
        unit:product.unit || 'each',
        stockMode:product.stockMode || 'none',
        stockQty:Number(product.stockQty || 0),
        attributesJson:product.attributesJson || '[]'
      });
      return {ok:true};
    },
    setQty(productId, quantity){
      const line = POS.cart.find(item => item.productId === productId);
      if(!line) return {ok:false};
      const next = Math.max(0, Number(quantity || 0));
      if(line.stockMode === 'track' && next > line.stockQty) return {ok:false, error:`Only ${line.stockQty} in stock`};
      if(next === 0) POS.cart = POS.cart.filter(item => item.productId !== productId);
      else line.qty = next;
      return {ok:true};
    },
    remove(productId){
      const line = POS.cart.find(item => item.productId === productId);
      return line ? POS.setQty(productId, line.qty - 1) : {ok:false};
    },
    removeLine(productId){ POS.cart = POS.cart.filter(item => item.productId !== productId); },
    subtotal(){ return POS.cart.reduce((sum,line)=>sum+line.price*line.qty,0); },
    discount(){ return Math.min(POS.subtotal(), Math.max(0, Number(POS.sale.discount || 0))); },
    total(){ return Math.max(0, POS.subtotal() - POS.discount()); },
    lines(){ return POS.cart.map(line => ({...line, total:line.price*line.qty})); },
    clear(){ POS.cart = []; POS.sale = {customerName:'', phone:'', note:'', paymentMethod:'cash', discount:0}; }
  };

  function imageMarkup(line){
    return line.image
      ? `<img class="pos-cart-thumb" src="${U.esc(line.image)}" alt="">`
      : `<span class="pos-cart-thumb placeholder">${U.esc(String(line.name || 'P').slice(0,1).toUpperCase())}</span>`;
  }

  function renderCart(){
    const lines = POS.lines();
    return `<aside class="card pos-cart-panel">
      <div class="pos-cart-head"><div><span class="eyebrow">Current sale</span><h2>Cart</h2></div><span class="pill">${lines.reduce((sum,line)=>sum+line.qty,0)} items</span></div>
      <div class="pos-cart-lines">${lines.map(line=>`<div class="pos-cart-line">
        ${imageMarkup(line)}
        <div class="pos-cart-info"><strong>${U.esc(line.name)}</strong><span>${U.money(line.price)}${line.unit && line.unit !== 'each' ? ` / ${U.esc(line.unit)}` : ''}</span><div class="qty-control"><button type="button" class="icon-btn" data-cart-decrease="${U.esc(line.productId)}" aria-label="Decrease quantity">−</button><b>${line.qty}</b><button type="button" class="icon-btn" data-cart-increase="${U.esc(line.productId)}" aria-label="Increase quantity">+</button></div></div>
        <div class="pos-cart-price"><b>${U.money(line.total)}</b><button type="button" class="icon-btn danger-icon" data-cart-remove-line="${U.esc(line.productId)}" aria-label="Remove item">×</button></div>
      </div>`).join('') || '<div class="pos-empty"><strong>No items yet</strong><span>Select a product or scan a barcode.</span></div>'}</div>
      <div class="pos-customer-grid">
        <div class="field"><label>Customer name</label><input id="posCustomerName" autocomplete="name" value="${U.esc(POS.sale.customerName)}" placeholder="Walk-in customer"></div>
        <div class="field"><label>Phone</label><input id="posPhone" inputmode="tel" autocomplete="tel" value="${U.esc(POS.sale.phone)}" placeholder="For receipt or credit"></div>
        <div class="field full"><label>Sale note</label><textarea id="posNote" rows="2" placeholder="Optional note">${U.esc(POS.sale.note)}</textarea></div>
      </div>
      <div class="pos-totals">
        <div><span>Subtotal</span><b>${U.money(POS.subtotal())}</b></div>
        <div class="discount-row"><label for="posDiscount">Discount</label><input id="posDiscount" type="number" min="0" step="0.001" value="${U.esc(POS.sale.discount)}"><b id="posDiscountValue">${U.money(POS.discount())}</b></div>
        <div class="grand-total"><span>Total</span><b id="posGrandTotal">${U.money(POS.total())}</b></div>
      </div>
      <div class="pos-payment"><label for="posPayment">Payment method</label><select id="posPayment" class="input"><option value="cash" ${POS.sale.paymentMethod==='cash'?'selected':''}>Cash</option><option value="benefit" ${POS.sale.paymentMethod==='benefit'?'selected':''}>Benefit</option><option value="card" ${POS.sale.paymentMethod==='card'?'selected':''}>Card</option><option value="credit" ${POS.sale.paymentMethod==='credit'?'selected':''}>Customer credit</option></select></div>
      <button id="completeSaleBtn" class="btn primary pos-complete" ${lines.length?'':'disabled'}>Complete sale · ${U.money(POS.total())}</button>
    </aside>`;
  }

  global.VendorPOS = { POS, renderCart };
})(window);
