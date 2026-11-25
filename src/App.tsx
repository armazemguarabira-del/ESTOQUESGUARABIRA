/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { RawData, ResRow, AjustesData, MenRow, DiaRow, DashboardSnapshot, EstoqueCentralData, SavedPopupItem, SavedDailyDiffRecord, SavedDailyDiffItem, CalculatedProduct } from './data/types';
import { PublicUser, USER_ROLE_LABELS } from './types/auth';
import { initialRawData, cervegelasRes, cervegelasMen } from './data/defaultRawData';
import { calculateProducts, CERVEGELA_CODES, sum } from './utils/calc';
import {
  saveStateToFirestore,
  loadStateFromFirestore,
  logActionToFirestore,
  subscribeToState,
  savePopupsToFirestore,
  loadPopupsFromFirestore,
  saveDailyDiffToFirestore,
  loadAllDailyDiffsFromFirestore,
  deleteDailyDiffFromFirestore,
  subscribeToDailyDiffs,
  computeEcContentHash,
  loadUsersFromFirestore,
  subscribeToUsers,
  ensureProvisionalAdminInFirestore,
  signOutAuth,
  updateUserInFirestore,
} from './firebase';
import { process020502, parseColL, syncEcWithDashboard, isResOutOfSyncWithEc, splitDelimitedLine } from './utils/importer020502';
import { process020304 } from './utils/importer020304';
import { processTabelaPrecos } from './utils/importerPrecos';
// Snapshot storage removed

// Views
import { ResumoView } from './components/ResumoView';
import { AjustesView } from './components/AjustesView';
import { DifDiariaView } from './components/DifDiariaView';
import { DifMensalView } from './components/DifMensalView';
import { EstoqueCentralView } from './components/EstoqueCentralView';
import { DashboardView } from './components/DashboardView';
import { RecontagemView } from './components/RecontagemView';
import { createRecontagemFromProduct } from './data/defaultRecontagens';
import { RecontagemItem, ContagemEstoqueItem } from './data/types';
import { consolidateContagens, getItemDateString, mergeContagemItems } from './utils/contagemUtils';

// Modals
import { Import020502Modal } from './components/Import020502Modal';
import { ImportPrecosModal } from './components/ImportPrecosModal';
import { LogsModal } from './components/LogsModal';
import { Modal } from './components/Modal';
import { SalvarDifModal } from './components/SalvarDifModal';
import { PasswordModal } from './components/PasswordModal';
import { EvolucaoDiariaView } from './components/EvolucaoDiariaView';
import { ProdutosView } from './components/ProdutosView';
import { PopupsSalvosView } from './components/PopupsSalvosView';
import { ExportGradeView } from './components/ExportGradeView';
import { CheckLancamentoGradeView } from './components/CheckLancamentoGradeView';
import { LoginScreen } from './components/LoginScreen';
import { CadastroUsuariosView } from './components/CadastroUsuariosView';

type TabKey = 'dashboard' | 'popups_salvos' | 'export_grade' | 'check_grade' | 'resumo' | 'ajustes' | 'dif_diaria' | 'dif_mensal' | 'ec' | 'recontagem' | 'produtos' | 'usuarios';

