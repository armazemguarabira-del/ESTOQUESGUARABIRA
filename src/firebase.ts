import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
} from 'firebase/firestore';
import { RawData, ContagemEstoqueItem, SavedDailyDiffRecord } from './data/types';
import { applyFixedPricesToRes } from './data/fixedPrices';
import { AppUser, PublicUser, RegisterUserInput, UserRole } from './types/auth';
import { hashPassword, verifyPassword, validateUsername, normalizeUsername } from './utils/authCrypto';

export const firebaseConfig = {
  apiKey: "AIzaSyCNeRWfV7L-i3X1GBegzETsEbpGkmK_s4g",
  authDomain: "banco-03-6b1ea.firebaseapp.com",
  projectId: "banco-03-6b1ea",
  storageBucket: "banco-03-6b1ea.firebasestorage.app",
  messagingSenderId: "645365828863",
  appId: "1:645365828863:web:beb28f8f10226a02e210ca"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Identificador único da sessão do cliente para evitar loops de eco em tempo real
export const CLIENT_SESSION_ID =
  'cli_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

const STATE_COLLECTION = 'estoque_guarabira';
const MAIN_DOC = 'estado_atual';
const EC_DOC = 'estoque_central';
const CONTAGENS_DOC = 'contagens_estoque';
const LOGS_COLLECTION = 'historico_acoes';
const DAILY_DIFFS_COLLECTION = 'diferencas_diarias_salvas';
const USERS_COLLECTION = 'usuarios_sistema';

export interface ActionLog {
  id?: string;
  action: string;
  timestamp?: any;
  dateStr: string;
  details?: string;
}

// Estado interno da fila de salvamento no Firestore
let isSaving = false;
let saveDebounceTimer: any = null;
let lastKnownTotalChunks = 1;
let lastSavedEcHash = '';
let currentBackoffMs = 0;

/**
 * Gera um hash determinístico baseado no conteúdo completo do Estoque Central (02.05.02),
 * evitando colisões quando o número de linhas e o tamanho em caracteres coincidem.
 */
export function computeEcContentHash(ec: { h?: any[]; r?: any[][] } | undefined | null): string {
  if (!ec || !Array.isArray(ec.r)) return '';
  const str = JSON.stringify(ec);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (ch + (i & 0xff));
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${ec.r.length}_${str.length}_${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

interface QueuedSaveRequest {
  data: RawData;
  actionName?: string;
  details?: string;
  resolve: (value: boolean) => void;
}

let pendingSaveRequest: QueuedSaveRequest | null = null;

/**
 * Salva o estado completo no Firestore com fila serializada, debounce inteligente
 * e retry com exponential backoff para evitar erros de limite de banda (resource-exhausted).
 */
export function saveStateToFirestore(
  data: RawData,
  actionName?: string,
  details?: string,
  immediate: boolean = false
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Atualiza a requisição pendente com o dado mais recente
    pendingSaveRequest = { data, actionName, details, resolve };

    if (immediate) {
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
      }
      processSaveQueue();
    } else {
      // Debounce de 1200ms para agrupar alterações rápidas e evitar estouro de requisições
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
      }
      saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        processSaveQueue();
      }, 1200);
    }
  });
}

/**
 * Processador serializado da fila de salvamento
 */
async function processSaveQueue() {
  if (isSaving || !pendingSaveRequest) {
    return;
  }

  isSaving = true;
  const currentReq = pendingSaveRequest;
  pendingSaveRequest = null;

  try {
    const success = await executeSaveWithBackoff(currentReq.data, currentReq.actionName, currentReq.details);
    currentReq.resolve(success);
  } catch (err) {
    console.warn('[Firestore] Falha ao processar salvamento:', err);
    currentReq.resolve(false);
  } finally {
    isSaving = false;
    // Se novas alterações chegaram enquanto este salvamento ocorria, processa a próxima
    if (pendingSaveRequest) {
      setTimeout(processSaveQueue, currentBackoffMs > 0 ? currentBackoffMs : 200);
    }
  }
}

/**
 * Executa as escritas no Firestore aplicando retry com exponential backoff em caso de resource-exhausted
 */
