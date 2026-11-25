import React, { useState, useEffect } from 'react';
import { CalculatedProduct } from '../data/types';
import { N } from '../utils/formatters';
import { sum } from '../utils/calc';
import { 
  Calendar, 
  Save, 
  X, 
  AlertTriangle, 
  CheckCircle2, 
  TrendingDown, 
  TrendingUp, 
  Scale,
  Clock
} from 'lucide-react';

export interface SalvarDifModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmSave: (targetDateKey: string) => Promise<void> | void;
  calculated: CalculatedProduct[];
  xs: number[];
  desativados?: number[];
}

export const SalvarDifModal: React.FC<SalvarDifModalProps> = ({
  isOpen,
  onClose,
  onConfirmSave,
  calculated,
  xs,
  desativados = [],
}) => {
  const today = new Date();
  const getTodayKey = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const todayDateKey = getTodayKey();
  const [selectedDateKey, setSelectedDateKey] = useState<string>(todayDateKey);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSelectedDateKey(getTodayKey());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Cálculos do resumo da conciliação a ser gravada (exatamente idênticos ao Dashboard)
  const desativadosSet = new Set(desativados || []);
  const activeProducts = calculated.filter((p) => !desativadosSet.has(p.c) && !p.desativado);

  const sv0 = (r: CalculatedProduct) => (xs.includes(r.c) ? 0 : r.S);

  const faltas = activeProducts.filter((r) => r.R < 0);
  faltas.sort((a, b) => a.S - b.S);
  const sobras = activeProducts.filter((r) => r.R > 0 && sv0(r) >= 0);
  sobras.sort((a, b) => sv0(b) - sv0(a));

  const totalF = sum(faltas, (r) => -r.S);
  const totalS = sum(sobras, sv0);
  const saldo = totalS - totalF;
  const divergenciasCount = faltas.length + sobras.length;

  const handleConfirm = async () => {
    if (!selectedDateKey) return;
    setIsSaving(true);
    try {
      await onConfirmSave(selectedDateKey);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const selectedDateBR = selectedDateKey ? selectedDateKey.split('-').reverse().join('/') : '';
  const selectedDayNum = selectedDateKey ? parseInt(selectedDateKey.split('-')[2], 10) : today.getDate();

  const formattedToday = today.toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
        backdropFilter: 'blur(3px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '540px',
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid #1e3f70',
        }}
      >
        {/* Cabeçalho */}
        <div
          style={{
            background: 'linear-gradient(135deg, #1e3f70 0%, #2B579A 100%)',
            color: '#fff',
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                padding: '6px',
                display: 'flex',
              }}
            >
              <Save size={20} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold', letterSpacing: '0.3px' }}>
                SALVAR DIF NA DIF MENSAL
              </h2>
              <div style={{ fontSize: '11px', opacity: 0.9, marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Clock size={12} />
                <span>Hoje: {formattedToday}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            style={{
              background: 'none',
              border: 'none',
              color: '#fff',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              opacity: 0.8,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Corpo */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Seletor do Dia */}
          <div
            style={{
              background: '#F0F4F8',
              border: '1px solid #D0DCE5',
              borderRadius: '6px',
              padding: '14px 16px',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12px',
                fontWeight: 'bold',
                color: '#1e3f70',
                marginBottom: '8px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Calendar size={15} />
                SELECIONE A DATA EXATA PARA GRAVAR A DIF ISOLADA:
              </span>
              {selectedDateKey === todayDateKey && (
                <span
                  style={{
                    background: '#2B579A',
                    color: '#fff',
                    fontSize: '10px',
                    padding: '2px 6px',
                    borderRadius: '10px',
                    fontWeight: 'bold',
                  }}
                >
                  HOJE
                </span>
              )}
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="date"
                value={selectedDateKey}
                onChange={(e) => setSelectedDateKey(e.target.value)}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  borderRadius: '4px',
                  border: '1px solid #1e3f70',
                  background: '#fff',
                  color: '#000',
                  cursor: 'pointer',
                }}
              />

              <button
                type="button"
                onClick={() => setSelectedDateKey(todayDateKey)}
                disabled={selectedDateKey === todayDateKey || isSaving}
                className="btn"
                style={{
                  padding: '8px 14px',
                  fontSize: '12px',
                  background: selectedDateKey === todayDateKey ? '#ccc' : '#fff',
                  border: '1px solid #1e3f70',
                  color: selectedDateKey === todayDateKey ? '#666' : '#1e3f70',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  cursor: selectedDateKey === todayDateKey ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Usar Hoje ({todayDateKey.split('-').reverse().join('/')})
              </button>
            </div>

            <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#555' }}>
              Será gravada exclusivamente na aba <b>diferencas_diarias_salvas/{selectedDateKey}</b> no Firebase (Dia <b>{selectedDayNum}</b>), sem mesclar com nenhuma outra data.
            </p>
          </div>

          {/* Resumo dos Valores que serão gravados */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#333', marginBottom: '8px' }}>
              RESUMO DA CONCILIAÇÃO ATUAL:
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
              }}
            >
              {/* Faltas */}
              <div
                style={{
                  background: '#FFF5F5',
                  border: '1px solid #FED7D7',
                  borderRadius: '6px',
                  padding: '10px',
                  textAlign: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', fontSize: '10px', fontWeight: 'bold', color: '#C53030' }}>
                  <TrendingDown size={12} />
                  FALTAS
                </div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#9B2C2C', marginTop: '4px' }}>
                  R$ {N(totalF)}
                </div>
                <div style={{ fontSize: '10px', color: '#742A2A', marginTop: '2px' }}>
                  {faltas.length} itens
                </div>
              </div>

              {/* Sobras */}
              <div
                style={{
                  background: '#F0FFF4',
                  border: '1px solid #C6F6D5',
                  borderRadius: '6px',
                  padding: '10px',
                  textAlign: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', fontSize: '10px', fontWeight: 'bold', color: '#276749' }}>
                  <TrendingUp size={12} />
                  SOBRAS
                </div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#22543D', marginTop: '4px' }}>
                  R$ {N(totalS)}
                </div>
                <div style={{ fontSize: '10px', color: '#22543D', marginTop: '2px' }}>
                  {sobras.length} itens
                </div>
              </div>

              {/* Saldo Líquido */}
              <div
                style={{
                  background: saldo >= 0 ? '#F7FAFC' : '#FFF5F5',
                  border: `1px solid ${saldo >= 0 ? '#E2E8F0' : '#FEB2B2'}`,
                  borderRadius: '6px',
                  padding: '10px',
                  textAlign: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', fontSize: '10px', fontWeight: 'bold', color: saldo >= 0 ? '#2D3748' : '#9B2C2C' }}>
                  <Scale size={12} />
                  SALDO FINAL
                </div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: saldo >= 0 ? '#2B6CB0' : '#C53030', marginTop: '4px' }}>
                  {saldo < 0 ? '-' : ''}R$ {N(Math.abs(saldo))}
                </div>
                <div style={{ fontSize: '10px', color: '#718096', marginTop: '2px' }}>
                  {divergenciasCount} com divergência
                </div>
              </div>
            </div>
          </div>

          {/* Mensagem explicativa */}
          <div
            style={{
              display: 'flex',
              gap: '10px',
              padding: '10px 12px',
              background: '#EBF8FF',
              border: '1px solid #BEE3F8',
              borderRadius: '6px',
              fontSize: '11.5px',
              color: '#2B6CB0',
              lineHeight: 1.4,
            }}
          >
            <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              Ao confirmar, será criada/atualizada uma aba isolada no Firebase para a data <b>{selectedDateBR}</b> (<code style={{ fontSize: '10.5px' }}>diferencas_diarias_salvas/{selectedDateKey}</code>), contendo apenas as diferenças deste dia, sem nunca mesclar com outros dias.
            </div>
          </div>
        </div>

        {/* Rodapé com Botões */}
        <div
          style={{
            padding: '12px 20px',
            background: '#F7FAFC',
            borderTop: '1px solid #E2E8F0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="btn"
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              background: '#fff',
              border: '1px solid #CBD5E0',
              color: '#4A5568',
              borderRadius: '4px',
              fontWeight: 'bold',
              cursor: isSaving ? 'not-allowed' : 'pointer',
            }}
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSaving}
            className="btn"
            style={{
              padding: '8px 20px',
              fontSize: '13px',
              background: '#2B579A',
              border: '1px solid #1e3f70',
              color: '#fff',
              borderRadius: '4px',
              fontWeight: 'bold',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 2px 4px rgba(43, 87, 154, 0.3)',
            }}
          >
            <Save size={15} />
            <span>{isSaving ? 'Gravando...' : `Confirmar e Salvar (${selectedDateBR})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
