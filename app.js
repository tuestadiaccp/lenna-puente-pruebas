// Página independiente del puente de pruebas (sin servidor propio): habla solo con el Supabase de pruebas.
// Solo usa la clave PÚBLICA; las funciones del servidor exigen que quien entra sea administrador del espacio.
(() => {
  const cfg = window.LENNA_PUENTE;
  const $ = id => document.getElementById(id);
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  const NAMES = { 'claude-desarrollo': 'Claude Desarrollo', 'claude-conserjeria': 'Claude Conserjería', codex: 'Codex' };
  const STATES = { busy: 'Ocupado según sus metadatos', idle: 'Libre según sus metadatos', unknown: 'Desconocido' };
  let workspace = null, polling = 0;

  const setMsg = text => { $('msg').textContent = text || ''; };
  const show = loggedIn => { $('login').hidden = loggedIn; $('panel').hidden = !loggedIn; };
  const text = (parent, tag, value, cls) => { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; parent.append(el); return el; };

  async function rpc(action, extra = {}) {
    const { data, error } = await db.rpc('bridge_status_user', { p_workspace: workspace, p_action: action, ...extra });
    if (error) throw new Error('No se pudo consultar el puente. Comprueba la conexión, el emparejamiento y tus permisos.');
    return data;
  }

  function render(r) {
    const box = $('result'); box.replaceChildren();
    if (!r) return;
    if (r.state === 'pending') text(box, 'p', 'Esperando al computador (máximo dos minutos)…');
    if (r.state === 'expired') text(box, 'p', 'Consulta vencida: el computador no respondió a tiempo. No implica que Claude esté cerrado.');
    for (const t of r.response ?? []) { const p = document.createElement('p'); text(p, 'strong', (NAMES[t.destination] ?? 'Destino') + ': '); p.append(STATES[t.state] ?? 'Desconocido'); box.append(p); }
    if (r.completedAt) text(box, 'p', 'Respuesta recibida: ' + new Date(r.completedAt).toLocaleString() + '. Es una observación, no una garantía de disponibilidad.', 'mut');
    if (r.lastSeen && r.state !== 'completed') text(box, 'p', 'Última señal del computador: ' + new Date(r.lastSeen).toLocaleString(), 'mut');
  }

  async function follow(r) {
    render(r);
    const run = ++polling;
    if (!r || r.state !== 'pending') return;
    const until = Date.now() + 125000;
    while (run === polling && Date.now() < until) {
      await new Promise(res => setTimeout(res, 3000));
      if (run !== polling) return;
      try { r = await rpc('result', { p_request: r.id }); setMsg(''); render(r); if (r.state !== 'pending') return; }
      catch { setMsg('No se pudo recuperar la respuesta. Puedes volver a consultar.'); }
    }
    if (run === polling) { render(null); setMsg('Se agotó la espera. Vuelve a consultar cuando tengas conexión.'); }
  }

  const busyWhile = async (buttons, fn) => { buttons.forEach(b => $(b).disabled = true); try { await fn(); } catch (e) { setMsg(e.message || 'Consulta no disponible'); } finally { buttons.forEach(b => $(b).disabled = false); } };
  const ALL = ['ask', 'latest', 'pair', 'revoke'];

  // El espacio es fijo (config.js). El permiso de administrador lo valida el SERVIDOR: si no lo eres, la consulta se rechaza (42501).
  async function enter(session) {
    workspace = cfg.workspaceId;
    const { error } = await db.rpc('bridge_status_user', { p_workspace: workspace, p_action: 'latest' });
    if (error && (error.code === '42501' || /not authorized/i.test(error.message || ''))) {
      show(false); workspace = null;
      $('loginMsg').textContent = 'Entraste con ' + (session.user.email || 'ese correo') + ', pero ese correo no es el administrador del puente de pruebas. Usa el correo del administrador.';
      await db.auth.signOut(); return;
    }
    show(true);
    if (error) setMsg(/not paired/i.test(error.message || '') ? 'Todavía no hay un computador vinculado.' : /revoked/i.test(error.message || '') ? 'El acceso del computador está revocado.' : 'El puente avisó: ' + (error.message || 'error'));
  }

  $('send').onclick = async () => {
    const email = $('email').value.trim();
    if (!email) { $('loginMsg').textContent = 'Escribe tu correo.'; return; }
    $('send').disabled = true;
    const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } });
    $('loginMsg').textContent = error ? (error.status === 429 ? 'Espera un minuto: solo se puede pedir un correo por minuto.' : 'No se pudo enviar el acceso. Revisa el correo (debe ser el de administrador).') : 'Listo. Abre el correo en este mismo teléfono y toca el enlace (o escribe el código de 8 dígitos si trae uno). Puede tardar un minuto.';
    $('send').disabled = false;
  };
  $('verify').onclick = async () => {
    const { data, error } = await db.auth.verifyOtp({ email: $('email').value.trim(), token: $('code').value.trim(), type: 'email' });
    if (error || !data.session) { $('loginMsg').textContent = 'Código incorrecto o vencido.'; return; }
    await enter(data.session);
  };
  $('ask').onclick = () => busyWhile(['ask', 'latest'], async () => { setMsg(''); await follow(await rpc('request')); });
  $('latest').onclick = () => busyWhile(['ask', 'latest'], async () => { setMsg(''); const r = await rpc('latest'); if (!r) { render(null); setMsg('No hay consultas recientes para recuperar.'); } else await follow(r); });
  $('pair').onclick = () => busyWhile(ALL, async () => {
    if (!confirm('Esto REEMPLAZA la credencial actual y DESCONECTA el puente hasta que guardes la nueva en el computador. ¿Continuar?')) return;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    await rpc('pair', { p_token: token }); $('cred').value = token; $('cred').hidden = false; $('hide').hidden = false; render(null);
  });
  $('hide').onclick = () => { $('cred').value = ''; $('cred').hidden = true; $('hide').hidden = true; };
  $('revoke').onclick = () => busyWhile(ALL, async () => {
    if (!confirm('Esto DESCONECTA el computador del puente. ¿Revocar el acceso?')) return;
    await rpc('revoke'); $('hide').onclick(); render(null); setMsg('Acceso del computador revocado.');
  });
  $('logout').onclick = async () => { polling++; await db.auth.signOut(); workspace = null; show(false); };

  // Si el enlace del correo vuelve con un error (vencido, ya usado, bloqueado por el visor del correo), se dice con claridad.
  function linkProblem() {
    const params = new URLSearchParams(location.hash.replace(/^#/, '') || location.search);
    const code = params.get('error_code') || params.get('error');
    if (!code) return null;
    history.replaceState(null, '', location.pathname);
    if (code === 'otp_expired') return 'El enlace del correo está vencido o ya se usó (algunos correos lo "abren" solos y lo gastan). Pide uno nuevo y ábrelo directo, sin vista previa.';
    return 'El enlace del correo no funcionó (' + code + '). Pide uno nuevo.';
  }

  (async () => {
    const problem = linkProblem();
    const { data } = await db.auth.getSession();
    if (data.session) await enter(data.session); else { show(false); if (problem) $('loginMsg').textContent = problem; }
    db.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_IN' && session && !workspace) void enter(session); });
  })();
})();