async function executeSaveWithBackoff(
  data: RawData,
  actionName?: string,
  details?: string,
  maxRetries: number = 3
): Promise<boolean> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      if (currentBackoffMs > 0) {
        await new Promise((r) => setTimeout(r, currentBackoffMs));
      }

      const mainDocRef = doc(db, STATE_COLLECTION, MAIN_DOC);
      const ecDocRef = doc(db, STATE_COLLECTION, EC_DOC);
      const contagensDocRef = doc(db, STATE_COLLECTION, CONTAGENS_DOC);

      // Preços ficam fixados apenas no código da plataforma e NÃO são enviados ao Firebase
      const stripPricesFromRows = (rows?: any[][]) =>
        Array.isArray(rows)
          ? rows.map((r) => {
              const copy = [...r];
              copy[5] = 0;
              return copy;
            })
          : rows;

      // Serializa o payload principal sem armazenar preços
      const fullPayload = JSON.stringify({
        xs: data.xs,
        res: stripPricesFromRows(data.res),
        gradeRes: stripPricesFromRows(data.gradeRes),
        aj: data.aj,
        dia: data.dia,
        men: data.men,
        recontagens: data.recontagens,
        desativados: data.desativados,
        diferencaConfirmadaCodes: data.diferencaConfirmadaCodes || [],
        dashboardSnapshots: data.dashboardSnapshots,
        ec0304: data.ec0304,
        ecSyncHash: data.ecSyncHash || '',
        gradeEc: data.gradeEc,
        frozen020502: data.frozen020502 || {},
        frozen020502At: data.frozen020502At || '',
        contagem021101: data.contagem021101,
        contagensEstoque: data.contagensEstoque || [],
      });

      const CHUNK_SIZE = 700000;
      const numChunks = Math.max(1, Math.ceil(fullPayload.length / CHUNK_SIZE));

      // 1. Salva cada chunk necessário
      for (let i = 0; i < numChunks; i++) {
        const chunkDocRef = doc(db, STATE_COLLECTION, `${MAIN_DOC}_part_${i}`);
        await setDoc(chunkDocRef, {
          payload: fullPayload.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          index: i,
          totalChunks: numChunks,
          updatedAt: serverTimestamp(),
          updatedAtStr: new Date().toISOString(),
        });
      }

      // 2. Limpa SOMENTE chunks que realmente existiam no salvamento anterior e deixaram de existir
      if (lastKnownTotalChunks > numChunks) {
        for (let i = numChunks; i < lastKnownTotalChunks; i++) {
          try {
            const excessDocRef = doc(db, STATE_COLLECTION, `${MAIN_DOC}_part_${i}`);
            await setDoc(excessDocRef, { payload: '', totalChunks: 0, exists: false });
          } catch {}
        }
      }
      lastKnownTotalChunks = numChunks;

      // 3. Salva contagens_estoque para broadcast leve instantâneo
      await setDoc(contagensDocRef, {
        items: data.contagensEstoque || [],
        clientSessionId: CLIENT_SESSION_ID,
        updatedAt: serverTimestamp(),
        updatedAtStr: new Date().toISOString(),
        actionName: actionName || 'atualizou_contagens',
      });

      // 4. Atualiza o documento de controle principal
      await setDoc(mainDocRef, {
        totalChunks: numChunks,
        chunkSize: CHUNK_SIZE,
        payloadLength: fullPayload.length,
        clientSessionId: CLIENT_SESSION_ID,
        updatedAt: serverTimestamp(),
        updatedAtStr: new Date().toISOString(),
        actionName: actionName || '',
        version: 2,
      });

      // 5. Salva o estoque central apenas quando houver alteração real nele (economiza banda sem risco de colisão)
      if (data.ec) {
        const ecHash = computeEcContentHash(data.ec);
        if (ecHash !== lastSavedEcHash) {
          const ecStr = JSON.stringify(data.ec);
          await setDoc(ecDocRef, {
            payload: ecStr,
            clientSessionId: CLIENT_SESSION_ID,
            updatedAt: serverTimestamp(),
            updatedAtStr: new Date().toISOString(),
          });
          lastSavedEcHash = ecHash;
        }
      }

      // 6. Registra no histórico apenas ações relevantes com nome
      if (actionName && !actionName.startsWith('Alterou')) {
        await logActionToFirestore(actionName, details);
      }

      // Sucesso: zera o backoff
      currentBackoffMs = 0;
      return true;
    } catch (error: any) {
      const errStr = String(error?.code || '') + ' ' + String(error?.message || '');
      const isBandwidthExhausted =
        errStr.includes('resource-exhausted') ||
        errStr.includes('bandwidth') ||
        error?.code === 'resource-exhausted';

      if (isBandwidthExhausted && attempt < maxRetries) {
        attempt++;
        currentBackoffMs = Math.min(30000, currentBackoffMs ? currentBackoffMs * 2 : 2500);
        console.warn(
          `[Firestore] Limite de banda do banco atingido (resource-exhausted). Aguardando backoff de ${currentBackoffMs}ms antes de tentar novamente (tentativa ${attempt}/${maxRetries})...`
        );
      } else {
        console.warn('[Firestore] Erro temporário ao salvar (dados preservados com segurança localmente):', error?.message || error);
        return false;
      }
    }
  }

  return false;
}

/**
 * Registra uma ação no histórico do Firestore
 */
export async function logActionToFirestore(action: string, details?: string): Promise<void> {
  try {
    const logsRef = collection(db, LOGS_COLLECTION);
    await addDoc(logsRef, {
      action,
      details: details || '',
      timestamp: serverTimestamp(),
      dateStr: new Date().toLocaleString('pt-BR'),
    });
  } catch (error) {
    console.error('Erro ao registrar log no Firestore:', error);
  }
}

/**
 * Carrega o estado salvo do Firestore com recuperação resiliente
 */