export default function App() {
  // Autenticação e usuários cadastrados no Firebase
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [usersList, setUsersList] = useState<PublicUser[]>([]);
  const [dismissedProvisionalPrompt, setDismissedProvisionalPrompt] = useState(false);
  const [provisionalNewPass, setProvisionalNewPass] = useState('');
  const [provisionalConfirmPass, setProvisionalConfirmPass] = useState('');
  const [provisionalPassError, setProvisionalPassError] = useState<string | null>(null);
  const [savingProvisionalPass, setSavingProvisionalPass] = useState(false);

  // Estado centralizado e persistido 100% no Firebase Firestore
  const [data, setData] = useState<RawData>(initialRawData);

  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [history, setHistory] = useState<{ data: RawData; desc: string }[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Pop-ups Salvos para Auditoria persistidos exclusivamente no Firestore
  const [savedPopups, setSavedPopups] = useState<SavedPopupItem[]>([]);

  // Diferenças Diárias Salvas em abas 100% isoladas por data no Firebase (diferencas_diarias_salvas/{YYYY-MM-DD})
  const [savedDailyDiffs, setSavedDailyDiffs] = useState<Record<string, SavedDailyDiffRecord>>({});

  const handleSavePopup = (item: SavedPopupItem) => {
    setSavedPopups((prev) => {
      const existingIndex = prev.findIndex((p) => p.code === item.code && p.isFalta === item.isFalta);
      let next: SavedPopupItem[];
      if (existingIndex >= 0) {
        next = [...prev];
        next[existingIndex] = item;
        setToastMessage(`✓ Pop-up de [${item.code}] ${item.desc} atualizado na aba POP-UPS SALVOS!`);
      } else {
        next = [item, ...prev];
        setToastMessage(`✓ Pop-up de [${item.code}] ${item.desc} salvo na aba POP-UPS SALVOS!`);
      }
      savePopupsToFirestore(next);
      return next;
    });
  };

  const handleRemoveSavedPopup = (id: string) => {
    setSavedPopups((prev) => {
      const next = prev.filter((p) => p.id !== id);
      savePopupsToFirestore(next);
      return next;
    });
    setToastMessage(`Item removido dos Pop-ups Salvos.`);
  };

  const handleClearSavedPopups = () => {
    setSavedPopups([]);
    savePopupsToFirestore([]);
    setToastMessage(`Todos os Pop-ups Salvos foram limpos.`);
  };

  // Modais e Banners
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportPrecosModalOpen, setIsImportPrecosModalOpen] = useState(false);
  const [importTargetTab, setImportTargetTab] = useState<'dashboard' | 'ec' | 'grade'>('ec');
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [isSalvarDifModalOpen, setIsSalvarDifModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [protectedAction, setProtectedAction] = useState<(() => void) | null>(null);
  const [produtosInitialQuery, setProdutosInitialQuery] = useState('');

  const runProtectedAction = (action: () => void) => {
    setProtectedAction(() => action);
    setIsPasswordModalOpen(true);
  };
  const [t7BannerHtml, setT7BannerHtml] = useState<string | null>(null);
  const [ecBannerHtml, setEcBannerHtml] = useState<string | null>(null);
  const [precosBannerHtml, setPrecosBannerHtml] = useState<string | null>(null);
  const [ec0304BannerHtml, setEc0304BannerHtml] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  // Estado de conexão em tempo real com todos os usuários
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);

  // Garante usuário provisório inicial, carrega usuários e escuta alterações em tempo real
  useEffect(() => {
    let mounted = true;
    ensureProvisionalAdminInFirestore().then(() =>
      loadUsersFromFirestore().then((list) => {
        if (!mounted) return;
        setUsersList(list);
      })
    );
    const unsubUsers = subscribeToUsers((list) => {
      if (!mounted) return;
      setUsersList(list);
      setCurrentUser((prev) => {
        if (!prev) return prev;
        const updated = list.find((u) => u.username === prev.username);
        if (!updated || updated.active === false) {
          return null;
        }
        return updated;
      });
    });
    return () => {
      mounted = false;
      unsubUsers();
    };
  }, []);

  // Carrega do Firestore ao iniciar e escuta alterações em tempo real (100% real-time para todos os usuários)
  useEffect(() => {
    let isMounted = true;

    async function initFirestore() {
      const [remote, popups, dailyDiffs] = await Promise.all([
        loadStateFromFirestore(),
        loadPopupsFromFirestore(),
        loadAllDailyDiffsFromFirestore(),
      ]);
      if (remote && isMounted) {
        let syncedRemote = remote;
        if (isResOutOfSyncWithEc(remote)) {
          const syncRes = syncEcWithDashboard(remote);
          if (syncRes.success && syncRes.nextData) {
            syncedRemote = syncRes.nextData;
            saveStateToFirestore(syncedRemote, 'Auto-sincronização com Estoque Central (02.05.02)');
          }
        }
        setData(syncedRemote);
        setIsRealtimeActive(true);
      }
      if (Array.isArray(popups) && isMounted) {
        setSavedPopups(popups);
      }
      if (dailyDiffs && isMounted) {
        setSavedDailyDiffs(dailyDiffs);
      }
    }
    initFirestore();

    const unsubscribe = subscribeToState(
      (remoteData, action) => {
        if (!isMounted) return;
        let syncedRemote = remoteData;
        if (isResOutOfSyncWithEc(remoteData)) {
          const syncRes = syncEcWithDashboard(remoteData);
          if (syncRes.success && syncRes.nextData) {
            syncedRemote = syncRes.nextData;
          }
        }
        setData(syncedRemote);
        setIsRealtimeActive(true);
        if (action) {
          setToastMessage(`⚡ Sincronizado em tempo real: ${action}`);
        }
      },
      (contagensItems, action) => {
        if (!isMounted) return;
        setData((prev) => ({
          ...prev,
          contagensEstoque: consolidateContagens(contagensItems),
        }));
        setIsRealtimeActive(true);
        if (action) {
          setToastMessage(`⚡ Contagem atualizada por outro usuário (${action})`);
        }
      }
    );

    const unsubscribeDailyDiffs = subscribeToDailyDiffs((records) => {
      if (!isMounted) return;
      setSavedDailyDiffs(records);
    });

    return () => {
      isMounted = false;
      unsubscribe();
      unsubscribeDailyDiffs();
    };
  }, []);

  // Push para histórico (separa o estado anterior como ponto 0 para permitir desfazer já na 1ª alteração)
  const pushHistory = (newData: RawData, description: string, baseData: RawData = data) => {
    const baseHistory =
      history.length === 0 || historyIndex < 0
        ? [{ data: baseData, desc: 'Estado Inicial' }]
        : history.slice(0, historyIndex + 1);
    const nextHistory = [...baseHistory, { data: newData, desc: description }].slice(-25);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  };

  const updateDataWithHistory = (newData: RawData, description: string) => {
    pushHistory(newData, description, data);
    setData(newData);
    saveStateToFirestore(newData, description);
  };

  // Cálculo reativo dos produtos para Dashboard e Resumo
  const { C: calculatedProducts, CM: calculatedMap } = useMemo(() => {
    return calculateProducts(data);
  }, [data]);

  // Cálculo reativo 100% independente dos produtos para a GRADE
  const { C: gradeCalculatedProducts, CM: gradeCalculatedMap } = useMemo(() => {
    const gradeData: RawData = {
      ...data,
      res: data.gradeRes || data.res,
    };
    return calculateProducts(gradeData);
  }, [data.gradeRes, data.res, data.aj, data.xs, data.dia, data.men]);

  // Atualização de uma célula do Resumo (Disponível G ou Inventário J) por código do produto
  const handleUpdateRes = (code: number, key: 'G' | 'J', value: number) => {
    const index = data.res.findIndex((r) => r[0] === code);
    if (index < 0) return;

    const newRes = [...data.res];
    const row = [...newRes[index]] as ResRow;
    const colIndex = key === 'G' ? 3 : 7;
    const oldVal = row[colIndex];

    let nextRawVal = value;
    if (key === 'J') {
      const calc = calculatedMap[code];
      const adjOffset = calc ? (calc.N - calc.M + calc.P + calc.O) : 0;
      nextRawVal = value - adjOffset;
    }
    if (oldVal === nextRawVal) return;

    row[colIndex] = nextRawVal;
    newRes[index] = row;

    const desc = `Alterou ${key === 'G' ? 'Disponível Promax' : 'Inventário'} do item ${row[0]} (${row[1]}) de ${oldVal} para ${nextRawVal}`;
    const nextData: RawData = {
      ...data,
      res: newRes,
      gradeRes: data.gradeRes ? newRes.map((r) => [...r] as ResRow) : undefined,
      ecSyncHash: data.ec?.r?.length ? computeEcContentHash(data.ec) : data.ecSyncHash,
    };
    updateDataWithHistory(nextData, desc);
  };

  // Atualização dos Ajustes
  const handleUpdateAjustes = (newAj: AjustesData) => {
    const nextData = { ...data, aj: newAj };
    updateDataWithHistory(nextData, 'Atualização nas tabelas de ajustes');
  };

  // Abertura do modal de importação centralizado em Estoque Central
  const handleOpenImportModalForTab = (tab: 'dashboard' | 'ec' | 'grade' = 'ec') => {
    setImportTargetTab('ec');
    setIsImportModalOpen(true);
  };

  // Salvamento diário isolado no Firebase (diferencas_diarias_salvas/{YYYY-MM-DD}) acionado pelo modal SALVAR 02.05.02 DO DIA
  const handleSaveSnapshot = async (snapshot: DashboardSnapshot) => {
    const targetDateKey = snapshot.date || getLocalDateKey();
    const [yearStr, monthStr, dayStr] = targetDateKey.split('-');
    const targetYear = Number(yearStr);
    const targetMonth = Number(monthStr);
    const targetDay = Number(dayStr);
    const dayIndex = targetDay - 1;

    const now = new Date();
    const isCurrentActiveMonth =
      targetYear === now.getFullYear() && targetMonth === now.getMonth() + 1;

    const existingAction = savedDailyDiffs[targetDateKey]?.sourceAction;
    const sourceActionToSave: 'CONGELAR' | 'SALVAR_DIF' =
      existingAction === 'CONGELAR' ? 'CONGELAR' : 'SALVAR_DIF';

    const isolatedRecord = buildIsolatedDailyDiffRecord(
      targetDateKey,
      calculatedProducts,
      data.xs,
      data.desativados || [],
      sourceActionToSave
    );

    const okDaily = await saveDailyDiffToFirestore(isolatedRecord);
    const updatedDiffs = { ...savedDailyDiffs, [targetDateKey]: isolatedRecord };
    setSavedDailyDiffs(updatedDiffs);

    let newMen = data.men;
    if (isCurrentActiveMonth && dayIndex >= 0 && dayIndex < 31) {
      const menMap = new Map<number, number>();
      newMen = data.men.map((row, idx) => {
        menMap.set(row[0], idx);
        return [...row] as MenRow;
      });
      calculatedProducts.forEach((calc) => {
        const code = calc.c;
        const diff = calc.R;
        if (menMap.has(code)) {
          const idx = menMap.get(code)!;
          const row = newMen[idx];
          const days = [...row[4]];
          days[dayIndex] = diff;
          const newTotal = days.reduce<number>((acc, v) => acc + (v || 0), 0);
          newMen[idx] = [row[0], calc.d || row[1], calc.X || row[2], row[3], days, newTotal];
        } else {
          const days: (number | null)[] = new Array(31).fill(null);
          days[dayIndex] = diff;
          newMen.push([calc.c, calc.d, calc.X, 0, days, diff]);
          menMap.set(code, newMen.length - 1);
        }
      });
    }

    const nextData: RawData = {
      ...data,
      men: newMen,
    };
    const actionDesc = `Salvou 02.05.02 e DIF do dia ${isolatedRecord.dateBR} (${snapshot.label || 'Fechamento'})`;
    pushHistory(nextData, actionDesc);
    setData(nextData);
    await saveStateToFirestore(nextData, actionDesc, undefined, true);

    if (okDaily) {
      setToastMessage(`✓ 02.05.02 e fechamento do dia ${isolatedRecord.dateBR} salvos no Firebase!`);
    } else {
      setToastMessage(`⚠️ Falha temporária ao salvar no Firebase para ${isolatedRecord.dateBR}.`);
    }
  };

  // Importação do relatório 02.05.02 (Centralizado na aba de Estoque Central e propagado para toda a plataforma)
  const handleImport020502 = async (
    content: string,
    fileName: string,
    targetTab: 'dashboard' | 'ec' | 'grade' = 'ec',
    autoSaveDailySnapshot: boolean = false
  ) => {
    try {
      const effectiveTarget = targetTab === 'grade' ? 'grade' : 'ec';
      const res = process020502(content, fileName, data, effectiveTarget);
      if (res.success && res.nextData) {
        let finalData = res.nextData;

        if (autoSaveDailySnapshot && effectiveTarget !== 'grade') {
          const todayDateKey = getLocalDateKey();
          const newCalcs = calculateProducts(finalData).C;
          const isolatedRecord = buildIsolatedDailyDiffRecord(
            todayDateKey,
            newCalcs,
            finalData.xs,
            finalData.desativados || [],
            'SALVAR_DIF'
          );
          await saveDailyDiffToFirestore(isolatedRecord);
          setSavedDailyDiffs((prev) => ({ ...prev, [todayDateKey]: isolatedRecord }));
        }

        updateDataWithHistory(
          finalData,
          effectiveTarget === 'grade'
            ? `Importação 02.05.02 (Grade): ${fileName}`
            : `Importação 02.05.02 (Estoque Central): ${fileName}`
        );
        setEcBannerHtml(res.bannerHtml || null);
        setIsImportModalOpen(false);
        setToastMessage(
          autoSaveDailySnapshot && effectiveTarget !== 'grade'
            ? `✓ Relatório 02.05.02 importado no Estoque Central e fechamento de hoje salvo no Firebase!`
            : `✓ Relatório 02.05.02 importado com sucesso no Estoque Central!`
        );
      } else {
        setToastMessage(`⚠️ ${res.message || 'Erro ao processar importação 02.05.02'}`);
      }
    } catch (e: any) {
      setToastMessage(`⚠️ Falha ao importar: ${e?.message || e}`);
    }
  };

  // Sincronização manual imediata da 02.05.02 do Estoque Central para o Dashboard e Resumo
  const handleSyncEcWithDashboard = () => {
    const syncRes = syncEcWithDashboard(data);
    if (syncRes.success && syncRes.nextData) {
      updateDataWithHistory(syncRes.nextData, 'Sincronizou Estoque Central (02.05.02) com Dashboard');
      setEcBannerHtml(syncRes.bannerHtml || null);
      setToastMessage('✓ Dashboard e Resumo sincronizados com a 02.05.02 do Estoque Central!');
    } else {
      setToastMessage(`⚠️ ${syncRes.message || 'Não foi possível sincronizar o Estoque Central.'}`);
    }
  };

  // Carrega uma 02.05.02 salva histórica diretamente para o Estoque Central e navega para a aba
  const handleLoadSaved020502ToPlatform = (snapshot: DashboardSnapshot) => {
    if (!snapshot.ec || !snapshot.ec.h || !snapshot.ec.r || snapshot.ec.r.length === 0) {
      setToastMessage('⚠️ Os dados da 02.05.02 desta data não estão disponíveis ou estão vazios.');
      return;
    }

    try {
      const newEc: EstoqueCentralData = {
        h: [...snapshot.ec.h],
        r: snapshot.ec.r.map((row) => [...row]),
      };

      let nextData: RawData;
      if (snapshot.res && Array.isArray(snapshot.res) && snapshot.res.length > 0) {
        nextData = {
          ...data,
          ec: newEc,
          ecSyncHash: computeEcContentHash(newEc),
          res: snapshot.res.map((r) => [...r] as typeof r),
          gradeRes: data.gradeRes ? snapshot.res.map((r) => [...r] as typeof r) : undefined,
        };
      } else {
        const baseWithNewEc: RawData = { ...data, ec: newEc };
        const syncRes = syncEcWithDashboard(baseWithNewEc);
        nextData = syncRes.success && syncRes.nextData ? syncRes.nextData : baseWithNewEc;
      }

      updateDataWithHistory(
        nextData,
        `Carregou 02.05.02 salva do dia ${snapshot.date.split('-').reverse().join('/')} no Estoque Central`
      );

      // Muda para a aba de Estoque Central para visualização imediata
      setActiveTab('ec');
      setToastMessage(
        `✓ 02.05.02 do dia ${snapshot.date.split('-').reverse().join('/')} carregada com sucesso no Estoque Central!`
      );
    } catch (e: any) {
      console.error('Erro ao carregar 02.05.02:', e);
      setToastMessage(`⚠️ Falha ao carregar relatório: ${e?.message || e}`);
    }
  };

  // Importação de Tabela de Preços (Tabela 7) via Estoque Central
  const handleImportPrecos = (content: string, fileName: string) => {
    try {
      const res = processTabelaPrecos(content, fileName, data);
      if (res.success && res.nextData) {
        updateDataWithHistory(
          res.nextData,
          `Importou Tabela de Preços (${fileName}): ${res.matchedCount} produtos atualizados`
        );
        setPrecosBannerHtml(res.bannerHtml || null);
        setIsImportPrecosModalOpen(false);
        setToastMessage(`✓ Tabela de Preços importada (${res.matchedCount} produtos atualizados)!`);
      } else {
        setToastMessage(`⚠️ ${res.message || 'Erro ao processar Tabela de Preços'}`);
      }
    } catch (e: any) {
      setToastMessage(`⚠️ Falha ao importar Tabela de Preços: ${e?.message || e}`);
    }
  };

  // Importação do relatório 02.05.02 específica para a Grade
  const handleGradeImport020502 = (content: string, fileName: string) => {
    try {
      const res = process020502(content, fileName, data, 'grade');
      if (res.success && res.nextData) {
        updateDataWithHistory(
          res.nextData,
          `Importou 02.05.02 para a Grade: ${fileName} (${res.nextData.gradeEc?.r?.length || 0} produtos)`
        );
        setToastMessage(`✓ Relatório 02.05.02 importado com sucesso na Grade!`);
      } else {
        const lines = String(content)
          .replace(/\r/g, '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        if (lines.length < 2) {
          setToastMessage('⚠️ Arquivo 02.05.02 vazio ou sem linhas suficientes.');
          return;
        }
        let sep = ';';
        const firstLines = lines.slice(0, 20).join('\n');
        if ((firstLines.match(/\t/g) || []).length > (firstLines.match(/;/g) || []).length) {
          sep = '\t';
        }
        const body = lines.map((l) => splitDelimitedLine(l, sep));
        const header = body[0];
        const dataRows = body.slice(1);

        const gradeEc = {
          h: header,
          r: dataRows,
        };

        const nextData = {
          ...data,
          gradeEc,
        };

        updateDataWithHistory(nextData, `Importou 02.05.02 para a Grade: ${fileName} (${dataRows.length} itens)`);
        setToastMessage(`✓ Relatório 02.05.02 importado com sucesso na Grade! (${dataRows.length} itens)`);
      }
    } catch (e: any) {
      setToastMessage(`⚠️ Erro ao importar 02.05.02 para a Grade: ${e?.message || e}`);
    }
  };

  // Importação do relatório 02.03.04 específica para a Grade Independente
  const handleGradeImport020304 = (content: string, fileName: string) => {
    try {
      const res = process020304(content, fileName, data);
      if (res.success && res.nextData && res.nextData.ec0304) {
        const nextData = {
          ...data,
          ec0304: res.nextData.ec0304,
        };
        const count = res.matchedCount || res.nextData.ec0304.r.length;
        updateDataWithHistory(nextData, `Importou 02.03.04 para a Grade: ${fileName} (${count} produtos)`);
        setToastMessage(`✓ Relatório 02.03.04 importado: ${count} produtos carregados na coluna Saldo!`);
      } else {
        setToastMessage(`⚠️ ${res.message || 'Erro ao processar importação 02.03.04'}`);
      }
    } catch (e: any) {
      setToastMessage(`⚠️ Falha ao importar 02.03.04 para a Grade: ${e?.message || e}`);
    }
  };

  // Limpar relatório 02.03.04 da Grade
  const handleClearGrade020304 = () => {
    const nextData = {
      ...data,
      ec0304: undefined,
    };
    updateDataWithHistory(nextData, 'Removeu relatório 02.03.04 da Grade (saldo voltou para Tabela 7)');
    setToastMessage('✓ Relatório 02.03.04 removido da Grade. O saldo voltou para a Tabela 7.');
  };

  // Importação de Tabela 7
  const handleImportT7 = (content: string, fileName: string) => {
    try {
      const lines = String(content).replace(/\r/g, '').split('\n');
      let count = 0;
      const newRes = [...data.res];
      const resMap = new Map(newRes.map((r, i) => [r[0], i]));

      lines.forEach((line) => {
        const cleanLine = line.trim();
        if (!cleanLine) return;
        let parts = splitDelimitedLine(cleanLine, '\t');
        if (parts.length < 2) parts = splitDelimitedLine(cleanLine, ';');
        if (parts.length < 2) parts = splitDelimitedLine(cleanLine, ',');

        if (parts.length >= 2) {
          const codStr = parts[0].trim().replace(/\D/g, '');
          const cod = Number(codStr);
          if (!isNaN(cod) && cod > 0) {
            let valStr = parts[1].trim();
            let val = 0;
            if (valStr.includes(',') && valStr.includes('.')) {
              val = parseFloat(valStr.replace(/\./g, '').replace(',', '.')) || 0;
            } else if (valStr.includes(',')) {
              val = parseFloat(valStr.replace(',', '.')) || 0;
            } else {
              val = parseFloat(valStr) || 0;
            }

            if (resMap.has(cod)) {
              const idx = resMap.get(cod)!;
              const row = [...newRes[idx]] as ResRow;
              row[3] = val; // Atualiza Disponível Promax
              newRes[idx] = row;
              count++;
            }
          }
        }
      });

      if (count === 0) {
        setToastMessage(`⚠️ Nenhum produto correspondente foi encontrado no arquivo ${fileName}.`);
        return;
      }

      const nextData: RawData = {
        ...data,
        res: newRes,
        gradeRes: newRes.map((r) => [...r] as ResRow),
        ecSyncHash: data.ec?.r?.length ? computeEcContentHash(data.ec) : data.ecSyncHash,
      };
      updateDataWithHistory(nextData, `Importou Tabela 7 (${fileName}): ${count} produtos`);
      setT7BannerHtml(`<b>Tabela 7 importada com sucesso:</b> ${count} produtos atualizados a partir de ${fileName}.`);
      setToastMessage(`✓ Tabela 7 importada: ${count} produtos atualizados!`);
    } catch (e: any) {
      setToastMessage(`⚠️ Erro ao importar Tabela 7: ${e?.message || e}`);
    }
  };

  // Helpers para gravação 100% isolada por data no Firebase (diferencas_diarias_salvas/{YYYY-MM-DD})
  const getLocalDateKey = (d: Date = new Date()): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const buildIsolatedDailyDiffRecord = (
    dateKey: string,
    prods: CalculatedProduct[],
    xs: number[],
    desativados: number[],
    sourceAction: 'CONGELAR' | 'SALVAR_DIF'
  ): SavedDailyDiffRecord => {
    const [yearStr, monthStr, dayStr] = dateKey.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    const dateBR = `${dayStr}/${monthStr}/${yearStr}`;

    const desativadosSet = new Set(desativados || []);
    const active = prods.filter((p) => !desativadosSet.has(p.c) && !p.desativado);
    const sv0 = (r: CalculatedProduct) => (xs.includes(r.c) ? 0 : r.S);

    const faltas = active.filter((r) => r.R < 0);
    const sobras = active.filter((r) => r.R > 0 && sv0(r) >= 0);

    const totalFaltas = sum(faltas, (r) => -r.S);
    const totalSobras = sum(sobras, sv0);
    const saldoFinal = totalSobras - totalFaltas;

    const items: SavedDailyDiffItem[] = active.map((r) => ({
      cod: r.c,
      desc: r.d,
      fatorCx: r.V || 1,
      fatorHl: r.X || 0,
      precoCx: r.U || 0,
      difCx: r.R,
      difValor: r.R > 0 && xs.includes(r.c) ? 0 : r.S,
    }));

    return {
      dateKey,
      dateBR,
      day,
      month,
      year,
      savedAt: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      sourceAction,
      summary: {
        totalFaltas,
        totalSobras,
        saldoFinal,
        faltasCount: faltas.length,
        sobrasCount: sobras.length,
        divergenciasCount: faltas.length + sobras.length,
        totalProdutos: active.length,
      },
      items,
    };
  };

  // Obtém o registro salvo imediatamente anterior à data alvo (para comparativo sem mesclar datas)
  const getPriorDiffMapForDate = (
    targetDateKey: string,
    allDiffs: Record<string, SavedDailyDiffRecord>
  ): Map<number, number> | null => {
    const priorKeys = Object.keys(allDiffs)
      .filter((k) => k < targetDateKey)
      .sort();
    if (priorKeys.length === 0) return null;
    const latestPrior = allDiffs[priorKeys[priorKeys.length - 1]];
    const map = new Map<number, number>();
    latestPrior.items.forEach((it) => map.set(it.cod, it.difCx));
    return map;
  };

  // Ações do Dashboard
  const handleCongelar = () => {
    const todayDateKey = getLocalDateKey();
    runProtectedAction(async () => {
      setConfirmModal({
        isOpen: true,
        title: 'Finalizar Conciliação e Congelar',
        message: `Deseja finalizar a conciliação de hoje (${todayDateKey.split('-').reverse().join('/')}), congelar a 02.05.02 (Coluna L) e as divergências atuais no Dashboard, criar a aba isolada no Firebase (diferencas_diarias_salvas/${todayDateKey}) e atualizar a DIF Diária e DIF Mensal?`,
        onConfirm: async () => {
          const targetDay = new Date().getDate();
          const dayIndex = targetDay - 1;

          // 1. Cria a aba 100% isolada desta data exata no Firebase (sem mesclar com nenhum outro dia)
          const isolatedRecord = buildIsolatedDailyDiffRecord(
            todayDateKey,
            calculatedProducts,
            data.xs,
            data.desativados || [],
            'CONGELAR'
          );

          // 2. Congela a 02.05.02 atual (Coluna L - Disponível Fiscal) para exibição na Exportação de Grade
          const ecForFreeze =
            data.ec && Array.isArray(data.ec.r) && data.ec.r.length > 0
              ? data.ec
              : data.gradeEc && Array.isArray(data.gradeEc.r) && data.gradeEc.r.length > 0
              ? data.gradeEc
              : null;

          const frozen020502: Record<number, number> = {};
          if (ecForFreeze && Array.isArray(ecForFreeze.r)) {
            const headers = (ecForFreeze.h || []).map((h) =>
              String(h || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim()
            );
            let pIdx = headers.findIndex(
              (h) =>
                h === 'produto' ||
                h === 'codigo' ||
                h === 'cod produto' ||
                h === 'cod prod' ||
                h === 'cod' ||
                h === 'mercadoria'
            );
            let dispIdx = headers.findIndex(
              (h) => h === 'disponivel' || h === 'disponivel fiscal' || h === 'saldo grade real'
            );
            if (pIdx < 0) pIdx = 3;
            if (dispIdx < 0) dispIdx = 11;

            ecForFreeze.r.forEach((row) => {
              if (!row || !Array.isArray(row)) return;
              let code = 0;
              if (row[pIdx] !== undefined && row[pIdx] !== null) {
                const v = String(row[pIdx]).trim().replace(/^0+/, '');
                const num = Number(v);
                if (!isNaN(num) && num > 10 && num < 99999999) {
                  code = num;
                }
              }
              if (!code) {
                for (const c of [3, 0, 1, 2]) {
                  const v = String(row[c] || '').trim().replace(/^0+/, '');
                  const n = Number(v);
                  if (!isNaN(n) && n > 10 && n < 99999999) {
                    code = n;
                    break;
                  }
                }
              }
              if (code <= 0) return;

              let dispVal = 0;
              if (row.length > dispIdx && row[dispIdx] !== undefined && row[dispIdx] !== '') {
                dispVal = parseColL(row[dispIdx]);
              } else if (row.length > 11 && row[11] !== undefined && row[11] !== '') {
                dispVal = parseColL(row[11]);
              }
              frozen020502[code] = Math.max(0, Math.round(dispVal));
            });
          } else {
            calculatedProducts.forEach((p) => {
              frozen020502[p.c] = Math.max(0, Math.round(p.H));
            });
          }

          const frozen020502At = new Date().toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          // 3. Atualiza o dia correspondente do mês atual na DIF Mensal
          const menMap = new Map<number, number>();
          const newMen: MenRow[] = data.men.map((row, idx) => {
            menMap.set(row[0], idx);
            return [...row] as MenRow;
          });

          let nonZeroCount = 0;

          calculatedProducts.forEach((calc) => {
            const code = calc.c;
            const diff = calc.R;

            if (menMap.has(code)) {
              const idx = menMap.get(code)!;
              const row = newMen[idx];
              const days = [...row[4]];
              days[dayIndex] = diff;
              const newTotal = days.reduce<number>((acc, v) => acc + (v || 0), 0);
              newMen[idx] = [row[0], calc.d || row[1], calc.X || row[2], row[3], days, newTotal];
              if (diff !== 0) nonZeroCount++;
            } else {
              const days: (number | null)[] = new Array(31).fill(null);
              days[dayIndex] = diff;
              newMen.push([calc.c, calc.d, calc.X, 0, days, diff]);
              menMap.set(code, newMen.length - 1);
              if (diff !== 0) nonZeroCount++;
            }
          });

          // 4. Congela data.dia com a diferença atual (DIF CONGELADA = DIA ATUAL = currDiff)
          const nextDia: DiaRow[] = calculatedProducts.map((p) => {
            const currDiff = p.R;
            return [p.c, currDiff, currDiff];
          });

          const nextData: RawData = {
            ...data,
            men: newMen,
            dia: nextDia,
            frozen020502,
            frozen020502At,
          };

          const actionDesc = `Conciliação e 02.05.02 congeladas em ${isolatedRecord.dateBR} (${nonZeroCount} divergências)`;
          setSavedDailyDiffs((prev) => ({ ...prev, [todayDateKey]: isolatedRecord }));
          pushHistory(nextData, actionDesc);
          setData(nextData);
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          setToastMessage(
            `❄️ Conciliação e 02.05.02 congeladas (${isolatedRecord.dateBR} — ${nonZeroCount} divergências).`
          );

          await Promise.all([
            saveDailyDiffToFirestore(isolatedRecord),
            saveStateToFirestore(nextData, 'Congelar ' + isolatedRecord.dateBR, actionDesc, true),
          ]);
        },
      });
    });
  };

  const handleSalvar = () => {
    setIsSalvarDifModalOpen(true);
  };

  const handleConfirmSaveDif = (targetDateKey: string) => {
    runProtectedAction(async () => {
      const [yearStr, monthStr, dayStr] = targetDateKey.split('-');
      const targetYear = Number(yearStr);
      const targetMonth = Number(monthStr);
      const targetDay = Number(dayStr);
      const dayIndex = targetDay - 1;

      const now = new Date();
      const isCurrentActiveMonth =
        targetYear === now.getFullYear() && targetMonth === now.getMonth() + 1;

      // 1. Grava PRIMEIRO na aba 100% isolada do Firebase para aquela data específica:
      //    diferencas_diarias_salvas/{YYYY-MM-DD} — nunca mescla com outros dias!
      const existingAction = savedDailyDiffs[targetDateKey]?.sourceAction;
      const sourceActionToSave: 'CONGELAR' | 'SALVAR_DIF' =
        existingAction === 'CONGELAR' ? 'CONGELAR' : 'SALVAR_DIF';

      const isolatedRecord = buildIsolatedDailyDiffRecord(
        targetDateKey,
        calculatedProducts,
        data.xs,
        data.desativados || [],
        sourceActionToSave
      );
      const okDaily = await saveDailyDiffToFirestore(isolatedRecord);
      const updatedDiffs = { ...savedDailyDiffs, [targetDateKey]: isolatedRecord };
      setSavedDailyDiffs(updatedDiffs);

      // 2. Só atualiza a grade mensal (data.men) se a data escolhida pertencer ao mês/ano ativo,
      //    evitando mesclar lançamentos de meses diferentes (ex: Outubro vs Novembro).
      let newMen = data.men;
      let updatedCount = isolatedRecord.summary.totalProdutos;
      const nonZeroCount = isolatedRecord.summary.divergenciasCount;

      if (isCurrentActiveMonth && dayIndex >= 0 && dayIndex < 31) {
        const menMap = new Map<number, number>();
        newMen = data.men.map((row, idx) => {
          menMap.set(row[0], idx);
          return [...row] as MenRow;
        });

        updatedCount = 0;
        calculatedProducts.forEach((calc) => {
          const code = calc.c;
          const diff = calc.R;

          if (menMap.has(code)) {
            const idx = menMap.get(code)!;
            const row = newMen[idx];
            const days = [...row[4]];
            days[dayIndex] = diff;
            const newTotal = days.reduce<number>((acc, v) => acc + (v || 0), 0);
            newMen[idx] = [row[0], calc.d || row[1], calc.X || row[2], row[3], days, newTotal];
            updatedCount++;
          } else {
            const days: (number | null)[] = new Array(31).fill(null);
            days[dayIndex] = diff;
            newMen.push([calc.c, calc.d, calc.X, 0, days, diff]);
            menMap.set(code, newMen.length - 1);
            updatedCount++;
          }
        });
      }

      // 3. Atualiza data.dia apenas se esta for a data mais recente gravada (mantendo comparativo isolado)
      const allKeys = Object.keys(updatedDiffs).sort();
      const latestKey = allKeys[allKeys.length - 1] || targetDateKey;
      let nextDia = data.dia;

      if (targetDateKey >= latestKey) {
        const priorMap = getPriorDiffMapForDate(targetDateKey, updatedDiffs);
        const existingDiaMap = new Map<number, [number, number, number]>();
        data.dia.forEach((d) => existingDiaMap.set(d[0], d));

        nextDia = calculatedProducts.map((p) => {
          const currDiff = p.R;
          const prev = existingDiaMap.get(p.c);
          const prevEq = priorMap
            ? (priorMap.get(p.c) ?? 0)
            : (prev ? prev[2] : 0);
          return [p.c, prevEq, currDiff];
        });
      }

      const nextData: RawData = {
        ...data,
        men: newMen,
        dia: nextDia,
      };

      const actionDesc = `Salva DIF isolada (${isolatedRecord.dateBR}) em diferencas_diarias_salvas/${targetDateKey} (${nonZeroCount} divergências)`;
      pushHistory(nextData, actionDesc);
      setData(nextData);

      // 4. Sincroniza estado principal no Firebase
      const okState = await saveStateToFirestore(nextData, 'Salvamento DIF ' + isolatedRecord.dateBR, actionDesc, true);
      if (okDaily || okState) {
        setToastMessage(
          `✅ Aba isolada ${isolatedRecord.dateBR} salva no Firebase (diferencas_diarias_salvas/${targetDateKey}) — ${updatedCount} itens.`
        );
      } else {
        setToastMessage(`⚠️ DIF do dia ${isolatedRecord.dateBR} salva localmente (falha temporária de conexão com Firebase).`);
      }
    });
  };

  const handleLimpar = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Limpar Diferenças (Zerar Divergências)',
      message: 'Deseja igualar o estoque físico ao sistema Promax e zerar todas as diferenças da conciliação atual (saldo zerado)?',
      onConfirm: () => {
        const sAdj = { M: {} as Record<number, number>, N: {} as Record<number, number>, O: {} as Record<number, number> };
        (data.aj?.so || []).forEach((r) => {
          if (r[8] === 'Pendente') {
            const c = Number(r[0]);
            sAdj.M[c] = (sAdj.M[c] || 0) + Number(r[2] || 0);
          }
        });
        (data.aj?.av || []).forEach((r) => {
          if (r[4] === 'Pendente') {
            const c = Number(r[1]);
            sAdj.N[c] = (sAdj.N[c] || 0) + Number(r[3] || 0);
          }
        });
        (data.aj?.fm || []).forEach((r) => {
          const c = Number(r[0]);
          sAdj.O[c] = (sAdj.O[c] || 0) + Number(r[2] || 0);
        });

        const clearedRes = data.res.map((r) => {
          const row = [...r] as ResRow;
          const c = row[0];
          const M = sAdj.M[c] || 0;
          const Nn = sAdj.N[c] || 0;
          const Oo = sAdj.O[c] || 0;
          row[7] = row[3] - Nn + M - Oo; // J = G (diferença zerada inclusive com ajustes pendentes)
          row[8] = 0;      // repack
          row[9] = 0;      // ajuste M
          row[10] = 0;     // ajuste N
          row[11] = 0;     // ajuste O
          return row;
        });
        const nextDia = data.dia.map((d) => [d[0], 0, 0] as [number, number, number]);
        const nextData: RawData = {
          ...data,
          res: clearedRes,
          gradeRes: data.gradeRes ? clearedRes.map((r) => [...r] as ResRow) : undefined,
          dia: nextDia,
          ecSyncHash: data.ec?.r?.length ? computeEcContentHash(data.ec) : data.ecSyncHash,
        };
        updateDataWithHistory(nextData, 'Limpeza e regularização das diferenças (Base Zerada)');
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const handleVoltarOriginal = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Restaurar Base Limpa (Zerada)',
      message: 'Deseja descartar as alterações e restaurar a base oficial 100% zerada (sem divergências, DIF Diária zerada e DIF Mensal limpa)?',
      onConfirm: () => {
        updateDataWithHistory(initialRawData, 'Restauração da base original zerada');
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  // Ações da DIF Mensal
  const handleUpdateMen = (newMen: MenRow[], description: string) => {
    runProtectedAction(() => {
      const nextData = { ...data, men: newMen };
      updateDataWithHistory(nextData, description);
    });
  };

  const handleClearMenDay = async (day: number) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const dateKey = `${y}-${m}-${dStr}`;

    await deleteDailyDiffFromFirestore(dateKey);
    setSavedDailyDiffs((prev) => {
      const next = { ...prev };
      delete next[dateKey];
      return next;
    });

    let clearedCount = 0;
    const newMen = data.men.map((r) => {
      const row = [...r] as MenRow;
      const days = [...row[4]];
      if (days[day - 1] !== null) {
        clearedCount++;
      }
      days[day - 1] = null;
      const soma = days.reduce<number>((acc, v) => acc + (v || 0), 0);
      return [row[0], row[1], row[2], row[3], days, soma] as MenRow;
    });
    updateDataWithHistory(
      { ...data, men: newMen },
      `Limpeza dos lançamentos do Dia ${day} (${dateKey}) na DIF Mensal e no Firebase (${clearedCount} produtos zerados)`
    );
  };

  const handleDeleteDailyDiff = async (dateKey: string) => {
    const ok = await deleteDailyDiffFromFirestore(dateKey);
    if (!ok) {
      setToastMessage(`⚠️ Não foi possível excluir a aba ${dateKey} no Firebase.`);
      return;
    }

    setSavedDailyDiffs((prev) => {
      const next = { ...prev };
      delete next[dateKey];
      return next;
    });

    const [yStr, mStr, dStr] = dateKey.split('-');
    const now = new Date();
    const isCurrentMonth = Number(yStr) === now.getFullYear() && Number(mStr) === now.getMonth() + 1;
    const dayNum = Number(dStr);

    if (isCurrentMonth && dayNum >= 1 && dayNum <= 31) {
      const newMen = data.men.map((r) => {
        const row = [...r] as MenRow;
        const days = [...row[4]];
        days[dayNum - 1] = null;
        const soma = days.reduce<number>((acc, v) => acc + (v || 0), 0);
        return [row[0], row[1], row[2], row[3], days, soma] as MenRow;
      });
      updateDataWithHistory(
        { ...data, men: newMen },
        `Excluiu aba isolada ${dateKey.split('-').reverse().join('/')} do Firebase`
      );
    }

    setToastMessage(`🗑️ Aba isolada ${dateKey.split('-').reverse().join('/')} removida do Firebase.`);
  };

  const handleResetAllMen = (options?: { resetFechamentoMode?: 'keep' | 'last_day' | 'zero' }) => {
    const mode = options?.resetFechamentoMode || 'keep';
    let lastActiveDay = 0;
    if (mode === 'last_day') {
      data.men.forEach((r) => {
        r[4].forEach((v, i) => {
          if (v !== null && i + 1 > lastActiveDay) lastActiveDay = i + 1;
        });
      });
    }

    const newMen = data.men.map((r) => {
      const row = [...r] as MenRow;
      const emptyDays: (number | null)[] = Array(31).fill(null);
      let newFechamento = row[3];
      if (mode === 'zero') {
        newFechamento = 0;
      } else if (mode === 'last_day' && lastActiveDay > 0) {
        const lastVal = row[4][lastActiveDay - 1];
        if (lastVal !== null) {
          newFechamento = lastVal;
        }
      }
      return [row[0], row[1], row[2], newFechamento, emptyDays, 0] as MenRow;
    });

    const descMsg =
      mode === 'zero'
        ? 'DIF Mensal zerada 100% (dias e fechamentos) para novo mês'
        : mode === 'last_day'
        ? 'DIF Mensal zerada com fechamento atualizado pelo último dia para novo mês'
        : 'DIF Mensal zerada (todos os dias 1..31 limpos) para novo mês';

    updateDataWithHistory({ ...data, men: newMen }, descMsg);
  };

  // Undo / Redo (com persistência no Firebase e atalhos Ctrl+Z / Ctrl+Y)
  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      const restored = history[prevIndex].data;
      const revertedAction = history[historyIndex]?.desc || 'última alteração';
      setHistoryIndex(prevIndex);
      setData(restored);
      saveStateToFirestore(restored, `Desfeito: ${revertedAction}`);
      setToastMessage(`↩️ Desfeito: ${revertedAction}`);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      const restored = history[nextIndex].data;
      const redoneAction = history[nextIndex]?.desc || 'ação';
      setHistoryIndex(nextIndex);
      setData(restored);
      saveStateToFirestore(restored, `Refeito: ${redoneAction}`);
      setToastMessage(`↪️ Refeito: ${redoneAction}`);
    }
  };

  // Atalhos de teclado globais Ctrl+Z (Desfazer) e Ctrl+Y (Refazer)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!currentUser) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (historyIndex > 0) {
          e.preventDefault();
          handleUndo();
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        if (historyIndex < history.length - 1) {
          e.preventDefault();
          handleRedo();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Recontagem States & Handlers
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (toastMessage) {
      const t = setTimeout(() => setToastMessage(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toastMessage]);

  const handleRecontar = (code: number) => {
    const prod = calculatedProducts.find((p) => p.c === code);
    const currentRecontagens = data.recontagens || [];
    let nextRecontagens = [...currentRecontagens];
    const existing = currentRecontagens.find((r) => r.cod === code);

    if (!existing && prod) {
      const newItem = createRecontagemFromProduct(prod);
      nextRecontagens = [newItem, ...nextRecontagens];
      updateDataWithHistory(
        { ...data, recontagens: nextRecontagens },
        `Adicionou item ${code} (${prod.d}) à Recontagem`
      );
    }

    // Não muda de aba! Apenas informa com texto simples conforme solicitado
    setToastMessage(`Item ${code} enviado para a aba de Recontagem.`);
  };

  const handleToggleDiferencaConfirmada = (code: number, desc?: string) => {
    const current = data.diferencaConfirmadaCodes || [];
    const exists = current.includes(code);
    const next = exists ? current.filter((c) => c !== code) : [...current, code];
    const nextData: RawData = {
      ...data,
      diferencaConfirmadaCodes: next,
    };
    const actionDesc = exists
      ? `Removeu marcação azul (não contar) do produto #${code} (${desc || ''})`
      : `Marcou produto #${code} (${desc || ''}) em azul: diferença permaneceu e não precisa contar novamente`;
    updateDataWithHistory(nextData, actionDesc);
    setToastMessage(
      exists
        ? `Marcação azul removida do item #${code}.`
        : `🔵 Item #${code} marcado em AZUL: diferença permaneceu e não precisa contar novamente!`
    );
  };

  const handleUpdateRecontagem = (item: RecontagemItem, desc?: string) => {
    const current = data.recontagens || [];
    const next = current.map((r) => (r.id === item.id ? item : r));
    updateDataWithHistory(
      { ...data, recontagens: next },
      desc || `Atualizou recontagem do item ${item.cod}`
    );
  };

  const handleDeleteRecontagem = (id: string) => {
    const current = data.recontagens || [];
    const itemToDelete = current.find((r) => r.id === id || String(r.cod) === id);
    const next = current.filter((r) => r.id !== id && String(r.cod) !== id);
    const codName = itemToDelete?.cod || '';
    updateDataWithHistory(
      { ...data, recontagens: next },
      `Removeu item ${codName} da fila de recontagem`
    );
    setToastMessage(`✓ Item ${codName} excluído da recontagem.`);
  };

  const handleClearAjustados = () => {
    const current = data.recontagens || [];
    const next = current.filter((r) => r.status !== 'ajustado');
    updateDataWithHistory(
      { ...data, recontagens: next },
      'Limpeza de itens ajustados da Recontagem'
    );
    setToastMessage('Itens ajustados removidos da recontagem.');
  };

  const handleClearAllRecontagens = () => {
    updateDataWithHistory(
      { ...data, recontagens: [] },
      'Limpeza total da fila de Recontagem'
    );
    setToastMessage('Fila de recontagem limpa.');
  };

  const handleAplicarRecontagemAoEstoque = (item: RecontagemItem) => {
    const finalUnid = item.novaContagemUnid ?? (item.novaContagemCx || 0) * (item.fatorCx || 1);
    const finalCx = item.novaContagemCx ?? Math.floor(finalUnid / (item.fatorCx || 1));

    // 1. Atualiza na tabela res (coluna 7: b - inventário físico)
    const resIdx = data.res.findIndex((r) => r[0] === item.cod);
    let nextRes = [...data.res];
    if (resIdx !== -1) {
      const row = [...nextRes[resIdx]] as ResRow;
      row[7] = finalUnid;
      nextRes[resIdx] = row;
    }

    // 2. Atualiza status na lista de recontagens
    const currentRecontagens = data.recontagens || [];
    const nextRecontagens = currentRecontagens.map((r) =>
      r.id === item.id
        ? {
            ...item,
            status: 'ajustado' as const,
            novaContagemUnid: finalUnid,
            novaContagemCx: finalCx,
            ajustadoEm: new Date().toLocaleString('pt-BR'),
          }
        : r
    );

    const desc = `Recontagem aplicada na base: Item ${item.cod} (${item.desc}) ajustado para ${finalCx} cx (${finalUnid} un)`;
    const nextData: RawData = {
      ...data,
      res: nextRes,
      gradeRes: data.gradeRes ? nextRes.map((r) => [...r] as ResRow) : undefined,
      recontagens: nextRecontagens,
      ecSyncHash: data.ec?.r?.length ? computeEcContentHash(data.ec) : data.ecSyncHash,
    };

    updateDataWithHistory(nextData, desc);
    setToastMessage(`✅ Estoque do item ${item.cod} ajustado com sucesso na base oficial!`);
  };

  const handleToggleDesativar = (code: number) => {
    const currentList = data.desativados || [];
    const isDesativado = currentList.includes(code);
    const prodDesc = calculatedMap[code]?.d || `Item ${code}`;

    const nextList = isDesativado
      ? currentList.filter((c) => c !== code)
      : [...currentList, code];

    const actionDesc = isDesativado
      ? `Reativou na plataforma: ${code} - ${prodDesc}`
      : `Desativou da plataforma por inteiro: ${code} - ${prodDesc}`;

    const nextData: RawData = {
      ...data,
      desativados: nextList,
    };

    updateDataWithHistory(nextData, actionDesc);
    setToastMessage(
      isDesativado
        ? `✅ Produto ${code} foi reativado na plataforma com sucesso!`
        : `🚫 Produto ${code} foi desativado da plataforma por inteiro (removido dos cálculos e dashboards).`
    );
  };

  const handleUpdateProductPrice = (
    code: number,
    precoCx: number,
    fatorCx?: number,
    fatorHl?: number
  ) => {
    let updatedDesc = '';
    let oldP = 0;
    let found = false;

    const newRes = data.res.map((r) => {
      const row = [...r] as ResRow;
      if (row[0] === code) {
        found = true;
        oldP = row[5];
        row[5] = precoCx;
        if (fatorCx !== undefined && fatorCx > 0) {
          row[4] = fatorCx;
        }
        if (fatorHl !== undefined && fatorHl >= 0) {
          row[6] = fatorHl;
        }
        updatedDesc = row[1];
      }
      return row;
    });

    if (!found) {
      const baseItem = data.ec?.r?.find((row) => Number(row[3]) === code);
      const desc = baseItem ? String(baseItem[4]) : `PRODUTO ${code}`;
      const f = fatorCx !== undefined && fatorCx > 0 ? fatorCx : 1;
      const newRow: ResRow = [
        code,
        desc,
        'cx',
        0, // G
        f, // V0
        precoCx, // U
        fatorHl || 0, // X
        0, // b
        0, // P
        0, // rm
        0, // rn
        0, // ro
      ];
      newRes.push(newRow);
      updatedDesc = desc;
    }

    const nextData: RawData = {
      ...data,
      res: newRes,
      gradeRes: data.gradeRes ? newRes.map((r) => [...r] as ResRow) : undefined,
      priceOverrides: {
        ...(data.priceOverrides || {}),
        [code]: precoCx,
      },
    };

    const actionDesc = `Definiu preço do produto #${code} (${updatedDesc || 'Item'}): R$ ${precoCx.toFixed(2).replace('.', ',')}`;
    updateDataWithHistory(nextData, actionDesc);
    setToastMessage(`✓ Preço do produto #${code} salvo com sucesso: R$ ${precoCx.toFixed(2).replace('.', ',')}!`);
  };

  const handleSaveContagemEstoque = (item: ContagemEstoqueItem) => {
    const list = data.contagensEstoque || [];
    const itemDate = getItemDateString(item);

    const existingIndex = list.findIndex(
      (c) =>
        c.id === item.id ||
        (c.cod === item.cod && getItemDateString(c) === itemDate)
    );

    let updatedList: ContagemEstoqueItem[];
    let wasMerged = false;

    if (existingIndex >= 0) {
      const existing = list[existingIndex];
      if (item.id === existing.id) {
        // Atualização direta
        updatedList = list.map((c, i) => (i === existingIndex ? item : c));
      } else {
        // Código igual em lançamento novo: SOMA as quantidades
        const merged = mergeContagemItems(existing, item);
        updatedList = list.map((c, i) => (i === existingIndex ? merged : c));
        wasMerged = true;
      }
    } else {
      updatedList = [item, ...list];
    }

    const consolidated = consolidateContagens(updatedList);
    const nextData: RawData = {
      ...data,
      contagensEstoque: consolidated,
    };
    const logText = wasMerged
      ? `Somou contagem do produto #${item.cod} (${item.desc || ''}): total atualizado para ${item.totalCaixasFormatado} cx`
      : `Registrou contagem de estoque do produto #${item.cod} (${item.totalCaixasFormatado} cx)`;
    updateDataWithHistory(nextData, logText);
  };

  const handleUpdateContagemEstoque = (item: ContagemEstoqueItem) => {
    const list = data.contagensEstoque || [];
    const itemDate = getItemDateString(item);
    // Atualiza o item e limpa eventuais duplicatas anteriores do mesmo código na data
    const filtered = list.filter(
      (c) => c.id === item.id || !(c.cod === item.cod && getItemDateString(c) === itemDate)
    );
    const updatedList = filtered.map((c) => (c.id === item.id ? item : c));
    const exists = updatedList.some((c) => c.id === item.id);
    const finalList = exists ? updatedList : [item, ...updatedList];

    const nextData: RawData = {
      ...data,
      contagensEstoque: consolidateContagens(finalList),
    };
    updateDataWithHistory(nextData, `Atualizou contagem de estoque do produto #${item.cod}`);
  };

  const handleDeleteContagemEstoque = (id: string) => {
    const list = data.contagensEstoque || [];
    const target = list.find((c) => c.id === id);
    const targetDate = target ? getItemDateString(target) : '';
    const updatedList = list.filter((c) => {
      if (c.id === id) return false;
      if (target && c.cod === target.cod && getItemDateString(c) === targetDate) return false;
      return true;
    });
    const nextData: RawData = {
      ...data,
      contagensEstoque: consolidateContagens(updatedList),
    };
    updateDataWithHistory(nextData, `Excluiu contagem de estoque ${target ? `#${target.cod}` : ''}`);
  };

  const handleClearAllContagensEstoque = () => {
    const nextData: RawData = {
      ...data,
      contagensEstoque: [],
    };
    updateDataWithHistory(nextData, 'Limpou todas as contagens de estoque');
  };

  const handleAplicarContagensAoEstoque = (items: ContagemEstoqueItem[]) => {
    const itemMap = new Map<number, number>();
    items.forEach((it) => {
      itemMap.set(it.cod, it.totalUnidades);
    });

    const newRes = data.res.map((r) => {
      const row = [...r] as ResRow;
      if (itemMap.has(row[0])) {
        row[7] = itemMap.get(row[0])!; // Coluna b (inventário físico em unidades)
      }
      return row;
    });

    const nextData: RawData = {
      ...data,
      res: newRes,
      gradeRes: data.gradeRes ? newRes.map((r) => [...r] as ResRow) : undefined,
      ecSyncHash: data.ec?.r?.length ? computeEcContentHash(data.ec) : data.ecSyncHash,
    };

    updateDataWithHistory(nextData, `Aplicou contagem física de ${items.length} produtos ao inventário base`);
    setToastMessage(`✓ ${items.length} contagens físicas aplicadas com sucesso ao inventário do sistema!`);
  };

  const handleLogout = () => {
    signOutAuth();
    setCurrentUser(null);
    setDismissedProvisionalPrompt(false);
    setActiveTab('dashboard');
    setToastMessage(null);
  };

  const handleSaveProvisionalNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setProvisionalPassError(null);

    if (provisionalNewPass.length < 4) {
      setProvisionalPassError('A nova senha deve ter pelo menos 4 caracteres.');
      return;
    }
    if (provisionalNewPass !== provisionalConfirmPass) {
      setProvisionalPassError('As senhas digitadas não conferem.');
      return;
    }

    setSavingProvisionalPass(true);
    try {
      const res = await updateUserInFirestore(
        currentUser.username,
        {
          newPassword: provisionalNewPass,
          mustChangePassword: false,
        },
        currentUser.username
      );
      if (res.success) {
        setCurrentUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
        setProvisionalNewPass('');
        setProvisionalConfirmPass('');
        setDismissedProvisionalPrompt(true);
        setToastMessage('✓ Nova senha definitiva salva com sucesso!');
      } else {
        setProvisionalPassError(res.error || 'Erro ao atualizar a senha.');
      }
    } finally {
      setSavingProvisionalPass(false);
    }
  };

  if (!currentUser) {
    return (
      <LoginScreen
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          setDismissedProvisionalPrompt(false);
          setActiveTab('dashboard');
          setToastMessage(`✓ Bem-vindo(a), ${user.fullName}!`);
        }}
      />
    );
  }

  const pendingResetCount =
    currentUser.role === 'admin'
      ? usersList.filter((u) => u.passwordResetRequested).length
      : 0;

  return (
    <div className="min-h-screen bg-white text-zinc-900 flex flex-col font-sans w-full max-w-full overflow-x-hidden">
      {/* Top Black Bar */}
      <div className="top-black-bar print:hidden" />

      {/* Main Navigation Tabs */}
      <nav className="app-nav print:hidden">
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginRight: '6px' }}>
          <b>ESTOQUE OFICIAL GUARABIRA</b>
          <span
            style={{
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              backgroundColor: isRealtimeActive ? '#16a34a' : '#eab308',
              boxShadow: isRealtimeActive ? '0 0 6px #22c55e' : 'none',
              display: 'inline-block',
              transition: 'all 0.3s ease',
            }}
            title={
              isRealtimeActive
                ? 'Conectado em tempo real com todos os usuários via Firebase'
                : 'Conectando ao banco em tempo real...'
            }
          />
        </div>

        <button
          className={`k-tab ${activeTab === 'dashboard' ? 'on' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          DASHBOARD
        </button>

        <button
          className={activeTab === 'popups_salvos' ? 'on' : ''}
          onClick={() => setActiveTab('popups_salvos')}
          style={
            activeTab === 'popups_salvos'
              ? { background: '#7C3AED', color: '#FFFFFF', borderColor: '#A78BFA', fontWeight: '800' }
              : { background: '#6D28D9', color: '#EDE9FE', fontWeight: 'bold' }
          }
          title="Aba de Pop-ups Salvos: Selecione produtos dando duplo clique na quantidade (QTDE) no Dashboard"
        >
          POP-UPS SALVOS
          {savedPopups.length > 0 && (
            <span
              style={{
                marginLeft: '5px',
                background: activeTab === 'popups_salvos' ? '#FFFFFF' : '#FFC000',
                color: '#000000',
                borderRadius: '999px',
                padding: '1px 6px',
                fontSize: '9.5px',
                fontWeight: 'bold',
              }}
            >
              {savedPopups.length}
            </span>
          )}
        </button>

        <button
          className={activeTab === 'export_grade' ? 'on' : ''}
          onClick={() => setActiveTab('export_grade')}
          style={
            activeTab === 'export_grade'
              ? { background: '#059669', color: '#FFFFFF', borderColor: '#34D399', fontWeight: '800' }
              : { background: '#065F46', color: '#D1FAE5', fontWeight: 'bold' }
          }
          title="Exportação de Grade: CodigoProduto, CodigoGrade, QuantidadeProduto, QuantidadeReserva com ajustes de 02.05.02, congelamentos e quebras"
        >
          EXPORTAR GRADE
        </button>

        <button
          className={activeTab === 'check_grade' ? 'on' : ''}
          onClick={() => setActiveTab('check_grade')}
          style={
            activeTab === 'check_grade'
              ? { background: '#2563EB', color: '#FFFFFF', borderColor: '#60A5FA', fontWeight: '800' }
              : { background: '#1D4ED8', color: '#DBEAFE', fontWeight: 'bold' }
          }
          title="Check de Lançamento da Grade: Valida se o relatório da grade baixado do sistema confere com o planejado"
        >
          CHECK LANÇAMENTO
        </button>

        <button
          className={activeTab === 'resumo' ? 'on' : ''}
          onClick={() => setActiveTab('resumo')}
        >
          RESUMO
        </button>

        <button
          className={activeTab === 'ajustes' ? 'on' : ''}
          onClick={() => setActiveTab('ajustes')}
        >
          AJUSTES
        </button>

        <button
          className={activeTab === 'dif_diaria' ? 'on' : ''}
          onClick={() => setActiveTab('dif_diaria')}
        >
          DIF DIÁRIA
        </button>

        <button
          className={activeTab === 'dif_mensal' ? 'on' : ''}
          onClick={() => setActiveTab('dif_mensal')}
        >
          DIF MENSAL
        </button>

        <button
          className={activeTab === 'ec' ? 'on' : ''}
          onClick={() => setActiveTab('ec')}
        >
          ESTOQUE CENTRAL
        </button>









        <button
          className={activeTab === 'recontagem' ? 'on' : ''}
          onClick={() => setActiveTab('recontagem')}
          style={
            activeTab === 'recontagem'
              ? { background: '#D97706', color: '#fff' }
              : { background: '#B45309', color: '#FEF3C7' }
          }
          title="Aba de Recontagem Física e Auditoria Cega de Itens (Ativada por duplo clique no COD)"
        >
          RECONTAGEM
          {(data.recontagens?.length || 0) > 0 && (
            <span
              style={{
                marginLeft: '4px',
                background: activeTab === 'recontagem' ? '#fff' : '#000',
                color: activeTab === 'recontagem' ? '#000' : '#FFC000',
                borderRadius: '999px',
                padding: '0 4px',
                fontSize: '9px',
                fontWeight: 'bold',
              }}
            >
              {data.recontagens?.length}
            </span>
          )}
        </button>

        <button
          className={activeTab === 'produtos' ? 'on' : ''}
          onClick={() => {
            setProdutosInitialQuery('');
            setActiveTab('produtos');
          }}
          style={
            activeTab === 'produtos'
              ? { background: '#0F172A', color: '#fff' }
              : { background: '#1E293B', color: '#E2E8F0' }
          }
          title="Catálogo Geral: Todos os produtos cadastrados na plataforma com códigos, preços, estoques e divergências"
        >
          TODOS OS PRODUTOS
        </button>

        <button
          className={activeTab === 'usuarios' ? 'on' : ''}
          onClick={() => setActiveTab('usuarios')}
          style={
            activeTab === 'usuarios'
              ? { background: '#090d16', color: '#FFC000', borderColor: '#000' }
              : { background: '#334155', color: '#F8FAFC' }
          }
          title="Guia de Cadastro e Gerenciamento de Usuários"
        >
          CADASTRO USUÁRIOS
          {pendingResetCount > 0 && (
            <span
              style={{
                marginLeft: '4px',
                background: '#FFC000',
                color: '#000000',
                borderRadius: '999px',
                padding: '0 4px',
                fontSize: '9px',
                fontWeight: 'bold',
              }}
            >
              {pendingResetCount}
            </span>
          )}
        </button>

        <div
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            flexShrink: 0,
            paddingLeft: '6px',
          }}
        >
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              color: '#0F172A',
              whiteSpace: 'nowrap',
            }}
            title={`${currentUser.fullName} (${USER_ROLE_LABELS[currentUser.role]})`}
          >
            {currentUser.username}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            style={{
              background: '#7F1D1D',
              color: '#FEE2E2',
              borderColor: '#450A0A',
            }}
            title="Sair da conta atual e voltar para a tela de login"
          >
            SAIR
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 w-full pb-10">
        {activeTab === 'resumo' && (
          <ResumoView
            calculated={calculatedProducts}
            xs={data.xs}
            onUpdateRes={handleUpdateRes}
            onImportT7={handleImportT7}
            t7BannerHtml={t7BannerHtml}
            ecBannerHtml={ecBannerHtml}
            onRecontar={handleRecontar}
            onNavigateToDashboard={() => setActiveTab('dashboard')}
          />
        )}

        {activeTab === 'ajustes' && (
          <AjustesView
            ajustes={data.aj}
            calculatedMap={calculatedMap}
            onUpdateAjustes={handleUpdateAjustes}
          />
        )}

        {activeTab === 'dif_diaria' && (
          <DifDiariaView data={data} calculatedMap={calculatedMap} />
        )}

        {activeTab === 'dif_mensal' && (
          <DifMensalView
            men={data.men}
            calculatedMap={calculatedMap}
            onClearDay={handleClearMenDay}
            onResetAll={handleResetAllMen}
            onUpdateMen={handleUpdateMen}
            onSalvarDifToday={() => setIsSalvarDifModalOpen(true)}
            savedDailyDiffs={savedDailyDiffs}
            onDeleteDailyDiff={handleDeleteDailyDiff}
          />
        )}

        {activeTab === 'ec' && (
          <EstoqueCentralView
            ec={data.ec}
            res={data.res}
            data={data}
            calculated={calculatedProducts}
            onSaveSnapshot={handleSaveSnapshot}
            onImport={(txt, nome) => handleImport020502(txt, nome, 'ec', false)}
            importBannerHtml={ecBannerHtml}
            onClearBanner={() => setEcBannerHtml(null)}
            onNavigateToDashboard={() => setActiveTab('dashboard')}
            onNavigateToTab={(tab) => setActiveTab(tab as TabKey)}
            onOpenImportModal={() => {
              setImportTargetTab('ec');
              setIsImportModalOpen(true);
            }}
            onOpenImportPrecosModal={() => setIsImportPrecosModalOpen(true)}
            onImportPrecos={handleImportPrecos}
            precosBannerHtml={precosBannerHtml}
            onClearPrecosBanner={() => setPrecosBannerHtml(null)}
            ec0304BannerHtml={ec0304BannerHtml}
            onClearEc0304Banner={() => setEc0304BannerHtml(null)}
            onSyncWithDashboard={handleSyncEcWithDashboard}
          />
        )}







        {activeTab === 'export_grade' && (
          <ExportGradeView
            data={data}
            calculatedMap={calculatedMap}
            calculatedProducts={calculatedProducts}
            onImport020502={(txt, nome) => handleImport020502(txt, nome, 'grade', false)}
            ecBannerHtml={ecBannerHtml}
          />
        )}

        {activeTab === 'check_grade' && (
          <CheckLancamentoGradeView
            data={data}
            calculatedMap={calculatedMap}
            onNavigateToExportGrade={() => setActiveTab('export_grade')}
          />
        )}

        {activeTab === 'dashboard' && (
          <DashboardView
            data={data}
            calculated={calculatedProducts}
            savedDailyDiffs={savedDailyDiffs}
            onSaveSnapshot={handleSaveSnapshot}
            onCongelar={handleCongelar}
            onSalvar={handleSalvar}
            onLimpar={handleLimpar}
            onVoltarOriginal={handleVoltarOriginal}
            onOpenImport020502={() => setActiveTab('ec')}
            onRecontar={handleRecontar}
            onToggleDesativar={handleToggleDesativar}
            onToggleDiferencaConfirmada={handleToggleDiferencaConfirmada}
            onNavigateToProdutos={(search) => {
              setProdutosInitialQuery(search || '');
              setActiveTab('produtos');
            }}
            onSavePopup={handleSavePopup}
            canUndo={historyIndex > 0}
            canRedo={historyIndex < history.length - 1}
            lastActionDescription={history[historyIndex]?.desc}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        )}

        {activeTab === 'popups_salvos' && (
          <PopupsSalvosView
            savedPopups={savedPopups}
            onRemovePopup={handleRemoveSavedPopup}
            onClearAll={handleClearSavedPopups}
            onNavigateToDashboard={() => setActiveTab('dashboard')}
          />
        )}

        {activeTab === 'recontagem' && (
          <RecontagemView
            recontagens={data.recontagens || []}
            calculatedProducts={calculatedProducts}
            onUpdateRecontagem={handleUpdateRecontagem}
            onDeleteRecontagem={handleDeleteRecontagem}
            onClearAjustados={handleClearAjustados}
            onClearAll={handleClearAllRecontagens}
            onAplicarAoEstoque={handleAplicarRecontagemAoEstoque}
            onNavigateToDashboard={() => setActiveTab('dashboard')}
          />
        )}


        {activeTab === 'produtos' && (
          <ProdutosView
            data={data}
            calculatedProducts={calculatedProducts}
            calculatedMap={calculatedMap}
            initialQuery={produtosInitialQuery}
            onRecontar={handleRecontar}
            onToggleDesativar={handleToggleDesativar}
            onNavigateToTab={(tab) => setActiveTab(tab as TabKey)}
            onUpdateProductPrice={handleUpdateProductPrice}
            onOpenImportPrecos={() => setIsImportPrecosModalOpen(true)}
          />
        )}

        {activeTab === 'usuarios' && (
          <CadastroUsuariosView
            currentUser={currentUser}
            users={usersList}
            onNotify={(msg) => setToastMessage(msg)}
          />
        )}
      </main>

      {/* Toast Notification Simples */}
      {toastMessage && (
        <div
          className="print:hidden"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 9999,
            background: toastMessage.startsWith('⚠️') ? 'rgba(127, 29, 29, 0.96)' : 'rgba(24, 24, 27, 0.95)',
            color: '#fff',
            padding: '10px 16px',
            borderRadius: '6px',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            fontSize: '12px',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderLeft: toastMessage.startsWith('⚠️') ? '4px solid #F87171' : '4px solid #FFC000',
            borderTop: '1px solid #3f3f46',
            borderRight: '1px solid #3f3f46',
            borderBottom: '1px solid #3f3f46',
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          <span>{toastMessage.startsWith('⚠️') ? '⚠️' : '✓'}</span>
          <span>{toastMessage.startsWith('⚠️') ? toastMessage.replace(/^⚠️\s*/, '') : toastMessage}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#a1a1aa',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '13px',
              marginLeft: '6px',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Modais do Sistema */}
      <Import020502Modal
        isOpen={isImportModalOpen}
        currentData={data}
        targetTab="ec"
        onClose={() => setIsImportModalOpen(false)}
        onConfirmImport={handleImport020502}
      />

      <ImportPrecosModal
        isOpen={isImportPrecosModalOpen}
        currentData={data}
        onClose={() => setIsImportPrecosModalOpen(false)}
        onConfirmImport={handleImportPrecos}
      />

      <LogsModal
        isOpen={isLogsModalOpen}
        onClose={() => setIsLogsModalOpen(false)}
      />

      <Modal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      <SalvarDifModal
        isOpen={isSalvarDifModalOpen}
        onClose={() => setIsSalvarDifModalOpen(false)}
        onConfirmSave={handleConfirmSaveDif}
        calculated={calculatedProducts}
        xs={data.xs}
        desativados={data.desativados}
      />
      
      <PasswordModal
        isOpen={isPasswordModalOpen}
        onClose={() => setIsPasswordModalOpen(false)}
        onConfirm={() => protectedAction && protectedAction()}
        title="Autenticação Necessária"
      />

      {currentUser.mustChangePassword && !dismissedProvisionalPrompt && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 print:hidden">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-lg p-6">
            <h3 className="text-base font-bold text-slate-900">
              Alterar Senha Provisória
            </h3>
            <p className="text-xs text-slate-600 mt-1">
              Você acessou com uma senha provisória. Defina sua senha definitiva abaixo ou altere depois na guia Cadastro de Usuários.
            </p>

            {provisionalPassError && (
              <div className="mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {provisionalPassError}
              </div>
            )}

            <form onSubmit={handleSaveProvisionalNewPassword} className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nova Senha Definitiva
                </label>
                <input
                  type="password"
                  value={provisionalNewPass}
                  onChange={(e) => setProvisionalNewPass(e.target.value)}
                  placeholder="Mínimo 4 caracteres"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  disabled={savingProvisionalPass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Confirmar Nova Senha
                </label>
                <input
                  type="password"
                  value={provisionalConfirmPass}
                  onChange={(e) => setProvisionalConfirmPass(e.target.value)}
                  placeholder="Repita a nova senha"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  disabled={savingProvisionalPass}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDismissedProvisionalPrompt(true)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  disabled={savingProvisionalPass}
                >
                  Alterar depois
                </button>
                <button
                  type="submit"
                  disabled={savingProvisionalPass}
                  className="px-4 py-2 text-xs font-bold text-[#FFC000] bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  {savingProvisionalPass ? 'Salvando...' : 'Salvar Nova Senha'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
