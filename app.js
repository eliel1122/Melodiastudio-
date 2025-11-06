/* === Firebase sync (SITE PUBLIC) === */
let __FB_APP = null;
let __JUST_PUSHED_LOCAL = 0;

async function __initFirebaseApp() {
  if (__FB_APP) return __FB_APP;
  const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
  const fsMod  = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const firebaseConfig = {
    apiKey: "AIzaSyCQeFRyWNQnFUX4GGeT9bYa5PA8lFlOSdY",
    authDomain: "melodiastudio-f2d00.firebaseapp.com",
    projectId: "melodiastudio-f2d00",
    storageBucket: "melodiastudio-f2d00.firebasestorage.app",
    messagingSenderId: "227814839561",
    appId: "1:227814839561:web:90bda938bb2de4cdcdefd8",
    measurementId: "G-9WCKN77S0B"
  };
  const app = appMod.initializeApp(firebaseConfig);
  const db  = fsMod.getFirestore(app);
  __FB_APP = { app, db, doc: fsMod.doc, getDoc: fsMod.getDoc, setDoc: fsMod.setDoc, onSnapshot: fsMod.onSnapshot };
  return __FB_APP;
}

async function __cloudRefSite() {
  const f = await __initFirebaseApp();
  return f.doc(f.db, 'melodia', 'state');
}

// Cloud -> localStorage -> UI
(async function __subscribeSite(){
  const f = await __initFirebaseApp();
  const ref = await __cloudRefSite();
  f.onSnapshot(ref, snap => {
    if (!snap.exists()) return;
    const cloud = snap.data();
    if (Date.now() - __JUST_PUSHED_LOCAL < 800) return;
    localStorage.setItem('melodiaData', JSON.stringify(cloud));
    // Rafraîchis l’interface
    try { typeof renderServices   === 'function' && renderServices(); } catch(_) {}
    try { typeof renderBeatmakers === 'function' && renderBeatmakers(); } catch(_) {}
    try { typeof refreshCart      === 'function' && refreshCart(); } catch(_) {}
    try { typeof populateSlots    === 'function' && populateSlots(); } catch(_) {}
  });
})();
// ----- Seed data -----
const seed = {
  categories:[
    {id:"enr",name:"Enregistrement",services:[
      {id:"prise-voix",title:"Prise de voix",desc:"Enregistrement voix en cabine traitée acoustiquement.",options:[
        {label:"1h",minutes:60,price:25000},
        {label:"2h",minutes:120,price:35000},
        {label:"4h",minutes:240,price:70000},
        {label:"8h",minutes:480,price:150000},
      ]}
    ]},
    {id:"post",name:"Post-production",services:[
      {id:"arr",title:"Arrangement",desc:"Création et structuration musicale — sur devis.",options:[{label:"Devis",minutes:0,price:150000}]},
      {id:"mix",title:"Mixage",desc:"Équilibre, clarté, spatialisation — sur devis.",options:[{label:"Devis",minutes:0,price:50000}]},
      {id:"mast",title:"Mastering",desc:"Optimisation finale multi-plateformes — sur devis.",options:[{label:"Devis",minutes:0,price:50000}]},
    ]},
    {id:"loc",name:"Location",services:[
      {id:"loc-espace",title:"Location d’espace (répétitions / tournages)",desc:"Accès à la salle de répétition.",options:[
        {label:"1h",minutes:60,price:25000},
        {label:"2h",minutes:120,price:35000},
        {label:"4h",minutes:240,price:70000},
        {label:"8h",minutes:480,price:150000},
      ]},
      {id:"loc-studio",title:"Location du studio",desc:"Accès complet au studio.",options:[
        {label:"1h",minutes:60,price:30000},
        {label:"2h",minutes:120,price:50000},
        {label:"4h",minutes:240,price:80000},
        {label:"8h",minutes:480,price:200000},
      ]}
    ]},
  ],
  beatmakers:[{id:"chapito",name:"Chapito",skills:"Afrobeats, Drill, Pop"},{id:"uzy",name:"UzyJack",skills:"Trap, RnB"}],
  availability:{}, // { beatmakerId: [ISO strings] }
  cart_items:[],
  bookings:[]
};
function db(){ let d=localStorage.getItem("melodiaData"); if(!d){localStorage.setItem("melodiaData",JSON.stringify(seed)); return seed;} return JSON.parse(d);}
function save(data){ localStorage.setItem("melodiaData",JSON.stringify(data));}
let data = db();

// Live categories from admin (if any)
let SERVICES = data.categories;