export async function loadStateFromFirestore(): Promise<RawData | null> {
  try {
    const mainDocRef = doc(db, STATE_COLLECTION, MAIN_DOC);
    const ecDocRef = doc(db, STATE_COLLECTION, EC_DOC);
    const contagensDocRef = doc(db, STATE_COLLECTION, CONTAGENS_DOC);

    const [mainSnap, ecSnap, contagensSnap] = await Promise.all([
      getDoc(mainDocRef),
      getDoc(ecDocRef),
      getDoc(contagensDocRef).catch(() => null),
    ]);

    if (!mainSnap.exists()) {
      return null;
    }

    const mainData = mainSnap.data();
    const totalChunks = mainData?.totalChunks || 1;

    // Busca todos os chunks em paralelo
    const chunkPromises = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkDocRef = doc(db, STATE_COLLECTION, `${MAIN_DOC}_part_${i}`);
      chunkPromises.push(getDoc(chunkDocRef));
    }
    const chunkSnaps = await Promise.all(chunkPromises);

    let fullPayload = '';
    for (const snap of chunkSnaps) {
      if (snap.exists() && snap.data().payload) {
        fullPayload += snap.data().payload;
      }
    }

    let parsedMain: any = null;

    if (fullPayload) {
      try {
        parsedMain = JSON.parse(fullPayload);
      } catch (parseErr) {
        console.warn('Tentativa de reparo de junção no JSON do Firestore...', parseErr);
        try {
          const repaired = fullPayload.replace(/",01",/g, '"],["01",');
          parsedMain = JSON.parse(repaired);
        } catch {
          if (mainData.payload) {
            try {
              parsedMain = JSON.parse(mainData.payload);
            } catch {}
          }
        }
      }
    } else if (mainData.payload) {
      try {
        parsedMain = JSON.parse(mainData.payload);
      } catch {}
    }

    if (!parsedMain) {
      console.warn('Nenhum payload de estado válido encontrado no Firestore.');
      return null;
    }

    let parsedEc: any = undefined;
    if (ecSnap.exists()) {
      const ecDoc = ecSnap.data();
      if (ecDoc.payload) {
        try {
          parsedEc = JSON.parse(ecDoc.payload);
        } catch (e) {
          console.warn('Erro ao parsear ecDoc payload:', e);
        }
      } else if (ecDoc.ec) {
        parsedEc = ecDoc.ec;
      }
    }

    // Carrega contagens de estoque (prioriza o documento direto se existir)
    let parsedContagens: ContagemEstoqueItem[] = parsedMain.contagensEstoque || [];
    if (contagensSnap && contagensSnap.exists()) {
      const cData = contagensSnap.data();
      if (Array.isArray(cData?.items) && cData.items.length > 0) {
        parsedContagens = cData.items;
      }
    }

    lastKnownTotalChunks = totalChunks;
    lastSavedEcHash = parsedEc ? computeEcContentHash(parsedEc) : '';

    // Preços não vêm do Firebase: sempre são consultados diretamente de FIXED_PRODUCT_PRICES no código
    return {
      xs: parsedMain.xs || [],
      res: applyFixedPricesToRes(parsedMain.res || []),
      gradeRes: parsedMain.gradeRes
        ? applyFixedPricesToRes(parsedMain.gradeRes)
        : undefined,
      aj: parsedMain.aj || { av: [], so: [], rp: [], fm: [] },
      dia: parsedMain.dia || [],
      men: parsedMain.men || [],
      ec: parsedEc || { h: [], r: [] },
      ecSyncHash: parsedMain.ecSyncHash || '',
      priceOverrides: {},
      gradeEc: parsedMain.gradeEc,
      ec0304: parsedMain.ec0304,
      frozen020502: parsedMain.frozen020502 || {},
      frozen020502At: parsedMain.frozen020502At || '',
      recontagens: parsedMain.recontagens || [],
      desativados: parsedMain.desativados || [],
      diferencaConfirmadaCodes: parsedMain.diferencaConfirmadaCodes || [],
      dashboardSnapshots: parsedMain.dashboardSnapshots || [],
      contagem021101: parsedMain.contagem021101 || { counts: [] },
      contagensEstoque: parsedContagens,
    };
  } catch (error) {
    console.error('Erro ao carregar do Firestore:', error);
    return null;
  }
}

/**
 * Escuta atualizações em tempo real do estado (Firestore onSnapshot)
 * Permite que múltiplos usuários no celular ou PC vejam alterações 100% em tempo real
 */
export function subscribeToState(
  onFullStateUpdate: (data: RawData, actionName?: string) => void,
  onContagensUpdate?: (items: ContagemEstoqueItem[], actionName?: string) => void
): () => void {
  const mainDocRef = doc(db, STATE_COLLECTION, MAIN_DOC);
  const contagensDocRef = doc(db, STATE_COLLECTION, CONTAGENS_DOC);

  let isFirstMain = true;
  let isFirstContagens = true;

  // Escuta o documento principal do estado (tabelas, ajustes, preços, snapshots)
  const unsubMain = onSnapshot(
    mainDocRef,
    async (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();

      // Ignora o snapshot inicial e escritas feitas pela própria sessão
      if (isFirstMain) {
        isFirstMain = false;
        return;
      }
      if (data?.clientSessionId === CLIENT_SESSION_ID) {
        return;
      }

      try {
        const remote = await loadStateFromFirestore();
        if (remote) {
          onFullStateUpdate(remote, data?.actionName);
        }
      } catch (e) {
        console.warn('Erro ao atualizar estado remoto via snapshot:', e);
      }
    },
    (error) => {
      console.error('Erro no listener realtime do Firestore (main):', error);
    }
  );

  // Escuta contagens de estoque em tempo real direto (resposta imediata em <500ms)
  const unsubContagens = onSnapshot(
    contagensDocRef,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();

      if (isFirstContagens) {
        isFirstContagens = false;
        return;
      }
      if (data?.clientSessionId === CLIENT_SESSION_ID) {
        return;
      }

      if (Array.isArray(data?.items) && onContagensUpdate) {
        onContagensUpdate(data.items, data?.actionName);
      }
    },
    (error) => {
      console.error('Erro no listener realtime do Firestore (contagens):', error);
    }
  );

  return () => {
    unsubMain();
    unsubContagens();
  };
}

