(function(global){
  'use strict';
  const U = global.OmniUtils;
  const POS = {
    cart: [],
    add(product){
      const line = POS.cart.find(x => x.productId === product.id);
      if(line) line.qty += 1;
      else POS.cart.push({productId:product.id, name:product.name, price:Number(product.price||0), qty:1});
    },
    remove(productId){
      const line = POS.cart.find(x => x.productId === productId);
      if(!line) return;
      line.qty -= 1;
      if(line.qty <= 0) POS.cart = POS.cart.filter(x => x.productId !== productId);
    },
    total(){ return POS.cart.reduce((sum,line)=>sum+line.price*line.qty,0); },
    lines(){ return POS.cart.map(line => ({...line, total:line.price*line.qty})); },
    clear(){ POS.cart = []; }
  };

  function renderCart(){
    return `<div class="card pad"><div class="head"><h2>Sale Cart</h2><span class="pill">${POS.cart.length} lines</span></div>${POS.lines().map(line=>`<div class="cart-line"><span>${U.esc(line.name)} x ${line.qty}</span><button class="btn small danger" data-cart-remove="${line.productId}">−</button><b>${U.money(line.total)}</b></div>`).join('') || '<div class="empty">Cart is empty</div>'}<div class="total"><span>Total</span><span>${U.money(POS.total())}</span></div><div class="field" style="margin-top:12px"><label>Customer phone for credit/receipt</label><input id="posPhone" placeholder="+973..."></div><select id="posPayment" class="input" style="margin-top:10px"><option value="cash">Cash</option><option value="benefit">Benefit</option><option value="card">Card</option><option value="credit">Credit</option></select><button id="completeSaleBtn" class="btn primary" style="width:100%;margin-top:12px">Complete sale</button></div>`;
  }

  global.VendorPOS = { POS, renderCart };
})(window);