// ----- render services -----
const servicesWrap = document.getElementById('servicesWrap');
function renderServices(){
  servicesWrap.innerHTML='';
  SERVICES.forEach(cat=>{
    const box=document.createElement('div'); box.className='card'; box.innerHTML=`<div class="badge">${cat.name}</div>`;
    (cat.services||[]).forEach(s=>{
      const sDiv=document.createElement('div'); sDiv.className='service';
      sDiv.innerHTML=`<h3>${s.title}</h3><small class="muted">${s.desc||''}</small><div class="options"></div>`;
      const grid=sDiv.querySelector('.options');
      (s.options||[]).forEach((opt,idx)=>{
        const btn=document.createElement('button'); btn.className='option-btn';
        const label = opt.minutes>0 ? `${opt.label} — ${opt.price.toLocaleString()} FCFA` : `Demander un devis (à partir de ${opt.price.toLocaleString()} FCFA)`;
        btn.textContent=label; btn.onclick=()=>addToCart({catId:cat.id,serviceId:s.id,optIndex:idx});
        grid.appendChild(btn);
      });
      box.appendChild(sDiv);
    });
    servicesWrap.appendChild(box);
  });
}
renderServices();

// ----- beatmakers on homepage -----
const bmWrap=document.getElementById('bmWrap');
function renderBeatmakers(){
  data=db(); bmWrap.innerHTML='';
  if(!data.beatmakers?.length){ bmWrap.innerHTML='<small class="muted">Aucun beatmaker enregistré.</small>'; return; }
  data.beatmakers.forEach(b=>{
    const p=document.createElement('p'); p.innerHTML=`<strong>${b.name}</strong> — <small class="muted">${b.skills||''}</small>`; bmWrap.appendChild(p);
  });
}
renderBeatmakers();

// ----- cart / drawer -----
const cartFab=document.getElementById('cartFab'); const drawer=document.getElementById('drawer'); const closeDrawer=document.getElementById('closeDrawer');
const cartCount=document.getElementById('cartCount'); const cartList=document.getElementById('cartList');
const beatmakerSelect=document.getElementById('beatmakerSelect'); const slotSelect=document.getElementById('slotSelect');
cartFab.onclick=()=>drawer.classList.add('open'); closeDrawer.onclick=()=>drawer.classList.remove('open');

function addToCart(ref){
  data=db();
  const cat=data.categories.find(c=>c.id===ref.catId);
  const svc=cat?.services.find(s=>s.id===ref.serviceId);
  const opt=svc?.options[ref.optIndex];
  if(!svc||!opt){ alert("Service invalide."); return; }
  (data.cart_items||=[]).push({title:svc.title,label:opt.label,price:opt.price,minutes:opt.minutes,category:cat.id});
  save(data); refreshCart(); drawer.classList.add('open');
}

function refreshCart(){
  data=db(); cartCount.textContent=(data.cart_items||[]).length; cartList.innerHTML='';
  (data.cart_items||[]).forEach((it,idx)=>{
    const row=document.createElement('div'); row.className='item';
    row.innerHTML=`<div><strong>${it.title}</strong> <small class="muted">(${it.label})</small></div><div>${(it.price||0).toLocaleString()} FCFA</div>`;
    const del=document.createElement('button'); del.className='tab'; del.textContent='Supprimer';
    del.onclick=()=>{ let d=db(); d.cart_items.splice(idx,1); save(d); refreshCart(); };
    row.appendChild(del); cartList.appendChild(row);
  });
  // beatmakers
  beatmakerSelect.innerHTML = (data.beatmakers||[]).map(b=>`<option value="${b.id}">${b.name}</option>`).join('');
  populateSlots();
}
refreshCart();

// ---- availability -----
function getAvailabilityFor(beatmakerId){
  const d=db(); return (d.availability && d.availability[beatmakerId]) ? d.availability[beatmakerId].slice() : [];
}
function formatFr(iso){
  const dt=new Date(iso); return dt.toLocaleString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',','');
}
function populateSlots(){
  const bmId = beatmakerSelect?.value;
  slotSelect.innerHTML='';
  if(!bmId){ slotSelect.innerHTML='<option value="">-- Sélectionne un beatmaker --</option>'; return; }
  const all = getAvailabilityFor(bmId);
  const d=db();
  const used = new Set((d.bookings||[]).filter(b=>b.beatmakerId===bmId && b.status!=='cancelled').map(b=> new Date(b.datetime).toISOString()));
  const free = all.filter(iso=> !used.has(iso));
  if(free.length===0){ slotSelect.innerHTML='<option value="">Aucun créneau disponible</option>'; return; }
  free.sort().forEach(iso=>{
    const opt=document.createElement('option'); opt.value=iso; opt.textContent=formatFr(iso); slotSelect.appendChild(opt);
  });
}
beatmakerSelect.addEventListener('change', populateSlots);

// Live sync listeners from admin
window.addEventListener('storage', (e)=>{
  if(e.key==="melodia_services_categories"){ try{ SERVICES=JSON.parse(e.newValue)||SERVICES; renderServices(); }catch(_){} }
  if(e.key==="melodia_availability"){ populateSlots(); }
  if(e.key==="melodiaData"){ renderBeatmakers(); refreshCart(); populateSlots(); }
});

// WhatsApp helper (returns if a window was opened)
function tryOpenWhatsApp(msg){
  try{
    const url=`https://wa.me/2250718415131?text=${encodeURIComponent(msg)}`;
    const w=window.open(url,'_blank');
    return !!w;
  }catch(e){ return false; }
}
function formatRef(){const n=Math.random().toString(36).slice(2,6).toUpperCase();const t=new Date();const pad=n2=>String(n2).padStart(2,'0');return `MEL-${t.getFullYear()}${pad(t.getMonth()+1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}-${n}`;}

