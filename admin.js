/* === Firebase sync (ADMIN) === */
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
  __FB_APP = { app, db, doc: fsMod.doc, setDoc: fsMod.setDoc };
  return __FB_APP;
}

async function __cloudRefSite() {
  const f = await __initFirebaseApp();
  return f.doc(f.db, 'melodia', 'state');
}

// pousse tout le localStorage vers Firestore
async function saveDataToCloud() {
  try {
    __JUST_PUSHED_LOCAL = Date.now();
    const f = await __initFirebaseApp();
    const ref = await __cloudRefSite();
    const all = JSON.parse(localStorage.getItem('melodiaData') || '{}');
    await f.setDoc(ref, all, { merge: false });
  } catch(e) { console.error('Cloud save error', e); }
}
/* === Firebase sync (ADMIN) === */
let __FB_ADMIN = null;
let __SYNCING_FROM_CLOUD = false;
let __LAST_LOCAL_PUSH_AT = 0;

async function __initFirebaseAdmin() {
  if (__FB_ADMIN) return __FB_ADMIN;
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
  __FB_ADMIN = {
    app, db,
    doc: fsMod.doc,
    getDoc: fsMod.getDoc,
    setDoc: fsMod.setDoc,
    onSnapshot: fsMod.onSnapshot
  };
  return __FB_ADMIN;
}

async function __cloudRef() {
  const f = await __initFirebaseAdmin();
  return f.doc(f.db, 'melodia', 'state');
}

// PUSH localStorage -> cloud
async function __pushLocalToCloud() {
  try {
    const raw = localStorage.getItem('melodiaData');
    if (!raw) return;
    const state = JSON.parse(raw);
    const f = await __initFirebaseAdmin();
    const ref = await __cloudRef();
    __LAST_LOCAL_PUSH_AT = Date.now();
    await f.setDoc(ref, state, { merge: false });
  } catch (e) {
    console.error('[Firebase admin] push error:', e);
  }
}

// SUBSCRIBE cloud -> localStorage -> refresh admin UI
(async function __subscribeAdmin() {
  const f = await __initFirebaseAdmin();
  const ref = await __cloudRef();
  f.onSnapshot(ref, snap => {
    if (!snap.exists()) return;
    const cloud = snap.data();
    // évite d’écraser juste après notre propre push
    if (Date.now() - __LAST_LOCAL_PUSH_AT < 800) return;
    __SYNCING_FROM_CLOUD = true;
    localStorage.setItem('melodiaData', JSON.stringify(cloud));
    // rafraîchis l’UI admin si les fonctions existent
    try { typeof renderSvcEditor === 'function' && renderSvcEditor(); } catch(_) {}
    try { typeof renderStats     === 'function' && renderStats();     } catch(_) {}
    try { typeof renderCalendar  === 'function' && renderCalendar();  } catch(_) {}
    try { typeof renderDispos    === 'function' && renderDispos();    } catch(_) {}
    try { typeof renderBmEditor  === 'function' && renderBmEditor();  } catch(_) {}
    __SYNCING_FROM_CLOUD = false;
    // notifie les autres onglets (site public) qu’un update a eu lieu
    localStorage.setItem('melodia_sync_tick', String(Date.now()));
  });
})();
function db(){let d=localStorage.getItem("melodiaData");return d?JSON.parse(d):null;}
function save(v){
  localStorage.setItem("melodiaData", JSON.stringify(v));
  if (!window.__SYNCING_FROM_CLOUD) {
    __pushLocalToCloud();
  }
}
const PASS="melodia2025";
document.getElementById('loginBtn').onclick=()=>{const v=(document.getElementById('pwd').value||'').trim();if(v===PASS){document.getElementById('login').style.display='none';document.getElementById('adminApp').style.display='block';init();}else alert("Mot de passe incorrect.");};

// Tabs
document.querySelectorAll('.tab[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tab[data-tab]').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  const id=btn.dataset.tab; document.querySelectorAll('section[id^=tab-]').forEach(s=>s.style.display='none'); document.getElementById('tab-'+id).style.display='block';
}));

function init(){renderSvcEditor();renderStats();renderCalendar();renderDispos();renderBmEditor();document.getElementById('exportCsv').onclick=exportCsv;document.getElementById('exportServices').onclick=exportServices;}

