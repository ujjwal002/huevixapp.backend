const API = '/api/v1';
const TKEY = 'huevix_admin_token';
let charts = [];

function token(){ return localStorage.getItem(TKEY); }
function logout(){ localStorage.removeItem(TKEY); show('login'); }
function show(which){
  document.getElementById('login').style.display = which==='login' ? '' : 'none';
  document.getElementById('dash').style.display  = which==='dash'  ? '' : 'none';
}

async function login(){
  const err = document.getElementById('loginErr'); err.textContent = '';
  try{
    const r = await fetch(API + '/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ email: email.value.trim(), password: password.value })
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data?.error?.message || 'Login failed');
    // tolerate common token shapes
    const t = data.accessToken || data.token || (data.tokens && data.tokens.accessToken);
    if(!t) throw new Error('Login ok but no access token in response');
    localStorage.setItem(TKEY, t);
    show('dash'); load();
  }catch(e){ err.textContent = e.message; }
}

const inr = (n)=> '₹' + Number(n||0).toLocaleString('en-IN');
const nz  = (n)=> Number(n||0).toLocaleString('en-IN');

function stat(label, value, sub, cls){
  return `<div class="stat"><div class="l">${label}</div><div class="v ${cls||''}">${value}</div>${sub?`<div class="s">${sub}</div>`:''}</div>`;
}
function na(title){ return `<div class="panel"><span class="na">${title}: no data (section unavailable)</span></div>`; }

async function load(){
  charts.forEach(c=>c.destroy()); charts=[];
  const box = document.getElementById('content');
  box.innerHTML = '<p class="muted">Loading…</p>';
  const r = await fetch(API + '/admin/metrics?days=30', { headers:{ Authorization: 'Bearer ' + token() }});
  if(r.status===401 || r.status===403){ logout(); return; }
  const m = await r.json();
  document.getElementById('stamp').textContent = 'Updated ' + new Date(m.generatedAt).toLocaleTimeString();

  let html = '';

  // -------- topline --------
  const u=m.users, a=m.activity, ret=m.retention;
  html += '<div class="grid">';
  if(u){ html += stat('Total users', nz(u.total), `+${nz(u.newToday)} today · +${nz(u.new7d)} this week`); }
  if(a){ html += stat('DAU', nz(a.dau), `WAU ${nz(a.wau)} · MAU ${nz(a.mau)}`);
         html += stat('Stickiness', a.stickiness + '%', 'DAU / MAU'); }
  if(ret){
    const c=(v)=> v===null?'—':v+'%';
    html += stat('D1 retention', c(ret.d1), `cohort ${nz(ret.d1Cohort)}`, ret.d1>=25?'good':ret.d1===null?'':'warn');
    html += stat('D7 retention', c(ret.d7), `cohort ${nz(ret.d7Cohort)}`, ret.d7>=15?'good':ret.d7===null?'':'warn');
    html += stat('D30 retention', c(ret.d30), `cohort ${nz(ret.d30Cohort)}`, ret.d30>=8?'good':ret.d30===null?'':'warn');
  }
  html += '</div>';

  // -------- growth charts --------
  html += '<h2>Growth (30 days)</h2><div class="two">';
  html += (u&&u.signupSeries)? '<div class="panel"><canvas id="chSignups"></canvas></div>' : na('Signups');
  html += (a&&a.dauSeries)?    '<div class="panel"><canvas id="chDau"></canvas></div>'     : na('DAU');
  html += '</div>';

  // -------- gaja voice --------
  const v=m.voice;
  html += '<h2>Gaja Voice (AI)</h2>';
  if(v){
    html += '<div class="grid">'
      + stat('Sessions', nz(v.sessionsTotal), `${nz(v.sessionsToday)} today · ${nz(v.sessions7d)} 7d`)
      + stat('Minutes talked', nz(v.minutesTotal), `avg ${v.avgTurnsPerSession} turns/session`)
      + stat('Voice revenue', inr(v.revenueInr), `${nz(v.coinsSpent)} coins spent`)
      + stat('Est. cost', inr(v.estCostInr), 'Sarvam + GPT')
      + stat('Est. margin', inr(v.estMarginInr), '', v.estMarginInr>=0?'good':'bad')
      + '</div>';
    if(v.modes && v.modes.length){
      html += '<div class="panel"><table><tr><th>Mode</th><th>Sessions</th></tr>'
        + v.modes.map(x=>`<tr><td>${x.mode}</td><td>${nz(x.sessions)}</td></tr>`).join('') + '</table></div>';
    }
  } else html += na('Voice');

  // -------- quiz --------
  const q=m.quiz;
  html += '<h2>Quiz Engagement</h2>';
  html += q ? '<div class="grid">'
      + stat('Completed today', nz(q.completedToday))
      + stat('Completed 7d', nz(q.completed7d))
      + stat('All-time plays', nz(q.completedTotal))
      + stat('Users with 30 days', nz(q.usersWith30Days), 'referral-qualified pace')
      + '</div>' : na('Quiz');

  // -------- referrals --------
  const rf=m.referrals;
  html += '<h2>Referrals</h2>';
  html += rf ? '<div class="grid">'
      + stat('Invited', nz(rf.total), `${nz(rf.pending)} in progress`)
      + stat('Qualified', nz(rf.qualified))
      + stat('Accrued liability', inr(rf.liabilityInr), 'earned − paid', rf.liabilityInr>0?'warn':'')
      + stat('Payouts pending', nz(rf.payoutsPending), inr(rf.payoutsPendingInr))
      + stat('Payouts paid', nz(rf.payoutsPaid), inr(rf.payoutsPaidInr))
      + '</div>' : na('Referrals');

  // -------- content + economy --------
  const c=m.content, e=m.economy;
  html += '<h2>Content & Economy</h2><div class="grid">';
  if(c){
    html += stat('Cards', nz(c.cardsTotal), `${nz(c.published)} published · +${nz(c.new7d)} 7d`);
    html += stat('Audio ready', nz(c.audioReady), `${nz(c.audioMissing)} pending/failed`, c.audioMissing>0?'warn':'good');
  }
  if(e){ html += stat('Coins in wallets', nz(e.coinsInWallets), 'liability ' + inr(e.walletLiabilityInr)); }
  html += '</div>';

  box.innerHTML = html;

  // charts
  const mk=(id,label,data,key)=> {
    const el=document.getElementById(id); if(!el) return;
    charts.push(new Chart(el,{type:'line',data:{labels:data.map(x=>x.day.slice(5)),
      datasets:[{label,data:data.map(x=>x[key]),borderColor:'#8b5cf6',backgroundColor:'rgba(139,92,246,.15)',fill:true,tension:.3,pointRadius:0}]},
      options:{plugins:{legend:{labels:{color:'#9a94c2'}}},scales:{x:{ticks:{color:'#9a94c2'},grid:{color:'#2a2550'}},y:{ticks:{color:'#9a94c2'},grid:{color:'#2a2550'},beginAtZero:true}}}}));
  };
  if(u&&u.signupSeries) mk('chSignups','Signups / day',u.signupSeries,'signups');
  if(a&&a.dauSeries)    mk('chDau','Daily active users',a.dauSeries,'dau');
}

if(token()){ show('dash'); load(); } else show('login');

// CSP-safe event wiring (no inline handlers)
document.getElementById('btnLogin').addEventListener('click', login);
document.getElementById('btnRefresh').addEventListener('click', load);
document.getElementById('btnLogout').addEventListener('click', logout);
document.getElementById('password').addEventListener('keydown', (e)=>{ if(e.key==='Enter') login(); });