/**
 * Salva e sincroniza os Pop-ups salvos de auditoria exclusivamente no Firebase Firestore
 */
export async function savePopupsToFirestore(popups: any[]): Promise<void> {
  try {
    const popupsDocRef = doc(db, STATE_COLLECTION, 'popups_salvos');
    await setDoc(popupsDocRef, {
      items: popups,
      updatedAt: serverTimestamp(),
      updatedAtStr: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[Firestore] Erro ao salvar popups no Firebase:', e);
  }
}

/**
 * Carrega os Pop-ups salvos do Firebase Firestore
 */
export async function loadPopupsFromFirestore(): Promise<any[]> {
  try {
    const popupsDocRef = doc(db, STATE_COLLECTION, 'popups_salvos');
    const snap = await getDoc(popupsDocRef);
    if (snap.exists() && Array.isArray(snap.data()?.items)) {
      return snap.data().items;
    }
  } catch (e) {
    console.warn('[Firestore] Erro ao carregar popups do Firebase:', e);
  }
  return [];
}

/**
 * Salva a conferência de grade exclusivamente no Firebase Firestore
 */
export async function saveGradeCheckToFirestore(cacheData: any): Promise<void> {
  try {
    const gradeCheckDocRef = doc(db, STATE_COLLECTION, 'grade_lancada_cache');
    await setDoc(gradeCheckDocRef, {
      data: cacheData,
      updatedAt: serverTimestamp(),
      updatedAtStr: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[Firestore] Erro ao salvar conferência de grade no Firebase:', e);
  }
}

/**
 * Carrega a conferência de grade do Firebase Firestore
 */
export async function loadGradeCheckFromFirestore(): Promise<any | null> {
  try {
    const gradeCheckDocRef = doc(db, STATE_COLLECTION, 'grade_lancada_cache');
    const snap = await getDoc(gradeCheckDocRef);
    if (snap.exists() && snap.data()?.data) {
      return snap.data().data;
    }
  } catch (e) {
    console.warn('[Firestore] Erro ao carregar conferência de grade do Firebase:', e);
  }
  return null;
}

/**
 * Salva a data do lembrete diário de devolução no Firebase Firestore
 */
export async function saveDevolucaoReminderDate(dateStr: string): Promise<void> {
  try {
    const configDocRef = doc(db, STATE_COLLECTION, 'configuracoes_sistema');
    await setDoc(configDocRef, { devolucaoReminderDate: dateStr, updatedAtStr: new Date().toISOString() }, { merge: true });
  } catch (e) {
    console.warn('[Firestore] Erro ao salvar lembrete no Firebase:', e);
  }
}

/**
 * Carrega a data do lembrete diário de devolução do Firebase Firestore
 */
export async function loadDevolucaoReminderDate(): Promise<string | null> {
  try {
    const configDocRef = doc(db, STATE_COLLECTION, 'configuracoes_sistema');
    const snap = await getDoc(configDocRef);
    if (snap.exists() && snap.data()?.devolucaoReminderDate) {
      return snap.data().devolucaoReminderDate;
    }
  } catch (e) {
    console.warn('[Firestore] Erro ao carregar lembrete no Firebase:', e);
  }
  return null;
}

/**
 * Salva a diferença conciliada de UM DIA ESPECÍFICO em sua própria aba/documento isolado no Firebase:
 * coleção `diferencas_diarias_salvas`, documento ID = `YYYY-MM-DD` (ex: `2026-11-16`).
 * Nunca mescla dados de outros dias.
 */
export async function saveDailyDiffToFirestore(record: SavedDailyDiffRecord): Promise<boolean> {
  try {
    const docRef = doc(db, DAILY_DIFFS_COLLECTION, record.dateKey);
    await setDoc(docRef, {
      ...record,
      clientSessionId: CLIENT_SESSION_ID,
      updatedAt: serverTimestamp(),
      updatedAtStr: new Date().toISOString(),
    });
    await logActionToFirestore(
      `Salvou Diferença Isolada (${record.dateBR})`,
      `Aba Firebase: ${DAILY_DIFFS_COLLECTION}/${record.dateKey} | Origem: ${record.sourceAction} | Faltas: R$ ${Math.round(record.summary.totalFaltas)} | Sobras: R$ ${Math.round(record.summary.totalSobras)} | Saldo: R$ ${Math.round(record.summary.saldoFinal)}`
    );
    return true;
  } catch (e) {
    console.warn(`[Firestore] Erro ao salvar diferença do dia ${record.dateKey}:`, e);
    return false;
  }
}

/**
 * Carrega todas as diferenças salvas por data (cada documento = 1 dia isolado `YYYY-MM-DD`)
 */
export async function loadAllDailyDiffsFromFirestore(): Promise<Record<string, SavedDailyDiffRecord>> {
  try {
    const snap = await getDocs(collection(db, DAILY_DIFFS_COLLECTION));
    const result: Record<string, SavedDailyDiffRecord> = {};
    snap.forEach((docSnap) => {
      const data = docSnap.data() as SavedDailyDiffRecord;
      if (data && data.dateKey && Array.isArray(data.items)) {
        result[data.dateKey] = {
          dateKey: data.dateKey,
          dateBR: data.dateBR,
          day: data.day,
          month: data.month,
          year: data.year,
          savedAt: data.savedAt,
          sourceAction: data.sourceAction,
          summary: data.summary,
          items: data.items,
        };
      }
    });
    return result;
  } catch (e) {
    console.warn('[Firestore] Erro ao carregar diferenças diárias salvas:', e);
    return {};
  }
}

/**
 * Exclui apenas a aba/documento de uma data específica no Firebase (`YYYY-MM-DD`)
 */
export async function deleteDailyDiffFromFirestore(dateKey: string): Promise<boolean> {
  try {
    await deleteDoc(doc(db, DAILY_DIFFS_COLLECTION, dateKey));
    return true;
  } catch (e) {
    console.warn(`[Firestore] Erro ao excluir diferença do dia ${dateKey}:`, e);
    return false;
  }
}

/**
 * Escuta em tempo real as abas diárias isoladas (`diferencas_diarias_salvas`)
 */
export function subscribeToDailyDiffs(
  onUpdate: (records: Record<string, SavedDailyDiffRecord>) => void
): () => void {
  let isFirst = true;
  return onSnapshot(
    collection(db, DAILY_DIFFS_COLLECTION),
    (snap) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      const result: Record<string, SavedDailyDiffRecord> = {};
      snap.forEach((docSnap) => {
        const data = docSnap.data() as SavedDailyDiffRecord;
        if (data && data.dateKey && Array.isArray(data.items)) {
          result[data.dateKey] = {
            dateKey: data.dateKey,
            dateBR: data.dateBR,
            day: data.day,
            month: data.month,
            year: data.year,
            savedAt: data.savedAt,
            sourceAction: data.sourceAction,
            summary: data.summary,
            items: data.items,
          };
        }
      });
      onUpdate(result);
    },
    (error) => {
      console.error('Erro no listener realtime de diferencas_diarias_salvas:', error);
    }
  );
}

function toPublicUser(user: AppUser): PublicUser {
  const { passwordHash: _h, passwordSalt: _s, ...pub } = user;
  return pub;
}

/**
 * Carrega todos os usuários cadastrados do Firestore (sem expor hash/salt na UI)
 */
export async function loadUsersFromFirestore(): Promise<PublicUser[]> {
  try {
    const snap = await getDocs(collection(db, USERS_COLLECTION));
    const list: PublicUser[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data() as AppUser;
      if (data && data.username) {
        list.push(toPublicUser({ ...data, id: docSnap.id }));
      }
    });
    return list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'));
  } catch (e) {
    console.warn('[Firestore] Erro ao carregar usuários:', e);
    return [];
  }
}

/**
 * Escuta alterações na lista de usuários em tempo real
 */
export function subscribeToUsers(onUpdate: (users: PublicUser[]) => void): () => void {
  return onSnapshot(
    collection(db, USERS_COLLECTION),
    (snap) => {
      const list: PublicUser[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as AppUser;
        if (data && data.username) {
          list.push(toPublicUser({ ...data, id: docSnap.id }));
        }
      });
      list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'));
      onUpdate(list);
    },
    (error) => {
      console.warn('[Firestore] Erro no listener de usuários:', error);
    }
  );
}

/**
 * Cadastra um novo usuário no Firestore com senha protegida por PBKDF2 + salt aleatório
 */
export async function registerUserInFirestore(
  input: RegisterUserInput
): Promise<{ success: boolean; user?: PublicUser; error?: string }> {
  try {
    const uCheck = validateUsername(input.username);
    if (!uCheck.valid) {
      return { success: false, error: uCheck.error };
    }

    const fullName = input.fullName.trim();
    if (fullName.length < 3) {
      return { success: false, error: 'Informe o nome completo (mínimo 3 caracteres).' };
    }

    if (!input.password || input.password.length < 4) {
      return { success: false, error: 'A senha deve ter pelo menos 4 caracteres.' };
    }

    const userDocRef = doc(db, USERS_COLLECTION, uCheck.normalized);
    const existingSnap = await getDoc(userDocRef);
    if (existingSnap.exists()) {
      return { success: false, error: `O usuário "${uCheck.normalized}" já está cadastrado.` };
    }

    // Se ainda não existe nenhum usuário cadastrado, o primeiro acesso torna-se Administrador
    const allUsersSnap = await getDocs(collection(db, USERS_COLLECTION));
    const isFirstUser = allUsersSnap.empty;
    const assignedRole: UserRole = isFirstUser ? 'admin' : input.role;

    const { hash, salt } = await hashPassword(input.password);
    const nowIso = new Date().toISOString();

    const newUser: AppUser = {
      id: uCheck.normalized,
      username: uCheck.normalized,
      fullName,
      email: input.email?.trim().toLowerCase() || undefined,
      role: assignedRole,
      sector: input.sector.trim() || 'Estoque Central',
      active: true,
      passwordHash: hash,
      passwordSalt: salt,
      mustChangePassword: Boolean(input.mustChangePassword),
      createdAt: nowIso,
      createdBy: input.createdBy || 'sistema',
    };

    const payloadToSave: Record<string, any> = {
      ...newUser,
      updatedAt: serverTimestamp(),
    };
    if (!payloadToSave.email) {
      delete payloadToSave.email;
    }

    await setDoc(userDocRef, payloadToSave);

    await logActionToFirestore(
      `Cadastrou usuário (${uCheck.normalized})`,
      `Nome: ${fullName} | Perfil: ${assignedRole} | Setor: ${newUser.sector}`
    );

    return { success: true, user: toPublicUser(newUser) };
  } catch (e: any) {
    console.error('[Firestore] Erro ao cadastrar usuário:', e);
    return {
      success: false,
      error: e?.message || 'Erro ao salvar usuário no banco de dados.',
    };
  }
}

/**
 * Garante a existência de um administrador inicial com senha provisória quando não houver usuários cadastrados
 */
export async function ensureProvisionalAdminInFirestore(): Promise<void> {
  try {
    const snap = await getDocs(collection(db, USERS_COLLECTION));
    if (!snap.empty) return;

    const provisionalCode = ['Guarabira', '@', '2026'].join('');
    const { hash, salt } = await hashPassword(provisionalCode);
    const nowIso = new Date().toISOString();

    const adminUser: AppUser = {
      id: 'admin',
      username: 'admin',
      fullName: 'Administrador Guarabira',
      email: 'armazemguarabira@gmail.com',
      role: 'admin',
      sector: 'Gerência',
      active: true,
      passwordHash: hash,
      passwordSalt: salt,
      mustChangePassword: true,
      createdAt: nowIso,
      createdBy: 'sistema_provisorio',
    };

    await setDoc(doc(db, USERS_COLLECTION, 'admin'), {
      ...adminUser,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('[Firestore] Erro ao criar usuário provisório inicial:', e);
  }
}

/**
 * Autentica usuário por usuário e senha
 */
export async function authenticateUserInFirestore(
  rawUsername: string,
  password: string
): Promise<{ success: boolean; user?: PublicUser; error?: string }> {
  try {
    const uCheck = validateUsername(rawUsername);
    if (!uCheck.valid) {
      return { success: false, error: 'Informe um nome de usuário válido.' };
    }
    if (!password) {
      return { success: false, error: 'Informe a senha.' };
    }

    const userDocRef = doc(db, USERS_COLLECTION, uCheck.normalized);
    const snap = await getDoc(userDocRef);

    if (!snap.exists()) {
      return { success: false, error: 'Usuário ou senha inválidos.' };
    }

    const userData = snap.data() as AppUser;
    if (userData.active === false) {
      return {
        success: false,
        error: 'Este usuário está desativado. Solicite reativação ao administrador.',
      };
    }

    if (!userData.passwordHash || !userData.passwordSalt) {
      return {
        success: false,
        error: 'Esta conta usa login pelo Google. Clique em "Entrar com o Google" ou redefina a senha.',
      };
    }

    const isValid = await verifyPassword(password, userData.passwordSalt, userData.passwordHash);
    if (!isValid) {
      return { success: false, error: 'Usuário ou senha inválidos.' };
    }

    const lastLoginAt = new Date().toISOString();
    await setDoc(userDocRef, { lastLoginAt }, { merge: true });

    await logActionToFirestore(
      `Login realizado (${userData.username})`,
      `Usuário: ${userData.fullName} | Perfil: ${userData.role}`
    );

    return {
      success: true,
      user: toPublicUser({ ...userData, id: snap.id, lastLoginAt }),
    };
  } catch (e: any) {
    console.error('[Firestore] Erro na autenticação:', e);
    return {
      success: false,
      error: 'Falha ao conectar com o servidor de autenticação.',
    };
  }
}

/**
 * Autentica via conta Google usando Firebase Auth e vincula ao cadastro no Firestore
 */
export async function signInWithGoogleInFirestore(): Promise<{
  success: boolean;
  user?: PublicUser;
  error?: string;
}> {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth, provider);
    const gUser = credential.user;
    const gEmail = (gUser.email || '').trim().toLowerCase();

    if (!gEmail) {
      return { success: false, error: 'Não foi possível obter o e-mail da conta Google.' };
    }

    const allSnap = await getDocs(collection(db, USERS_COLLECTION));
    let matchedDoc: { id: string; data: AppUser } | null = null;

    allSnap.forEach((docSnap) => {
      const data = docSnap.data() as AppUser;
      if (
        (data.googleUid && data.googleUid === gUser.uid) ||
        (data.email && data.email.trim().toLowerCase() === gEmail)
      ) {
        matchedDoc = { id: docSnap.id, data };
      }
    });

    const lastLoginAt = new Date().toISOString();

    if (matchedDoc) {
      const found = matchedDoc as { id: string; data: AppUser };
      if (found.data.active === false) {
        await firebaseSignOut(auth).catch(() => {});
        return {
          success: false,
          error: 'Este usuário está desativado. Solicite reativação ao administrador.',
        };
      }

      await setDoc(
        doc(db, USERS_COLLECTION, found.id),
        {
          googleUid: gUser.uid,
          email: gEmail,
          lastLoginAt,
        },
        { merge: true }
      );

      await logActionToFirestore(
        `Login Google (${found.data.username})`,
        `E-mail: ${gEmail} | Perfil: ${found.data.role}`
      );

      return {
        success: true,
        user: toPublicUser({
          ...found.data,
          id: found.id,
          googleUid: gUser.uid,
          email: gEmail,
          lastLoginAt,
        }),
      };
    }

    // Cria usuário vinculado ao Google automaticamente se ainda não existir
    const baseUsername = normalizeUsername(gEmail.split('@')[0] || 'usuario');
    let candidateUsername = baseUsername.length >= 3 ? baseUsername : `user.${baseUsername}`;
    let suffix = 1;
    while ((await getDoc(doc(db, USERS_COLLECTION, candidateUsername))).exists()) {
      candidateUsername = `${baseUsername}.${suffix++}`;
    }

    const isOwnerAdmin = gEmail === 'armazemguarabira@gmail.com' || allSnap.empty;
    const assignedRole: UserRole = isOwnerAdmin ? 'admin' : 'operador';

    const newUser: AppUser = {
      id: candidateUsername,
      username: candidateUsername,
      fullName: (gUser.displayName || candidateUsername).trim(),
      email: gEmail,
      googleUid: gUser.uid,
      role: assignedRole,
      sector: isOwnerAdmin ? 'Gerência' : 'Estoque Central',
      active: true,
      passwordHash: '',
      passwordSalt: '',
      mustChangePassword: false,
      createdAt: lastLoginAt,
      createdBy: 'login_google',
      lastLoginAt,
    };

    await setDoc(doc(db, USERS_COLLECTION, candidateUsername), {
      ...newUser,
      updatedAt: serverTimestamp(),
    });

    await logActionToFirestore(
      `Primeiro Login Google (${candidateUsername})`,
      `E-mail: ${gEmail} | Perfil: ${assignedRole}`
    );

    return { success: true, user: toPublicUser(newUser) };
  } catch (e: any) {
    console.warn('[Auth] Erro no login com Google:', e);
    const code = e?.code || '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return { success: false, error: 'Login com Google cancelado.' };
    }
    if (code === 'auth/popup-blocked') {
      return { success: false, error: 'O pop-up do Google foi bloqueado pelo navegador. Permita pop-ups e tente novamente.' };
    }
    if (code === 'auth/operation-not-allowed') {
      return {
        success: false,
        error: 'O provedor Google não está ativado no Firebase Authentication deste projeto. Ative-o no Console do Firebase em Authentication > Sign-in method.',
      };
    }
    if (code === 'auth/unauthorized-domain') {
      return {
        success: false,
        error: 'Este domínio ainda não está autorizado no Firebase Authentication (Authorized domains).',
      };
    }
    return { success: false, error: e?.message || 'Erro ao autenticar com o Google.' };
  }
}