// ---- Services Editor (live sync) ----
function renderSvcEditor(){
  let data=db(); const wrap=document.getElementById('svcEditor'); wrap.innerHTML='';
  data.categories.forEach((cat,cidx)=>{
    const box=document.createElement('div'); box.className='card'; box.style.marginBottom='12px';
    const title=document.createElement('h4'); title.textContent=cat.name; box.appendChild(title);
    cat.services.forEach((svc,sidx)=>{
      const row=document.createElement('div'); row.className='service'; row.innerHTML=`<input value="${svc.title}" style="width:260px;margin-right:8px"/> <input value="${svc.desc||''}" style="width:60%"/>`;
      // options
      const tbl=document.createElement('table'); tbl.innerHTML='<thead><tr><th>Label</th><th>Minutes</th><th>Prix (FCFA)</th><th></th></tr></thead>';
      const tb=document.createElement('tbody'); tbl.appendChild(tb);
      (svc.options||[]).forEach((op,oidx)=>{
        const tr=document.createElement('tr');
        tr.innerHTML=`<td><input value="${op.label}"/></td><td><input type="number" value="${op.minutes}"/></td><td><input type="number" value="${op.price}"/></td>`;
        const td=document.createElement('td'); const del=document.createElement('button'); del.className='tab'; del.textContent='Supprimer';
        del.onclick=()=>{ let d=db(); d.categories[cidx].services[sidx].options.splice(oidx,1); save(d); broadcastCategories(d.categories); renderSvcEditor();};
        td.appendChild(del); tr.appendChild(td); tb.appendChild(tr);
        const [lbl,min,pr]=tr.querySelectorAll('input');
        lbl.oninput=()=>{ let d=db(); d.categories[cidx].services[sidx].options[oidx].label=lbl.value; save(d); broadcastCategories(d.categories); };
        min.oninput=()=>{ let d=db(); d.categories[cidx].services[sidx].options[oidx].minutes=parseInt(min.value||0); save(d); broadcastCategories(d.categories); };
        pr.oninput=()=>{ let d=db(); d.categories[cidx].services[sidx].options[oidx].price=parseInt(pr.value||0); save(d); broadcastCategories(d.categories); };
      });
      const addOpt=document.createElement('button'); addOpt.className='tab'; addOpt.textContent='Ajouter une option';
      addOpt.onclick=()=>{ let d=db(); d.categories[cidx].services[sidx].options.push({label:"Nouvelle",minutes:60,price:0}); save(d); broadcastCategories(d.categories); renderSvcEditor(); };
      const [tIn,dIn]=row.querySelectorAll('input');
      tIn.oninput=()=>{ let d=db(); d.categories[cidx].services[sidx].title=tIn.value; save(d); broadcastCategories(d.categories); };
      dIn.oninput=()=>{ let d=db(); d.categories[cidx].services[sidx].desc=dIn.value; save(d); broadcastCategories(d.categories); };
      const removeSvc=document.createElement('button'); removeSvc.className='tab'; removeSvc.textContent='Supprimer le service';
      removeSvc.onclick=()=>{ let d=db(); d.categories[cidx].services.splice(sidx,1); save(d); broadcastCategories(d.categories); renderSvcEditor(); };
      row.appendChild(tbl); row.appendChild(addOpt); row.appendChild(removeSvc); box.appendChild(row);
    });
    const addService=document.createElement('button'); addService.className='tab'; addService.textContent='Ajouter un service à « '+cat.name+' »';
    addService.onclick=()=>{ let d=db(); d.categories[cidx].services.push({id:"svc-"+Date.now(),title:"Nouveau service",desc:"",options:[]}); save(d); broadcastCategories(d.categories); renderSvcEditor(); };
    box.appendChild(addService); wrap.appendChild(box);
  });
}
function broadcastCategories(cats){ localStorage.setItem("melodia_services_categories", JSON.stringify(cats)); }
function exportServices(){ const d=db(); const blob=new Blob([JSON.stringify({categories:d.categories},null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download="services.json"; a.click(); URL.revokeObjectURL(url);}

// ---- Stats ----
function renderStats(){ const box=document.getElementById('statsBox'); const d=db(); const paid=d.bookings.filter(b=>b.status==="paid"); const pending=d.bookings.filter(b=>b.status==="pending"); const total=paid.reduce((s,a)=>s+a.total,0); box.innerHTML=`<p><strong>Réservations payées :</strong> ${paid.length} • <strong>CA :</strong> ${total.toLocaleString()} FCFA</p><p><strong>En attente :</strong> ${pending.length}</p>`;}

// ---- Calendar (simplified list) ----
function renderCalendar(){ const box=document.getElementById('calBox'); const d=db(); if(!d.bookings.length){ box.innerHTML='<small class="note">Aucune réservation.</small>'; return;} const tbl=document.createElement('table'); tbl.innerHTML='<thead><tr><th>Ref</th><th>Date</th><th>Client</th><th>Total</th><th>Beatmaker</th><th>Statut</th></tr></thead>'; const tb=document.createElement('tbody'); d.bookings.slice().reverse().forEach(b=>{ const tr=document.createElement('tr'); const dt=new Date(b.datetime).toLocaleString('fr-FR'); const bm=(d.beatmakers.find(x=>x.id===b.beatmakerId)||{}).name||''; tr.innerHTML=`<td>${b.ref}</td><td>${dt}</td><td>${b.name}</td><td>${b.total.toLocaleString()} FCFA</td><td>${bm}</td><td>${b.status}</td>`; tb.appendChild(tr);}); tbl.appendChild(tb); box.innerHTML=''; box.appendChild(tbl);}

// ---- Disponibilités (add/list/delete per beatmaker) ----
function renderDispos(){
  const box=document.getElementById('disposBox'); const d=db(); box.innerHTML='';
  (d.beatmakers||[]).forEach((b)=>{
    const wrap=document.createElement('div'); wrap.className='service';
    wrap.innerHTML=`<h4>${b.name}</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <div>
          <label style="display:block;font-size:12px;color:#9ca3af">Nouveau créneau</label>
          <input type="datetime-local" id="slot-${b.id}" />
        </div>
        <button class="tab" id="add-${b.id}">Ajouter le créneau</button>
      </div>
      <div style="margin-top:10px">
        <strong>Créneaux disponibles</strong>
        <div id="list-${b.id}" style="margin-top:6px"></div>
      </div>`;
    box.appendChild(wrap);

    function renderList(){
      const target=wrap.querySelector(`#list-${b.id}`);
      target.innerHTML='';
      const arr=(db().availability||{})[b.id]||[];
      if(arr.length===0){ target.innerHTML='<small class="note">Aucun créneau enregistré.</small>'; return; }
      arr.slice().sort().forEach((iso)=>{
        const row=document.createElement('div'); row.className='item';
        const dt=new Date(iso);
        const f=dt.toLocaleString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',','');
        row.innerHTML=`<div>${f}</div>`;
        const del=document.createElement('button'); del.className='tab'; del.textContent='Supprimer';
        del.onclick=()=>{ let x=db(); const xs=(x.availability[b.id]||[]); x.availability[b.id]=xs.filter(s=>s!==iso); save(x); broadcastAvailability(x.availability); renderList(); };
        row.appendChild(del); target.appendChild(row);
      });
    }
    renderList();

    wrap.querySelector(`#add-${b.id}`).onclick=()=>{
      const inp=wrap.querySelector(`#slot-${b.id}`);
      const val=inp.value; if(!val){ alert('Choisis une date/heure'); return; }
      let x=db(); x.availability=x.availability||{}; x.availability[b.id]=x.availability[b.id]||[];
      const iso=new Date(val).toISOString();
      if(!x.availability[b.id].includes(iso)){
        x.availability[b.id].push(iso); save(x); broadcastAvailability(x.availability); renderList(); inp.value='';
      } else { alert('Ce créneau existe déjà.'); }
    };
  });
}
function broadcastAvailability(av){ localStorage.setItem('melodia_availability', JSON.stringify(av)); }

// ---- Beatmakers CRUD ----
function renderBmEditor(){
  const box=document.getElementById('bmEditor'); const d=db(); box.innerHTML='';
  (d.beatmakers||[]).forEach((b,idx)=>{
    const row=document.createElement('div'); row.className='service';
    row.innerHTML=`<input value="${b.name}" style="width:220px;margin-right:8px"/><input value="${b.skills||''}" style="width:60%" placeholder="Spécialités"/>`;
    const del=document.createElement('button'); del.className='tab'; del.textContent='Supprimer';
    del.onclick=()=>{ let x=db(); x.beatmakers.splice(idx,1); save(x); renderBmEditor(); };
    const ins=row.querySelectorAll('input');
    ins[0].oninput=()=>{ let x=db(); x.beatmakers[idx].name=ins[0].value; save(x); };
    ins[1].oninput=()=>{ let x=db(); x.beatmakers[idx].skills=ins[1].value; save(x); };
    row.appendChild(del); box.appendChild(row);
  });
  const add=document.createElement('button'); add.className='tab'; add.textContent='Ajouter un beatmaker';
  add.onclick=()=>{ let x=db(); (x.beatmakers||[]).push({id:"bm-"+Date.now(),name:"Nouveau",skills:""}); save(x); renderBmEditor(); };
  box.appendChild(add);
}

// ---- Export CSV ----
function exportCsv(){
  const d=db(); const rows=[["ref","date","client","phone","email","total","beatmaker","status"]];
  d.bookings.forEach(b=>{
    rows.push([b.ref,new Date(b.datetime).toISOString(),b.name,b.phone,b.email,b.total,(d.beatmakers.find(x=>x.id===b.beatmakerId)||{}).name||"",b.status]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\\n");
  const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download="reservations.csv"; a.click(); URL.revokeObjectURL(url);
}
function exportServices(){ const d=db(); const blob=new Blob([JSON.stringify({categories:d.categories},null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download="services.json"; a.click(); URL.revokeObjectURL(url);}
