// Importa datas ocupadas de calendários iCal (Airbnb e Booking) para a coleção
// "bloqueios". Só grava com APLICAR=true. Links e chave ficam nos Secrets do
// GitHub, e os registros não recebem nome nem contato de hóspedes.
import { pathToFileURL } from 'node:url';

const CASAS = ['amarela', 'bege', 'marrom', 'branca', 'nossa'];

export function dataIso(valor) {
  const m = String(valor || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export function lerEventosIcal(texto) {
  const bruto = String(texto || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  if (!/BEGIN:VCALENDAR/.test(bruto)) throw new Error('resposta-nao-e-calendario');
  const eventos = [];
  for (const bloco of bruto.split('BEGIN:VEVENT').slice(1)) {
    const corpo = bloco.split('END:VEVENT')[0];
    const campo = (nome) => {
      const m = corpo.match(new RegExp(`^${nome}(?:;[^:\\n]*)?:(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    if (campo('STATUS').toUpperCase() === 'CANCELLED') continue;
    const entrada = dataIso(campo('DTSTART'));
    const saida = dataIso(campo('DTEND'));
    if (entrada && saida && saida > entrada) eventos.push({ entrada, saida, titulo: campo('SUMMARY') });
  }
  return eventos;
}

function somarDia(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function coberto(ev, ocupacoes) {
  for (let d = ev.entrada; d < ev.saida; d = somarDia(d, 1)) {
    if (!ocupacoes.some((o) => d >= o.entrada && d < o.saida)) return false;
  }
  return true;
}

// Datas apenas fechadas a cerca de 1 ano ou mais são o limite da agenda da plataforma, não ocupação.
// Reservas (título "Reserved" ou outro) nunca entram nesta regra.
export function limiteDaAgenda(ev, hoje) {
  return /not available|closed|indispon/i.test(ev.titulo || '') && ev.entrada >= somarDia(hoje, 360);
}

// Decide o que criar e remover, sem acessar nada externo.
export function planejar({ casa, origem, eventos, internos, existentes, hoje }) {
  const prefixo = `ext_${casa}_${origem}_`;
  const futuros = eventos.filter((e) => e.saida >= hoje && !limiteDaAgenda(e, hoje));
  const vistos = new Map();
  const cobertos = new Set();
  for (const e of futuros) {
    const id = `${prefixo}${e.entrada}_${e.saida}`;
    if (coberto(e, internos.filter((o) => o.casa === casa))) { cobertos.add(id); continue; }
    vistos.set(id, { casa, entrada: e.entrada, saida: e.saida, motivo: origem === 'airbnb' ? 'Airbnb' : origem === 'booking' ? 'Booking.com' : origem, origem, externo: true });
  }
  const atuais = existentes.filter((x) => x.id.startsWith(prefixo) && x.saida >= hoje);
  const idsAtuais = new Set(atuais.map((x) => x.id));
  const criar = [...vistos.entries()].filter(([id]) => !idsAtuais.has(id)).map(([id, dados]) => ({ id, dados }));
  const remover = atuais.filter((x) => !vistos.has(x.id)).map((x) => x.id);
  // A trava protege contra um calendário que veio vazio; datas ainda presentes nele, já ocupadas no painel, podem sair.
  const sumiram = remover.filter((id) => !cobertos.has(id));
  const removeDemais = atuais.length >= 3 && sumiram.length / atuais.length > 0.5;
  return { criar, remover: removeDemais ? remover.filter((id) => cobertos.has(id)) : remover, remocaoRetida: removeDemais ? sumiram.length : 0, total: vistos.size };
}

// Remove espaços e caracteres invisíveis que podem vir ao copiar e colar.
export function limparLink(valor) {
  return String(valor || '').replace(/[\s\u00A0\u200B-\u200F\u2060\uFEFF]/g, '').replace(/^webcal:\/\//i, 'https://');
}

export function lerConfiguracao(json) {
  let lista;
  try { lista = JSON.parse(String(json || '').replace(/^\uFEFF/, '').trim()); } catch { throw new Error('ICAL_FEEDS não é um JSON válido'); }
  if (!Array.isArray(lista) || !lista.length) throw new Error('ICAL_FEEDS está vazio');
  lista.forEach((f, i) => {
    if (!CASAS.includes(f.casa)) throw new Error(`Item ${i + 1}: casa inválida`);
    if (!['airbnb', 'booking'].includes(f.origem)) throw new Error(`Item ${i + 1}: origem inválida`);
    f.url = limparLink(f.url);
    if (!/^https:\/\//i.test(f.url)) throw new Error(`Item ${i + 1}: link inválido (começa com "${f.url.slice(0, 8)}", ${f.url.length} caracteres)`);
  });
  return lista;
}

// ---------- Envio: gera um .ics por casa e plataforma com as datas ocupadas no painel ----------
const ROTULO_DESTINO = { airbnb: /airbnb/i, booking: /booking/i };

export function lerExportacoes(texto) {
  return String(texto || '').split(/[,;\s]+/).filter(Boolean).map((item) => {
    const [casa, destino] = item.toLowerCase().split(':');
    if (!CASAS.includes(casa) || !ROTULO_DESTINO[destino]) throw new Error(`EXPORTAR_CALENDARIOS: item inválido "${item}"`);
    return { casa, destino };
  });
}

// Junta períodos que se tocam ou se sobrepõem.
export function juntarPeriodos(lista) {
  const ord = lista.filter((x) => x.entrada < x.saida).sort((a, b) => a.entrada.localeCompare(b.entrada));
  const out = [];
  for (const x of ord) {
    const u = out[out.length - 1];
    if (u && x.entrada <= u.saida) { if (x.saida > u.saida) u.saida = x.saida; } else out.push({ entrada: x.entrada, saida: x.saida });
  }
  return out;
}

// Ocupações do painel que devem ir para a plataforma: reservas e bloqueios, menos o que veio dela mesma.
export function periodosParaExportar({ casa, destino, disponibilidade, origemPorReserva, bloqueios, hoje }) {
  const daPlataforma = ROTULO_DESTINO[destino];
  const res = disponibilidade.filter((d) => d.casa === casa && !daPlataforma.test(origemPorReserva[d.reservaId || d.id] || ''));
  const blq = bloqueios.filter((b) => b.casa === casa && !(b.externo && b.origem === destino));
  return juntarPeriodos([...res, ...blq].filter((x) => x.entrada && x.saida && x.saida > hoje));
}

export function gerarIcs(casa, periodos, agora = new Date()) {
  const carimbo = agora.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const d = (iso) => iso.replace(/-/g, '');
  const linhas = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Casas na Praia//Calendario//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const p of periodos) {
    linhas.push('BEGIN:VEVENT', `UID:${casa}-${d(p.entrada)}-${d(p.saida)}@casas-na-praia.web.app`, `DTSTAMP:${carimbo}`, `DTSTART;VALUE=DATE:${d(p.entrada)}`, `DTEND;VALUE=DATE:${d(p.saida)}`, 'SUMMARY:Indisponível', 'END:VEVENT');
  }
  linhas.push('END:VCALENDAR');
  return linhas.join('\r\n') + '\r\n';
}

async function baixar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'casas-na-praia-sync' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function principal() {
  const aplicar = process.env.APLICAR === 'true';
  const feeds = lerConfiguracao(process.env.ICAL_FEEDS);
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  console.log(aplicar ? 'Modo: APLICAR' : 'Modo: TESTE (nada será gravado)');
  // Só o que termina de hoje em diante: o histórico não muda nada aqui e só gastaria leituras.
  const [rs, bs] = await Promise.all([db.collection('disponibilidade').where('saida', '>=', hoje).get(), db.collection('bloqueios').where('saida', '>=', hoje).get()]);
  const bloqueios = bs.docs.map((d) => ({ id: d.id, ...d.data() }));
  const internos = [...rs.docs.map((d) => d.data()), ...bloqueios.filter((b) => !b.externo)].filter((o) => o.casa && o.entrada && o.saida);
  let falhas = 0;
  for (const f of feeds) {
    const rotulo = `${f.casa}/${f.origem}`;
    try {
      const eventos = lerEventosIcal(await baixar(f.url));
      const p = planejar({ casa: f.casa, origem: f.origem, eventos, internos, existentes: bloqueios.filter((b) => b.externo), hoje });
      console.log(`${rotulo}: ${eventos.length} evento(s) lidos; criar ${p.criar.length}; remover ${p.remover.length}`);
      p.criar.forEach((c) => console.log(`  + ${c.dados.entrada} a ${c.dados.saida}`));
      if (p.remocaoRetida) console.log(`  ATENÇÃO: remoção de ${p.remocaoRetida} bloqueio(s) retida. Confira o calendário.`);
      if (aplicar && (p.criar.length || p.remover.length)) {
        const lote = db.batch();
        p.criar.forEach((c) => lote.set(db.collection('bloqueios').doc(c.id), { ...c.dados, atualizadoEm: FieldValue.serverTimestamp(), criadoEm: FieldValue.serverTimestamp() }));
        p.remover.forEach((id) => lote.delete(db.collection('bloqueios').doc(id)));
        await lote.commit();
      }
    } catch (e) {
      falhas++;
      console.error(`${rotulo}: falhou (${e?.name === 'TimeoutError' ? 'tempo esgotado' : String(e?.message || 'erro').replace(/https?:\/\/\S+/g, '[link]')}). Nada foi alterado para este calendário.`);
    }
  }
  const exportacoes = lerExportacoes(process.env.EXPORTAR_CALENDARIOS);
  if (exportacoes.length) {
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      // Atualiza a leitura depois das gravações acima, para o envio refletir o estado atual.
      const [rs2, bs2, futuras] = await Promise.all([db.collection('disponibilidade').where('saida', '>', hoje).get(), db.collection('bloqueios').where('saida', '>', hoje).get(), db.collection('reservas').where('saida', '>=', hoje).get()]);
      const origemPorReserva = {};
      futuras.forEach((d) => { origemPorReserva[d.id] = String(d.data().origemReserva || ''); });
      const disp = rs2.docs.map((d) => ({ id: d.id, ...d.data() }));
      const blqs = bs2.docs.map((d) => ({ id: d.id, ...d.data() }));
      mkdirSync('saida-calendarios', { recursive: true });
      for (const { casa, destino } of exportacoes) {
        const periodos = periodosParaExportar({ casa, destino, disponibilidade: disp, origemPorReserva, bloqueios: blqs, hoje });
        writeFileSync(`saida-calendarios/${casa}-para-${destino}.ics`, gerarIcs(casa, periodos));
        console.log(`Envio ${casa} para ${destino}: ${periodos.length} período(s) ocupado(s)`);
        periodos.forEach((p) => console.log(`  > ${p.entrada} a ${p.saida}`));
      }
    } catch (e) {
      falhas++;
      console.error(`Envio dos calendários falhou (${String(e?.message || 'erro')}). Os links continuam com a versão anterior.`);
      try { (await import('node:fs')).rmSync('saida-calendarios', { recursive: true, force: true }); } catch {}
    }
  }
  if (falhas) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((e) => {
    console.error('Falha geral:', String(e?.message || 'erro').replace(/https?:\/\/\S+/g, '[link]'));
    process.exitCode = 1;
  });
}