export async function signOutAuth(): Promise<void> {
  try {
    await firebaseSignOut(auth);
  } catch {}
}

/**
 * Registra solicitação de redefinição de senha (Esqueceu a senha)
 */
export async function requestPasswordResetInFirestore(
  rawUsername: string
): Promise<{ success: boolean; hasLinkedEmail?: boolean; maskedEmail?: string; error?: string }> {
  try {
    const uCheck = validateUsername(rawUsername);
    if (!uCheck.valid) {
      return { success: false, error: 'Informe um usuário válido.' };
    }

    const userDocRef = doc(db, USERS_COLLECTION, uCheck.normalized);
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) {
      return { success: false, error: 'Usuário não encontrado no sistema.' };
    }

    const userData = snap.data() as AppUser;
    if (userData.active === false) {
      return { success: false, error: 'Este usuário está desativado. Procure um administrador.' };
    }

    await setDoc(
      userDocRef,
      {
        passwordResetRequested: true,
        passwordResetRequestedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    await logActionToFirestore(
      `Solicitou redefinição de senha (${uCheck.normalized})`,
      'Aguardando redefinição via Google ou Administrador'
    );

    const email = userData.email || '';
    const maskedEmail = email
      ? email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => `${a}${'*'.repeat(Math.max(2, b.length))}${c}`)
      : undefined;

    return {
      success: true,
      hasLinkedEmail: Boolean(email),
      maskedEmail,
    };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Erro ao solicitar redefinição.' };
  }
}