// Confirmation section renderer
function showConfirmation(booking, whatsappOpened){
  document.getElementById('drawer').classList.remove('open');
  const sec=document.getElementById('confirmation'); sec.style.display='block';
  const wrap=document.getElementById('confirmRecap');
  const itemsHtml = booking.items.map(i=>`<div class="row"><div>${i.title} <small class="muted">(${i.label})</small></div><div>${(i.price||0).toLocaleString()} FCFA</div></div>`).join('');
  wrap.innerHTML = `
    <div class="row"><div>Référence</div><div class="confirm-badge">${booking.ref}</div></div>
    <div class="row"><div>Date / créneau</div><div>${new Date(booking.datetime).toLocaleString('fr-FR')}</div></div>
    <div class="row"><div>Beatmaker</div><div>${(db().beatmakers.find(b=>b.id===booking.beatmakerId)||{}).name||''}</div></div>
    ${itemsHtml}
    <div class="row"><div><strong>Total</strong></div><div><strong>${booking.total.toLocaleString()} FCFA</strong></div></div>
    <div class="row"><div>Client</div><div>${booking.name} — ${booking.phone}${booking.email?(' — '+booking.email):''}</div></div>
  `;
  const m=document.getElementById('confirmMsg');
  if(whatsappOpened){
    m.innerHTML = "C’est noté ! Si tu as <strong>confirmé sur WhatsApp</strong>, tout est parfait — on t’attend au studio. Tu recevras un message si besoin de précisions.";
  }else{
    m.innerHTML = "Ta réservation est <strong>enregistrée</strong>. Si <strong>WhatsApp ne s’est pas ouvert (PC)</strong>, pas de stress : nous te recontacterons très bientôt pour la confirmation finale.";
  }
  sec.scrollIntoView({behavior:'smooth'});
}

// Confirm booking handler
document.getElementById('confirmBtn').onclick=()=>{
  data=db(); if(!(data.cart_items||[]).length){alert("Votre panier est vide.");return;}
  const bm=data.beatmakers.find(b=>b.id===beatmakerSelect.value);
  const dt=slotSelect.value; const name=document.getElementById('nameInput').value.trim();
  const phone=document.getElementById('phoneInput').value.trim(); const email=document.getElementById('emailInput').value.trim();
  if(!bm||!dt||!name||!phone){ alert("Merci de remplir Beatmaker, créneau, nom et téléphone."); return; }
  const ref=formatRef(); const total=(data.cart_items||[]).reduce((s,a)=>s+(a.price||0),0);
  const items=(data.cart_items||[]).map(i=>`${i.title} (${i.label}) - ${i.price} FCFA`).join(" | ");
  const msg=`Bonjour Melodia Studio, je confirme ma réservation ${ref} : ${items}. Beatmaker : ${bm.name}. Date : ${new Date(dt).toLocaleString('fr-FR')}. Nom : ${name}. Tel : ${phone}. Email : ${email||'-'}. Total : ${total.toLocaleString()} FCFA.`;
  const bookingObj = {ref,items:data.cart_items,total,beatmakerId:bm.id,datetime:dt,name,phone,email,status:"pending"};
  (data.bookings||=[]).push(bookingObj);
  // remove slot
  data.availability = data.availability || {}; data.availability[bm.id] = (data.availability[bm.id]||[]).filter(x=>x!==dt);
  save(data);
  __pushStateToCloudFromSite();
  const opened = tryOpenWhatsApp(msg);
  let d2=db(); d2.cart_items=[]; save(d2); refreshCart(); populateSlots();
  showConfirmation(bookingObj, opened);
};

// Custom slot request
document.getElementById('customSlotBtn').onclick=()=>{
  const name=prompt("Ton nom complet ?"); if(!name) return;
  const phone=prompt("Ton numéro WhatsApp ?"); if(!phone) return;
  const wish=prompt("Quel créneau te conviendrait idéalement ? (ex: Mercredi 18h-20h)"); if(!wish) return;
  alert("Merci ! Nous allons te recontacter pour valider un créneau personnalisé.");
};

async function __pushStateToCloudFromSite() {
  try {
    const raw = localStorage.getItem('melodiaData');
    if (!raw) return;
    const state = JSON.parse(raw);
    const f = await __initFirebaseApp();
    const ref = await __cloudRefSite();
    __JUST_PUSHED_LOCAL = Date.now();
    await f.setDoc(ref, state, { merge: false });
  } catch(e) {
    console.error('[Firebase site] push error:', e);
  }
}
// Burger
const burgerBtn = document.getElementById('burgerBtn');
const mobileMenu = document.getElementById('mobileMenu');
if(burgerBtn && mobileMenu){
  burgerBtn.addEventListener('click', ()=> mobileMenu.classList.toggle('open'));
  mobileMenu.querySelectorAll('a').forEach(a=>a.addEventListener('click', ()=> mobileMenu.classList.remove('open')));
}