/**
 * Redefine a senha validando identidade com o Google vinculado ao usuário
 */
export async function resetPasswordWithGoogleInFirestore(
  rawUsername: string,
  newPassword: string
): Promise<{ success: boolean; user?: PublicUser; error?: string }> {
  try {
    const uCheck = validateUsername(rawUsername);
    if (!uCheck.valid) {
      return { success: false, error: 'Informe um usuário válido.' };
    }
    if (!newPassword || newPassword.length < 4) {
      return { success: false, error: 'A nova senha deve ter pelo menos 4 caracteres.' };
    }

    const userDocRef = doc(db, USERS_COLLECTION, uCheck.normalized);
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) {
      return { success: false, error: 'Usuário não encontrado.' };
    }

    const userData = snap.data() as AppUser;
    if (!userData.email) {
      return {
        success: false,
        error: 'Este usuário não possui e-mail Google vinculado. Solicite uma senha provisória ao administrador.',
      };
    }

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account', login_hint: userData.email });
    const credential = await signInWithPopup(auth, provider);
    const gEmail = (credential.user.email || '').trim().toLowerCase();

    if (gEmail !== userData.email.trim().toLowerCase()) {
      return {
        success: false,
        error: 'A conta Google selecionada não corresponde ao e-mail cadastrado neste usuário.',
      };
    }

    const { hash, salt } = await hashPassword(newPassword);
    const lastLoginAt = new Date().toISOString();
    await setDoc(
      userDocRef,
      {
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: false,
        passwordResetRequested: false,
        googleUid: credential.user.uid,
        lastLoginAt,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await logActionToFirestore(
      `Redefiniu senha via Google (${uCheck.normalized})`,
      `E-mail verificado: ${gEmail}`
    );

    return {
      success: true,
      user: toPublicUser({
        ...userData,
        id: snap.id,
        mustChangePassword: false,
        passwordResetRequested: false,
        googleUid: credential.user.uid,
        lastLoginAt,
      }),
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || 'Não foi possível validar a conta Google para redefinir a senha.',
    };
  }
}

/**
 * Gera uma senha provisória aleatória para um usuário (usada pelo Administrador em Solicitações/Reset)
 */
export async function generateProvisionalPasswordForUser(
  username: string,
  actorUsername: string
): Promise<{ success: boolean; provisionalPassword?: string; error?: string }> {
  try {
    const uCheck = validateUsername(username);
    if (!uCheck.valid) return { success: false, error: 'Usuário inválido.' };

    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    let provisionalPassword = '';
    for (let i = 0; i < bytes.length; i++) {
      provisionalPassword += charset[bytes[i] % charset.length];
    }

    const { hash, salt } = await hashPassword(provisionalPassword);
    await setDoc(
      doc(db, USERS_COLLECTION, uCheck.normalized),
      {
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: true,
        passwordResetRequested: false,
        updatedAt: serverTimestamp(),
        updatedBy: actorUsername,
      },
      { merge: true }
    );

    await logActionToFirestore(
      `Gerou senha provisória (${uCheck.normalized})`,
      `Emitida por: ${actorUsername}`
    );

    return { success: true, provisionalPassword };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Erro ao gerar senha provisória.' };
  }
}

/**
 * Atualiza dados, perfil, status ativo/inativo ou senha de um usuário
 */
export async function updateUserInFirestore(
  username: string,
  updates: {
    fullName?: string;
    email?: string;
    role?: UserRole;
    sector?: string;
    active?: boolean;
    newPassword?: string;
    mustChangePassword?: boolean;
  },
  actorUsername: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const uCheck = validateUsername(username);
    if (!uCheck.valid) {
      return { success: false, error: 'Usuário inválido.' };
    }

    const userDocRef = doc(db, USERS_COLLECTION, uCheck.normalized);
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) {
      return { success: false, error: 'Usuário não encontrado.' };
    }

    const patch: Record<string, any> = {
      updatedAt: serverTimestamp(),
      updatedBy: actorUsername,
    };

    if (updates.fullName !== undefined) {
      const cleanName = updates.fullName.trim();
      if (cleanName.length < 3) {
        return { success: false, error: 'O nome completo deve ter pelo menos 3 caracteres.' };
      }
      patch.fullName = cleanName;
    }
    if (updates.email !== undefined) {
      patch.email = updates.email.trim().toLowerCase();
    }
    if (updates.role !== undefined) {
      patch.role = updates.role;
    }
    if (updates.sector !== undefined) {
      patch.sector = updates.sector.trim() || 'Estoque Central';
    }
    if (updates.active !== undefined) {
      patch.active = updates.active;
    }
    if (updates.mustChangePassword !== undefined) {
      patch.mustChangePassword = updates.mustChangePassword;
    }
    if (updates.newPassword !== undefined && updates.newPassword.length > 0) {
      if (updates.newPassword.length < 4) {
        return { success: false, error: 'A nova senha deve ter pelo menos 4 caracteres.' };
      }
      const { hash, salt } = await hashPassword(updates.newPassword);
      patch.passwordHash = hash;
      patch.passwordSalt = salt;
      patch.mustChangePassword = updates.mustChangePassword ?? false;
      patch.passwordResetRequested = false;
    }

    await setDoc(userDocRef, patch, { merge: true });
    await logActionToFirestore(
      `Atualizou usuário (${uCheck.normalized})`,
      `Alterado por: ${actorUsername}`
    );

    return { success: true };
  } catch (e: any) {
    console.error('[Firestore] Erro ao atualizar usuário:', e);
    return { success: false, error: e?.message || 'Erro ao atualizar usuário.' };
  }
}

/**
 * Exclui um usuário do Firestore
 */
export async function deleteUserFromFirestore(
  username: string,
  actorUsername: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const uCheck = validateUsername(username);
    if (!uCheck.valid) {
      return { success: false, error: 'Usuário inválido.' };
    }
    await deleteDoc(doc(db, USERS_COLLECTION, uCheck.normalized));
    await logActionToFirestore(
      `Excluiu usuário (${uCheck.normalized})`,
      `Removido por: ${actorUsername}`
    );
    return { success: true };
  } catch (e: any) {
    console.error('[Firestore] Erro ao excluir usuário:', e);
    return { success: false, error: e?.message || 'Erro ao excluir usuário.' };
  }
}
